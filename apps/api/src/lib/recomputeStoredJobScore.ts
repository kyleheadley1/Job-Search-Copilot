import { evaluateRules } from "../agents/jobAgent/rules.js";
import { computeSalaryAsk } from "../agents/jobAgent/salaryAsk.js";
import { RECOMMENDATION_LABELS } from "../config/capabilitySurvivabilityPolicy.js";
import { userProfile as defaultUserProfile } from "../config/userProfile.js";
import { detectCapabilityGap, detectSpecializationGap } from "./capabilityGap.js";
import { computeCompositeScore } from "./compositeScoreModel.js";
import { recommendationForScore } from "./compositeScoring.js";
import { applyHistoryPoints } from "./historyAdjustments.js";
import { applyJdLanguageOutputBoundary } from "./jdLanguageOutputBoundary.js";
import { sanitizeExtractedTags } from "./jdTagProvenance.js";
import { detectReferralPathway } from "./referralPathway.js";
import { withSanitizedRuleNotes } from "./riskDisplaySanitizer.js";
import { applyScoringClampLayer } from "./scoringClampLayer.js";
import { sealAuthoritativeScore } from "./authoritativeScore.js";
import { buildScoreDisplay } from "./scoreDisplayModel.js";
import type { JobRecord } from "../types/job.js";
import type { ResumeContextSet } from "../types/resumeContext.js";
import { toActiveResumeType } from "../types/resume.js";
import type { UserProfile } from "../types/userProfile.js";
import type { Recommendation, RuleEvaluation, SalaryAsk, ScoreBreakdown } from "../types/scoring.js";

/** Strip composite / display fields; keep stored LLM category scores only. */
export const storedCategoryScores = (score: ScoreBreakdown): ScoreBreakdown => ({
  stackFit: score.stackFit,
  levelFit: score.levelFit,
  domainFit: score.domainFit,
  resumeStoryClarity: score.resumeStoryClarity,
  functionalOverlap: score.functionalOverlap,
  recruiterFriendliness: score.recruiterFriendliness,
  careerValue: score.careerValue,
  total: 0,
});

export type RecomputedStoredJobScore = {
  rules: RuleEvaluation;
  score: ScoreBreakdown;
  recommendation: Recommendation;
  salaryAsk: SalaryAsk;
  referralPathwayAvailable?: boolean;
  referralPathwayNotes?: string;
};

/**
 * Deterministic re-score: re-run rules + composite on stored extraction and category scores.
 * Does not call the scoring LLM or re-extract the JD.
 */
export const recomputeStoredJobScore = (params: {
  job: JobRecord;
  profile?: UserProfile;
  resumeContexts?: ResumeContextSet;
}): RecomputedStoredJobScore => {
  const profile = params.profile ?? defaultUserProfile;
  const { job, resumeContexts } = params;
  const activeResumeType = toActiveResumeType(job.recommendedResume);
  const resumeText =
    resumeContexts?.[activeResumeType]?.rawText ?? resumeContexts?.BASE?.rawText;

  // Re-apply preferred/required provenance on every recompute so section-header
  // fixes (What You Need / Nice-to-Haves) correct stale extracted arrays.
  const extracted = sanitizeExtractedTags(job.extracted);

  const rules = withSanitizedRuleNotes(
    evaluateRules(extracted, profile, { resumeContexts, activeResumeType }),
    extracted,
    profile,
    resumeText,
  );

  // Prefer pre-clamp LLM categories: stored post-clamp categories would take subtractive docks twice.
  const rawCategories = job.score.llmCategories
    ? { ...job.score.llmCategories, total: 0 }
    : storedCategoryScores(job.score);
  const clamped = applyScoringClampLayer({
    score: rawCategories,
    extracted,
    rules,
    profile,
    resumeText,
  });

  const capabilityGap = detectCapabilityGap(extracted, clamped.score, resumeText);
  const specializationGap = detectSpecializationGap(extracted, clamped.score, resumeText);
  const rulesWithGap: RuleEvaluation = {
    ...clamped.rules,
    capabilityGap,
    specializationGap,
  };

  const composite = computeCompositeScore({
    rawScore: clamped.score,
    rules: rulesWithGap,
    extracted,
    profile,
    resumeText,
  });

  const finalRules = applyJdLanguageOutputBoundary(extracted, rulesWithGap);

  const referralPathway = detectReferralPathway({
    profile,
    extracted,
    resumeText,
  });

  const frozen = composite.hardGateReasons?.length ? undefined : job.score.historyAdjustments;
  const adjustedScore: ScoreBreakdown = frozen?.length
    ? { ...composite.score, total: applyHistoryPoints(composite.score.total, frozen), historyAdjustments: frozen }
    : composite.score;
  const finalRecommendation = frozen?.length
    ? recommendationForScore(adjustedScore.total)
    : composite.recommendation;

  const scoreDisplayFinal = buildScoreDisplay({
    score: adjustedScore,
    rules: finalRules,
    extracted,
    profile,
    recommendation: finalRecommendation,
    hardGateReasons: composite.hardGateReasons,
    trackerPostedAt: job.tracker?.postedAt,
    jobCreatedAt: job.createdAt,
  });

  const llmCategories = job.score.llmCategories;
  const withDisplay: ScoreBreakdown = scoreDisplayFinal
    ? {
        ...adjustedScore,
        llmCategories,
        scoreDisplay: scoreDisplayFinal,
        recommendationLabel: scoreDisplayFinal.bandHeadline,
      }
    : {
        ...adjustedScore,
        llmCategories,
        recommendationLabel: RECOMMENDATION_LABELS[finalRecommendation],
      };
  const sealed = sealAuthoritativeScore({
    score: withDisplay,
    recommendation: finalRecommendation,
  });

  const salaryAsk = computeSalaryAsk({
    extracted,
    score: sealed.score,
    recommendation: sealed.recommendation,
    rules: finalRules,
  });

  return {
    rules: finalRules,
    score: sealed.score,
    recommendation: sealed.recommendation,
    salaryAsk,
    referralPathwayAvailable: referralPathway.referralPathwayAvailable,
    referralPathwayNotes: referralPathway.referralPathwayNotes,
  };
};
