import type { ExtractedJobData } from "../types/job.js";
import type { RuleEvaluation } from "../types/scoring.js";
import { jdDutiesBlob, jdSignalsSeniorDepthRequirements } from "./jdGroundedRiskNotes.js";
import { extractGroundedYearsClauses } from "./yearsExperienceReconciliation.js";
import { normalizeText } from "./text.js";
import { logger } from "./logger.js";

const TITLE_SENIOR_STAFF_RE = /\b(senior|staff|principal|sr\.?)\b/i;
const TITLE_LEAD_ROLE_RE =
  /\b(tech\s+lead|team\s+lead|lead\s+(?:engineer|developer|software|sre|data|ml|ai|platform|product|backend|frontend|full[\s-]?stack))\b/i;
const TITLE_EXEC_ROLE_RE = /\b(engineering\s+manager|director\s+of\s+engineering)\b/i;

/** Architect as a role-title noun — not imperative verb ("Architect core systems…"). */
const TITLE_ARCHITECT_ROLE_RE =
  /\b((?:principal|staff|senior|lead|software|systems|platform|solution|data|cloud|security|enterprise|technical|application)\s+architect|architect\s+(?:engineer|of\s+record))\b/i;

const VERB_ARCHITECT_TITLE_RE =
  /^architect\s+(?:core|the|our|a|an|and|to|scalable|robust|high|new|ml|ai|data|backend|frontend|distributed|key|major|production|cloud|mobile|agent|llm|rag|api|platform|pipeline|system|systems|solution|solutions|features|services|infrastructure|components|workflows|integrations|products|experiences|capabilities)\b/i;

/** Single seniority band token (Simplify / Greenhouse multi-select values). */
const SENIORITY_BAND_TOKEN =
  "(?:entry(?:\\s+level)?|junior|mid(?:\\s*-?\\s*level)?|associate|new\\s*grad|intern|senior(?:\\s+level)?|staff|principal|lead(?:\\/?staff)?|lead\\/staff)";

/** Labeled Simplify Seniority next-line values — single band or comma-separated multi-band. */
const METADATA_SENIORITY_VALUE_RE = new RegExp(
  `^${SENIORITY_BAND_TOKEN}(?:\\s*,\\s*${SENIORITY_BAND_TOKEN})*$`,
  "i",
);

const EARLY_METADATA_SENIORITY_VALUE_RE = new RegExp(
  `^(?:entry(?:\\s+level)?|junior|mid(?:\\s*-?\\s*level)?|associate|new\\s*grad|intern)(?:\\s*,\\s*${SENIORITY_BAND_TOKEN})*$`,
  "i",
);

/**
 * Explicit "Seniority" chrome label + next line. Preferred structured source.
 * Bare unlabeled "Junior, Mid" lines (title-adjacent Simplify chrome) are NOT trusted alone
 * for gating — they may exist without a real Seniority field.
 */
export const readLabeledSeniorityValue = (job: ExtractedJobData): string | null => {
  const lines = (job.rawText ?? "")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

  const seniorityLabelIdx = lines.findIndex((l) => /^seniority$/i.test(l));
  if (seniorityLabelIdx >= 0) {
    const next = lines[seniorityLabelIdx + 1];
    if (next && METADATA_SENIORITY_VALUE_RE.test(next)) return next;
  }
  return null;
};

export const hasTrustedStructuredSeniority = (job: ExtractedJobData): boolean =>
  Boolean(readLabeledSeniorityValue(job)?.trim() || job.seniority?.trim());

/** True when only years/body year bands exist — no Seniority label and no seniority field. */
export const hasEmptyStructuredSeniority = (job: ExtractedJobData): boolean =>
  !readLabeledSeniorityValue(job)?.trim() && !job.seniority?.trim();

/**
 * Structured seniority for gating.
 * Prefer labeled Seniority field; then early-career chrome lines (Mid Level / Junior, Mid);
 * then job.seniority. Unlabeled early lines never promote senior/staff — that avoided
 * body pollution, but early chrome must still veto over a polluted seniority field.
 */
export const resolveStructuredSeniorityLevel = (job: ExtractedJobData): string => {
  const labeled = readLabeledSeniorityValue(job);
  if (labeled) return labeled;

  const lines = (job.rawText ?? "")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  for (const line of lines.slice(0, 30)) {
    if (EARLY_METADATA_SENIORITY_VALUE_RE.test(line)) return line;
  }

  return job.seniority?.trim() ?? "";
};

export const isEarlyCareerStructuredLevel = (level: string): boolean =>
  /\b(junior|mid|entry|early career|associate|new grad|intern)\b/i.test(normalizeText(level));

/**
 * Whether the structured seniority field describes a senior/staff/principal role level.
 * Multi-band listings gate on the LOWEST listed band — "Mid, Senior Level, Lead/Staff"
 * is open to Mid and is not field-overreach by itself (Lead/Staff must not win).
 */
export const seniorityFieldSignalsOverreach = (seniority?: string | null): boolean => {
  if (!seniority?.trim()) return false;
  const s = normalizeText(seniority);
  // Lowest band wins: any early/mid band present → field alone is not overreach.
  if (/\b(junior|mid|entry|early career|associate|new grad|intern)\b/i.test(s)) return false;
  return /\b(senior|staff|principal|director|lead)\b/i.test(s);
};

export const yearsExperienceSignalsOverreach = (min?: number | null): boolean =>
  (min ?? 0) >= 5;

/**
 * Early-career structured level with compatible years vetoes the seniority hard gate.
 * When early-career chrome conflicts with years ≥5 (polluted parse), do NOT veto via this
 * path — the gate fail-safes to manual review instead of firing on years alone.
 */
export const earlyCareerLevelVetoesSeniorityGate = (job: ExtractedJobData): boolean => {
  const level = normalizeText(resolveStructuredSeniorityLevel(job));
  if (!level || !isEarlyCareerStructuredLevel(level)) return false;
  const yearsMin = job.yearsExperience?.min;
  return yearsMin == null || yearsMin <= 4;
};

/**
 * Early chrome says junior/mid but yearsExperience.min ≥5 — extraction conflict.
 * Fail safe: do not silently gate from the years parse.
 */
export const earlyCareerConflictsWithYears = (job: ExtractedJobData): boolean => {
  const level = normalizeText(resolveStructuredSeniorityLevel(job));
  if (!level || !isEarlyCareerStructuredLevel(level)) return false;
  return yearsExperienceSignalsOverreach(job.yearsExperience?.min);
};

/**
 * Senior/staff seniority field with nothing in the posting to back it: no explicit
 * Seniority label, no seniority noun in the title, and years min unstated or ≤4.
 * The field is then an inference (often from prose like "senior client engineers").
 */
export const seniorityFieldUncorroborated = (job: ExtractedJobData): boolean =>
  !readLabeledSeniorityValue(job) &&
  !roleTitleSignalsSeniority(job.title) &&
  !yearsExperienceSignalsOverreach(job.yearsExperience?.min) &&
  seniorityFieldSignalsOverreach(effectiveSeniorityFieldForGate(job));

/**
 * Flag for manual review when:
 * - the senior seniority field is uncorroborated (see above), OR
 * - structured seniority is empty and body years alone would gate, OR
 * - early-career chrome conflicts with years ≥5 (polluted year parse like 2–10+ → min 10).
 * Do not silently fire the hard gate in those cases.
 */
export const seniorityNeedsManualReview = (job: ExtractedJobData): boolean => {
  if (roleTitleSignalsSeniority(job.title)) return false;
  if (earlyCareerLevelVetoesSeniorityGate(job)) return false;
  if (earlyCareerConflictsWithYears(job)) return true;
  if (seniorityFieldUncorroborated(job)) return true;
  if (hasEmptyStructuredSeniority(job) && yearsExperienceSignalsOverreach(job.yearsExperience?.min)) {
    return true;
  }
  return false;
};

export type SeniorityGateTriggerExplanation = {
  wouldFire: boolean;
  vetoed: boolean;
  vetoReason?: string;
  triggerSource?: "title" | "yearsExperience" | "seniorityField" | "rulesFlagOnly";
  triggerDetail?: string;
  resolvedLevel?: string;
  parsedSeniorityField?: string | null;
  needsManualReview?: boolean;
};

/** Trace which signal would add the seniority hard gate (for calibration/debug). */
export const explainSeniorityGateTrigger = (
  job: ExtractedJobData,
  rules?: Pick<RuleEvaluation, "seniorityOverreach">,
): SeniorityGateTriggerExplanation => {
  const resolvedLevel = resolveStructuredSeniorityLevel(job);
  const parsedSeniorityField = job.seniority ?? null;
  const base = { resolvedLevel, parsedSeniorityField };
  const needsManualReview = seniorityNeedsManualReview(job);

  if (earlyCareerLevelVetoesSeniorityGate(job)) {
    if (jdSignalsSeniorDepthRequirements(job)) {
      return {
        ...base,
        wouldFire: true,
        vetoed: false,
        triggerSource: "seniorityField",
        triggerDetail:
          "early-career multi-band tag present, but Required text signals senior-depth asks",
        needsManualReview: false,
      };
    }
    return {
      ...base,
      wouldFire: false,
      vetoed: true,
      vetoReason: `early-career structured level (${resolvedLevel || parsedSeniorityField}) with years min ${job.yearsExperience?.min ?? "unset"} ≤ 4`,
      needsManualReview: false,
    };
  }

  if (titleOrLabelSignalsSeniority(job)) {
    const stretch = !jdDemandsSeniorExperience(job);
    const source = roleTitleSignalsSeniority(job.title) ? "title" : "seniorityField";
    const detail = source === "title" ? (job.title ?? "") : (readLabeledSeniorityValue(job) ?? "");
    return {
      ...base,
      wouldFire: !stretch,
      vetoed: false,
      triggerSource: source,
      triggerDetail: stretch
        ? `${detail} — title/label only, JD asks for nothing beyond the profile: stretch dock, no gate`
        : detail,
      needsManualReview: false,
    };
  }

  if (needsManualReview) {
    return {
      ...base,
      wouldFire: false,
      vetoed: false,
      needsManualReview: true,
      triggerDetail: earlyCareerConflictsWithYears(job)
        ? "early-career seniority conflicts with years min ≥5 — fail safe, no gate"
        : seniorityFieldUncorroborated(job)
          ? `seniority field "${job.seniority}" not backed by title, Seniority label, or years ≥5 — no gate`
          : "structured seniority empty — years/prose alone do not gate",
    };
  }

  if (yearsExperienceSignalsOverreach(job.yearsExperience?.min)) {
    return {
      ...base,
      wouldFire: true,
      vetoed: false,
      triggerSource: "yearsExperience",
      triggerDetail: String(job.yearsExperience?.min),
      needsManualReview: false,
    };
  }

  const seniorityField = effectiveSeniorityFieldForGate(job);
  if (seniorityFieldSignalsOverreach(seniorityField)) {
    return {
      ...base,
      wouldFire: true,
      vetoed: false,
      triggerSource: "seniorityField",
      triggerDetail: seniorityField ?? "",
      needsManualReview: false,
    };
  }

  if (rules?.seniorityOverreach) {
    return {
      ...base,
      wouldFire: true,
      vetoed: false,
      triggerSource: "rulesFlagOnly",
      triggerDetail: "rules.seniorityOverreach=true without detectable trigger",
      needsManualReview: false,
    };
  }

  return { ...base, wouldFire: false, vetoed: false, needsManualReview: false };
};

export const logSeniorityGateEvaluation = (
  job: ExtractedJobData,
  rules: Pick<RuleEvaluation, "seniorityOverreach">,
  vetoed: boolean,
): void => {
  const explanation = explainSeniorityGateTrigger(job, rules);
  if (vetoed) {
    logger.info("Seniority hard gate vetoed at evaluation", explanation);
    return;
  }
  if (explanation.needsManualReview) {
    logger.info("Seniority hard gate deferred for manual review", explanation);
    return;
  }
  if (explanation.wouldFire || rules.seniorityOverreach) {
    logger.info("Seniority hard gate firing", explanation);
  }
};

export const titleArchitectIsRoleNoun = (title?: string | null): boolean => {
  const t = normalizeText(title ?? "");
  if (!t || VERB_ARCHITECT_TITLE_RE.test(t)) return false;
  if (TITLE_ARCHITECT_ROLE_RE.test(t)) return true;
  if (/\barchitect\b/i.test(t) && t.split(/\s+/).length <= 4 && !/\b(and|with|for|to|will|help)\b/i.test(t)) {
    return true;
  }
  return false;
};

/** Seniority tokens in the role TITLE only — noun forms, not body/responsibility verbs. */
export const roleTitleSignalsSeniority = (title?: string | null): boolean => {
  const t = normalizeText(title ?? "");
  if (!t) return false;
  if (TITLE_SENIOR_STAFF_RE.test(t)) return true;
  if (TITLE_LEAD_ROLE_RE.test(t)) return true;
  if (TITLE_EXEC_ROLE_RE.test(t)) return true;
  return titleArchitectIsRoleNoun(t);
};

export const effectiveSeniorityFieldForGate = (job: ExtractedJobData): string | null => {
  const resolved = resolveStructuredSeniorityLevel(job);
  if (resolved && isEarlyCareerStructuredLevel(resolved)) return resolved;
  return job.seniority ?? (resolved || null);
};

/** Required/responsibility asks that only an experienced hire meets (people leadership, years leading). */
const SENIOR_EXPERIENCE_ASK_RE =
  /\b(direct reports|people management|people manager|manag(?:e|ing) (?:a |the )?team of|lead(?:ing)? (?:a |the )?team of \d+|proven track record of (?:leading|managing)|extensive (?:industry |professional )?experience|\d+\+?\s*years?[^.\n]{0,40}\b(?:leading|leadership|managing|people management|as a (?:tech|team) lead)|set(?:ting)? technical (?:direction|strategy) (?:for|across) (?:the )?(?:org|organization|company|multiple teams))\b/i;

export const jdAsksForSeniorExperience = (job: ExtractedJobData): boolean =>
  SENIOR_EXPERIENCE_ASK_RE.test(jdDutiesBlob(job));

/** Explicit JD year floors (including fractional 1.5+). Conflicting floors return null. */
export const requiredYearsRangeInDuties = (
  job: ExtractedJobData,
): { min: number; max?: number } | null => {
  const clauses = extractGroundedYearsClauses(job);
  if (clauses.length === 0) return null;
  const unique: number[] = [];
  for (const m of clauses.map((c) => c.min)) {
    if (!unique.some((n) => Math.abs(n - m) < 0.05)) unique.push(m);
  }
  if (unique.length !== 1) return null;
  const clause = clauses.find((c) => Math.abs(c.min - unique[0]!) < 0.05)!;
  return { min: clause.min, max: clause.max };
};

export const requiredYearsInDuties = (job: ExtractedJobData): number | null =>
  requiredYearsRangeInDuties(job)?.min ?? null;

/** Experience the JD actually demands beyond an early-career profile. */
export const jdDemandsSeniorExperience = (job: ExtractedJobData): boolean =>
  yearsExperienceSignalsOverreach(job.yearsExperience?.min ?? requiredYearsInDuties(job)) ||
  jdSignalsSeniorDepthRequirements(job) ||
  jdAsksForSeniorExperience(job);

const titleOrLabelSignalsSeniority = (job: ExtractedJobData): boolean =>
  roleTitleSignalsSeniority(job.title) || seniorityFieldSignalsOverreach(readLabeledSeniorityValue(job));

/**
 * - "overreach": the posting obviously wants more experience (5+ years, senior-depth or
 *   people-leadership asks) → hard gate.
 * - "stretch": only the title/Seniority label reads senior/staff/principal and the JD asks
 *   for nothing beyond the profile (e.g. "Principal AI Engineer", 1+ years) → soft dock.
 * - "none": no seniority signal, early-career veto, or an inferred label with nothing to back it.
 *
 * Multi-band Mid/Junior tags still overreach on senior-depth Required text (Luminos guard).
 * Fail safe (no gate + manual review) when structured seniority is empty and only body years
 * would fire, or early-career chrome conflicts with years ≥5.
 */
export type SeniorityAssessment = "none" | "stretch" | "overreach";

export const assessRoleSeniority = (job: ExtractedJobData): SeniorityAssessment => {
  if (earlyCareerLevelVetoesSeniorityGate(job)) {
    return jdSignalsSeniorDepthRequirements(job) ? "overreach" : "none";
  }
  if (titleOrLabelSignalsSeniority(job)) {
    return jdDemandsSeniorExperience(job) ? "overreach" : "stretch";
  }
  if (seniorityNeedsManualReview(job)) return "none";
  return yearsExperienceSignalsOverreach(job.yearsExperience?.min) ? "overreach" : "none";
};

export const detectRoleSeniorityOverreach = (job: ExtractedJobData): boolean =>
  assessRoleSeniority(job) === "overreach";

export const detectRoleSeniorityStretch = (job: ExtractedJobData): boolean =>
  assessRoleSeniority(job) === "stretch";

export { EARLY_METADATA_SENIORITY_VALUE_RE, jdSignalsSeniorDepthRequirements };
