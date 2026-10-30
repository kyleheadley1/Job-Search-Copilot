import type { ExtractedJobData } from "../types/job.js";
import type {
  CapabilityBreakdown,
  CapabilityGap,
  ScoreBreakdown,
  SpecializationGap,
  SpecializationGapSeverity,
} from "../types/scoring.js";
import { analyzeLanguageRequirementStrength } from "./languageRequirementStrength.js";
import {
  jdHasExplicitDesignToolRequirement,
  jdHasNarrativeDesignLanguageOnly,
  tagsAtLeastStrength,
} from "./jdTagProvenance.js";
import {
  findLiteralLeadsWithSourceQuote,
  languageOnlyInDisjunctiveChoice,
  languageOnlyInIllustrativeExample,
} from "./disjunctiveLanguageRequirement.js";
import { normalizeText } from "./text.js";

const structuredBlob = (job: ExtractedJobData): string =>
  normalizeText(
    [
      job.title,
      ...(job.stack ?? []),
      ...(job.requiredSkills ?? []),
      ...(job.preferredSkills ?? []),
      ...(job.requirements ?? []),
      ...(job.responsibilities ?? []),
      job.rawText ?? "",
    ].join("\n"),
  );

const requiredBlob = (job: ExtractedJobData): string =>
  normalizeText(
    [
      ...(job.requiredSkills ?? []),
      ...(job.requirements ?? []),
      ...(job.stack ?? []),
    ].join("\n"),
  );

const hardRequiredBlob = (job: ExtractedJobData): string =>
  normalizeText([...(job.requiredSkills ?? []), ...(job.requirements ?? [])].join("\n"));

const preferredBlob = (job: ExtractedJobData): string =>
  normalizeText([...(job.preferredSkills ?? [])].join("\n"));

const DESIGN_JD_SIGNALS =
  /\b(figma|design\s+system|visual\s+design|ui\/ux|ux\s+design|design\s+portfolio|wireframe|prototyp|pixel[-\s]?perfect|interaction\s+design)\b/i;

const DESIGN_TITLE_RE =
  /\b(web\s+)?design\s+engineer\b|\bproduct\s+design\s+engineer\b|\bui\s+engineer\b/i;

const DESIGN_RESUME_EVIDENCE =
  /\b(figma|sketch|adobe\s*xd|design\s+system|ui\/ux|ux\s+design|wireframe|prototyp|visual\s+design|design\s+portfolio|interaction\s+design)\b/i;

const PYTHON_BACKEND_RE = /\b(python|flask|django)\b/i;
const NODE_LEAD_RE = /\bnode(?:\.js)?\b/i;

/** Non-binding list phrasing — languages here are examples, not hard requirements. */
const INCLUDING_BUT_NOT_LIMITED_CLAUSE =
  /\bincluding\s+but\s+not\s+limited\s+to\b[^.\n]{0,220}/gi;

const stripIncludingButNotLimitedClauses = (text: string): string =>
  text.replace(INCLUDING_BUT_NOT_LIMITED_CLAUSE, " ");

const labelFromPythonBlob = (blob: string): string | undefined => {
  if (!PYTHON_BACKEND_RE.test(blob)) return undefined;
  const hasDjango = /\bdjango\b/i.test(blob);
  const hasFlask = /\bflask\b/i.test(blob);
  const hasPython = /\bpython\b/i.test(blob);
  if (hasDjango && hasPython) return "Python/Django";
  if (hasFlask && hasPython) return "Python/Flask";
  if (hasDjango) return "Django";
  if (hasFlask) return "Flask";
  if (hasPython) return "Python";
  return undefined;
};

/** Required-section prose names Node/TS as the backend stack (authoritative). */
const requiredNamesNodeBackend = (requirementsProse: string): boolean =>
  /\bbackend\s+development\s+using\s+node(?:\.js)?\b/i.test(requirementsProse) ||
  /\bnode(?:\.js)?\s*\([^)]*(?:express|nestjs)[^)]*\)/i.test(requirementsProse) ||
  (/\bnode(?:\.js)?\b/i.test(requirementsProse) &&
    /\b(backend|express|nestjs|restful\s+api|rest\s+api)\b/i.test(requirementsProse));

/**
 * Derive backend pillar label from Requirements prose as authoritative.
 * Responsibilities (and especially "including but not limited to" lists) are secondary/non-binding.
 * Never use skill-tag order alone. Never treat a disjunctive choice-list language as "leads with".
 */
export const extractJdBackendLabel = (job: ExtractedJobData): string | undefined => {
  const requirementsProse = normalizeText(
    stripIncludingButNotLimitedClauses((job.requirements ?? []).join("\n")),
  );
  const responsibilitiesProse = normalizeText(
    stripIncludingButNotLimitedClauses((job.responsibilities ?? []).join("\n")),
  );

  const fromRequired = labelFromPythonBlob(requirementsProse);
  if (fromRequired) {
    // Disjunctive "at least one from Python, Java, C++" must not become "Python leads".
    if (languageOnlyInDisjunctiveChoice(job, "Python")) return undefined;
    const base = fromRequired.split("/")[0]!.trim();
    if (languageOnlyInDisjunctiveChoice(job, base)) return undefined;
    if (languageOnlyInIllustrativeExample(job, base)) return undefined;
    return fromRequired;
  }

  // Required names Node.js as the backend — do not let Responsibilities example lists
  // (or contaminated skill tags) invent a Python-primary stack.
  if (requiredNamesNodeBackend(requirementsProse)) return undefined;

  const fromResp = labelFromPythonBlob(responsibilitiesProse);
  if (fromResp && languageOnlyInDisjunctiveChoice(job, fromResp.split("/")[0]!.trim())) {
    return undefined;
  }
  return fromResp;
};

export const extractResumeBackendLabel = (resumeText: string): string | undefined => {
  const resume = normalizeText(resumeText);
  if (NODE_LEAD_RE.test(resume)) return "Node";
  if (/\bpython\b/i.test(resume) && /\b(django|flask)\b/i.test(resume)) {
    if (/\bdjango\b/i.test(resume)) return "Python/Django";
    if (/\bflask\b/i.test(resume)) return "Python/Flask";
    return "Python";
  }
  if (/\bpython\b/i.test(resume)) return "Python";
  return undefined;
};

const backendGapEvidence = (jdSide: string, resumeSide: string, hasAdjacentPython: boolean): string =>
  hasAdjacentPython
    ? `Role leads with ${jdSide} on the backend; resume leads with ${resumeSide}`
    : `${jdSide} backend required; resume is ${resumeSide}-primary without production depth on the JD stack`;

export const detectEnterpriseIamSpecialization = (job: ExtractedJobData): boolean => {
  const blob = structuredBlob(job);
  const signals = [
    /\bsaml\b/i.test(blob),
    /\boidc\b|\bopenid connect\b/i.test(blob),
    /\boauth\b/i.test(blob),
    /\bldap\b/i.test(blob),
    /\bactive directory\b/i.test(blob),
    /\bidentity (and access )?management\b|\biam\b/i.test(blob),
    /\bsingle sign[-\s]?on\b|\bsso\b/i.test(blob),
  ].filter(Boolean).length;
  return signals >= 3;
};

const titleNamesIam = (job: ExtractedJobData): boolean =>
  /\b(identity|iam|sso|saml|oauth|oidc)\b/i.test(job.title ?? "");

const titleNamesDesign = (job: ExtractedJobData): boolean =>
  DESIGN_TITLE_RE.test(job.title ?? "");

const countDesignSignals = (blob: string): number => {
  const patterns = [
    /\bfigma\b/i,
    /\bdesign\s+system\b/i,
    /\bvisual\s+design\b/i,
    /\bui\/ux\b|\bux\s+design\b/i,
    /\bdesign\s+portfolio\b/i,
    /\bwireframe\b/i,
    /\bprototyp/i,
    /\bpixel[-\s]?perfect\b/i,
  ];
  return patterns.filter((re) => re.test(blob)).length;
};

/** Derive severity from JD placement + how much evidence the candidate lacks. */
const resolveSeverity = (params: {
  inTitle: boolean;
  inRequired: boolean;
  inPreferred: boolean;
  candidateHasAdjacent: boolean;
  signalCount: number;
}): SpecializationGapSeverity => {
  if (params.inTitle && params.inRequired && !params.candidateHasAdjacent) return "central";
  if (params.inRequired && !params.candidateHasAdjacent) return "central";
  if (params.inTitle || (params.inRequired && params.candidateHasAdjacent)) return "moderate";
  if (params.inPreferred || params.candidateHasAdjacent) return "moderate";
  if (params.signalCount >= 2) return "moderate";
  return "minor";
};

export const computeSpecializationDock = (
  severity: SpecializationGapSeverity,
  signalCount: number,
): number => {
  switch (severity) {
    case "central":
      return Math.min(20, 12 + Math.min(8, signalCount));
    case "moderate":
      return Math.min(8, 4 + Math.min(4, Math.floor(signalCount / 2)));
    case "minor":
      return Math.min(3, signalCount > 0 ? 2 : 1);
    default:
      return 0;
  }
};

const finalizeGap = (
  gap: Omit<SpecializationGap, "dock"> & { signalCount: number },
): SpecializationGap => {
  const { signalCount, ...rest } = gap;
  return {
    ...rest,
    dock: computeSpecializationDock(gap.severity, signalCount),
  };
};

export const detectDesignFigmaSpecializationGap = (
  job: ExtractedJobData,
  resumeText?: string,
): SpecializationGap | undefined => {
  if (jdHasNarrativeDesignLanguageOnly(job)) return undefined;
  if (!jdHasExplicitDesignToolRequirement(job)) return undefined;

  const required = normalizeText(
    [...(job.requirements ?? []), ...tagsAtLeastStrength(job, "REQUIRED").map((t) => t.term)].join("\n"),
  );
  const inTitle = titleNamesDesign(job);
  const inRequired = DESIGN_JD_SIGNALS.test(required);
  const signalCount = countDesignSignals(required);

  if (!inTitle && !inRequired && signalCount < 1) return undefined;

  const resume = normalizeText(resumeText ?? "");
  if (DESIGN_RESUME_EVIDENCE.test(resume)) return undefined;

  const severity = resolveSeverity({
    inTitle,
    inRequired,
    inPreferred: DESIGN_JD_SIGNALS.test(
      normalizeText([...(job.preferredSkills ?? []), ...tagsAtLeastStrength(job, "PREFERRED").map((t) => t.term)].join("\n")),
    ),
    candidateHasAdjacent: false,
    signalCount,
  });

  return finalizeGap({
    kind: "design_portfolio",
    name: "design/Figma",
    evidence: inTitle
      ? "Design/Figma pillar named in title and required qualifications"
      : "Explicit design-tool or portfolio requirements in JD; no design portfolio evidence on resume",
    severity,
    lever: "portfolio",
    jdSide: "design/Figma",
    resumeSide: "engineering-side",
    signalCount,
  });
};

export const detectBackendStackSpecializationGap = (
  job: ExtractedJobData,
  resumeText?: string,
): SpecializationGap | undefined => {
  const jdSide = extractJdBackendLabel(job);
  if (!jdSide) return undefined;

  const baseLang = jdSide.split("/")[0]!.trim();
  // Fabrication guard: only emit "leads with" style gaps when JD literally states priority.
  const sourceQuote = findLiteralLeadsWithSourceQuote(job, baseLang);
  if (!sourceQuote) return undefined;
  if (languageOnlyInDisjunctiveChoice(job, baseLang)) return undefined;

  const strength = analyzeLanguageRequirementStrength(job, jdSide);
  if (strength === "soft") return undefined;

  // Authoritative Required-section only — Responsibilities example lists do not count as "required".
  const requirementsProse = normalizeText(
    stripIncludingButNotLimitedClauses((job.requirements ?? []).join("\n")),
  );
  const inRequired = PYTHON_BACKEND_RE.test(requirementsProse);
  const inTitle = PYTHON_BACKEND_RE.test(job.title ?? "");
  // Skill-tag / stack order alone must not count as "leads with" evidence.
  if (!inRequired && !inTitle) return undefined;

  const resume = normalizeText(resumeText ?? "");
  const resumeSide = extractResumeBackendLabel(resume);
  if (!resumeSide || !NODE_LEAD_RE.test(resume)) return undefined;

  const hasPython = PYTHON_BACKEND_RE.test(resume);
  let severity = resolveSeverity({
    inTitle,
    inRequired,
    inPreferred: PYTHON_BACKEND_RE.test(preferredBlob(job)),
    candidateHasAdjacent: hasPython,
    signalCount: [inRequired, inTitle].filter(Boolean).length,
  });

  if (severity === "minor" && hasPython) return undefined;

  return finalizeGap({
    kind: "backend_stack",
    name: `${jdSide} backend`,
    evidence: `${backendGapEvidence(jdSide, resumeSide, hasPython)} (JD: "${sourceQuote.slice(0, 120)}")`,
    severity,
    lever: severity === "central" ? "upskill" : "resume",
    jdSide,
    resumeSide,
    signalCount: [inRequired, inTitle].filter(Boolean).length + (hasPython ? 1 : 0),
  });
};

/** @deprecated alias */
export const detectPythonBackendSpecializationGap = detectBackendStackSpecializationGap;

export const detectEnterpriseIamSpecializationGap = (
  job: ExtractedJobData,
  _rawScore?: ScoreBreakdown,
): SpecializationGap | undefined => {
  if (!detectEnterpriseIamSpecialization(job)) return undefined;

  const inTitle = titleNamesIam(job);
  const inRequired = /\b(saml|oauth|oidc|ldap|iam|sso)\b/i.test(requiredBlob(job));
  const signalCount = [
    /\bsaml\b/i.test(structuredBlob(job)),
    /\boauth\b/i.test(structuredBlob(job)),
    /\boidc\b/i.test(structuredBlob(job)),
    /\bldap\b/i.test(structuredBlob(job)),
  ].filter(Boolean).length;

  if (!inTitle && !inRequired && signalCount < 3) return undefined;

  const severity = resolveSeverity({
    inTitle,
    inRequired,
    inPreferred: false,
    candidateHasAdjacent: false,
    signalCount: Math.max(signalCount, 3),
  });

  return finalizeGap({
    kind: "enterprise_iam",
    name: "enterprise IAM / SAML-OIDC",
    evidence: inTitle
      ? "IAM/SAML-OIDC specialization central in title or required section"
      : "Enterprise IAM integration depth beyond OAuth-only resume evidence",
    severity,
    lever: "none",
    jdSide: "enterprise IAM / SAML-OIDC",
    resumeSide: "OAuth-only",
    signalCount: Math.max(signalCount, 3),
  });
};

export const detectSpecializationGap = (
  job: ExtractedJobData,
  rawScore?: ScoreBreakdown,
  resumeText?: string,
): SpecializationGap | undefined =>
  detectDesignFigmaSpecializationGap(job, resumeText) ??
  detectBackendStackSpecializationGap(job, resumeText) ??
  detectEnterpriseIamSpecializationGap(job, rawScore);

/** Capability backbone is no longer discounted — gap docks the final composite instead. */
export const applySpecializationGapToBreakdown = (
  breakdown: CapabilityBreakdown,
  _gap: SpecializationGap | undefined,
): CapabilityBreakdown => breakdown;

export const detectCapabilityGap = (
  job: ExtractedJobData,
  rawScore?: ScoreBreakdown,
  resumeText?: string,
): CapabilityGap | undefined => {
  const gap = detectSpecializationGap(job, rawScore, resumeText);
  if (!gap) return undefined;
  return { kind: "specialization", reason: gap.name };
};

export const specializationGapIsNonAddressable = (gap: SpecializationGap | undefined): boolean =>
  Boolean(gap && (gap.lever === "none" || gap.lever === "portfolio" || gap.lever === "upskill"));

export const specializationGapHeadlineWorthy = (gap: SpecializationGap | undefined): boolean =>
  Boolean(gap && (gap.severity === "central" || gap.severity === "moderate"));
