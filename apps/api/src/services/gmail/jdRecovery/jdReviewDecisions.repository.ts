import { getDb } from "../../../config/mongo.js";
import type { JdReviewDecision, JdShadowReport } from "./jdReviewDecisions.types.js";

type Doc = JdReviewDecision & { _id: string };

const strip = ({ _id, ...rest }: Doc): JdReviewDecision => rest;

let indexesEnsured = false;

export const JD_REVIEW_DECISIONS_COLLECTION = "jd_review_decisions";

const SHADOW_SAMPLE_LIMITATION =
  "Shadow-mode counts are descriptive only. Do not treat a small sample as reliable precision or as authority to enable auto-confirmation.";

export const jdReviewDecisionsRepository = {
  async collection() {
    const db = await getDb();
    const col = db.collection<Doc>(JD_REVIEW_DECISIONS_COLLECTION);
    if (!indexesEnsured) {
      indexesEnsured = true;
      await Promise.all([
        col.createIndex({ applicationKey: 1, decidedAt: -1 }),
        col.createIndex({ decidedAt: -1 }),
      ]).catch(() => {
        indexesEnsured = false;
      });
    }
    return col;
  },

  async insert(decision: JdReviewDecision): Promise<void> {
    const col = await this.collection();
    await col.insertOne({ ...decision, _id: decision.decisionId });
  },

  async listRecent(limit = 200): Promise<JdReviewDecision[]> {
    const col = await this.collection();
    const docs = await col.find({}).sort({ decidedAt: -1 }).limit(limit).toArray();
    return docs.map(strip);
  },

  async listByApplicationKey(applicationKey: string): Promise<JdReviewDecision[]> {
    const col = await this.collection();
    const docs = await col.find({ applicationKey }).sort({ decidedAt: -1 }).toArray();
    return docs.map(strip);
  },
};

export const summarizeShadowDecisions = (decisions: JdReviewDecision[]): JdShadowReport => {
  const matching = decisions.filter((row) => row.action !== "removed" && row.action !== "restored");
  const eligible = matching.filter((row) => row.shadowAtDecision.recommendation === "eligible_for_auto_confirmation");
  const eligibleConfirmed = eligible.filter((row) => row.action === "confirmed").length;
  const eligibleRejectedOrCorrected = eligible.filter((row) => row.action !== "confirmed").length;
  const falseNegatives = matching.filter(
    (row) =>
      row.action === "confirmed" && row.shadowAtDecision.recommendation !== "eligible_for_auto_confirmation",
  ).length;
  const reasons = new Map<string, number>();
  for (const row of matching) {
    const proposed = row.shadowAtDecision.recommendation;
    const agreed =
      (proposed === "eligible_for_auto_confirmation" && row.action === "confirmed") ||
      (proposed === "reject_mismatch" && row.action === "rejected") ||
      (proposed === "manual_review" && row.action !== "confirmed" && row.action !== "rejected");
    if (agreed) continue;
    const reason = `${proposed}→${row.action}`;
    reasons.set(reason, (reasons.get(reason) ?? 0) + 1);
  }
  return {
    shadowMode: true,
    autoConfirmEnabled: false,
    reviewed: matching.length,
    shadowEligible: eligible.length,
    eligibleConfirmed,
    eligibleRejectedOrCorrected,
    falsePositives: eligibleRejectedOrCorrected,
    falseNegatives,
    disagreementReasons: [...reasons.entries()]
      .map(([reason, count]) => ({ reason, count }))
      .sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason)),
    limitation: SHADOW_SAMPLE_LIMITATION,
  };
};
