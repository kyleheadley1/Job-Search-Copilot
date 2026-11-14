import { beforeEach, describe, expect, it, vi } from "vitest";

const state = {
  evaluation: null as null | Record<string, unknown>,
  apps: [] as Array<Record<string, unknown>>,
  roles: new Map<string, string>(),
  notApplication: new Set<string>(),
  removed: new Set<string>(),
  upserts: [] as Array<Record<string, unknown>>,
};

vi.mock("../../services/gmail/gmailApplications.js", () => ({
  APPLICATION_IDENTITY_LOOKBACK_DAYS: 120,
  normalizeCompany: (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim(),
  roleTokens: (role: string) =>
    role
      .toLowerCase()
      .replace(/[^a-z0-9+#\- ]+/g, " ")
      .split(/\s+/)
      .filter(Boolean),
  getGmailApplications: async () => state.apps,
}));

vi.mock("../../services/gmail/gmailMessages.repository.js", () => ({
  gmailMessagesRepository: {
    setClassificationRole: async (id: string, role: string) => {
      state.roles.set(id, role);
    },
    setNotApplicationEmail: async (id: string) => {
      state.notApplication.add(id);
    },
  },
}));

vi.mock("../../services/gmail/jdRecovery/evaluations.repository.js", () => ({
  evaluationsRepository: {
    findByKey: async (key: string) => {
      if (state.evaluation && (state.evaluation as { key: string }).key === key) return state.evaluation;
      return state.upserts.find((row) => row.key === key) ?? null;
    },
    upsert: async (evaluation: Record<string, unknown>) => {
      state.upserts = state.upserts.filter((row) => row.key !== evaluation.key);
      state.upserts.push(evaluation);
    },
    remove: async (key: string) => {
      state.removed.add(key);
      if (state.evaluation && (state.evaluation as { key: string }).key === key) state.evaluation = null;
    },
  },
}));

vi.mock("../../services/gmail/jdRecovery/runRecovery.js", () => ({
  AlreadyScoredError: class AlreadyScoredError extends Error {
    constructor(message: string) {
      super(message);
      this.name = "AlreadyScoredError";
    }
  },
  EvaluationNotFoundError: class EvaluationNotFoundError extends Error {
    constructor(message: string) {
      super(message);
      this.name = "EvaluationNotFoundError";
    }
  },
}));

const { splitRoleLessByCandidates, CannotSplitRoleLessError } = await import(
  "../../services/gmail/jdRecovery/splitRoleLessApplication.js"
);

describe("splitRoleLessByCandidates", () => {
  beforeEach(() => {
    state.evaluation = {
      key: "flowcode::",
      company: "Flowcode",
      role: null,
      appliedAt: "2026-11-14T22:41:02.000Z",
      createdAt: "2026-11-14T22:41:02.000Z",
      updatedAt: "2026-11-14T22:44:03.000Z",
      outcome: { status: "applied", furthestStage: "applied", updatedAt: "2026-11-14T22:44:03.000Z", history: [] },
      recovery: {
        status: "not_found",
        notes: ["role_unknown"],
        attempts: [],
        serperQueries: 0,
        candidates: [
          {
            prospectId: "p1",
            source: "prospect",
            matchLevel: "high",
            title: "Applied AI Engineer: Solutions & Infrastructure",
            text: "x".repeat(400),
          },
          {
            prospectId: "p2",
            source: "prospect",
            matchLevel: "high",
            title: "Applied AI Engineer: Product & Experience",
            text: "y".repeat(400),
          },
        ],
      },
    };
    state.apps = [
      {
        key: "flowcode::",
        company: "Flowcode",
        role: null,
        emails: [
          {
            id: "e2",
            subject: "Thank you for applying to Flowcode",
            date: "2026-11-14T22:44:03.000Z",
            eventType: "applied",
          },
          {
            id: "sec",
            subject: "Security code for your application to Flowcode",
            date: "2026-11-14T22:42:16.000Z",
            eventType: "applied",
          },
          {
            id: "e1",
            subject: "Thank you for applying to Flowcode",
            date: "2026-11-14T22:41:02.000Z",
            eventType: "applied",
          },
        ],
      },
    ];
    state.roles.clear();
    state.notApplication.clear();
    state.removed.clear();
    state.upserts = [];
  });

  it("splits a role-less company row into one application per JD candidate", async () => {
    const result = await splitRoleLessByCandidates("flowcode::");
    expect(result.keys).toEqual([
      "flowcode::applied ai engineer solutions infrastructure",
      "flowcode::applied ai engineer product experience",
    ]);
    expect(state.roles.get("e1")).toBe("Applied AI Engineer: Solutions & Infrastructure");
    expect(state.roles.get("e2")).toBe("Applied AI Engineer: Product & Experience");
    expect(state.notApplication.has("sec")).toBe(true);
    expect(state.removed.has("flowcode::")).toBe(true);
    expect(result.evaluations.map((e) => e.recovery.candidates?.map((c) => c.prospectId))).toEqual([["p1"], ["p2"]]);
  });

  it("refuses to split when only one candidate remains", async () => {
    (state.evaluation as { recovery: { candidates: unknown[] } }).recovery.candidates = [
      {
        prospectId: "p1",
        source: "prospect",
        matchLevel: "high",
        title: "Applied AI Engineer: Solutions & Infrastructure",
        text: "x".repeat(400),
      },
    ];
    await expect(splitRoleLessByCandidates("flowcode::")).rejects.toBeInstanceOf(CannotSplitRoleLessError);
  });
});
