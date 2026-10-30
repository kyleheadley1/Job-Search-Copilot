import { getDb } from "../../../config/mongo.js";
import {
  JD_RECOVERY_QUEUE_COLLECTION,
  type JdRecoveryOutcome,
  type JdRecoveryQueueRecord,
  type JdRecoveryQueueStatus,
} from "./jdRecoveryQueue.types.js";

type Doc = Omit<JdRecoveryQueueRecord, "applicationKey"> & { _id: string; applicationKey?: string };

let indexesEnsured = false;

const strip = (doc: Doc): JdRecoveryQueueRecord => {
  const { _id, applicationKey: _ignored, ...rest } = doc;
  return { ...rest, applicationKey: _id };
};

const optional = <T>(value: T | undefined): T | undefined => (value == null || value === "" ? undefined : value);

export type SaveQueueOutcomeInput = {
  applicationKey: string;
  status: JdRecoveryQueueStatus;
  lastOutcome: JdRecoveryOutcome;
  lastFailureReason?: string;
  nextRetryAt?: string | null;
  candidateCount?: number;
  lastCandidateSourceUrl?: string;
  evidence?: string[];
  incrementAttempt: boolean;
  nowIso: string;
};

export const jdRecoveryQueueRepository = {
  async collection() {
    const db = await getDb();
    const col = db.collection<Doc>(JD_RECOVERY_QUEUE_COLLECTION);
    if (!indexesEnsured) {
      indexesEnsured = true;
      await Promise.all([
        col.createIndex({ status: 1, nextRetryAt: 1 }),
        col.createIndex({ leaseExpiresAt: 1 }),
        col.createIndex({ lastAttemptAt: -1 }),
      ]).catch(() => {
        indexesEnsured = false;
      });
    }
    return col;
  },

  async findByKey(key: string): Promise<JdRecoveryQueueRecord | null> {
    const col = await this.collection();
    const doc = await col.findOne({ _id: key });
    return doc ? strip(doc) : null;
  },

  async findByKeys(keys: string[]): Promise<Map<string, JdRecoveryQueueRecord>> {
    const map = new Map<string, JdRecoveryQueueRecord>();
    if (keys.length === 0) return map;
    const col = await this.collection();
    const docs = await col.find({ _id: { $in: keys } }).toArray();
    for (const doc of docs) map.set(doc._id, strip(doc));
    return map;
  },

  async listAll(): Promise<JdRecoveryQueueRecord[]> {
    const col = await this.collection();
    const docs = await col.find({}).toArray();
    return docs.map(strip);
  },

  async ensureSkeleton(key: string, nowIso: string): Promise<void> {
    const col = await this.collection();
    await col.updateOne(
      { _id: key },
      {
        $setOnInsert: {
          applicationKey: key,
          status: "unattempted",
          attemptCount: 0,
          candidateCount: 0,
          createdAt: nowIso,
          updatedAt: nowIso,
        },
      },
      { upsert: true },
    );
  },

  /**
   * Claim a key only when it has no lease or the lease has expired.
   * Same-session in-progress work is not reclaimed here; callers exclude those keys.
   */
  async claimAtomic(params: {
    key: string;
    sessionId: string;
    batchId: string;
    nowIso: string;
    leaseExpiresAt: string;
  }): Promise<JdRecoveryQueueRecord | null> {
    await this.ensureSkeleton(params.key, params.nowIso);
    const col = await this.collection();
    const doc = await col.findOneAndUpdate(
      {
        _id: params.key,
        $or: [
          { leaseExpiresAt: { $exists: false } },
          { leaseExpiresAt: null },
          { leaseExpiresAt: { $lte: params.nowIso } },
        ],
      },
      {
        $set: {
          status: "in_progress",
          leaseOwner: params.sessionId,
          leaseExpiresAt: params.leaseExpiresAt,
          lastAttemptAt: params.nowIso,
          lastClaimBatchId: params.batchId,
          updatedAt: params.nowIso,
        },
      },
      { returnDocument: "after" },
    );
    return doc ? strip(doc) : null;
  },

  async saveOutcome(input: SaveQueueOutcomeInput): Promise<JdRecoveryQueueRecord> {
    await this.ensureSkeleton(input.applicationKey, input.nowIso);
    const col = await this.collection();
    const unset: Record<string, ""> = {
      leaseOwner: "",
      leaseExpiresAt: "",
    };
    if (input.nextRetryAt === null) unset.nextRetryAt = "";
    const set: Record<string, unknown> = {
      status: input.status,
      lastOutcome: input.lastOutcome,
      updatedAt: input.nowIso,
      lastAttemptAt: input.nowIso,
    };
    if (input.lastFailureReason !== undefined) set.lastFailureReason = optional(input.lastFailureReason);
    if (input.nextRetryAt) set.nextRetryAt = input.nextRetryAt;
    if (input.candidateCount !== undefined) set.candidateCount = input.candidateCount;
    if (input.lastCandidateSourceUrl !== undefined) {
      set.lastCandidateSourceUrl = optional(input.lastCandidateSourceUrl);
    }
    if (input.evidence !== undefined) set.evidence = input.evidence;
    const inc = input.incrementAttempt ? { attemptCount: 1 } : {};
    const doc = await col.findOneAndUpdate(
      { _id: input.applicationKey },
      {
        $set: set,
        $unset: unset,
        ...(input.incrementAttempt ? { $inc: inc } : {}),
      },
      { returnDocument: "after" },
    );
    if (!doc) {
      throw new Error(`Failed to persist recovery outcome for ${input.applicationKey}`);
    }
    return strip(doc);
  },
};

export const resetJdRecoveryQueueIndexesForTests = (): void => {
  indexesEnsured = false;
};
