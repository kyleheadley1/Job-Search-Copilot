import { SURVIVABILITY_TUNING } from "../config/capabilitySurvivabilityPolicy.js";
import { STACK_MISMATCH_CAPS } from "../config/scoringPolicy.js";
import { presentFitForDisplay } from "./authoritativeScore.js";
import { contractFinalDock } from "./contractEmployment.js";
import { recommendationForScore } from "./compositeScoring.js";
import { SCORER_VERSION } from "../services/gmail/jdRecovery/runRecovery.js";
import type { ApplicationEvaluation } from "../services/gmail/jdRecovery/evaluations.repository.js";
import type { ApprovedRevisionOverlay } from "../services/scoring/scoreRevision.types.js";
import type { JobRecord } from "../types/job.js";
import type { RecomputedStoredJobScore } from "./recomputeStoredJobScore.js";
import {
  buildRecommendationBoundaryAudit,
  buildStackPenaltyAudit,
  classifyLanguageRequirementSource,
  type LanguageRequirementSourceClass,
  type RecommendationBoundaryAudit,
  type StackPenaltyAudit,
} from "./scoringAuditDiagnostics.js";

export type CalibrationDifferenceClass =
  | "aligned"
  | "corrected_requirement"
  | "role_lane"
  | "rule_change"
  | "approved_revision"
  | "unresolved";

export type CalibrationBaselineRow = {
  key: string;
  company: string;
  role: string | null;
  historicalTotal: number | null;
  historicalRec: string | null;
  effectiveTotal: number | null;
  effectiveRec: string | null;
  effectiveSource: string | null;
  replayTotal: number | null;
  replayRec: string | null;
  storedLane: string | null;
  replayLane: string | null;
  capability: number | null;
  survAdjustment: number | null;
  gapDock: number | null;
  contractDock: number | null;
  storedStackFit: number | null;
  replayStackFit: number | null;
  storedCapability: number | null;
  replayCapability: number | null;
  storedSurvAdjustment: number | null;
  replaySurvAdjustment: number | null;
  storedGapDock: number | null;
  storedSpecializationDock: number | null;
  storedCoreGap: string[];
  storedLanguageSourceClasses: LanguageRequirementSourceClass[];
  replayCoreGap: string[];
  storedStackMismatch: boolean | null;
  replayStackMismatch: boolean | null;
  specializationDock: number | null;
  hardGates: string[];
  caps: string[];
  promptVersion: string | null;
  pipelineVersionLabel: string;
  differenceClass: CalibrationDifferenceClass;
  doubleCount: string;
  stackPenalty: StackPenaltyAudit | null;
  recommendationBoundary: RecommendationBoundaryAudit | null;
  notes: string[];
};

const recOf = (value: string | undefined | null): string | null => value ?? null;

export const classifyCalibrationDifference = (row: {
  historicalTotal: number | null;
  historicalRec: string | null;
  effectiveTotal: number | null;
  effectiveSource: string | null;
  replayTotal: number | null;
  replayRec: string | null;
  storedLane: string | null;
  replayLane: string | null;
  storedCoreGap: string[];
  replayCoreGap: string[];
  storedStackMismatch: boolean | null;
  replayStackMismatch: boolean | null;
  specializationDock: number | null;
}): CalibrationDifferenceClass => {
  if (row.effectiveSource === "approved_revision") return "approved_revision";
  const hist = row.historicalTotal;
  const replay = row.replayTotal;
  if (hist == null || replay == null) return "unresolved";
  if (Math.abs(hist - replay) < 0.51 && recOf(row.historicalRec) === recOf(row.replayRec)) {
    return "aligned";
  }
  const gapChanged =
    JSON.stringify([...(row.storedCoreGap ?? [])].sort()) !==
      JSON.stringify([...(row.replayCoreGap ?? [])].sort()) ||
    row.storedStackMismatch !== row.replayStackMismatch ||
    (row.specializationDock ?? 0) > 0;
  if (gapChanged) return "corrected_requirement";
  if (row.storedLane && row.replayLane && row.storedLane !== row.replayLane) return "role_lane";
  if (Math.abs(hist - replay) >= 0.51) return "rule_change";
  return "unresolved";
};

export const evaluationToJobRecord = (evaluation: ApplicationEvaluation): JobRecord | null => {
  const detail = evaluation.fit?.detail;
  if (!detail?.score || !evaluation.jd?.text) return null;
  return {
    extracted: { ...detail.extracted, rawText: evaluation.jd.text },
    score: detail.score,
    recommendedResume: detail.recommendedResume,
  } as JobRecord;
};

export const doubleCountAssessment = (row: {
  storedStackFit: number | null;
  replayStackFit: number | null;
  replayStackMismatch: boolean | null;
  replayCoreGap: string[];
  specializationDock: number | null;
  gapDock: number | null;
}): string => {
  const stackFit = row.replayStackFit ?? row.storedStackFit;
  const dock = row.gapDock ?? row.specializationDock ?? 0;
  const mismatch = row.replayStackMismatch === true || (row.replayCoreGap?.length ?? 0) > 0;
  if (stackFit == null) return "insufficient_category_data";
  if (!mismatch && (row.specializationDock ?? 0) === 0) return "no_mandatory_language_penalty";
  if (stackFit <= 10 && dock > 0) {
    return "possible_double_count: LLM/clamp stackFit already ≤10 and deterministic dock also applied";
  }
  if (stackFit > 10 && dock > 0) {
    return "deterministic_dock_only: stored stackFit not stack-mismatch clamped";
  }
  if (stackFit <= 10 && dock === 0) {
    return "llm_or_clamp_only";
  }
  return "no_overlap";
};

export const buildCalibrationBaselineRow = (params: {
  evaluation: ApplicationEvaluation;
  revision?: ApprovedRevisionOverlay | null;
  replay: RecomputedStoredJobScore | null;
  replayError?: string;
}): CalibrationBaselineRow => {
  const evaluation = params.evaluation;
  const fit = evaluation.fit;
  const storedRules = fit?.detail?.rules;
  const presented = fit
    ? presentFitForDisplay(fit, { revision: params.revision, evaluation })
    : null;
  const display = params.replay?.score.scoreDisplay;
  const storedCoreGap = storedRules?.coreLanguageGap ?? [];
  const replayCoreGap = params.replay?.rules.coreLanguageGap ?? [];
  const rowBase = {
    historicalTotal: fit?.total ?? null,
    historicalRec: recOf(fit?.recommendation),
    effectiveTotal: presented?.total ?? null,
    effectiveSource: presented?.authoritativeSource ?? null,
    replayTotal: params.replay?.score.total ?? null,
    replayRec: recOf(params.replay?.recommendation),
    storedLane: storedRules?.roleLane ?? null,
    replayLane: params.replay?.rules.roleLane ?? null,
    storedCoreGap,
    replayCoreGap,
    storedStackMismatch: storedRules?.stackMismatch ?? null,
    replayStackMismatch: params.replay?.rules.stackMismatch ?? null,
    specializationDock: params.replay?.rules.specializationGap?.dock ?? null,
  };
  const caps = [
    params.replay?.rules.frontendPrimaryRole ? "frontend_primary" : null,
    params.replay?.rules.platformInfraRole ? "platform_infra" : null,
    params.replay?.rules.adjacentRoleFunction ? "adjacent_role" : null,
  ].filter((cap): cap is string => Boolean(cap));
  const notes: string[] = [];
  if (params.replayError) notes.push(params.replayError);
  if ((rowBase.specializationDock ?? 0) > 0) {
    notes.push(
      `specialization ${params.replay?.rules.specializationGap?.name ?? "gap"} dock ${rowBase.specializationDock}`,
    );
  }
  return {
    key: evaluation.key,
    company: evaluation.company,
    role: evaluation.role,
    ...rowBase,
    effectiveRec: recOf(presented?.recommendation),
    capability: params.replay?.score.capability ?? display?.capability ?? null,
    survAdjustment: display?.survAdjustment ?? null,
    gapDock: display?.gapDock ?? null,
    contractDock:
      params.replay != null && evaluation.fit?.detail?.extracted
        ? contractFinalDock({
            ...evaluation.fit.detail.extracted,
            rawText: evaluation.jd?.text,
          })
        : null,
    storedStackFit: fit?.detail?.score?.llmCategories?.stackFit ?? fit?.detail?.score?.stackFit ?? null,
    replayStackFit: params.replay?.score.stackFit ?? null,
    storedCapability: fit?.detail?.score?.capability ?? fit?.breakdown?.capability ?? null,
    replayCapability: params.replay?.score.capability ?? display?.capability ?? null,
    storedSurvAdjustment: fit?.detail?.score?.scoreDisplay?.survAdjustment ?? null,
    replaySurvAdjustment: display?.survAdjustment ?? null,
    storedGapDock: fit?.detail?.score?.scoreDisplay?.gapDock ?? fit?.breakdown?.gapDock ?? null,
    storedSpecializationDock: storedRules?.specializationGap?.dock ?? null,
    storedLanguageSourceClasses: storedCoreGap.map((language) =>
      classifyLanguageRequirementSource(
        evaluation.fit?.detail?.extracted
          ? { ...evaluation.fit.detail.extracted, rawText: evaluation.jd?.text }
          : undefined,
        language,
      ),
    ),
    hardGates: display?.hardGates ?? fit?.detail?.score?.scoreDisplay?.hardGates ?? [],
    caps,
    promptVersion: fit?.promptVersion ?? null,
    pipelineVersionLabel: SCORER_VERSION,
    differenceClass: classifyCalibrationDifference(rowBase),
    doubleCount: doubleCountAssessment({
      storedStackFit: fit?.detail?.score?.llmCategories?.stackFit ?? fit?.detail?.score?.stackFit ?? null,
      replayStackFit: params.replay?.score.stackFit ?? null,
      replayStackMismatch: params.replay?.rules.stackMismatch ?? null,
      replayCoreGap,
      specializationDock: rowBase.specializationDock,
      gapDock: display?.gapDock ?? null,
    }),
    stackPenalty: params.replay
      ? buildStackPenaltyAudit({
          extracted: evaluation.fit?.detail?.extracted
            ? { ...evaluation.fit.detail.extracted, rawText: evaluation.jd?.text }
            : undefined,
          rules: params.replay.rules,
          score: params.replay.score,
          gapDock: display?.gapDock,
        })
      : null,
    recommendationBoundary:
      params.replay?.score.total != null
        ? buildRecommendationBoundaryAudit(
            params.replay.score.total,
            (display?.hardGates?.length ?? 0) > 0,
          )
        : null,
    notes,
  };
};

export const LARGE_REPLAY_DELTA_ABS = 10;

export type LargeReplayDeltaReport = {
  key: string;
  company: string;
  role: string | null;
  historicalAuthoritative: number | null;
  effectiveApprovedRevision: number | null;
  currentReplay: number | null;
  absDelta: number;
  capabilityHistorical: number | null;
  capabilityReplay: number | null;
  capabilityDelta: number | null;
  survivabilityHistorical: number | null;
  survivabilityReplay: number | null;
  survivabilityDelta: number | null;
  gapDockHistorical: number | null;
  gapDockReplay: number | null;
  gapDockDelta: number | null;
  storedLane: string | null;
  replayLane: string | null;
  laneChanged: boolean;
  storedCoreGap: string[];
  replayCoreGap: string[];
  requirementGroundingChanged: boolean;
  historicalRec: string | null;
  replayRec: string | null;
  tierChanged: boolean;
  confirmedCauses: string[];
  unresolvedCauses: string[];
  differenceClass: CalibrationDifferenceClass;
};

const numDelta = (a: number | null, b: number | null): number | null =>
  a == null || b == null ? null : b - a;

const sortedJson = (value: string[]): string => JSON.stringify([...value].sort());

export const classifyLargeReplayDeltaCauses = (row: {
  historicalTotal?: number | null;
  replayTotal?: number | null;
  replayHardGates?: string[];
  storedStackMismatch: boolean | null;
  replayStackMismatch: boolean | null;
  storedCoreGap: string[];
  replayCoreGap: string[];
  storedSpecializationDock: number | null;
  specializationDock: number | null;
  storedLane: string | null;
  replayLane: string | null;
  historicalRec: string | null;
  replayRec: string | null;
  storedCapability: number | null;
  replayCapability: number | null;
  stackPenaltySourceClasses?: string[];
  storedLanguageSourceClasses?: LanguageRequirementSourceClass[];
}): { confirmed: string[]; unresolved: string[] } => {
  const confirmed: string[] = [];
  const unresolved: string[] = [];
  const groundingChanged = sortedJson(row.storedCoreGap) !== sortedJson(row.replayCoreGap);
  if (row.storedStackMismatch === true && row.replayStackMismatch === false) {
    confirmed.push("stack_mismatch_clamp_lifted");
  }
  if ((row.storedSpecializationDock ?? 0) > 0 && (row.specializationDock ?? 0) === 0) {
    confirmed.push("specialization_dock_removed");
  } else if ((row.storedSpecializationDock ?? 0) !== (row.specializationDock ?? 0)) {
    confirmed.push("specialization_dock_changed");
  }
  if (groundingChanged) confirmed.push("requirement_grounding_change");
  if (groundingChanged && row.storedCoreGap.length > 0 && row.replayCoreGap.length === 0) {
    confirmed.push("core_language_gap_cleared");
  }
  if (
    (row.stackPenaltySourceClasses?.includes("illustrative") ||
      row.storedLanguageSourceClasses?.includes("illustrative")) &&
    (row.storedCoreGap.length > 0 || (row.storedSpecializationDock ?? 0) > 0) &&
    row.replayCoreGap.length === 0 &&
    (row.specializationDock ?? 0) === 0
  ) {
    confirmed.push("illustrative_language_no_longer_mandatory");
  }
  if (row.storedLane && row.replayLane && row.storedLane !== row.replayLane) {
    confirmed.push("role_lane_change");
  }
  if (row.historicalRec && row.replayRec && row.historicalRec !== row.replayRec) {
    confirmed.push("recommendation_tier_change");
  }
  if (
    row.historicalTotal === SURVIVABILITY_TUNING.hardGateScoreFloor &&
    row.replayTotal != null &&
    row.replayTotal !== SURVIVABILITY_TUNING.hardGateScoreFloor &&
    (row.replayHardGates?.length ?? 0) === 0
  ) {
    confirmed.push("hard_gate_no_longer_firing");
  }
  const capabilityMoved =
    row.storedCapability != null &&
    row.replayCapability != null &&
    Math.abs(row.replayCapability - row.storedCapability) >= 10;
  const stackRuleChanged =
    row.storedStackMismatch !== row.replayStackMismatch ||
    groundingChanged ||
    (row.storedSpecializationDock ?? 0) !== (row.specializationDock ?? 0);
  if (capabilityMoved && !stackRuleChanged && !confirmed.includes("role_lane_change")) {
    unresolved.push("capability_move_without_stack_rule_change");
  }
  if (confirmed.length === 0) unresolved.push("unexplained_score_move");
  return { confirmed, unresolved };
};

export const buildLargeReplayDeltaReport = (
  row: CalibrationBaselineRow,
): LargeReplayDeltaReport | null => {
  const historical = row.historicalTotal;
  const replay = row.replayTotal;
  if (historical == null || replay == null) return null;
  const absDelta = Math.abs(replay - historical);
  if (absDelta < LARGE_REPLAY_DELTA_ABS) return null;
  const causes = classifyLargeReplayDeltaCauses({
    historicalTotal: row.historicalTotal,
    replayTotal: row.replayTotal,
    replayHardGates: row.hardGates,
    storedStackMismatch: row.storedStackMismatch,
    replayStackMismatch: row.replayStackMismatch,
    storedCoreGap: row.storedCoreGap,
    replayCoreGap: row.replayCoreGap,
    storedSpecializationDock: row.storedSpecializationDock,
    specializationDock: row.specializationDock,
    storedLane: row.storedLane,
    replayLane: row.replayLane,
    historicalRec: row.historicalRec,
    replayRec: row.replayRec,
    storedCapability: row.storedCapability,
    replayCapability: row.replayCapability,
    stackPenaltySourceClasses: [
      ...(row.stackPenalty?.languagePenalties.map((p) => p.sourceClass) ?? []),
      row.stackPenalty?.specializationGap?.sourceClass,
    ].filter((value): value is string => Boolean(value)),
    storedLanguageSourceClasses: row.storedLanguageSourceClasses,
  });
  return {
    key: row.key,
    company: row.company,
    role: row.role,
    historicalAuthoritative: historical,
    effectiveApprovedRevision:
      row.effectiveSource === "approved_revision" ? row.effectiveTotal : null,
    currentReplay: replay,
    absDelta,
    capabilityHistorical: row.storedCapability,
    capabilityReplay: row.replayCapability,
    capabilityDelta: numDelta(row.storedCapability, row.replayCapability),
    survivabilityHistorical: row.storedSurvAdjustment,
    survivabilityReplay: row.replaySurvAdjustment,
    survivabilityDelta: numDelta(row.storedSurvAdjustment, row.replaySurvAdjustment),
    gapDockHistorical: row.storedGapDock,
    gapDockReplay: row.gapDock,
    gapDockDelta: numDelta(row.storedGapDock, row.gapDock),
    storedLane: row.storedLane,
    replayLane: row.replayLane,
    laneChanged: Boolean(row.storedLane && row.replayLane && row.storedLane !== row.replayLane),
    storedCoreGap: row.storedCoreGap,
    replayCoreGap: row.replayCoreGap,
    requirementGroundingChanged: sortedJson(row.storedCoreGap) !== sortedJson(row.replayCoreGap),
    historicalRec: row.historicalRec,
    replayRec: row.replayRec,
    tierChanged: Boolean(row.historicalRec && row.replayRec && row.historicalRec !== row.replayRec),
    confirmedCauses: causes.confirmed,
    unresolvedCauses: causes.unresolved,
    differenceClass: row.differenceClass,
  };
};

export type DockPolicyId = "A" | "B" | "C" | "D";

export type DockPolicyResult = {
  id: DockPolicyId;
  label: string;
  specDock: number;
  final: number;
  rec: string;
  combinedStackPenalty: number;
  llmAlreadyAtCeiling: boolean;
  production: boolean;
};

const clampScore = (n: number): number => Math.min(100, Math.max(0, Math.round(n)));

/**
 * In-memory only. Production remains policy A.
 * B/C trigger when original LLM stackFit is already ≤ the mismatch ceiling (10).
 */
export const applyDockPolicies = (params: {
  llmStackFit: number | null;
  adjustedStackFit: number | null;
  specializationDock: number;
  capability: number;
  survAdjustment: number;
  gapDock: number;
  contractDock: number;
  hardGate: boolean;
}): DockPolicyResult[] => {
  const ceiling = STACK_MISMATCH_CAPS.tier1StackFitMax;
  const llm = params.llmStackFit;
  const adjusted = params.adjustedStackFit ?? llm;
  const spec = Math.max(0, params.specializationDock);
  const otherGap = Math.max(0, params.gapDock - spec);
  const llmAlreadyAtCeiling = llm != null && llm <= ceiling;
  const combinedStackPenalty =
    (llm == null ? 0 : Math.max(0, 20 - llm)) + Math.max(0, (llm ?? 0) - (adjusted ?? llm ?? 0)) + spec;
  const scoreOf = (nextSpec: number): number => {
    if (params.hardGate) return 25;
    return clampScore(
      params.capability + params.survAdjustment - (otherGap + nextSpec) - params.contractDock,
    );
  };
  const recOfScore = (final: number) => recommendationForScore(final, params.hardGate);
  const aFinal = scoreOf(spec);
  const bSpec = llmAlreadyAtCeiling ? 0 : spec;
  const cSpec = llmAlreadyAtCeiling ? Math.round(spec / 2) : spec;
  return [
    {
      id: "A",
      label: "production: full specialization dock",
      specDock: spec,
      final: aFinal,
      rec: recOfScore(aFinal),
      combinedStackPenalty,
      llmAlreadyAtCeiling,
      production: true,
    },
    {
      id: "B",
      label: "drop spec dock when LLM stackFit ≤ 10",
      specDock: bSpec,
      final: scoreOf(bSpec),
      rec: recOfScore(scoreOf(bSpec)),
      combinedStackPenalty: combinedStackPenalty - spec + bSpec,
      llmAlreadyAtCeiling,
      production: false,
    },
    {
      id: "C",
      label: "halve spec dock when LLM stackFit ≤ 10",
      specDock: cSpec,
      final: scoreOf(cSpec),
      rec: recOfScore(scoreOf(cSpec)),
      combinedStackPenalty: combinedStackPenalty - spec + cSpec,
      llmAlreadyAtCeiling,
      production: false,
    },
    {
      id: "D",
      label: "keep full dock; report combined stack penalty",
      specDock: spec,
      final: aFinal,
      rec: recOfScore(aFinal),
      combinedStackPenalty,
      llmAlreadyAtCeiling,
      production: false,
    },
  ];
};
