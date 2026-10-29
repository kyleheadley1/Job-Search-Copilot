import { describe, expect, it, vi } from "vitest";
import type { JobRecord } from "../../types/job.js";
import type { GmailApplication } from "../../services/gmail/gmailApplications.js";
import { appliedDatesCompatible, matchTrackerJob } from "../../services/gmail/gmailApplications.js";
import type { ApplicationEvaluation } from "../../services/gmail/jdRecovery/evaluations.repository.js";
import {
  addMissingApplicationsToTracker,
  buildTrackerJob,
  isAutoAddCandidate,
  type AutoAddDeps,
} from "../../services/gmail/trackerAutoAdd.js";

const SCORE = {
  stackFit: 15,
  levelFit: 18,
  domainFit: 8,
  resumeStoryClarity: 9,
  functionalOverlap: 12,
  recruiterFriendliness: 12,
  careerValue: 8,
  total: 82,
};

const RULES = {
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
};

const app = (over: Partial<GmailApplication> = {}): GmailApplication => ({
  key: "acme::software engineer",
  company: "Acme",
  role: "Software Engineer",
  appliedAt: "2026-09-01T12:00:00.000Z",
  appliedAtKnown: true,
  appliedAtSource: "email",
  status: "interviewing",
  furthestStage: "interviewing",
  interviewRounds: [],
  activelyInterviewing: true,
  lastUpdateAt: "2026-09-10T12:00:00.000Z",
  emails: [],
  ...over,
});

const evaluation = (over: Partial<ApplicationEvaluation> = {}): ApplicationEvaluation =>
  ({
    key: "acme::software engineer",
    company: "Acme",
    role: "Software Engineer",
    appliedAt: "2026-09-01T12:00:00.000Z",
    recovery: { status: "scored", attempts: [], serperQueries: 0, url: "https://job-boards.greenhouse.io/acme/jobs/1" },
    jd: { text: "Full JD text", textHash: "h" },
    fit: {
      total: 82,
      recommendation: "apply",
      recommendedResume: "BASE",
      scoredAt: "2026-09-02T00:00:00.000Z",
      promptVersion: "v1",
      detail: {
        recommendation: "apply",
        recommendedResume: "BASE",
        topMatch: "TypeScript",
        mainRisk: "None",
        rationale: ["fit"],
        risks: [],
        resumeRationale: [],
        score: SCORE,
        rules: RULES,
        extracted: {
          company: "Acme",
          title: "Software Engineer",
          stack: [],
          requiredSkills: [],
          preferredSkills: [],
          domainTags: [],
        },
      },
    },
    outcome: {
      status: "interviewing",
      updatedAt: "2026-09-10T12:00:00.000Z",
      history: [
        { status: "applied", at: "2026-09-01T12:00:00.000Z" },
        { status: "interviewing", at: "2026-09-10T12:00:00.000Z" },
      ],
    },
    createdAt: "2026-09-02T00:00:00.000Z",
    updatedAt: "2026-09-02T00:00:00.000Z",
    ...over,
  }) as ApplicationEvaluation;

const trackerJob = (appliedAt: string | undefined, over: Partial<JobRecord> = {}): JobRecord =>
  ({
    id: "job-1",
    extracted: { company: "Acme", title: "Software Engineer" },
    tracker: appliedAt ? { appliedAt } : {},
    statusHistory: [],
    status: "applied",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...over,
  }) as unknown as JobRecord;

describe("date-aware tracker matching", () => {
  it("treats confirmed applied dates more than 21 days apart as a re-application", () => {
    expect(appliedDatesCompatible(app(), trackerJob("2026-09-15T00:00:00.000Z"))).toBe(true);
    expect(appliedDatesCompatible(app(), trackerJob("2026-06-01T00:00:00.000Z"))).toBe(false);
    expect(matchTrackerJob(app(), [trackerJob("2026-06-01T00:00:00.000Z")])).toBeUndefined();
    expect(matchTrackerJob(app(), [trackerJob("2026-08-25T00:00:00.000Z")])?.id).toBe("job-1");
  });

  it("lets company and role decide when either date is only estimated", () => {
    expect(matchTrackerJob(app({ appliedAtSource: "estimated" }), [trackerJob("2026-01-01T00:00:00.000Z")])?.id).toBe("job-1");
    expect(matchTrackerJob(app(), [trackerJob(undefined)])?.id).toBe("job-1");
  });

  it("prefers the row created from this application", () => {
    const linked = trackerJob("2026-01-01T00:00:00.000Z", {
      id: "linked",
      extracted: { company: "Renamed Co", title: "Other" } as JobRecord["extracted"],
      tracker: { gmailKey: "acme::software engineer" },
    });
    expect(matchTrackerJob(app(), [trackerJob("2026-09-01T00:00:00.000Z"), linked])?.id).toBe("linked");
  });
});

describe("buildTrackerJob", () => {
  it("copies the stored score without re-scoring and maps status and history", () => {
    const job = buildTrackerJob(app(), evaluation(), "2026-10-04T00:00:00.000Z")!;
    expect(job.score).toEqual(SCORE);
    expect(job.recommendation).toBe("apply");
    expect(job.scoreHistory).toEqual([{ scoredAt: "2026-09-02T00:00:00.000Z", score: SCORE, recommendation: "apply" }]);
    expect(job.status).toBe("interviewing");
    expect(job.tracker).toMatchObject({ appliedAt: "2026-09-01T12:00:00.000Z", source: "gmail", gmailKey: app().key });
    expect(job.statusHistory?.map((h) => [h.fromStatus, h.toStatus, h.createdAt])).toEqual([
      [undefined, "applied", "2026-09-01T12:00:00.000Z"],
      ["applied", "interviewing", "2026-09-10T12:00:00.000Z"],
    ]);
    expect(job.extracted.rawText).toBe("Full JD text");
    expect(job.extracted.url).toBe("https://job-boards.greenhouse.io/acme/jobs/1");
  });

  it("ends history at a later rejection", () => {
    const job = buildTrackerJob(app({ status: "rejected", lastUpdateAt: "2026-09-20T00:00:00.000Z" }), evaluation())!;
    expect(job.status).toBe("rejected");
    expect(job.statusHistory?.at(-1)).toMatchObject({ fromStatus: "interviewing", toStatus: "rejected" });
  });

  it("returns null for unscored applications", () => {
    expect(buildTrackerJob(app(), evaluation({ fit: undefined }))).toBeNull();
  });
});

describe("addMissingApplicationsToTracker", () => {
  const run = async (apps: GmailApplication[], evals: ApplicationEvaluation[]) => {
    const saved: JobRecord[] = [];
    const marked: string[] = [];
    const deps: AutoAddDeps = {
      loadApplications: async () => apps,
      loadEvaluations: async () => new Map(evals.map((e) => [e.key, e])),
      save: vi.fn(async (job) => {
        saved.push(job);
      }),
      markAdded: vi.fn(async (key) => {
        marked.push(key);
      }),
    };
    const result = await addMissingApplicationsToTracker(deps);
    return { result, saved, marked };
  };

  it("adds scored applications missing from the tracker and flags them", async () => {
    const { result, saved, marked } = await run([app()], [evaluation()]);
    expect(result.added).toBe(1);
    expect(saved[0]!.score.total).toBe(82);
    expect(marked).toEqual(["acme::software engineer"]);
  });

  it("skips unscored, already-added, and already-tracked applications", async () => {
    const unscored = app({ key: "u::r" });
    const added = app({ key: "a::r" });
    const tracked = app({ key: "t::r", trackerJobId: "job-9" });
    const { result } = await run(
      [unscored, added, tracked],
      [
        evaluation({ key: "u::r", fit: undefined }),
        evaluation({ key: "a::r", trackerAutoAddedAt: "2026-09-05T00:00:00.000Z" }),
        evaluation({ key: "t::r" }),
      ],
    );
    expect(result.added).toBe(0);
  });

  it("never re-adds once flagged, even if the tracker row was deleted", () => {
    expect(isAutoAddCandidate(app(), evaluation({ trackerAutoAddedAt: "2026-09-05T00:00:00.000Z" }))).toBe(false);
  });

  it("adds a confirmed MCP scoring the same way as other scored rows, without changing an existing tracker status", async () => {
    const confirmed = evaluation({
      recovery: {
        status: "scored",
        attempts: [],
        serperQueries: 0,
        foundVia: "mcp",
        verifiedBy: "user",
        url: "https://www.builtinnyc.com/job/forward-deployed-software-engineer/11912990",
      },
    });
    const { result, saved } = await run([app({ status: "applied" })], [confirmed]);
    expect(result.added).toBe(1);
    expect(saved[0]!.status).toBe("applied");
    expect(saved[0]!.tracker).toMatchObject({
      source: "gmail",
      gmailKey: "acme::software engineer",
      statusOutcome: "applied",
    });
    expect(saved[0]!.score.total).toBe(82);

    const alreadyTracked = app({ trackerJobId: "existing-job", trackerStatus: "interviewing" });
    const { result: skipped } = await run([alreadyTracked], [confirmed]);
    expect(skipped.added).toBe(0);
  });
});
