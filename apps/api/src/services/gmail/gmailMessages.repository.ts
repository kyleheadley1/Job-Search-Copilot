import { getDb } from "../../config/mongo.js";
import type { ActionRequest } from "./actionRequest.js";
import type { EmailClassification } from "./gmailClassifier.js";
import type { InterviewDetail } from "./interviewRounds.js";

/** Per-message classification cache. Full email bodies are never stored. */
export type StoredGmailMessage = {
  id: string;
  threadId: string;
  date: string;
  from: string;
  subject: string;
  /** Hiring-platform tenant id when known (workday:evolent, ashby:uuid, …). */
  platformAccount?: string;
  prefilterPassed: boolean;
  prefilterReason: string;
  prefilterVersion?: number;
  /** Set only when the message went through the LLM. */
  classification?: EmailClassification;
  /** False when the LLM call failed; such messages are retried on the next sync. */
  llmSucceeded?: boolean;
  processedAt: string;
  /** When the candidate replied in this thread after an action request. */
  actionRepliedAt?: string;
  /** When the candidate marked the action request done by hand. */
  actionDismissedAt?: string;
};

type Doc = StoredGmailMessage & { _id: string };

export const gmailMessagesRepository = {
  async collection() {
    const db = await getDb();
    return db.collection<Doc>("gmail_messages");
  },

  /**
   * Ids already processed successfully. LLM failures are excluded so they get retried, and so are
   * messages dropped by an older prefilter version.
   */
  async findProcessedIds(ids: string[], prefilterVersion = 1): Promise<Set<string>> {
    if (ids.length === 0) return new Set();
    const col = await this.collection();
    const docs = await col
      .find(
        {
          _id: { $in: ids },
          llmSucceeded: { $ne: false },
          $nor: [
            {
              prefilterPassed: false,
              $or: [{ prefilterVersion: { $exists: false } }, { prefilterVersion: { $lt: prefilterVersion } }],
            },
          ],
        },
        { projection: { _id: 1 } },
      )
      .toArray();
    return new Set(docs.map((d) => d._id));
  },

  async upsert(message: StoredGmailMessage): Promise<void> {
    const col = await this.collection();
    await col.replaceOne({ _id: message.id }, message, { upsert: true });
  },

  /** Interview emails with no round details, or details from an older extraction version. Newest first. */
  async listInterviewIdsMissingDetail(limit: number, version: number): Promise<string[]> {
    const col = await this.collection();
    const docs = await col
      .find(
        {
          "classification.isApplicationEmail": true,
          "classification.eventType": "interview",
          "classification.interview.version": { $ne: version },
        },
        { projection: { _id: 1 } },
      )
      .sort({ date: -1 })
      .limit(limit)
      .toArray();
    return docs.map((d) => d._id);
  },

  async setInterviewDetail(id: string, detail: InterviewDetail): Promise<void> {
    const col = await this.collection();
    await col.updateOne({ _id: id }, { $set: { "classification.interview": detail } });
  },

  /** Recent application emails of the given types not yet checked for an action request (or checked by an older version). */
  async listIdsMissingAction(sinceIso: string, eventTypes: string[], version: number, limit: number): Promise<string[]> {
    const col = await this.collection();
    const docs = await col
      .find(
        {
          date: { $gte: sinceIso },
          "classification.isApplicationEmail": true,
          "classification.eventType": { $in: eventTypes },
          "classification.action.version": { $ne: version },
        },
        { projection: { _id: 1 } },
      )
      .sort({ date: -1 })
      .limit(limit)
      .toArray();
    return docs.map((d) => d._id);
  },

  async setAction(id: string, action: ActionRequest): Promise<void> {
    const col = await this.collection();
    await col.updateOne({ _id: id }, { $set: { "classification.action": action } });
  },

  /** Recent action requests the candidate hasn't replied to or dismissed. */
  async listOpenActionMessages(sinceIso: string): Promise<Array<Pick<StoredGmailMessage, "id" | "threadId" | "date">>> {
    const col = await this.collection();
    const docs = await col
      .find(
        {
          date: { $gte: sinceIso },
          "classification.action.needed": true,
          actionRepliedAt: { $exists: false },
          actionDismissedAt: { $exists: false },
        },
        { projection: { _id: 1, threadId: 1, date: 1 } },
      )
      .toArray();
    return docs.map((d) => ({ id: d._id, threadId: d.threadId, date: d.date }));
  },

  async setActionReplied(id: string, at: string): Promise<void> {
    const col = await this.collection();
    await col.updateOne({ _id: id }, { $set: { actionRepliedAt: at } });
  },

  /** Returns false when no such message exists. */
  async dismissAction(id: string): Promise<boolean> {
    const col = await this.collection();
    const result = await col.updateOne({ _id: id }, { $set: { actionDismissedAt: new Date().toISOString() } });
    return result.matchedCount > 0;
  },

  async listApplicationMessagesSince(sinceIso: string): Promise<StoredGmailMessage[]> {
    const col = await this.collection();
    const docs = await col
      .find({ date: { $gte: sinceIso }, "classification.isApplicationEmail": true })
      .sort({ date: 1 })
      .toArray();
    return docs.map(({ _id, ...rest }) => ({ ...rest, id: rest.id ?? _id }));
  },

  /**
   * Recent human-looking mail for a company (classified or not). Used to prefer confirmation
   * threads over calendar invites when drafting thank-yous / follow-ups.
   */
  async listPersonMessagesForCompany(companyKey: string, limit = 40): Promise<StoredGmailMessage[]> {
    if (!companyKey) return [];
    const col = await this.collection();
    const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(escape(companyKey), "i");
    const docs = await col
      .find({
        $or: [{ "classification.company": re }, { subject: re }, { from: re }],
      })
      .sort({ date: -1 })
      .limit(limit)
      .toArray();
    return docs.map(({ _id, ...rest }) => ({ ...rest, id: rest.id ?? _id }));
  },

  /** Assign a role onto a stored classification (used when confirmations omitted the title). */
  async setClassificationRole(id: string, role: string): Promise<void> {
    const col = await this.collection();
    await col.updateOne(
      { _id: id, "classification.isApplicationEmail": true },
      { $set: { "classification.role": role.trim(), processedAt: new Date().toISOString() } },
    );
  },

  /** Drop a stored message from application grouping (e.g. Greenhouse security-code mail). */
  async setNotApplicationEmail(id: string, reason: string): Promise<void> {
    const col = await this.collection();
    await col.updateOne(
      { _id: id },
      {
        $set: {
          "classification.isApplicationEmail": false,
          "classification.eventType": "other",
          prefilterReason: reason,
          processedAt: new Date().toISOString(),
        },
      },
    );
  },
};
