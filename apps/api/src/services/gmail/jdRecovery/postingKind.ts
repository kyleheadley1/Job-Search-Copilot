export const POSTING_KINDS = ["job_posting", "talent_pool_or_event", "unknown"] as const;
export type PostingKind = (typeof POSTING_KINDS)[number];
