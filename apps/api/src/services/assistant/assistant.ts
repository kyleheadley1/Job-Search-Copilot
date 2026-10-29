import { randomUUID } from "node:crypto";
import { env } from "../../config/env.js";
import { userProfile } from "../../config/userProfile.js";
import { suggestionsRepository } from "../agent/suggestions.repository.js";
import { getGmailApplications } from "../gmail/gmailApplications.js";
import { gmailAuth } from "../gmail/gmailAuth.js";
import { evaluationsRepository } from "../gmail/jdRecovery/evaluations.repository.js";
import { buildMonthSpend } from "../gmail/jdRecovery/recoveryMetrics.js";
import type { ReplyTarget } from "../gmail/replyDraft.js";
import { jobsRepository } from "../jobs/jobs.repository.js";
import { overlayJobWithEffectiveScore, overlayJobsWithEffectiveScores } from "../scoring/trackerEffectiveScore.js";
import { loadFeatureBudget, monthStartDay, type FeatureBudget } from "../llm/featureBudget.js";
import { llmUsageRepository, withLlmContext } from "../llm/llmUsage.js";
import { runWithTools, type ToolLoopResult } from "../llm/responsesClient.js";
import { executeEmailDraft, executeTrackerStatus, replyTargetFor } from "../proposals/execute.js";
import { alertListingsRepository } from "../topJobs/alertListings.repository.js";
import { topJobsRepository } from "../topJobs/topJobs.repository.js";
import { listingWindowStart, prioritizePending, scoreListingNow } from "../topJobs/topJobsSync.js";
import {
  assistantRepository,
  type AssistantMessage,
  type AssistantProposal,
} from "./assistant.repository.js";
import { buildAssistantTools, type AssistantToolDeps } from "./tools.js";

/** Only the latest turns are sent; older ones stay visible in the panel but cost nothing. */
export const HISTORY_MESSAGES = 12;
export const MAX_TOOL_STEPS = 6;
/** Conservative cost of one answered message (a few lookups at low reasoning effort). */
export const EST_ASSISTANT_TURN_USD = 0.01;
/** Even with budget left, a day can't exceed this many messages. */
export const MAX_MESSAGES_PER_DAY = 40;
const MAX_MESSAGE_CHARS = 2000;
const APP_LOOKBACK_DAYS = 120;

const systemPrompt = (now: Date) => `You are the assistant inside the user's personal job-search app. Today is ${now.toDateString()}.
The user: ${userProfile.headline}

Answer from the user's own data using the lookup tools; never guess names, dates, or statuses you haven't looked up. Be brief and concrete: short paragraphs or bullets, no filler.

You cannot change anything yourself. To change a tracker status, draft an email, or score a Top Jobs listing, call the matching propose_* tool. That only creates a card the user approves or dismisses. Say "I've put a card below for you to approve", never "done" or "sent". Emails become Gmail drafts the user sends themselves; the app can never send mail.

Email drafts: warm, specific, under 120 words, no subject line, no invented facts, no placeholders except "Hi there," when no name is known, signed "Best,".`;

export type AssistantDeps = {
  tools: AssistantToolDeps;
  loadBudget: () => Promise<FeatureBudget>;
  getMessages: () => Promise<AssistantMessage[]>;
  appendMessages: (m: AssistantMessage[]) => Promise<void>;
  runLoop: (input: Parameters<typeof runWithTools>[0]) => Promise<ToolLoopResult>;
};

const loadApps = () => getGmailApplications(APP_LOOKBACK_DAYS);

const loadBudget = () =>
  loadFeatureBudget({
    feature: "assistant",
    monthlyUsd: env.assistantMonthlyBudgetUsd,
    maxUnits: MAX_MESSAGES_PER_DAY,
    perUnitUsd: EST_ASSISTANT_TURN_USD,
  });

export const defaultAssistantDeps: AssistantDeps = {
  tools: {
    loadApps,
    getEvaluation: (key) => evaluationsRepository.findByKey(key),
    listTracker: async () => overlayJobsWithEffectiveScores(await jobsRepository.findAll()),
    getJob: async (id) => overlayJobWithEffectiveScore(await jobsRepository.getById(id)),
    listTopJobs: () => topJobsRepository.list(),
    listQueue: async () => prioritizePending(await alertListingsRepository.listPending(listingWindowStart())),
    getListing: (key) => alertListingsRepository.get(key),
    listNextSteps: () => suggestionsRepository.listOpen(),
    monthSpend: async () =>
      buildMonthSpend(await llmUsageRepository.listSinceDay(monthStartDay(new Date())), {
        top_jobs: env.topJobsMonthlyBudgetUsd,
        agent: env.agentMonthlyBudgetUsd,
        assistant: env.assistantMonthlyBudgetUsd,
      }),
    saveProposal: (p) => assistantRepository.saveProposal(p),
  },
  loadBudget,
  getMessages: () => assistantRepository.getMessages(),
  appendMessages: (m) => assistantRepository.appendMessages(m),
  runLoop: (input) => withLlmContext({ feature: "assistant" }, () => runWithTools(input)),
};

export class AssistantBusyError extends Error {}
export class ProposalNotFoundError extends Error {}

let busy = false;

export type AssistantReply = { messages: AssistantMessage[]; proposals: AssistantProposal[] };

/** One user message → at most MAX_TOOL_STEPS paid calls. Refuses (free) once today's budget is used. */
export const sendAssistantMessage = async (
  text: string,
  deps: AssistantDeps = defaultAssistantDeps,
  now = new Date(),
): Promise<AssistantReply> => {
  const content = text.trim().slice(0, MAX_MESSAGE_CHARS);
  if (!content) throw new Error("Empty message");
  if (busy) throw new AssistantBusyError("Still answering the previous message");
  busy = true;
  try {
    const userMessage: AssistantMessage = { id: randomUUID(), role: "user", content, at: now.toISOString() };
    const reply = (body: string, extra: Partial<AssistantMessage> = {}): AssistantMessage => ({
      id: randomUUID(),
      role: "assistant",
      content: body,
      at: new Date().toISOString(),
      ...extra,
    });

    const budget = await deps.loadBudget();
    if (budget.allowedUnits <= 0) {
      const answer = reply(
        budget.exhausted
          ? `This month's assistant budget ($${budget.monthlyUsd.toFixed(2)}) is used up. It resets on the 1st.`
          : "Today's share of the assistant budget is used up; ask again tomorrow.",
      );
      await deps.appendMessages([userMessage, answer]);
      return { messages: [userMessage, answer], proposals: [] };
    }

    const history = (await deps.getMessages()).slice(-HISTORY_MESSAGES).map((m) => ({ role: m.role, content: m.content }));
    const created: AssistantProposal[] = [];
    const result = await deps.runLoop({
      systemPrompt: systemPrompt(now),
      messages: [...history, { role: "user", content }],
      tools: buildAssistantTools(deps.tools, created),
      maxSteps: MAX_TOOL_STEPS,
      reasoningEffort: "low",
    });

    const body = result.success && result.text.trim()
      ? result.text.trim()
      : `Sorry, I couldn't answer that${result.error ? ` (${result.error})` : ""}.`;
    const answer = reply(body, {
      ...(created.length ? { proposalIds: created.map((p) => p.id) } : {}),
      ...(result.toolCalls.length ? { tools: [...new Set(result.toolCalls.map((c) => c.name))] } : {}),
    });
    await deps.appendMessages([userMessage, answer]);
    return { messages: [userMessage, answer], proposals: created };
  } finally {
    busy = false;
  }
};

export const getAssistantThread = async () => {
  const [messages, budget, gmail] = await Promise.all([
    assistantRepository.getMessages(),
    loadBudget(),
    gmailAuth.getStatus(),
  ]);
  const proposals = await assistantRepository.proposalsByIds(messages.flatMap((m) => m.proposalIds ?? []));
  return {
    messages,
    proposals,
    canCreateDrafts: gmail.canCreateDrafts,
    budget: { monthlyUsd: budget.monthlyUsd, spentThisMonthUsd: budget.spentThisMonthUsd },
  };
};

const openProposal = async (id: string, kind?: AssistantProposal["payload"]["kind"]) => {
  const p = await assistantRepository.getProposal(id);
  if (!p || p.status !== "open" || (kind && p.payload.kind !== kind)) {
    throw new ProposalNotFoundError(`No open proposal ${id}`);
  }
  return p;
};

export const proposalReplyTarget = async (id: string): Promise<ReplyTarget> => {
  const p = await openProposal(id, "email_draft");
  if (p.payload.kind !== "email_draft") throw new ProposalNotFoundError(id);
  return replyTargetFor(p.payload.appKey, p.payload.preferEmailId);
};

/**
 * Runs exactly the stored proposal. For emails, `email` is the recipient and text you confirmed in
 * the editor; it becomes a Gmail draft in the application's thread, never a sent message.
 */
export const approveProposal = async (
  id: string,
  email?: { to: string; body: string },
  now = new Date(),
): Promise<AssistantProposal> => {
  const p = await openProposal(id);
  const at = now.toISOString();
  let result: string;
  const payload = p.payload;
  if (payload.kind === "tracker_status") {
    await executeTrackerStatus(payload.jobId, payload.status, payload.note);
    result = `Status set to ${payload.status}`;
  } else if (payload.kind === "email_draft") {
    if (!email) throw new Error("Recipient and text are required to create the draft");
    const entry = await executeEmailDraft({
      appKey: payload.appKey,
      preferEmailId: payload.preferEmailId,
      to: email.to,
      body: email.body,
      source: "assistant",
      sourceId: p.id,
      kind: payload.emailKind,
    });
    result = `Draft saved to ${entry.to}`;
  } else {
    const outcome = await scoreListingNow(payload.listingKey);
    result =
      outcome.status === "stored"
        ? "Scored and added to Top Jobs"
        : `Not added: ${outcome.status}${outcome.reason ? ` (${outcome.reason})` : ""}`;
  }
  await assistantRepository.resolveProposal(id, "approved", at, result);
  return { ...p, status: "approved", resolvedAt: at, result };
};

export const dismissProposal = async (id: string, now = new Date()): Promise<void> => {
  await openProposal(id);
  await assistantRepository.resolveProposal(id, "dismissed", now.toISOString());
};

export const clearAssistantThread = () => assistantRepository.clear();
