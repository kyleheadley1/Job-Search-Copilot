import { randomUUID } from "node:crypto";
import { z } from "zod";
import { userProfile } from "../../config/userProfile.js";
import { evaluationFingerprint } from "../../lib/evaluationFingerprint.js";
import { totalsAgree } from "../../lib/authoritativeScore.js";
import { textMentionsGoLanguage } from "../../lib/goLanguage.js";
import { analyzeCoreLanguageRequirement } from "../../lib/coreLanguageRequirements.js";
import { classifyRoleLane } from "../../lib/roleFunctionClassifier.js";
import {
  deriveSeniorityFromTitleAndText,
  reconcileSeniority,
} from "../../lib/seniorityReconciliation.js";
import {
  lineLooksLikeTechStackInventory,
  pythonIsExclusiveCoreRequirement,
  pythonOnMixedStackInventory,
} from "../../lib/stackMismatchAnalysis.js";
import { normalizeText } from "../../lib/text.js";
import type { ExtractedJobData } from "../../types/job.js";
import {
  extractGroundedYearsClauses,
  reconcileYearsExperience,
} from "../../lib/yearsExperienceReconciliation.js";
import { SCORER_VERSION } from "../gmail/jdRecovery/runRecovery.js";
import { evaluationsRepository } from "../gmail/jdRecovery/evaluations.repository.js";
import {
  engineEvidenceFor,
  provenance,
  replayStoredEvaluation,
  ScoreRevisionError,
} from "./scoreRevisions.service.js";
import { scoreRevisionsRepository } from "./scoreRevisions.repository.js";
import {
  SCORING_REVISION_VERSION,
  SCORE_CORRECTION_TYPES,
  SCORE_REVISION_CONFIDENCE,
  type ScoreCorrectionType,
  type ScoreRevision,
  type ScoreRevisionInputId,
  type ScoreRevisionSnapshot,
} from "./scoreRevision.types.js";

const MIN_QUOTE_CHARS = 16;

const jsonScalar = z.union([z.string(), z.number(), z.boolean(), z.null()]);
const jsonValue = z.union([jsonScalar, z.record(z.string(), jsonScalar)]);

export const ProposeScoringCorrectionInput = z
  .object({
    applicationKey: z.string().trim().min(1).max(500),
    evaluationFingerprint: z.string().trim().min(16).max(128),
    correctionType: z.enum(SCORE_CORRECTION_TYPES),
    originalValue: jsonValue,
    proposedValue: jsonValue,
    jdEvidence: z.array(z.string().trim().min(MIN_QUOTE_CHARS).max(800)).min(1).max(8),
    explanation: z.string().trim().min(20).max(4000),
    confidence: z.enum(SCORE_REVISION_CONFIDENCE),
    uncertainty: z
      .string()
      .trim()
      .max(2000)
      .optional()
      .transform((value) => (value ? value : undefined)),
    allowRoleLaneChange: z.boolean().optional(),
  })
  .strict();

export type ProposeScoringCorrectionInput = z.infer<typeof ProposeScoringCorrectionInput>;

const REVIEW_REQUIRED_CODES = new Set(["LANE_REVIEW_REQUIRED", "AMBIGUOUS_EVIDENCE", "REVIEW_REQUIRED"]);

export const isReviewRequiredCode = (code: string): boolean => REVIEW_REQUIRED_CODES.has(code);

const collapseQuote = (value: string): string =>
  normalizeText(value.replace(/[“”]/g, '"').replace(/[‘’]/g, "'"));

export const quotesGroundedInJd = (jdText: string, quotes: string[]): string[] => {
  const haystack = collapseQuote(jdText);
  const accepted: string[] = [];
  for (const quote of quotes) {
    const needle = collapseQuote(quote);
    if (needle.length < MIN_QUOTE_CHARS || !haystack.includes(needle)) {
      throw new ScoreRevisionError(
        "UNSUPPORTED_EVIDENCE",
        "Every jdEvidence quote must appear verbatim in the stored job description.",
      );
    }
    accepted.push(quote.trim());
  }
  return accepted;
};

const OWNERSHIP_MISMATCH_ONLY =
  /\b(end[-\s]?to[-\s]?end ownership|own deployments?|title\/responsibility mismatch|without stated support|high[-\s]?autonomy)\b/i;
const SENIORITY_INTERPRETATION =
  /\b(junior|entry[-\s]?level|associate|senior|staff|principal|engineer ii|engineer iii|software engineer|years?|early[-\s]?career|forward deployed|title)\b/i;
const MIXED_STACK_INTERPRETATION =
  /\b(tech stack|our stack|stack includes|such as|e\.g\.|comfortable working across|and\s*\/\s*or|front-end and back-end|must have|required|experience)\b/i;
const EXCLUSIVE_STACK_INTERPRETATION =
  /\b(must have|required|primary language|professional experience with|strong proficiency|strong fundamentals)\b/i;

const quoteSupportsCorrection = (
  type: ScoreCorrectionType,
  quote: string,
  proposedValue: unknown,
): boolean => {
  const q = collapseQuote(quote);
  if (type === "years_experience_minimum") {
    const proposed = asYears(proposedValue);
    if (proposed.min != null) {
      const n = String(proposed.min).replace(/\.0$/, "");
      const re = new RegExp(`\\b${n.replace(".", "\\.")}\\s*\\+?\\s*(?:years?|yrs)`, "i");
      return re.test(q);
    }
    return /\b(years?|experience|engineer ii|engineer iii)\b/i.test(q);
  }
  if (type === "inferred_seniority") {
    if (OWNERSHIP_MISMATCH_ONLY.test(q) && !SENIORITY_INTERPRETATION.test(q)) return false;
    return SENIORITY_INTERPRETATION.test(q);
  }
  if (type === "stack_language_classification") {
    const proposed = asStack(proposedValue);
    if (!languageMentioned(q, proposed.language)) return false;
    if (proposed.classification === "mixed_stack_inventory") return MIXED_STACK_INTERPRETATION.test(q);
    return EXCLUSIVE_STACK_INTERPRETATION.test(q);
  }
  if (type === "role_lane") {
    const proposed = asLane(proposedValue);
    const aboutRole =
      /\b(engineer|frontend|backend|platform|product|react|api|infrastructure|shipping|typescript|role)\b/i.test(
        q,
      );
    if (!aboutRole) return false;
    if (proposed === "product_frontend") {
      return /\b(front[\s-]?end|react|next\.js|ui engineer|product-minded|shipping)\b/i.test(q);
    }
    if (proposed === "product_backend") {
      return /\b(back[\s-]?end|apis?|server[-\s]?side|product-minded|shipping)\b/i.test(q);
    }
    if (proposed === "product_fullstack") {
      return /\b(full[\s-]?stack|front-end and back-end|product-minded|shipping|react)\b/i.test(q);
    }
    if (proposed === "platform_infra") {
      return /\b(platform|sre|infrastructure|kubernetes|terraform)\b/i.test(q);
    }
    return true;
  }
  return true;
};

const assertQuotesSupportInterpretation = (
  type: ScoreCorrectionType,
  quotes: string[],
  proposedValue: unknown,
): void => {
  const supporting = quotes.filter((quote) => quoteSupportsCorrection(type, quote, proposedValue));
  if (supporting.length === 0) {
    const ambiguousLane = type === "role_lane";
    throw new ScoreRevisionError(
      ambiguousLane ? "REVIEW_REQUIRED" : "EVIDENCE_NOT_SUPPORTED",
      "JD quotes must support the proposed interpretation, not merely appear somewhere in the posting.",
    );
  }
};

const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

const asYears = (value: unknown): { min?: number; raw?: string } => {
  if (value == null) return {};
  if (typeof value === "number") return { min: value };
  if (typeof value === "string") {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? { min: parsed, raw: value } : { raw: value };
  }
  const rec = asRecord(value);
  const min = typeof rec.min === "number" ? rec.min : undefined;
  const raw = typeof rec.raw === "string" ? rec.raw : undefined;
  return { min, raw };
};

const asSeniority = (value: unknown): string | null => {
  if (value == null) return null;
  if (typeof value !== "string") {
    throw new ScoreRevisionError("UNSUPPORTED_CORRECTION", "Seniority values must be a string or null.");
  }
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
};

const STACK_LANGUAGES = ["python", "go", "java"] as const;
type StackLanguage = (typeof STACK_LANGUAGES)[number];
type StackClassification = "mixed_stack_inventory" | "exclusive_core_language";

const asStack = (value: unknown): { language: StackLanguage; classification: StackClassification } => {
  const rec = asRecord(value);
  const language = typeof rec.language === "string" ? rec.language.toLowerCase() : "";
  const classification = rec.classification;
  if (!STACK_LANGUAGES.includes(language as StackLanguage)) {
    throw new ScoreRevisionError("UNSUPPORTED_CORRECTION", "Stack corrections only support python, go, or java.");
  }
  if (classification !== "mixed_stack_inventory" && classification !== "exclusive_core_language") {
    throw new ScoreRevisionError(
      "UNSUPPORTED_CORRECTION",
      "Stack classification must be mixed_stack_inventory or exclusive_core_language.",
    );
  }
  return { language: language as StackLanguage, classification };
};

const ROLE_LANES = [
  "product_frontend",
  "product_fullstack",
  "product_backend",
  "platform_infra",
  "adjacent_non_engineering",
] as const;

const asLane = (value: unknown): (typeof ROLE_LANES)[number] => {
  if (typeof value !== "string" || !ROLE_LANES.includes(value as (typeof ROLE_LANES)[number])) {
    throw new ScoreRevisionError("UNSUPPORTED_CORRECTION", "proposedValue is not a supported role lane.");
  }
  return value as (typeof ROLE_LANES)[number];
};

const yearsMin = (value?: { yearsExperience?: { min?: number }; min?: number }): number | undefined =>
  value?.yearsExperience?.min ?? value?.min;

const minsAgree = (a?: number, b?: number): boolean => {
  if (a == null && b == null) return true;
  if (a == null || b == null) return false;
  return Math.abs(a - b) < 0.05;
};

const seniorityKey = (value: string | null | undefined): string | null => {
  if (!value) return null;
  const v = normalizeText(value);
  if (/\b(junior|entry|associate|new grad|intern|apprentice)\b/i.test(v)) return "entry";
  if (/\b(senior|staff|principal|lead)\b/i.test(v)) return "senior";
  return v;
};

const languageMentioned = (text: string, language: StackLanguage): boolean => {
  if (language === "python") return /\bpython\b/i.test(text);
  if (language === "java") return /\bjava\b/i.test(text);
  return textMentionsGoLanguage(text);
};

const lineHasJsOrTs = (line: string): boolean =>
  /\b(type\s*script|typescript|javascript|node(?:\.js)?|react)\b/i.test(line);

const mixedStackInventoryForLanguage = (job: ExtractedJobData, language: StackLanguage): boolean => {
  if (language === "python") return pythonOnMixedStackInventory(job);
  const blob = [job.rawText ?? "", ...(job.requiredSkills ?? [])].join("\n");
  return blob.split(/[\n.;]/).some((sentence) => {
    const s = sentence.trim();
    return lineLooksLikeTechStackInventory(s) && languageMentioned(s, language) && lineHasJsOrTs(s);
  });
};

const exclusiveCoreForLanguage = (job: ExtractedJobData, language: StackLanguage): boolean => {
  if (language === "python") return pythonIsExclusiveCoreRequirement(job);
  const analysis = analyzeCoreLanguageRequirement(job, userProfile);
  return analysis.explicitHardRequirement && analysis.language === language;
};

const assertOriginalYears = (storedMin: number | undefined, original: { min?: number }) => {
  if (original.min != null && !minsAgree(original.min, storedMin)) {
    throw new ScoreRevisionError(
      "ORIGINAL_MISMATCH",
      `originalValue.min ${original.min} does not match the stored years floor ${storedMin ?? "unset"}.`,
    );
  }
};

const assertOriginalSeniority = (stored: string | undefined, original: string | null) => {
  if (seniorityKey(stored) !== seniorityKey(original)) {
    throw new ScoreRevisionError(
      "ORIGINAL_MISMATCH",
      `originalValue seniority ${original ?? "null"} does not match stored ${stored ?? "unset"}.`,
    );
  }
};

const assertCorrectionReflected = (type: ScoreCorrectionType, ids: ScoreRevisionInputId[]) => {
  const required: Record<ScoreCorrectionType, ScoreRevisionInputId[]> = {
    years_experience_minimum: ["yearsExperience", "seniorityOverreach"],
    inferred_seniority: ["seniority", "seniorityOverreach"],
    stack_language_classification: ["stackMismatch"],
    role_lane: ["roleLane"],
  };
  if (!required[type].some((id) => ids.includes(id))) {
    throw new ScoreRevisionError(
      "CORRECTION_NOT_APPLIED",
      `Deterministic replay did not apply a ${type} change. Claude's proposed input is not an executable correction.`,
    );
  }
};

const validateYearsCorrection = (extracted: ExtractedJobData, input: ProposeScoringCorrectionInput) => {
  const original = asYears(input.originalValue);
  const proposed = asYears(input.proposedValue);
  assertOriginalYears(extracted.yearsExperience?.min, original);
  const clauses = extractGroundedYearsClauses(extracted);
  const reconciled = reconcileYearsExperience(extracted);
  if (reconciled.ambiguous && clauses.length > 1) {
    throw new ScoreRevisionError(
      "AMBIGUOUS_EVIDENCE",
      "Multiple explicit years floors appear in the JD; automatic replay is not allowed.",
    );
  }
  if (proposed.min != null) {
    const grounded = clauses.some((clause) => minsAgree(clause.min, proposed.min));
    if (!grounded) {
      throw new ScoreRevisionError(
        "EVIDENCE_NOT_SUPPORTED",
        `Proposed years minimum ${proposed.min} is not an explicit JD years clause.`,
      );
    }
  } else if (!reconciled.changed) {
    throw new ScoreRevisionError(
      "EVIDENCE_NOT_SUPPORTED",
      "Dropping the stored years floor is not supported by the JD text.",
    );
  }
};

const validateSeniorityCorrection = (extracted: ExtractedJobData, input: ProposeScoringCorrectionInput) => {
  const original = asSeniority(input.originalValue);
  const proposed = asSeniority(input.proposedValue);
  assertOriginalSeniority(extracted.seniority, original);
  const derived = deriveSeniorityFromTitleAndText(extracted);
  const reconciled = reconcileSeniority(extracted);
  if (proposed == null) {
    if (seniorityKey(derived) === "senior") {
      throw new ScoreRevisionError(
        "GENUINE_SENIORITY_GATE",
        "The title/JD still reads as senior; dropping seniority is not a supported correction.",
      );
    }
    if (!reconciled.conflictLogged && seniorityKey(extracted.seniority) === seniorityKey(reconciled.job.seniority)) {
      throw new ScoreRevisionError(
        "EVIDENCE_NOT_SUPPORTED",
        "Current seniority rules would not drop the stored seniority value.",
      );
    }
    return;
  }
  if (seniorityKey(proposed) !== seniorityKey(derived) && seniorityKey(proposed) !== seniorityKey(reconciled.job.seniority)) {
    throw new ScoreRevisionError(
      "EVIDENCE_NOT_SUPPORTED",
      `Proposed seniority ${proposed} is not supported by the title or JD seniority signals.`,
    );
  }
};

const validateStackCorrection = (
  extracted: ExtractedJobData,
  storedGap: string[] | undefined,
  input: ProposeScoringCorrectionInput,
) => {
  const original = asStack(input.originalValue);
  const proposed = asStack(input.proposedValue);
  if (original.language !== proposed.language) {
    throw new ScoreRevisionError("UNSUPPORTED_CORRECTION", "Stack originalValue and proposedValue must name the same language.");
  }
  const language = proposed.language;
  if (proposed.classification === "mixed_stack_inventory") {
    if (exclusiveCoreForLanguage(extracted, language)) {
      throw new ScoreRevisionError(
        "GENUINE_CORE_LANGUAGE",
        `The stored JD treats ${language} as an exclusive core-language requirement.`,
      );
    }
    if (!mixedStackInventoryForLanguage(extracted, language)) {
      throw new ScoreRevisionError(
        "EVIDENCE_NOT_SUPPORTED",
        `The stored JD does not list ${language} as mixed-stack inventory beside JS/TS.`,
      );
    }
    return;
  }
  if (!exclusiveCoreForLanguage(extracted, language) && !(storedGap ?? []).some((g) => g.toLowerCase().includes(language))) {
    throw new ScoreRevisionError(
      "EVIDENCE_NOT_SUPPORTED",
      `The stored JD does not make ${language} an exclusive core-language requirement.`,
    );
  }
};

const validateLaneCorrection = (
  extracted: ExtractedJobData,
  storedLane: string | undefined,
  input: ProposeScoringCorrectionInput,
) => {
  const proposed = asLane(input.proposedValue);
  const original = asLane(input.originalValue);
  if (original !== (storedLane as typeof original) && storedLane) {
    throw new ScoreRevisionError(
      "ORIGINAL_MISMATCH",
      `originalValue lane ${original} does not match stored ${storedLane}.`,
    );
  }
  const classified = classifyRoleLane(extracted).label;
  if (proposed !== classified) {
    throw new ScoreRevisionError(
      "REVIEW_REQUIRED",
      `Classifier maps this JD to ${classified}, not ${proposed}. Role-lane overrides that disagree with the classifier are not auto-replayed.`,
    );
  }
};

const engineAgreesWithProposal = (
  type: ScoreCorrectionType,
  input: ProposeScoringCorrectionInput,
  corrected: ScoreRevisionSnapshot,
): void => {
  if (type === "years_experience_minimum") {
    const proposed = asYears(input.proposedValue);
    if (!minsAgree(proposed.min, yearsMin(corrected))) {
      throw new ScoreRevisionError(
        "CONTRADICTORY_CORRECTION",
        `Engine years floor is ${yearsMin(corrected) ?? "unset"}; Claude proposed ${proposed.min ?? "unset"}.`,
      );
    }
  }
  if (type === "inferred_seniority") {
    const proposed = asSeniority(input.proposedValue);
    if (seniorityKey(proposed) !== seniorityKey(corrected.seniority)) {
      throw new ScoreRevisionError(
        "CONTRADICTORY_CORRECTION",
        `Engine seniority is ${corrected.seniority ?? "unset"}; Claude proposed ${proposed ?? "null"}.`,
      );
    }
  }
  if (type === "stack_language_classification") {
    const proposed = asStack(input.proposedValue);
    const gap = (corrected.coreLanguageGap ?? []).map((g) => g.toLowerCase());
    const stillGapped = gap.some((g) => g.includes(proposed.language));
    if (proposed.classification === "mixed_stack_inventory" && stillGapped && corrected.stackMismatch) {
      throw new ScoreRevisionError(
        "CONTRADICTORY_CORRECTION",
        `Replay still treats ${proposed.language} as a core-language gap.`,
      );
    }
    if (proposed.classification === "exclusive_core_language" && !corrected.stackMismatch && !stillGapped) {
      throw new ScoreRevisionError(
        "CONTRADICTORY_CORRECTION",
        `Replay does not treat ${proposed.language} as a core-language requirement.`,
      );
    }
  }
  if (type === "role_lane") {
    const proposed = asLane(input.proposedValue);
    if (corrected.roleLane !== proposed) {
      throw new ScoreRevisionError(
        "CONTRADICTORY_CORRECTION",
        `Replay role lane is ${corrected.roleLane ?? "unset"}; Claude proposed ${proposed}.`,
      );
    }
  }
};

export const publicClaudeProposalView = (revision: ScoreRevision) => ({
  status: "proposed" as const,
  approved: false as const,
  revisionId: revision.revisionId,
  applicationKey: revision.applicationKey,
  method: revision.method,
  correctionType: revision.correctionType,
  original: {
    total: revision.original.total,
    recommendation: revision.original.recommendation,
    yearsExperience: revision.original.yearsExperience,
    seniority: revision.original.seniority ?? null,
    stackMismatch: revision.original.stackMismatch,
    coreLanguageGap: revision.original.coreLanguageGap,
    roleLane: revision.original.roleLane,
    seniorityOverreach: revision.original.seniorityOverreach,
  },
  proposed: {
    total: revision.corrected.total,
    recommendation: revision.corrected.recommendation,
    yearsExperience: revision.corrected.yearsExperience,
    seniority: revision.corrected.seniority ?? null,
    stackMismatch: revision.corrected.stackMismatch,
    coreLanguageGap: revision.corrected.coreLanguageGap,
    roleLane: revision.corrected.roleLane,
    seniorityOverreach: revision.corrected.seniorityOverreach,
  },
  inputChanges: revision.inputChanges,
  evidence: revision.evidence,
  explanation: revision.explanation,
  confidence: revision.confidence,
  uncertainty: revision.uncertainty,
  recommendationTierChanged: revision.recommendationTierChanged,
  laneChange: revision.inputsChanged.includes("roleLane"),
  evaluationFingerprint: revision.evaluationFingerprint,
});

export const proposeClaudeScoringCorrection = async (
  input: ProposeScoringCorrectionInput,
): Promise<ReturnType<typeof publicClaudeProposalView>> => {
  const evaluation = await evaluationsRepository.findByKey(input.applicationKey);
  if (!evaluation) throw new ScoreRevisionError("NOT_FOUND", `No evaluation for ${input.applicationKey}`);
  if (evaluation.recovery.status !== "scored" || !evaluation.fit) {
    throw new ScoreRevisionError("NOT_SCORED", `${input.applicationKey} is not scored.`);
  }
  if (!evaluation.jd?.text) {
    throw new ScoreRevisionError("MISSING_BREAKDOWN", "Stored JD text is required to ground a correction.");
  }
  const currentFingerprint = evaluationFingerprint(evaluation);
  if (currentFingerprint !== input.evaluationFingerprint) {
    throw new ScoreRevisionError(
      "STALE_FINGERPRINT",
      "evaluationFingerprint does not match the current stored evaluation.",
    );
  }

  const acceptedQuotes = quotesGroundedInJd(evaluation.jd.text, input.jdEvidence);
  assertQuotesSupportInterpretation(input.correctionType, acceptedQuotes, input.proposedValue);
  if (!evaluation.fit.detail?.extracted) {
    throw new ScoreRevisionError("MISSING_BREAKDOWN", "Stored extraction is required to validate a correction.");
  }
  const extracted: ExtractedJobData = { ...evaluation.fit.detail.extracted, rawText: evaluation.jd.text };
  const storedRules = evaluation.fit.detail.rules;

  if (input.correctionType === "years_experience_minimum") validateYearsCorrection(extracted, input);
  else if (input.correctionType === "inferred_seniority") validateSeniorityCorrection(extracted, input);
  else if (input.correctionType === "stack_language_classification") {
    validateStackCorrection(extracted, storedRules?.coreLanguageGap, input);
  } else {
    validateLaneCorrection(extracted, storedRules?.roleLane, input);
  }

  const existing = await scoreRevisionsRepository.listByApplicationKey(evaluation.key);
  const duplicate = existing.find(
    (row) =>
      row.status === "proposed" &&
      row.evaluationFingerprint === currentFingerprint &&
      row.correctionType === input.correctionType,
  );
  if (duplicate) {
    throw new ScoreRevisionError(
      "DUPLICATE_PROPOSAL",
      `A proposed ${input.correctionType} correction already exists (${duplicate.revisionId}).`,
    );
  }

  const replay = await replayStoredEvaluation({ evaluation });
  if (replay.inputChanges.some((change) => change.id === "roleLane") && !input.allowRoleLaneChange) {
    throw new ScoreRevisionError(
      "LANE_REVIEW_REQUIRED",
      `Role lane would change from ${String(replay.original.roleLane)} to ${String(replay.corrected.roleLane)} (engine score ${replay.corrected.total} / ${replay.corrected.recommendation}). Pass allowRoleLaneChange after explicit review; the user must still approve in the dashboard.`,
    );
  }
  if (
    totalsAgree(replay.original.total, replay.corrected.total) &&
    replay.original.recommendation === replay.corrected.recommendation &&
    replay.inputChanges.length === 0
  ) {
    throw new ScoreRevisionError("NO_CORRECTION", "Deterministic replay matches the current effective score.");
  }

  const inputsChanged = [...new Set(replay.inputChanges.map((change) => change.id))];
  assertCorrectionReflected(input.correctionType, inputsChanged);
  engineAgreesWithProposal(input.correctionType, input, replay.corrected);

  const revision: ScoreRevision = {
    revisionId: randomUUID(),
    applicationKey: evaluation.key,
    evaluationFingerprint: currentFingerprint,
    scoringVersion: SCORING_REVISION_VERSION,
    pipelineVersionLabel: SCORER_VERSION,
    method: "claude_audit_proposal",
    status: "proposed",
    inputsChanged,
    inputChanges: replay.inputChanges,
    evidence: [
      ...acceptedQuotes.map((quote) => `JD quote: "${quote}"`),
      ...engineEvidenceFor(replay.extracted, replay.inputChanges),
    ].slice(0, 10),
    explanation: input.explanation,
    recommendationTierChanged: replay.original.recommendation !== replay.corrected.recommendation,
    original: replay.original,
    corrected: replay.corrected,
    createdAt: new Date().toISOString(),
    createdBy: provenance("mcp", input.correctionType, "claude"),
    correctionType: input.correctionType,
    confidence: input.confidence,
    uncertainty: input.uncertainty,
  };
  await scoreRevisionsRepository.insert(revision);
  return publicClaudeProposalView(revision);
};
