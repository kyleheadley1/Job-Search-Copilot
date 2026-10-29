import type { ExtractedJobData } from "../types/job.js";
import { resolveEmployerScale } from "./employerScale.js";
import {
  isEarlyCareerStructuredLevel,
  resolveStructuredSeniorityLevel,
} from "./seniorityGate.js";
import { normalizeText } from "./text.js";

/** 0 = early/junior, 1 = mid, 2 = senior, 3 = staff+ */
export type SeniorityBand = 0 | 1 | 2 | 3;

export type TitleResponsibilityMismatchEval = {
  mismatch: boolean;
  titleBand: SeniorityBand;
  responsibilityBand: SeniorityBand;
  statedEarlyCareer: boolean;
  highAutonomy: boolean;
  hasSupportStructure: boolean;
  earlyStageOrg: boolean;
  highOwnershipLowSupport: boolean;
  /** Managed / supported team structure (reporting line, XFN team) — not mere mentorship words. */
  hasManagedTeamStructure: boolean;
  /** Canonical Key Risk line when mismatch is true. */
  mismatchRiskNote?: string;
  /** Canonical Key Risk / survivability note when highOwnershipLowSupport is true. */
  highOwnershipLowSupportNote?: string;
};

const INDUSTRY_SENIOR_TITLE_RE =
  /\b(forward\s+deployed(?:\s+engineer)?|founding(?:\s+full[-\s]?stack)?\s+engineer|staff(?:\s+engineer)?|principal(?:\s+engineer)?|distinguished(?:\s+engineer)?|engineering\s+manager|tech\s+lead|team\s+lead)\b/i;

const TITLE_EARLY_RE =
  /\b(junior|associate|entry[-\s]?level|intern|new\s+grad)\b/i;

/** Title modifiers only — not imperative "Lead features…" in responsibilities. */
const TITLE_SENIOR_MODIFIER_RE =
  /\b(senior|sr\.?|staff|principal)\b/i;

/**
 * Total / unsupervised ownership — August Law class.
 * Does NOT include feature-level "lead/own X from design to production" inside a managed team.
 */
const TOTAL_UNSUPERVISED_OWNERSHIP_RE =
  /\b(you\s+decide\s+what\s+done\s+means|decide\s+what\s+done\s+means|own\s+deployments?\s+end\s+to\s+end|own(?:s|\s+the)?\s+(?:the\s+)?(?:deployments?|cutovers?|migrations?|function|roadmap|technical\s+direction)|define\s+how\s+this\s+function\s+works|no\s+margin\s+for\s+error|full\s+autonomy|zero\s*[-–to]+\s*one|0\s*[-–to]+\s*1|live[-\s]?migration|production\s+cutovers?|build\s+from\s+scratch\s+with\s+no\s+support)\b/i;

const FOUNDING_ZERO_TO_ONE_RE =
  /\b(founding(?:\s+engineer)?|zero\s*[-–to]+\s*one|0\s*[-–to]+\s*1|first\s+engineer|1st\s+engineer)\b/i;

/** Mentorship / ramp language. */
const MENTORSHIP_SUPPORT_RE =
  /\b(mentor(?:ship|ed|ing)?|onboarding|ramp(?:\s+up)?|buddy\s+system|pair(?:ed|\s+with)|close\s+supervision|structured\s+training|new\s+grad\s+program|junior[-\s]?friendly|learning\s+environment|coaching|learn(?:ing)?\s+under|works?\s+with\s+experienced\s+(?:forward\s+deployed\s+engineers|fdes?|engineers)|under\s+(?:the\s+)?(?:guidance|mentorship|supervision)\s+of)\b/i;

/** Explicit reporting line or named supporting / cross-functional team. */
const REPORTING_LINE_RE =
  /\b(report(?:s|ing)?\s+to\s+(?:the\s+)?(?:engineering\s+)?manager|reports?\s+to\s+[A-Z][a-z]+|managed\s+by|works?\s+under\s+(?:the\s+)?(?:guidance|direction)\s+of)\b/i;

const CROSS_FUNCTIONAL_TEAM_RE =
  /\b(cross[-\s]?functional|work(?:s|ing)?\s+with\s+(?:a\s+)?(?:cross[-\s]?functional\s+)?(?:team|partners?)|collaborat(?:e|es|ing)\s+with\s+(?:product|design|qa|pm|engineering)|(?:qa|quality\s+assurance|design(?:ers)?|product\s+managers?|pms?|native\s+mobile|data\s+(?:team|engineers?|scientists?)|backend|frontend)\b[^.\n]{0,80}\b(?:and|,)\b[^.\n]{0,60}\b(?:qa|design|product|pm|mobile|data|engineers?)\b)/i;

const NAMED_TEAM_ROSTER_RE =
  /\b(qa|design(?:ers)?|product\s+managers?|\bpms?\b|native\s+mobile|data\s+team|engineering\s+manager)\b/i;

const SEVERITY_EARLY_CAREER_EXCEED_RE =
  /\b(may\s+exceed\s+typical\s+early[-\s]?career|beyond\s+entry[-\s]?level|senior[-\s]?level\s+ownership\s+expected|exceeds?\s+(?:typical\s+)?early[-\s]?career|too\s+senior\s+for|ownership\s+(?:bar|scope)\s+(?:likely\s+)?exceeds?|hands[-\s]?on\s+integrations?.{0,80}exceed)\b/i;

/** Flat mid bar (2+/3+ years) without founding/zero-to-one framing. */
const FLAT_YEARS_BAR_RE =
  /\b(2\+|3\+|at\s+least\s+2|minimum\s+of\s+2|2\s*[-–]\s*\d+)\s*years?\b/i;

const jobEvidenceBlob = (job: ExtractedJobData): string =>
  normalizeText(
    [
      job.title,
      ...(job.responsibilities ?? []),
      ...(job.requirements ?? []),
      ...(job.requiredSkills ?? []),
      job.rawText ?? "",
    ]
      .filter(Boolean)
      .join("\n"),
  );

export const titleImpliedSeniorityBand = (title?: string | null): SeniorityBand => {
  const t = normalizeText(title ?? "");
  if (!t) return 1;
  if (/\b(staff|principal|distinguished|engineering\s+manager|director)\b/i.test(t)) return 3;
  if (INDUSTRY_SENIOR_TITLE_RE.test(t) || TITLE_SENIOR_MODIFIER_RE.test(t)) return 2;
  if (TITLE_EARLY_RE.test(t)) return 0;
  return 1;
};

/**
 * Managed-team / support structure: mentorship OR reporting line OR named XFN team.
 * Feature ownership inside such a structure is mid-band, not unsupervised senior.
 */
export const jdHasManagedTeamStructure = (job: ExtractedJobData): boolean => {
  const blob = jobEvidenceBlob(job);
  if (MENTORSHIP_SUPPORT_RE.test(blob)) return true;
  if (REPORTING_LINE_RE.test(blob)) return true;
  if (CROSS_FUNCTIONAL_TEAM_RE.test(blob)) return true;
  // Roster of supporting roles mentioned together with collaboration language.
  if (
    NAMED_TEAM_ROSTER_RE.test(blob) &&
    /\b(collaborat|partner(?:s|ing)?\s+with|work(?:s|ing)?\s+(?:closely\s+)?with|cross[-\s]?functional)\b/i.test(
      blob,
    )
  ) {
    return true;
  }
  return false;
};

export const jdHasSupportStructureLanguage = (job: ExtractedJobData): boolean =>
  jdHasManagedTeamStructure(job);

export const jdHasTotalUnsupervisedOwnership = (job: ExtractedJobData): boolean => {
  const blob = jobEvidenceBlob(job);
  return TOTAL_UNSUPERVISED_OWNERSHIP_RE.test(blob) || FOUNDING_ZERO_TO_ONE_RE.test(blob);
};

/**
 * Strong countervailing signals: managed team + flat years bar + no founding/zero-to-one.
 * Suppresses mismatch for feature-level "lead/own" verbs.
 */
export const jdHasCountervailingStructureSignals = (job: ExtractedJobData): boolean => {
  const blob = jobEvidenceBlob(job);
  const managed = jdHasManagedTeamStructure(job);
  if (!managed) return false;
  if (FOUNDING_ZERO_TO_ONE_RE.test(blob) || TOTAL_UNSUPERVISED_OWNERSHIP_RE.test(blob)) {
    return false;
  }
  const flatYears =
    FLAT_YEARS_BAR_RE.test(blob) ||
    (job.yearsExperience?.min != null &&
      job.yearsExperience.min >= 2 &&
      job.yearsExperience.min <= 4);
  // Reporting line or XFN team alone is enough; flat years strengthens but isn't required
  // when an explicit manager reporting line exists.
  if (REPORTING_LINE_RE.test(blob) || CROSS_FUNCTIONAL_TEAM_RE.test(blob)) return true;
  return flatYears && managed;
};

export const responsibilityImpliedSeniorityBand = (job: ExtractedJobData): SeniorityBand => {
  const blob = jobEvidenceBlob(job);
  if (!blob.trim()) return 1;

  const managed = jdHasManagedTeamStructure(job);
  const unsupervised = jdHasTotalUnsupervisedOwnership(job);

  // Feature-level lead/own inside a managed team → mid, not senior.
  if (managed && !unsupervised) return 1;

  if (unsupervised) return 2;

  if (MENTORSHIP_SUPPORT_RE.test(blob)) return 0;
  if (/\b(collaborate|work\s+with|pair|mentor|guidance|support\s+from)\b/i.test(blob)) return 1;
  return 1;
};

export const jdHasHighAutonomyLanguage = (job: ExtractedJobData): boolean =>
  jdHasTotalUnsupervisedOwnership(job);

export const isEarlyStageHighOwnershipOrg = (job: ExtractedJobData): boolean => {
  const scale = resolveEmployerScale(job);
  const blob = normalizeText(job.rawText ?? "");
  const under50 =
    (scale.employeeCount != null && scale.employeeCount <= 50) ||
    /\b(1[-\s]?10|11[-\s]?50)\s*(employees|employee|people)\b/i.test(blob);
  const seedOnly =
    /\b(seed(?:\s+round)?|pre[-\s]?seed|single[-\s]?seed|raised\s+\$?\d+\s*m(?:illion)?)\b/i.test(blob) &&
    !/\b(series\s+[b-z]|post[-\s]?ipo|publicly\s+traded)\b/i.test(blob);
  return under50 || (seedOnly && (scale.employeeCount == null || scale.employeeCount <= 100));
};

export const statedLevelIsEarlyCareer = (job: ExtractedJobData): boolean => {
  const level = resolveStructuredSeniorityLevel(job);
  if (level && isEarlyCareerStructuredLevel(level)) return true;
  const yearsMin = job.yearsExperience?.min;
  const yearsMax = job.yearsExperience?.max;
  // Flat 2+ years alone is a mid bar, not "early-career tagging" for mismatch purposes
  // unless also junior/associate chrome.
  if (yearsMin != null && yearsMin <= 1) return true;
  // Explicit 0–3 ramp (Trunk Tools): min at or below 1 with a cap of 3, or a stated 0–3 range.
  if (yearsMax != null && yearsMax <= 3 && (yearsMin == null || yearsMin <= 1)) return true;
  const blob = normalizeText([job.seniority, job.rawText ?? "", job.title ?? ""].filter(Boolean).join("\n"));
  return /\b(junior|entry[-\s]?level|associate|early[-\s]?career|0\s*(?:[–-]|to)\s*[123]\s*years?|1[-\s]?2\s*years?|1\+\s*years?)\b/i.test(
    blob,
  );
};

/**
 * Title vs responsibility consistency, plus stated junior/years conflicting with
 * senior title or unsupervised high-autonomy responsibilities.
 *
 * Countervailing managed-team structure suppresses feature-ownership false positives
 * and keeps Level-fit mismatch aligned with high-ownership/low-support survivability.
 */
export const evaluateTitleResponsibilitySeniority = (
  job: ExtractedJobData,
): TitleResponsibilityMismatchEval => {
  const titleBand = titleImpliedSeniorityBand(job.title);
  const hasManagedTeamStructure = jdHasManagedTeamStructure(job);
  const hasSupportStructure = hasManagedTeamStructure;
  const countervailing = jdHasCountervailingStructureSignals(job);
  const unsupervised = jdHasTotalUnsupervisedOwnership(job);
  const responsibilityBand = responsibilityImpliedSeniorityBand(job);
  const statedEarlyCareer = statedLevelIsEarlyCareer(job);
  const highAutonomy = unsupervised;
  const earlyStageOrg = isEarlyStageHighOwnershipOrg(job);

  const highOwnershipLowSupport =
    highAutonomy && !hasSupportStructure && earlyStageOrg;

  const bandDelta = Math.abs(titleBand - responsibilityBand);
  const classicMismatch =
    bandDelta > 1 &&
    // Only when the high band is real unsupervised ownership, not feature lead verbs.
    (responsibilityBand < 2 || unsupervised) &&
    !countervailing;

  // Senior-coded title (FDE / founding) tagged junior — still a mismatch unless
  // strong managed-team countervailing AND no unsupervised ownership language.
  const seniorTitleTaggedEarly =
    titleBand >= 2 &&
    statedEarlyCareer &&
    !countervailing &&
    (unsupervised || !hasManagedTeamStructure);

  // Associate/junior title + unsupervised ownership (Eulerity class).
  const earlyTitleUnsupervisedOwnership =
    titleBand <= 0 && unsupervised && !countervailing;

  // Align with survivability: if support structure exists such that highOwnershipLowSupport
  // would not fire, do not apply a full Level-fit mismatch from responsibility autonomy alone
  // for unmodified mid titles.
  const midTitleFeatureOwnershipOnly =
    titleBand === 1 && !unsupervised && hasManagedTeamStructure;

  let mismatch =
    !midTitleFeatureOwnershipOnly &&
    (classicMismatch || seniorTitleTaggedEarly || earlyTitleUnsupervisedOwnership);

  // Final agreement gate: when managed structure is present and ownership is not
  // unsupervised/total, never fire mismatch (NYT Reflections class).
  if (countervailing && !unsupervised) {
    mismatch = false;
  }

  // Early-career FDE ramp (Trunk Tools): title uses the FDE label but the JD is
  // explicitly 0–3 years with learning under experienced FDEs. Do not treat that
  // as a senior-title mismatch. "Senior/Staff FDE" and unsupervised ownership stay.
  const title = normalizeText(job.title ?? "");
  const earlyYearRange =
    (job.yearsExperience?.max != null &&
      job.yearsExperience.max <= 3 &&
      (job.yearsExperience.min == null || job.yearsExperience.min <= 1)) ||
    /\b0\s*(?:[–-]|to)\s*[123]\s*years?\b/i.test(jobEvidenceBlob(job));
  const explicitJuniorFdeRamp =
    INDUSTRY_SENIOR_TITLE_RE.test(title) &&
    !TITLE_SENIOR_MODIFIER_RE.test(title) &&
    statedEarlyCareer &&
    !unsupervised &&
    (hasManagedTeamStructure || earlyYearRange);
  if (explicitJuniorFdeRamp) {
    mismatch = false;
  }

  let mismatchRiskNote: string | undefined;
  if (mismatch) {
    if (earlyTitleUnsupervisedOwnership || (classicMismatch && titleBand <= 0 && responsibilityBand >= 2)) {
      mismatchRiskNote =
        "Title/responsibility mismatch — junior/associate title paired with senior-autonomy responsibilities (end-to-end ownership without stated support structure).";
    } else if (seniorTitleTaggedEarly || (titleBand >= 2 && statedEarlyCareer)) {
      mismatchRiskNote =
        "Title/responsibility mismatch — title reads as high-autonomy/senior (e.g. Forward Deployed / founding-style) while the listing is tagged junior or 1–2 years; responsibilities confirm ownership beyond early-career ramp.";
    } else {
      mismatchRiskNote =
        "Title/responsibility mismatch — seniority implied by the title and the responsibilities disagree by more than one level; do not rely on stated years alone.";
    }
  }

  const highOwnershipLowSupportNote = highOwnershipLowSupport
    ? "High ownership, low support — role expects end-to-end autonomy with no mentorship/onboarding language at a small early-stage engineering org."
    : undefined;

  return {
    mismatch,
    titleBand,
    responsibilityBand,
    statedEarlyCareer,
    highAutonomy,
    hasSupportStructure,
    earlyStageOrg,
    highOwnershipLowSupport,
    hasManagedTeamStructure,
    mismatchRiskNote,
    highOwnershipLowSupportNote,
  };
};

/** True when risk/note prose asserts the role likely exceeds early-career scope. */
export const textSignalsEarlyCareerExceedSeverity = (text: string): boolean =>
  SEVERITY_EARLY_CAREER_EXCEED_RE.test(text);

export const TITLE_RESPONSIBILITY_MISMATCH_LEVEL_FIT_MAX = 8;
export const EARLY_CAREER_EXCEED_SEVERITY_LEVEL_FIT_MAX = 9;
export const HIGH_OWNERSHIP_LOW_SUPPORT_SURV_PENALTY = 0.12;
