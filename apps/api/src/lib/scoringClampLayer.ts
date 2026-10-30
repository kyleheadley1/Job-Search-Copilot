import { SCORING_CLAMP_POLICY } from "../config/scoringClampPolicy.js";
import { STACK_MISMATCH_CAPS } from "../config/scoringPolicy.js";
import type { ExtractedJobData } from "../types/job.js";
import { earlyCareerLevelVetoesSeniorityGate } from "./seniorityGate.js";
import type { HardRuleFlag, RuleEvaluation, ScoreBreakdown } from "../types/scoring.js";
import {
  applyJdLanguageOutputBoundary,
  coreLanguageMismatchMessage,
  jdGroundedCoreLanguageGaps,
} from "./jdLanguageOutputBoundary.js";
import { normalizeText } from "./text.js";
import {
  classifyRoleLane,
  roleLaneIsAdjacent,
  roleLaneIsFrontendPrimary,
  roleLaneIsPlatformInfra,
} from "./roleFunctionClassifier.js";
import { isContractEmploymentType } from "./contractEmployment.js";
import { structuredFirstJobBlob } from "./structuredFirstJobBlob.js";
import {
  EARLY_CAREER_EXCEED_SEVERITY_LEVEL_FIT_MAX,
  TITLE_RESPONSIBILITY_MISMATCH_LEVEL_FIT_MAX,
  textSignalsEarlyCareerExceedSeverity,
} from "./titleResponsibilitySeniority.js";
import {
  detectReinforcedExperienceFloor,
  estimateCandidateProfessionalYears,
  reinforcedFloorLevelFitDock,
} from "./reinforcedExperienceFloor.js";
import {
  PRODUCTION_INFRA_OWNERSHIP_LEVEL_FIT_DOCK,
} from "./namedCapabilityRiskPenalty.js";
import type { UserProfile } from "../types/userProfile.js";
import { levelFitCeilingForSeniorityDock, seniorityLevelFitDock } from "./experienceGap.js";
import { userProfile as defaultUserProfile } from "../config/userProfile.js";

const jobBlob = (job: ExtractedJobData): string => structuredFirstJobBlob(job);

/** Employer-industry finance signals — not benefits (401k/pension) or bare "insurance" wellness copy. */
const FINANCE_DOMAIN_RE =
  /\b(fintech|trading|quant(?:itative)?|banking|investment\s+bank|asset management|hedge fund|market maker|insurance\s+carrier|life\s+insurer|prudential|jane street|citadel|two sigma|goldman|jpmorgan|blackrock)\b/i;

const FINANCE_DOMAIN_TAG_RE =
  /\b(finance|fintech|banking|trading|quant|insurance|investment)\b/i;

const QUANT_TRADING_RE =
  /\b(quant(?:itative)?\s+trading|trading\s+firm|market\s+maker|proprietary\s+trading|jane\s+street|citadel|two\s+sigma|hudson\s+river|de\s+shaw)\b/i;

const STAFFING_AGENCY_RE =
  /\b(staffing(\s+agency|\s+firm)?|recruiting\s+(agency|firm)|talent\s+solutions|tech\s+consulting|jsr\s+tech|staff\s+aug|staff-aug|contract\s+staffing)\b/i;

/** Drop benefits / wellness boilerplate so 401k and "health insurance" cannot open the finance path. */
const stripBenefitsBoilerplate = (text: string): string =>
  normalizeText(text)
    .replace(/\bbenefits?\b[:\s-][^\n.]{0,400}/gi, " ")
    .replace(
      /\b(401\(?k\)?|retirement\s+planning|financial\s+wellness|pension\s+(?:plan|education)|health\s+insurance|competitive\s+salary)\b/gi,
      " ",
    );

/** Product BNPL / consumer healthcare financing — not bank/trading/staffing placement. */
const PRODUCT_BNPL_OR_CONSUMER_FINANCE_RE =
  /\b(bnpl|buy\s+now\s+pay\s+later|patient\s+financ|healthcare\s+financ|medical\s+financ|consumer\s+financ|point[-\s]?of[-\s]?sale\s+financ|care\s+credit)\b/i;

const HOURLY_W2_RE =
  /\b(hourly|\/hr|per\s+hour|w-?2\s+contract|contract\s+to\s+hire|c2h)\b/i;

const RAW_DEGREE =
  /\b(bachelor'?s?\s+degree|bachelors\s+degree|bs\s+in|b\.s\.|ba\s+in)[^.\n]{0,160}\brequired\b|\bdegree\s+in\s+(computer science|cs|engineering)\s+required\b/i;

const INFRA_PLATFORM_SHAPE_RE =
  /\b(edge\s+computing|cloudflare\s+workers|fastly|terraform|kubernetes|\bk8s\b|\biac\b|infrastructure\s+as\s+code|site\s+reliability|\bsre\b|observability|platform\s+architecture|edge\s+platform|cdn)\b/i;

const ML_RESEARCH_SHAPE_RE =
  /\b(pytorch|tensorflow|modeling|machine\s+learning\s+research|research\s+scientist|ml\s+research|deep\s+learning\s+research|training\s+models|neural\s+network\s+research)\b/i;

const hasCoreLanguageClamp = (rules: RuleEvaluation): boolean =>
  Boolean(
    !rules.disjunctiveLanguageRequirementSatisfied &&
      (rules.stackMismatch ||
        rules.explicitCoreLanguageMismatch ||
        (rules.coreLanguageGap?.length ?? 0) > 0),
  );

/**
 * Residual shapes when `platform_infra` lane is not enough (edge/platform chrome,
 * ML/research). Prefer `classifyRoleLane` → `platform_infra` for true platform titles.
 */
export const detectRoleShapeOutsideLane = (job: ExtractedJobData): boolean => {
  const blob = jobBlob(job);
  return INFRA_PLATFORM_SHAPE_RE.test(blob) || ML_RESEARCH_SHAPE_RE.test(blob);
};

export const detectFinanceClampContext = (
  job: ExtractedJobData,
  rules: RuleEvaluation,
): { financePenalty: boolean; quantTrading: boolean; staffingPlacement: boolean; credentialHeavy: boolean } => {
  const blob = stripBenefitsBoilerplate(jobBlob(job));
  const employerFocused = stripBenefitsBoilerplate(
    normalizeText(
      [
        job.company,
        job.employerCompanyName,
        job.title,
        ...(job.domainTags ?? []),
        ...(job.responsibilities ?? []),
        ...(job.requirements ?? []),
      ]
        .filter(Boolean)
        .join("\n"),
    ),
  );

  // Product BNPL / healthcare financing employers are not bank/trading/staffing placements.
  if (PRODUCT_BNPL_OR_CONSUMER_FINANCE_RE.test(blob) || PRODUCT_BNPL_OR_CONSUMER_FINANCE_RE.test(employerFocused)) {
    const quantTrading = QUANT_TRADING_RE.test(blob);
    return { financePenalty: quantTrading, quantTrading, staffingPlacement: false, credentialHeavy: false };
  }

  const financeDomain =
    rules.financePenalty ||
    (job.domainTags ?? []).some((t) => FINANCE_DOMAIN_TAG_RE.test(t)) ||
    FINANCE_DOMAIN_RE.test(employerFocused) ||
    FINANCE_DOMAIN_RE.test(blob);
  if (!financeDomain) {
    return { financePenalty: false, quantTrading: false, staffingPlacement: false, credentialHeavy: false };
  }

  // Staffing/placement: agency fields or explicit staffing-agency company — not "consulting with PMs" in duties.
  const staffingPlacement =
    Boolean(job.agencyCompanyName?.trim()) ||
    Boolean(
      job.employerCompanyName?.trim() &&
        job.listingCompanyName?.trim() &&
        normalizeText(job.employerCompanyName!) !== normalizeText(job.listingCompanyName!),
    ) ||
    STAFFING_AGENCY_RE.test(normalizeText(job.company ?? "")) ||
    STAFFING_AGENCY_RE.test(normalizeText(job.agencyCompanyName ?? "")) ||
    /\bstaffing\s+placement\b/i.test(blob);

  const credentialHeavy =
    rules.credentialHeavyFintechAlgorithm ||
    (rules.financePenalty && rules.explicitDegreeRisk) ||
    /\b(gaap|series\s+\d+|licensed|cfa|frm|actuarial)\b/i.test(employerFocused);

  const quantTrading = QUANT_TRADING_RE.test(blob);
  // Hard finance clamp / placement flag: institution staffing, credentials, or quant — not bare product-fintech tags.
  const financePenalty = credentialHeavy || staffingPlacement || quantTrading;

  return { financePenalty, quantTrading, staffingPlacement, credentialHeavy };
};

export const detectStaffAugContractRole = (job: ExtractedJobData): boolean => {
  const blob = jobBlob(job);
  if (HOURLY_W2_RE.test(blob)) return true;
  if (STAFFING_AGENCY_RE.test(normalizeText(job.company ?? ""))) return true;
  if (job.agencyCompanyName?.trim()) return true;
  if (
    job.employerCompanyName?.trim() &&
    job.listingCompanyName?.trim() &&
    normalizeText(job.employerCompanyName) !== normalizeText(job.listingCompanyName)
  ) {
    return true;
  }
  return false;
};

export const buildHardRuleFlags = (
  job: ExtractedJobData,
  rules: RuleEvaluation,
): HardRuleFlag[] => {
  const flags: HardRuleFlag[] = [];
  const seen = new Set<string>();

  const push = (flag: HardRuleFlag) => {
    if (seen.has(flag.id)) return;
    seen.add(flag.id);
    flags.push(flag);
  };

  if (rules.seniorityOverreach && !earlyCareerLevelVetoesSeniorityGate(job)) {
    push({
      id: "seniorityOverreach",
      message:
        "Seniority overreach — role reads Senior/Staff or expects experienced ownership beyond early-career profile.",
    });
  }

  const langs = jdGroundedCoreLanguageGaps(rules, job);
  const coreLanguageMismatch =
    !rules.disjunctiveLanguageRequirementSatisfied &&
    langs.length > 0 &&
    (rules.stackMismatch ||
      rules.explicitCoreLanguageMismatch ||
      (rules.coreLanguageGap?.length ?? 0) > 0);

  if (coreLanguageMismatch && langs.length > 0) {
    push({
      id: "coreLanguageMismatch",
      citedLanguages: langs,
      message: coreLanguageMismatchMessage(langs),
    });
  }

  if (rules.explicitDegreeRisk && rules.matureStructuredEmployer && !rules.degreeEquivalencySatisfied) {
    push({
      id: "degreeGateStructuredEmployer",
      message:
        "Degree gate at structured employer — bootcamp/equivalent language rarely survives first-pass ATS screen.",
    });
  } else if (
    rules.degreeHasEquivalencyClause &&
    !rules.degreeEquivalencySatisfied &&
    (job.degreeRequirement?.level === "required" ||
      Boolean(job.degreeRequirement?.raw?.trim()) ||
      RAW_DEGREE.test(job.rawText ?? ""))
  ) {
    push({
      id: "degreePreferenceWithEquivalency",
      message: rules.degreeConflictingRequirement
        ? "JD requires a specific degree on one line and allows equivalent experience on another — the strict line likely drives first-pass screening."
        : "Degree listed but JD allows related/equivalent experience — soft preference, not a first-pass filter.",
    });
  }

  const finance = detectFinanceClampContext(job, rules);
  if (finance.staffingPlacement || finance.credentialHeavy) {
    push({
      id: "financePenalty",
      message:
        "Finance/trading/insurance placement — credential-heavy screen or staffing into financial institution.",
    });
  }
  if (finance.quantTrading) {
    push({
      id: "quantTradingMismatch",
      message: "Quant/trading role shape — domain and core-language bar outside product SWE lane.",
    });
  }

  return flags;
};

export type ScoringClampResult = {
  score: ScoreBreakdown;
  rules: RuleEvaluation;
};

/**
 * Post-processing clamp layer: apply category caps/flags after raw LLM scores, before sum + total ceiling.
 * Does not modify raw scoring prompts or LLM logic.
 */
export const applyScoringClampLayer = (params: {
  score: ScoreBreakdown;
  extracted: ExtractedJobData;
  rules: RuleEvaluation;
  profile?: UserProfile;
  resumeText?: string;
}): ScoringClampResult => {
  const hardRuleFlags = buildHardRuleFlags(params.extracted, params.rules);
  const financeCtx = detectFinanceClampContext(params.extracted, params.rules);
  const roleLane = classifyRoleLane(params.extracted);

  const rules: RuleEvaluation = {
    ...params.rules,
    // Keep product-fintech rules.financePenalty for soft notes; only escalate clamp when placement/credential/quant.
    financePenalty: financeCtx.financePenalty || params.rules.financePenalty,
    hardRuleFlags,
    roleShapeOutsideLane:
      roleLaneIsPlatformInfra(roleLane.label) || detectRoleShapeOutsideLane(params.extracted),
    roleLane: roleLane.label,
    roleLaneKind: roleLane.adjacentKind,
    adjacentRoleFunction: roleLaneIsAdjacent(roleLane.label),
    frontendPrimaryRole: roleLaneIsFrontendPrimary(roleLane.label),
    platformInfraRole: roleLaneIsPlatformInfra(roleLane.label),
  };

  let score = { ...params.score };

  // Rule 1 — story & functional under core-language / stack mismatch
  if (hasCoreLanguageClamp(rules)) {
    score.resumeStoryClarity = Math.min(
      score.resumeStoryClarity,
      SCORING_CLAMP_POLICY.storyFunctionalUnderCoreLanguageGap.resumeStoryClarityMax,
    );
    score.functionalOverlap = Math.min(
      score.functionalOverlap,
      SCORING_CLAMP_POLICY.storyFunctionalUnderCoreLanguageGap.functionalOverlapMax,
    );
  }

  if (rules.stackMismatch) {
    score.stackFit = Math.min(score.stackFit, STACK_MISMATCH_CAPS.tier1StackFitMax);
  } else if ((rules.adjacentFrameworkGap?.length ?? 0) > 0) {
    score.stackFit = Math.min(score.stackFit, STACK_MISMATCH_CAPS.tier2StackFitMax);
  } else if (rules.explicitCoreLanguageMismatch) {
    score.stackFit = Math.min(score.stackFit, 11);
  }

  // Rule 2 — stack shape vs keyword match
  if (rules.roleShapeOutsideLane) {
    score.stackFit = Math.min(score.stackFit, SCORING_CLAMP_POLICY.roleShapeOutsideLane.stackFitMax);
  }

  // Rule 4 — finance domain
  if (rules.financePenalty) {
    score.domainFit = Math.min(score.domainFit, SCORING_CLAMP_POLICY.financeDomain.domainFitMax);
  }

  // Rule 5 — recruiter friendliness at structured employers with degree risk
  if (rules.matureStructuredEmployer && rules.explicitDegreeRisk) {
    score.recruiterFriendliness = Math.min(
      score.recruiterFriendliness,
      SCORING_CLAMP_POLICY.matureStructuredDegreeRisk.recruiterFriendlinessMax,
    );
  }

  // Rule 7 — contract / staffing-agency roles
  if (detectStaffAugContractRole(params.extracted)) {
    score.careerValue = Math.min(score.careerValue, SCORING_CLAMP_POLICY.staffAugContract.careerValueMax);
  } else if (isContractEmploymentType(params.extracted)) {
    score.careerValue = Math.max(0, score.careerValue - 1);
  }

  // Do not floor stackFit to 17 because a disjunctive group was satisfied.
  // That raised otherwise-valid LLM scores and leaked credit from unrelated groups.
  // Preserve original LLM stackFit unless a mismatch/shape clamp above reduced it.

  // Title/responsibility seniority mismatch / early-career-exceed severity → Level fit dock.
  // Core function ownership beyond early-career must move capability, not only Key Risk prose.
  const notesBlob = [...(rules.notes ?? []), ...(rules.hardRuleNotes ?? [])].join("\n");
  const severityFromNotes = textSignalsEarlyCareerExceedSeverity(notesBlob);
  let earlyCareerExceedSeverityRisk = Boolean(rules.earlyCareerExceedSeverityRisk) || severityFromNotes;
  const levelFitBefore = params.score.levelFit;
  if (rules.titleResponsibilityMismatch) {
    score.levelFit = Math.min(score.levelFit, TITLE_RESPONSIBILITY_MISMATCH_LEVEL_FIT_MAX);
    score.recruiterFriendliness = Math.min(score.recruiterFriendliness, 9);
  } else if (earlyCareerExceedSeverityRisk) {
    score.levelFit = Math.min(score.levelFit, EARLY_CAREER_EXCEED_SEVERITY_LEVEL_FIT_MAX);
  }

  // Reinforced experience floor stacks with (and is distinct from) title/responsibility mismatch.
  if (rules.reinforcedExperienceFloor) {
    const floor = detectReinforcedExperienceFloor(params.extracted);
    const candidateYears = estimateCandidateProfessionalYears({
      profile: params.profile ?? defaultUserProfile,
      resumeText: params.resumeText,
    });
    const dock = reinforcedFloorLevelFitDock({ floor, candidateYears });
    if (dock > 0) {
      score.levelFit = Math.max(0, score.levelFit - dock);
    }
  }

  const seniorityDock = seniorityLevelFitDock(rules);
  if (seniorityDock > 0) {
    score.levelFit = Math.min(score.levelFit, levelFitCeilingForSeniorityDock(seniorityDock));
  }

  if (rules.productionInfraOwnershipGap) {
    score.levelFit = Math.max(0, score.levelFit - PRODUCTION_INFRA_OWNERSHIP_LEVEL_FIT_DOCK);
  }

  const scoringRiskScoreInconsistency =
    earlyCareerExceedSeverityRisk &&
    score.levelFit > EARLY_CAREER_EXCEED_SEVERITY_LEVEL_FIT_MAX &&
    levelFitBefore === score.levelFit;

  const rulesWithSeniority: RuleEvaluation = {
    ...rules,
    earlyCareerExceedSeverityRisk,
    scoringRiskScoreInconsistency,
  };

  const boundedRules = applyJdLanguageOutputBoundary(params.extracted, rulesWithSeniority);
  return { score, rules: boundedRules };
};

export const hardFlagTotalCeiling = (rules: RuleEvaluation): number | null => {
  const hasCore = rules.hardRuleFlags?.some((f) => f.id === "coreLanguageMismatch") ?? false;
  const hasSenior = rules.hardRuleFlags?.some((f) => f.id === "seniorityOverreach") ?? false;
  const caps = SCORING_CLAMP_POLICY.hardFlagTotalCeilings;

  if (hasCore && hasSenior) return caps.coreLanguageAndSeniority;
  if (hasCore) return caps.coreLanguageMismatch;
  if (hasSenior) return caps.seniorityOverreach;
  return null;
};
