import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createMongoTestHarness } from "../support/mongo-test-db.js";
import { evaluationsRepository, type ApplicationEvaluation } from "../../services/gmail/jdRecovery/evaluations.repository.js";
import {
  ConcurrentApprovalError,
  scoreRevisionsRepository,
} from "../../services/scoring/scoreRevisions.repository.js";
import type { ScoreRevision } from "../../services/scoring/scoreRevision.types.js";

const mongo = createMongoTestHarness("score_revisions");

const evaluation = (key: string): ApplicationEvaluation =>
  ({
    key,
    company: "Affirm",
    role: "Software Engineer II",
    appliedAt: "2026-04-01T00:00:00.000Z",
    recovery: { status: "scored", attempts: [], serperQueries: 0 },
    jd: { text: "Frontend TypeScript React. 2+ years.", textHash: "h", title: "SE II" },
    fit: {
      total: 25,
      recommendation: "weak",
      recommendedResume: "BASE",
      scoredAt: "2026-04-02T00:00:00.000Z",
      promptVersion: "test",
    },
    outcome: { status: "applied", updatedAt: "2026-04-02T00:00:00.000Z", history: [] },
    createdAt: "2026-04-02T00:00:00.000Z",
    updatedAt: "2026-04-02T00:00:00.000Z",
  }) as ApplicationEvaluation;

const revision = (over: Partial<ScoreRevision> & Pick<ScoreRevision, "revisionId" | "applicationKey">): ScoreRevision => ({
  evaluationFingerprint: "fp",
  scoringVersion: "score-revision-v1",
  pipelineVersionLabel: "test",
  method: "deterministic_replay",
  status: "proposed",
  inputsChanged: ["yearsExperience"],
  inputChanges: [{ id: "yearsExperience", from: 8, to: 2 }],
  evidence: ["JD years"],
  explanation: "replay",
  recommendationTierChanged: true,
  original: { total: 25, recommendation: "weak", hardGates: [] },
  corrected: { total: 71, recommendation: "apply", hardGates: [] },
  createdAt: new Date().toISOString(),
  createdBy: { actor: "user", via: "api", at: new Date().toISOString() },
  ...over,
});

beforeAll(async () => {
  await mongo.start();
});

afterAll(async () => {
  await mongo.stop();
});

beforeEach(async () => {
  const col = await scoreRevisionsRepository.collection();
  await col.deleteMany({});
  const evals = await evaluationsRepository.collection();
  await evals.deleteMany({});
});

describe("score_revisions repository", () => {
  it("enforces one active approved revision and preserves history on rollback", async () => {
    const key = "affirm::frontend";
    await evaluationsRepository.upsert(evaluation(key));
    const first = revision({ revisionId: "r1", applicationKey: key });
    const second = revision({
      revisionId: "r2",
      applicationKey: key,
      corrected: { total: 42, recommendation: "weak", hardGates: [] },
    });
    await scoreRevisionsRepository.insert(first);
    await scoreRevisionsRepository.insert(second);

    const approved = await scoreRevisionsRepository.approveAtomic({
      revisionId: "r1",
      applicationKey: key,
      approvedAt: new Date().toISOString(),
      approvedBy: { actor: "user", via: "dashboard", at: new Date().toISOString() },
    });
    expect(approved.status).toBe("approved");
    expect(approved.activeApplicationKey).toBe(key);

    await expect(
      scoreRevisionsRepository.approveAtomic({
        revisionId: "r2",
        applicationKey: key,
        approvedAt: new Date().toISOString(),
        approvedBy: { actor: "user", via: "dashboard", at: new Date().toISOString() },
      }),
    ).rejects.toBeInstanceOf(ConcurrentApprovalError);

    const stored = await evaluationsRepository.findByKey(key);
    expect(stored?.fit?.total).toBe(25);

    const rolled = await scoreRevisionsRepository.rollbackAtomic({
      revisionId: "r1",
      applicationKey: key,
      rolledBackAt: new Date().toISOString(),
      rolledBackBy: { actor: "user", via: "dashboard", at: new Date().toISOString() },
    });
    expect(rolled.status).toBe("rolled_back");
    expect(rolled.activeApplicationKey).toBeUndefined();

    const history = await scoreRevisionsRepository.listByApplicationKey(key);
    expect(history).toHaveLength(2);
    expect(history.map((row) => row.status).sort()).toEqual(["proposed", "rolled_back"]);

    const later = await scoreRevisionsRepository.approveAtomic({
      revisionId: "r2",
      applicationKey: key,
      approvedAt: new Date().toISOString(),
      approvedBy: { actor: "user", via: "dashboard", at: new Date().toISOString() },
    });
    expect(later.status).toBe("approved");
    const active = await scoreRevisionsRepository.findApprovedByApplicationKeys([key]);
    expect(active.get(key)?.revisionId).toBe("r2");
    expect((await evaluationsRepository.findByKey(key))?.fit?.total).toBe(25);
  });

  it("rejects a second concurrent approve via the sparse unique index", async () => {
    const key = "affirm::fullstack";
    const a = revision({ revisionId: "a", applicationKey: key });
    const b = revision({ revisionId: "b", applicationKey: key });
    await scoreRevisionsRepository.insert(a);
    await scoreRevisionsRepository.insert(b);
    const stamp = {
      approvedAt: new Date().toISOString(),
      approvedBy: { actor: "user" as const, via: "api" as const, at: new Date().toISOString() },
    };
    const results = await Promise.allSettled([
      scoreRevisionsRepository.approveAtomic({ revisionId: "a", applicationKey: key, ...stamp }),
      scoreRevisionsRepository.approveAtomic({ revisionId: "b", applicationKey: key, ...stamp }),
    ]);
    const ok = results.filter((r) => r.status === "fulfilled");
    const failed = results.filter((r) => r.status === "rejected");
    expect(ok).toHaveLength(1);
    expect(failed).toHaveLength(1);
    expect(failed[0]?.status === "rejected" && failed[0].reason).toBeInstanceOf(ConcurrentApprovalError);
    const active = await scoreRevisionsRepository.findApprovedByApplicationKeys([key]);
    expect(active.size).toBe(1);
  });
});
