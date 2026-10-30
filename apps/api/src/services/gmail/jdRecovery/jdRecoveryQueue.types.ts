export const JD_RECOVERY_QUEUE_COLLECTION = "jd_recovery_queue";

export const JD_RECOVERY_DEFAULT_BATCH = 5;
export const JD_RECOVERY_MAX_BATCH = 10;
export const JD_RECOVERY_LEASE_MS = 2 * 60 * 60 * 1000;
export const JD_RECOVERY_NOT_FOUND_RETRY_DAYS = 7;
export const JD_RECOVERY_TEMPORARY_RETRY_MS = 60 * 60 * 1000;

export const JD_RECOVERY_QUEUE_STATUSES = [
  "unattempted",
  "in_progress",
  "candidate_pending_review",
  "not_found",
  "skipped_requires_review",
  "not_a_job_posting",
  "unresolved_application",
  "retry_due",
  "completed",
] as const;

export type JdRecoveryQueueStatus = (typeof JD_RECOVERY_QUEUE_STATUSES)[number];

export const JD_RECOVERY_OUTCOMES = [
  "candidate_submitted",
  "not_found",
  "temporary_error",
  "skipped_requires_review",
  "not_a_job_posting",
  "unresolved_application",
] as const;

export type JdRecoveryOutcome = (typeof JD_RECOVERY_OUTCOMES)[number];

export type JdRecoveryEffectiveStatus =
  | "completed"
  | "candidate_pending_review"
  | "in_progress"
  | "not_found"
  | "skipped_requires_review"
  | "not_a_job_posting"
  | "unresolved_application"
  | "retry_due"
  | "temporary_failure"
  | "unattempted";

export type JdRecoveryUnresolvedExclusion = "missing_gmail_record" | "outside_lookback";

export type RelatedApplicationHint = {
  key: string;
  company: string;
  role: string | null;
  appliedAt: string;
  lastUpdateAt: string;
  status: string;
  scored?: boolean;
  note: "hint_only_not_a_merge";
};

export type JdRecoveryQueueRecord = {
  applicationKey: string;
  status: JdRecoveryQueueStatus;
  attemptCount: number;
  lastAttemptAt?: string;
  nextRetryAt?: string;
  lastOutcome?: JdRecoveryOutcome;
  lastFailureReason?: string;
  candidateCount: number;
  lastCandidateSourceUrl?: string;
  leaseOwner?: string;
  leaseExpiresAt?: string;
  lastClaimBatchId?: string;
  evidence?: string[];
  createdAt: string;
  updatedAt: string;
};

export type ClaimJdRecoveryBatchInput = {
  days?: number;
  limit?: number;
  mode?: "default" | "retry_only";
  sessionId?: string;
  includeSkipped?: boolean;
};

export type RecordJdRecoveryOutcomeInput = {
  applicationKey: string;
  outcome: JdRecoveryOutcome;
  reason?: string;
  evidence?: string[];
  sourceUrl?: string;
  sessionId?: string;
};

export type JdRecoveryProgressInput = {
  days?: number;
};
