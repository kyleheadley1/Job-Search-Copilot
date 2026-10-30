import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { getDb } from "../../config/mongo.js";
import type { GmailApplication } from "../../services/gmail/gmailApplications.js";
import { evaluationsRepository, type ApplicationEvaluation } from "../../services/gmail/jdRecovery/evaluations.repository.js";
import { submitJdCandidate } from "../../services/gmail/jdRecovery/jdCandidates.service.js";
import {
  jdRecoveryQueueRepository,
  resetJdRecoveryQueueIndexesForTests,
} from "../../services/gmail/jdRecovery/jdRecoveryQueue.repository.js";
import { createJdRecoveryQueueService } from "../../services/gmail/jdRecovery/jdRecoveryQueue.service.js";
import { JD_RECOVERY_QUEUE_COLLECTION } from "../../services/gmail/jdRecovery/jdRecoveryQueue.types.js";
import { createMongoTestHarness } from "../support/mongo-test-db.js";

const mongo = createMongoTestHarness("jd_recovery_queue");

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

const keys = (prefix: string, count: number) =>
  Array.from({ length: count }, (_, i) =>
    app({
      key: `${prefix}::role ${String(i + 1).padStart(2, "0")}`,
      company: prefix,
      role: `Role ${i + 1}`,
      appliedAt: `2026-09-${String(i + 1).padStart(2, "0")}T00:00:00.000Z`,
    }),
  );

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

const serviceOf = (apps: GmailApplication[], now = new Date("2026-10-29T12:00:00.000Z")) => {
  const clock = { now };
  return {
    clock,
    service: createJdRecoveryQueueService({
      getApplications: async () => apps,
      getEvaluationsByKeys: (wanted) => evaluationsRepository.findByKeys(wanted),
      store: jdRecoveryQueueRepository,
      now: () => clock.now,
    }),
  };
};

beforeAll(async () => {
  await mongo.start();
});

afterAll(async () => {
  await mongo.stop();
});

beforeEach(async () => {
  resetJdRecoveryQueueIndexesForTests();
  const db = await getDb();
  await db.collection(JD_RECOVERY_QUEUE_COLLECTION).deleteMany({});
  await db.collection("application_evaluations").deleteMany({});
});

describe("JD recovery queue Mongo persistence", () => {
  it("does not let concurrent claims overlap", async () => {
    const apps = keys("race", 10);
    const { service } = serviceOf(apps);
    const [left, right] = await Promise.all([
      service.claim({ limit: 5, sessionId: "session-left1" }),
      service.claim({ limit: 5, sessionId: "session-right" }),
    ]);
    const leftKeys = left.claimed.map((row) => row.applicationKey);
    const rightKeys = right.claimed.map((row) => row.applicationKey);
    expect(leftKeys).toHaveLength(5);
    expect(rightKeys).toHaveLength(5);
    expect(new Set([...leftKeys, ...rightKeys]).size).toBe(10);
  });

  it("recovers an expired lease and keeps a live lease exclusive", async () => {
    const apps = keys("hold", 2);
    const { service, clock } = serviceOf(apps, new Date("2026-10-29T12:00:00.000Z"));
    const first = await service.claim({ limit: 1, sessionId: "session-hold1" });
    expect(first.claimed.map((row) => row.applicationKey)).toEqual(["hold::role 02"]);
    const stillHeld = await service.claim({ limit: 1, sessionId: "session-hold2" });
    expect(stillHeld.claimed.map((row) => row.applicationKey)).toEqual(["hold::role 01"]);
    const db = await getDb();
    await db.collection(JD_RECOVERY_QUEUE_COLLECTION).updateOne(
      { _id: "hold::role 02" },
      { $set: { leaseExpiresAt: "2026-10-29T11:00:00.000Z" } },
    );
    clock.now = new Date("2026-10-29T12:05:00.000Z");
    const recovered = await service.claim({ limit: 1, sessionId: "session-hold3" });
    expect(recovered.claimed.map((row) => row.applicationKey)).toEqual(["hold::role 02"]);
  });

  it("persists a candidate submission across a new service instance", async () => {
    const apps = [app({ key: "fluxcap::fde", company: "Fluxcap", role: "Forward Deployed Software Engineer" })];
    const { service } = serviceOf(apps);
    await service.claim({ limit: 1, sessionId: "session-flux1" });
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
        findByKey: (key) => evaluationsRepository.findByKey(key),
        upsertIfUnscored: (evaluation) => evaluationsRepository.upsertIfUnscored(evaluation),
      },
      120,
    );
    await service.syncAfterCandidateSubmitted(submitted);
    const restarted = createJdRecoveryQueueService({
      getApplications: async () => apps,
      getEvaluationsByKeys: (wanted) => evaluationsRepository.findByKeys(wanted),
      store: jdRecoveryQueueRepository,
      now: () => new Date("2026-10-30T12:00:00.000Z"),
    });
    const progress = await restarted.progress({ days: 120 });
    expect(progress.pendingHumanJdReview).toBe(1);
    expect(progress.unattempted).toBe(0);
    expect(await restarted.claim({ limit: 5, sessionId: "session-flux2" })).toMatchObject({ claimed: [] });
    const recorded = await restarted.record({
      applicationKey: "fluxcap::fde",
      outcome: "candidate_submitted",
    });
    expect(recorded.completed).toBe(false);
    expect(recorded.queueStatus).toBe("candidate_pending_review");

    const existing = await evaluationsRepository.findByKey("fluxcap::fde");
    expect(existing).toBeTruthy();
    await evaluationsRepository.upsert({
      ...(existing as ApplicationEvaluation),
      recovery: { ...existing!.recovery, status: "scored" },
      fit: {
        total: 70,
        recommendation: "apply",
        recommendedResume: "BASE",
        scoredAt: "2026-10-30T13:00:00.000Z",
        promptVersion: "v1",
      },
    });
    const afterScore = await restarted.progress({ days: 120 });
    expect(afterScore.scored).toBe(1);
    expect(afterScore.pendingHumanJdReview).toBe(0);
    expect(await restarted.claim({ limit: 5, sessionId: "session-flux3" })).toMatchObject({ claimed: [] });
  });

  it("treats unscored Gmail applications without queue records as unattempted", async () => {
    const apps = keys("fresh", 3);
    const { service } = serviceOf(apps);
    const progress = await service.progress({ days: 120 });
    expect(progress.total).toBe(3);
    expect(progress.unattempted).toBe(3);
    expect(progress.scored).toBe(0);
    const claimed = await service.claim({ limit: 5, sessionId: "session-fresh" });
    expect(claimed.claimed.map((row) => row.applicationKey)).toEqual([
      "fresh::role 03",
      "fresh::role 02",
      "fresh::role 01",
    ]);
  });
});
