import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentSuggestion } from "../../services/agent/suggestions.repository.js";
import type { GmailApplication } from "../../services/gmail/gmailApplications.js";

const store = new Map<string, AgentSuggestion>();
const updateStatus = vi.fn(async (id: string) => (id === "job-1" ? { id } : null));

vi.mock("../../services/agent/suggestions.repository.js", () => ({
  suggestionsRepository: {
    get: vi.fn(async (id: string) => store.get(id) ?? null),
    resolve: vi.fn(async (id: string, status: AgentSuggestion["status"]) => {
      const s = store.get(id);
      if (s) store.set(id, { ...s, status });
    }),
  },
}));
vi.mock("../../services/jobs/jobs.repository.js", () => ({ jobsRepository: { updateStatus } }));

const { runDailyAgent, approveSuggestion, dismissSuggestion, SuggestionNotFoundError } = await import(
  "../../services/agent/dailyAgent.js"
);
type AgentDeps = Parameters<typeof runDailyAgent>[0];

const NOW = new Date("2026-10-04T12:00:00.000Z");
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86_400_000).toISOString();

const ghostedApp = (key: string): GmailApplication => ({
  key,
  company: key,
  role: "Software Engineer",
  appliedAt: daysAgo(50),
  appliedAtKnown: true,
  appliedAtSource: "email",
  status: "applied",
  furthestStage: "applied",
  interviewRounds: [],
  activelyInterviewing: false,
  lastUpdateAt: daysAgo(40),
  emails: [],
  trackerJobId: `job-${key}`,
  trackerStatus: "applied",
});

const followUpApp = (key: string): GmailApplication => ({
  ...ghostedApp(key),
  status: "assessment",
  furthestStage: "assessment",
  lastUpdateAt: daysAgo(10),
});

const makeDeps = (over: Partial<AgentDeps> & { existing?: AgentSuggestion[]; allowed?: number } = {}) => {
  const saved: AgentSuggestion[] = [];
  const expired: string[][] = [];
  const deps: AgentDeps = {
    loadApps: async () => [ghostedApp("a"), followUpApp("b")],
    loadBudget: async () => ({
      monthlyUsd: 1.5,
      spentThisMonthUsd: 0,
      todayAllowanceUsd: 0.05,
      allowedUnits: over.allowed ?? 1,
      exhausted: false,
    }),
    run: vi.fn(async () => ({
      success: true,
      data: {
        items: [
          { i: 1, priority: 4, reason: "Nudge them on the assessment.", draft: "Hi there, ..." },
          { i: 2, priority: 1, reason: "No reply in 40 days.", draft: "should be dropped" },
        ],
      },
      diagnostics: { fallbackUsed: false },
    })),
    byIds: async (ids) => new Map((over.existing ?? []).filter((s) => ids.includes(s.id)).map((s) => [s.id, s])),
    save: async (s) => void saved.push(s),
    expireMissing: async (ids) => {
      expired.push(ids);
      return 0;
    },
    recordRun: async () => undefined,
    ...over,
  };
  return { deps, saved, expired };
};

describe("runDailyAgent", () => {
  it("has the agent rank and draft new steps, keeping drafts only where a draft makes sense", async () => {
    const { deps, saved } = makeDeps();
    const summary = await runDailyAgent(deps, NOW);
    expect(deps.run).toHaveBeenCalledTimes(1);
    const follow = saved.find((s) => s.kind === "follow_up")!;
    expect(saved.some((s) => s.kind === "mark_ghosted")).toBe(false);
    expect(follow).toMatchObject({ writtenBy: "agent", priority: 4, draft: "Hi there, ..." });
    expect(summary).toMatchObject({ candidates: 1, written: 1, budgetLimited: false });
  });

  it("falls back to free rule text when today's budget is spent", async () => {
    const { deps, saved } = makeDeps({ allowed: 0 });
    const summary = await runDailyAgent(deps, NOW);
    expect(deps.run).not.toHaveBeenCalled();
    expect(saved.every((s) => s.writtenBy === "rules" && !s.draft)).toBe(true);
    expect(summary.budgetLimited).toBe(true);
  });

  it("never brings back dismissed steps and doesn't pay twice for steps already written today", async () => {
    const earlierToday = new Date(NOW.getTime() - 3_600_000).toISOString();
    const base = { company: "x", role: null, title: "t", reason: "r", priority: 1, draftable: false, createdAt: daysAgo(1), updatedAt: earlierToday };
    const { deps, saved, expired } = makeDeps({
      existing: [
        { ...base, id: `follow_up:b:${daysAgo(10).slice(0, 10)}`, kind: "follow_up", appKey: "b", writtenBy: "agent", status: "open" },
      ],
    });
    const summary = await runDailyAgent(deps, NOW);
    expect(deps.run).not.toHaveBeenCalled();
    expect(saved).toEqual([]);
    expect(summary.candidates).toBe(1);
    expect(expired[0]).toEqual([`follow_up:b:${daysAgo(10).slice(0, 10)}`]);
  });

  it("rewrites steps the agent wrote on an earlier day, keeping the old draft if none comes back", async () => {
    const followId = `follow_up:b:${daysAgo(10).slice(0, 10)}`;
    const { deps, saved } = makeDeps({
      loadApps: async () => [followUpApp("b")],
      existing: [
        {
          id: followId, kind: "follow_up", appKey: "b", company: "b", role: null, title: "t", reason: "Interview in ~41 hours",
          priority: 3, draftable: true, draft: "Old draft", writtenBy: "agent", status: "open", createdAt: daysAgo(2), updatedAt: daysAgo(1),
        },
      ],
      run: vi.fn(async () => ({
        success: true,
        data: { items: [{ i: 1, priority: 5, reason: "Fresh reason.", draft: null }] },
        diagnostics: { fallbackUsed: false },
      })),
    });
    await runDailyAgent(deps, NOW);
    expect(deps.run).toHaveBeenCalledTimes(1);
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({ id: followId, reason: "Fresh reason.", priority: 5, draft: "Old draft", createdAt: daysAgo(2) });
  });
});

describe("approval gating", () => {
  const suggestion = (over: Partial<AgentSuggestion>): AgentSuggestion => ({
    id: "s1",
    kind: "follow_up",
    appKey: "a",
    company: "Acme",
    role: null,
    title: "t",
    reason: "r",
    priority: 3,
    draftable: true,
    writtenBy: "agent",
    status: "open",
    createdAt: daysAgo(1),
    updatedAt: daysAgo(1),
    ...over,
  });

  beforeEach(() => {
    store.clear();
    updateStatus.mockClear();
  });

  it("only changes the tracker when you approve a proposed change", async () => {
    store.set("g", suggestion({ id: "g", kind: "mark_ghosted", proposedChange: { jobId: "job-1", status: "lapsed" } }));
    const result = await approveSuggestion("g", NOW);
    expect(updateStatus).toHaveBeenCalledWith("job-1", "lapsed", "Approved from Next steps");
    expect(result.status).toBe("approved");
  });

  it("marks plain steps done without touching the tracker, and dismiss changes nothing", async () => {
    store.set("f", suggestion({ id: "f" }));
    store.set("d", suggestion({ id: "d", proposedChange: { jobId: "job-1", status: "lapsed" } }));
    expect((await approveSuggestion("f", NOW)).status).toBe("done");
    await dismissSuggestion("d", NOW);
    expect(updateStatus).not.toHaveBeenCalled();
    expect(store.get("d")!.status).toBe("dismissed");
  });

  it("refuses to act on a step that is no longer open", async () => {
    store.set("x", suggestion({ id: "x", status: "dismissed", proposedChange: { jobId: "job-1", status: "lapsed" } }));
    await expect(approveSuggestion("x", NOW)).rejects.toBeInstanceOf(SuggestionNotFoundError);
    expect(updateStatus).not.toHaveBeenCalled();
  });
});
