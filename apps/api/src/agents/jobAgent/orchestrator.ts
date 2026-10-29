import { randomUUID } from 'crypto';
import { userProfile } from '../../config/userProfile.js';
import {
  getTrackerColor,
  TRACKER_ACTION_BY_RECOMMENDATION,
  TRACKER_HARD_GATE_ACTION,
  TRACKER_PRIORITY_BY_RECOMMENDATION,
} from '../../config/scoringPolicy.js';
import { evaluateShortlist } from '../../lib/shortlist.js';
import type { JobRecord } from '../../types/job.js';
import type { ScoreBreakdown } from '../../types/scoring.js';
import { buildTrackerSpreadsheetFromJob } from '../../tracker/canonicalSpreadsheet.js';
import { detectReferralPathway } from '../../lib/referralPathway.js';
import { buildScoreDisplay } from '../../lib/scoreDisplayModel.js';
import { RECOMMENDATION_LABELS } from '../../config/capabilitySurvivabilityPolicy.js';
import { evaluateRules } from './rules.js';
import { scoreJob } from './scoring.js';
import { computeSalaryAsk } from './salaryAsk.js';
import { deterministicResumeSelection, selectResume } from './resumeSelector.js';
import { computeCompositeScore } from '../../lib/compositeScoreModel.js';
import type { ResumeType } from '../../types/resume.js';
import { fetchJobPosting } from '../../tools/fetchJobPosting.js';
import { parseJobText } from '../../tools/parseJobText.js';
import { extractJobData } from '../../tools/extractJobData.js';
import { listMissingCriticalFields } from '../../tools/deterministicRawTextExtract.js';
import { resumeContextService } from '../../services/resume/resumeContext.js';
import { logger } from '../../lib/logger.js';
import { withSanitizedRuleNotes } from '../../lib/riskDisplaySanitizer.js';
import {
  canReuseStoredScoringCategories,
  jdTextHashFromInput,
} from '../../lib/jdTextHash.js';
import { storedCategoryScores } from '../../lib/recomputeStoredJobScore.js';
import { recommendationForScore } from '../../lib/compositeScoring.js';
import { sealAuthoritativeScore } from '../../lib/authoritativeScore.js';
import {
  applyHistoryPoints,
  loadApprovedAdjustments,
  matchAdjustments,
} from '../../services/insights/applyAdjustments.js';

export const triageJob = async (input: {
  url?: string;
  rawText?: string;
  companyHint?: string;
  fullPrep?: boolean;
  /** When re-triaging, pass the prior job to reuse stored LLM scores if JD text is unchanged. */
  retriageFrom?: JobRecord;
}): Promise<JobRecord> => {
  const t0 = Date.now();
  const stageMs = {
    fetchAndParse: 0,
    extraction: 0,
    rules: 0,
    resumeContext: 0,
    scoring: 0,
    salary: 0,
    resumeSelection: 0,
  };
  const fetchStart = Date.now();
  const fetchedText = input.url
    ? await fetchJobPosting(input.url).catch(() => undefined)
    : undefined;
  const mergedText = [input.rawText, fetchedText].filter(Boolean).join('\n\n');
  const parsedText = mergedText
    ? parseJobText(mergedText).normalized
    : undefined;
  stageMs.fetchAndParse = Date.now() - fetchStart;

  const currentJdTextHash = jdTextHashFromInput({
    rawText: input.rawText,
    fetchedText,
  });
  const reuseStoredCategories = canReuseStoredScoringCategories({
    currentJdTextHash,
    previousJob: input.retriageFrom,
  });
  const preservedScoring = reuseStoredCategories && input.retriageFrom
    ? {
        categoryScores: storedCategoryScores(input.retriageFrom.score),
        narrative: {
          topMatch: input.retriageFrom.topMatch,
          mainRisk: input.retriageFrom.mainRisk,
          risks: input.retriageFrom.risks ?? [],
          rationale: input.retriageFrom.rationale ?? [],
        },
      }
    : undefined;

  const extractionStart = Date.now();
  const {
    extracted,
    llmExtractionSucceeded,
    extractionDiagnostics,
    heuristicInferredFields,
    preScoringMetadata,
  } = await extractJobData({
    url: input.url,
    rawText: parsedText,
    companyHint: input.companyHint,
  });
  stageMs.extraction = Date.now() - extractionStart;

  const resumeCtxStart = Date.now();
  const resumeContexts = await resumeContextService.getAvailableContexts();
  stageMs.resumeContext = Date.now() - resumeCtxStart;

  // Preview resume before scoring so survivability uses the same text as recommendedResume
  // (selectResume historically ran after scoreJob and hardcoded SWE for impactMetricQuality).
  const resumePreview = deterministicResumeSelection(extracted, resumeContexts);
  let activeResumeType: ResumeType = resumePreview.recommendedResume;
  let resumeTextForScore =
    resumeContexts?.[activeResumeType]?.rawText ?? resumeContexts?.BASE?.rawText;

  const rulesStart = Date.now();
  const rules = withSanitizedRuleNotes(
    evaluateRules(extracted, userProfile, { resumeContexts, activeResumeType }),
    extracted,
    userProfile,
    resumeTextForScore,
  );
  stageMs.rules = Date.now() - rulesStart;
  const scoringStart = Date.now();
  const {
    scoring: scored,
    rules: scoredRules,
    scoringDiagnostics,
    scoringLlmSucceeded,
    scoringCategoriesReused,
  } = await scoreJob({
    extracted,
    rules,
    userProfile,
    resumeContexts,
    resumeText: resumeTextForScore,
    preScoringMetadata,
    preservedScoring,
  });
  stageMs.scoring = Date.now() - scoringStart;
  const resumeSelStart = Date.now();
  const resumeSelection = await selectResume({
    extracted,
    score: scored.score,
    topMatch: scored.topMatch,
    mainRisk: scored.mainRisk,
    userProfile,
    resumeContexts,
  });
  stageMs.resumeSelection = Date.now() - resumeSelStart;

  let scoredScore: ScoreBreakdown = scored.score;
  let scoredRulesFinal = scoredRules;
  let scoredRecommendation = scored.recommendation;
  activeResumeType = resumeSelection.recommendedResume;
  const finalResumeText =
    resumeContexts?.[activeResumeType]?.rawText ?? resumeTextForScore;
  // Ambiguous LLM resume selection may diverge from the deterministic preview —
  // recompute survivability so impactMetricQuality still matches recommendedResume.
  if (finalResumeText !== resumeTextForScore) {
    resumeTextForScore = finalResumeText;
    const recomposite = computeCompositeScore({
      rawScore: scored.score,
      rules: scoredRules,
      extracted,
      profile: userProfile,
      resumeText: finalResumeText,
    });
    scoredScore = recomposite.score;
    scoredRecommendation = recomposite.recommendation;
  }

  // Re-triage keeps the adjustments the role was first scored with, so its score doesn't drift.
  const hardGated = (buildScoreDisplay({
    score: scoredScore,
    rules: scoredRulesFinal,
    extracted,
    profile: userProfile,
    recommendation: scoredRecommendation,
  })?.hardGates?.length ?? 0) > 0;
  const historyAdjustments = hardGated
    ? []
    : input.retriageFrom
      ? (input.retriageFrom.score.historyAdjustments ?? [])
      : matchAdjustments(
          {
            fit: scoredScore.total,
            extracted,
            rules: scoredRulesFinal,
            score: scoredScore,
            recommendedResume: resumeSelection.recommendedResume,
            postingUrl: input.url ?? extracted.url,
          },
          await loadApprovedAdjustments(),
        );
  if (historyAdjustments.length > 0) {
    scoredScore = {
      ...scoredScore,
      total: applyHistoryPoints(scoredScore.total, historyAdjustments),
      historyAdjustments,
    };
    scoredRecommendation = recommendationForScore(scoredScore.total);
  }

  const referralPathway = detectReferralPathway({
    profile: userProfile,
    extracted,
    resumeText: finalResumeText,
  });

  const scoreDisplayFinal = buildScoreDisplay({
    score: scoredScore,
    rules: scoredRulesFinal,
    extracted,
    profile: userProfile,
    recommendation: scoredRecommendation,
  });

  const withDisplay: ScoreBreakdown = scoreDisplayFinal
    ? {
        ...scoredScore,
        scoreDisplay: scoreDisplayFinal,
        recommendationLabel: scoreDisplayFinal.bandHeadline,
      }
    : {
        ...scoredScore,
        recommendationLabel: RECOMMENDATION_LABELS[scoredRecommendation],
      };
  const sealed = sealAuthoritativeScore({
    score: withDisplay,
    recommendation: scoredRecommendation,
  });
  const scoreWithDisplay = sealed.score;
  const finalRecommendation = sealed.recommendation;

  const salaryStart = Date.now();
  const salaryAsk = computeSalaryAsk({
    extracted,
    score: scoreWithDisplay,
    recommendation: finalRecommendation,
    rules: scoredRulesFinal,
  });
  stageMs.salary = Date.now() - salaryStart;

  const scoringJdTextHash =
    scoringLlmSucceeded && currentJdTextHash
      ? currentJdTextHash
      : input.retriageFrom?.scoringJdTextHash;

  const now = new Date().toISOString();
  const initialRecord: JobRecord = {
    id: randomUUID(),
    extracted,
    rules: scoredRulesFinal,
    score: scoreWithDisplay,
    recommendation: finalRecommendation,
    referralPathwayAvailable: referralPathway.referralPathwayAvailable,
    referralPathwayNotes: referralPathway.referralPathwayNotes,
    salaryAsk,
    recommendedResume: resumeSelection.recommendedResume,
    resumeRationale: resumeSelection.rationale,
    topMatch: scored.topMatch,
    mainRisk: scored.mainRisk,
    rationale: scored.rationale,
    risks: scored.risks,
    generated: {},
    scoringJdTextHash,
    debugExtraction: {
      fallbackUsed: !llmExtractionSucceeded,
      extraction: {
        success: llmExtractionSucceeded,
        fallbackUsed: extractionDiagnostics.fallbackUsed,
        httpStatus: extractionDiagnostics.httpStatus,
        errorCode: extractionDiagnostics.errorCode,
        errorType: extractionDiagnostics.errorType,
        errorMessage: extractionDiagnostics.errorMessage,
        parseStage: extractionDiagnostics.parseStage,
        reason: extractionDiagnostics.reason,
      },
      scoring: {
        success: scoringLlmSucceeded,
        fallbackUsed: scoringDiagnostics.fallbackUsed,
        httpStatus: scoringDiagnostics.httpStatus,
        errorCode: scoringDiagnostics.errorCode,
        errorType: scoringDiagnostics.errorType,
        errorMessage: scoringDiagnostics.errorMessage,
        parseStage: scoringDiagnostics.parseStage,
        reason: scoringCategoriesReused
          ? 'jd_text_hash_unchanged_reused_categories'
          : scoringDiagnostics.reason,
      },
      extractedFromRawText: heuristicInferredFields,
      missingCriticalFields: listMissingCriticalFields(extracted),
    },
    tracker: {
      priority: TRACKER_PRIORITY_BY_RECOMMENDATION[finalRecommendation],
      recommendedAction: scoreDisplayFinal?.hardGates.length
        ? TRACKER_HARD_GATE_ACTION
        : TRACKER_ACTION_BY_RECOMMENDATION[finalRecommendation],
      statusOutcome: finalRecommendation,
      color: getTrackerColor('to_review', scoreWithDisplay.total),
    },
    status: 'to_review',
    createdAt: now,
    updatedAt: now,
    scoreHistory: [
      {
        scoredAt: now,
        score: scoreWithDisplay,
        recommendation: finalRecommendation,
      },
    ],
  };
  const shortlistEval = evaluateShortlist(initialRecord);
  initialRecord.tracker = {
    ...initialRecord.tracker,
    shortlist: shortlistEval.onShortlist,
    shortlistTag: shortlistEval.tag,
    freshnessTier: shortlistEval.freshnessLabel,
  };
  logger.info('triage timing', {
    totalMs: Date.now() - t0,
    ...stageMs,
    hasUrlInput: Boolean(input.url),
    hasRawTextInput: Boolean(input.rawText?.trim()),
    extractionLlmSucceeded: llmExtractionSucceeded,
    scoringLlmSucceeded,
    scoringCategoriesReused: Boolean(scoringCategoriesReused),
  });
  return {
    ...initialRecord,
    trackerSpreadsheet: buildTrackerSpreadsheetFromJob(initialRecord),
  };
};
