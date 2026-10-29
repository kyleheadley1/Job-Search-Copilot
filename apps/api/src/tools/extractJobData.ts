import {
  extractionSystemPrompt,
  buildExtractionPrompt,
  metadataExtractionSystemPrompt,
  buildMetadataExtractionPrompt,
} from "../agents/jobAgent/prompts.js";
import { ExtractedJobFromModelSchema, JobMetadataFromModelSchema } from "../agents/jobAgent/schemas.js";
import type { ExtractedJobData } from "../types/job.js";
import { responsesClient } from "../services/llm/responsesClient.js";
import type { StructuredCallDiagnostics } from "../services/llm/responsesClient.js";
import { logger } from "../lib/logger.js";
import { parseJobText } from "./parseJobText.js";
import {
  extractFromRawText,
  mergeExtractedWithHeuristics,
} from "./deterministicRawTextExtract.js";
import {
  extractJobPostingMetadata,
  isRejectedCompanyCandidate,
  isWeakJobTitle,
  isWeakOrPlaceholderCompany,
  logJobPostingMetadataDebug,
  validateExtractedCompany,
  type JobPostingMetadata,
  type PreScoringJobMetadata,
} from "./jobPostingMetadataExtract.js";
import { resolveCompanyFromText, sanitizeCompanyName, ensureCompanyName, ensureJobTitle } from "./companyCandidateRules.js";
import { normalizeLocationPrefixedTitle } from "./preScoringMetadataExtract.js";
import { applyCompanyPresentation } from "./companyExtraction.js";
import { attachGeoScope } from "../lib/geoEligibility.js";
import { attachClearanceCitizenshipFields } from "../lib/clearanceCitizenship.js";
import { reconcileSeniority } from "../lib/seniorityReconciliation.js";
import { reconcileYearsExperience } from "../lib/yearsExperienceReconciliation.js";
import { extractCompanyEmployeeCount } from "../lib/companyEmployeeCount.js";
import { sanitizeExtractedTags } from "../lib/jdTagProvenance.js";
import { attachReinforcedExperienceFloor } from "../lib/reinforcedExperienceFloor.js";

const fallbackExtraction = (input: { url?: string; rawText?: string; companyHint?: string }): ExtractedJobData => ({
  company: input.companyHint ?? "Unknown Company",
  title: "Unknown Title",
  url: input.url,
  rawText: input.rawText,
  remoteType: "unknown",
  stack: [],
  requiredSkills: [],
  preferredSkills: [],
  domainTags: [],
  responsibilities: [],
  requirements: [],
});

const applyPreParsedMetadata = (base: ExtractedJobData, meta: JobPostingMetadata, rawText: string): ExtractedJobData => {
  const trusted = meta.preScoring?.confidence === "high" || meta.preScoring?.confidence === "medium";
  const resolved = resolveCompanyFromText(rawText, {
    llmCompany: base.company,
    preScoringCompany: meta.companyName,
  });
  const metaCompany = meta.companyName && !isRejectedCompanyCandidate(meta.companyName) ? meta.companyName : null;
  const company =
    resolved ??
    (metaCompany && (trusted || isRejectedCompanyCandidate(base.company) || isWeakOrPlaceholderCompany(base.company))
      ? metaCompany
      : !isRejectedCompanyCandidate(base.company)
        ? base.company
        : metaCompany ?? base.company);
  const title = meta.jobTitle && (trusted || isWeakJobTitle(base.title)) ? meta.jobTitle : base.title;
  return {
    ...base,
    company: company || base.company,
    title: title || base.title,
    employmentType: meta.employmentType ?? base.employmentType,
    location: meta.location ?? base.location ?? undefined,
    seniority: meta.seniority ?? base.seniority ?? undefined,
  };
};

const applyMetadataFallback = (base: ExtractedJobData, meta: {
  companyName: string | null;
  jobTitle: string | null;
  employmentType: string | null;
  location: string | null;
  seniority: string | null;
}): ExtractedJobData => ({
  ...base,
  company:
    meta.companyName && !isRejectedCompanyCandidate(meta.companyName) &&
    (isRejectedCompanyCandidate(base.company) || isWeakOrPlaceholderCompany(base.company))
      ? meta.companyName
      : !isRejectedCompanyCandidate(base.company)
        ? base.company
        : meta.companyName ?? base.company,
  title: meta.jobTitle && isWeakJobTitle(base.title) ? meta.jobTitle : base.title,
  employmentType: meta.employmentType ?? base.employmentType,
  location: base.location ?? meta.location ?? undefined,
  seniority: base.seniority ?? meta.seniority ?? undefined,
});

const resolveFinalCompany = (
  company: string | undefined,
  normalizedText: string,
  companyHint?: string,
): string =>
  sanitizeCompanyName(company, normalizedText, companyHint) ??
  resolveCompanyFromText(normalizedText, { companyHint, llmCompany: company }) ??
  companyHint?.trim() ??
  "Unknown Company";

const finalizeExtracted = (extracted: ExtractedJobData, normalizedText: string, companyHint?: string): ExtractedJobData => {
  let out = extracted;
  if (out.title) {
    const normalizedTitle = normalizeLocationPrefixedTitle(out.title);
    if (normalizedTitle.jobTitle !== out.title) {
      out = {
        ...out,
        title: normalizedTitle.jobTitle,
        location: out.location ?? normalizedTitle.location ?? undefined,
      };
    }
  }
  out = {
    ...out,
    company: resolveFinalCompany(out.company, normalizedText, companyHint),
    title: ensureJobTitle(out.title),
  };
  out = applyCompanyPresentation(out, companyHint);
  out = {
    ...out,
    company: ensureCompanyName(out.companyDisplayName ?? out.company),
    title: ensureJobTitle(out.title),
  };
  const employeeCount =
    out.companyEmployeeCount ?? extractCompanyEmployeeCount({ ...out, rawText: normalizedText });
  if (employeeCount != null) {
    out = { ...out, companyEmployeeCount: employeeCount };
  }
  if (normalizedText.trim()) {
    out = sanitizeExtractedTags({ ...out, rawText: normalizedText });
    out = attachReinforcedExperienceFloor(out);
  }
  return attachClearanceCitizenshipFields(attachGeoScope(out));
};

export type ExtractJobDataResult = {
  extracted: ExtractedJobData;
  llmExtractionSucceeded: boolean;
  extractionDiagnostics: StructuredCallDiagnostics;
  heuristicInferredFields: string[];
  preScoringMetadata?: PreScoringJobMetadata;
};

export const extractJobData = async (input: {
  url?: string;
  rawText?: string;
  companyHint?: string;
}): Promise<ExtractJobDataResult> => {
  const fallback = () => fallbackExtraction(input);
  let normalized: string | undefined;
  let preParsed: JobPostingMetadata | undefined;

  if (input.rawText?.trim()) {
    normalized = parseJobText(input.rawText.replace(/\r\n/g, "\n")).normalized;
    preParsed = extractJobPostingMetadata(normalized);
    logJobPostingMetadataDebug(normalized, preParsed, "pre_llm");
  }

  const extractedRun = await responsesClient.runStructured({
    systemPrompt: extractionSystemPrompt,
    userPrompt: buildExtractionPrompt({ ...input, rawText: normalized ?? input.rawText, preParsed }),
    schema: ExtractedJobFromModelSchema,
    fallback,
  });
  const llmExtractionSucceeded = extractedRun.success;
  if (!llmExtractionSucceeded) {
    logger.warn("Job extraction used deterministic fallback", {
      fallbackUsed: extractedRun.diagnostics.fallbackUsed,
      httpStatus: extractedRun.diagnostics.httpStatus,
      errorCode: extractedRun.diagnostics.errorCode,
      parseStage: extractedRun.diagnostics.parseStage,
      reason: extractedRun.diagnostics.reason,
      errorMessage: extractedRun.diagnostics.errorMessage,
    });
  }
  let extracted = extractedRun.data;
  let heuristicInferredFields: string[] = [];

  if (preParsed && normalized) {
    extracted = applyPreParsedMetadata(extracted, preParsed, normalized);
  }

  if (normalized) {
    const heur = extractFromRawText(normalized, input.companyHint);
    heuristicInferredFields = heur.inferredFields;
    extracted = mergeExtractedWithHeuristics(extracted, heur);
    extracted.rawText = extracted.rawText ?? input.rawText;
    extracted = finalizeExtracted(extracted, normalized, input.companyHint);
  }

  if (normalized && isWeakOrPlaceholderCompany(extracted.company)) {
    const metaRun = await responsesClient.runStructured({
      systemPrompt: metadataExtractionSystemPrompt,
      userPrompt: buildMetadataExtractionPrompt(normalized),
      schema: JobMetadataFromModelSchema,
      fallback: () => ({
        companyName: preParsed?.companyName ?? null,
        jobTitle: preParsed?.jobTitle ?? null,
        employmentType: preParsed?.employmentType ?? null,
        location: preParsed?.location ?? null,
        seniority: preParsed?.seniority ?? null,
        salary: preParsed?.salary ?? null,
        workModel: preParsed?.workModel ?? null,
      }),
    });
    if (!metaRun.success) {
      logger.warn("Metadata fallback extraction used deterministic values", metaRun.diagnostics);
    }
    extracted = applyMetadataFallback(extracted, metaRun.data);
    extracted = finalizeExtracted(extracted, normalized, input.companyHint);
  }

  const yearsReconciled = reconcileYearsExperience(extracted);
  const reconciled = reconcileSeniority(yearsReconciled.job);
  extracted = {
    ...reconciled.job,
    company: ensureCompanyName(reconciled.job.company),
    title: ensureJobTitle(reconciled.job.title),
  };

  return {
    extracted,
    llmExtractionSucceeded,
    extractionDiagnostics: extractedRun.diagnostics,
    heuristicInferredFields,
    preScoringMetadata: preParsed?.preScoring,
  };
};
