import { describe, expect, it, vi } from "vitest";
import { ZodError } from "zod";
import {
  GetApplicationDetailsInput,
  GetApplicationInsightsInput,
  ListApplicationsInput,
  ListMissingJobDescriptionsInput,
  MCP_MAX_DAYS,
  MCP_TOOL_NAMES,
  MCP_TOOLS,
  McpToolError,
  runMcpTool,
  SubmitJdCandidateInputSchema,
  type McpDeps,
} from "../../mcp/catalog.js";
import { submitJdCandidate } from "../../services/gmail/jdRecovery/jdCandidates.service.js";
import { createMcpServer } from "../../mcp/server.js";
import { toInsightsView, toListRow } from "../../mcp/views.js";
import type { GmailApplication } from "../../services/gmail/gmailApplications.js";
import type { ApplicationEvaluation } from "../../services/gmail/jdRecovery/evaluations.repository.js";
import type { InsightsRun } from "../../services/insights/insights.repository.js";
import { exampleUserProfile } from "../../config/userProfile.example.js";

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
    attempts: [{ url: "https://attempt-secret.example/job/1", source: "email_link", ok: false, reason: "http_403" }],
    serperQueries: 0,
    recoveredRole: "Staff Engineer",
    foundVia: "prospect",
    source: "manual",
    url: "https://posting-secret.example/job/1",
    notes: ["internal_note_secret"],
    candidates: [{ url: "https://candidate-secret.example/job", source: "serper", matchLevel: "low", text: "CANDIDATE TEXT SECRET" }],
    match: { level: "high", signals: ["prospect_auto_attached"] },
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
  getActiveScoreRevisions: vi.fn(async () => new Map()),
  getLatestInsightsRun: vi.fn(async () => insightsRun),
  getUserProfile: vi.fn(() => {
    throw new Error("getUserProfile should not run in compact read-tool tests");
  }),
  getResumeContexts: vi.fn(async () => {
    throw new Error("getResumeContexts should not run in compact read-tool tests");
  }),
  saveJobProspect: vi.fn(async () => {
    throw new Error("saveJobProspect should not run in read-tool tests");
  }),
  submitJdCandidate: vi.fn(async () => {
    throw new Error("submitJdCandidate should not run in read-tool tests");
  }),
  proposeScoringCorrection: vi.fn(async () => {
    throw new Error("proposeScoringCorrection should not run in read-tool tests");
  }),
});

const json = (value: unknown) => JSON.stringify(value);

describe("MCP tool discovery", () => {
  it("exposes the Phase 1 tools plus missing-JD recovery tools", () => {
    expect(MCP_TOOL_NAMES).toEqual([
      "list_applications",
      "get_application_details",
      "get_application_insights",
      "save_job_prospect",
      "list_missing_job_descriptions",
      "submit_jd_candidate",
      "list_scored_applications_for_audit",
      "get_scoring_audit_context",
      "propose_scoring_correction",
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
      evaluation: {
        status: "scored",
        fitTotal: 72,
        recommendation: "apply",
        matchLevel: "high",
        jdTitle: "Staff Engineer",
        foundVia: "prospect",
        matchSignals: ["prospect_auto_attached"],
      },
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

describe("MCP evaluation provenance", () => {
  it("allowlists only the evaluation fields the details tool may return", async () => {
    const result = JSON.parse(json(await runMcpTool("get_application_details", { key: "acme:engineer" }, deps()))) as {
      evaluation: Record<string, unknown>;
    };
    const allowed = new Set([
      "status",
      "fitTotal",
      "recommendation",
      "recommendedResume",
      "matchLevel",
      "foundVia",
      "matchSignals",
      "jdTitle",
      "fitBreakdown",
      "storedFitTotal",
      "scoreConflict",
      "authoritativeSource",
      "revisionId",
      "scoreRevised",
      "originalAuthoritativeTotal",
      "fingerprintStale",
      "staleRevisionTotal",
    ]);
    for (const field of Object.keys(result.evaluation)) {
      expect(allowed.has(field)).toBe(true);
    }
    expect(result.evaluation).not.toHaveProperty("attempts");
    expect(result.evaluation).not.toHaveProperty("candidates");
    expect(result.evaluation).not.toHaveProperty("notes");
    expect(result.evaluation).not.toHaveProperty("url");
  });

  it("omits provenance fields when recovery has no stage or match", async () => {
    const bare = {
      ...evaluation,
      recovery: { status: "not_found", attempts: [], serperQueries: 0 },
      fit: undefined,
    } as unknown as ApplicationEvaluation;
    const d = deps();
    d.getEvaluationsByKeys = vi.fn(async () => new Map([[bare.key, bare]]));
    const result = JSON.parse(json(await runMcpTool("get_application_details", { key: "acme:engineer" }, d))) as {
      evaluation: Record<string, unknown>;
    };
    expect(result.evaluation.status).toBe("not_found");
    expect(result.evaluation).not.toHaveProperty("foundVia");
    expect(result.evaluation).not.toHaveProperty("matchSignals");
    expect(result.evaluation).not.toHaveProperty("matchLevel");
  });
});

describe("save_job_prospect description", () => {
  it("discloses background recovery, scoring, and tracker sync", () => {
    const tool = MCP_TOOLS.find((entry) => entry.name === "save_job_prospect");
    expect(tool?.description).toMatch(/background JD recovery/);
    expect(tool?.description).toMatch(/score the application/);
    expect(tool?.description).toMatch(/sync the tracker/);
    expect(tool?.description).toMatch(/recoveryQueued: true/);
    expect(tool?.description).not.toMatch(/write the tracker/);
  });
});

describe("MCP authorization and PII boundaries", () => {
  it("does not leak credentials, senders, JD text, or quiet-good-fit companies", async () => {
    const d = deps();
    const listed = json(await runMcpTool("list_applications", {}, d));
    const details = json(await runMcpTool("get_application_details", { key: "acme:engineer" }, d));
    const insights = json(await runMcpTool("get_application_insights", {}, d));
    const missing = json(await runMcpTool("list_missing_job_descriptions", {}, d));
    const scored = json(await runMcpTool("list_scored_applications_for_audit", {}, d));
    const blob = `${listed}\n${details}\n${insights}\n${missing}\n${scored}`;
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
      "attempt-secret.example",
      "posting-secret.example",
      "candidate-secret.example",
      "CANDIDATE TEXT SECRET",
      "internal_note_secret",
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
    expect(() => ListMissingJobDescriptionsInput.parse({ limit: 99 })).toThrow(ZodError);
    expect(() => SubmitJdCandidateInputSchema.parse({ applicationKey: "k", company: "Acme" })).toThrow(ZodError);
    expect(() =>
      SubmitJdCandidateInputSchema.parse({
        applicationKey: "k",
        company: "Acme",
        originalText: "x".repeat(50),
        sourceUrl: "https://example.com/job",
        sourceType: "aggregator",
        matchEvidence: ["title match"],
        completeness: "full",
        confidence: 0.99,
      }),
    ).toThrow(ZodError);
  });
});

const FULL_JD = [
  "Product Engineer",
  "Beta",
  "",
  "Responsibilities",
  "- Ship product features used by customer teams in production",
  "- Work with customers to understand problems and choose a useful first step",
  "- Write tested TypeScript services and review code with the team",
  "",
  "Requirements",
  "- 3+ years of software engineering experience",
  "- Familiarity with TypeScript and a frontend framework such as React",
  "Build TypeScript services and React interfaces for our healthcare platform. ".repeat(8),
].join("\n");

describe("MCP Phase 2 missing JD tools", () => {
  const phase2Deps = () => {
    const evaluations = new Map<string, ApplicationEvaluation>([[evaluation.key, evaluation]]);
    const apps = [poisonedAcme, otherApp];
    const d: McpDeps = {
      getApplications: vi.fn(async () => apps),
      getEvaluationsByKeys: vi.fn(async (keys) => {
        const map = new Map<string, ApplicationEvaluation>();
        for (const key of keys) {
          const row = evaluations.get(key);
          if (row) map.set(key, row);
        }
        return map;
      }),
      getActiveScoreRevisions: vi.fn(async () => new Map()),
      getLatestInsightsRun: vi.fn(async () => insightsRun),
      getUserProfile: vi.fn(() => {
        throw new Error("getUserProfile should not run in Phase 2 tests");
      }),
      getResumeContexts: vi.fn(async () => {
        throw new Error("getResumeContexts should not run in Phase 2 tests");
      }),
      saveJobProspect: vi.fn(async () => {
        throw new Error("saveJobProspect should not run in Phase 2 tests");
      }),
      proposeScoringCorrection: vi.fn(async () => {
        throw new Error("proposeScoringCorrection should not run in Phase 2 tests");
      }),
      submitJdCandidate: (input) =>
        submitJdCandidate(input, {
          getApplications: async () => apps,
          findByKey: async (key) => evaluations.get(key) ?? null,
          upsertIfUnscored: async (row) => {
            const current = evaluations.get(row.key);
            if (current?.recovery.status === "scored") return current;
            evaluations.set(row.key, row);
            return row;
          },
        }, 120),
    };
    return { d, evaluations };
  };

  it("lists only unscored applications with an allowlisted payload", async () => {
    const { d } = phase2Deps();
    const result = (await runMcpTool("list_missing_job_descriptions", { limit: 10 }, d)) as {
      totalMatched: number;
      applications: Array<Record<string, unknown>>;
    };
    expect(result.totalMatched).toBe(1);
    expect(result.applications).toEqual([
      {
        applicationKey: "beta:pm",
        company: "Beta",
        title: "PM",
        appliedAt: "2026-10-01T00:00:00.000Z",
        appliedAtKnown: true,
        furthestStage: "applied",
        recoveryStatus: "none",
        candidateCount: 0,
        emailCount: 0,
        submittedCandidates: [],
      },
    ]);
    const payload = json(result);
    expect(payload).not.toContain("secret@example.com");
    expect(payload).not.toContain("FULL JOB DESCRIPTION SECRET");
    expect(payload).not.toContain("CANDIDATE TEXT SECRET");
  });

  it("submits a candidate for review and keeps JD text out of the MCP response", async () => {
    const { d, evaluations } = phase2Deps();
    const result = JSON.parse(
      json(
        await runMcpTool(
          "submit_jd_candidate",
          {
            applicationKey: "beta:pm",
            company: "Beta",
            title: "PM",
            originalText: FULL_JD,
            sourceUrl: "https://www.builtinnyc.com/job/pm/1?utm_source=x",
            sourceType: "aggregator",
            matchEvidence: ["Exact company and title"],
            completeness: "full",
          },
          d,
        ),
      ),
    ) as Record<string, unknown>;
    expect(result).toMatchObject({
      applicationKey: "beta:pm",
      status: "submitted",
      reviewRequired: true,
      scoringEligible: true,
      completeness: "full",
    });
    expect(result).not.toHaveProperty("originalText");
    expect(result).not.toHaveProperty("text");
    expect(json(result)).not.toContain("Build TypeScript services");
    const saved = evaluations.get("beta:pm")!;
    expect(saved.recovery.status).toBe("unverified");
    expect(saved.fit).toBeUndefined();
    expect(saved.recovery.candidates![0]!.rawText).toContain("Product Engineer");
    expect(saved.recovery.candidates![0]!.matchLevel).toBe("low");

    const listed = JSON.parse(json(await runMcpTool("list_missing_job_descriptions", { query: "beta" }, d))) as {
      applications: Array<{ submittedCandidates: Array<Record<string, unknown>> }>;
    };
    expect(listed.applications[0]?.submittedCandidates[0]).toMatchObject({
      sourceType: "aggregator",
      completeness: "full",
    });
    expect(json(listed)).not.toContain("Build TypeScript services");
  });
});

describe("MCP Phase 3A scoring audit tools", () => {
  const auditDeps = (): McpDeps => {
    const d = deps();
    d.getUserProfile = vi.fn(() => exampleUserProfile);
    d.getResumeContexts = vi.fn(async () => ({
      BASE: {
        type: "BASE",
        sourcePath: "/secret/home/base_resume.txt",
        sourceKind: "txt",
        loadedAt: "2026-10-02T00:00:00.000Z",
        rawText: "TypeScript Node.js React AWS.",
        metadata: {
          strongestThemes: ["TypeScript"],
          projectEvidence: [],
          keywords: ["typescript"],
          bestFitRoleShapes: ["product_fullstack"],
          avoidUseCases: [],
          claimSupport: [],
        },
      },
    }));
    return d;
  };

  it("lists scored applications with audit metadata and no JD body", async () => {
    const result = JSON.parse(json(await runMcpTool("list_scored_applications_for_audit", { limit: 20 }, auditDeps()))) as {
      readOnly: boolean;
      totalMatched: number;
      applications: Array<Record<string, unknown>>;
      scoringModel: { formula: string };
      auditProtocol: { readOnly: boolean };
    };
    expect(result.readOnly).toBe(true);
    expect(result.totalMatched).toBe(1);
    expect(result.applications[0]).toMatchObject({
      applicationKey: "acme:engineer",
      fitTotal: 72,
      recommendation: "apply",
      recommendedResume: "BASE",
    });
    expect(result.scoringModel.formula).toMatch(/capability/);
    expect(result.auditProtocol.readOnly).toBe(true);
    expect(json(result)).not.toContain("FULL JOB DESCRIPTION SECRET");
    expect(json(result)).not.toContain("secret@example.com");
  });

  it("returns a stored scoring packet without rescoring or leaking credentials", async () => {
    const d = auditDeps();
    const packet = JSON.parse(json(await runMcpTool("get_scoring_audit_context", { key: "acme:engineer" }, d))) as {
      readOnly: boolean;
      jobDescription: { text?: string };
      scoring: { evidenceGaps: string[]; total: number };
      candidate: { profile: { headline: string } };
    };
    expect(packet.readOnly).toBe(true);
    expect(packet.scoring.total).toBe(72);
    expect(packet.jobDescription.text).toContain("FULL JOB DESCRIPTION SECRET");
    expect(packet.candidate.profile.headline).toBe(exampleUserProfile.headline);
    expect(packet.scoring.evidenceGaps).toContain("profileNotSnapshottedAtScoring");
    expect(json(packet)).not.toContain("refresh-secret");
    expect(json(packet)).not.toContain("secret@example.com");
    expect(json(packet)).not.toContain("/secret/home");
    expect(d.getUserProfile).toHaveBeenCalled();
  });

  it("rejects an unscored key and extra identity fields", async () => {
    await expect(runMcpTool("get_scoring_audit_context", { key: "beta:pm" }, auditDeps())).rejects.toMatchObject({
      code: "NOT_SCORED",
    });
    await expect(
      runMcpTool("get_scoring_audit_context", { key: "acme:engineer", userId: "x" }, auditDeps()),
    ).rejects.toBeInstanceOf(ZodError);
    await expect(
      runMcpTool("list_scored_applications_for_audit", { userId: "x" }, auditDeps()),
    ).rejects.toBeInstanceOf(ZodError);
  });
});
