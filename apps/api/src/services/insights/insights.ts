import { randomUUID } from "node:crypto";
import { z } from "zod";
import { env } from "../../config/env.js";
import { logger } from "../../lib/logger.js";
import { getGmailApplications } from "../gmail/gmailApplications.js";
import { evaluationsRepository } from "../gmail/jdRecovery/evaluations.repository.js";
import { loadApprovedOverlays } from "../scoring/scoreRevisions.service.js";
import { jobsRepository } from "../jobs/jobs.repository.js";
import { loadFeatureBudget, type FeatureBudget } from "../llm/featureBudget.js";
import { withLlmContext } from "../llm/llmUsage.js";
import { responsesClient } from "../llm/responsesClient.js";
import {
  analyzeInsights,
  GOOD_FIT,
  VERDICT_WORDS,
  type InsightsAnalysis,
  type ProposedAdjustment,
} from "./analyze.js";
import { buildInsightRows, type InsightRow } from "./dataset.js";
import {
  insightsRepository,
  type AdjustmentStatus,
  type InsightsRun,
  type ScoringAdjustment,
} from "./insights.repository.js";

/** Covers the whole Gmail history the app has synced. */
export const INSIGHTS_LOOKBACK_DAYS = 3650;
export const QUIET_GOOD_FITS_SHOWN = 12;
export const INSIGHTS_INTERVAL_DAYS = 7;
/** Conservative cost of one summary call (a page of aggregate numbers in, a paragraph out). */
export const EST_INSIGHTS_SUMMARY_USD = 0.003;

export type QuietGoodFit = { id: string; company: string; role: string | null; fit: number; appliedAt: string | null };

export type InsightsResult = InsightsAnalysis & { quietGoodFits: QuietGoodFit[] };

export type InsightsPanel = {
  run: InsightsRun | null;
  adjustments: ScoringAdjustment[];
  budget: { monthlyUsd: number; spentThisMonthUsd: number };
  running: boolean;
};

export class InsightsBusyError extends Error {
  constructor() {
    super("An insights run is already in progress");
  }
}

export class AdjustmentNotFoundError extends Error {
  constructor(id: string) {
    super(`Adjustment ${id} not found`);
  }
}

export class AdjustmentTransitionError extends Error {}

export const loadInsightRows = async (now = Date.now()): Promise<InsightRow[]> => {
  const [jobs, apps] = await Promise.all([jobsRepository.findAll(), getGmailApplications(INSIGHTS_LOOKBACK_DAYS)]);
  const evaluations = await evaluationsRepository.findByKeys(apps.map((a) => a.key));
  const revisions = await loadApprovedOverlays(apps.map((a) => a.key));
  return buildInsightRows({ jobs, apps, evaluations, revisions }, now);
};

export const quietGoodFits = (rows: InsightRow[]): QuietGoodFit[] =>
  rows
    .filter((r) => r.outcome === "negative" && r.fit != null && r.fit >= GOOD_FIT)
    .sort((a, b) => b.fit! - a.fit!)
    .slice(0, QUIET_GOOD_FITS_SHOWN)
    .map((r) => ({ id: r.id, company: r.company, role: r.role, fit: r.fit!, appliedAt: r.appliedAt }));

export const computeInsights = async (now = new Date()): Promise<InsightsResult> => {
  const rows = await loadInsightRows(now.getTime());
  return { ...analyzeInsights(rows, now), quietGoodFits: quietGoodFits(rows) };
};

/**
 * New proposals start as proposed. Ones you dismissed stay dismissed, and approved ones keep their
 * points (only the evidence refreshes). A proposal that later runs no longer support is withdrawn.
 */
export const syncAdjustments = (
  existing: ScoringAdjustment[],
  proposals: ProposedAdjustment[],
  nowIso: string,
): ScoringAdjustment[] => {
  const byId = new Map(existing.map((a) => [a.id, a]));
  const proposedIds = new Set(proposals.map((p) => p.id));
  const out: ScoringAdjustment[] = [];
  for (const p of proposals) {
    const prev = byId.get(p.id);
    if (!prev) out.push({ ...p, status: "proposed", createdAt: nowIso, updatedAt: nowIso });
    else if (prev.status === "proposed" || prev.status === "withdrawn") {
      out.push({ ...prev, ...p, status: "proposed", updatedAt: nowIso });
    } else out.push({ ...prev, evidence: p.evidence, updatedAt: nowIso });
  }
  for (const prev of existing) {
    if (prev.status === "proposed" && !proposedIds.has(prev.id)) {
      out.push({ ...prev, status: "withdrawn", updatedAt: nowIso });
    }
  }
  return out;
};

const SummarySchema = z.object({ summary: z.string().trim().min(1).max(900) });

const SUMMARY_SYSTEM_PROMPT = `You explain a job seeker's application statistics in plain English (<=110 words, second person, no bullet points).
The numbers were already tested for chance with a false-discovery correction. Only call a named pattern real if its verdict is "conclusive"; mention "worth watching" ones as tentative. Never call the whole analysis conclusive. Don't repeat verdict labels or statistics jargon (AUC, q) verbatim; say what they mean. If nothing is conclusive, say plainly that the differences look like randomness and that more applications or responses are needed. Mention coverage gaps (unscored or inferred applies) when they are large. If seniority or AI/FDE numbers are given, say what they show in one sentence and that small callback counts limit confidence. Never invent numbers, companies, or causes beyond those given.
Return JSON only: {"summary":"..."}`;

const unscoredLine = (reasons: InsightsAnalysis["counts"]["unscoredReasons"]): string => {
  const parts = Object.entries(reasons)
    .filter(([, n]) => (n ?? 0) > 0)
    .map(([reason, n]) => `${reason} ${n}`);
  return parts.length ? parts.join(", ") : "none";
};

export const buildSummaryPrompt = (r: InsightsAnalysis): string =>
  [
    `Decided applications: ${r.counts.decided}; human contact (screen or later): ${r.baseRate.k} (${(r.baseRate.rate * 100).toFixed(1)}%). Still too early: ${r.counts.tooEarly}.`,
    `Coverage: ${r.counts.withFit} scored, ${r.counts.withoutFit} without a score (${unscoredLine(r.counts.unscoredReasons)}); callbacks ${r.counts.scoredCallbacks} scored / ${r.counts.unscoredCallbacks} unscored; applied evidence ${r.counts.confirmedApplied} confirmed / ${r.counts.inferredApplied} inferred.`,
    `Fit score vs callbacks: ${r.scorePredicts.note} Named-test verdict: ${VERDICT_WORDS[r.scorePredicts.verdict]}.`,
    `By score tier: ${r.scoreBands.map((b) => `${b.band} ${b.k}/${b.n}`).join("; ")}.`,
    `Seniority (applied / callbacks): ${r.screening.seniority.map((s) => `${s.bucket} ${s.k}/${s.n}`).join("; ")}; unknown ${r.screening.seniorityUnknown}.`,
    `Degree: ${r.screening.degree.map((s) => `${s.bucket} ${s.k}/${s.n}`).join("; ")}; unknown ${r.screening.degreeUnknown}.`,
    `Specialized AI/FDE: ${r.screening.specialized.k}/${r.screening.specialized.n} vs rest ${r.screening.specialized.restK}/${r.screening.specialized.restN}; unknown ${r.screening.specializedUnknown}.`,
    `Good fits (score >= ${GOOD_FIT}): ${r.goodFit.k}/${r.goodFit.n} got human contact.`,
    "Strongest patterns:",
    ...r.patterns
      .slice(0, 6)
      .map(
        (p) =>
          `- ${p.featureLabel} = ${p.bucket}: ${p.k}/${p.n} vs rest ${p.restK}/${p.restN}, unknown ${p.unknownN}, q=${p.q.toFixed(2)}, verdict ${VERDICT_WORDS[p.verdict]}`,
      ),
    `Strongest named-test verdict: ${VERDICT_WORDS[r.conclusion]}. Do not call the whole analysis conclusive.`,
  ].join("\n");

export type InsightsDeps = {
  compute: (now: Date) => Promise<InsightsResult>;
  loadBudget: () => Promise<FeatureBudget>;
  summarize: (prompt: string) => Promise<string | null>;
  latestRun: () => Promise<InsightsRun | null>;
  saveRun: (run: InsightsRun) => Promise<void>;
  listAdjustments: () => Promise<ScoringAdjustment[]>;
  saveAdjustment: (a: ScoringAdjustment) => Promise<void>;
};

const loadInsightsBudget = () =>
  loadFeatureBudget({
    feature: "insights",
    monthlyUsd: env.insightsMonthlyBudgetUsd,
    maxUnits: 1,
    perUnitUsd: EST_INSIGHTS_SUMMARY_USD,
  });

const defaultDeps: InsightsDeps = {
  compute: computeInsights,
  loadBudget: loadInsightsBudget,
  summarize: async (userPrompt) => {
    const result = await withLlmContext({ feature: "insights" }, () =>
      responsesClient.runStructured({
        systemPrompt: SUMMARY_SYSTEM_PROMPT,
        userPrompt,
        schema: SummarySchema,
        fallback: () => ({ summary: "" }),
        reasoningEffort: "low",
      }),
    );
    return result.success && result.data.summary ? result.data.summary : null;
  },
  latestRun: () => insightsRepository.latestRun(),
  saveRun: (run) => insightsRepository.saveRun(run),
  listAdjustments: () => insightsRepository.listAdjustments(),
  saveAdjustment: (a) => insightsRepository.saveAdjustment(a),
};

let running = false;

export const runInsights = async (
  trigger: InsightsRun["trigger"],
  deps: InsightsDeps = defaultDeps,
  now = new Date(),
): Promise<InsightsRun> => {
  if (running) throw new InsightsBusyError();
  running = true;
  try {
    const result = await deps.compute(now);
    const budget = await deps.loadBudget();
    const summary = budget.allowedUnits > 0 ? await deps.summarize(buildSummaryPrompt(result)) : null;
    const run: InsightsRun = { ...result, id: randomUUID(), trigger, ...(summary ? { summary } : {}) };
    await deps.saveRun(run);
    for (const a of syncAdjustments(await deps.listAdjustments(), result.proposals, now.toISOString())) {
      await deps.saveAdjustment(a);
    }
    return run;
  } finally {
    running = false;
  }
};

/** Weekly pass, piggybacking on the Gmail sync scheduler. */
export const runInsightsIfDue = async (deps: InsightsDeps = defaultDeps, now = new Date()): Promise<void> => {
  const last = await deps.latestRun();
  const age = last ? now.getTime() - Date.parse(last.generatedAt) : Infinity;
  if (age < INSIGHTS_INTERVAL_DAYS * 86_400_000 || running) return;
  try {
    const run = await runInsights("weekly", deps, now);
    logger.info("Weekly insights run complete", { decided: run.counts.decided, conclusion: run.conclusion });
  } catch (error) {
    logger.warn("Weekly insights run failed", { message: error instanceof Error ? error.message : String(error) });
  }
};

export const getInsightsPanel = async (): Promise<InsightsPanel> => {
  const [run, adjustments, budget] = await Promise.all([
    insightsRepository.latestRun(),
    insightsRepository.listAdjustments(),
    loadInsightsBudget(),
  ]);
  return {
    run,
    adjustments: adjustments.filter((a) => a.status !== "withdrawn"),
    budget: { monthlyUsd: budget.monthlyUsd, spentThisMonthUsd: budget.spentThisMonthUsd },
    running,
  };
};

const TRANSITIONS: Record<"approve" | "dismiss" | "disable", { from: AdjustmentStatus[]; to: AdjustmentStatus }> = {
  approve: { from: ["proposed", "disabled"], to: "approved" },
  dismiss: { from: ["proposed"], to: "dismissed" },
  disable: { from: ["approved"], to: "disabled" },
};

export const transitionAdjustment = async (
  id: string,
  action: keyof typeof TRANSITIONS,
  now = new Date(),
): Promise<ScoringAdjustment> => {
  const current = await insightsRepository.getAdjustment(id);
  if (!current) throw new AdjustmentNotFoundError(id);
  const rule = TRANSITIONS[action];
  if (!rule.from.includes(current.status)) {
    throw new AdjustmentTransitionError(`Can't ${action} an adjustment that is ${current.status}`);
  }
  const nowIso = now.toISOString();
  const next: ScoringAdjustment = {
    ...current,
    status: rule.to,
    updatedAt: nowIso,
    ...(rule.to === "approved" ? { approvedAt: nowIso } : {}),
  };
  await insightsRepository.saveAdjustment(next);
  return next;
};
