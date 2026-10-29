import { describe, expect, it, vi } from "vitest";
import { evaluationFingerprint } from "../../lib/evaluationFingerprint.js";
import type { ApplicationEvaluation } from "../../services/gmail/jdRecovery/evaluations.repository.js";
import type { JobRecord } from "../../types/job.js";

const findByTrackerJobIds = vi.fn();
const findByKeys = vi.fn();
const loadApprovedOverlays = vi.fn();

vi.mock("../../services/gmail/jdRecovery/evaluations.repository.js", () => ({
  evaluationsRepository: {
    findByTrackerJobIds: (...args: unknown[]) => findByTrackerJobIds(...args),
    findByKeys: (...args: unknown[]) => findByKeys(...args),
  },
}));

vi.mock("../../services/scoring/scoreRevisions.service.js", () => ({
  loadApprovedOverlays: (...args: unknown[]) => loadApprovedOverlays(...args),
}));

const { overlayJobsWithEffectiveScores } = await import("../../services/scoring/trackerEffectiveScore.js");

const job = (id: string, total: number): JobRecord =>
  ({
    id,
    extracted: { company: "Affirm", title: "Software Engineer II, Frontend", stack: [], requiredSkills: [], preferredSkills: [], domainTags: [], responsibilities: [], requirements: [] },
    rules: { notes: [] },
    score: { total, stackFit: 10, levelFit: 10, domainFit: 5, resumeStoryClarity: 5, functionalOverlap: 8, recruiterFriendliness: 8, careerValue: 5 },
    recommendation: "weak",
    salaryAsk: {},
    recommendedResume: "BASE",
    resumeRationale: [],
    topMatch: "TypeScript",
    mainRisk: "years",
    rationale: [],
    risks: [],
    generated: {},
    tracker: { gmailKey: "affirm::frontend" },
    status: "applied",
    createdAt: "2026-04-01T00:00:00.000Z",
    updatedAt: "2026-04-01T00:00:00.000Z",
  }) as JobRecord;

const evaluation = (total: number): ApplicationEvaluation =>
  ({
    key: "affirm::frontend",
    company: "Affirm",
    role: "Software Engineer II, Frontend",
    appliedAt: "2026-04-01T00:00:00.000Z",
    trackerJobId: "job-1",
    recovery: { status: "scored", attempts: [], serperQueries: 0 },
    jd: { text: "Frontend TypeScript. 2+ years.", textHash: "h" },
    fit: {
      total,
      recommendation: total >= 65 ? "apply" : "weak",
      recommendedResume: "BASE",
      scoredAt: "2026-04-02T00:00:00.000Z",
      promptVersion: "test",
    },
    outcome: { status: "applied", updatedAt: "2026-04-02T00:00:00.000Z", history: [] },
    createdAt: "2026-04-02T00:00:00.000Z",
    updatedAt: "2026-04-02T00:00:00.000Z",
  }) as ApplicationEvaluation;

describe("overlayJobsWithEffectiveScores", () => {
  it("leaves unlinked tracker scores alone", async () => {
    findByTrackerJobIds.mockResolvedValue(new Map());
    findByKeys.mockResolvedValue(new Map());
    loadApprovedOverlays.mockResolvedValue(new Map());
    const [row] = await overlayJobsWithEffectiveScores([job("job-1", 25)]);
    expect(row!.score.total).toBe(25);
    expect(row!.effectiveScore).toBeUndefined();
  });

  it("drops a stale persisted overlay when the job is no longer linked", async () => {
    findByTrackerJobIds.mockResolvedValue(new Map());
    findByKeys.mockResolvedValue(new Map());
    loadApprovedOverlays.mockResolvedValue(new Map());
    const stale = {
      ...job("job-1", 25),
      effectiveScore: { total: 71, recommendation: "apply", storedTrackerTotal: 25, applicationKey: "affirm::frontend" },
    } as JobRecord;
    const [row] = await overlayJobsWithEffectiveScores([stale]);
    expect(row!.score.total).toBe(25);
    expect(row!.effectiveScore).toBeUndefined();
  });

  it("presents an approved Gmail revision without mutating the stored tracker total", async () => {
    const evalRow = evaluation(25);
    findByTrackerJobIds.mockResolvedValue(new Map([["job-1", evalRow]]));
    findByKeys.mockResolvedValue(new Map());
    loadApprovedOverlays.mockResolvedValue(
      new Map([
        [
          evalRow.key,
          {
            revisionId: "rev-1",
            applicationKey: evalRow.key,
            evaluationFingerprint: evaluationFingerprint(evalRow),
            status: "approved",
            correctedTotal: 71,
            correctedRecommendation: "apply",
            originalTotal: 25,
            originalRecommendation: "weak",
          },
        ],
      ]),
    );
    const [row] = await overlayJobsWithEffectiveScores([job("job-1", 25)]);
    expect(row!.score.total).toBe(25);
    expect(row!.effectiveScore?.total).toBe(71);
    expect(row!.effectiveScore?.scoreRevised).toBe(true);
    expect(row!.effectiveScore?.storedTrackerTotal).toBe(25);
  });

  it("falls back to the Gmail overlay when the revision fingerprint is stale", async () => {
    const evalRow = evaluation(25);
    findByTrackerJobIds.mockResolvedValue(new Map([["job-1", evalRow]]));
    findByKeys.mockResolvedValue(new Map());
    loadApprovedOverlays.mockResolvedValue(
      new Map([
        [
          evalRow.key,
          {
            revisionId: "rev-1",
            applicationKey: evalRow.key,
            evaluationFingerprint: "stale",
            status: "approved",
            correctedTotal: 71,
            correctedRecommendation: "apply",
            originalTotal: 25,
            originalRecommendation: "weak",
          },
        ],
      ]),
    );
    const [row] = await overlayJobsWithEffectiveScores([job("job-1", 25)]);
    expect(row!.effectiveScore?.total).toBe(25);
    expect(row!.effectiveScore?.fingerprintStale).toBe(true);
    expect(row!.effectiveScore?.staleRevisionTotal).toBe(71);
    expect(row!.score.total).toBe(25);
  });
});
