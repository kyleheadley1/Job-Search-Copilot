import type { LlmFeature, LlmUsageRecord } from "../../llm/llmUsage.js";
import type { ApplicationEvaluation, RecoveryCandidate, RecoveryStage } from "./evaluations.repository.js";

export const SERPER_FREE_GRANT = 2500;

/**
 * Serper only runs when no company board was found, so a board posting on a row that used Serper
 * must have come from a Serper hit. Email-named vs guessed boards can't be told apart on old rows.
 */
export const inferCandidateStage = (
  e: Pick<ApplicationEvaluation, "recovery">,
  c: Pick<RecoveryCandidate, "source" | "stage">,
): RecoveryStage => {
  if (c.stage) return c.stage;
  if (c.source === "email_body" || c.source === "email_link") return "email";
  if (c.source === "serper") return "serper";
  if (c.source === "manual") return "manual";
  if (c.source === "prospect") return "prospect";
  return e.recovery.serperQueries > 0 ? "serper_board" : "guessed_board";
};

const stageOf = (e: ApplicationEvaluation): RecoveryStage | undefined => {
  if (e.recovery.foundVia) return e.recovery.foundVia;
  if (!e.recovery.source) return undefined;
  return inferCandidateStage(e, { source: e.recovery.source });
};

export type StageBucket = "email" | "company_board" | "serper" | "manual";

const BUCKET: Record<RecoveryStage, StageBucket> = {
  email: "email",
  email_board: "company_board",
  guessed_board: "company_board",
  serper_board: "serper",
  serper: "serper",
  manual: "manual",
  prospect: "manual",
};

export type RecoveryMetrics = {
  applications: number;
  /** Rows where some step produced a posting (scored, or a candidate waiting for a pick). */
  withUsefulData: number;
  verifiedAuto: number;
  userPicked: number;
  userPasted: number;
  needsPick: number;
  notFound: number;
  byBucket: Record<StageBucket, { verified: number; candidatesOnly: number }>;
  serper: {
    jobsSearched: number;
    jobsWithResults: number;
    verified: number;
    candidatesOnly: number;
    queriesUsed: number;
    budget: number;
    freeGrant: number;
  };
};

export const buildRecoveryMetrics = (
  evaluations: ApplicationEvaluation[],
  serperUsage: { queries: number; cap: number },
): RecoveryMetrics => {
  const byBucket: RecoveryMetrics["byBucket"] = {
    email: { verified: 0, candidatesOnly: 0 },
    company_board: { verified: 0, candidatesOnly: 0 },
    serper: { verified: 0, candidatesOnly: 0 },
    manual: { verified: 0, candidatesOnly: 0 },
  };
  const m: RecoveryMetrics = {
    applications: evaluations.length,
    withUsefulData: 0,
    verifiedAuto: 0,
    userPicked: 0,
    userPasted: 0,
    needsPick: 0,
    notFound: 0,
    byBucket,
    serper: {
      jobsSearched: 0,
      jobsWithResults: 0,
      verified: 0,
      candidatesOnly: 0,
      queriesUsed: serperUsage.queries,
      budget: serperUsage.cap,
      freeGrant: SERPER_FREE_GRANT,
    },
  };

  for (const e of evaluations) {
    const r = e.recovery;
    const stage = stageOf(e);
    const usedSerper = r.serperQueries > 0;
    if (usedSerper) {
      m.serper.jobsSearched += 1;
      if (!(r.notes ?? []).includes("serper_no_results")) m.serper.jobsWithResults += 1;
    }

    if (r.status === "scored") {
      m.withUsefulData += 1;
      if (r.verifiedBy === "user") {
        if (stage === "manual") m.userPasted += 1;
        else m.userPicked += 1;
      } else {
        m.verifiedAuto += 1;
      }
      if (stage) byBucket[BUCKET[stage]].verified += 1;
      if (stage && BUCKET[stage] === "serper") m.serper.verified += 1;
      continue;
    }

    if (r.status === "unverified" || (r.candidates?.length ?? 0) > 0) {
      m.withUsefulData += 1;
      m.needsPick += 1;
      const buckets = new Set(
        (r.candidates?.length ? r.candidates : stage ? [{ source: r.source!, stage }] : []).map(
          (c) => BUCKET[inferCandidateStage(e, c)],
        ),
      );
      for (const b of buckets) byBucket[b].candidatesOnly += 1;
      if (buckets.has("serper")) m.serper.candidatesOnly += 1;
      continue;
    }

    m.notFound += 1;
  }
  return m;
};

export type CostSummary = {
  model: string;
  /** First recorded call; costs before this were not tracked. */
  trackingSince: string | null;
  today: number;
  last7Days: number;
  windowDays: number;
  windowTotal: number;
  byFeature: Record<LlmFeature, { costUsd: number; calls: number }>;
  byDay: Array<{ day: string; costUsd: number }>;
  /** Mean OpenAI cost to score one role (JD extraction + scoring). */
  perScoredRole: number | null;
  perEmailClassified: number | null;
  thisMonth?: MonthSpend;
};

export type MonthSpend = {
  total: number;
  byFeature: Record<LlmFeature, number>;
  /** Hard monthly caps for features that have one. */
  budgets: Partial<Record<LlmFeature, number>>;
};

export const buildMonthSpend = (
  records: Pick<LlmUsageRecord, "feature" | "costUsd">[],
  budgets: MonthSpend["budgets"],
): MonthSpend => {
  const byFeature: MonthSpend["byFeature"] = {
    gmail_classify: 0,
    jd_recovery: 0,
    top_jobs: 0,
    agent: 0,
    assistant: 0,
    insights: 0,
    other: 0,
  };
  let total = 0;
  for (const r of records) {
    byFeature[r.feature] += r.costUsd;
    total += r.costUsd;
  }
  return { total, byFeature, budgets };
};

export const buildCostSummary = (
  records: LlmUsageRecord[],
  opts: { model: string; today: string; sevenDaysAgo: string; windowDays: number },
): CostSummary => {
  const byFeature: CostSummary["byFeature"] = {
    gmail_classify: { costUsd: 0, calls: 0 },
    jd_recovery: { costUsd: 0, calls: 0 },
    top_jobs: { costUsd: 0, calls: 0 },
    agent: { costUsd: 0, calls: 0 },
    assistant: { costUsd: 0, calls: 0 },
    insights: { costUsd: 0, calls: 0 },
    other: { costUsd: 0, calls: 0 },
  };
  const byDay = new Map<string, number>();
  const recoveryKeys = new Set<string>();
  let today = 0;
  let last7Days = 0;
  let windowTotal = 0;
  let first: string | null = null;
  for (const r of records) {
    windowTotal += r.costUsd;
    if (r.day === opts.today) today += r.costUsd;
    if (r.day >= opts.sevenDaysAgo) last7Days += r.costUsd;
    byFeature[r.feature].costUsd += r.costUsd;
    byFeature[r.feature].calls += 1;
    byDay.set(r.day, (byDay.get(r.day) ?? 0) + r.costUsd);
    if (r.feature === "jd_recovery" && r.key) recoveryKeys.add(r.key);
    if (!first || r.at < first) first = r.at;
  }
  const classify = byFeature.gmail_classify;
  return {
    model: opts.model,
    trackingSince: first,
    today,
    last7Days,
    windowDays: opts.windowDays,
    windowTotal,
    byFeature,
    byDay: [...byDay].sort(([a], [b]) => a.localeCompare(b)).map(([day, costUsd]) => ({ day, costUsd })),
    perScoredRole: recoveryKeys.size ? byFeature.jd_recovery.costUsd / recoveryKeys.size : null,
    perEmailClassified: classify.calls ? classify.costUsd / classify.calls : null,
  };
};
