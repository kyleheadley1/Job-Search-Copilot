import { getDb } from "../../config/mongo.js";
import type { ScoreRevision } from "./scoreRevision.types.js";

type Doc = ScoreRevision & { _id: string };

const strip = ({ _id, ...rest }: Doc): ScoreRevision => rest;

let indexesEnsured = false;

export class ConcurrentApprovalError extends Error {
  constructor(applicationKey: string) {
    super(`Another approved revision already exists for ${applicationKey}`);
    this.name = "ConcurrentApprovalError";
  }
}

export class RevisionStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RevisionStateError";
  }
}

export const scoreRevisionsRepository = {
  async collection() {
    const db = await getDb();
    const col = db.collection<Doc>("score_revisions");
    if (!indexesEnsured) {
      indexesEnsured = true;
      await Promise.all([
        col.createIndex({ applicationKey: 1, createdAt: -1 }),
        col.createIndex({ activeApplicationKey: 1 }, { unique: true, sparse: true }),
      ]).catch(() => {
        indexesEnsured = false;
      });
    }
    return col;
  },

  async insert(revision: ScoreRevision): Promise<void> {
    const col = await this.collection();
    await col.insertOne({ ...revision, _id: revision.revisionId });
  },

  async findById(revisionId: string): Promise<ScoreRevision | null> {
    const col = await this.collection();
    const doc = await col.findOne({ _id: revisionId });
    return doc ? strip(doc) : null;
  },

  async listByApplicationKey(applicationKey: string): Promise<ScoreRevision[]> {
    const col = await this.collection();
    const docs = await col.find({ applicationKey }).sort({ createdAt: -1 }).toArray();
    return docs.map(strip);
  },

  async findApprovedByApplicationKeys(keys: string[]): Promise<Map<string, ScoreRevision>> {
    if (keys.length === 0) return new Map();
    const col = await this.collection();
    const docs = await col.find({ activeApplicationKey: { $in: keys } }).toArray();
    return new Map(docs.map((d) => [d.applicationKey, strip(d)]));
  },

  async approveAtomic(params: {
    revisionId: string;
    applicationKey: string;
    approvedBy: ScoreRevision["approvedBy"];
    approvedAt: string;
    independentlyVerifiedAt?: string;
  }): Promise<ScoreRevision> {
    const col = await this.collection();
    try {
      const updated = await col.findOneAndUpdate(
        { _id: params.revisionId, applicationKey: params.applicationKey, status: "proposed" },
        {
          $set: {
            status: "approved",
            approvedAt: params.approvedAt,
            approvedBy: params.approvedBy,
            activeApplicationKey: params.applicationKey,
            ...(params.independentlyVerifiedAt ? { independentlyVerifiedAt: params.independentlyVerifiedAt } : {}),
          },
        },
        { returnDocument: "after" },
      );
      if (!updated) {
        throw new RevisionStateError("Revision is not in proposed status or does not match the evaluation.");
      }
      return strip(updated);
    } catch (error) {
      const code = typeof error === "object" && error && "code" in error ? (error as { code?: number }).code : undefined;
      if (code === 11000) throw new ConcurrentApprovalError(params.applicationKey);
      throw error;
    }
  },

  async rollbackAtomic(params: {
    revisionId: string;
    applicationKey: string;
    rolledBackBy: ScoreRevision["rolledBackBy"];
    rolledBackAt: string;
  }): Promise<ScoreRevision> {
    const col = await this.collection();
    const updated = await col.findOneAndUpdate(
      { _id: params.revisionId, applicationKey: params.applicationKey, status: "approved" },
      {
        $set: {
          status: "rolled_back",
          rolledBackAt: params.rolledBackAt,
          rolledBackBy: params.rolledBackBy,
        },
        $unset: { activeApplicationKey: "" },
      },
      { returnDocument: "after" },
    );
    if (!updated) {
      throw new RevisionStateError("Revision is not the active approved revision.");
    }
    return strip(updated);
  },
};

export const toApprovedOverlay = (revision: ScoreRevision) => ({
  revisionId: revision.revisionId,
  applicationKey: revision.applicationKey,
  evaluationFingerprint: revision.evaluationFingerprint,
  status: "approved" as const,
  correctedTotal: revision.corrected.total,
  correctedRecommendation: revision.corrected.recommendation,
  originalTotal: revision.original.total,
  originalRecommendation: revision.original.recommendation,
});
