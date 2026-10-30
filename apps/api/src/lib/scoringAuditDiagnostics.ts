/**
 * Read-only scoring audit diagnostics. Does not change totals, weights, or thresholds.
 */
import { COMPOSITE_SCORING } from "../config/capabilitySurvivabilityPolicy.js";
import { SCORE_CATEGORY_MAXES, STACK_MISMATCH_CAPS } from "../config/scoringPolicy.js";
import type { ExtractedJobData } from "../types/job.js";
import type { Recommendation, RuleEvaluation, ScoreBreakdown } from "../types/scoring.js";
import { recommendationForScore } from "./compositeScoring.js";
import {
  findLiteralLeadsWithSourceQuote,
  isExclusiveCoreLanguageRequirement,
  languageIsIllustrativeExampleOnly,
  languageOnlyInDisjunctiveChoice,
  languageOnlyInIllustrativeExample,
} from "./disjunctiveLanguageRequirement.js";
import { termIsPreferredOrNarrativeOnly } from "./jdTagProvenance.js";

export type LanguageRequirementSourceClass =
  | "mandatory"
  | "preferred"
  | "illustrative"
  | "ambiguous";

export type LanguagePenaltyAudit = {
  language: string;
  kind: "core_language_gap" | "specialization";
  sourceClass: LanguageRequirementSourceClass;
  sourceQuote: string | null;
  dock?: number;
  evidence?: string;
};

export type StackPenaltyAudit = {
  originalLlmStackFit: number | null;
  adjustedStackFit: number | null;
  stackMismatchFlag: boolean;
  stackMismatchClampApplied: boolean;
  stackMismatchClampCeiling: number | null;
  clampReducedStackFit: number;
  coreLanguageGap: string[];
  coreLanguageGapEvidence: LanguagePenaltyAudit[];
  specializationGap: {
    name: string;
    dock: number;
    evidence: string;
    jdSide?: string;
    sourceClass: LanguageRequirementSourceClass;
    sourceQuote: string | null;
  } | null;
  gapDock: number | null;
  languagePenalties: LanguagePenaltyAudit[];
  combinedStackPressure: {
    categoryScoreEffects: {
      llmStackFitDeficitFromMax: number | null;
      clampReduction: number;
    };
    explicitDeductions: {
      specializationDock: number;
      gapDock: number | null;
    };
    combined: number | null;
    note: string;
  };
};

export type RecommendationBoundaryAudit = {
  score: number;
  recommendation: Recommendation;
  cutoffs: { strong_apply: number; apply: number; stretch: number };
  nearestCutoff: number;
  distanceToNearestCutoff: number;
  absDistanceToNearestCutoff: number;
  withinTwoPoints: boolean;
  tierAboveCutoff: Recommendation;
  tierBelowCutoff: Recommendation;
  note: string;
};

const jobRequirementBlob = (job: ExtractedJobData): string =>
  [job.rawText ?? "", ...(job.requirements ?? []), ...(job.responsibilities ?? [])].join("\n");

export const classifyLanguageRequirementSource = (
  job: ExtractedJobData | undefined,
  language: string,
): LanguageRequirementSourceClass => {
  if (!job || !language.trim()) return "ambiguous";
  if (
    languageIsIllustrativeExampleOnly(job, language) ||
    languageOnlyInIllustrativeExample(job, language)
  ) {
    return "illustrative";
  }
  if (termIsPreferredOrNarrativeOnly(language, job)) return "preferred";
  const blob = jobRequirementBlob(job);
  if (findLiteralLeadsWithSourceQuote(job, language)) return "mandatory";
  if (isExclusiveCoreLanguageRequirement(blob, language)) return "mandatory";
  if (languageOnlyInDisjunctiveChoice(job, language)) return "ambiguous";
  return "ambiguous";
};

const quoteForLanguage = (job: ExtractedJobData | undefined, language: string): string | null => {
  if (!job) return null;
  return findLiteralLeadsWithSourceQuote(job, language);
};

export const buildStackPenaltyAudit = (params: {
  extracted?: ExtractedJobData;
  rules?: Pick<
    RuleEvaluation,
    "stackMismatch" | "coreLanguageGap" | "specializationGap" | "explicitCoreLanguageMismatch"
  >;
  score?: Pick<ScoreBreakdown, "stackFit" | "llmCategories">;
  gapDock?: number | null;
}): StackPenaltyAudit => {
  const originalLlmStackFit = params.score?.llmCategories?.stackFit ?? null;
  const adjustedStackFit = params.score?.stackFit ?? null;
  const mismatch = params.rules?.stackMismatch === true;
  const ceiling = mismatch ? STACK_MISMATCH_CAPS.tier1StackFitMax : null;
  const clampReducedStackFit =
    originalLlmStackFit != null && adjustedStackFit != null
      ? Math.max(0, originalLlmStackFit - adjustedStackFit)
      : 0;
  const stackMismatchClampApplied =
    mismatch &&
    originalLlmStackFit != null &&
    originalLlmStackFit > STACK_MISMATCH_CAPS.tier1StackFitMax &&
    adjustedStackFit != null &&
    adjustedStackFit <= STACK_MISMATCH_CAPS.tier1StackFitMax;

  const coreLanguageGap = params.rules?.coreLanguageGap ?? [];
  const coreLanguageGapEvidence: LanguagePenaltyAudit[] = coreLanguageGap.map((language) => ({
    language,
    kind: "core_language_gap",
    sourceClass: classifyLanguageRequirementSource(params.extracted, language),
    sourceQuote: quoteForLanguage(params.extracted, language),
  }));

  const spec = params.rules?.specializationGap;
  const specLanguage = spec?.jdSide?.split("/")[0]?.trim() ?? spec?.name ?? "";
  const specializationGap = spec
    ? {
        name: spec.name,
        dock: spec.dock,
        evidence: spec.evidence,
        jdSide: spec.jdSide,
        sourceClass: classifyLanguageRequirementSource(params.extracted, specLanguage),
        sourceQuote: quoteForLanguage(params.extracted, specLanguage),
      }
    : null;

  const languagePenalties: LanguagePenaltyAudit[] = [
    ...coreLanguageGapEvidence,
    ...(spec
      ? [
          {
            language: specLanguage || spec.name,
            kind: "specialization" as const,
            sourceClass: specializationGap!.sourceClass,
            sourceQuote: specializationGap!.sourceQuote,
            dock: spec.dock,
            evidence: spec.evidence,
          },
        ]
      : []),
  ];

  const llmDeficit =
    originalLlmStackFit == null
      ? null
      : Math.max(0, SCORE_CATEGORY_MAXES.stackFit - originalLlmStackFit);
  const specializationDock = spec?.dock ?? 0;
  const combined =
    (llmDeficit ?? 0) + clampReducedStackFit + (params.gapDock ?? specializationDock);

  return {
    originalLlmStackFit,
    adjustedStackFit,
    stackMismatchFlag: mismatch,
    stackMismatchClampApplied,
    stackMismatchClampCeiling: ceiling,
    clampReducedStackFit,
    coreLanguageGap,
    coreLanguageGapEvidence,
    specializationGap,
    gapDock: params.gapDock ?? spec?.dock ?? null,
    languagePenalties,
    combinedStackPressure: {
      categoryScoreEffects: {
        llmStackFitDeficitFromMax: llmDeficit,
        clampReduction: clampReducedStackFit,
      },
      explicitDeductions: {
        specializationDock,
        gapDock: params.gapDock ?? spec?.dock ?? null,
      },
      combined,
      note: "Diagnostic only: category-score effects and explicit deductions are listed separately and must not be treated as an exact causal estimate of double-counting.",
    },
  };
};

const CUTOFFS: Array<{
  cutoff: number;
  tierAbove: Recommendation;
  tierBelow: Recommendation;
}> = [
  { cutoff: COMPOSITE_SCORING.STRONG_APPLY, tierAbove: "strong_apply", tierBelow: "apply" },
  { cutoff: COMPOSITE_SCORING.APPLY_LOW, tierAbove: "apply", tierBelow: "stretch" },
  { cutoff: COMPOSITE_SCORING.STRETCH_LOW, tierAbove: "stretch", tierBelow: "weak" },
];

export const buildRecommendationBoundaryAudit = (
  score: number,
  hardGate = false,
): RecommendationBoundaryAudit => {
  const recommendation = recommendationForScore(score, hardGate);
  const nearest = CUTOFFS.reduce((best, row) =>
    Math.abs(score - row.cutoff) < Math.abs(score - best.cutoff) ? row : best,
  );
  const distance = score - nearest.cutoff;
  return {
    score,
    recommendation,
    cutoffs: {
      strong_apply: COMPOSITE_SCORING.STRONG_APPLY,
      apply: COMPOSITE_SCORING.APPLY_LOW,
      stretch: COMPOSITE_SCORING.STRETCH_LOW,
    },
    nearestCutoff: nearest.cutoff,
    distanceToNearestCutoff: distance,
    absDistanceToNearestCutoff: Math.abs(distance),
    withinTwoPoints: Math.abs(distance) <= 2,
    tierAboveCutoff: nearest.tierAbove,
    tierBelowCutoff: nearest.tierBelow,
    note: "Boundary metadata only. Recommendation names and 80/65/50 cutoffs are unchanged.",
  };
};
