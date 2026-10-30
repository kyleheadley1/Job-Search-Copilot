import { COMPOSITE_SCORING, SURVIVABILITY_TUNING } from "../config/capabilitySurvivabilityPolicy.js";
import { SCORE_CATEGORY_MAXES } from "../config/scoringPolicy.js";
import type { UserProfile } from "../types/userProfile.js";
import { toActiveResumeType, type StoredResumeType } from "../types/resume.js";
import type { ResumeContext, ResumeContextSet } from "../types/resumeContext.js";
import type { GmailApplication } from "../services/gmail/gmailApplications.js";
import type {
  ApplicationEvaluation,
  FitBreakdown,
  ScoringDetail,
} from "../services/gmail/jdRecovery/evaluations.repository.js";
import { SCORER_VERSION } from "../services/gmail/jdRecovery/runRecovery.js";
import { effectiveScoreProvenance, presentFitForDisplay, resolveStoredFitScore } from "../lib/authoritativeScore.js";
import { evaluationFingerprint } from "../lib/evaluationFingerprint.js";
import type { ApprovedRevisionOverlay } from "../services/scoring/scoreRevision.types.js";
import { recommendationForScore } from "../lib/compositeScoring.js";
import {
  buildRecommendationBoundaryAudit,
  buildStackPenaltyAudit,
} from "../lib/scoringAuditDiagnostics.js";
import { assessExtractedJdSupport } from "../lib/jdTagProvenance.js";

export const AUDIT_ROLE_CATEGORIES = [
  "frontend",
  "backend",
  "full_stack",
  "ai_engineering",
  "forward_deployed",
  "implementation",
  "early_career",
  "platform_infra",
  "other",
] as const;

export type AuditRoleCategory = (typeof AUDIT_ROLE_CATEGORIES)[number];

export const MAX_AUDIT_JD_CHARS = 20_000;
export const MAX_AUDIT_RESUME_CHARS = 15_000;

const capText = (text: string, max: number): { text: string; truncated: boolean } => {
  if (text.length <= max) return { text, truncated: false };
  return { text: text.slice(0, max), truncated: true };
};

/** Static scoring-engine facts for the auditor. Not a second scorer. */
export const SCORING_MODEL_FOR_AUDIT = {
  formula: "capability + survivabilityAdjustment − gapDock − contractDock, then 0–100 clamp",
  capability: {
    fromLlmCategories: ["stackFit", "levelFit", "functionalOverlap"],
    rescaledMaxes: { stackFit: 35, levelFit: 30, functionalOverlap: 35 },
    llmMaxes: {
      stackFit: SCORE_CATEGORY_MAXES.stackFit,
      levelFit: SCORE_CATEGORY_MAXES.levelFit,
      functionalOverlap: SCORE_CATEGORY_MAXES.functionalOverlap,
    },
    note: "LLM scores the three categories; deterministic clamps, role-lane caps, and specialization docks can lower them before they are rescaled to 100.",
  },
  otherLlmCategories: {
    domainFit: { max: SCORE_CATEGORY_MAXES.domainFit, feeds: "survivability.domainMatchForListing" },
    resumeStoryClarity: { max: SCORE_CATEGORY_MAXES.resumeStoryClarity, feeds: "survivability.resumeStoryCoherence" },
    recruiterFriendliness: {
      max: SCORE_CATEGORY_MAXES.recruiterFriendliness,
      feeds: "display and some clamp-layer totals; not a composite axis",
    },
    careerValue: {
      max: SCORE_CATEGORY_MAXES.careerValue,
      feeds: "display and some clamp-layer totals; not a composite axis",
    },
  },
  survivability: {
    multiplierRange: [SURVIVABILITY_TUNING.floor, 1],
    adjustment: {
      neutral: COMPOSITE_SCORING.SURV_NEUTRAL,
      penaltyScale: COMPOSITE_SCORING.SURV_PENALTY_SCALE,
      bonusScale: COMPOSITE_SCORING.SURV_BONUS_SCALE,
      min: COMPOSITE_SCORING.SURV_ADJ_MIN,
      max: COMPOSITE_SCORING.SURV_ADJ_MAX,
    },
  },
  recommendationBands: {
    strong_apply: COMPOSITE_SCORING.STRONG_APPLY,
    apply: COMPOSITE_SCORING.APPLY_LOW,
    stretch: COMPOSITE_SCORING.STRETCH_LOW,
    weak: 0,
    note: "Recommendation is the score tier only. The LLM's recommendation field is discarded.",
  },
  hardGates: {
    floor: SURVIVABILITY_TUNING.hardGateScoreFloor,
    typicalReasons: [
      "visa/sponsorship",
      "citizenship",
      "clearance",
      "non-commutable location",
      "explicit core-language mismatch at a mature employer",
      "seniority overreach",
      "explicit geo exclusion",
    ],
    note: "A fired hard gate sets the stored total to 25 and recommendation to weak. Technical overlap cannot override it.",
  },
  promptBandContradiction:
    "The LLM scoring prompt still quotes older bands (85/78/70/60). Stored recommendations use 80/65/50. Do not treat prompt-band language as the persisted mapping.",
  penaltyVectorNote:
    "rules.penaltyVector records named hard-penalty magnitudes but the composite path does not subtract those numbers. Actual docks are hard-gate floor, survivability adjustment, gapDock, and clamps.",
  dimensions: {
    technicalCapabilityFit: "capability (stackFit + levelFit + functionalOverlap)",
    experienceAndSeniorityFit: "levelFit plus rules.seniorityOverreach / experienceGap / early-career flags",
    eligibilityOrHardRequirements: "evaluateHardGates + degree/clearance/geo rules; not a separate stored axis",
    careerAlignment: "careerValue is scored but is not a composite axis; targetRoles live on the profile only",
    overallApplicationPriority: "recommendation tier + tracker priority derived from that tier",
  },
  resumeSelection:
    "Deterministic preview (AI vs BASE from title/body signals) then optional LLM tie-break. Survivability is recomputed if the final variant differs.",
  scorerEntryPoints: {
    triageJob: "Canonical pipeline: extract → rules → scoreJob → resume select → composite → display",
    scoreBlind: "Gmail/recovery wrapper: triageJob(rawText, companyHint) with no email or outcome",
    scoreUserPosting: "Confirm/paste/prospect path: scoreBlind then persist fit; never overwrites a scored row",
  },
} as const;

export const AUDIT_PROTOCOL = {
  readOnly: true,
  sampleSize: "Review about 15–20 scored applications, including similar roles together.",
  sourceOfTruth:
    "Use the returned candidate profile and resume variants. Do not substitute a generic software-engineer profile.",
  dimensions: [
    "technical_capability_fit",
    "experience_and_seniority_fit",
    "eligibility_or_hard_requirements",
    "career_alignment",
    "overall_application_priority",
  ],
  investigate: [
    "scores_too_high",
    "scores_too_low",
    "inconsistent_similar_requirements",
    "exact_technology_keyword_overweight",
    "transferable_experience_underweight",
    "seniority_misread",
    "eligibility_barrier_underenforced",
    "superficial_ai_llm_overvalued",
    "incorrect_resume_recommendation",
    "score_vs_recommendation_disagreement",
  ],
  findingClasses: [
    "isolated_evaluation_error",
    "repeated_role_category_pattern",
    "rubric_design_weakness",
    "llm_interpretation_weakness",
    "missing_or_low_quality_input",
    "inconclusive",
  ],
  individualFinding: [
    "applicationKey",
    "company",
    "role",
    "originalScore",
    "originalRecommendation",
    "auditAssessment",
    "direction: too_high | too_low | inconsistent | reasonable",
    "severity",
    "supportingEvidence",
    "proposedCorrectedScoreOrRange (audit opinion only; never a write)",
    "confidence",
    "limitations",
  ],
  rules: [
    "A high technical match must not override a genuine eligibility barrier.",
    "A missing exact technology keyword must not automatically outweigh strong transferable engineering experience.",
    "Cite stored evidence (JD, rules, categories, profile/resume). Do not invent original LLM internals when evidenceGaps says they are missing.",
    "A free-form corrected score is an opinion, not a database write.",
    "For supported interpretation errors (years floor, inferred seniority, mixed-stack vs exclusive core language, role lane), call propose_scoring_correction with JD quotes. Do not send a numeric score; the engine recomputes. The user approves in the dashboard.",
    "Do not treat one disagreement as systematic bias.",
    "Claude's judgment is not ground truth.",
  ],
} as const;

export type ScoringAuditListFilters = {
  query?: string;
  roleCategory?: AuditRoleCategory;
  minScore?: number;
  maxScore?: number;
  recommendation?: string;
  resumeVariant?: StoredResumeType;
  outcome?: string;
  promptVersion?: string;
  appliedAfter?: string;
  appliedBefore?: string;
  offset: number;
  limit: number;
};

const titleBlob = (app: GmailApplication, evaluation: ApplicationEvaluation): string =>
  [
    app.role,
    evaluation.role,
    evaluation.jd?.title,
    evaluation.fit?.detail?.extracted.title,
    evaluation.fit?.detail?.extracted.seniority,
  ]
    .filter(Boolean)
    .join(" ");

export const deriveAuditRoleCategories = (
  app: GmailApplication,
  evaluation: ApplicationEvaluation,
): AuditRoleCategory[] => {
  const tags = new Set<AuditRoleCategory>();
  const rules = evaluation.fit?.detail?.rules;
  const blob = titleBlob(app, evaluation);

  if (rules) {
    if (rules.roleLane === "product_frontend" || rules.frontendPrimaryRole) tags.add("frontend");
    if (rules.roleLane === "product_backend") tags.add("backend");
    if (rules.roleLane === "product_fullstack") tags.add("full_stack");
    if (rules.roleLane === "platform_infra" || rules.platformInfraRole) tags.add("platform_infra");
    if (rules.roleLane === "adjacent_non_engineering" || rules.adjacentRoleFunction) {
      tags.add("implementation");
    }
    if (rules.fdeBuilderSoftwarePrimary) tags.add("forward_deployed");
    if (rules.researchHeavyAiRole || rules.vagueEarlyStageAiCalibration) tags.add("ai_engineering");
    if (rules.earlyCareerFriendlyRole || rules.strictNewGradPipeline) tags.add("early_career");
  }

  if (/\b(front[- ]?end|react engineer|ui engineer)\b/i.test(blob)) tags.add("frontend");
  if (/\b(back[- ]?end|server[- ]?side|api engineer)\b/i.test(blob)) tags.add("backend");
  if (/\bfull[- ]?stack\b/i.test(blob)) tags.add("full_stack");
  if (/\b(forward[-\s]?deployed|fde)\b/i.test(blob)) tags.add("forward_deployed");
  if (/\b(ai|machine learning|llm|generative|applied ai)\b/i.test(blob)) tags.add("ai_engineering");
  if (/\b(implementation|solutions engineer|sales engineer|business systems)\b/i.test(blob)) {
    tags.add("implementation");
  }
  if (/\b(junior|new[- ]?grad|early[- ]?career|entry[- ]?level)\b/i.test(blob)) tags.add("early_career");
  if (/\b(platform|sre|devops|infrastructure)\b/i.test(blob)) tags.add("platform_infra");

  if (tags.size === 0) tags.add("other");
  return [...tags];
};

export const isScoredEvaluation = (evaluation?: ApplicationEvaluation): evaluation is ApplicationEvaluation =>
  evaluation?.recovery.status === "scored" && typeof evaluation.fit?.total === "number";

const matchesQuery = (app: GmailApplication, evaluation: ApplicationEvaluation, query?: string): boolean => {
  if (!query) return true;
  const q = query.toLowerCase();
  const role = app.role ?? evaluation.role ?? evaluation.jd?.title ?? "";
  return app.company.toLowerCase().includes(q) || role.toLowerCase().includes(q);
};

export type ScoredApplicationAuditRow = {
  applicationKey: string;
  company: string;
  role: string | null;
  appliedAt: string;
  outcome: string;
  furthestStage: string;
  fitTotal: number;
  recommendation: string;
  recommendedResume: StoredResumeType;
  promptVersion: string;
  scoredAt: string;
  foundVia?: string;
  roleCategories: AuditRoleCategory[];
  roleLane?: string;
  hardGateFired: boolean;
  hasScoringDetail: boolean;
  hasBreakdown: boolean;
  storedFitTotal?: number;
  scoreConflict?: boolean;
  authoritativeSource?: string;
  revisionId?: string;
  scoreRevised?: boolean;
  originalAuthoritativeTotal?: number;
  fingerprintStale?: boolean;
  staleRevisionTotal?: number;
};

export const toScoredAuditRow = (
  app: GmailApplication,
  evaluation: ApplicationEvaluation,
  revision?: ApprovedRevisionOverlay | null,
): ScoredApplicationAuditRow => {
  const fit = evaluation.fit!;
  const presented = presentFitForDisplay(fit, { revision, evaluation });
  const hardGates = fit.breakdown?.hardGates ?? fit.detail?.score.scoreDisplay?.hardGates ?? [];
  return {
    applicationKey: app.key,
    company: app.company,
    role: app.role ?? evaluation.role ?? evaluation.jd?.title ?? null,
    appliedAt: app.appliedAt,
    outcome: app.status,
    furthestStage: app.furthestStage,
    fitTotal: presented.total,
    recommendation: presented.recommendation,
    recommendedResume: fit.recommendedResume,
    promptVersion: fit.promptVersion,
    scoredAt: fit.scoredAt,
    foundVia: evaluation.recovery.foundVia,
    roleCategories: deriveAuditRoleCategories(app, evaluation),
    roleLane: fit.detail?.rules.roleLane,
    hardGateFired: hardGates.length > 0 || presented.total === SURVIVABILITY_TUNING.hardGateScoreFloor,
    hasScoringDetail: Boolean(fit.detail),
    hasBreakdown: Boolean(fit.breakdown),
    ...effectiveScoreProvenance(presented),
  };
};

export const listScoredApplicationsForAudit = (
  apps: GmailApplication[],
  evaluations: Map<string, ApplicationEvaluation>,
  filters: ScoringAuditListFilters,
  revisions?: Map<string, ApprovedRevisionOverlay>,
): { totalMatched: number; applications: ScoredApplicationAuditRow[] } => {
  const matched = apps.filter((app) => {
    const evaluation = evaluations.get(app.key);
    if (!isScoredEvaluation(evaluation)) return false;
    if (!matchesQuery(app, evaluation, filters.query)) return false;
    const fit = evaluation.fit!;
    const presented = presentFitForDisplay(fit, { revision: revisions?.get(app.key), evaluation });
    if (filters.minScore != null && presented.total < filters.minScore) return false;
    if (filters.maxScore != null && presented.total > filters.maxScore) return false;
    if (filters.recommendation && presented.recommendation !== filters.recommendation) return false;
    if (filters.resumeVariant && fit.recommendedResume !== filters.resumeVariant) return false;
    if (filters.outcome && app.status !== filters.outcome) return false;
    if (filters.promptVersion && fit.promptVersion !== filters.promptVersion) return false;
    if (filters.appliedAfter && app.appliedAt < filters.appliedAfter) return false;
    if (filters.appliedBefore && app.appliedAt > filters.appliedBefore) return false;
    if (filters.roleCategory && !deriveAuditRoleCategories(app, evaluation).includes(filters.roleCategory)) {
      return false;
    }
    return true;
  });
  matched.sort((a, b) => (b.appliedAt < a.appliedAt ? -1 : b.appliedAt > a.appliedAt ? 1 : 0));
  const page = matched.slice(filters.offset, filters.offset + filters.limit);
  return {
    totalMatched: matched.length,
    applications: page.map((app) => toScoredAuditRow(app, evaluations.get(app.key)!, revisions?.get(app.key))),
  };
};

const profileForAudit = (profile: UserProfile) => ({
  headline: profile.headline,
  strengths: profile.strengths,
  weakerAreas: profile.weakerAreas,
  degreeStatus: profile.degreeStatus,
  training: profile.training,
  targetRoles: profile.targetRoles,
  locationPreferences: profile.locationPreferences,
  flagshipProjects: profile.flagshipProjects,
  recurringStory: profile.recurringStory,
  hardConstraints: profile.hardConstraints,
  estimatedProfessionalYears: profile.estimatedProfessionalYears,
  screeningYears: profile.screeningYears,
  requiresSponsorship: profile.requiresSponsorship,
  citizenshipStatus: profile.citizenshipStatus,
  holdsActiveClearance: profile.holdsActiveClearance,
  candidateLocation: profile.candidateLocation,
  certifications: profile.certifications,
});

const resumeEvidence = (context: ResumeContext | undefined) => {
  if (!context) return null;
  const body = capText(context.rawText, MAX_AUDIT_RESUME_CHARS);
  return {
    type: context.type,
    sourceKind: context.sourceKind,
    loadedAt: context.loadedAt,
    rawText: body.text,
    rawTextTruncated: body.truncated,
    metadata: {
      strongestThemes: context.metadata.strongestThemes,
      keywords: context.metadata.keywords,
      bestFitRoleShapes: context.metadata.bestFitRoleShapes,
      avoidUseCases: context.metadata.avoidUseCases,
      claimSupport: context.metadata.claimSupport,
      projectEvidence: context.metadata.projectEvidence,
    },
  };
};

const breakdownView = (breakdown?: FitBreakdown) => {
  if (!breakdown) return undefined;
  return {
    categories: breakdown.categories,
    capability: breakdown.capability,
    survivability: breakdown.survivability,
    gapDock: breakdown.gapDock,
    hardGates: breakdown.hardGates,
    topMatch: breakdown.topMatch,
    mainRisk: breakdown.mainRisk,
    risks: breakdown.risks,
  };
};

const detailView = (detail?: ScoringDetail) => {
  if (!detail) return undefined;
  const score = detail.score;
  return {
    recommendation: detail.recommendation,
    recommendedResume: detail.recommendedResume,
    topMatch: detail.topMatch,
    mainRisk: detail.mainRisk,
    rationale: detail.rationale,
    risks: detail.risks,
    resumeRationale: detail.resumeRationale,
    extracted: detail.extracted,
    rules: detail.rules,
    score: {
      stackFit: score.stackFit,
      levelFit: score.levelFit,
      domainFit: score.domainFit,
      resumeStoryClarity: score.resumeStoryClarity,
      functionalOverlap: score.functionalOverlap,
      recruiterFriendliness: score.recruiterFriendliness,
      careerValue: score.careerValue,
      total: score.total,
      capability: score.capability,
      capabilityBreakdown: score.capabilityBreakdown,
      survivability: score.survivability,
      survivabilityBreakdown: score.survivabilityBreakdown,
      llmCategories: score.llmCategories,
      recommendationLabel: score.recommendationLabel,
      differentiatorCoverageNote: score.differentiatorCoverageNote,
      roleFunctionCapNote: score.roleFunctionCapNote,
      historyAdjustments: score.historyAdjustments,
      scoreDisplay: score.scoreDisplay
        ? {
            capability: score.scoreDisplay.capability,
            survivability: score.scoreDisplay.survivability,
            final: score.scoreDisplay.final,
            survAdjustment: score.scoreDisplay.survAdjustment,
            gapDock: score.scoreDisplay.gapDock,
            scoreDerivation: score.scoreDisplay.scoreDerivation,
            scoreBand: score.scoreDisplay.scoreBand,
            bandHeadline: score.scoreDisplay.bandHeadline,
            hardGates: score.scoreDisplay.hardGates,
            survivabilityPenalties: score.scoreDisplay.survivabilityPenalties,
            actionLine: score.scoreDisplay.actionLine,
            eligibilityAdvisories: score.scoreDisplay.eligibilityAdvisories,
          }
        : undefined,
    },
  };
};

export type ScoringAuditContext = {
  readOnly: true;
  application: {
    applicationKey: string;
    company: string;
    role: string | null;
    appliedAt: string;
    outcome: string;
    furthestStage: string;
    outcomeAtScoring?: string;
    trackerStatus?: string;
    foundVia?: string;
    matchLevel?: string;
    matchSignals?: string[];
    sourceUrl?: string;
  };
  scoring: {
    total: number;
    recommendation: string;
    recommendationFromScore: ReturnType<typeof recommendationForScore>;
    storedTotals?: {
      fitTotal?: number;
      detailTotal?: number;
      displayFinal?: number;
    };
    scoreConflict?: boolean;
    authoritativeSource?: string;
    revisionId?: string;
    scoreRevised?: boolean;
    originalAuthoritativeTotal?: number;
    fingerprintStale?: boolean;
    staleRevisionTotal?: number;
    /** Canonical SHA-256 of the stored evaluation. Same value `propose_scoring_correction` validates. Not the JD text hash. */
    evaluationFingerprint: string;
    recommendedResume: StoredResumeType;
    scoredAt: string;
    promptVersion: string;
    pipelineVersionLabel: string;
    breakdown?: ReturnType<typeof breakdownView>;
    detail?: ReturnType<typeof detailView>;
    stackPenalty?: ReturnType<typeof buildStackPenaltyAudit>;
    recommendationBoundary?: ReturnType<typeof buildRecommendationBoundaryAudit>;
    evidenceGaps: string[];
  };
  jobDescription: {
    text?: string;
    textTruncated?: boolean;
    title?: string;
    company?: string;
    textHash?: string;
    missing: boolean;
    completeness?: ReturnType<typeof assessExtractedJdSupport>;
  };
  candidate: {
    profileIsCurrentNotHistorical: true;
    profile: ReturnType<typeof profileForAudit>;
    recommendedResume: StoredResumeType;
    recommendedResumeEvidence: ReturnType<typeof resumeEvidence>;
    otherResumeTypes: StoredResumeType[];
  };
  scoringModel: typeof SCORING_MODEL_FOR_AUDIT;
};

export const buildScoringAuditContext = (params: {
  app: GmailApplication;
  evaluation: ApplicationEvaluation;
  profile: UserProfile;
  resumeContexts: ResumeContextSet;
  revision?: ApprovedRevisionOverlay | null;
}): ScoringAuditContext => {
  const { app, evaluation, profile, resumeContexts, revision } = params;
  const fit = evaluation.fit!;
  const presented = presentFitForDisplay(fit, { revision, evaluation });
  const resolved = resolveStoredFitScore(fit);
  const evidenceGaps: string[] = [];
  if (!fit.detail) evidenceGaps.push("scoringDetailMissing");
  if (!fit.breakdown) evidenceGaps.push("fitBreakdownMissing");
  if (!fit.detail?.score.llmCategories) evidenceGaps.push("llmCategoriesMissing");
  if (!evaluation.jd?.text) evidenceGaps.push("jobDescriptionMissing");
  evidenceGaps.push("profileNotSnapshottedAtScoring");
  evidenceGaps.push("resumeNotSnapshottedAtScoring");
  if (fit.promptVersion === SCORER_VERSION) evidenceGaps.push("promptVersionIsPipelineLabel");

  const resumeType = toActiveResumeType(fit.recommendedResume);
  const jd = evaluation.jd?.text ? capText(evaluation.jd.text, MAX_AUDIT_JD_CHARS) : undefined;
  const extractedForAudit = fit.detail?.extracted
    ? { ...fit.detail.extracted, rawText: evaluation.jd?.text ?? fit.detail.extracted.rawText }
    : undefined;
  const completeness = assessExtractedJdSupport({
    rawText: evaluation.jd?.text ?? extractedForAudit?.rawText,
    stack: extractedForAudit?.stack,
    requiredSkills: extractedForAudit?.requiredSkills,
    preferredSkills: extractedForAudit?.preferredSkills,
  });
  if (completeness.incomplete) evidenceGaps.push("incompleteJobDescription");
  if (completeness.ungroundedRequirementTags.length > 0) {
    evidenceGaps.push("ungroundedExtractedTags");
  }
  const hardGateFired =
    (fit.breakdown?.hardGates ?? fit.detail?.score.scoreDisplay?.hardGates ?? []).length > 0;
  const stackPenalty = buildStackPenaltyAudit({
    extracted: extractedForAudit,
    rules: fit.detail?.rules,
    score: fit.detail?.score,
    gapDock: fit.breakdown?.gapDock ?? fit.detail?.score.scoreDisplay?.gapDock,
  });
  const recommendationBoundary = buildRecommendationBoundaryAudit(presented.total, hardGateFired);

  return {
    readOnly: true,
    application: {
      applicationKey: app.key,
      company: app.company,
      role: app.role ?? evaluation.role ?? evaluation.jd?.title ?? null,
      appliedAt: app.appliedAt,
      outcome: app.status,
      furthestStage: app.furthestStage,
      outcomeAtScoring: evaluation.outcomeAtScoring,
      trackerStatus: app.trackerStatus,
      foundVia: evaluation.recovery.foundVia,
      matchLevel: evaluation.recovery.match?.level,
      matchSignals: evaluation.recovery.match?.signals ? [...evaluation.recovery.match.signals] : undefined,
      sourceUrl: evaluation.recovery.url,
    },
    scoring: {
      total: presented.total,
      recommendation: presented.recommendation,
      recommendationFromScore: recommendationForScore(presented.total, hardGateFired),
      storedTotals: {
        fitTotal: resolved.storedFitTotal,
        detailTotal: resolved.storedDetailTotal,
        displayFinal: resolved.storedDisplayFinal,
      },
      ...effectiveScoreProvenance(presented),
      evaluationFingerprint: evaluationFingerprint(evaluation),
      recommendedResume: fit.recommendedResume,
      scoredAt: fit.scoredAt,
      promptVersion: fit.promptVersion,
      pipelineVersionLabel: SCORER_VERSION,
      breakdown: breakdownView(fit.breakdown),
      detail: detailView(fit.detail),
      stackPenalty,
      recommendationBoundary,
      evidenceGaps,
    },
    jobDescription: jd
      ? {
          text: jd.text,
          textTruncated: jd.truncated,
          title: evaluation.jd?.title,
          company: evaluation.jd?.company,
          textHash: evaluation.jd?.textHash,
          missing: false,
          completeness,
        }
      : { missing: true, completeness },
    candidate: {
      profileIsCurrentNotHistorical: true,
      profile: profileForAudit(profile),
      recommendedResume: fit.recommendedResume,
      recommendedResumeEvidence: resumeEvidence(resumeContexts[resumeType]),
      otherResumeTypes: (Object.keys(resumeContexts) as StoredResumeType[]).filter((type) => type !== resumeType),
    },
    scoringModel: SCORING_MODEL_FOR_AUDIT,
  };
};
