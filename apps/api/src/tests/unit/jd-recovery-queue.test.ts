import { describe, expect, it } from "vitest";
import type { GmailApplication } from "../../services/gmail/gmailApplications.js";
import type { ApplicationEvaluation } from "../../services/gmail/jdRecovery/evaluations.repository.js";
import { submitJdCandidate } from "../../services/gmail/jdRecovery/jdCandidates.service.js";
import type { SaveQueueOutcomeInput } from "../../services/gmail/jdRecovery/jdRecoveryQueue.repository.js";
import {
  createJdRecoveryQueueService,
  deriveEffectiveRecoveryStatus,
  hasPendingJdConfirmation,
  type JdRecoveryQueueStore,
} from "../../services/gmail/jdRecovery/jdRecoveryQueue.service.js";
import type { JdRecoveryQueueRecord } from "../../services/gmail/jdRecovery/jdRecoveryQueue.types.js";
import { JD_RECOVERY_NOT_FOUND_RETRY_DAYS } from "../../services/gmail/jdRecovery/jdRecoveryQueue.types.js";

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
    emails: [
      {
        id: "m1",
        subject: "Thanks for applying",
        from: "recruiter@example.com",
        date: "2026-10-01T00:00:00.000Z",
        eventType: "applied",
        gmailUrl: "https://mail.google.com/mail/u/0/#inbox/m1",
      },
    ],
    ...over,
  }) as GmailApplication;

const evaluation = (
  row: GmailApplication,
  over: Partial<ApplicationEvaluation> = {},
): ApplicationEvaluation =>
  ({
    key: row.key,
    company: row.company,
    role: row.role,
    appliedAt: row.appliedAt,
    recovery: { status: "not_found", attempts: [], serperQueries: 0 },
    outcome: { status: row.status, updatedAt: row.appliedAt, history: [] },
    createdAt: row.appliedAt,
    updatedAt: row.appliedAt,
    ...over,
  }) as ApplicationEvaluation;

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

const memoryStore = (): JdRecoveryQueueStore & { rows: Map<string, JdRecoveryQueueRecord> } => {
  const rows = new Map<string, JdRecoveryQueueRecord>();
  return {
    rows,
    findByKey: async (key) => (rows.has(key) ? structuredClone(rows.get(key)!) : null),
    findByKeys: async (keys) => {
      const map = new Map<string, JdRecoveryQueueRecord>();
      for (const key of keys) {
        const row = rows.get(key);
        if (row) map.set(key, structuredClone(row));
      }
      return map;
    },
    listAll: async () => [...rows.values()].map((row) => structuredClone(row)),
    claimAtomic: async ({ key, sessionId, batchId, nowIso, leaseExpiresAt }) => {
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
        lastOutcome: current?.lastOutcome,
        lastFailureReason: current?.lastFailureReason,
        nextRetryAt: current?.nextRetryAt,
        lastCandidateSourceUrl: current?.lastCandidateSourceUrl,
        evidence: current?.evidence,
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
        lastCandidateSourceUrl: input.lastCandidateSourceUrl ?? current?.lastCandidateSourceUrl,
        evidence: input.evidence ?? current?.evidence,
        lastClaimBatchId: current?.lastClaimBatchId,
      };
      rows.set(input.applicationKey, next);
      return structuredClone(next);
    },
  };
};

const keys = (prefix: string, count: number) =>
  Array.from({ length: count }, (_, i) =>
    app({
      key: `${prefix}::role ${String(i + 1).padStart(2, "0")}`,
      company: prefix,
      role: `Role ${i + 1}`,
      appliedAt: `2026-09-${String(i + 1).padStart(2, "0")}T00:00:00.000Z`,
    }),
  );

const progressSum = (progress: {
  scored: number;
  unattempted: number;
  inProgress: number;
  pendingHumanJdReview: number;
  notFoundRetryNotDue: number;
  skippedRequiresReview?: number;
  notAJobPosting?: number;
  retryDue: number;
  temporaryFailures: number;
}) =>
  progress.scored +
  progress.unattempted +
  progress.inProgress +
  progress.pendingHumanJdReview +
  progress.notFoundRetryNotDue +
  (progress.skippedRequiresReview ?? 0) +
  (progress.notAJobPosting ?? 0) +
  progress.retryDue +
  progress.temporaryFailures;

describe("deriveEffectiveRecoveryStatus", () => {
  it("treats missing queue records as unattempted and scored evaluations as completed", () => {
    expect(deriveEffectiveRecoveryStatus(undefined, undefined, "2026-10-29T00:00:00.000Z")).toBe("unattempted");
    const scored = evaluation(app({ key: "a::b", company: "A" }), {
      recovery: { status: "scored", attempts: [], serperQueries: 0 },
    });
    expect(deriveEffectiveRecoveryStatus(scored, undefined, "2026-10-29T00:00:00.000Z")).toBe("completed");
  });

  it("keeps automated recovery not_found as unattempted until Claude records an outcome", () => {
    const automated = evaluation(app({ key: "a::b", company: "A" }), {
      recovery: { status: "not_found", reason: "no_board_found", attempts: [], serperQueries: 0 },
    });
    expect(deriveEffectiveRecoveryStatus(automated, undefined, "2026-10-29T00:00:00.000Z")).toBe("unattempted");
  });

  it("derives pending review from evaluation candidates, not the queue copy", () => {
    const pending = evaluation(app({ key: "a::b", company: "A" }), {
      recovery: {
        status: "unverified",
        attempts: [],
        serperQueries: 0,
        candidates: [{ url: "https://jobs.example/1", source: "mcp", matchLevel: "low", text: "JD" }],
      },
    });
    expect(hasPendingJdConfirmation(pending)).toBe(true);
    expect(deriveEffectiveRecoveryStatus(pending, undefined, "2026-10-29T00:00:00.000Z")).toBe(
      "candidate_pending_review",
    );
  });

  it("keeps skipped_requires_review distinct from not_found even when stored status is not_found", () => {
    const ciscoShaped = {
      applicationKey: "cisco::fy26 software engineer full stack application development time united states req 2000127",
      status: "not_found" as const,
      lastOutcome: "skipped_requires_review" as const,
      attemptCount: 1,
      candidateCount: 0,
      createdAt: "2026-10-29T12:00:00.000Z",
      updatedAt: "2026-10-29T12:05:00.000Z",
      lastAttemptAt: "2026-10-29T12:05:00.000Z",
      lastFailureReason: "Conflicting requisition IDs: search used 2000127, stored requisitionId is 2000087",
    };
    expect(
      deriveEffectiveRecoveryStatus(undefined, ciscoShaped, "2026-10-29T12:10:00.000Z"),
    ).toBe("skipped_requires_review");
  });

  it("does not treat a skipped lastOutcome with no nextRetryAt as retry_due", () => {
    const skippedNoRetry = {
      applicationKey: "skip::eng",
      status: "not_found" as const,
      lastOutcome: "skipped_requires_review" as const,
      attemptCount: 1,
      candidateCount: 0,
      createdAt: "2026-10-29T12:00:00.000Z",
      updatedAt: "2026-10-29T12:05:00.000Z",
    };
    expect(deriveEffectiveRecoveryStatus(undefined, skippedNoRetry, "2026-11-10T00:00:00.000Z")).toBe(
      "skipped_requires_review",
    );
  });
});

describe("JD recovery queue service", () => {
  const setup = (
    apps: GmailApplication[],
    evaluations: ApplicationEvaluation[] = [],
    initial = new Date("2026-10-29T12:00:00.000Z"),
  ) => {
    const store = memoryStore();
    const clock = { now: initial };
    const evalMap = new Map(evaluations.map((row) => [row.key, row]));
    const service = createJdRecoveryQueueService({
      getApplications: async () => apps,
      getEvaluationsByKeys: async (wanted) => {
        const map = new Map<string, ApplicationEvaluation>();
        for (const key of wanted) {
          const row = evalMap.get(key);
          if (row) map.set(key, row);
        }
        return map;
      },
      store,
      now: () => clock.now,
    });
    return {
      service,
      store,
      evalMap,
      setNow: (next: Date) => {
        clock.now = next;
      },
    };
  };

  it("claims five never-attempted jobs and does not return them on the next claim", async () => {
    const apps = keys("co", 8);
    const { service } = setup(apps);
    const first = await service.claim({ limit: 5, sessionId: "session-aaaa" });
    expect(first.claimed).toHaveLength(5);
    expect(first.claimed.map((row) => row.applicationKey)).toEqual([
      "co::role 08",
      "co::role 07",
      "co::role 06",
      "co::role 05",
      "co::role 04",
    ]);
    expect(first.remainingEligible.unattempted).toBe(3);
    expect(JSON.stringify(first)).not.toContain("recruiter@example.com");
    expect(JSON.stringify(first)).not.toContain("mail.google.com");
    const second = await service.claim({ limit: 5, sessionId: "session-aaaa" });
    expect(second.claimed.map((row) => row.applicationKey)).toEqual(["co::role 03", "co::role 02", "co::role 01"]);
    expect(second.claimed.some((row) => first.claimed.some((item) => item.applicationKey === row.applicationKey))).toBe(
      false,
    );
  });

  it("claims the newest unattempted application first and keeps older ones recoverable", async () => {
    const apps = [
      app({ key: "acme::backend", company: "Acme", role: "Backend", appliedAt: "2026-06-01T00:00:00.000Z" }),
      app({ key: "acme::frontend", company: "Acme", role: "Frontend", appliedAt: "2026-10-20T00:00:00.000Z" }),
      app({ key: "beta::pm", company: "Beta", role: "PM", appliedAt: "2026-09-01T00:00:00.000Z" }),
    ];
    const { service } = setup(apps);
    const first = await service.claim({ limit: 1, sessionId: "session-recent1" });
    expect(first.claimed.map((row) => row.applicationKey)).toEqual(["acme::frontend"]);
    expect(first.remainingEligible.unattempted).toBe(2);
    const second = await service.claim({ limit: 2, sessionId: "session-recent2" });
    expect(second.claimed.map((row) => row.applicationKey)).toEqual(["beta::pm", "acme::backend"]);
  });

  it("excludes scored applications, pending candidates, and not_found until retry", async () => {
    const apps = keys("mix", 4);
    const evaluations = [
      evaluation(apps[0]!, {
        recovery: { status: "scored", attempts: [], serperQueries: 0, foundVia: "prospect", match: { level: "high", signals: ["prospect_auto_attached"] } },
      }),
      evaluation(apps[1]!, {
        recovery: {
          status: "unverified",
          attempts: [],
          serperQueries: 0,
          candidates: [{ url: "https://jobs.example/pending", source: "mcp", matchLevel: "low", text: "JD" }],
        },
      }),
    ];
    const { service } = setup(apps, evaluations);
    const claimed = await service.claim({ limit: 1, sessionId: "session-cccc" });
    expect(claimed.claimed.map((row) => row.applicationKey)).toEqual(["mix::role 04"]);
    await service.record({
      applicationKey: "mix::role 04",
      outcome: "not_found",
      reason: "No current posting on the careers page",
    });
    const again = await service.claim({ limit: 5, sessionId: "session-dddd" });
    expect(again.claimed.map((row) => row.applicationKey)).toEqual(["mix::role 03"]);
  });

  it("includes retry_due only after unattempted work, or in retry_only mode", async () => {
    const apps = keys("retry", 3);
    const { service, setNow } = setup(apps);
    const first = await service.claim({ limit: 1, sessionId: "session-eeee" });
    expect(first.claimed.map((row) => row.applicationKey)).toEqual(["retry::role 03"]);
    await service.record({
      applicationKey: "retry::role 03",
      outcome: "not_found",
      reason: "Closed requisition",
    });
    const beforeRetry = await service.claim({ limit: 1, sessionId: "session-ffff" });
    expect(beforeRetry.claimed.map((row) => row.applicationKey)).toEqual(["retry::role 02"]);
    await service.record({
      applicationKey: "retry::role 02",
      outcome: "temporary_error",
      reason: "Careers page timed out",
    });
    setNow(new Date("2026-11-06T12:00:00.000Z"));
    const defaultAfter = await service.claim({ limit: 1, sessionId: "session-gggg" });
    expect(defaultAfter.claimed.map((row) => row.applicationKey)).toEqual(["retry::role 01"]);
    const retryOnly = await service.claim({ limit: 5, mode: "retry_only", sessionId: "session-hhhh" });
    expect(retryOnly.claimed.map((row) => row.applicationKey)).toEqual(["retry::role 03", "retry::role 02"]);
  });

  it("excludes skipped_requires_review unless includeSkipped is set", async () => {
    const apps = [app({ key: "skip::eng", company: "Skip", role: "Eng" })];
    const { service, store } = setup(apps);
    await service.claim({ limit: 1, sessionId: "session-skip1" });
    const recorded = await service.record({
      applicationKey: "skip::eng",
      outcome: "skipped_requires_review",
      reason: "Company name is too generic to search safely",
    });
    expect(recorded.recorded).toBe(true);
    expect(recorded.queueStatus).toBe("skipped_requires_review");
    expect(recorded.effectiveStatus).toBe("skipped_requires_review");
    expect(recorded.retryAt).toBeUndefined();
    expect(recorded.note).toMatch(/not scheduled for automatic retry/i);
    expect(store.rows.get("skip::eng")).toMatchObject({
      status: "skipped_requires_review",
      lastOutcome: "skipped_requires_review",
      nextRetryAt: undefined,
    });
    const progress = await service.progress();
    expect(progress.skippedRequiresReview).toBe(1);
    expect(progress.notFoundRetryNotDue).toBe(0);
    expect(progress.retryDue).toBe(0);
    expect(progressSum(progress)).toBe(progress.total);
    expect((await service.claim({ limit: 5, sessionId: "session-skip2" })).claimed).toEqual([]);
    expect((await service.claim({ limit: 5, mode: "retry_only", sessionId: "session-skip3" })).claimed).toEqual([]);
    const included = await service.claim({
      limit: 5,
      includeSkipped: true,
      sessionId: "session-skip4",
    });
    expect(included.claimed.map((row) => row.applicationKey)).toEqual(["skip::eng"]);
  });

  it("does not auto-retry a legacy skipped row whose stored status is not_found", async () => {
    const apps = [
      app({
        key: "cisco::fy26 software engineer full stack application development time united states req 2000127",
        company: "Cisco",
        role: "Software Engineer",
      }),
    ];
    const { service, store } = setup(apps);
    store.rows.set(
      "cisco::fy26 software engineer full stack application development time united states req 2000127",
      {
        applicationKey:
          "cisco::fy26 software engineer full stack application development time united states req 2000127",
        status: "not_found",
        lastOutcome: "skipped_requires_review",
        attemptCount: 1,
        candidateCount: 0,
        createdAt: "2026-10-29T12:00:00.000Z",
        updatedAt: "2026-10-29T12:05:00.000Z",
        lastAttemptAt: "2026-10-29T12:05:00.000Z",
        lastFailureReason: "Conflicting requisition IDs: search used 2000127, stored requisitionId is 2000087",
      },
    );
    expect((await service.claim({ limit: 5, sessionId: "session-cisco1" })).claimed).toEqual([]);
    expect((await service.claim({ limit: 5, mode: "retry_only", sessionId: "session-cisco2" })).claimed).toEqual([]);
    const progress = await service.progress();
    expect(progress.skippedRequiresReview).toBe(1);
    expect(progress.retryDue).toBe(0);
    expect(progress.notFoundRetryNotDue).toBe(0);
    expect(progressSum(progress)).toBe(progress.total);
  });

  it("recovers an expired lease without returning an active one", async () => {
    const apps = keys("lease", 2);
    const { service, store } = setup(apps, [], new Date("2026-10-29T12:00:00.000Z"));
    const first = await service.claim({ limit: 1, sessionId: "session-hhhh" });
    expect(first.claimed[0]?.applicationKey).toBe("lease::role 02");
    const held = store.rows.get("lease::role 02")!;
    store.rows.set("lease::role 02", { ...held, leaseExpiresAt: "2026-10-29T11:00:00.000Z" });
    const recovered = await service.claim({ limit: 2, sessionId: "session-iiii" });
    expect(recovered.claimed.map((row) => row.applicationKey)).toEqual(["lease::role 02", "lease::role 01"]);
  });

  it("keeps a submitted candidate pending across a new service instance and completes only when scored", async () => {
    const apps = [app({ key: "fluxcap::fde", company: "Fluxcap", role: "FDE" })];
    const evalMap = new Map<string, ApplicationEvaluation>();
    const store = memoryStore();
    const clock = { now: new Date("2026-10-29T12:00:00.000Z") };
    const runtime = {
      getApplications: async () => apps,
      getEvaluationsByKeys: async (wanted: string[]) => {
        const map = new Map<string, ApplicationEvaluation>();
        for (const key of wanted) {
          const row = evalMap.get(key);
          if (row) map.set(key, row);
        }
        return map;
      },
      store,
      now: () => clock.now,
    };
    const service = createJdRecoveryQueueService(runtime);
    await service.claim({ limit: 1, sessionId: "session-jjjj" });
    const submitted = await submitJdCandidate(
      {
        applicationKey: "fluxcap::fde",
        company: "Fluxcap",
        originalText: FULL_JD,
        sourceUrl: "https://jobs.ashbyhq.com/fluxcap/fde",
        sourceType: "ats",
        matchEvidence: ["Exact company and title on the ATS posting"],
        completeness: "full",
      },
      {
        getApplications: async () => apps,
        findByKey: async (key) => evalMap.get(key) ?? null,
        upsertIfUnscored: async (row) => {
          evalMap.set(row.key, structuredClone(row));
          return structuredClone(row);
        },
      },
      120,
    );
    await service.syncAfterCandidateSubmitted(submitted);
    const restarted = createJdRecoveryQueueService(runtime);
    const progress = await restarted.progress({ days: 120 });
    expect(progress.pendingHumanJdReview).toBe(1);
    expect(progress.unattempted).toBe(0);
    expect(progressSum(progress)).toBe(progress.total);
    const next = await restarted.claim({ limit: 5, sessionId: "session-kkkk" });
    expect(next.claimed).toEqual([]);
    const recorded = await restarted.record({
      applicationKey: "fluxcap::fde",
      outcome: "candidate_submitted",
    });
    expect(recorded.completed).toBe(false);
    expect(recorded.queueStatus).toBe("candidate_pending_review");

    evalMap.set("fluxcap::fde", {
      ...evalMap.get("fluxcap::fde")!,
      recovery: { ...evalMap.get("fluxcap::fde")!.recovery, status: "scored" },
      fit: {
        total: 70,
        recommendation: "apply",
        recommendedResume: "BASE",
        scoredAt: "2026-10-29T13:00:00.000Z",
        promptVersion: "v1",
      },
    });
    const afterScore = await restarted.progress({ days: 120 });
    expect(afterScore.scored).toBe(1);
    expect(afterScore.pendingHumanJdReview).toBe(0);
    expect(progressSum(afterScore)).toBe(afterScore.total);
    const afterClaim = await restarted.claim({ limit: 5, sessionId: "session-llll" });
    expect(afterClaim.claimed).toEqual([]);
  });

  it("does not mark candidate_submitted complete without an authoritative candidate", async () => {
    const apps = [app({ key: "open::eng", company: "Open", role: "Eng" })];
    const { service } = setup(apps);
    await service.claim({ limit: 1, sessionId: "session-mmmm" });
    const result = await service.record({
      applicationKey: "open::eng",
      outcome: "candidate_submitted",
    });
    expect(result.recorded).toBe(false);
    expect(result.error).toBe("CANDIDATE_NOT_SUBMITTED");
  });

  it("keeps not_found retry at seven days and temporary errors distinct", async () => {
    const apps = [
      app({ key: "tmp::eng", company: "Tmp", role: "Eng" }),
      app({ key: "tmp::pm", company: "Tmp", role: "PM", appliedAt: "2026-10-02T00:00:00.000Z" }),
    ];
    const { service } = setup(apps, [], new Date("2026-10-29T12:00:00.000Z"));
    await service.claim({ limit: 2, sessionId: "session-nnnn" });
    const missed = await service.record({
      applicationKey: "tmp::eng",
      outcome: "not_found",
      reason: "Careers page has no matching requisition",
    });
    expect(missed.retryAt).toBe(
      new Date(
        Date.parse("2026-10-29T12:00:00.000Z") + JD_RECOVERY_NOT_FOUND_RETRY_DAYS * 24 * 60 * 60 * 1000,
      ).toISOString(),
    );
    await service.record({
      applicationKey: "tmp::pm",
      outcome: "temporary_error",
      reason: "Network timeout fetching the ATS board",
    });
    const progress = await service.progress();
    expect(progress.notFoundRetryNotDue).toBe(1);
    expect(progress.temporaryFailures).toBe(1);
    expect(progress.skippedRequiresReview).toBe(0);
    expect(progressSum(progress)).toBe(progress.total);
  });

  it("claims identity-stable keys even when the eligibility window is short", async () => {
    const roleless = app({
      key: "axle::",
      company: "Axle",
      role: null,
      appliedAt: "2026-10-12T18:34:52.000Z",
      lastUpdateAt: "2026-10-12T18:34:52.000Z",
    });
    const complete = app({
      key: "axle::product engineer",
      company: "Axle",
      role: "Product Engineer",
      appliedAt: "2026-08-12T14:41:15.278Z",
      lastUpdateAt: "2026-10-12T18:34:52.000Z",
    });
    const recent = app({
      key: "inhouse::full stack engineer",
      company: "InHouse",
      role: "Full Stack Engineer",
      appliedAt: "2026-10-25T12:00:00.000Z",
      lastUpdateAt: "2026-10-25T12:00:00.000Z",
    });
    const store = memoryStore();
    const service = createJdRecoveryQueueService({
      getApplications: async (days) => (days < 30 ? [roleless, recent] : [complete, recent]),
      getEvaluationsByKeys: async () => new Map(),
      store,
      now: () => new Date("2026-10-30T12:00:00.000Z"),
      identityLookbackDays: 120,
    });
    const short = await service.claim({ days: 11, limit: 5, sessionId: "session-id1" });
    expect(short.claimed.map((row) => row.applicationKey)).toEqual(["inhouse::full stack engineer"]);
    const wide = await service.claim({ days: 80, limit: 5, sessionId: "session-id2" });
    expect(wide.claimed.map((row) => row.applicationKey)).toEqual(["axle::product engineer"]);
    expect(wide.claimed.some((row) => row.applicationKey === "axle::")).toBe(false);
  });

  it("keeps an orphan queue key visible after a failed submit and recorded temporary error", async () => {
    const complete = app({
      key: "axle::product engineer",
      company: "Axle",
      role: "Product Engineer",
      appliedAt: "2026-08-12T14:41:15.278Z",
      lastUpdateAt: "2026-10-12T18:34:52.000Z",
    });
    const scored = evaluation(complete, {
      recovery: { status: "scored", attempts: [], serperQueries: 0 },
      fit: {
        total: 80,
        recommendation: "strong_apply",
        recommendedResume: "AI",
        scoredAt: "2026-08-20T00:00:00.000Z",
        promptVersion: "v1",
      },
    });
    const apps = [complete];
    const evalMap = new Map([[complete.key, scored]]);
    const store = memoryStore();
    const service = createJdRecoveryQueueService({
      getApplications: async () => apps,
      getEvaluationsByKeys: async (wanted) => {
        const map = new Map<string, ApplicationEvaluation>();
        for (const key of wanted) {
          const row = evalMap.get(key);
          if (row) map.set(key, row);
        }
        return map;
      },
      store,
      now: () => new Date("2026-10-30T16:50:00.000Z"),
      identityLookbackDays: 120,
    });
    store.rows.set("axle::", {
      applicationKey: "axle::",
      status: "in_progress",
      attemptCount: 0,
      candidateCount: 0,
      createdAt: "2026-10-30T16:40:00.000Z",
      updatedAt: "2026-10-30T16:40:00.000Z",
      lastAttemptAt: "2026-10-30T16:40:00.000Z",
      leaseOwner: "session-axle",
      leaseExpiresAt: "2026-10-30T18:40:00.000Z",
    });
    await expect(
      submitJdCandidate(
        {
          applicationKey: "axle::",
          company: "Axle",
          originalText: FULL_JD,
          sourceUrl: "https://jobs.example/axle",
          sourceType: "company_site",
          matchEvidence: ["Axle careers page"],
          completeness: "full",
        },
        {
          getApplications: async () => apps,
          findByKey: async (key) => evalMap.get(key) ?? null,
          upsertIfUnscored: async (row) => {
            if (evalMap.get(row.key)?.recovery.status === "scored") return evalMap.get(row.key)!;
            evalMap.set(row.key, structuredClone(row));
            return structuredClone(row);
          },
        },
        120,
      ),
    ).rejects.toMatchObject({
      code: "APPLICATION_UNRESOLVED",
      possibleRelatedKeys: [expect.objectContaining({ key: "axle::product engineer", note: "hint_only_not_a_merge" })],
    });
    const recorded = await service.record({
      applicationKey: "axle::",
      outcome: "temporary_error",
      reason: "submit_jd_candidate could not resolve axle::",
    });
    expect(recorded.recorded).toBe(true);
    expect(recorded.effectiveStatus).toBe("unresolved_application");
    expect(recorded.possibleRelatedKeys).toEqual([
      expect.objectContaining({ key: "axle::product engineer", scored: true, note: "hint_only_not_a_merge" }),
    ]);
    expect(apps).toHaveLength(1);
    expect(evalMap.get(complete.key)?.fit?.total).toBe(80);
    const progress = await service.progress({ days: 120 });
    expect(progress.unresolvedQueue.missingGmailRecord).toBe(1);
    expect(progress.unresolvedQueue.outsideLookback).toBe(0);
    expect(progress.unresolvedQueue.items[0]?.applicationKey).toBe("axle::");
    expect(progress.temporaryFailures).toBe(0);
    expect(progress.retryDue).toBe(0);
    expect(progressSum(progress)).toBe(progress.total);
    expect((await service.claim({ days: 120, limit: 5, sessionId: "session-orphan" })).claimed).toEqual([]);
    const narrow = await service.progress({ days: 11 });
    expect(narrow.unresolvedQueue.missingGmailRecord).toBe(1);
    expect(narrow.unresolvedQueue.outsideLookback).toBe(0);
  });

  it("reports lookback exclusions separately from missing Gmail records", async () => {
    const older = app({
      key: "ipivot::full stack developer react node",
      company: "iPivot",
      role: "Full Stack Developer",
      appliedAt: "2026-10-12T00:00:00.000Z",
      lastUpdateAt: "2026-10-12T00:00:00.000Z",
    });
    const { service, store } = setup([older], [], new Date("2026-10-30T12:00:00.000Z"));
    store.rows.set(older.key, {
      applicationKey: older.key,
      status: "not_found",
      lastOutcome: "not_found",
      attemptCount: 1,
      candidateCount: 0,
      createdAt: "2026-10-30T12:00:00.000Z",
      updatedAt: "2026-10-30T12:00:00.000Z",
      lastAttemptAt: "2026-10-30T12:00:00.000Z",
      nextRetryAt: "2026-11-06T12:00:00.000Z",
    });
    const wide = await service.progress({ days: 120 });
    expect(wide.notFoundRetryNotDue).toBe(1);
    expect(wide.unresolvedQueue.outsideLookback).toBe(0);
    const identityService = createJdRecoveryQueueService({
      getApplications: async () => [older],
      getEvaluationsByKeys: async () => new Map(),
      store,
      now: () => new Date("2026-10-30T12:00:00.000Z"),
      identityLookbackDays: 120,
    });
    const narrow = await identityService.progress({ days: 11 });
    expect(narrow.total).toBe(0);
    expect(narrow.unresolvedQueue.outsideLookback).toBe(1);
    expect(narrow.unresolvedQueue.missingGmailRecord).toBe(0);
    expect(narrow.unresolvedQueue.items[0]?.applicationKey).toBe(older.key);
  });
});
