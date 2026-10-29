import { beforeEach, describe, expect, it, vi } from "vitest";
import { presentFitForDisplay } from "../../lib/authoritativeScore.js";
import { evaluationFingerprint } from "../../lib/evaluationFingerprint.js";
import { reconcileSeniority } from "../../lib/seniorityReconciliation.js";
import { reconcileYearsExperience } from "../../lib/yearsExperienceReconciliation.js";
import { toEvaluationSummary } from "../../services/gmail/jdRecovery/summary.js";
import { toListRow } from "../../mcp/views.js";
import {
  buildScoringAuditContext,
  listScoredApplicationsForAudit,
} from "../../mcp/scoringAudit.js";
import { MCP_TOOL_NAMES, runMcpTool, type McpDeps } from "../../mcp/catalog.js";
import type { ApplicationEvaluation } from "../../services/gmail/jdRecovery/evaluations.repository.js";
import type { GmailApplication } from "../../services/gmail/gmailApplications.js";
import type { ApprovedRevisionOverlay, ScoreRevision } from "../../services/scoring/scoreRevision.types.js";
import { exampleUserProfile } from "../../config/userProfile.example.js";
import type { ResumeContextSet } from "../../types/resumeContext.js";
import type { Recommendation, RuleEvaluation, ScoreBreakdown } from "../../types/scoring.js";

const findByKey = vi.fn();
const insert = vi.fn(async () => undefined);
const findById = vi.fn();
const approveAtomic = vi.fn();
const rollbackAtomic = vi.fn();
const recompute = vi.fn();

vi.mock("../../services/gmail/jdRecovery/evaluations.repository.js", () => ({
  evaluationsRepository: {
    findByKey: (...args: unknown[]) => findByKey(...args),
  },
}));

vi.mock("../../services/scoring/scoreRevisions.repository.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../services/scoring/scoreRevisions.repository.js")>();
  return {
    ...actual,
    scoreRevisionsRepository: {
      insert: (...args: unknown[]) => insert(...args),
      findById: (...args: unknown[]) => findById(...args),
      listByApplicationKey: vi.fn(async () => []),
      findApprovedByApplicationKeys: vi.fn(async () => new Map()),
      approveAtomic: (...args: unknown[]) => approveAtomic(...args),
      rollbackAtomic: (...args: unknown[]) => rollbackAtomic(...args),
    },
  };
});

vi.mock("../../services/resume/resumeContext.js", () => ({
  resumeContextService: { getAvailableContexts: vi.fn(async () => ({})) },
}));

vi.mock("../../lib/recomputeStoredJobScore.js", () => ({
  recomputeStoredJobScore: (...args: unknown[]) => recompute(...args),
}));

const { proposeDeterministicRevision, approveScoreRevision, rollbackScoreRevision, ScoreRevisionError } = await import(
  "../../services/scoring/scoreRevisions.service.js"
);
const { ConcurrentApprovalError } = await import("../../services/scoring/scoreRevisions.repository.js");

const scoredFit = (total: number, recommendation: Recommendation, over: Record<string, unknown> = {}) => ({
  total,
  recommendation,
  recommendedResume: "BASE" as const,
  scoredAt: "2026-05-01T00:00:00.000Z",
  promptVersion: "jd-recovery-v1:base-ai",
  detail: {
    recommendation,
    recommendedResume: "BASE",
    topMatch: "TypeScript",
    mainRisk: "years",
    rationale: [],
    risks: [],
    resumeRationale: [],
    score: {
      stackFit: 16,
      levelFit: 14,
      domainFit: 8,
      resumeStoryClarity: 8,
      functionalOverlap: 12,
      recruiterFriendliness: 10,
      careerValue: 7,
      total,
      capability: total + 2,
      llmCategories: { stackFit: 16, levelFit: 14, domainFit: 8 },
      scoreDisplay: { final: total, scoreBand: recommendation, hardGates: [], scoreDerivation: `${total + 2} + (-2) = ${total}` },
    } satisfies ScoreBreakdown,
    rules: {
      roleLane: "product_frontend",
      stackMismatch: true,
      seniorityOverreach: false,
      coreLanguageGap: ["python"],
      notes: [],
    } as unknown as RuleEvaluation,
    extracted: {
      company: "Affirm",
      title: "Software Engineer II, Frontend",
      stack: ["TypeScript", "React"],
      requiredSkills: ["TypeScript"],
      preferredSkills: [],
      domainTags: [],
      responsibilities: ["Build UI"],
      requirements: ["2+ years"],
      yearsExperience: { raw: "8+ years", min: 8 },
      seniority: "senior",
    },
    ...over,
  },
});

const evaluationOf = (over: Partial<ApplicationEvaluation> = {}): ApplicationEvaluation =>
  ({
    key: "affirm::frontend",
    company: "Affirm",
    role: "Software Engineer II, Frontend",
    appliedAt: "2026-04-01T00:00:00.000Z",
    recovery: { status: "scored", attempts: [], serperQueries: 0 },
    jd: {
      text: "Software Engineer II, Frontend. 2+ years of TypeScript and React. Python is a plus.",
      textHash: "jd-affirm-fe",
      title: "Software Engineer II, Frontend",
    },
    fit: scoredFit(25, "weak"),
    outcome: { status: "applied", updatedAt: "2026-04-01T00:00:00.000Z", history: [] },
    createdAt: "2026-04-01T00:00:00.000Z",
    updatedAt: "2026-04-01T00:00:00.000Z",
    ...over,
  }) as ApplicationEvaluation;

const appOf = (key: string, company: string): GmailApplication =>
  ({
    key,
    company,
    role: "Engineer",
    appliedAt: "2026-04-01T00:00:00.000Z",
    appliedAtKnown: true,
    appliedAtSource: "email",
    status: "applied",
    furthestStage: "applied",
    interviewRounds: [],
    activelyInterviewing: false,
    lastUpdateAt: "2026-04-02T00:00:00.000Z",
    emails: [],
  }) as GmailApplication;

const overlayOf = (evaluation: ApplicationEvaluation, total: number, recommendation: Recommendation): ApprovedRevisionOverlay => ({
  revisionId: "rev-1",
  applicationKey: evaluation.key,
  evaluationFingerprint: evaluationFingerprint(evaluation),
  status: "approved",
  correctedTotal: total,
  correctedRecommendation: recommendation,
  originalTotal: 25,
  originalRecommendation: "weak",
});

const snapshot = (total: number, recommendation: Recommendation, extra: Record<string, unknown> = {}) => ({
  total,
  recommendation,
  hardGates: [] as string[],
  roleLane: "product_frontend",
  stackMismatch: true,
  ...extra,
});

const proposal = (evaluation: ApplicationEvaluation, over: Partial<ScoreRevision> = {}): ScoreRevision => ({
  revisionId: "rev-1",
  applicationKey: evaluation.key,
  evaluationFingerprint: evaluationFingerprint(evaluation),
  scoringVersion: "score-revision-v1",
  pipelineVersionLabel: "jd-recovery-v1:base-ai",
  method: "deterministic_replay",
  status: "proposed",
  inputsChanged: ["yearsExperience"],
  inputChanges: [{ id: "yearsExperience", from: { min: 8 }, to: { min: 2 } }],
  evidence: ['JD years: "2+ years of TypeScript"'],
  explanation: "Deterministic replay",
  recommendationTierChanged: true,
  original: snapshot(25, "weak"),
  corrected: snapshot(71, "apply"),
  createdAt: "2026-10-29T00:00:00.000Z",
  createdBy: { actor: "user", via: "dashboard", at: "2026-10-29T00:00:00.000Z" },
  ...over,
});

const replayResult = (total: number, recommendation: Recommendation, rules: Record<string, unknown> = {}) => ({
  rules: {
    roleLane: "product_frontend",
    stackMismatch: false,
    seniorityOverreach: false,
    coreLanguageGap: [],
    notes: [],
    ...rules,
  },
  score: {
    stackFit: 16,
    levelFit: 14,
    domainFit: 8,
    resumeStoryClarity: 8,
    functionalOverlap: 12,
    recruiterFriendliness: 10,
    careerValue: 7,
    total,
    capability: total + 2,
    scoreDisplay: { final: total, scoreBand: recommendation, hardGates: [], scoreDerivation: `${total + 2} + (-2) = ${total}` },
  },
  recommendation,
  salaryAsk: {},
});

beforeEach(() => {
  findByKey.mockReset();
  insert.mockReset();
  findById.mockReset();
  approveAtomic.mockReset();
  rollbackAtomic.mockReset();
  recompute.mockReset();
});

describe("evaluation fingerprint", () => {
  it("is stable for the same stored evaluation and changes when fit.total changes", () => {
    const a = evaluationOf();
    const b = evaluationOf();
    expect(evaluationFingerprint(a)).toBe(evaluationFingerprint(b));
    b.fit = { ...b.fit!, total: 26 };
    expect(evaluationFingerprint(a)).not.toBe(evaluationFingerprint(b));
  });
});

describe("effective-score resolver", () => {
  it("uses an approved revision when the fingerprint still matches, without mutating storage", () => {
    const evaluation = evaluationOf();
    const original = structuredClone(evaluation.fit);
    const presented = presentFitForDisplay(evaluation.fit!, {
      revision: overlayOf(evaluation, 71, "apply"),
      evaluation,
    });
    expect(presented.total).toBe(71);
    expect(presented.recommendation).toBe("apply");
    expect(presented.authoritativeSource).toBe("approved_revision");
    expect(presented.scoreRevised).toBe(true);
    expect(presented.originalAuthoritativeTotal).toBe(25);
    expect(evaluation.fit).toEqual(original);
  });

  it("ignores a proposed revision and keeps the overlay", () => {
    const evaluation = evaluationOf();
    const presented = presentFitForDisplay(evaluation.fit!, {
      revision: { ...overlayOf(evaluation, 71, "apply"), status: "proposed" } as unknown as ApprovedRevisionOverlay,
      evaluation,
    });
    expect(presented.total).toBe(25);
    expect(presented.scoreRevised).toBeUndefined();
  });

  it("does not apply a stale fingerprint; falls back to overlay", () => {
    const evaluation = evaluationOf();
    const presented = presentFitForDisplay(evaluation.fit!, {
      revision: { ...overlayOf(evaluation, 71, "apply"), evaluationFingerprint: "stale" },
      evaluation,
    });
    expect(presented.total).toBe(25);
    expect(presented.fingerprintStale).toBe(true);
    expect(presented.revisionId).toBe("rev-1");
    expect(presented.staleRevisionTotal).toBe(71);
    expect(presented.authoritativeSource).not.toBe("approved_revision");
    const summary = toEvaluationSummary(evaluation, { ...overlayOf(evaluation, 71, "apply"), evaluationFingerprint: "stale" });
    expect(summary.fitTotal).toBe(25);
    expect(summary.fingerprintStale).toBe(true);
    expect(summary.staleRevisionTotal).toBe(71);
    expect(summary.scoreRevised).toBeUndefined();
  });

  it("keeps TELCOR overlay 60 when no revision is approved", () => {
    const telcor = evaluationOf({
      key: "TELCOR:Gmail",
      company: "TELCOR",
      fit: {
        total: 79,
        recommendation: "apply",
        recommendedResume: "BASE",
        scoredAt: "2026-05-13T00:00:00.000Z",
        promptVersion: "test",
        detail: {
          recommendation: "stretch",
          recommendedResume: "BASE",
          topMatch: "TypeScript",
          mainRisk: "platform",
          rationale: [],
          risks: [],
          resumeRationale: [],
          score: {
            total: 60,
            capability: 62,
            scoreDisplay: { final: 60, scoreBand: "stretch", hardGates: [] },
          },
          rules: { notes: [] } as unknown as RuleEvaluation,
          extracted: { company: "TELCOR", title: "Software Engineer", stack: [], requiredSkills: [], preferredSkills: [], domainTags: [], responsibilities: [], requirements: [] },
        },
      },
    });
    const presented = presentFitForDisplay(telcor.fit!, { evaluation: telcor });
    expect(presented.total).toBe(60);
    expect(presented.recommendation).toBe("stretch");
    expect(toEvaluationSummary(telcor).fitTotal).toBe(60);
  });
});

describe("proposeDeterministicRevision", () => {
  it("records original vs corrected inputs without writing fit", async () => {
    const evaluation = evaluationOf();
    findByKey.mockResolvedValue(evaluation);
    recompute.mockReturnValue(replayResult(71, "apply", { stackMismatch: false }));
    const revision = await proposeDeterministicRevision({ applicationKey: evaluation.key, via: "dashboard" });
    expect(revision.status).toBe("proposed");
    expect(revision.method).toBe("deterministic_replay");
    expect(revision.original.total).toBe(25);
    expect(revision.corrected.total).toBe(71);
    expect(revision.recommendationTierChanged).toBe(true);
    expect(revision.inputsChanged.length).toBeGreaterThan(0);
    expect(insert).toHaveBeenCalledOnce();
    expect(evaluation.fit!.total).toBe(25);
  });

  it("refuses missing historical breakdowns and invented totals", async () => {
    findByKey.mockResolvedValue(evaluationOf({ fit: { total: 55, recommendation: "stretch", recommendedResume: "BASE", scoredAt: "2026-01-01T00:00:00.000Z", promptVersion: "old" } }));
    await expect(proposeDeterministicRevision({ applicationKey: "meow::se" })).rejects.toMatchObject({
      name: "ScoreRevisionError",
      code: "MISSING_BREAKDOWN",
    });
    expect(insert).not.toHaveBeenCalled();
  });

  it("requires explicit lane review when roleLane would change", async () => {
    const evaluation = evaluationOf();
    findByKey.mockResolvedValue(evaluation);
    recompute.mockReturnValue(replayResult(82, "strong_apply", { roleLane: "product_backend" }));
    await expect(proposeDeterministicRevision({ applicationKey: evaluation.key })).rejects.toMatchObject({
      code: "LANE_REVIEW_REQUIRED",
    });
    expect(insert).not.toHaveBeenCalled();
    const allowed = await proposeDeterministicRevision({ applicationKey: evaluation.key, allowRoleLaneChange: true });
    expect(allowed.inputsChanged).toContain("roleLane");
    expect(insert).toHaveBeenCalledOnce();
  });

  it("refuses a no-op replay", async () => {
    const evaluation = evaluationOf({ fit: scoredFit(71, "apply") });
    const extracted = { ...evaluation.fit!.detail!.extracted, rawText: evaluation.jd!.text };
    const years = reconcileYearsExperience(extracted);
    const seniority = reconcileSeniority(years.job);
    const { rawText: _rawText, ...stored } = seniority.job;
    evaluation.fit!.detail!.extracted = stored;
    const rules = {
      ...evaluation.fit!.detail!.rules,
      roleLane: "product_frontend",
      stackMismatch: seniority.job ? evaluation.fit!.detail!.rules.stackMismatch : false,
      coreLanguageGap: evaluation.fit!.detail!.rules.coreLanguageGap,
      seniorityOverreach: Boolean(evaluation.fit!.detail!.rules.seniorityOverreach),
    } as RuleEvaluation;
    evaluation.fit!.detail!.rules = rules;
    findByKey.mockResolvedValue(evaluation);
    recompute.mockReturnValue(replayResult(71, "apply", { ...rules }));
    await expect(proposeDeterministicRevision({ applicationKey: evaluation.key })).rejects.toMatchObject({
      code: "NO_CORRECTION",
    });
  });
});

describe("approve and rollback", () => {
  it("approves a deterministic proposal and leaves the original evaluation untouched", async () => {
    const evaluation = evaluationOf();
    const originalTotal = evaluation.fit!.total;
    findByKey.mockResolvedValue(evaluation);
    findById.mockResolvedValue(proposal(evaluation));
    approveAtomic.mockImplementation(async () => ({ ...proposal(evaluation), status: "approved", approvedAt: "2026-10-29T01:00:00.000Z" }));
    const approved = await approveScoreRevision({ applicationKey: evaluation.key, revisionId: "rev-1", via: "dashboard" });
    expect(approved.status).toBe("approved");
    expect(evaluation.fit!.total).toBe(originalTotal);
    expect(approveAtomic).toHaveBeenCalledOnce();
  });

  it("rejects a stale fingerprint, inconsistent recommendation, and non-executable methods", async () => {
    const evaluation = evaluationOf();
    findByKey.mockResolvedValue(evaluation);
    findById.mockResolvedValueOnce(proposal(evaluation, { evaluationFingerprint: "old" }));
    await expect(approveScoreRevision({ applicationKey: evaluation.key, revisionId: "rev-1" })).rejects.toMatchObject({
      code: "STALE_FINGERPRINT",
    });

    findById.mockResolvedValueOnce(proposal(evaluation, { corrected: snapshot(71, "weak") }));
    await expect(approveScoreRevision({ applicationKey: evaluation.key, revisionId: "rev-1" })).rejects.toMatchObject({
      code: "INCONSISTENT_SCORE",
    });

    findById.mockResolvedValueOnce(proposal(evaluation, { method: "human_correction" }));
    await expect(approveScoreRevision({ applicationKey: evaluation.key, revisionId: "rev-1" })).rejects.toMatchObject({
      code: "METHOD_NOT_EXECUTABLE",
    });
    expect(approveAtomic).not.toHaveBeenCalled();
  });

  it("maps a unique-index collision to CONCURRENT_APPROVAL", async () => {
    const evaluation = evaluationOf();
    findByKey.mockResolvedValue(evaluation);
    findById.mockResolvedValue(proposal(evaluation));
    approveAtomic.mockRejectedValue(new ConcurrentApprovalError(evaluation.key));
    await expect(approveScoreRevision({ applicationKey: evaluation.key, revisionId: "rev-1" })).rejects.toMatchObject({
      code: "CONCURRENT_APPROVAL",
    });
  });

  it("rolls back without deleting history", async () => {
    rollbackAtomic.mockResolvedValue({ ...proposal(evaluationOf()), status: "rolled_back", rolledBackAt: "2026-10-29T02:00:00.000Z" });
    const rolled = await rollbackScoreRevision({ applicationKey: "affirm::frontend", revisionId: "rev-1", via: "dashboard" });
    expect(rolled.status).toBe("rolled_back");
    expect(rolled.revisionId).toBe("rev-1");
  });

  it("does not treat Claude or jobs as an approval path", () => {
    expect(MCP_TOOL_NAMES).toContain("propose_scoring_correction");
    expect(MCP_TOOL_NAMES).not.toContain("approve_score_revision");
    expect(MCP_TOOL_NAMES).not.toContain("rollback_score_revision");
    expect(typeof ScoreRevisionError).toBe("function");
  });
});

describe("resolver on dashboard, MCP, and insights surfaces", () => {
  it("dashboard summaries and MCP list/audit rows use the approved revision", () => {
    const evaluation = evaluationOf();
    const revision = overlayOf(evaluation, 71, "apply");
    const summary = toEvaluationSummary(evaluation, revision);
    expect(summary.fitTotal).toBe(71);
    expect(summary.scoreRevised).toBe(true);
    expect(summary.originalAuthoritativeTotal).toBe(25);

    const row = toListRow(appOf(evaluation.key, evaluation.company), evaluation, revision);
    expect(row.fitTotal).toBe(71);
    expect(row.scoreRevised).toBe(true);

    const listed = listScoredApplicationsForAudit(
      [appOf(evaluation.key, evaluation.company)],
      new Map([[evaluation.key, evaluation]]),
      { offset: 0, limit: 20, minScore: 70 },
      new Map([[evaluation.key, revision]]),
    );
    expect(listed.totalMatched).toBe(1);
    expect(listed.applications[0]?.fitTotal).toBe(71);
  });

  it("audit context reports the approved revision as the effective total", () => {
    const evaluation = evaluationOf();
    const packet = buildScoringAuditContext({
      app: appOf(evaluation.key, evaluation.company),
      evaluation,
      profile: exampleUserProfile,
      resumeContexts: {
        BASE: {
          type: "BASE",
          sourcePath: "/tmp/base.txt",
          sourceKind: "txt",
          loadedAt: "2026-10-02T00:00:00.000Z",
          rawText: "TypeScript React",
          metadata: {
            strongestThemes: ["TypeScript"],
            projectEvidence: [],
            keywords: ["typescript"],
            bestFitRoleShapes: ["product_frontend"],
            avoidUseCases: [],
            claimSupport: [],
          },
        },
      } as ResumeContextSet,
      revision: overlayOf(evaluation, 71, "apply"),
    });
    expect(packet.scoring.total).toBe(71);
    expect(packet.scoring.authoritativeSource).toBe("approved_revision");
    expect(packet.scoring.revisionId).toBe("rev-1");
  });

  it("MCP list_applications uses the revision loader and never exposes write tools", async () => {
    const evaluation = evaluationOf();
    const deps: McpDeps = {
      getApplications: vi.fn(async () => [appOf(evaluation.key, evaluation.company)]),
      getEvaluationsByKeys: vi.fn(async () => new Map([[evaluation.key, evaluation]])),
      getActiveScoreRevisions: vi.fn(async () => new Map([[evaluation.key, overlayOf(evaluation, 71, "apply")]])),
      getLatestInsightsRun: vi.fn(async () => null),
      getUserProfile: vi.fn(() => exampleUserProfile),
      getResumeContexts: vi.fn(async () => ({}) as ResumeContextSet),
      saveJobProspect: vi.fn(async () => {
        throw new Error("write");
      }),
      submitJdCandidate: vi.fn(async () => {
        throw new Error("write");
      }),
      proposeScoringCorrection: vi.fn(async () => {
        throw new Error("write");
      }),
    };
    const listed = (await runMcpTool("list_applications", { query: "Affirm", limit: 10 }, deps)) as {
      applications: Array<{ fitTotal?: number; scoreRevised?: boolean }>;
    };
    expect(listed.applications[0]?.fitTotal).toBe(71);
    expect(listed.applications[0]?.scoreRevised).toBe(true);
    expect(MCP_TOOL_NAMES).toContain("propose_scoring_correction");
    expect(MCP_TOOL_NAMES.some((name) => name.includes("approve") || name.includes("rollback"))).toBe(false);
  });
});
