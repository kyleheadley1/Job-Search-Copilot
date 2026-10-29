import { beforeEach, describe, expect, it, vi } from "vitest";
import type { JobRecord } from "../../types/job.js";

const triageJobMock = vi.fn();

vi.mock("../../agents/jobAgent/orchestrator.js", () => ({
  triageJob: (...args: unknown[]) => triageJobMock(...args),
}));

vi.mock("../../services/jobs/jobs.repository.js", () => ({
  jobsRepository: {
    getById: vi.fn(),
    upsertJob: vi.fn(),
  },
}));

// The service overlays Gmail effective scores at read time; unit tests inject the
// evaluation + revision lookups instead of reaching Mongo.
const findByTrackerJobIdsMock = vi.fn();
const findByKeysMock = vi.fn();
const loadApprovedOverlaysMock = vi.fn();

vi.mock("../../services/gmail/jdRecovery/evaluations.repository.js", () => ({
  evaluationsRepository: {
    findByTrackerJobIds: (...args: unknown[]) => findByTrackerJobIdsMock(...args),
    findByKeys: (...args: unknown[]) => findByKeysMock(...args),
  },
}));

vi.mock("../../services/scoring/scoreRevisions.service.js", () => ({
  loadApprovedOverlays: (...args: unknown[]) => loadApprovedOverlaysMock(...args),
}));

import { jobsRepository } from "../../services/jobs/jobs.repository.js";
import { jobsService, JobNoJdSourceError } from "../../services/jobs/jobs.service.js";

const score62 = {
  stackFit: 10,
  levelFit: 10,
  domainFit: 7,
  resumeStoryClarity: 8,
  functionalOverlap: 10,
  recruiterFriendliness: 10,
  careerValue: 7,
  total: 62,
};

const score85 = {
  stackFit: 16,
  levelFit: 18,
  domainFit: 8,
  resumeStoryClarity: 9,
  functionalOverlap: 14,
  recruiterFriendliness: 12,
  careerValue: 8,
  total: 85,
};

const baseRules = (): JobRecord["rules"] => ({
  explicitDegreeRisk: false,
  traditionalCompanyPenalty: false,
  financePenalty: false,
  strictNewGradPipeline: false,
  earlyCareerFriendlyRole: false,
  newGradPenalty: false,
  seniorityOverreach: false,
  locationMismatch: false,
  visaMismatch: false,
  citizenshipMismatch: false,
  clearanceMismatch: false,
  stackMismatch: false,
  domainMismatch: false,
  startupFounderMismatch: false,
  notes: [],
});

const triageResult = (overrides: Partial<JobRecord> = {}): JobRecord => ({
  id: "draft-1",
  extracted: {
    company: "Acme",
    title: "Engineer",
    rawText: "Build internal AI tools with Claude Code.",
    stack: [],
    requiredSkills: [],
    preferredSkills: [],
    domainTags: [],
    responsibilities: [],
    requirements: [],
  },
  rules: baseRules(),
  score: score85,
  recommendation: "apply",
  salaryAsk: {},
  recommendedResume: "BASE",
  resumeRationale: [],
  topMatch: "Fresh match",
  mainRisk: "Fresh risk",
  rationale: [],
  risks: [],
  generated: {},
  tracker: {
    priority: "high",
    recommendedAction: "Apply with urgency",
    statusOutcome: "yes",
    shortlist: true,
    color: "green",
  },
  status: "to_review",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-02T00:00:00.000Z",
  scoreHistory: [{ scoredAt: "2026-01-02T00:00:00.000Z", score: score85, recommendation: "apply" }],
  ...overrides,
});

describe("jobsService.runRetriage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(jobsRepository.getById).mockResolvedValue(null);
    vi.mocked(jobsRepository.upsertJob).mockReset();
    triageJobMock.mockReset();
    findByTrackerJobIdsMock.mockResolvedValue(new Map());
    findByKeysMock.mockResolvedValue(new Map());
    loadApprovedOverlaysMock.mockResolvedValue(new Map());
  });

  it("re-scores a draft job in place and clears generated assets", async () => {
    triageJobMock
      .mockResolvedValueOnce(
        triageResult({
          id: "draft-1",
          score: score62,
          recommendation: "stretch",
          topMatch: "Old match",
          generated: { coverLetter: "old letter" },
          scoreHistory: [{ scoredAt: "2026-01-01T00:00:00.000Z", score: score62, recommendation: "stretch" }],
        }),
      )
      .mockResolvedValueOnce(
        triageResult({
          id: "ignored",
          extracted: {
            company: "Unknown Company",
            title: "Engineer",
            companyDisplayName: "Unknown Company",
            rawText: "Build internal AI tools with Claude Code.",
            stack: [],
            requiredSkills: [],
            preferredSkills: [],
            domainTags: [],
            responsibilities: [],
            requirements: [],
          },
        }),
      );

    const seeded = await jobsService.runTriage({
      rawText: "Build internal AI tools with Claude Code.",
      companyHint: "Acme",
    });
    const { job, tracked } = await jobsService.runRetriage(seeded.id);

    expect(tracked).toBe(false);
    expect(job.id).toBe("draft-1");
    expect(job.score.total).toBe(85);
    expect(job.extracted.company).toBe("Acme");
    expect(job.extracted.companyDisplayName).toBe("Acme");
    expect(job.topMatch).toBe("Fresh match");
    expect(job.generated).toEqual({});
    expect(job.scoreHistory?.length).toBe(2);
    expect(triageJobMock).toHaveBeenLastCalledWith(
      expect.objectContaining({
        rawText: "Build internal AI tools with Claude Code.",
        companyHint: "Acme",
        retriageFrom: expect.objectContaining({ id: "draft-1" }),
      }),
    );
  });

  it("persists re-score for tracked jobs via repository upsert", async () => {
    vi.mocked(jobsRepository.getById).mockResolvedValue(
      triageResult({
        id: "tracked-1",
        score: score62,
        recommendation: "stretch",
        status: "applied",
        generated: { coverLetter: "old" },
        trackerSpreadsheet: { latestScore: "62" },
        scoreHistory: [{ scoredAt: "2026-01-01T00:00:00.000Z", score: score62, recommendation: "stretch" }],
      }),
    );
    vi.mocked(jobsRepository.upsertJob).mockImplementation(async (record) => record);
    triageJobMock.mockResolvedValueOnce(triageResult({ id: "ignored" }));

    const { job, tracked } = await jobsService.runRetriage("tracked-1");

    expect(tracked).toBe(true);
    expect(jobsRepository.upsertJob).toHaveBeenCalled();
    expect(job.id).toBe("tracked-1");
    expect(job.score.total).toBe(85);
    expect(job.trackerSpreadsheet?.latestScore).toBe("85");
    expect(job.trackerSpreadsheet?.originalAltScore).toBe("62");
  });

  it("never persists the read-time effective-score overlay on retriage", async () => {
    vi.mocked(jobsRepository.getById).mockResolvedValue(
      triageResult({
        id: "tracked-linked",
        score: score62,
        recommendation: "stretch",
        status: "applied",
        tracker: { priority: "medium", recommendedAction: "Apply", statusOutcome: "applied", gmailKey: "acme::engineer" },
        scoreHistory: [{ scoredAt: "2026-01-01T00:00:00.000Z", score: score62, recommendation: "stretch" }],
      }),
    );
    vi.mocked(jobsRepository.upsertJob).mockImplementation(async (record) => record);
    findByTrackerJobIdsMock.mockResolvedValue(
      new Map([
        [
          "tracked-linked",
          {
            key: "acme::engineer",
            company: "Acme",
            role: "Engineer",
            trackerJobId: "tracked-linked",
            fit: { total: 48, recommendation: "weak", recommendedResume: "BASE", scoredAt: "2026-01-03T00:00:00.000Z", promptVersion: "test" },
          },
        ],
      ]),
    );
    triageJobMock.mockResolvedValueOnce(triageResult({ id: "ignored" }));

    const { job, tracked } = await jobsService.runRetriage("tracked-linked");

    expect(tracked).toBe(true);
    const persisted = vi.mocked(jobsRepository.upsertJob).mock.calls[0]?.[0];
    expect(persisted).toBeDefined();
    expect(persisted).not.toHaveProperty("effectiveScore");
    expect(persisted?.score.total).toBe(85);
    // Response still presents the linked Gmail evaluation, without touching jobs.score.
    expect(job.score.total).toBe(85);
    expect(job.effectiveScore?.total).toBe(48);
    expect(job.effectiveScore?.storedTrackerTotal).toBe(85);
  });

  it("rejects re-triage when no JD source is stored", async () => {
    triageJobMock.mockResolvedValueOnce(
      triageResult({
        id: "draft-2",
        extracted: {
          company: "Acme",
          title: "Engineer",
          stack: [],
          requiredSkills: [],
          preferredSkills: [],
          domainTags: [],
          responsibilities: [],
          requirements: [],
        },
      }),
    );
    const seeded = await jobsService.runTriage({ rawText: "temporary" });
    await expect(jobsService.runRetriage(seeded.id)).rejects.toBeInstanceOf(JobNoJdSourceError);
  });
});
