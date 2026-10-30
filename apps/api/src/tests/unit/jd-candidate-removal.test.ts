import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ApplicationEvaluation, RecoveryCandidate } from "../../services/gmail/jdRecovery/evaluations.repository.js";
import { submitJdCandidate } from "../../services/gmail/jdRecovery/jdCandidates.service.js";
import {
  excludedReviewRowsFromEvaluations,
  hasPendingJdConfirmation,
  pendingReviewRowsFromEvaluations,
  rejectReviewedCandidate,
  removeReviewedCandidate,
  restoreReviewedCandidate,
} from "../../services/gmail/jdRecovery/jdReview.service.js";
import { assessShadowEligibility } from "../../services/gmail/jdRecovery/jdShadowEligibility.js";
import { createJdRecoveryQueueService } from "../../services/gmail/jdRecovery/jdRecoveryQueue.service.js";
import type { SaveQueueOutcomeInput } from "../../services/gmail/jdRecovery/jdRecoveryQueue.repository.js";
import type { JdRecoveryQueueRecord } from "../../services/gmail/jdRecovery/jdRecoveryQueue.types.js";
import type { GmailApplication } from "../../services/gmail/gmailApplications.js";
import { buildMatchEvidenceSnapshot } from "../../services/gmail/jdRecovery/jdMatchEvidence.js";

const evals = new Map<string, ApplicationEvaluation>();

vi.mock("../../services/gmail/jdRecovery/evaluations.repository.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../services/gmail/jdRecovery/evaluations.repository.js")>();
  return {
    ...actual,
    evaluationsRepository: {
      findByKey: async (key: string) => evals.get(key) ?? null,
      upsertIfUnscored: async (evaluation: ApplicationEvaluation) => {
        const existing = evals.get(evaluation.key);
        if (existing?.recovery.status === "scored") return existing;
        evals.set(evaluation.key, evaluation);
        return evaluation;
      },
      listPendingJdReviews: async () => [...evals.values()].filter((row) => row.recovery.status !== "scored"),
    },
  };
});

vi.mock("../../services/gmail/jdRecovery/jdReviewDecisions.repository.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../services/gmail/jdRecovery/jdReviewDecisions.repository.js")>();
  return {
    ...actual,
    jdReviewDecisionsRepository: {
      insert: async () => undefined,
      listRecent: async () => [],
      listByApplicationKey: async () => [],
    },
  };
});

const FULL_JD = [
  "Forward Deployed Software Engineer",
  "Fluxcap",
  "",
  "Responsibilities",
  "- Work with design partners on production deployments",
  "- Write TypeScript services and debug customer issues",
  "",
  "Requirements",
  "- 4+ years of software engineering experience",
  "- Comfortable in customer-facing environments",
  "Build TypeScript services and React interfaces for our healthcare platform. ".repeat(8),
].join("\n");

const app = (over: Partial<GmailApplication> & Pick<GmailApplication, "key" | "company">): GmailApplication =>
  ({
    role: "Engineer",
    appliedAt: "2026-10-20T00:00:00.000Z",
    appliedAtKnown: true,
    appliedAtSource: "email",
    status: "applied",
    furthestStage: "applied",
    interviewRounds: [],
    activelyInterviewing: false,
    lastUpdateAt: "2026-10-21T00:00:00.000Z",
    emails: [],
    ...over,
  }) as GmailApplication;

const candidate = (over: Partial<RecoveryCandidate> & Pick<RecoveryCandidate, "url">): RecoveryCandidate => ({
  source: "mcp",
  matchLevel: "low",
  text: FULL_JD,
  completeness: "full",
  ...over,
});

const evaluationOf = (row: GmailApplication, candidates: RecoveryCandidate[]): ApplicationEvaluation =>
  ({
    key: row.key,
    company: row.company,
    role: row.role,
    appliedAt: row.appliedAt,
    recovery: { status: "unverified", attempts: [], serperQueries: 0, candidates },
    outcome: { status: row.status, updatedAt: row.appliedAt, history: [] },
    createdAt: row.appliedAt,
    updatedAt: row.appliedAt,
  }) as ApplicationEvaluation;

beforeEach(() => {
  evals.clear();
});

describe("candidate removal and restore", () => {
  it("removes one of three candidates without affecting siblings", async () => {
    const row = app({ key: "acme::eng", company: "Acme" });
    const candidates = [
      candidate({ url: "https://jobs.example/a", text: `${FULL_JD}\nNew York, NY onsite.` }),
      candidate({ url: "https://jobs.example/b", text: `${FULL_JD}\nNew York, NY hybrid.` }),
      candidate({ url: "https://jobs.example/c", text: `${FULL_JD}\nNew York, NY remote US.` }),
    ];
    evals.set(row.key, evaluationOf(row, candidates));
    await removeReviewedCandidate(row.key, "https://jobs.example/b", "listing_unavailable");
    const saved = evals.get(row.key)!;
    expect(saved.recovery.candidates?.map((item) => item.reviewStatus)).toEqual([undefined, "removed", undefined]);
    expect(saved.recovery.candidates?.[1]?.text).toContain("Forward Deployed");
    expect(saved.key).toBe("acme::eng");
    const active = pendingReviewRowsFromEvaluations([saved]);
    expect(active.map((item) => item.sourceUrl)).toEqual(["https://jobs.example/a", "https://jobs.example/c"]);
  });

  it("removes a dead URL with no stored JD", async () => {
    const row = app({ key: "dead::eng", company: "DeadCo" });
    evals.set(
      row.key,
      evaluationOf(row, [candidate({ url: "https://jobs.example/gone", text: "", completeness: "partial" })]),
    );
    await removeReviewedCandidate(row.key, "https://jobs.example/gone", "no_usable_jd");
    const saved = evals.get(row.key)!.recovery.candidates![0]!;
    expect(saved.reviewStatus).toBe("removed");
    expect(saved.removalReason).toBe("no_usable_jd");
    expect(saved.text).toBe("");
    expect(pendingReviewRowsFromEvaluations([evals.get(row.key)!])).toEqual([]);
  });

  it("removes a dead URL while preserving a complete saved JD", async () => {
    const row = app({ key: "keep::eng", company: "KeepCo" });
    evals.set(row.key, evaluationOf(row, [candidate({ url: "https://jobs.example/expired", text: FULL_JD, completeness: "full" })]));
    const beforeHash = FULL_JD.length;
    await removeReviewedCandidate(row.key, "https://jobs.example/expired", "listing_unavailable");
    const saved = evals.get(row.key)!.recovery.candidates![0]!;
    expect(saved.text.length).toBe(beforeHash);
    expect(saved.completeness).toBe("full");
    expect(saved.reviewStatus).toBe("removed");
    const excluded = excludedReviewRowsFromEvaluations([evals.get(row.key)!]);
    expect(excluded[0]?.availability).toBe("listing_unavailable");
  });

  it("removes a temporarily inaccessible URL when the user asks", async () => {
    const row = app({ key: "tmp::eng", company: "TmpCo" });
    evals.set(
      row.key,
      evaluationOf(row, [candidate({ url: "https://jobs.example/loginwall", text: "Please complete the bot check to continue." })]),
    );
    await removeReviewedCandidate(row.key, "https://jobs.example/loginwall", "other");
    expect(evals.get(row.key)!.recovery.candidates![0]!.removalReason).toBe("other");
  });

  it("restores a removed candidate without scoring", async () => {
    const row = app({ key: "rest::eng", company: "RestCo" });
    evals.set(row.key, evaluationOf(row, [candidate({ url: "https://jobs.example/nyc", text: `${FULL_JD}\nNew York, NY` })]));
    await removeReviewedCandidate(row.key, "https://jobs.example/nyc", "wrong_posting");
    const restored = await restoreReviewedCandidate(row.key, "https://jobs.example/nyc");
    expect(restored.evaluation.recovery.status).toBe("unverified");
    expect(restored.evaluation.fit).toBeUndefined();
    expect(restored.evaluation.recovery.candidates![0]!.reviewStatus).toBe("pending");
    expect(restored.evaluation.recovery.candidates![0]!.geoOverride).toBe(true);
    expect(pendingReviewRowsFromEvaluations([restored.evaluation])).toHaveLength(1);
  });

  it("does not reactivate a removed URL on duplicate submit", async () => {
    const gmail = app({ key: "dup::eng", company: "DupCo" });
    const existing = candidate({
      url: "https://jobs.example/dup",
      reviewStatus: "removed",
      removalReason: "listing_unavailable",
      text: FULL_JD,
    });
    const evaluations = new Map<string, ApplicationEvaluation>([[gmail.key, evaluationOf(gmail, [existing])]]);
    const store = {
      getApplications: async () => [gmail],
      findByKey: async (key: string) => evaluations.get(key) ?? null,
      upsertIfUnscored: async (evaluation: ApplicationEvaluation) => {
        evaluations.set(evaluation.key, evaluation);
        return evaluation;
      },
    };
    const result = await submitJdCandidate(
      {
        applicationKey: gmail.key,
        company: "DupCo",
        originalText: FULL_JD,
        sourceUrl: "https://jobs.example/dup?utm_source=x",
        sourceType: "ats",
        matchEvidence: ["same url"],
        completeness: "full",
      },
      store,
      120,
    );
    expect(result.status).toBe("previously_removed");
    expect(result.reviewRequired).toBe(false);
    expect(result.previouslyRemoved).toBe(true);
    expect(evaluations.get(gmail.key)!.recovery.candidates).toHaveLength(1);
    expect(evaluations.get(gmail.key)!.recovery.candidates![0]!.reviewStatus).toBe("removed");
  });

  it("keeps distinct URLs for the same application", async () => {
    const row = app({ key: "multi::eng", company: "Multi" });
    evals.set(
      row.key,
      evaluationOf(row, [
        candidate({ url: "https://jobs.example/backend", text: `${FULL_JD}\nNew York` }),
        candidate({ url: "https://jobs.example/frontend", text: `${FULL_JD}\nNew York` }),
      ]),
    );
    await removeReviewedCandidate(row.key, "https://jobs.example/backend", "wrong_posting");
    expect(evals.get(row.key)!.recovery.candidates?.map((item) => item.url)).toEqual([
      "https://jobs.example/backend",
      "https://jobs.example/frontend",
    ]);
    expect(evals.get(row.key)!.recovery.candidates?.[1]?.reviewStatus).not.toBe("removed");
  });

  it("clears pending review when every candidate is removed", async () => {
    const row = app({ key: "all::eng", company: "AllCo" });
    evals.set(
      row.key,
      evaluationOf(row, [
        candidate({ url: "https://jobs.example/1", text: `${FULL_JD}\nNew York` }),
        candidate({ url: "https://jobs.example/2", text: `${FULL_JD}\nNew York` }),
      ]),
    );
    await removeReviewedCandidate(row.key, "https://jobs.example/1", "listing_unavailable");
    expect(hasPendingJdConfirmation(evals.get(row.key)!)).toBe(true);
    await removeReviewedCandidate(row.key, "https://jobs.example/2", "listing_unavailable");
    expect(hasPendingJdConfirmation(evals.get(row.key)!)).toBe(false);
    expect(evals.get(row.key)!.recovery.status).toBe("unverified");
  });

  it("does not change a scored application", async () => {
    const row = app({ key: "scored::eng", company: "ScoredCo" });
    const scored = evaluationOf(row, [candidate({ url: "https://jobs.example/s" })]);
    scored.recovery.status = "scored";
    scored.fit = { total: 70, recommendation: "apply", recommendedResume: "BASE", scoredAt: row.appliedAt, promptVersion: "v1" };
    scored.jd = { text: FULL_JD, textHash: "abc123" };
    evals.set(row.key, scored);
    await expect(removeReviewedCandidate(row.key, "https://jobs.example/s", "other")).rejects.toMatchObject({ name: "AlreadyScoredError" });
    expect(evals.get(row.key)!.fit?.total).toBe(70);
    expect(evals.get(row.key)!.jd?.textHash).toBe("abc123");
  });

  it("does not treat a wrong-location sibling as invalidating the NYC candidate", () => {
    const row = app({ key: "sib::eng", company: "SibCo" });
    const nyc = candidate({ url: "https://jobs.example/nyc", text: `${FULL_JD}\nOnsite in New York, NY.`, location: "New York, NY" });
    const seattle = candidate({
      url: "https://jobs.example/seattle",
      text: `${FULL_JD}\nOnsite in Seattle, WA.`,
      location: "Seattle, WA",
    });
    const evaluation = evaluationOf(row, [nyc, seattle]);
    const active = pendingReviewRowsFromEvaluations([evaluation]);
    const excluded = excludedReviewRowsFromEvaluations([evaluation]);
    expect(active.map((item) => item.sourceUrl)).toEqual(["https://jobs.example/nyc"]);
    expect(excluded.map((item) => item.sourceUrl)).toEqual(["https://jobs.example/seattle"]);
    expect(excluded[0]?.geo.status).toBe("incompatible");
  });

  it("keeps a red-zone heuristic candidate in the active review list", () => {
    const row = app({ key: "red::eng", company: "RedCo" });
    const evaluation = evaluationOf(row, [
      candidate({
        url: "https://jobs.example/williamsburg",
        text: `${FULL_JD}\nOnsite in Williamsburg, Brooklyn.`,
        location: "Williamsburg, Brooklyn",
      }),
    ]);
    const active = pendingReviewRowsFromEvaluations([evaluation]);
    const excluded = excludedReviewRowsFromEvaluations([evaluation]);
    expect(active.map((item) => item.sourceUrl)).toEqual(["https://jobs.example/williamsburg"]);
    expect(active[0]?.geo.status).toBe("needs_review");
    expect(active[0]?.geo.excludedFromDefaultReview).toBe(false);
    expect(excluded).toEqual([]);
  });
});

describe("queue reeligibility after removal", () => {
  const memoryStore = () => {
    const rows = new Map<string, JdRecoveryQueueRecord>();
    return {
      rows,
      findByKey: async (key: string) => (rows.has(key) ? structuredClone(rows.get(key)!) : null),
      findByKeys: async (keys: string[]) => {
        const map = new Map<string, JdRecoveryQueueRecord>();
        for (const key of keys) {
          const row = rows.get(key);
          if (row) map.set(key, structuredClone(row));
        }
        return map;
      },
      listAll: async () => [...rows.values()].map((row) => structuredClone(row)),
      claimAtomic: async ({ key, sessionId, batchId, nowIso, leaseExpiresAt }: { key: string; sessionId: string; batchId: string; nowIso: string; leaseExpiresAt: string }) => {
        const current = rows.get(key);
        if (current?.leaseExpiresAt && current.leaseExpiresAt > nowIso) return null;
        const next: JdRecoveryQueueRecord = {
          applicationKey: key,
          status: "in_progress",
          attemptCount: current?.attemptCount ?? 0,
          candidateCount: current?.candidateCount ?? 0,
          createdAt: current?.createdAt ?? nowIso,
          updatedAt: nowIso,
          lastAttemptAt: nowIso,
          lastClaimBatchId: batchId,
          leaseOwner: sessionId,
          leaseExpiresAt,
        };
        rows.set(key, next);
        return structuredClone(next);
      },
      saveOutcome: async (input: SaveQueueOutcomeInput) => {
        const current = rows.get(input.applicationKey);
        const next: JdRecoveryQueueRecord = {
          applicationKey: input.applicationKey,
          status: input.status,
          attemptCount: (current?.attemptCount ?? 0) + (input.incrementAttempt ? 1 : 0),
          candidateCount: input.candidateCount ?? current?.candidateCount ?? 0,
          createdAt: current?.createdAt ?? input.nowIso,
          updatedAt: input.nowIso,
          lastAttemptAt: input.nowIso,
          lastOutcome: input.lastOutcome,
          lastFailureReason: input.lastFailureReason,
          nextRetryAt: input.nextRetryAt === null ? undefined : (input.nextRetryAt ?? current?.nextRetryAt),
        };
        rows.set(input.applicationKey, next);
        return structuredClone(next);
      },
    };
  };

  it("applies retry backoff instead of an immediate reclaim loop", async () => {
    const gmail = app({ key: "loop::eng", company: "LoopCo" });
    const evaluation = evaluationOf(gmail, []);
    const store = memoryStore();
    const service = createJdRecoveryQueueService({
      getApplications: async () => [gmail],
      getEvaluationsByKeys: async () => new Map([[gmail.key, evaluation]]),
      store,
      now: () => new Date("2026-10-30T12:00:00.000Z"),
    });
    await service.claim({ limit: 1, sessionId: "session-loop1" });
    await service.syncAfterReviewChange(evaluation);
    const immediately = await service.claim({ limit: 1, sessionId: "session-loop2" });
    expect(immediately.claimed).toEqual([]);
    expect(store.rows.get(gmail.key)?.lastFailureReason).toBe("no_actionable_candidates");
    expect(store.rows.get(gmail.key)?.nextRetryAt).toBe("2026-10-30T13:00:00.000Z");
  });

  it("applies the same backoff when no queue row exists yet", async () => {
    const gmail = app({ key: "fresh::eng", company: "FreshCo" });
    const evaluation = evaluationOf(gmail, []);
    const store = memoryStore();
    const service = createJdRecoveryQueueService({
      getApplications: async () => [gmail],
      getEvaluationsByKeys: async () => new Map([[gmail.key, evaluation]]),
      store,
      now: () => new Date("2026-10-30T12:00:00.000Z"),
    });
    expect(store.rows.size).toBe(0);
    await service.syncAfterReviewChange(evaluation);
    expect(store.rows.get(gmail.key)?.lastFailureReason).toBe("no_actionable_candidates");
    expect(store.rows.get(gmail.key)?.nextRetryAt).toBe("2026-10-30T13:00:00.000Z");
    const immediately = await service.claim({ limit: 1, sessionId: "session-fresh1" });
    expect(immediately.claimed).toEqual([]);
  });
});

describe("shadow and evidence after removal", () => {
  it("excludes removed candidates from active shadow eligibility", () => {
    const snapshot = buildMatchEvidenceSnapshot({
      applicationKey: "acme::eng",
      company: "Acme",
      role: "Engineer",
      appliedAt: "2026-10-01T00:00:00.000Z",
      appliedAtKnown: true,
      candidate: {
        url: "https://jobs.ashbyhq.com/acme/eng",
        sourceType: "ats",
        title: "Engineer",
        company: "Acme",
        completeness: "full",
        text: FULL_JD,
      },
    });
    const shadow = assessShadowEligibility(snapshot, { reviewStatus: "removed" });
    expect(shadow.recommendation).not.toBe("eligible_for_auto_confirmation");
    expect(shadow.autoConfirmEnabled).toBe(false);
    expect(shadow.blockers).toContain("removed_from_review");
  });

  it("keeps original evidence snapshots on human review decisions", async () => {
    const row = app({ key: "ev::eng", company: "EvCo" });
    const snap = buildMatchEvidenceSnapshot({
      applicationKey: row.key,
      company: row.company,
      role: row.role,
      appliedAt: row.appliedAt,
      appliedAtKnown: true,
      candidate: { url: "https://jobs.example/ev", sourceType: "ats", title: "Engineer", completeness: "full", text: FULL_JD },
    });
    evals.set(
      row.key,
      evaluationOf(row, [candidate({ url: "https://jobs.example/ev", text: FULL_JD, evidenceSnapshot: snap })]),
    );
    await rejectReviewedCandidate(row.key, "https://jobs.example/ev", "not the role");
    expect(evals.get(row.key)!.recovery.candidates![0]!.evidenceSnapshot).toEqual(snap);
  });
});
