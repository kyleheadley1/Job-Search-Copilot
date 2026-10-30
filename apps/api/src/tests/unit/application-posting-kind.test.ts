import { describe, expect, it } from "vitest";
import type { GmailApplication } from "../../services/gmail/gmailApplications.js";
import {
  classifyPostingKind,
  isTalentPoolOrEvent,
} from "../../services/gmail/jdRecovery/applicationPostingKind.js";
import type { ApplicationEvaluation } from "../../services/gmail/jdRecovery/evaluations.repository.js";
import { submitJdCandidate } from "../../services/gmail/jdRecovery/jdCandidates.service.js";
import {
  excludedReviewRowsFromEvaluations,
  hasPendingJdConfirmation,
  pendingReviewRowsFromEvaluations,
} from "../../services/gmail/jdRecovery/jdReview.service.js";
import {
  createJdRecoveryQueueService,
  type JdRecoveryQueueStore,
} from "../../services/gmail/jdRecovery/jdRecoveryQueue.service.js";
import type { SaveQueueOutcomeInput } from "../../services/gmail/jdRecovery/jdRecoveryQueue.repository.js";
import type { JdRecoveryQueueRecord } from "../../services/gmail/jdRecovery/jdRecoveryQueue.types.js";
import { AlreadyScoredError } from "../../services/gmail/jdRecovery/runRecovery.js";

const app = (over: Partial<GmailApplication> & Pick<GmailApplication, "key" | "company">): GmailApplication =>
  ({
    role: "Engineer",
    appliedAt: "2026-10-19T18:48:04.000Z",
    appliedAtKnown: true,
    appliedAtSource: "email",
    status: "applied",
    furthestStage: "applied",
    interviewRounds: [],
    activelyInterviewing: false,
    lastUpdateAt: "2026-10-19T18:48:04.000Z",
    emails: [
      {
        id: "m1",
        subject: "We received your job application",
        from: "recruiter@example.com",
        date: "2026-10-19T18:48:04.000Z",
        eventType: "applied",
        gmailUrl: "https://mail.google.com/mail/u/0/#inbox/m1",
      },
    ],
    ...over,
  }) as GmailApplication;

const evaluationOf = (row: GmailApplication, over: Partial<ApplicationEvaluation> = {}): ApplicationEvaluation =>
  ({
    key: row.key,
    company: row.company,
    role: row.role,
    appliedAt: row.appliedAt,
    recovery: { status: "unverified", attempts: [], serperQueries: 0 },
    outcome: { status: row.status, updatedAt: row.appliedAt, history: [] },
    createdAt: row.appliedAt,
    updatedAt: row.appliedAt,
    ...over,
  }) as ApplicationEvaluation;

const SPARSE_JD = [
  "Software Engineer",
  "Acme",
  "",
  "Responsibilities",
  "- Build product features",
  "",
  "Requirements",
  "- Familiarity with TypeScript",
  "Join our team and write software with us. ".repeat(12),
].join("\n");

const TALENT_POOL_TEXT = [
  "AfroTech 11/2026 Talent Profile",
  "JPMorganChase",
  "",
  "Join our talent community for AfroTech. This is not a specific role requisition.",
  "Submit your profile so recruiters can consider you for future openings.",
  "Job Number: 210784843",
  "No concrete engineering requirements are listed because this is a conference interest form. ".repeat(4),
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

describe("application posting kind", () => {
  it("classifies a talent-profile registration without scoring or treating it as not_found", async () => {
    const gmail = app({
      key: "jpmorganchase::afrotech 11 2026 210784843",
      company: "JPMorganChase",
      role: "Afrotech , 11/2026 210784843",
    });
    const evalMap = new Map<string, ApplicationEvaluation>();
    const store = memoryStore();
    const service = createJdRecoveryQueueService({
      getApplications: async () => [gmail],
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
    });
    const submitted = await submitJdCandidate(
      {
        applicationKey: gmail.key,
        company: "JPMorganChase",
        title: "AfroTech 11/2026 210784843",
        originalText: TALENT_POOL_TEXT,
        sourceUrl: "https://jpmc.fa.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_1001/job/210784843",
        sourceType: "company_site",
        matchEvidence: ["Exact req 210784843 on JPMC careers"],
        completeness: "partial",
        requisitionId: "210784843",
      },
      {
        getApplications: async () => [gmail],
        findByKey: async (key) => evalMap.get(key) ?? null,
        upsertIfUnscored: async (row) => {
          evalMap.set(row.key, structuredClone(row));
          return structuredClone(row);
        },
      },
      120,
    );
    expect(submitted.status).toBe("submitted");
    expect(submitted.scoringEligible).toBe(false);
    evalMap.set(gmail.key, {
      ...evalMap.get(gmail.key)!,
      postingKind: undefined,
    });
    const { evaluation, result } = await classifyPostingKind(
      {
        applicationKey: gmail.key,
        postingKind: "talent_pool_or_event",
        reason: "Conference talent-profile intake, not a concrete engineering role",
      },
      {
        getApplications: async () => [gmail],
        findByKey: async (key) => evalMap.get(key) ?? null,
        upsertIfUnscored: async (row) => {
          if (evalMap.get(row.key)?.recovery.status === "scored") return evalMap.get(row.key)!;
          evalMap.set(row.key, structuredClone(row));
          return structuredClone(row);
        },
        identityLookbackDays: 120,
      },
    );
    evalMap.set(gmail.key, evaluation);
    await service.syncAfterPostingKindChange(evaluation);
    expect(result.postingKind).toBe("talent_pool_or_event");
    expect(isTalentPoolOrEvent(evaluation)).toBe(true);
    expect(evaluation.fit).toBeUndefined();
    expect(evaluation.recovery.candidates).toHaveLength(1);
    expect(hasPendingJdConfirmation(evaluation)).toBe(false);
    expect(pendingReviewRowsFromEvaluations([evaluation])).toEqual([]);
    expect(excludedReviewRowsFromEvaluations([evaluation])[0]?.exclusionReason).toMatch(/talent-pool or event/i);
    const progress = await service.progress();
    expect(progress.notAJobPosting).toBe(1);
    expect(progress.notFoundRetryNotDue).toBe(0);
    expect(progress.pendingHumanJdReview).toBe(0);
    expect((await service.claim({ limit: 5, sessionId: "session-talent" })).claimed).toEqual([]);
  });

  it("does not treat a sparse but real job posting as a non-job registration", async () => {
    const gmail = app({ key: "acme::software engineer", company: "Acme", role: "Software Engineer" });
    const evalMap = new Map<string, ApplicationEvaluation>();
    const submitted = await submitJdCandidate(
      {
        applicationKey: gmail.key,
        company: "Acme",
        originalText: SPARSE_JD,
        sourceUrl: "https://jobs.example/acme-swe",
        sourceType: "company_site",
        matchEvidence: ["Exact Software Engineer title on the company site"],
        completeness: "partial",
      },
      {
        getApplications: async () => [gmail],
        findByKey: async (key) => evalMap.get(key) ?? null,
        upsertIfUnscored: async (row) => {
          evalMap.set(row.key, structuredClone(row));
          return structuredClone(row);
        },
      },
      120,
    );
    expect(submitted.status).toBe("submitted");
    expect(evalMap.get(gmail.key)?.postingKind).toBeUndefined();
    expect(hasPendingJdConfirmation(evalMap.get(gmail.key))).toBe(true);
    expect(isTalentPoolOrEvent(evalMap.get(gmail.key))).toBe(false);
  });

  it("restores a mistaken talent-pool classification without scoring", async () => {
    const gmail = app({ key: "restore::eng", company: "RestoreCo", role: "Engineer" });
    const evalMap = new Map<string, ApplicationEvaluation>([
      [
        gmail.key,
        evaluationOf(gmail, {
          postingKind: "talent_pool_or_event",
          postingKindReason: "mistaken",
          postingKindSource: "explicit",
          recovery: {
            status: "unverified",
            attempts: [],
            serperQueries: 0,
            candidates: [{ url: "https://jobs.example/eng", source: "mcp", matchLevel: "low", text: SPARSE_JD }],
          },
        }),
      ],
    ]);
    const store = memoryStore();
    const service = createJdRecoveryQueueService({
      getApplications: async () => [gmail],
      getEvaluationsByKeys: async () => evalMap,
      store,
      now: () => new Date("2026-10-30T16:50:00.000Z"),
    });
    store.rows.set(gmail.key, {
      applicationKey: gmail.key,
      status: "not_a_job_posting",
      lastOutcome: "not_a_job_posting",
      attemptCount: 1,
      candidateCount: 1,
      createdAt: "2026-10-30T16:00:00.000Z",
      updatedAt: "2026-10-30T16:00:00.000Z",
    });
    const { evaluation, result } = await classifyPostingKind(
      {
        applicationKey: gmail.key,
        postingKind: "job_posting",
        reason: "This is a real engineering requisition",
      },
      {
        getApplications: async () => [gmail],
        findByKey: async (key) => evalMap.get(key) ?? null,
        upsertIfUnscored: async (row) => {
          evalMap.set(row.key, structuredClone(row));
          return structuredClone(row);
        },
        identityLookbackDays: 120,
      },
    );
    evalMap.set(gmail.key, evaluation);
    await service.syncAfterPostingKindChange(evaluation);
    expect(result.restored).toBe(true);
    expect(evaluation.postingKind).toBe("job_posting");
    expect(evaluation.recovery.status).not.toBe("scored");
    expect(hasPendingJdConfirmation(evaluation)).toBe(true);
    const progress = await service.progress();
    expect(progress.notAJobPosting).toBe(0);
    expect(progress.pendingHumanJdReview).toBe(1);
  });

  it("refuses to classify a scored evaluation", async () => {
    const gmail = app({ key: "axle::product engineer", company: "Axle", role: "Product Engineer" });
    const scored = evaluationOf(gmail, {
      recovery: { status: "scored", attempts: [], serperQueries: 0 },
      fit: {
        total: 80,
        recommendation: "strong_apply",
        recommendedResume: "AI",
        scoredAt: "2026-08-20T00:00:00.000Z",
        promptVersion: "v1",
      },
    });
    await expect(
      classifyPostingKind(
        {
          applicationKey: gmail.key,
          postingKind: "talent_pool_or_event",
          reason: "should not rewrite a score",
        },
        {
          getApplications: async () => [gmail],
          findByKey: async () => scored,
          upsertIfUnscored: async () => scored,
          identityLookbackDays: 120,
        },
      ),
    ).rejects.toBeInstanceOf(AlreadyScoredError);
    expect(scored.fit?.total).toBe(80);
    expect(scored.postingKind).toBeUndefined();
  });
});

describe("Garner-like same-title location variants", () => {
  it("keeps skipped_requires_review when NYC hybrid and remote variants cannot be distinguished", async () => {
    const gmail = app({
      key: "garner health::software engineer",
      company: "Garner Health",
      role: "Software Engineer III",
      appliedAt: "2026-09-30T18:28:03.000Z",
      lastUpdateAt: "2026-10-23T22:47:16.000Z",
    });
    const store = memoryStore();
    const service = createJdRecoveryQueueService({
      getApplications: async () => [gmail],
      getEvaluationsByKeys: async () => new Map(),
      store,
      now: () => new Date("2026-10-30T16:46:00.000Z"),
    });
    await service.claim({ limit: 1, sessionId: "session-garner" });
    const recorded = await service.record({
      applicationKey: gmail.key,
      outcome: "skipped_requires_review",
      reason:
        "Garner runs two distinct Software Engineer III postings: NYC hybrid and Remote US. Confirmation email does not name the location.",
      evidence: [
        "https://jobs.example/garner-nyc-hybrid",
        "https://jobs.example/garner-remote-us",
      ],
    });
    expect(recorded.effectiveStatus).toBe("skipped_requires_review");
    expect(recorded.retryAt).toBeUndefined();
    const progress = await service.progress();
    expect(progress.skippedRequiresReview).toBe(1);
    expect(progress.notFoundRetryNotDue).toBe(0);
    expect(progress.notAJobPosting).toBe(0);
    expect((await service.claim({ limit: 5, sessionId: "session-garner2" })).claimed).toEqual([]);
    expect((await service.claim({ limit: 5, mode: "retry_only", sessionId: "session-garner3" })).claimed).toEqual([]);
  });
});
