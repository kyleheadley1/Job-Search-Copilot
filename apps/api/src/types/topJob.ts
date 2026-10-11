import type { ExtractedJobData } from "./job.js";
import type { StoredResumeType } from "./resume.js";
import type { Recommendation, RuleEvaluation, ScoreBreakdown } from "./scoring.js";

export const ALERT_PLATFORMS = ["linkedin", "indeed", "ziprecruiter", "remotehunter"] as const;
export type AlertPlatform = (typeof ALERT_PLATFORMS)[number];

export type TopJobSource = `${AlertPlatform}_alert`;

export type DiscoveredListing = {
  source: TopJobSource;
  externalId: string;
  company: string;
  title: string;
  description: string;
  applyUrl: string;
  location?: string;
  remote?: boolean;
  sourcePostedAt: string;
  sourceUpdatedAt: string;
};

export type TopJobRecord = {
  id: string;
  source: TopJobSource;
  externalId: string;
  applyUrl: string;
  sourcePostedAt: string;
  sourceUpdatedAt: string;
  lastSyncedAt: string;
  extracted: ExtractedJobData;
  rules: RuleEvaluation;
  score: ScoreBreakdown;
  recommendation: Recommendation;
  topMatch: string;
  mainRisk: string;
  rationale: string[];
  recommendedResume: StoredResumeType;
  resumeRationale: string[];
  promotedToJobId?: string;
  /** Location from the alert or the posting page. */
  location?: string;
  /** Why the row is no longer shown: the posting closed, or the location isn't remote/NYC. */
  hiddenReason?: "closed" | "location" | "applied";
  hiddenAt?: string;
  /** Last time the posting was re-checked for being closed. */
  liveCheckedAt?: string;
};

export type TopJobsSyncStats = {
  /** New alert emails read this run. */
  alertEmails: number;
  /** Roles pulled out of those emails (before de-duplication). */
  listingsParsed: number;
  /** Pending roles considered this run. */
  fetched: number;
  preFiltered: number;
  triaged: number;
  stored: number;
  skippedExisting: number;
  belowMinScore: number;
  /** No readable job description from the alert link or a search fallback. */
  jdUnavailable: number;
  /** Not remote and not in the NYC metro. */
  locationFiltered: number;
  /** Posting no longer accepting applications. */
  closed: number;
  /** Previously listed roles hidden this run (closed since, or location doesn't fit). */
  retired: number;
  serperQueries: number;
  bySource: Partial<Record<AlertPlatform, number>>;
  /** Roles labelled by the cheap batched pre-screen this run. */
  prescreened?: number;
  /** Roles the pre-screen rated a clear mismatch, so they were never fully scored. */
  prescreenSkipped?: number;
  /** Scoring stopped early because today's share of the monthly budget ran out. */
  budgetLimited?: boolean;
};

export type TopJobsSyncMeta = {
  _id: "sync_meta";
  lastSyncAt: string | null;
  lastManualSyncAt: string | null;
  lastSyncStats: TopJobsSyncStats | null;
  lastSyncError: string | null;
};

export type TopJobsSyncStatus = {
  lastSyncAt: string | null;
  lastManualSyncAt: string | null;
  lastSyncStats: TopJobsSyncStats | null;
  lastSyncError: string | null;
  manualRefreshCooldownMin: number;
  canManualRefresh: boolean;
  manualRefreshAvailableAt: string | null;
  gmailConnected: boolean;
  serperConfigured: boolean;
  openAiKeyConfigured: boolean;
  /** Roles parsed from alerts that haven't been checked yet (waiting on the daily scoring cap). */
  pendingListings: number;
  budget: { monthlyUsd: number; spentThisMonthUsd: number };
};
