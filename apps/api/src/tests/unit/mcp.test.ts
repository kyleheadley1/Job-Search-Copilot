import { describe, expect, it, vi } from "vitest";
import { ZodError } from "zod";
import {
  GetApplicationDetailsInput,
  GetApplicationInsightsInput,
  ListApplicationsInput,
  MCP_MAX_DAYS,
  MCP_TOOL_NAMES,
  McpToolError,
  runMcpTool,
  type McpDeps,
} from "../../mcp/catalog.js";
import { createMcpServer } from "../../mcp/server.js";
import { toInsightsView, toListRow } from "../../mcp/views.js";
import type { GmailApplication } from "../../services/gmail/gmailApplications.js";
import type { ApplicationEvaluation } from "../../services/gmail/jdRecovery/evaluations.repository.js";
import type { InsightsRun } from "../../services/insights/insights.repository.js";

const interval = { rate: 0.25, lo: 0.1, hi: 0.4 };

const app = (over: Partial<GmailApplication> & Pick<GmailApplication, "key" | "company">): GmailApplication =>
  ({
    role: "Engineer",
    appliedAt: "2026-10-01T00:00:00.000Z",
    appliedAtKnown: true,
    appliedAtSource: "email",
    status: "applied",
    furthestStage: "applied",
    interviewRounds: [],
    activelyInterviewing: false,
    lastUpdateAt: "2026-10-02T00:00:00.000Z",
    emails: [],
    ...over,
  }) as GmailApplication;

const poisonedAcme = app({
  key: "acme:engineer",
  company: "Acme",
  role: "Engineer",
  status: "interviewing",
  furthestStage: "interviewing",
  activelyInterviewing: true,
  from: "secret@example.com",
  refreshToken: "refresh-secret",
  interviewRounds: [
    {
      number: 1,
      kind: "recruiter_screen",
      focus: "intro",
      interviewers: "Jane Doe (Recruiter)",
      startedAt: "2026-10-03T00:00:00.000Z",
      lastEmailAt: "2026-10-03T00:00:00.000Z",
      emailIds: ["m2"],
      scheduledAt: "2026-10-10T15:00:00.000Z",
      durationMinutes: 30,
      cancelled: false,
      label: "1st round · recruiter screen",
    },
  ],
  emails: [
    {
      id: "m1",
      subject: "Thanks for applying",
      from: "recruiter@acme.com",
      date: "2026-10-01T00:00:00.000Z",
      eventType: "applied",
      gmailUrl: "https://mail.google.com/mail/u/0/#inbox/m1",
    },
  ],
  actionNeeded: {
    emailId: "m2",
    threadId: "t2",
    type: "schedule",
    summary: "Pick a time for the screen",
    deadline: "2026-10-08T00:00:00.000Z",
    receivedAt: "2026-10-03T00:00:00.000Z",
    gmailUrl: "https://mail.google.com/mail/u/0/#inbox/m2",
  },
} as GmailApplication & { from: string; refreshToken: string });

const otherApp = app({ key: "beta:pm", company: "Beta", role: "PM", status: "rejected", furthestStage: "applied" });

const evaluation = {
  key: "acme:engineer",
  company: "Acme",
  role: "Engineer",
  appliedAt: "2026-10-01T00:00:00.000Z",
  recovery: {
    status: "scored",
    attempts: [],
    serperQueries: 0,
    recoveredRole: "Staff Engineer",
    match: { level: "high", signals: [] },
  },
  jd: { text: "FULL JOB DESCRIPTION SECRET", textHash: "h", title: "Staff Engineer" },
  fit: {
    total: 72,
    recommendation: "apply",
    recommendedResume: "BASE",
    scoredAt: "2026-10-02T00:00:00.000Z",
    promptVersion: "v1",
    breakdown: {
      categories: { stackFit: 20 },
      topMatch: "Python",
      mainRisk: "years",
    },
  },
  outcome: { status: "interviewing", updatedAt: "2026-10-03T00:00:00.000Z", history: [] },
  createdAt: "2026-10-02T00:00:00.000Z",
  updatedAt: "2026-10-02T00:00:00.000Z",
} as unknown as ApplicationEvaluation;

const insightsRun = {
  id: "run-1",
  trigger: "manual",
  generatedAt: "2026-10-20T12:00:00.000Z",
  headline: "Small sample so far",
  conclusion: "no_signal",
  summary: "Stored summary paragraph",
  counts: {
    applications: 40,
    positive: 8,
    negative: 22,
    tooEarly: 10,
    decided: 30,
    withFit: 28,
    withoutFit: 12,
    scoredCallbacks: 6,
    unscoredCallbacks: 2,
    confirmedApplied: 25,
    inferredApplied: 15,
    unscoredReasons: { no_jd: 12 },
  },
  baseRate: { k: 8, n: 30, ...interval },
  scoreBands: [{ band: "Apply", k: 3, n: 12, rate: interval }],
  scorePredicts: {
    auc: 0.6,
    p: 0.2,
    n: 30,
    k: 8,
    rate: interval,
    verdict: "no_signal",
    note: "8 of 30 scored",
  },
  screening: {
    seniority: [{ bucket: "Senior", k: 4, n: 16, rate: interval }],
    seniorityUnknown: 2,
    degree: [{ bucket: "PhD", k: 2, n: 8, rate: interval }],
    degreeUnknown: 1,
    specialized: { k: 1, n: 10, rate: interval, restK: 7, restN: 20 },
    specializedUnknown: 0,
    bySeniorityAndDegree: [{ seniority: "Senior", degree: "PhD", k: 1, n: 6, rate: interval }],
  },
  patterns: [],
  goodFit: { k: 3, n: 12, rate: interval, patterns: [] },
  proposals: [],
  quietGoodFits: [{ id: "x", company: "SecretCo", role: "Eng", fit: 80, appliedAt: null }],
} as InsightsRun;

const syncGmail = vi.fn();
const runInsights = vi.fn();

const deps = (): McpDeps => ({
  getApplications: vi.fn(async () => [poisonedAcme, otherApp]),
  getEvaluationsByKeys: vi.fn(async (keys) => {
    const map = new Map<string, ApplicationEvaluation>();
    if (keys.includes(evaluation.key)) map.set(evaluation.key, evaluation);
    return map;
  }),
  getLatestInsightsRun: vi.fn(async () => insightsRun),
  saveJobProspect: vi.fn(async () => {
    throw new Error("saveJobProspect should not run in read-tool tests");
  }),
});

const json = (value: unknown) => JSON.stringify(value);

describe("MCP tool discovery", () => {
  it("exposes the three read tools plus save_job_prospect", () => {
    expect(MCP_TOOL_NAMES).toEqual([
      "list_applications",
      "get_application_details",
      "get_application_insights",
      "save_job_prospect",
    ]);
    const server = createMcpServer(deps());
    for (const name of MCP_TOOL_NAMES) {
      expect(server.toolInputSchemaJson(name)).toMatchObject({ type: "object" });
    }
    expect(server.toolInputSchemaJson("propose_email")).toBeUndefined();
    expect(server.toolInputSchemaJson("health")).toBeUndefined();
  });
});

describe("MCP tool results", () => {
  it("lists compact application rows with filters and fit totals", async () => {
    const d = deps();
    const result = (await runMcpTool("list_applications", { query: "acme", limit: 10 }, d)) as {
      days: number;
      totalMatched: number;
      applications: Array<Record<string, unknown>>;
    };
    expect(d.getApplications).toHaveBeenCalledWith(30);
    expect(result.days).toBe(30);
    expect(result.totalMatched).toBe(1);
    expect(result.applications).toEqual([
      {
        key: "acme:engineer",
        company: "Acme",
        role: "Engineer",
        status: "interviewing",
        furthestStage: "interviewing",
        appliedAt: "2026-10-01T00:00:00.000Z",
        lastUpdateAt: "2026-10-02T00:00:00.000Z",
        activelyInterviewing: true,
        fitTotal: 72,
      },
    ]);
  });

  it("returns useful details without bodies, senders, or JD text", async () => {
    const result = (await runMcpTool("get_application_details", { key: "acme:engineer" }, deps())) as Record<
      string,
      unknown
    >;
    expect(result).toMatchObject({
      key: "acme:engineer",
      company: "Acme",
      status: "interviewing",
      actionNeeded: { type: "schedule", summary: "Pick a time for the screen", deadline: "2026-10-08T00:00:00.000Z" },
      evaluation: { status: "scored", fitTotal: 72, recommendation: "apply", jdTitle: "Staff Engineer" },
    });
    expect(result.emails).toEqual([
      { date: "2026-10-01T00:00:00.000Z", eventType: "applied", subject: "Thanks for applying" },
    ]);
    expect((result.interviewRounds as unknown[])[0]).toMatchObject({
      number: 1,
      label: "1st round · recruiter screen",
      kind: "recruiter_screen",
    });
  });

  it("returns stored insights timestamp and sample sizes", async () => {
    const result = (await runMcpTool("get_application_insights", {}, deps())) as {
      run: { generatedAt: string; counts: { applications: number }; baseRate: { k: number; n: number } };
    };
    expect(result.run.generatedAt).toBe("2026-10-20T12:00:00.000Z");
    expect(result.run.counts.applications).toBe(40);
    expect(result.run.baseRate).toEqual({ k: 8, n: 30, rate: 0.25, lo: 0.1, hi: 0.4 });
  });

  it("reads a stored insights run that predates screening fields", async () => {
    const legacy = {
      ...insightsRun,
      screening: undefined,
      scorePredicts: { auc: 0.67, p: 0.01, n: 422, verdict: "conclusive", note: "Higher scores do get more callbacks (AUC 0.67)." },
    } as unknown as InsightsRun;
    const d = deps();
    d.getLatestInsightsRun = vi.fn(async () => legacy);
    const result = (await runMcpTool("get_application_insights", {}, d)) as {
      run: { generatedAt: string; screening?: unknown; scorePredicts: { n: number; rate?: unknown } };
    };
    expect(result.run.generatedAt).toBe("2026-10-20T12:00:00.000Z");
    expect(result.run.scorePredicts.n).toBe(422);
    expect(result.run.scorePredicts.rate).toBeUndefined();
    expect(result.run.screening).toBeUndefined();
    expect(result.run).toMatchObject({ conclusion: "no_signal", headline: "Small sample so far" });
  });

  it("preserves valid zero metrics instead of treating them as missing", () => {
    const zeroRate = { rate: 0, lo: 0, hi: 0 };
    const view = toInsightsView({
      ...insightsRun,
      counts: {
        ...insightsRun.counts,
        positive: 0,
        scoredCallbacks: 0,
        unscoredCallbacks: 0,
        tooEarly: 0,
        withoutFit: 0,
      },
      baseRate: { k: 0, n: 10, ...zeroRate },
      scorePredicts: { ...insightsRun.scorePredicts, k: 0, p: 0, auc: 0, rate: zeroRate },
      screening: {
        ...insightsRun.screening,
        seniorityUnknown: 0,
        degreeUnknown: 0,
        specializedUnknown: 0,
        specialized: { k: 0, n: 8, restK: 0, restN: 8, rate: zeroRate },
      },
      goodFit: { k: 0, n: 8, rate: zeroRate, patterns: [] },
    });
    const run = JSON.parse(JSON.stringify(view)).run;
    expect(run.counts.positive).toBe(0);
    expect(run.counts.scoredCallbacks).toBe(0);
    expect(run.counts.tooEarly).toBe(0);
    expect(run.baseRate).toEqual({ k: 0, n: 10, rate: 0, lo: 0, hi: 0 });
    expect(run.scorePredicts.k).toBe(0);
    expect(run.scorePredicts.auc).toBe(0);
    expect(run.scorePredicts.rate).toEqual(zeroRate);
    expect(run.screening.seniorityUnknown).toBe(0);
    expect(run.screening.specialized.k).toBe(0);
    expect(run.goodFit.k).toBe(0);
    expect(run.goodFit.rate).toEqual(zeroRate);

    const row = toListRow(app({ key: "zero:fit", company: "ZeroCo" }), {
      ...evaluation,
      key: "zero:fit",
      fit: { ...evaluation.fit, total: 0 },
    } as ApplicationEvaluation);
    expect(row.fitTotal).toBe(0);
    expect(JSON.parse(JSON.stringify(row)).fitTotal).toBe(0);
  });

  it("keeps the stored conclusion when optional metrics are absent or disagree", async () => {
    const d = deps();
    d.getLatestInsightsRun = vi.fn(async () => ({
      ...insightsRun,
      conclusion: "conclusive",
      headline: "Your fit score does predict callbacks",
      screening: undefined,
      scorePredicts: { auc: 0.67, p: 0.01, n: 422, verdict: "no_signal", note: "note" },
    }) as unknown as InsightsRun);
    const result = (await runMcpTool("get_application_insights", {}, d)) as {
      run: { conclusion: string; headline: string; screening?: unknown; scorePredicts: { verdict: string } };
    };
    expect(result.run.conclusion).toBe("conclusive");
    expect(result.run.headline).toBe("Your fit score does predict callbacks");
    expect(result.run.scorePredicts.verdict).toBe("no_signal");
    expect(result.run.screening).toBeUndefined();
    expect(result.run).not.toHaveProperty("inferredConclusion");
  });
});

describe("MCP authorization and PII boundaries", () => {
  it("does not leak credentials, senders, JD text, or quiet-good-fit companies", async () => {
    const d = deps();
    const listed = json(await runMcpTool("list_applications", {}, d));
    const details = json(await runMcpTool("get_application_details", { key: "acme:engineer" }, d));
    const insights = json(await runMcpTool("get_application_insights", {}, d));
    const blob = `${listed}\n${details}\n${insights}`;
    for (const secret of [
      "secret@example.com",
      "refresh-secret",
      "recruiter@acme.com",
      "FULL JOB DESCRIPTION SECRET",
      "Jane Doe",
      "mail.google.com",
      "SecretCo",
      "OPENAI_",
      "GOOGLE_",
    ]) {
      expect(blob).not.toContain(secret);
    }
    expect(d.getApplications).toHaveBeenCalled();
    expect(syncGmail).not.toHaveBeenCalled();
    expect(runInsights).not.toHaveBeenCalled();
  });

  it("rejects spoofed identity fields and does not dump other applications on a miss", async () => {
    await expect(runMcpTool("list_applications", { userId: "other-person" }, deps())).rejects.toBeInstanceOf(ZodError);
    await expect(runMcpTool("get_application_details", { key: "missing", userId: "x" }, deps())).rejects.toBeInstanceOf(
      ZodError,
    );
    await expect(runMcpTool("get_application_insights", { userId: "x" }, deps())).rejects.toBeInstanceOf(ZodError);

    try {
      await runMcpTool("get_application_details", { key: "missing" }, deps());
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(McpToolError);
      expect(error).toMatchObject({ code: "NOT_FOUND" });
      expect(json(error)).not.toContain("beta:pm");
    }
  });
});

describe("MCP invalid input", () => {
  it("rejects missing keys, out-of-range paging, and bad status before calling deps", async () => {
    const d = deps();
    expect(() => GetApplicationDetailsInput.parse({})).toThrow(ZodError);
    expect(() => ListApplicationsInput.parse({ days: 0 })).toThrow(ZodError);
    expect(() => ListApplicationsInput.parse({ limit: 99 })).toThrow(ZodError);
    expect(() => ListApplicationsInput.parse({ status: "ghosted" })).toThrow(ZodError);
    expect(() => GetApplicationInsightsInput.parse({ extra: true })).toThrow(ZodError);
    expect(() => ListApplicationsInput.parse({ days: MCP_MAX_DAYS + 1 })).toThrow(ZodError);

    await expect(runMcpTool("get_application_details", {}, d)).rejects.toBeInstanceOf(ZodError);
    expect(d.getApplications).not.toHaveBeenCalled();
    expect(d.getEvaluationsByKeys).not.toHaveBeenCalled();
    expect(d.getLatestInsightsRun).not.toHaveBeenCalled();
  });
});
