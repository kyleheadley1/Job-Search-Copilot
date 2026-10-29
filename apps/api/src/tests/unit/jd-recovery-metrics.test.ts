import { describe, expect, it } from "vitest";
import type { LlmUsageRecord } from "../../services/llm/llmUsage.js";
import type { ApplicationEvaluation } from "../../services/gmail/jdRecovery/evaluations.repository.js";
import { buildCostSummary, buildRecoveryMetrics } from "../../services/gmail/jdRecovery/recoveryMetrics.js";

const ev = (recovery: Partial<ApplicationEvaluation["recovery"]>): ApplicationEvaluation =>
  ({
    key: Math.random().toString(),
    recovery: { status: "not_found", attempts: [], serperQueries: 0, ...recovery },
  }) as unknown as ApplicationEvaluation;

describe("buildRecoveryMetrics", () => {
  it("attributes verified rows and candidates to the step that found them, inferring old rows", () => {
    const m = buildRecoveryMetrics(
      [
        ev({ status: "scored", source: "ats_board", foundVia: "guessed_board" }),
        ev({ status: "scored", source: "ats_board" }),
        ev({ status: "scored", source: "serper", serperQueries: 1 }),
        ev({ status: "scored", source: "manual", foundVia: "manual", verifiedBy: "user" }),
        ev({
          status: "unverified",
          source: "ats_board",
          serperQueries: 1,
          candidates: [{ url: "u", source: "ats_board", matchLevel: "low", text: "" }],
        }),
        ev({
          status: "unverified",
          source: "mcp",
          foundVia: "mcp",
          candidates: [{ url: "m", source: "mcp", stage: "mcp", matchLevel: "low", text: "" }],
        }),
        ev({ status: "not_found", serperQueries: 1, notes: ["serper_no_results"] }),
        ev({ status: "fetch_failed" }),
      ],
      { queries: 25, cap: 1250 },
    );
    expect(m).toMatchObject({
      applications: 8,
      withUsefulData: 6,
      verifiedAuto: 3,
      userPasted: 1,
      needsPick: 2,
      notFound: 2,
    });
    expect(m.byBucket.company_board).toEqual({ verified: 2, candidatesOnly: 0 });
    expect(m.byBucket.serper).toEqual({ verified: 1, candidatesOnly: 1 });
    expect(m.byBucket.manual.verified).toBe(1);
    expect(m.byBucket.manual.candidatesOnly).toBe(1);
    expect(m.serper).toMatchObject({ jobsSearched: 3, jobsWithResults: 2, verified: 1, candidatesOnly: 1, queriesUsed: 25 });
  });
});

describe("buildCostSummary", () => {
  const rec = (over: Partial<LlmUsageRecord>): LlmUsageRecord => ({
    at: "2026-10-01T12:00:00.000Z",
    day: "2026-10-01",
    model: "gpt-5-mini",
    feature: "other",
    inputTokens: 0,
    cachedTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    costUsd: 0,
    ...over,
  });

  it("totals by day and feature and averages per scored role and per email", () => {
    const s = buildCostSummary(
      [
        rec({ feature: "jd_recovery", key: "a", costUsd: 0.01 }),
        rec({ feature: "jd_recovery", key: "a", costUsd: 0.006 }),
        rec({ feature: "jd_recovery", key: "b", costUsd: 0.008, day: "2026-09-28" }),
        rec({ feature: "gmail_classify", costUsd: 0.001 }),
        rec({ feature: "gmail_classify", costUsd: 0.003, day: "2026-09-20" }),
      ],
      { model: "gpt-5-mini", today: "2026-10-01", sevenDaysAgo: "2026-09-25", windowDays: 30 },
    );
    expect(s.today).toBeCloseTo(0.017);
    expect(s.last7Days).toBeCloseTo(0.025);
    expect(s.windowTotal).toBeCloseTo(0.028);
    expect(s.perScoredRole).toBeCloseTo(0.012);
    expect(s.perEmailClassified).toBeCloseTo(0.002);
    expect(s.byDay.map((d) => d.day)).toEqual(["2026-09-20", "2026-09-28", "2026-10-01"]);
  });

  it("reports nothing tracked when there are no records", () => {
    const s = buildCostSummary([], { model: "m", today: "d", sevenDaysAgo: "d", windowDays: 7 });
    expect(s).toMatchObject({ trackingSince: null, perScoredRole: null, perEmailClassified: null, today: 0 });
  });
});
