import { randomUUID } from "node:crypto";
import { computeJdTextHash } from "../../../lib/jdTextHash.js";
import { normalizeSourceUrl } from "../../../lib/normalizeSourceUrl.js";
import type { ApplicationEvaluation, RecoveryCandidate } from "./evaluations.repository.js";
import { evaluationsRepository } from "./evaluations.repository.js";
import { isTalentPoolOrEvent, NotAJobPostingError } from "./applicationPostingKind.js";
import { jdAvailabilityDisplay, jdAvailabilityLabel, type JdAvailabilityLabel } from "./jdCandidateAvailability.js";
import {
  assessJdGeoCompatibility,
  isGeoExcludedFromDefaultReview,
  type GeoCompatibilityAssessment,
} from "./jdGeoCompatibility.js";
import {
  buildMatchEvidenceSnapshot,
  isPendingReviewCandidate,
  type JdMatchEvidenceSnapshot,
} from "./jdMatchEvidence.js";
import {
  jdReviewDecisionsRepository,
  summarizeShadowDecisions,
} from "./jdReviewDecisions.repository.js";
import type { JdReviewAction, JdReviewDecision, JdShadowReport } from "./jdReviewDecisions.types.js";
import { assessShadowEligibility, type ShadowAssessment } from "./jdShadowEligibility.js";
import {
  AlreadyScoredError,
  confirmCandidate,
  EvaluationNotFoundError,
  scorePastedJd,
} from "./runRecovery.js";

export const JD_REMOVAL_REASONS = [
  "listing_unavailable",
  "no_usable_jd",
  "wrong_posting",
  "wrong_location",
  "other",
] as const;

export type JdRemovalReason = (typeof JD_REMOVAL_REASONS)[number];

export class InvalidJdReviewActionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidJdReviewActionError";
  }
}

export type PendingJdReviewRow = {
  applicationKey: string;
  company: string;
  role: string | null;
  appliedAt: string;
  candidateId: string;
  sourceUrl?: string;
  sourceType?: RecoveryCandidate["sourceType"];
  completeness?: RecoveryCandidate["completeness"];
  claimedCompleteness?: RecoveryCandidate["claimedCompleteness"];
  matchEvidence?: string[];
  evidence: JdMatchEvidenceSnapshot;
  shadow: ShadowAssessment;
  liveShadow: ShadowAssessment;
  retrievedAt?: string;
  pendingCandidateCount: number;
  candidateLocation?: string;
  availability: JdAvailabilityLabel;
  availabilityLabel: string;
  geo: GeoCompatibilityAssessment;
  reviewStatus?: RecoveryCandidate["reviewStatus"];
  removalReason?: RecoveryCandidate["removalReason"];
  removedAt?: string;
  exclusionReason?: string;
  queueGroup: "active" | "excluded";
};

const candidateIdOf = (candidate: RecoveryCandidate): string =>
  candidate.url ?? candidate.prospectId ?? candidate.title ?? "candidate";

export const candidateMatchesIdentifier = (candidate: RecoveryCandidate, identifier: string): boolean => {
  if (candidate.prospectId && candidate.prospectId === identifier) return true;
  const wanted = normalizeSourceUrl(identifier) ?? identifier;
  const got = candidate.url ? normalizeSourceUrl(candidate.url) ?? candidate.url : undefined;
  return Boolean(got && wanted && got === wanted);
};

const geoFor = (evaluation: ApplicationEvaluation, candidate: RecoveryCandidate): GeoCompatibilityAssessment =>
  assessJdGeoCompatibility({
    candidate,
    applicationLocation: candidate.evidenceSnapshot?.signals.location.applicationValue,
    locationProvenance: candidate.evidenceSnapshot?.signals.location.provenance,
  });

const isActionableCandidate = (evaluation: ApplicationEvaluation, candidate: RecoveryCandidate): boolean => {
  if (isTalentPoolOrEvent(evaluation)) return false;
  if (!isPendingReviewCandidate(candidate)) return false;
  if (candidate.geoOverride) return true;
  return !isGeoExcludedFromDefaultReview(geoFor(evaluation, candidate), candidate.geoOverride);
};

const pendingCandidates = (evaluation: ApplicationEvaluation): RecoveryCandidate[] =>
  (evaluation.recovery.candidates ?? []).filter(isPendingReviewCandidate);

const actionableCandidates = (evaluation: ApplicationEvaluation): RecoveryCandidate[] =>
  (evaluation.recovery.candidates ?? []).filter((row) => isActionableCandidate(evaluation, row));

export const hasPendingJdConfirmation = (evaluation?: ApplicationEvaluation): boolean => {
  if (!evaluation || evaluation.recovery.status === "scored" || isTalentPoolOrEvent(evaluation)) return false;
  return actionableCandidates(evaluation).length > 0;
};

const siblingRefs = (evaluation: ApplicationEvaluation, currentUrl?: string) =>
  pendingCandidates(evaluation)
    .filter((row) => row.url && row.url !== currentUrl)
    .map((row) => ({ url: row.url!, title: row.title }));

const snapshotFor = (evaluation: ApplicationEvaluation, candidate: RecoveryCandidate): JdMatchEvidenceSnapshot =>
  candidate.evidenceSnapshot ??
  buildMatchEvidenceSnapshot({
    applicationKey: evaluation.key,
    company: evaluation.company,
    role: evaluation.role,
    appliedAt: evaluation.appliedAt,
    appliedAtKnown: true,
    applicationRequisitionId: evaluation.requisitionId ?? candidate.evidenceSnapshot?.application.requisitionId,
    candidate,
    siblingPostings: siblingRefs(evaluation, candidate.url),
    textHash: computeJdTextHash(candidate.text),
  });

const proposedCandidateId = (evaluation: ApplicationEvaluation): string | undefined => {
  const pending = actionableCandidates(evaluation);
  const eligible = pending.find(
    (row) =>
      assessShadowEligibility(snapshotFor(evaluation, row), { reviewStatus: row.reviewStatus, geo: geoFor(evaluation, row) })
        .recommendation === "eligible_for_auto_confirmation",
  );
  return candidateIdOf(eligible ?? pending[0] ?? {});
};

const fingerprintOf = (evaluation: ApplicationEvaluation) => ({
  recoveryStatus: evaluation.recovery.status,
  fitTotal: evaluation.fit?.total,
  jdTextHash: evaluation.jd?.textHash,
  scoredAt: evaluation.fit?.scoredAt,
});

const recordDecision = async (input: {
  evaluation: ApplicationEvaluation;
  candidate: RecoveryCandidate;
  action: JdReviewAction;
  note?: string;
}): Promise<JdReviewDecision> => {
  const snapshot = snapshotFor(input.evaluation, input.candidate);
  const decision: JdReviewDecision = {
    decisionId: `jrd-${randomUUID()}`,
    applicationKey: input.evaluation.key,
    candidateId: candidateIdOf(input.candidate),
    decidedAt: new Date().toISOString(),
    action: input.action,
    proposedCandidateId: proposedCandidateId(input.evaluation),
    evidenceSnapshot: snapshot,
    shadowAtDecision: assessShadowEligibility(snapshot),
    currentCompleteness: input.candidate.completeness,
    evaluationFingerprint: fingerprintOf(input.evaluation),
    note: input.note,
  };
  await jdReviewDecisionsRepository.insert(decision);
  return decision;
};

const toReviewRow = (
  evaluation: ApplicationEvaluation,
  candidate: RecoveryCandidate,
  actionableCount: number,
): PendingJdReviewRow => {
  const evidence = snapshotFor(evaluation, candidate);
  const geo = geoFor(evaluation, candidate);
  const live = buildMatchEvidenceSnapshot({
    applicationKey: evaluation.key,
    company: evaluation.company,
    role: evaluation.role,
    appliedAt: evaluation.appliedAt,
    appliedAtKnown: evidence.application.appliedAtKnown,
    applicationRequisitionId: evaluation.requisitionId ?? evidence.application.requisitionId,
    applicationLocation: evidence.signals.location.applicationValue,
    candidate: {
      ...candidate,
      competingPostings: candidate.competingPostings,
    },
    siblingPostings: siblingRefs(evaluation, candidate.url),
    textHash: computeJdTextHash(candidate.text ?? ""),
  });
  const shadowCtx = { reviewStatus: candidate.reviewStatus, geo };
  const availability = jdAvailabilityLabel(candidate);
  const excluded =
    candidate.reviewStatus === "removed" ||
    candidate.reviewStatus === "rejected" ||
    isGeoExcludedFromDefaultReview(geo, candidate.geoOverride);
  return {
    applicationKey: evaluation.key,
    company: evaluation.company,
    role: evaluation.role,
    appliedAt: evaluation.appliedAt,
    candidateId: candidateIdOf(candidate),
    sourceUrl: candidate.url,
    sourceType: candidate.sourceType,
    completeness: candidate.completeness,
    claimedCompleteness: candidate.claimedCompleteness,
    matchEvidence: candidate.matchEvidence,
    evidence,
    shadow: assessShadowEligibility(evidence, shadowCtx),
    liveShadow: assessShadowEligibility(live, shadowCtx),
    retrievedAt: candidate.retrievedAt,
    pendingCandidateCount: actionableCount,
    candidateLocation: candidate.location ?? geo.candidateLocation,
    availability,
    availabilityLabel: jdAvailabilityDisplay(availability),
    geo,
    reviewStatus: candidate.reviewStatus,
    removalReason: candidate.removalReason,
    removedAt: candidate.removedAt,
    exclusionReason:
      isTalentPoolOrEvent(evaluation)
        ? "Talent-pool or event registration, not a scoreable job posting"
        : candidate.reviewStatus === "removed"
          ? `Removed from review (${candidate.removalReason ?? "other"})`
          : candidate.reviewStatus === "rejected"
            ? "Rejected as the wrong posting for this application"
            : geo.excludedFromDefaultReview
              ? geo.reason
              : undefined,
    queueGroup: excluded ? "excluded" : "active",
  };
};

export const pendingReviewRowsFromEvaluations = (evaluations: ApplicationEvaluation[]): PendingJdReviewRow[] => {
  const reviews = evaluations
    .filter((evaluation) => evaluation.recovery.status !== "scored")
    .flatMap((evaluation) => {
      const actionable = actionableCandidates(evaluation);
      return pendingCandidates(evaluation)
        .filter((candidate) => isActionableCandidate(evaluation, candidate))
        .map((candidate) => toReviewRow(evaluation, candidate, actionable.length));
    });
  return reviews.sort((a, b) => b.appliedAt.localeCompare(a.appliedAt) || a.applicationKey.localeCompare(b.applicationKey));
};

export const excludedReviewRowsFromEvaluations = (evaluations: ApplicationEvaluation[]): PendingJdReviewRow[] => {
  const rows = evaluations
    .filter((evaluation) => evaluation.recovery.status !== "scored")
    .flatMap((evaluation) => {
      const actionable = actionableCandidates(evaluation);
      return (evaluation.recovery.candidates ?? [])
        .filter((candidate) => !isActionableCandidate(evaluation, candidate))
        .map((candidate) => toReviewRow(evaluation, candidate, actionable.length));
    });
  return rows.sort((a, b) => b.appliedAt.localeCompare(a.appliedAt) || a.applicationKey.localeCompare(b.applicationKey));
};

export const listPendingJdReviews = async (): Promise<{
  allTime: true;
  total: number;
  reviews: PendingJdReviewRow[];
  excluded: PendingJdReviewRow[];
}> => {
  const evaluations = await evaluationsRepository.listPendingJdReviews();
  const reviews = pendingReviewRowsFromEvaluations(evaluations);
  return {
    allTime: true,
    total: reviews.length,
    reviews,
    excluded: excludedReviewRowsFromEvaluations(evaluations),
  };
};

export const getJdShadowReport = async (): Promise<JdShadowReport> =>
  summarizeShadowDecisions(await jdReviewDecisionsRepository.listRecent(500));

export const confirmReviewedCandidate = async (
  key: string,
  identifier: string,
): Promise<{ evaluation: ApplicationEvaluation; decision: JdReviewDecision }> => {
  const evaluation = await evaluationsRepository.findByKey(key);
  if (!evaluation) throw new EvaluationNotFoundError(`No evaluation for ${key}`);
  if (isTalentPoolOrEvent(evaluation)) {
    throw new NotAJobPostingError(
      `${key} is classified as a talent-pool or event registration and is not eligible to score`,
    );
  }
  const candidate = evaluation.recovery.candidates?.find((row) => candidateMatchesIdentifier(row, identifier));
  if (!candidate) throw new EvaluationNotFoundError(`No candidate ${identifier} for ${key}`);
  if (candidate.reviewStatus === "rejected") {
    throw new EvaluationNotFoundError(`Candidate ${identifier} was rejected and is not confirmable`);
  }
  if (candidate.reviewStatus === "removed") {
    throw new InvalidJdReviewActionError(`Candidate ${identifier} was removed from review; restore it before confirming`);
  }
  const proposed = proposedCandidateId(evaluation);
  const picked = candidateIdOf(candidate);
  const scored = await confirmCandidate(key, identifier);
  const action: JdReviewAction = proposed && picked !== proposed ? "selected_other" : "confirmed";
  const decision = await recordDecision({ evaluation: scored, candidate, action });
  return { evaluation: scored, decision };
};

export const rejectReviewedCandidate = async (
  key: string,
  identifier: string,
  note?: string,
): Promise<{ evaluation: ApplicationEvaluation; decision: JdReviewDecision }> => {
  const evaluation = await evaluationsRepository.findByKey(key);
  if (!evaluation) throw new EvaluationNotFoundError(`No evaluation for ${key}`);
  if (evaluation.recovery.status === "scored") {
    throw new AlreadyScoredError(`${key} is already scored; scores are final`);
  }
  const index = evaluation.recovery.candidates?.findIndex((row) => candidateMatchesIdentifier(row, identifier));
  if (index === undefined || index < 0) throw new EvaluationNotFoundError(`No candidate ${identifier} for ${key}`);
  const candidate = evaluation.recovery.candidates![index]!;
  const nextCandidates = evaluation.recovery.candidates!.map((row, i) =>
    i === index ? { ...row, reviewStatus: "rejected" as const } : row,
  );
  const updated: ApplicationEvaluation = {
    ...evaluation,
    recovery: { ...evaluation.recovery, candidates: nextCandidates },
    updatedAt: new Date().toISOString(),
  };
  const written = await evaluationsRepository.upsertIfUnscored(updated);
  if (written.recovery.status === "scored") {
    throw new AlreadyScoredError(`${key} is already scored; scores are final`);
  }
  const decision = await recordDecision({ evaluation: written, candidate: { ...candidate, reviewStatus: "rejected" }, action: "rejected", note });
  return { evaluation: written, decision };
};

export const pasteReviewedJd = async (
  key: string,
  text: string,
  url?: string,
): Promise<{ evaluation: ApplicationEvaluation; decision?: JdReviewDecision }> => {
  const before = await evaluationsRepository.findByKey(key);
  const scored = await scorePastedJd(key, text, url);
  if (!before) return { evaluation: scored };
  const pending = pendingCandidates(before);
  const candidate =
    pending.find((row) => row.url && url && normalizeSourceUrl(row.url) === normalizeSourceUrl(url)) ??
    pending[0] ?? {
      url,
      source: "manual" as const,
      matchLevel: "high" as const,
      text,
      completeness: "full" as const,
    };
  const action: JdReviewAction = pending.length > 0 ? "corrected_source" : "pasted";
  const decision = await recordDecision({ evaluation: scored, candidate, action });
  return { evaluation: scored, decision };
};

const writeCandidate = async (
  key: string,
  identifier: string,
  patch: (candidate: RecoveryCandidate) => RecoveryCandidate,
  action: JdReviewAction,
  note?: string,
): Promise<{ evaluation: ApplicationEvaluation; decision: JdReviewDecision }> => {
  const evaluation = await evaluationsRepository.findByKey(key);
  if (!evaluation) throw new EvaluationNotFoundError(`No evaluation for ${key}`);
  if (evaluation.recovery.status === "scored") {
    throw new AlreadyScoredError(`${key} is already scored; scores are final`);
  }
  const index = evaluation.recovery.candidates?.findIndex((row) => candidateMatchesIdentifier(row, identifier));
  if (index === undefined || index < 0) throw new EvaluationNotFoundError(`No candidate ${identifier} for ${key}`);
  const candidate = evaluation.recovery.candidates![index]!;
  const next = patch(candidate);
  const nextCandidates = evaluation.recovery.candidates!.map((row, i) => (i === index ? next : row));
  const updated: ApplicationEvaluation = {
    ...evaluation,
    recovery: { ...evaluation.recovery, candidates: nextCandidates },
    updatedAt: new Date().toISOString(),
  };
  const written = await evaluationsRepository.upsertIfUnscored(updated);
  if (written.recovery.status === "scored") {
    throw new AlreadyScoredError(`${key} is already scored; scores are final`);
  }
  const decision = await recordDecision({ evaluation: written, candidate: next, action, note });
  return { evaluation: written, decision };
};

export const removeReviewedCandidate = async (
  key: string,
  identifier: string,
  reason: JdRemovalReason,
): Promise<{ evaluation: ApplicationEvaluation; decision: JdReviewDecision }> => {
  if (!(JD_REMOVAL_REASONS as readonly string[]).includes(reason)) {
    throw new InvalidJdReviewActionError("A removal reason is required");
  }
  return writeCandidate(
    key,
    identifier,
    (candidate) => ({
      ...candidate,
      reviewStatus: "removed",
      removalReason: reason,
      removedAt: new Date().toISOString(),
      geoOverride: undefined,
    }),
    "removed",
    reason,
  );
};

export const restoreReviewedCandidate = async (
  key: string,
  identifier: string,
): Promise<{ evaluation: ApplicationEvaluation; decision: JdReviewDecision }> => {
  const evaluation = await evaluationsRepository.findByKey(key);
  if (!evaluation) throw new EvaluationNotFoundError(`No evaluation for ${key}`);
  const candidate = evaluation.recovery.candidates?.find((row) => candidateMatchesIdentifier(row, identifier));
  if (!candidate) throw new EvaluationNotFoundError(`No candidate ${identifier} for ${key}`);
  if (candidate.reviewStatus === "rejected") {
    throw new InvalidJdReviewActionError("Rejected candidates stay rejected; they are not restored from Remove from review");
  }
  return writeCandidate(
    key,
    identifier,
    (row) => ({
      ...row,
      reviewStatus: "pending",
      removalReason: undefined,
      removedAt: undefined,
      geoOverride: true,
    }),
    "restored",
  );
};
