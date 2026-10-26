import { getDb } from "../../config/mongo.js";
import type { AgentCandidate } from "./candidates.js";

export type SuggestionStatus = "open" | "approved" | "done" | "dismissed" | "expired";

export type AgentSuggestion = Omit<AgentCandidate, "facts"> & {
  /** Why this matters now: the agent's explanation, or the rule facts when it didn't run. */
  reason: string;
  /** Short email draft you can copy; never sent automatically. */
  draft?: string;
  writtenBy: "agent" | "rules";
  status: SuggestionStatus;
  createdAt: string;
  updatedAt: string;
  resolvedAt?: string;
};

type Doc = Omit<AgentSuggestion, "id"> & { _id: string };

export type AgentRunSummary = {
  at: string;
  candidates: number;
  /** Suggestions the agent explained or drafted this run (0 when it fell back to rules). */
  written: number;
  budgetLimited: boolean;
};

type MetaDoc = { _id: "meta"; lastRunDay?: string; lastRun?: AgentRunSummary };

const fromDoc = ({ _id, ...rest }: Doc): AgentSuggestion => ({ id: _id, ...rest });

export const suggestionsRepository = {
  async col() {
    const db = await getDb();
    return db.collection<Doc>("agent_suggestions");
  },

  async meta() {
    const db = await getDb();
    return db.collection<MetaDoc>("agent_meta");
  },

  async byIds(ids: string[]): Promise<Map<string, AgentSuggestion>> {
    if (ids.length === 0) return new Map();
    const docs = await (await this.col()).find({ _id: { $in: ids } }).toArray();
    return new Map(docs.map((d) => [d._id, fromDoc(d)]));
  },

  async listOpen(): Promise<AgentSuggestion[]> {
    const docs = await (await this.col()).find({ status: "open" }).toArray();
    return docs
      .map(fromDoc)
      .sort((a, b) => b.priority - a.priority || (a.dueAt ?? "9999").localeCompare(b.dueAt ?? "9999"));
  },

  async get(id: string): Promise<AgentSuggestion | null> {
    const doc = await (await this.col()).findOne({ _id: id });
    return doc ? fromDoc(doc) : null;
  },

  async save(s: AgentSuggestion): Promise<void> {
    const { id, ...rest } = s;
    await (await this.col()).replaceOne({ _id: id }, rest, { upsert: true });
  },

  /** Drop leftover Next steps cards of one kind (e.g. auto-lapsed ghosted rows). */
  async expireOpenKind(kind: AgentCandidate["kind"], now: string): Promise<number> {
    const res = await (await this.col()).updateMany(
      { status: "open", kind },
      { $set: { status: "expired", updatedAt: now, resolvedAt: now } },
    );
    return res.modifiedCount;
  },

  /** Open suggestions whose situation no longer holds (you replied, the interview passed) drop off. */
  async expireMissing(activeIds: string[], now: string): Promise<number> {
    const res = await (await this.col()).updateMany(
      { status: "open", _id: { $nin: activeIds } },
      { $set: { status: "expired", updatedAt: now, resolvedAt: now } },
    );
    return res.modifiedCount;
  },

  async resolve(id: string, status: Exclude<SuggestionStatus, "open" | "expired">, now: string): Promise<void> {
    await (await this.col()).updateOne({ _id: id }, { $set: { status, updatedAt: now, resolvedAt: now } });
  },

  async getMeta(): Promise<MetaDoc> {
    return (await (await this.meta()).findOne({ _id: "meta" })) ?? { _id: "meta" };
  },

  async recordRun(day: string, summary: AgentRunSummary): Promise<void> {
    await (await this.meta()).updateOne(
      { _id: "meta" },
      { $set: { lastRunDay: day, lastRun: summary } },
      { upsert: true },
    );
  },
};
