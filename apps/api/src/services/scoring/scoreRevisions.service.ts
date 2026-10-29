import { randomUUID } from "node:crypto";
import { userProfile } from "../../config/userProfile.js";
import { evaluationFingerprint } from "../../lib/evaluationFingerprint.js";
import {
  presentFitForDisplay,
  totalsAgree,
} from "../../lib/authoritativeScore.js";
import { recommendationForScore } from "../../lib/compositeScoring.js";
import { recomputeStoredJobScore } from "../../lib/recomputeStoredJobScore.js";
import { reconcileSeniority } from "../../lib/seniorityReconciliation.js";
import { pythonOnMixedStackInventory } from "../../lib/stackMismatchAnalysis.js";
import {
  extractGroundedYearsClauses,
  reconcileYearsExperience,
} from "../../lib/yearsExperienceReconciliation.js";
import type { ExtractedJobData, JobRecord } from "../../types/job.js";
import type { Recommendation, RuleEvaluation, ScoreBreakdown } from "../../types/scoring.js";
import type { ResumeContextSet } from "../../types/resumeContext.js";
import { resumeContextService } from "../resume/resumeContext.js";
import { evaluationsRepository, type ApplicationEvaluation } from "../gmail/jdRecovery/evaluations.repository.js";
import { SCORER_VERSION } from "../gmail/jdRecovery/runRecovery.js";
import {
  ConcurrentApprovalError,
  RevisionStateError,
  scoreRevisionsRepository,
  toApprovedOverlay,
} from "./scoreRevisions.repository.js";
import {
  SCORING_REVISION_VERSION,
  type ScoreRevision,
  type ScoreRevisionInputChange,
  type ScoreRevisionInputId,
  type ScoreRevisionProvenance,
  type ScoreRevisionSnapshot,
} from "./scoreRevision.types.js";

export class ScoreRevisionError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ScoreRevisionError";
  }
}

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

const snapshotFromFit = (evaluation: ApplicationEvaluation): ScoreRevisionSnapshot => {
  const overlay = presentFitForDisplay(evaluation.fit!);
  const score = evaluation.fit!.detail?.score;
  const extracted = evaluation.fit!.detail?.extracted;
  const rules = evaluation.fit!.detail?.rules;
  return {
    total: overlay.total,
    recommendation: overlay.recommendation as Recommendation,
    capability: score?.capability,
    derivation: score?.scoreDisplay?.scoreDerivation,
    hardGates: score?.scoreDisplay?.hardGates ?? rules?.hardGateReasons ?? [],
    categories: score
      ? {
          stackFit: score.stackFit,
          levelFit: score.levelFit,
          domainFit: score.domainFit,
          resumeStoryClarity: score.resumeStoryClarity,
          functionalOverlap: score.functionalOverlap,
          recruiterFriendliness: score.recruiterFriendliness,
          careerValue: score.careerValue,
        }
      : undefined,
    yearsExperience: extracted?.yearsExperience,
    seniority: extracted?.seniority,
    roleLane: rules?.roleLane,
    stackMismatch: rules?.stackMismatch,
    coreLanguageGap: rules?.coreLanguageGap,
    seniorityOverreach: rules?.seniorityOverreach,
  };
};

const snapshotFromReplay = (
  extracted: ExtractedJobData,
  rules: RuleEvaluation,
  score: ScoreBreakdown,
  recommendation: Recommendation,
): ScoreRevisionSnapshot => ({
  total: score.total,
  recommendation,
  capability: score.capability,
  derivation: score.scoreDisplay?.scoreDerivation,
  hardGates: score.scoreDisplay?.hardGates ?? [],
  categories: {
    stackFit: score.stackFit,
    levelFit: score.levelFit,
    domainFit: score.domainFit,
    resumeStoryClarity: score.resumeStoryClarity,
    functionalOverlap: score.functionalOverlap,
    recruiterFriendliness: score.recruiterFriendliness,
    careerValue: score.careerValue,
  },
  yearsExperience: extracted.yearsExperience,
  seniority: extracted.seniority,
  roleLane: rules.roleLane,
  stackMismatch: rules.stackMismatch,
  coreLanguageGap: rules.coreLanguageGap,
  seniorityOverreach: rules.seniorityOverreach,
});

const diffInputs = (
  original: ScoreRevisionSnapshot,
  corrected: ScoreRevisionSnapshot,
): ScoreRevisionInputChange[] => {
  const changes: ScoreRevisionInputChange[] = [];
  const push = (id: ScoreRevisionInputId, from: unknown, to: unknown) => {
    if (!same(from ?? null, to ?? null)) changes.push({ id, from: from ?? null, to: to ?? null });
  };
  push("yearsExperience", original.yearsExperience, corrected.yearsExperience);
  push("seniority", original.seniority, corrected.seniority);
  push("stackMismatch", { mismatch: original.stackMismatch, gap: original.coreLanguageGap }, {
    mismatch: corrected.stackMismatch,
    gap: corrected.coreLanguageGap,
  });
  push("roleLane", original.roleLane, corrected.roleLane);
  push("seniorityOverreach", original.seniorityOverreach, corrected.seniorityOverreach);
  return changes;
};

const evidenceFor = (extracted: ExtractedJobData, changes: ScoreRevisionInputChange[]): string[] => {
  const quotes: string[] = [];
  if (changes.some((c) => c.id === "yearsExperience")) {
    for (const clause of extractGroundedYearsClauses(extracted).slice(0, 4)) {
      quotes.push(`JD years: "${clause.raw}"`);
    }
  }
  if (changes.some((c) => c.id === "seniority")) {
    quotes.push(`Title: "${extracted.title ?? ""}"`);
  }
  if (changes.some((c) => c.id === "stackMismatch") && pythonOnMixedStackInventory(extracted)) {
    quotes.push("JD lists Python beside TypeScript/React as a mixed stack inventory, not an exclusive core language.");
  }
  if (changes.some((c) => c.id === "roleLane")) {
    quotes.push(
      `Stored scoring used roleLane=${String(
        changes.find((c) => c.id === "roleLane")?.from ?? "unknown",
      )}; current classifier maps this JD to ${String(changes.find((c) => c.id === "roleLane")?.to ?? "unknown")}.`,
    );
  }
  return quotes.filter((q) => q.trim().length > 0).slice(0, 8);
};

const assertScoreRecConsistent = (total: number, recommendation: Recommendation, hardGate: boolean) => {
  const expected = recommendationForScore(total, hardGate);
  if (expected !== recommendation) {
    throw new ScoreRevisionError(
      "INCONSISTENT_SCORE",
      `Recommendation ${recommendation} does not match score ${total} (expected ${expected}).`,
    );
  }
};

export const provenance = (
  via: ScoreRevisionProvenance["via"],
  note?: string,
  actor: ScoreRevisionProvenance["actor"] = "user",
): ScoreRevisionProvenance => ({
  actor,
  via,
  at: new Date().toISOString(),
  note,
});

export type StoredReplay = {
  evaluation: ApplicationEvaluation;
  extracted: ExtractedJobData;
  original: ScoreRevisionSnapshot;
  corrected: ScoreRevisionSnapshot;
  inputChanges: ScoreRevisionInputChange[];
};

export const replayStoredEvaluation = async (params: {
  evaluation: ApplicationEvaluation;
  resumeContexts?: ResumeContextSet;
}): Promise<StoredReplay> => {
  const evaluation = params.evaluation;
  if (evaluation.recovery.status !== "scored" || !evaluation.fit) {
    throw new ScoreRevisionError("NOT_SCORED", `${evaluation.key} is not scored.`);
  }
  const detail = evaluation.fit.detail;
  if (!detail?.score || !evaluation.jd?.text) {
    throw new ScoreRevisionError(
      "MISSING_BREAKDOWN",
      "Deterministic replay needs the stored scoring snapshot and JD text.",
    );
  }
  if (!detail.score.llmCategories && detail.score.stackFit == null) {
    throw new ScoreRevisionError("MISSING_BREAKDOWN", "Stored LLM category scores are missing; refuse an invented total.");
  }

  const extracted = { ...detail.extracted, rawText: evaluation.jd.text };
  const years = reconcileYearsExperience(extracted);
  const seniority = reconcileSeniority(years.job);
  const resumeContexts = params.resumeContexts ?? (await resumeContextService.getAvailableContexts());
  const replayed = recomputeStoredJobScore({
    job: {
      extracted,
      score: detail.score,
      recommendedResume: detail.recommendedResume,
    } as JobRecord,
    profile: userProfile,
    resumeContexts,
  });

  const original = snapshotFromFit(evaluation);
  const corrected = snapshotFromReplay(seniority.job, replayed.rules, replayed.score, replayed.recommendation);
  assertScoreRecConsistent(corrected.total, corrected.recommendation, (corrected.hardGates?.length ?? 0) > 0);
  return {
    evaluation,
    extracted,
    original,
    corrected,
    inputChanges: diffInputs(original, corrected),
  };
};

export const engineEvidenceFor = (extracted: ExtractedJobData, changes: ScoreRevisionInputChange[]): string[] =>
  evidenceFor(extracted, changes);

export const assertReplayMatchesRevision = (revision: ScoreRevision, replay: StoredReplay): void => {
  if (!totalsAgree(revision.corrected.total, replay.corrected.total)) {
    throw new ScoreRevisionError(
      "INCONSISTENT_SCORE",
      `Stored proposal ${revision.corrected.total} does not match independent replay ${replay.corrected.total}.`,
    );
  }
  if (revision.corrected.recommendation !== replay.corrected.recommendation) {
    throw new ScoreRevisionError(
      "INCONSISTENT_SCORE",
      `Stored recommendation ${revision.corrected.recommendation} does not match replay ${replay.corrected.recommendation}.`,
    );
  }
  for (const id of revision.inputsChanged) {
    if (!replay.inputChanges.some((change) => change.id === id)) {
      throw new ScoreRevisionError(
        "INCONSISTENT_SCORE",
        `Independent replay no longer applies ${id}; refusing to activate this proposal.`,
      );
    }
  }
};

export const proposeDeterministicRevision = async (params: {
  applicationKey: string;
  allowRoleLaneChange?: boolean;
  reason?: string;
  via?: ScoreRevisionProvenance["via"];
  resumeContexts?: ResumeContextSet;
}): Promise<ScoreRevision> => {
  const evaluation = await evaluationsRepository.findByKey(params.applicationKey);
  if (!evaluation) throw new ScoreRevisionError("NOT_FOUND", `No evaluation for ${params.applicationKey}`);
  const replay = await replayStoredEvaluation({ evaluation, resumeContexts: params.resumeContexts });
  if (replay.inputChanges.some((c) => c.id === "roleLane") && !params.allowRoleLaneChange) {
    throw new ScoreRevisionError(
      "LANE_REVIEW_REQUIRED",
      `Role lane would change from ${String(replay.original.roleLane)} to ${String(replay.corrected.roleLane)} (proposed ${replay.corrected.total} / ${replay.corrected.recommendation}). Pass allowRoleLaneChange after explicit review.`,
    );
  }
  if (
    totalsAgree(replay.original.total, replay.corrected.total) &&
    replay.original.recommendation === replay.corrected.recommendation &&
    replay.inputChanges.length === 0
  ) {
    throw new ScoreRevisionError("NO_CORRECTION", "Deterministic replay matches the current effective score.");
  }

  const revision: ScoreRevision = {
    revisionId: randomUUID(),
    applicationKey: evaluation.key,
    evaluationFingerprint: evaluationFingerprint(evaluation),
    scoringVersion: SCORING_REVISION_VERSION,
    pipelineVersionLabel: SCORER_VERSION,
    method: "deterministic_replay",
    status: "proposed",
    inputsChanged: [...new Set(replay.inputChanges.map((c) => c.id))],
    inputChanges: replay.inputChanges,
    evidence: evidenceFor(replay.extracted, replay.inputChanges),
    explanation:
      params.reason?.trim() ||
      `Deterministic replay of stored LLM categories with current years/seniority/stack/lane rules. ${replay.inputChanges
        .map((c) => c.id)
        .join(", ") || "score seal only"}.`,
    recommendationTierChanged: replay.original.recommendation !== replay.corrected.recommendation,
    original: replay.original,
    corrected: replay.corrected,
    createdAt: new Date().toISOString(),
    createdBy: provenance(params.via ?? "api", params.reason),
  };
  await scoreRevisionsRepository.insert(revision);
  return revision;
};

export const approveScoreRevision = async (params: {
  applicationKey: string;
  revisionId: string;
  via?: ScoreRevisionProvenance["via"];
  note?: string;
}): Promise<ScoreRevision> => {
  const [evaluation, revision] = await Promise.all([
    evaluationsRepository.findByKey(params.applicationKey),
    scoreRevisionsRepository.findById(params.revisionId),
  ]);
  if (!evaluation) throw new ScoreRevisionError("NOT_FOUND", `No evaluation for ${params.applicationKey}`);
  if (!revision || revision.applicationKey !== params.applicationKey) {
    throw new ScoreRevisionError("NOT_FOUND", `No revision ${params.revisionId} for ${params.applicationKey}`);
  }
  if (revision.status !== "proposed") {
    throw new ScoreRevisionError("NOT_PROPOSED", `Revision is ${revision.status}, not proposed.`);
  }
  if (revision.method !== "deterministic_replay" && revision.method !== "claude_audit_proposal") {
    throw new ScoreRevisionError("METHOD_NOT_EXECUTABLE", "Only independently verified deterministic corrections can be approved.");
  }
  const currentFingerprint = evaluationFingerprint(evaluation);
  if (currentFingerprint !== revision.evaluationFingerprint) {
    throw new ScoreRevisionError(
      "STALE_FINGERPRINT",
      "The stored evaluation no longer matches the fingerprint recorded on this proposal.",
    );
  }
  assertScoreRecConsistent(
    revision.corrected.total,
    revision.corrected.recommendation,
    (revision.corrected.hardGates?.length ?? 0) > 0,
  );

  let independentlyVerifiedAt: string | undefined;
  if (revision.method === "claude_audit_proposal") {
    const replay = await replayStoredEvaluation({ evaluation });
    assertReplayMatchesRevision(revision, replay);
    independentlyVerifiedAt = new Date().toISOString();
  }

  try {
    return await scoreRevisionsRepository.approveAtomic({
      revisionId: revision.revisionId,
      applicationKey: params.applicationKey,
      approvedAt: new Date().toISOString(),
      approvedBy: provenance(params.via ?? "api", params.note),
      independentlyVerifiedAt,
    });
  } catch (error) {
    if (error instanceof ConcurrentApprovalError) {
      throw new ScoreRevisionError("CONCURRENT_APPROVAL", error.message);
    }
    if (error instanceof RevisionStateError) {
      throw new ScoreRevisionError("NOT_PROPOSED", error.message);
    }
    throw error;
  }
};

export const rollbackScoreRevision = async (params: {
  applicationKey: string;
  revisionId: string;
  via?: ScoreRevisionProvenance["via"];
  note?: string;
}): Promise<ScoreRevision> => {
  try {
    return await scoreRevisionsRepository.rollbackAtomic({
      revisionId: params.revisionId,
      applicationKey: params.applicationKey,
      rolledBackAt: new Date().toISOString(),
      rolledBackBy: provenance(params.via ?? "api", params.note),
    });
  } catch (error) {
    if (error instanceof RevisionStateError) {
      throw new ScoreRevisionError("NOT_APPROVED", error.message);
    }
    throw error;
  }
};

export const listScoreRevisions = (applicationKey: string) =>
  scoreRevisionsRepository.listByApplicationKey(applicationKey);

export const loadApprovedOverlays = async (keys: string[]) => {
  const map = await scoreRevisionsRepository.findApprovedByApplicationKeys(keys);
  return new Map([...map.entries()].map(([key, revision]) => [key, toApprovedOverlay(revision)]));
};

export const publicRevisionView = (revision: ScoreRevision) => ({
  revisionId: revision.revisionId,
  applicationKey: revision.applicationKey,
  status: revision.status,
  method: revision.method,
  scoringVersion: revision.scoringVersion,
  pipelineVersionLabel: revision.pipelineVersionLabel,
  inputsChanged: revision.inputsChanged,
  inputChanges: revision.inputChanges,
  evidence: revision.evidence,
  explanation: revision.explanation,
  recommendationTierChanged: revision.recommendationTierChanged,
  original: revision.original,
  corrected: revision.corrected,
  createdAt: revision.createdAt,
  createdBy: revision.createdBy,
  approvedAt: revision.approvedAt,
  approvedBy: revision.approvedBy,
  rolledBackAt: revision.rolledBackAt,
  rolledBackBy: revision.rolledBackBy,
  correctionType: revision.correctionType,
  confidence: revision.confidence,
  uncertainty: revision.uncertainty,
  independentlyVerifiedAt: revision.independentlyVerifiedAt,
});
