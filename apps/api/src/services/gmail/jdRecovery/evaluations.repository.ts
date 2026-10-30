import { getDb } from "../../../config/mongo.js";
import type { ExtractedJobData } from "../../../types/job.js";
import type { StoredResumeType } from "../../../types/resume.js";
import type { RuleEvaluation, ScoreBreakdown } from "../../../types/scoring.js";
import type { ApplicationStatus } from "../gmailApplications.js";
import type { InterviewBrief } from "../interviewBrief.js";
import type { EvidenceSource, MatchLevel } from "./assessJdMatch.js";
import type { JdMatchEvidenceSnapshot } from "./jdMatchEvidence.js";
import type { PostingKind } from "./postingKind.js";

export type RecoveryStatus = "scored" | "unverified" | "not_found" | "fetch_failed";

export type RecoveryAttempt = {
  url: string;
  source: EvidenceSource;
  ok: boolean;
  reason?: string;
  matchLevel?: MatchLevel;
};

/** Which pipeline step surfaced a posting. */
export type RecoveryStage =
  | "email"
  | "email_board"
  | "guessed_board"
  | "serper_board"
  | "serper"
  | "manual"
  | "prospect"
  | "mcp";

export type JdCompleteness = "full" | "partial";
export type JdSourceType = "company_site" | "ats" | "aggregator" | "other";

/** A recovered posting that wasn't verified automatically; kept so the user can pick it. */
export type RecoveryCandidate = {
  url?: string;
  prospectId?: string;
  source: EvidenceSource;
  stage?: RecoveryStage;
  matchLevel: MatchLevel;
  title?: string;
  company?: string;
  location?: string;
  /** Cleaned posting text used if the user confirms this candidate. */
  text: string;
  /** Original retrieved text for MCP submissions; never sent to the scorer until confirm. */
  rawText?: string;
  completeness?: JdCompleteness;
  /** Claude's requested completeness; the stored `completeness` is the server's decision. */
  claimedCompleteness?: JdCompleteness;
  sourceType?: JdSourceType;
  retrievedAt?: string;
  matchEvidence?: string[];
  requisitionId?: string;
  datePosted?: string;
  claudeConfidence?: number;
  competingPostings?: Array<{ url: string; title?: string }>;
  /** Absent or pending = still in the review queue. Rejected/removed candidates stay stored but are not confirmable until restored. */
  reviewStatus?: "pending" | "rejected" | "removed";
  removedAt?: string;
  removalReason?: "listing_unavailable" | "no_usable_jd" | "wrong_posting" | "wrong_location" | "other";
  /** User asked to keep a geographically excluded candidate in the active review list. */
  geoOverride?: boolean;
  /** Immutable match-evidence capture from submit time. Never overwritten by later edits. */
  evidenceSnapshot?: JdMatchEvidenceSnapshot;
};

/** What a confirmed company board held, so "not found" can say "closed" vs "title didn't match". */
export type BoardCheck = { board: string; jobs: number; closestTitle?: string; similarity?: number };

export type FitBreakdown = {
  categories: Record<string, number>;
  capability?: number;
  survivability?: number;
  gapDock?: number;
  hardGates?: string[];
  topMatch?: string;
  mainRisk?: string;
  risks?: string[];
};

/** Everything the scorer produced, so a score can be audited without re-running it. */
export type ScoringDetail = {
  recommendation: string;
  recommendedResume: StoredResumeType;
  topMatch: string;
  mainRisk: string;
  rationale: string[];
  risks: string[];
  resumeRationale: string[];
  score: ScoreBreakdown;
  rules: RuleEvaluation;
  extracted: Omit<ExtractedJobData, "rawText">;
};

/** A fresh scoring run of the stored JD for auditing. Never replaces `fit`. */
export type ScoringDiagnostic = {
  runAt: string;
  promptVersion: string;
  total: number;
  detail: ScoringDetail;
};

export type OutcomeHistoryEntry = { status: ApplicationStatus; at: string };

export { POSTING_KINDS, type PostingKind } from "./postingKind.js";

export type ApplicationEvaluation = {
  key: string;
  company: string;
  role: string | null;
  appliedAt: string;
  requisitionId?: string;
  /**
   * Explicit classification of the underlying requisition. Absent means unknown.
   * Never inferred from completeness alone. talent_pool_or_event is excluded from
   * JD recovery and must not be scored until restored to job_posting or unknown.
   */
  postingKind?: PostingKind;
  postingKindReason?: string;
  postingKindUpdatedAt?: string;
  postingKindSource?: "explicit";
  /** Pipeline version that produced this row; older unscored rows are retried. */
  recoveryVersion?: number;
  recovery: {
    status: RecoveryStatus;
    reason?: string;
    /** Every reason the posting wasn't verified, most actionable first. */
    notes?: string[];
    source?: EvidenceSource;
    /** Step that found the stored posting (absent on rows from before stages were recorded). */
    foundVia?: RecoveryStage;
    url?: string;
    match?: { level: MatchLevel; signals: string[] };
    attempts: RecoveryAttempt[];
    serperQueries: number;
    /** "user" when the posting was picked or pasted by hand. */
    verifiedBy?: "auto" | "user";
    /** Role taken from a board title found in the email, when the classifier had none. */
    recoveredRole?: string;
    candidates?: RecoveryCandidate[];
    boardChecks?: BoardCheck[];
  };
  /** Stored so a later rubric change can re-score the same text. */
  jd?: { text: string; textHash: string; title?: string; company?: string; datePosted?: string };
  fit?: {
    total: number;
    recommendation: string;
    recommendedResume: StoredResumeType;
    scoredAt: string;
    promptVersion: string;
    /** Why the score is what it is; absent on rows scored before breakdowns were stored. */
    breakdown?: FitBreakdown;
    /** Full scorer output; absent on rows scored before snapshots were stored. */
    detail?: ScoringDetail;
  };
  diagnostic?: ScoringDiagnostic;
  /** Interview cheat sheet, generated on first request and kept; never feeds the score. */
  interviewBrief?: InterviewBrief;
  /** Gmail status at the moment of scoring; never passed to the scorer. */
  outcomeAtScoring?: ApplicationStatus;
  outcome: {
    status: ApplicationStatus;
    updatedAt: string;
    history: OutcomeHistoryEntry[];
    furthestStage?: Exclude<ApplicationStatus, "rejected">;
    /** Last interview round reached, e.g. { number: 2, label: "2nd round · technical" }. */
    furthestRound?: { number: number; label: string };
  };
  /** Set once the application was added to the tracker automatically; it is never added again. */
  trackerAutoAddedAt?: string;
  trackerJobId?: string;
  createdAt: string;
  updatedAt: string;
};

type Doc = ApplicationEvaluation & { _id: string };

let indexesEnsured = false;

const strip = ({ _id, ...rest }: Doc): ApplicationEvaluation => rest;

export const evaluationsRepository = {
  async collection() {
    const db = await getDb();
    const col = db.collection<Doc>("application_evaluations");
    if (!indexesEnsured) {
      indexesEnsured = true;
      await col.createIndex({ appliedAt: -1 }).catch(() => {
        indexesEnsured = false;
      });
    }
    return col;
  },

  async findByKeys(keys: string[]): Promise<Map<string, ApplicationEvaluation>> {
    if (keys.length === 0) return new Map();
    const col = await this.collection();
    const docs = await col.find({ _id: { $in: keys } }).toArray();
    return new Map(docs.map((d) => [d._id, strip(d)]));
  },

  /** Map tracker job id → scored (or latest) Gmail evaluation linked to that row. */
  async findByTrackerJobIds(ids: string[]): Promise<Map<string, ApplicationEvaluation>> {
    if (ids.length === 0) return new Map();
    const col = await this.collection();
    const docs = await col.find({ trackerJobId: { $in: ids } }).toArray();
    const map = new Map<string, ApplicationEvaluation>();
    for (const doc of docs) {
      const evaluation = strip(doc);
      if (!evaluation.trackerJobId) continue;
      const existing = map.get(evaluation.trackerJobId);
      if (!existing || evaluation.recovery.status === "scored") map.set(evaluation.trackerJobId, evaluation);
    }
    return map;
  },

  async listSince(sinceIso: string): Promise<ApplicationEvaluation[]> {
    const col = await this.collection();
    const docs = await col.find({ appliedAt: { $gte: sinceIso } }).sort({ appliedAt: -1 }).toArray();
    return docs.map(strip);
  },

  /** Unscored evaluations that still have stored JD candidates (active, removed, or rejected). */
  async listPendingJdReviews(): Promise<ApplicationEvaluation[]> {
    const col = await this.collection();
    const docs = await col
      .find({
        "recovery.status": { $ne: "scored" },
        "recovery.candidates.0": { $exists: true },
      })
      .sort({ appliedAt: -1 })
      .toArray();
    return docs.map(strip);
  },

  async upsert(evaluation: ApplicationEvaluation): Promise<void> {
    const col = await this.collection();
    await col.replaceOne({ _id: evaluation.key }, evaluation, { upsert: true });
  },

  /**
   * Write an evaluation unless a scored row already exists for this key. Never overwrites a score.
   *
   * Cross-process scoring claim (not implemented): API and MCP each have their own in-memory
   * `state.running`, so two workers can both call the scorer before either writes. A short-lived
   * Mongo claim would sit in front of `scoreBlind` / `scoreUserPosting`, not replace this write.
   * Shape: `findOneAndUpdate` on `_id` where status is not `scored` and not a fresh `scoring`
   * claim, setting `recovery.status: "scoring"` and `updatedAt`. Steal claims older than ~10
   * minutes so a crashed worker does not stick. `needsRecovery` should treat fresh `scoring` as
   * in-progress and stale `scoring` like a short `fetch_failed` retry — do not wait 24h and do
   * not bump `RECOVERY_VERSION`. After the LLM returns, this method still publishes `scored` and
   * still refuses to overwrite an existing score. Prospect matching already requeues non-scored
   * rows, so a stolen/stale claim remains compatible with company-scoped follow-up runs.
   */
  async upsertIfUnscored(evaluation: ApplicationEvaluation): Promise<ApplicationEvaluation> {
    const col = await this.collection();
    const existing = await col.findOne({ _id: evaluation.key });
    if (existing?.recovery.status === "scored") return strip(existing);
    const doc = { ...evaluation, _id: evaluation.key };
    if (!existing) {
      try {
        await col.insertOne(doc);
        return evaluation;
      } catch (error) {
        const code = typeof error === "object" && error && "code" in error ? (error as { code?: number }).code : undefined;
        if (code !== 11000) throw error;
        const raced = await col.findOne({ _id: evaluation.key });
        if (raced?.recovery.status === "scored") return strip(raced);
      }
    }
    const replaced = await col.findOneAndReplace(
      { _id: evaluation.key, "recovery.status": { $ne: "scored" } },
      doc,
      { returnDocument: "after" },
    );
    if (replaced) return strip(replaced);
    const current = await col.findOne({ _id: evaluation.key });
    return current ? strip(current) : evaluation;
  },

  async findByKey(key: string): Promise<ApplicationEvaluation | null> {
    const col = await this.collection();
    const doc = await col.findOne({ _id: key });
    return doc ? strip(doc) : null;
  },

  /** Every evaluation whose key starts with one of these company keys (`company::role`). */
  async findByCompanyKeys(companyKeys: string[]): Promise<ApplicationEvaluation[]> {
    if (companyKeys.length === 0) return [];
    const col = await this.collection();
    const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const docs = await col.find({ _id: { $regex: `^(?:${companyKeys.map(escape).join("|")})::` } }).toArray();
    return docs.map(strip);
  },

  /** Move an evaluation to a new key without touching its score. */
  async rekey(oldKey: string, evaluation: ApplicationEvaluation): Promise<void> {
    const col = await this.collection();
    await col.replaceOne({ _id: evaluation.key }, evaluation, { upsert: true });
    if (oldKey !== evaluation.key) await col.deleteOne({ _id: oldKey });
  },

  /** Outcome-only update; never touches the score. */
  async setDiagnostic(key: string, diagnostic: ScoringDiagnostic): Promise<void> {
    const col = await this.collection();
    await col.updateOne({ _id: key }, { $set: { diagnostic, updatedAt: new Date().toISOString() } });
  },

  async setInterviewBrief(key: string, interviewBrief: InterviewBrief): Promise<void> {
    const col = await this.collection();
    await col.updateOne({ _id: key }, { $set: { interviewBrief, updatedAt: new Date().toISOString() } });
  },

  async markTrackerAdded(key: string, trackerJobId: string): Promise<void> {
    const col = await this.collection();
    const now = new Date().toISOString();
    await col.updateOne({ _id: key }, { $set: { trackerAutoAddedAt: now, trackerJobId, updatedAt: now } });
  },

  async updateOutcome(key: string, outcome: ApplicationEvaluation["outcome"]): Promise<void> {
    const col = await this.collection();
    await col.updateOne({ _id: key }, { $set: { outcome, updatedAt: new Date().toISOString() } });
  },
};
