import { describe, expect, it, vi } from "vitest";
import type { GmailApplication } from "../../services/gmail/gmailApplications.js";
import type { JobProspect, ProspectApplicationPatch } from "../../services/gmail/jdRecovery/jobProspects.repository.js";
import {
  listUnconfirmedProspects,
  markProspectApplied,
  ProspectApplicationError,
  type ProspectApplicationDeps,
} from "../../services/gmail/jdRecovery/prospectApplication.service.js";
import { MarkProspectAppliedInputSchema, runMcpTool, type McpDeps } from "../../mcp/catalog.js";
import type { JobRecord } from "../../types/job.js";

const NOW = new Date("2026-11-17T15:00:00");
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000).toISOString();

const prospect = (over: Partial<JobProspect>): JobProspect => ({
  id: over.id ?? "p1",
  company: "Draftwise",
  companyKey: "draftwise",
  title: "Forward Deployed AI Engineer, Backend",
  rawText: "jd",
  cleanedText: "jd",
  cleanedTextHash: "h",
  status: "open",
  createdAt: daysAgo(5),
  updatedAt: daysAgo(5),
  ...over,
});

const app = (over: Partial<GmailApplication>): GmailApplication =>
  ({
    key: "k1",
    company: "Draftwise",
    role: "Forward Deployed AI Engineer, Backend",
    appliedAt: daysAgo(1),
    appliedAtKnown: true,
    appliedAtSource: "email",
    status: "applied",
    furthestStage: "applied",
    interviewRounds: [],
    activelyInterviewing: false,
    lastUpdateAt: daysAgo(1),
    emails: [],
    ...over,
  }) as GmailApplication;

const makeDeps = (rows: JobProspect[], opts: { apps?: GmailApplication[]; jobs?: JobRecord[]; failTracker?: boolean } = {}) => {
  const createTrackedApplication = vi.fn(async () => {
    if (opts.failTracker) throw new Error("triage down");
    return "job-1";
  });
  const removeTrackedApplication = vi.fn(async (_jobId: string) => {});
  const deps: ProspectApplicationDeps = {
    findById: async (id) => rows.find((r) => r.id === id) ?? null,
    findByCompanyKey: async (key) => rows.filter((r) => r.companyKey === key),
    findAll: async () => rows,
    updateApplicationState: async (id: string, patch: ProspectApplicationPatch) => {
      const row = rows.find((r) => r.id === id);
      if (!row) return null;
      for (const [k, v] of Object.entries(patch)) {
        if (v === undefined) delete (row as Record<string, unknown>)[k];
        else (row as Record<string, unknown>)[k] = v;
      }
      return row;
    },
    getApplications: async () => opts.apps ?? [],
    getTrackerJobs: async () => opts.jobs ?? [],
    createTrackedApplication,
    removeTrackedApplication,
    now: () => NOW,
  };
  return { deps, createTrackedApplication, removeTrackedApplication };
};

describe("markProspectApplied", () => {
  it("records today's date and creates a tracker row when no email matched", async () => {
    const rows = [prospect({ id: "p1" })];
    const { deps, createTrackedApplication } = makeDeps(rows);
    const result = await markProspectApplied({ company: "Draftwise", title: "Forward Deployed AI Engineer, Backend" }, deps, {
      background: false,
    });
    expect(result.appliedAt).toBe("2026-11-17");
    expect(result.tracker).toBe("created");
    expect(result.trackerJobId).toBe("job-1");
    expect(createTrackedApplication).toHaveBeenCalledWith(rows[0], "2026-11-17");
    expect(rows[0]).toMatchObject({ appliedAt: "2026-11-17", trackerJobId: "job-1" });
  });

  it("updates saved duplicates of the same posting together", async () => {
    const rows = [prospect({ id: "a" }), prospect({ id: "b", createdAt: daysAgo(8) }), prospect({ id: "c", title: "Deployment Strategist" })];
    const { deps, createTrackedApplication } = makeDeps(rows);
    const result = await markProspectApplied({ prospectId: "a", appliedAt: "2026-11-10" }, deps, { background: false });
    expect(result.prospectIds).toEqual(["a", "b"]);
    expect(createTrackedApplication).toHaveBeenCalledTimes(1);
    expect(rows[1]!.appliedAt).toBe("2026-11-10");
    expect(rows[2]!.appliedAt).toBeUndefined();
  });

  it("skips tracker creation when a confirmation email already matches", async () => {
    const rows = [prospect({ id: "p1" })];
    const { deps, createTrackedApplication } = makeDeps(rows, { apps: [app({})] });
    const result = await markProspectApplied({ prospectId: "p1" }, deps, { background: false });
    expect(result.emailConfirmed).toBe(true);
    expect(result.tracker).toBe("handled_by_email");
    expect(createTrackedApplication).not.toHaveBeenCalled();
  });

  it("links an existing tracker row instead of creating a second one", async () => {
    const rows = [prospect({ id: "p1" })];
    const job = {
      id: "existing",
      status: "applied",
      extracted: { company: "Draftwise", title: "Forward Deployed AI Engineer, Backend" },
      tracker: {},
      updatedAt: daysAgo(2),
    } as unknown as JobRecord;
    const { deps, createTrackedApplication } = makeDeps(rows, { jobs: [job] });
    const result = await markProspectApplied({ prospectId: "p1" }, deps, { background: false });
    expect(result.tracker).toBe("linked_existing");
    expect(result.trackerJobId).toBe("existing");
    expect(createTrackedApplication).not.toHaveBeenCalled();
  });

  it("keeps the applied date and records the error when the tracker step fails", async () => {
    const rows = [prospect({ id: "p1" })];
    const { deps } = makeDeps(rows, { failTracker: true });
    const result = await markProspectApplied({ prospectId: "p1" }, deps, { background: false });
    expect(result.tracker).toBe("failed");
    expect(rows[0]).toMatchObject({ appliedAt: "2026-11-17", trackerSyncError: "triage down" });
  });

  it("marks not applied and clears any applied date", async () => {
    const rows = [prospect({ id: "p1", appliedAt: "2026-11-01" })];
    const { deps } = makeDeps(rows);
    const result = await markProspectApplied({ prospectId: "p1", applied: false }, deps);
    expect(result.applied).toBe(false);
    expect(rows[0]!.notApplied).toBe(true);
    expect(rows[0]!.appliedAt).toBeUndefined();
  });

  it("not applied removes the tracker row this flow created", async () => {
    const rows = [prospect({ id: "p1" })];
    const { deps, removeTrackedApplication } = makeDeps(rows);
    await markProspectApplied({ prospectId: "p1" }, deps, { background: false });
    const result = await markProspectApplied({ prospectId: "p1", applied: false }, deps);
    expect(removeTrackedApplication).toHaveBeenCalledWith("job-1");
    expect(rows[0]!.trackerJobId).toBeUndefined();
    expect(result.note).toMatch(/Removed the tracker row/);
  });

  it("not applied never removes a pre-existing tracker row", async () => {
    const rows = [prospect({ id: "p1", trackerJobId: "theirs" })];
    const { deps, removeTrackedApplication } = makeDeps(rows);
    await markProspectApplied({ prospectId: "p1", applied: false }, deps);
    expect(removeTrackedApplication).not.toHaveBeenCalled();
    expect(rows[0]!.trackerJobId).toBe("theirs");
  });

  it("drops the new tracker row if not applied arrives while scoring runs", async () => {
    const rows = [prospect({ id: "p1" })];
    const { deps, createTrackedApplication, removeTrackedApplication } = makeDeps(rows);
    createTrackedApplication.mockImplementationOnce(async () => {
      rows[0]!.notApplied = true;
      return "job-race";
    });
    const result = await markProspectApplied({ prospectId: "p1" }, deps, { background: false });
    expect(result.tracker).toBe("failed");
    expect(removeTrackedApplication).toHaveBeenCalledWith("job-race");
    expect(rows[0]!.trackerJobId).toBeUndefined();
  });

  it("reports options when the title is ambiguous or unknown", async () => {
    const rows = [
      prospect({ id: "a", title: "Solutions Engineer, Enterprise" }),
      prospect({ id: "b", title: "Solutions Engineer, Growth" }),
    ];
    const { deps } = makeDeps(rows);
    await expect(markProspectApplied({ company: "Draftwise", title: "Solutions Engineer" }, deps)).rejects.toMatchObject({
      code: "PROSPECT_AMBIGUOUS",
    });
    const err = await markProspectApplied({ company: "Draftwise", title: "Account Executive" }, deps).catch((e) => e);
    expect(err).toBeInstanceOf(ProspectApplicationError);
    expect(err.code).toBe("PROSPECT_NOT_FOUND");
    expect(err.options).toHaveLength(2);
  });
});

describe("listUnconfirmedProspects", () => {
  it("lists old unanswered prospects and applied-without-email ones, collapsing duplicates", async () => {
    const rows = [
      prospect({ id: "dw1", createdAt: daysAgo(6) }),
      prospect({ id: "dw2", createdAt: daysAgo(9) }),
      prospect({ id: "bl", company: "Baselayer", companyKey: "baselayer", title: "Solutions Engineer", createdAt: daysAgo(4), appliedAt: "2026-11-13" }),
      prospect({ id: "fresh", company: "Fresh", companyKey: "fresh", title: "Engineer", createdAt: daysAgo(1) }),
      prospect({ id: "skip", company: "Skip", companyKey: "skip", title: "Engineer", notApplied: true }),
      prospect({ id: "old", company: "Old", companyKey: "old", title: "Engineer", createdAt: daysAgo(60) }),
      prospect({ id: "att", company: "Att", companyKey: "att", title: "Engineer", status: "attached", attachedKey: "x" }),
      prospect({ id: "em", company: "Emailed", companyKey: "emailed", title: "Backend Engineer" }),
    ];
    const { deps } = makeDeps(rows, { apps: [app({ key: "e1", company: "Emailed", role: "Backend Engineer" })] });
    const result = await listUnconfirmedProspects({}, deps);
    expect(result.prospects.map((p) => [p.prospectId, p.state])).toEqual([
      ["dw1", "needs_answer"],
      ["bl", "applied_no_email"],
    ]);
    expect(result.prospects[0]!.duplicateIds).toEqual(["dw2"]);
    expect(result.needsAnswer).toBe(1);
    expect(result.appliedNoEmail).toBe(1);
  });

  it("can hide applied_no_email rows", async () => {
    const rows = [prospect({ id: "bl", appliedAt: "2026-11-13" })];
    const { deps } = makeDeps(rows);
    expect((await listUnconfirmedProspects({ includeApplied: false }, deps)).total).toBe(0);
  });
});

describe("MCP wiring", () => {
  it("requires prospectId or company + title", () => {
    expect(() => MarkProspectAppliedInputSchema.parse({ company: "Draftwise" })).toThrow();
    expect(MarkProspectAppliedInputSchema.parse({ prospectId: "p1" })).toMatchObject({ applied: true });
  });

  it("save_job_prospect with applied: true marks the saved prospect", async () => {
    const markProspectApplied = vi.fn(async () => ({ tracker: "creating" }));
    const deps = {
      saveJobProspect: vi.fn(async () => ({ id: "new-id", matchStatus: "awaiting_gmail_application" })),
      markProspectApplied,
    } as unknown as McpDeps;
    const result = (await runMcpTool(
      "save_job_prospect",
      { rawText: "x".repeat(60), company: "Baselayer", title: "Solutions Engineer", applied: true, appliedAt: "2026-11-17" },
      deps,
    )) as { id: string; applied: unknown };
    expect(markProspectApplied).toHaveBeenCalledWith({ prospectId: "new-id", applied: true, appliedAt: "2026-11-17" });
    expect(result.applied).toEqual({ tracker: "creating" });
  });

  it("save_job_prospect assumes applied for a new prospect", async () => {
    const markProspectApplied = vi.fn(async () => ({}));
    const deps = { saveJobProspect: vi.fn(async () => ({ id: "n", duplicate: false })), markProspectApplied } as unknown as McpDeps;
    await runMcpTool("save_job_prospect", { rawText: "x".repeat(60), company: "A", title: "B" }, deps);
    expect(markProspectApplied).toHaveBeenCalledWith({ prospectId: "n", applied: true, appliedAt: undefined });
  });

  it("save_job_prospect passes applied: false through", async () => {
    const markProspectApplied = vi.fn(async () => ({}));
    const deps = { saveJobProspect: vi.fn(async () => ({ id: "n", duplicate: false })), markProspectApplied } as unknown as McpDeps;
    await runMcpTool("save_job_prospect", { rawText: "x".repeat(60), company: "A", title: "B", applied: false }, deps);
    expect(markProspectApplied).toHaveBeenCalledWith({ prospectId: "n", applied: false, appliedAt: undefined });
  });

  it("re-saving an existing prospect leaves its applied state alone", async () => {
    const markProspectApplied = vi.fn();
    const deps = { saveJobProspect: vi.fn(async () => ({ id: "n", duplicate: true })), markProspectApplied } as unknown as McpDeps;
    await runMcpTool("save_job_prospect", { rawText: "x".repeat(60), company: "A", title: "B" }, deps);
    expect(markProspectApplied).not.toHaveBeenCalled();
  });
});
