import { beforeEach, describe, expect, it, vi } from "vitest";
import { ZodError } from "zod";
import { exampleUserProfile } from "../../config/userProfile.example.js";
import { evaluationFingerprint } from "../../lib/evaluationFingerprint.js";
import { classifyRoleLane } from "../../lib/roleFunctionClassifier.js";
import { buildScoringAuditContext } from "../../mcp/scoringAudit.js";
import { MCP_TOOL_NAMES, MCP_TOOLS, runMcpTool, type McpDeps } from "../../mcp/catalog.js";
import type { ApplicationEvaluation } from "../../services/gmail/jdRecovery/evaluations.repository.js";
import type { ScoreRevision } from "../../services/scoring/scoreRevision.types.js";
import type { Recommendation, RuleEvaluation, ScoreBreakdown } from "../../types/scoring.js";
import type { ExtractedJobData } from "../../types/job.js";

const findByKey = vi.fn();
const insert = vi.fn(async () => undefined);
const findById = vi.fn();
const listByApplicationKey = vi.fn(async () => [] as ScoreRevision[]);
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
      listByApplicationKey: (...args: unknown[]) => listByApplicationKey(...args),
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

const { ProposeScoringCorrectionInput, proposeClaudeScoringCorrection } = await import(
  "../../services/scoring/claudeScoringProposal.js"
);
const { approveScoreRevision, rollbackScoreRevision, ScoreRevisionError } = await import(
  "../../services/scoring/scoreRevisions.service.js"
);
const { ConcurrentApprovalError } = await import("../../services/scoring/scoreRevisions.repository.js");

const AFFIRM_JD =
  'Software Engineer II, Frontend. You have a total of 1.5+ years of experience as a software engineer. Build TypeScript and React interfaces.';
const MEOW_JD =
  "Comfortable working across both front-end and back-end technologies (our tech stack: TypeScript, React, Python (FastAPI), Postgres, AWS).";
const TELCOR_JD = [
  "AI Platform Engineer. Ideal for a product-minded engineer who enjoys shipping fast, owning features end-to-end, and building high-quality user experiences.",
  "Help build AI-powered products and experiences. Develop frontend applications with ReactJS and TypeScript. Integrate LLMs into product experiences and workflows.",
  "Requirements: 2+ years of experience with TypeScript. 2+ years of experience with ReactJS. Experience working with LLMs.",
].join("\n");

const scoredFit = (
  total: number,
  recommendation: Recommendation,
  extracted: Partial<ExtractedJobData>,
  rules: Partial<RuleEvaluation> = {},
) => ({
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
      scoreDisplay: {
        final: total,
        scoreBand: recommendation,
        hardGates: total <= 25 ? ["seniority overreach"] : [],
        scoreDerivation: `${total + 2} + (-2) = ${total}`,
      },
    } satisfies ScoreBreakdown,
    rules: {
      roleLane: "product_frontend",
      stackMismatch: false,
      seniorityOverreach: true,
      coreLanguageGap: [],
      notes: [],
      ...rules,
    } as unknown as RuleEvaluation,
    extracted: {
      company: "Affirm",
      title: "Software Engineer II, Frontend",
      stack: ["TypeScript", "React"],
      requiredSkills: ["TypeScript"],
      preferredSkills: [],
      domainTags: [],
      responsibilities: ["Build UI"],
      requirements: ["1.5+ years of experience as a software engineer"],
      yearsExperience: { raw: "5+ years", min: 5 },
      seniority: "senior",
      ...extracted,
    },
  },
});

const evaluationOf = (over: Partial<ApplicationEvaluation> = {}): ApplicationEvaluation =>
  ({
    key: "affirm::frontend-test",
    company: "Affirm",
    role: "Software Engineer II, Frontend",
    appliedAt: "2026-04-01T00:00:00.000Z",
    recovery: { status: "scored", attempts: [], serperQueries: 0 },
    jd: { text: AFFIRM_JD, textHash: "jd-affirm-fe-test", title: "Software Engineer II, Frontend" },
    fit: scoredFit(25, "weak", {}),
    outcome: { status: "applied", updatedAt: "2026-04-01T00:00:00.000Z", history: [] },
    createdAt: "2026-04-01T00:00:00.000Z",
    updatedAt: "2026-04-01T00:00:00.000Z",
    ...over,
  }) as ApplicationEvaluation;

const replayResult = (total: number, recommendation: Recommendation, rules: Record<string, unknown> = {}) => ({
  rules: {
    roleLane: "product_frontend",
    stackMismatch: false,
    seniorityOverreach: false,
    coreLanguageGap: [] as string[],
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
    scoreDisplay: {
      final: total,
      scoreBand: recommendation,
      hardGates: [],
      scoreDerivation: `${total + 2} + (-2) = ${total}`,
    },
  },
  recommendation,
  salaryAsk: {},
});

const yearsInput = (evaluation: ApplicationEvaluation) => ({
  applicationKey: evaluation.key,
  evaluationFingerprint: evaluationFingerprint(evaluation),
  correctionType: "years_experience_minimum" as const,
  originalValue: { min: 5, raw: "5+ years" },
  proposedValue: { min: 1.5, raw: "1.5+ years of experience" },
  jdEvidence: ["You have a total of 1.5+ years of experience as a software engineer"],
  explanation: "The stored 5+ / senior gate is a title misread of Engineer II, not an explicit years floor.",
  confidence: "high" as const,
});

beforeEach(() => {
  findByKey.mockReset();
  insert.mockReset();
  findById.mockReset();
  listByApplicationKey.mockReset();
  listByApplicationKey.mockResolvedValue([]);
  approveAtomic.mockReset();
  rollbackAtomic.mockReset();
  recompute.mockReset();
});

describe("ProposeScoringCorrectionInput", () => {
  it("rejects a free-form score and unknown keys", () => {
    const base = yearsInput(evaluationOf());
    expect(() => ProposeScoringCorrectionInput.parse({ ...base, proposedScore: 91 })).toThrow(ZodError);
    expect(() => ProposeScoringCorrectionInput.parse({ ...base, proposedTotal: 71 })).toThrow(ZodError);
    expect(() => ProposeScoringCorrectionInput.parse({ ...base, weights: { stackFit: 40 } })).toThrow(ZodError);
    expect(() =>
      ProposeScoringCorrectionInput.parse({ ...base, correctionType: "rubric_weight" }),
    ).toThrow(ZodError);
    expect(() =>
      ProposeScoringCorrectionInput.parse({ ...base, correctionType: "title_responsibility_mismatch" }),
    ).toThrow(ZodError);
  });
});

describe("proposeClaudeScoringCorrection", () => {
  it("stores an Affirm-style years correction using the engine score, not Claude's", async () => {
    const evaluation = evaluationOf();
    findByKey.mockResolvedValue(evaluation);
    recompute.mockReturnValue(replayResult(71, "apply"));
    const view = await proposeClaudeScoringCorrection(yearsInput(evaluation));
    expect(view.status).toBe("proposed");
    expect(view.approved).toBe(false);
    expect(view.method).toBe("claude_audit_proposal");
    expect(view.original.total).toBe(25);
    expect(view.proposed.total).toBe(71);
    expect(view.proposed.recommendation).toBe("apply");
    expect(view.proposed.yearsExperience?.min).toBe(1.5);
    expect(insert).toHaveBeenCalledOnce();
    const stored = insert.mock.calls[0]![0] as ScoreRevision;
    expect(stored.status).toBe("proposed");
    expect(stored.activeApplicationKey).toBeUndefined();
    expect(stored.corrected.total).toBe(71);
    expect(evaluation.fit!.total).toBe(25);
  });

  it("clears a Meow-style mixed-stack Python mismatch", async () => {
    const evaluation = evaluationOf({
      key: "meow::software engineer",
      company: "Meow",
      jd: { text: MEOW_JD, textHash: "meow", title: "Software Engineer" },
      fit: scoredFit(
        55,
        "stretch",
        {
          company: "Meow",
          title: "Software Engineer",
          yearsExperience: { raw: "2+ years", min: 2 },
          seniority: undefined,
          requirements: ["TypeScript, React, Python (FastAPI)"],
        },
        { stackMismatch: true, coreLanguageGap: ["python"], seniorityOverreach: false },
      ),
    });
    findByKey.mockResolvedValue(evaluation);
    recompute.mockReturnValue(replayResult(71, "apply", { stackMismatch: false, coreLanguageGap: [] }));
    const view = await proposeClaudeScoringCorrection({
      applicationKey: evaluation.key,
      evaluationFingerprint: evaluationFingerprint(evaluation),
      correctionType: "stack_language_classification",
      originalValue: { language: "python", classification: "exclusive_core_language" },
      proposedValue: { language: "python", classification: "mixed_stack_inventory" },
      jdEvidence: [
        "Comfortable working across both front-end and back-end technologies (our tech stack: TypeScript, React, Python (FastAPI), Postgres, AWS)",
      ],
      explanation: "Python sits in a mixed stack inventory beside TypeScript and React, not as an exclusive core language.",
      confidence: "high",
    });
    expect(view.proposed.total).toBe(71);
    expect(view.proposed.stackMismatch).toBe(false);
    expect(insert).toHaveBeenCalledOnce();
  });

  it("requires explicit lane review for a TELCOR-style role-lane disagreement", async () => {
    const extracted: ExtractedJobData = {
      company: "TELCOR",
      title: "AI Platform Engineer",
      stack: ["TypeScript", "React", "Redis", "Postgres"],
      requiredSkills: ["TypeScript", "ReactJS", "LLMs"],
      preferredSkills: [],
      domainTags: [],
      responsibilities: ["Develop frontend applications with ReactJS"],
      requirements: ["2+ years of experience with TypeScript"],
      yearsExperience: { raw: "2+ years", min: 2 },
      rawText: TELCOR_JD,
    };
    const classified = classifyRoleLane(extracted).label;
    const evaluation = evaluationOf({
      key: "telcor::ai platform engineer",
      company: "TELCOR",
      jd: { text: TELCOR_JD, textHash: "telcor", title: "AI Platform Engineer" },
      fit: scoredFit(60, "stretch", extracted, {
        roleLane: "platform_infra",
        seniorityOverreach: false,
      }),
    });
    findByKey.mockResolvedValue(evaluation);
    recompute.mockReturnValue(replayResult(82, "strong_apply", { roleLane: classified }));
    const input = {
      applicationKey: evaluation.key,
      evaluationFingerprint: evaluationFingerprint(evaluation),
      correctionType: "role_lane" as const,
      originalValue: "platform_infra",
      proposedValue: classified,
      jdEvidence: ["Ideal for a product-minded engineer who enjoys shipping fast"],
      explanation: "Stored platform_infra is a title-token misread of a product engineering JD.",
      confidence: "medium" as const,
    };
    await expect(proposeClaudeScoringCorrection(input)).rejects.toMatchObject({ code: "LANE_REVIEW_REQUIRED" });
    expect(insert).not.toHaveBeenCalled();
    const allowed = await proposeClaudeScoringCorrection({ ...input, allowRoleLaneChange: true });
    expect(allowed.laneChange).toBe(true);
    expect(allowed.proposed.total).toBe(82);
    expect(insert).toHaveBeenCalledOnce();
  });

  it("rejects dropping a genuine senior title", async () => {
    const jd = "Senior Software Engineer. You have 7+ years of experience building backend services.";
    const evaluation = evaluationOf({
      jd: { text: jd, textHash: "senior", title: "Senior Software Engineer" },
      fit: scoredFit(25, "weak", {
        title: "Senior Software Engineer",
        yearsExperience: { raw: "7+ years", min: 7 },
        seniority: "senior",
      }),
    });
    findByKey.mockResolvedValue(evaluation);
    await expect(
      proposeClaudeScoringCorrection({
        applicationKey: evaluation.key,
        evaluationFingerprint: evaluationFingerprint(evaluation),
        correctionType: "inferred_seniority",
        originalValue: "senior",
        proposedValue: null,
        jdEvidence: ["Senior Software Engineer. You have 7+ years of experience"],
        explanation: "Trying to drop a real senior title should be rejected.",
        confidence: "low",
      }),
    ).rejects.toMatchObject({ code: "GENUINE_SENIORITY_GATE" });
    expect(recompute).not.toHaveBeenCalled();
  });

  it("rejects mixed-stack claims against genuine Python, Go, and Java core requirements", async () => {
    const cases = [
      {
        language: "python" as const,
        title: "Backend Engineer",
        jd: "Must have production Python experience. Django required. Build APIs.",
        quote: "Must have production Python experience",
      },
      {
        language: "go" as const,
        title: "Backend Engineer",
        jd: "Must have professional experience with Go. Build production services in Golang.",
        quote: "Must have professional experience with Go",
      },
      {
        language: "java" as const,
        title: "Backend Engineer",
        jd: "You have experience developing backend using Java at a mature employer.",
        quote: "experience developing backend using Java",
      },
    ];
    for (const row of cases) {
      const evaluation = evaluationOf({
        jd: { text: row.jd, textHash: row.language, title: row.title },
        fit: scoredFit(
          25,
          "weak",
          { title: row.title, seniority: undefined, yearsExperience: { min: 3, raw: "3+" } },
          { stackMismatch: true, coreLanguageGap: [row.language], seniorityOverreach: false },
        ),
      });
      findByKey.mockResolvedValue(evaluation);
      await expect(
        proposeClaudeScoringCorrection({
          applicationKey: evaluation.key,
          evaluationFingerprint: evaluationFingerprint(evaluation),
          correctionType: "stack_language_classification",
          originalValue: { language: row.language, classification: "exclusive_core_language" },
          proposedValue: { language: row.language, classification: "mixed_stack_inventory" },
          jdEvidence: [row.quote],
          explanation: `Claiming ${row.language} is mixed-stack should fail on an exclusive requirement.`,
          confidence: "low",
        }),
      ).rejects.toMatchObject({ code: "GENUINE_CORE_LANGUAGE" });
    }
    expect(insert).not.toHaveBeenCalled();
  });

  it("accepts the audit-context fingerprint without STALE_FINGERPRINT", async () => {
    const evaluation = evaluationOf();
    findByKey.mockResolvedValue(evaluation);
    recompute.mockReturnValue(replayResult(71, "apply"));
    const packet = buildScoringAuditContext({
      app: {
        key: evaluation.key,
        company: evaluation.company,
        role: evaluation.role,
        appliedAt: evaluation.appliedAt,
        appliedAtKnown: true,
        appliedAtSource: "email",
        status: "applied",
        furthestStage: "applied",
        interviewRounds: [],
        activelyInterviewing: false,
        lastUpdateAt: evaluation.updatedAt,
        emails: [],
      },
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
      },
    });
    expect(packet.scoring.evaluationFingerprint).toBe(evaluationFingerprint(evaluation));
    expect(packet.scoring.evaluationFingerprint).not.toBe(packet.jobDescription.textHash);
    const view = await proposeClaudeScoringCorrection({
      ...yearsInput(evaluation),
      evaluationFingerprint: packet.scoring.evaluationFingerprint,
    });
    expect(view.status).toBe("proposed");
    expect(view.approved).toBe(false);
  });

  it("rejects an inferred-seniority proposal that only quotes an unrelated responsibility mismatch", async () => {
    const jd =
      "Forward Deployed Engineer. Own deployments end to end without stated support. 5+ years of experience building production systems.";
    const evaluation = evaluationOf({
      jd: { text: jd, textHash: "fde", title: "Forward Deployed Engineer" },
      fit: scoredFit(40, "weak", {
        title: "Forward Deployed Engineer",
        seniority: "senior",
        yearsExperience: { min: 5, raw: "5+" },
      }),
    });
    findByKey.mockResolvedValue(evaluation);
    await expect(
      proposeClaudeScoringCorrection({
        applicationKey: evaluation.key,
        evaluationFingerprint: evaluationFingerprint(evaluation),
        correctionType: "inferred_seniority",
        originalValue: "senior",
        proposedValue: "junior",
        jdEvidence: ["Own deployments end to end without stated support"],
        explanation: "An ownership mismatch quote must not be treated as an inferred-seniority correction.",
        confidence: "low",
      }),
    ).rejects.toMatchObject({ code: "EVIDENCE_NOT_SUPPORTED" });
    expect(insert).not.toHaveBeenCalled();
  });

  it("rejects unsupported JD evidence and stale fingerprints", async () => {
    const evaluation = evaluationOf();
    findByKey.mockResolvedValue(evaluation);
    await expect(
      proposeClaudeScoringCorrection({
        ...yearsInput(evaluation),
        jdEvidence: ["This sentence does not appear anywhere in the stored job description text"],
      }),
    ).rejects.toMatchObject({ code: "UNSUPPORTED_EVIDENCE" });
    await expect(
      proposeClaudeScoringCorrection({ ...yearsInput(evaluation), evaluationFingerprint: "a".repeat(64) }),
    ).rejects.toMatchObject({ code: "STALE_FINGERPRINT" });
    expect(insert).not.toHaveBeenCalled();
  });

  it("rejects duplicate proposed corrections", async () => {
    const evaluation = evaluationOf();
    findByKey.mockResolvedValue(evaluation);
    listByApplicationKey.mockResolvedValue([
      {
        revisionId: "existing",
        applicationKey: evaluation.key,
        evaluationFingerprint: evaluationFingerprint(evaluation),
        status: "proposed",
        correctionType: "years_experience_minimum",
      } as ScoreRevision,
    ]);
    await expect(proposeClaudeScoringCorrection(yearsInput(evaluation))).rejects.toMatchObject({
      code: "DUPLICATE_PROPOSAL",
    });
  });
});

describe("approval safeguards for Claude proposals", () => {
  it("approves only after independent replay matches, then rolls back", async () => {
    const evaluation = evaluationOf();
    findByKey.mockResolvedValue(evaluation);
    recompute.mockReturnValue(replayResult(71, "apply"));
    const view = await proposeClaudeScoringCorrection(yearsInput(evaluation));
    const stored = insert.mock.calls[0]![0] as ScoreRevision;
    findById.mockResolvedValue(stored);
    approveAtomic.mockImplementation(async () => ({
      ...stored,
      status: "approved",
      approvedAt: "2026-10-29T18:00:00.000Z",
      independentlyVerifiedAt: "2026-10-29T18:00:00.000Z",
      activeApplicationKey: evaluation.key,
    }));
    const approved = await approveScoreRevision({
      applicationKey: evaluation.key,
      revisionId: view.revisionId,
      via: "dashboard",
    });
    expect(approved.status).toBe("approved");
    expect(approved.independentlyVerifiedAt).toBeTruthy();
    expect(evaluation.fit!.total).toBe(25);

    rollbackAtomic.mockResolvedValue({ ...approved, status: "rolled_back", activeApplicationKey: undefined });
    const rolled = await rollbackScoreRevision({
      applicationKey: evaluation.key,
      revisionId: view.revisionId,
      via: "dashboard",
    });
    expect(rolled.status).toBe("rolled_back");
  });

  it("refuses to approve when independent replay no longer matches", async () => {
    const evaluation = evaluationOf();
    findByKey.mockResolvedValue(evaluation);
    recompute.mockReturnValue(replayResult(71, "apply"));
    await proposeClaudeScoringCorrection(yearsInput(evaluation));
    const stored = insert.mock.calls[0]![0] as ScoreRevision;
    findById.mockResolvedValue({ ...stored, corrected: { ...stored.corrected, total: 90, recommendation: "strong_apply" } });
    recompute.mockReturnValue(replayResult(71, "apply"));
    await expect(
      approveScoreRevision({ applicationKey: evaluation.key, revisionId: stored.revisionId }),
    ).rejects.toMatchObject({ code: "INCONSISTENT_SCORE" });
    expect(approveAtomic).not.toHaveBeenCalled();
  });

  it("maps a unique-index collision when an active revision already exists", async () => {
    const evaluation = evaluationOf();
    findByKey.mockResolvedValue(evaluation);
    recompute.mockReturnValue(replayResult(71, "apply"));
    await proposeClaudeScoringCorrection(yearsInput(evaluation));
    const stored = insert.mock.calls[0]![0] as ScoreRevision;
    findById.mockResolvedValue(stored);
    approveAtomic.mockRejectedValue(new ConcurrentApprovalError(evaluation.key));
    await expect(
      approveScoreRevision({ applicationKey: evaluation.key, revisionId: stored.revisionId }),
    ).rejects.toMatchObject({ code: "CONCURRENT_APPROVAL" });
  });
});

describe("MCP propose_scoring_correction", () => {
  const mcpDeps = (propose: McpDeps["proposeScoringCorrection"]): McpDeps => ({
    getApplications: vi.fn(async () => []),
    getEvaluationsByKeys: vi.fn(async () => new Map()),
    getActiveScoreRevisions: vi.fn(async () => new Map()),
    getLatestInsightsRun: vi.fn(async () => null),
    getUserProfile: vi.fn(() => {
      throw new Error("profile");
    }),
    getResumeContexts: vi.fn(async () => {
      throw new Error("resume");
    }),
    saveJobProspect: vi.fn(async () => {
      throw new Error("prospect");
    }),
    submitJdCandidate: vi.fn(async () => {
      throw new Error("jd");
    }),
    proposeScoringCorrection: propose,
  });

  it("registers a write-capable tool that cannot approve or rollback", () => {
    const tool = MCP_TOOLS.find((entry) => entry.name === "propose_scoring_correction");
    expect(tool?.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: false,
    });
    expect(MCP_TOOL_NAMES).toContain("propose_scoring_correction");
    expect(MCP_TOOL_NAMES).not.toContain("approve_score_revision");
    expect(MCP_TOOL_NAMES).not.toContain("rollback_score_revision");
    expect(tool?.description).toMatch(/does not approve/i);
  });

  it("returns a proposed view and maps review-required without inserting via the catalog", async () => {
    const propose = vi.fn(async () => ({ status: "proposed", approved: false, proposed: { total: 71 } }));
    const result = await runMcpTool("propose_scoring_correction", yearsInput(evaluationOf()), mcpDeps(propose));
    expect(propose).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ approved: false, proposed: { total: 71 } });

    const reviewing = vi.fn(async () => {
      throw new ScoreRevisionError("LANE_REVIEW_REQUIRED", "lane review");
    });
    const reviewed = await runMcpTool("propose_scoring_correction", yearsInput(evaluationOf()), mcpDeps(reviewing));
    expect(reviewed).toMatchObject({ status: "review_required", approved: false, code: "LANE_REVIEW_REQUIRED" });
  });

  it("does not accept a numeric score through the MCP schema", async () => {
    const propose = vi.fn(async () => ({ ok: true }));
    await expect(
      runMcpTool("propose_scoring_correction", { ...yearsInput(evaluationOf()), proposedScore: 99 }, mcpDeps(propose)),
    ).rejects.toBeInstanceOf(ZodError);
    expect(propose).not.toHaveBeenCalled();
  });
});
