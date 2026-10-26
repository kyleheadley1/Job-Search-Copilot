import { z } from "zod";
import { env } from "../../config/env.js";
import { userProfile } from "../../config/userProfile.js";
import { logger } from "../../lib/logger.js";
import { getGmailApplications, type GmailApplication } from "../gmail/gmailApplications.js";
import { gmailAuth } from "../gmail/gmailAuth.js";
import type { OutboxEntry, ReplyTarget } from "../gmail/replyDraft.js";
import { executeEmailDraft, executeTrackerStatus, replyTargetFor } from "../proposals/execute.js";
import { loadFeatureBudget, type FeatureBudget } from "../llm/featureBudget.js";
import { localDay, withLlmContext } from "../llm/llmUsage.js";
import { responsesClient, type StructuredCallResult } from "../llm/responsesClient.js";
import { gatherCandidates, type AgentCandidate } from "./candidates.js";
import { syncTrackerFromGmailQuietly } from "../gmail/trackerAutoLapse.js";
import {
  suggestionsRepository,
  type AgentRunSummary,
  type AgentSuggestion,
} from "./suggestions.repository.js";

/** Covers 30-day ghosting checks plus the email history behind them. */
export const AGENT_LOOKBACK_DAYS = 120;
/** One run is a single call over at most this many new candidates, so cost stays flat. */
export const MAX_AGENT_CANDIDATES = 12;
/** Conservative cost of one agent call (compact facts in, a few short drafts out). */
export const EST_AGENT_RUN_USD = 0.02;
/** The daily pass waits for the morning so overnight email is included. */
export const AGENT_DAILY_HOUR = 7;

const AgentOutputSchema = z.object({
  items: z.array(
    z.object({
      i: z.number().int(),
      priority: z.number().int().min(1).max(5),
      reason: z.string().trim().min(1).max(240),
      draft: z.string().trim().max(1200).nullable().optional(),
    }),
  ),
});
type AgentOutput = z.infer<typeof AgentOutputSchema>;

const SYSTEM_PROMPT = `You are a job-search assistant reviewing a candidate's open next steps. Each item was found by rules from their tracker and Gmail; you see only short facts.

For every item return:
- priority 1-5 (5 = do today: deadlines, interviews within a day; 1 = housekeeping)
- reason: one sentence, <=25 words, why it matters now and what exactly to do. Never say how long until something ("in 41 hours", "tomorrow", "in 3 days"): the app shows the date and a live countdown next to it.
- draft: only when the item says draftable=yes. A short, warm, specific email (<=110 words) the candidate can send as-is: no subject line, no placeholders like [Name] except the recipient greeting "Hi there," when no name is known, signed "Best,". Never invent facts, names, or dates beyond those given.

Return JSON only: {"items":[{"i":<number>,"priority":<1-5>,"reason":"...","draft":"..." | null}]}`;

export type AgentDeps = {
  loadApps: () => Promise<GmailApplication[]>;
  loadBudget: () => Promise<FeatureBudget>;
  run: (userPrompt: string) => Promise<StructuredCallResult<AgentOutput>>;
  byIds: typeof suggestionsRepository.byIds;
  save: typeof suggestionsRepository.save;
  expireMissing: typeof suggestionsRepository.expireMissing;
  recordRun: typeof suggestionsRepository.recordRun;
};

const defaultDeps: AgentDeps = {
  loadApps: async () => {
    await syncTrackerFromGmailQuietly();
    return getGmailApplications(AGENT_LOOKBACK_DAYS);
  },
  loadBudget: () =>
    loadFeatureBudget({
      feature: "agent",
      monthlyUsd: env.agentMonthlyBudgetUsd,
      maxUnits: 1,
      perUnitUsd: EST_AGENT_RUN_USD,
    }),
  run: (userPrompt) =>
    withLlmContext({ feature: "agent" }, () =>
      responsesClient.runStructured({
        systemPrompt: SYSTEM_PROMPT,
        userPrompt,
        schema: AgentOutputSchema,
        fallback: () => ({ items: [] }),
        reasoningEffort: "low",
      }),
    ),
  byIds: (ids) => suggestionsRepository.byIds(ids),
  save: (s) => suggestionsRepository.save(s),
  expireMissing: (ids, now) => suggestionsRepository.expireMissing(ids, now),
  recordRun: (day, summary) => suggestionsRepository.recordRun(day, summary),
};

const fromRules = (c: AgentCandidate, nowIso: string): AgentSuggestion => {
  const { facts, ...rest } = c;
  return { ...rest, reason: facts, writtenBy: "rules", status: "open", createdAt: nowIso, updatedAt: nowIso };
};

export const buildAgentPrompt = (items: AgentCandidate[]): string =>
  [
    `Candidate: ${userProfile.headline}`,
    "",
    "Items:",
    ...items.map(
      (c, i) =>
        `${i + 1}. [${c.kind}] ${c.title} | facts: ${c.facts} | draftable=${c.draftable ? "yes" : "no"}`,
    ),
  ].join("\n");

/**
 * Free rules find the next steps; one budgeted call ranks, explains, and drafts the new ones.
 * Drafting is automatic (nothing is sent). Tracker changes other than auto-lapse / Gmail
 * un-lapse wait for your approval. Steps you dismissed or finished never come back, and
 * steps already written are not paid for twice.
 */
export const runDailyAgent = async (deps: AgentDeps = defaultDeps, now = new Date()): Promise<AgentRunSummary> => {
  const nowIso = now.toISOString();
  const candidates = gatherCandidates(await deps.loadApps(), now.getTime());
  const existing = await deps.byIds(candidates.map((c) => c.id));
  const live = candidates.filter((c) => {
    const prev = existing.get(c.id);
    return !prev || prev.status === "open";
  });
  const today = localDay(now);
  const isNew = (c: AgentCandidate) => existing.get(c.id)?.writtenBy !== "agent";
  const isStale = (c: AgentCandidate) => {
    const prev = existing.get(c.id);
    return prev?.writtenBy === "agent" && localDay(new Date(prev.updatedAt)) !== today;
  };
  const fresh = [...live.filter(isNew), ...live.filter(isStale)];

  const budget = fresh.length > 0 ? await deps.loadBudget() : null;
  const toWrite = budget && budget.allowedUnits > 0 ? fresh.slice(0, MAX_AGENT_CANDIDATES) : [];
  const written = new Map<string, AgentOutput["items"][number]>();
  if (toWrite.length > 0) {
    const result = await deps.run(buildAgentPrompt(toWrite));
    if (result.success) {
      for (const item of result.data.items) {
        const c = toWrite[item.i - 1];
        if (c) written.set(c.id, item);
      }
    }
  }

  for (const c of live) {
    const prev = existing.get(c.id);
    const item = written.get(c.id);
    if (prev?.writtenBy === "agent" && !item) continue;
    const base = fromRules(c, prev?.createdAt ?? nowIso);
    const draft = c.draftable ? (item?.draft ?? prev?.draft) : undefined;
    await deps.save(
      item
        ? {
            ...base,
            priority: item.priority,
            reason: item.reason,
            ...(draft ? { draft } : {}),
            writtenBy: "agent",
            updatedAt: nowIso,
          }
        : { ...base, updatedAt: nowIso },
    );
  }
  await deps.expireMissing(
    live.map((c) => c.id),
    nowIso,
  );

  const summary: AgentRunSummary = {
    at: nowIso,
    candidates: live.length,
    written: written.size,
    budgetLimited: fresh.length > 0 && toWrite.length === 0,
  };
  await deps.recordRun(localDay(now), summary);
  return summary;
};

let running = false;

/** Called after each scheduled Gmail sync; does the day's pass once, after the morning hour. */
export const runDailyAgentIfDue = async (now = new Date()): Promise<void> => {
  if (!env.agentEnabled || running || now.getHours() < AGENT_DAILY_HOUR) return;
  const meta = await suggestionsRepository.getMeta();
  if (meta.lastRunDay === localDay(now)) return;
  running = true;
  try {
    const summary = await runDailyAgent(defaultDeps, now);
    logger.info("Daily agent pass complete", summary);
  } catch (error) {
    logger.warn("Daily agent pass failed", { message: error instanceof Error ? error.message : String(error) });
  } finally {
    running = false;
  }
};

export class SuggestionNotFoundError extends Error {}

/** Approving a tracker change applies it; approving anything else just marks it done. */
export const approveSuggestion = async (id: string, now = new Date()): Promise<AgentSuggestion> => {
  const s = await suggestionsRepository.get(id);
  if (!s || s.status !== "open") throw new SuggestionNotFoundError(`No open suggestion ${id}`);
  if (s.proposedChange) {
    await executeTrackerStatus(s.proposedChange.jobId, s.proposedChange.status, "Approved from Next steps");
  }
  const status = s.proposedChange ? "approved" : "done";
  await suggestionsRepository.resolve(id, status, now.toISOString());
  return { ...s, status };
};

const openDraftable = async (id: string): Promise<AgentSuggestion> => {
  const s = await suggestionsRepository.get(id);
  if (!s || s.status !== "open" || !s.draftable) throw new SuggestionNotFoundError(`No open draftable step ${id}`);
  return s;
};

/** Who the draft would go to and in which thread, for the editor shown before you approve. */
export const suggestionReplyTarget = async (id: string): Promise<ReplyTarget> => {
  const s = await openDraftable(id);
  return replyTargetFor(s.appKey, s.replyEmailId);
};

/** Approve = create a Gmail draft with the recipient and text you confirmed; the step is then done. */
export const draftSuggestion = async (
  id: string,
  approved: { to: string; body: string },
  now = new Date(),
): Promise<OutboxEntry> => {
  const s = await openDraftable(id);
  const entry = await executeEmailDraft({
    appKey: s.appKey,
    preferEmailId: s.replyEmailId,
    to: approved.to,
    body: approved.body,
    source: "next_steps",
    sourceId: s.id,
    kind: s.kind,
  });
  await suggestionsRepository.resolve(id, "done", now.toISOString());
  return entry;
};

export const dismissSuggestion = async (id: string, now = new Date()): Promise<void> => {
  const s = await suggestionsRepository.get(id);
  if (!s || s.status !== "open") throw new SuggestionNotFoundError(`No open suggestion ${id}`);
  await suggestionsRepository.resolve(id, "dismissed", now.toISOString());
};

export const getAgentPanel = async () => {
  const [suggestions, meta, budget, gmail] = await Promise.all([
    suggestionsRepository.listOpen(),
    suggestionsRepository.getMeta(),
    defaultDeps.loadBudget(),
    gmailAuth.getStatus(),
  ]);
  return {
    enabled: env.agentEnabled,
    canCreateDrafts: gmail.canCreateDrafts,
    suggestions,
    lastRun: meta.lastRun ?? null,
    budget: { monthlyUsd: budget.monthlyUsd, spentThisMonthUsd: budget.spentThisMonthUsd },
  };
};

export class AgentBusyError extends Error {}

/** "Refresh" on the dashboard: same budgeted pass, any time of day. */
export const runAgentNow = async (): Promise<AgentRunSummary> => {
  if (running) throw new AgentBusyError("Agent pass already running");
  running = true;
  try {
    return await runDailyAgent();
  } finally {
    running = false;
  }
};
