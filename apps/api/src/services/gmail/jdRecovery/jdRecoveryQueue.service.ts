import { randomUUID } from "node:crypto";
import {
  APPLICATION_IDENTITY_LOOKBACK_DAYS,
  filterApplicationsByLookback,
  relatedApplicationsForKey,
  type GmailApplication,
} from "../gmailApplications.js";
import { isTalentPoolOrEvent } from "./applicationPostingKind.js";
import type { ApplicationEvaluation } from "./evaluations.repository.js";
import {
  toMissingJobDescriptionRow,
  type MissingJobDescriptionRow,
  type SubmitJdCandidateResult,
} from "./jdCandidates.service.js";
import { hasPendingJdConfirmation } from "./jdReview.service.js";
import { jdRecoveryQueueRepository } from "./jdRecoveryQueue.repository.js";
import {
  JD_RECOVERY_DEFAULT_BATCH,
  JD_RECOVERY_LEASE_MS,
  JD_RECOVERY_MAX_BATCH,
  JD_RECOVERY_NOT_FOUND_RETRY_DAYS,
  JD_RECOVERY_TEMPORARY_RETRY_MS,
  type ClaimJdRecoveryBatchInput,
  type JdRecoveryEffectiveStatus,
  type JdRecoveryOutcome,
  type JdRecoveryQueueRecord,
  type JdRecoveryQueueStatus,
  type JdRecoveryUnresolvedExclusion,
  type RecordJdRecoveryOutcomeInput,
  type RelatedApplicationHint,
} from "./jdRecoveryQueue.types.js";

export type JdRecoveryQueueStore = {
  findByKey: (key: string) => Promise<JdRecoveryQueueRecord | null>;
  findByKeys: (keys: string[]) => Promise<Map<string, JdRecoveryQueueRecord>>;
  listAll: () => Promise<JdRecoveryQueueRecord[]>;
  claimAtomic: (params: {
    key: string;
    sessionId: string;
    batchId: string;
    nowIso: string;
    leaseExpiresAt: string;
  }) => Promise<JdRecoveryQueueRecord | null>;
  saveOutcome: typeof jdRecoveryQueueRepository.saveOutcome;
};

export type JdRecoveryQueueRuntime = {
  getApplications: (days: number) => Promise<GmailApplication[]>;
  getEvaluationsByKeys: (keys: string[]) => Promise<Map<string, ApplicationEvaluation>>;
  store: JdRecoveryQueueStore;
  now?: () => Date;
  /** Always load this many days of Gmail grouping before applying the claim/progress filter. */
  identityLookbackDays?: number;
};

const MAX_REASON = 400;
const MAX_EVIDENCE = 8;
const MAX_EVIDENCE_CHARS = 240;

export { hasPendingJdConfirmation };

export const isScoredEvaluation = (evaluation?: ApplicationEvaluation): boolean =>
  evaluation?.recovery.status === "scored";

export const deriveEffectiveRecoveryStatus = (
  evaluation: ApplicationEvaluation | undefined,
  queue: JdRecoveryQueueRecord | undefined,
  nowIso: string,
  opts?: { gmailResolved?: boolean },
): JdRecoveryEffectiveStatus => {
  if (isScoredEvaluation(evaluation)) return "completed";
  if (isTalentPoolOrEvent(evaluation) || queue?.lastOutcome === "not_a_job_posting" || queue?.status === "not_a_job_posting") {
    return "not_a_job_posting";
  }
  if (opts?.gmailResolved === false) return "unresolved_application";
  if (queue?.lastOutcome === "unresolved_application" || queue?.status === "unresolved_application") {
    return "unresolved_application";
  }
  if (hasPendingJdConfirmation(evaluation)) return "candidate_pending_review";
  if (queue?.leaseExpiresAt && queue.leaseExpiresAt > nowIso) return "in_progress";
  if (queue?.lastOutcome === "temporary_error") {
    if (queue.nextRetryAt && queue.nextRetryAt > nowIso) return "temporary_failure";
    return "retry_due";
  }
  if (queue?.lastOutcome === "skipped_requires_review" || queue?.status === "skipped_requires_review") {
    return "skipped_requires_review";
  }
  if (queue?.lastOutcome === "not_found" || queue?.status === "not_found") {
    if (queue.nextRetryAt && queue.nextRetryAt > nowIso) return "not_found";
    return "retry_due";
  }
  return "unattempted";
};

const claimPriority = (status: JdRecoveryEffectiveStatus): number | null => {
  if (status === "unattempted") return 0;
  if (status === "retry_due") return 1;
  return null;
};

const capEvidence = (items: string[] | undefined): string[] =>
  (items ?? [])
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, MAX_EVIDENCE)
    .map((item) => item.slice(0, MAX_EVIDENCE_CHARS));

const capReason = (reason: string | undefined): string | undefined => {
  const trimmed = reason?.trim();
  if (!trimmed) return undefined;
  return trimmed.slice(0, MAX_REASON);
};

const sortApps = (apps: GmailApplication[]): GmailApplication[] =>
  [...apps].sort((a, b) => {
    const byDate = b.appliedAt.localeCompare(a.appliedAt);
    if (byDate !== 0) return byDate;
    return a.key.localeCompare(b.key);
  });

export type ClaimedRecoveryRow = MissingJobDescriptionRow & {
  queueStatus: JdRecoveryEffectiveStatus;
  attemptCount: number;
  lastOutcome?: JdRecoveryOutcome;
  lastFailureReason?: string;
  nextRetryAt?: string;
};

const toClaimedRow = (
  app: GmailApplication,
  evaluation: ApplicationEvaluation | undefined,
  queue: JdRecoveryQueueRecord | undefined,
  effective: JdRecoveryEffectiveStatus,
): ClaimedRecoveryRow => ({
  ...toMissingJobDescriptionRow(app, evaluation),
  queueStatus: effective,
  attemptCount: queue?.attemptCount ?? 0,
  lastOutcome: queue?.lastOutcome,
  lastFailureReason: queue?.lastFailureReason,
  nextRetryAt: queue?.nextRetryAt,
});

const outcomeStatus = (
  outcome: JdRecoveryOutcome,
  evaluation: ApplicationEvaluation | undefined,
): JdRecoveryQueueStatus => {
  if (isScoredEvaluation(evaluation)) return "completed";
  if (outcome === "candidate_submitted" || hasPendingJdConfirmation(evaluation)) {
    return "candidate_pending_review";
  }
  if (outcome === "temporary_error") return "retry_due";
  if (outcome === "not_found") return "not_found";
  if (outcome === "skipped_requires_review") return "skipped_requires_review";
  if (outcome === "not_a_job_posting") return "not_a_job_posting";
  if (outcome === "unresolved_application") return "unresolved_application";
  return "not_found";
};

const nextRetryFor = (outcome: JdRecoveryOutcome, now: Date): string | null => {
  if (outcome === "not_found") {
    return new Date(now.getTime() + JD_RECOVERY_NOT_FOUND_RETRY_DAYS * 24 * 60 * 60 * 1000).toISOString();
  }
  if (outcome === "temporary_error") {
    return new Date(now.getTime() + JD_RECOVERY_TEMPORARY_RETRY_MS).toISOString();
  }
  return null;
};

const toRelatedHints = (
  claimedKey: string,
  apps: GmailApplication[],
  evaluations: Map<string, ApplicationEvaluation>,
): RelatedApplicationHint[] =>
  relatedApplicationsForKey(claimedKey, apps).map((row) => ({
    ...row,
    scored: isScoredEvaluation(evaluations.get(row.key)),
    note: "hint_only_not_a_merge" as const,
  }));

export const createJdRecoveryQueueService = (runtime: JdRecoveryQueueRuntime) => {
  const now = () => runtime.now?.() ?? new Date();
  const identityDays = runtime.identityLookbackDays;

  const loadIdentityApps = async (days: number) => {
    const loaded = sortApps(await runtime.getApplications(identityDays ?? days));
    if (identityDays != null && days < identityDays) {
      return { identityApps: loaded, apps: filterApplicationsByLookback(loaded, days, now()) };
    }
    return { identityApps: loaded, apps: loaded };
  };

  const loadWindow = async (days: number) => {
    const { identityApps, apps } = await loadIdentityApps(days);
    const evaluations = await runtime.getEvaluationsByKeys(identityApps.map((app) => app.key));
    const queue = await runtime.store.findByKeys(apps.map((app) => app.key));
    return { identityApps, apps, evaluations, queue };
  };

  const classify = (
    apps: GmailApplication[],
    evaluations: Map<string, ApplicationEvaluation>,
    queue: Map<string, JdRecoveryQueueRecord>,
    nowIso: string,
  ) =>
    apps.map((app) => {
      const evaluation = evaluations.get(app.key);
      const record = queue.get(app.key);
      const effective = deriveEffectiveRecoveryStatus(evaluation, record, nowIso);
      return { app, evaluation, record, effective };
    });

  const claim = async (input: ClaimJdRecoveryBatchInput = {}) => {
    const days = input.days ?? 120;
    const limit = Math.min(Math.max(input.limit ?? JD_RECOVERY_DEFAULT_BATCH, 1), JD_RECOVERY_MAX_BATCH);
    const mode = input.mode ?? "default";
    const sessionId = input.sessionId?.trim() || `jdq-${randomUUID()}`;
    const timestamp = now();
    const nowIso = timestamp.toISOString();
    const leaseExpiresAt = new Date(timestamp.getTime() + JD_RECOVERY_LEASE_MS).toISOString();
    const batchId = `batch-${randomUUID()}`;
    const { apps, evaluations, queue } = await loadWindow(days);
    const classified = classify(apps, evaluations, queue, nowIso);

    const eligible = classified.filter((row) => {
      if (row.effective === "completed" || row.effective === "candidate_pending_review") return false;
      if (row.effective === "in_progress") return false;
      if (row.effective === "not_a_job_posting" || row.effective === "unresolved_application") return false;
      if (row.effective === "skipped_requires_review") return Boolean(input.includeSkipped);
      if (mode === "retry_only") return row.effective === "retry_due";
      return row.effective === "unattempted" || row.effective === "retry_due";
    });

    eligible.sort((a, b) => {
      const pa = claimPriority(a.effective) ?? 9;
      const pb = claimPriority(b.effective) ?? 9;
      if (pa !== pb) return pa - pb;
      const byDate = b.app.appliedAt.localeCompare(a.app.appliedAt);
      if (byDate !== 0) return byDate;
      return a.app.key.localeCompare(b.app.key);
    });

    const claimed: ClaimedRecoveryRow[] = [];
    const skippedOverlap: string[] = [];
    for (const row of eligible) {
      if (claimed.length >= limit) break;
      const locked = await runtime.store.claimAtomic({
        key: row.app.key,
        sessionId,
        batchId,
        nowIso,
        leaseExpiresAt,
      });
      if (!locked) {
        skippedOverlap.push(row.app.key);
        continue;
      }
      claimed.push(toClaimedRow(row.app, row.evaluation, locked, "in_progress"));
    }

    const remaining = classified.filter((row) => {
      if (claimed.some((item) => item.applicationKey === row.app.key)) return false;
      return row.effective === "unattempted" || row.effective === "retry_due";
    });

    return {
      sessionId,
      batchId,
      leaseExpiresAt,
      days,
      claimed,
      skippedOverlapCount: skippedOverlap.length,
      remainingEligible: {
        unattempted: remaining.filter((row) => row.effective === "unattempted").length,
        retryDue: remaining.filter((row) => row.effective === "retry_due").length,
      },
    };
  };

  const record = async (input: RecordJdRecoveryOutcomeInput) => {
    const timestamp = now();
    const nowIso = timestamp.toISOString();
    const { identityApps, evaluations: windowEvals } = await loadWindow(identityDays ?? 120);
    const evaluation =
      (await runtime.getEvaluationsByKeys([input.applicationKey])).get(input.applicationKey) ??
      windowEvals.get(input.applicationKey);
    const gmailResolved = identityApps.some((app) => app.key === input.applicationKey);
    const relatedKeys = toRelatedHints(input.applicationKey, identityApps, windowEvals);
    if (isScoredEvaluation(evaluation)) {
      const saved = await runtime.store.saveOutcome({
        applicationKey: input.applicationKey,
        status: "completed",
        lastOutcome: input.outcome,
        incrementAttempt: false,
        candidateCount: evaluation?.recovery.candidates?.length ?? 0,
        nowIso,
        nextRetryAt: null,
      });
      return {
        applicationKey: input.applicationKey,
        recorded: true as const,
        completed: true as const,
        queueStatus: "completed" as const,
        effectiveStatus: "completed" as const,
        retryAt: undefined,
        attemptCount: saved.attemptCount,
        candidateCount: saved.candidateCount,
        note: "Evaluation is already scored; queue marked completed. Scores were not changed.",
      };
    }
    if (!gmailResolved) {
      const saved = await runtime.store.saveOutcome({
        applicationKey: input.applicationKey,
        status: "unresolved_application",
        lastOutcome: input.outcome === "candidate_submitted" ? "unresolved_application" : input.outcome,
        lastFailureReason: capReason(input.reason) ?? "claimed_key_not_in_gmail_listing",
        nextRetryAt: null,
        candidateCount: evaluation?.recovery.candidates?.length,
        lastCandidateSourceUrl: input.sourceUrl,
        evidence: capEvidence(input.evidence),
        incrementAttempt: true,
        nowIso,
      });
      return {
        applicationKey: input.applicationKey,
        recorded: true as const,
        completed: false as const,
        queueStatus: "unresolved_application" as const,
        effectiveStatus: "unresolved_application" as const,
        retryAt: undefined,
        attemptCount: saved.attemptCount,
        candidateCount: saved.candidateCount,
        error: "APPLICATION_UNRESOLVED",
        exclusion: "missing_gmail_record" as const,
        possibleRelatedKeys: relatedKeys,
        note: "Queue key is not in the current Gmail listing. Queue row preserved. Not a posting miss. Same-company keys are hints only and were not merged. Reconcile identity before retrying.",
      };
    }
    if (input.outcome === "candidate_submitted" && !hasPendingJdConfirmation(evaluation)) {
      return {
        applicationKey: input.applicationKey,
        recorded: false as const,
        completed: false as const,
        queueStatus: "in_progress" as const,
        effectiveStatus: deriveEffectiveRecoveryStatus(evaluation, await runtime.store.findByKey(input.applicationKey), nowIso),
        error: "CANDIDATE_NOT_SUBMITTED",
        note: "Call submit_jd_candidate first. A plausible URL is not enough to complete or score this application.",
      };
    }
    const outcome: JdRecoveryOutcome =
      input.outcome === "not_a_job_posting" || isTalentPoolOrEvent(evaluation) ? "not_a_job_posting" : input.outcome;
    const status = outcomeStatus(outcome, evaluation);
    const saved = await runtime.store.saveOutcome({
      applicationKey: input.applicationKey,
      status,
      lastOutcome: outcome,
      lastFailureReason: capReason(input.reason),
      nextRetryAt: nextRetryFor(outcome, timestamp),
      candidateCount: evaluation?.recovery.candidates?.length,
      lastCandidateSourceUrl: input.sourceUrl,
      evidence: capEvidence(input.evidence),
      incrementAttempt: true,
      nowIso,
    });
    const effective = deriveEffectiveRecoveryStatus(evaluation, saved, nowIso, { gmailResolved: true });
    return {
      applicationKey: input.applicationKey,
      recorded: true as const,
      completed: false as const,
      queueStatus: saved.status,
      effectiveStatus: effective,
      retryAt: saved.nextRetryAt,
      attemptCount: saved.attemptCount,
      candidateCount: saved.candidateCount,
      note:
        outcome === "candidate_submitted"
          ? "Candidate stored for human confirmation. Not scored."
          : outcome === "skipped_requires_review"
            ? "Held for human review. Not a posting miss and not scheduled for automatic retry. Reopen with includeSkipped."
            : outcome === "not_a_job_posting"
              ? "Classified as a talent-pool or event registration. Excluded from JD recovery and scoring. Distinct from not_found. Reversible with classify_application_posting_kind."
              : undefined,
    };
  };

  const syncAfterCandidateSubmitted = async (result: SubmitJdCandidateResult) => {
    if (
      result.status === "previously_removed" ||
      result.status === "previously_rejected" ||
      result.status === "application_unresolved" ||
      result.reviewRequired === false
    ) {
      return;
    }
    const timestamp = now();
    await runtime.store.saveOutcome({
      applicationKey: result.applicationKey,
      status: "candidate_pending_review",
      lastOutcome: "candidate_submitted",
      candidateCount: result.candidateCount,
      lastCandidateSourceUrl: result.sourceUrl,
      incrementAttempt: false,
      nowIso: timestamp.toISOString(),
      nextRetryAt: null,
    });
  };

  const syncAfterReviewChange = async (evaluation: ApplicationEvaluation) => {
    const existing = await runtime.store.findByKey(evaluation.key);
    const timestamp = now();
    const nowIso = timestamp.toISOString();
    if (isScoredEvaluation(evaluation)) {
      if (!existing) return;
      await runtime.store.saveOutcome({
        applicationKey: evaluation.key,
        status: "completed",
        lastOutcome: existing.lastOutcome ?? "candidate_submitted",
        candidateCount: evaluation.recovery.candidates?.length,
        incrementAttempt: false,
        nowIso,
        nextRetryAt: null,
      });
      return;
    }
    if (isTalentPoolOrEvent(evaluation)) {
      await runtime.store.saveOutcome({
        applicationKey: evaluation.key,
        status: "not_a_job_posting",
        lastOutcome: "not_a_job_posting",
        lastFailureReason: evaluation.postingKindReason ?? "talent_pool_or_event",
        candidateCount: evaluation.recovery.candidates?.length,
        incrementAttempt: false,
        nowIso,
        nextRetryAt: null,
      });
      return;
    }
    if (hasPendingJdConfirmation(evaluation)) {
      if (!existing) return;
      await runtime.store.saveOutcome({
        applicationKey: evaluation.key,
        status: "candidate_pending_review",
        lastOutcome: "candidate_submitted",
        candidateCount: evaluation.recovery.candidates?.length,
        incrementAttempt: false,
        nowIso,
        nextRetryAt: null,
      });
      return;
    }
    await runtime.store.saveOutcome({
      applicationKey: evaluation.key,
      status: "retry_due",
      lastOutcome: "temporary_error",
      lastFailureReason: "no_actionable_candidates",
      candidateCount: evaluation.recovery.candidates?.length,
      incrementAttempt: false,
      nowIso,
      nextRetryAt: nextRetryFor("temporary_error", timestamp),
    });
  };

  const progress = async (input: { days?: number } = {}) => {
    const days = input.days ?? 120;
    const nowIso = now().toISOString();
    const { identityApps, apps, evaluations, queue } = await loadWindow(days);
    const classified = classify(apps, evaluations, queue, nowIso);
    const count = (status: JdRecoveryEffectiveStatus) =>
      classified.filter((row) => row.effective === status).length;
    const windowKeys = new Set(apps.map((app) => app.key));
    const identityKeys = new Set(identityApps.map((app) => app.key));
    const allQueue = await runtime.store.listAll();
    const unresolvedItems = allQueue
      .filter((row) => !windowKeys.has(row.applicationKey))
      .map((row) => {
        const evaluation = evaluations.get(row.applicationKey);
        const exclusion: JdRecoveryUnresolvedExclusion = identityKeys.has(row.applicationKey)
          ? "outside_lookback"
          : "missing_gmail_record";
        const related = identityApps.find((app) => app.key === row.applicationKey);
        return {
          applicationKey: row.applicationKey,
          company: related?.company,
          title: related?.role ?? null,
          outcome: row.lastOutcome,
          queueStatus: deriveEffectiveRecoveryStatus(evaluation, row, nowIso, {
            gmailResolved: exclusion !== "missing_gmail_record",
          }),
          attemptedAt: row.lastAttemptAt,
          reason: row.lastFailureReason,
          retryAt: row.nextRetryAt,
          exclusion,
          possibleRelatedKeys:
            exclusion === "missing_gmail_record" ? toRelatedHints(row.applicationKey, identityApps, evaluations) : [],
        };
      });
    const recent = [
      ...classified
        .filter((row) => row.record?.lastAttemptAt)
        .map((row) => ({
          applicationKey: row.app.key,
          company: row.app.company,
          title: row.app.role,
          outcome: row.record?.lastOutcome,
          queueStatus: row.effective,
          attemptedAt: row.record?.lastAttemptAt,
          reason: row.record?.lastFailureReason,
          retryAt: row.record?.nextRetryAt,
        })),
      ...unresolvedItems.map((row) => ({
        applicationKey: row.applicationKey,
        company: row.company,
        title: row.title,
        outcome: row.outcome,
        queueStatus: row.queueStatus,
        attemptedAt: row.attemptedAt,
        reason: row.reason,
        retryAt: row.retryAt,
      })),
    ]
      .sort((a, b) => (b.attemptedAt ?? "").localeCompare(a.attemptedAt ?? ""))
      .slice(0, 15);
    const inProgress = classified
      .filter((row) => row.effective === "in_progress")
      .map((row) => ({
        applicationKey: row.app.key,
        company: row.app.company,
        title: row.app.role,
        leaseExpiresAt: row.record?.leaseExpiresAt,
        leaseOwner: row.record?.leaseOwner,
      }));
    return {
      readOnly: true as const,
      days,
      identityLookbackDays: identityDays ?? days,
      total: classified.length,
      scored: count("completed"),
      unattempted: count("unattempted"),
      inProgress: count("in_progress"),
      pendingHumanJdReview: count("candidate_pending_review"),
      notFoundRetryNotDue: count("not_found"),
      skippedRequiresReview: count("skipped_requires_review"),
      notAJobPosting: count("not_a_job_posting"),
      retryDue: count("retry_due"),
      temporaryFailures: count("temporary_failure"),
      unresolvedQueue: {
        missingGmailRecord: unresolvedItems.filter((row) => row.exclusion === "missing_gmail_record").length,
        outsideLookback: unresolvedItems.filter((row) => row.exclusion === "outside_lookback").length,
        items: unresolvedItems,
      },
      inProgressItems: inProgress,
      recentAttempts: recent,
    };
  };

  const syncAfterPostingKindChange = async (evaluation: ApplicationEvaluation) => {
    await syncAfterReviewChange(evaluation);
  };

  return {
    claim,
    record,
    progress,
    syncAfterCandidateSubmitted,
    syncAfterReviewChange,
    syncAfterPostingKindChange,
  };
};

export const createLiveJdRecoveryQueueService = (params: {
  getApplications: JdRecoveryQueueRuntime["getApplications"];
  getEvaluationsByKeys: JdRecoveryQueueRuntime["getEvaluationsByKeys"];
}) =>
  createJdRecoveryQueueService({
    ...params,
    store: jdRecoveryQueueRepository,
    identityLookbackDays: APPLICATION_IDENTITY_LOOKBACK_DAYS,
  });
