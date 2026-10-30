import { describe, expect, it } from "vitest";
import { exampleUserProfile } from "../../config/userProfile.example.js";
import { evaluationFingerprint } from "../../lib/evaluationFingerprint.js";
import {
  AUDIT_PROTOCOL,
  buildScoringAuditContext,
  deriveAuditRoleCategories,
  listScoredApplicationsForAudit,
} from "../../mcp/scoringAudit.js";
import type { GmailApplication } from "../../services/gmail/gmailApplications.js";
import type { ApplicationEvaluation } from "../../services/gmail/jdRecovery/evaluations.repository.js";
import type { ResumeContextSet } from "../../types/resumeContext.js";

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
    emails: [],
    ...over,
  }) as GmailApplication;

const scored = (
  over: Partial<ApplicationEvaluation> & Pick<ApplicationEvaluation, "key" | "company">,
): ApplicationEvaluation =>
  ({
    role: "Full Stack Engineer",
    appliedAt: "2026-10-01T00:00:00.000Z",
    recovery: { status: "scored", attempts: [], serperQueries: 0, foundVia: "mcp" },
    jd: { text: "Build TypeScript services and React interfaces.", textHash: "h", title: "Full Stack Engineer" },
    fit: {
      total: 72,
      recommendation: "apply",
      recommendedResume: "BASE",
      scoredAt: "2026-10-02T00:00:00.000Z",
      promptVersion: "jd-recovery-v1:base-ai",
      breakdown: {
        categories: { stackFit: 16, levelFit: 14, functionalOverlap: 11 },
        capability: 74,
        survivability: 0.58,
        gapDock: 0,
        hardGates: [],
        topMatch: "TypeScript product work",
        mainRisk: "years",
      },
    },
    outcome: { status: "applied", updatedAt: "2026-10-02T00:00:00.000Z", history: [] },
    createdAt: "2026-10-02T00:00:00.000Z",
    updatedAt: "2026-10-02T00:00:00.000Z",
    ...over,
  }) as ApplicationEvaluation;

const resumes: ResumeContextSet = {
  BASE: {
    type: "BASE",
    sourcePath: "/secret/home/base_resume.txt",
    sourceKind: "txt",
    loadedAt: "2026-10-02T00:00:00.000Z",
    rawText: "TypeScript Node.js React AWS internal tools.",
    metadata: {
      strongestThemes: ["TypeScript"],
      projectEvidence: [],
      keywords: ["typescript", "react"],
      bestFitRoleShapes: ["product_fullstack"],
      avoidUseCases: [],
      claimSupport: [],
    },
  },
};

describe("deriveAuditRoleCategories", () => {
  it("tags stored role-lane and FDE/AI flags without rescoring", () => {
    const evaluation = scored({
      key: "flux:fde",
      company: "FluxCap",
      fit: {
        total: 85,
        recommendation: "strong_apply",
        recommendedResume: "AI",
        scoredAt: "2026-10-02T00:00:00.000Z",
        promptVersion: "jd-recovery-v1:base-ai",
        detail: {
          recommendation: "strong_apply",
          recommendedResume: "AI",
          topMatch: "builder-first FDE",
          mainRisk: "customer delivery",
          rationale: [],
          risks: [],
          resumeRationale: [],
          score: { stackFit: 16, levelFit: 15, domainFit: 8, resumeStoryClarity: 9, functionalOverlap: 12, recruiterFriendliness: 12, careerValue: 8, total: 85 },
          rules: {
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
            fdeBuilderSoftwarePrimary: true,
            roleLane: "product_fullstack",
            notes: [],
          },
          extracted: { company: "FluxCap", title: "Forward Deployed Software Engineer", stack: [], requiredSkills: [], preferredSkills: [], domainTags: [], responsibilities: [], requirements: [] },
        },
      },
    } as ApplicationEvaluation);
    expect(deriveAuditRoleCategories(app({ key: "flux:fde", company: "FluxCap", role: "Forward Deployed Software Engineer" }), evaluation)).toEqual(
      expect.arrayContaining(["full_stack", "forward_deployed"]),
    );
  });

  it("falls back to title language when scoring detail is absent", () => {
    const evaluation = scored({ key: "ig:fe", company: "Intelligems", role: "Frontend Engineer" });
    expect(deriveAuditRoleCategories(app({ key: "ig:fe", company: "Intelligems", role: "Frontend Engineer" }), evaluation)).toContain(
      "frontend",
    );
  });
});

describe("listScoredApplicationsForAudit", () => {
  const flux = app({ key: "flux:fde", company: "FluxCap", role: "Forward Deployed Software Engineer", appliedAt: "2026-10-10T00:00:00.000Z" });
  const intern = app({ key: "bank:intern", company: "Heritage", role: "Software Engineer Intern", status: "rejected", furthestStage: "applied", appliedAt: "2026-09-01T00:00:00.000Z" });
  const missing = app({ key: "gap:eng", company: "GapCo", role: "Engineer" });
  const evaluations = new Map<string, ApplicationEvaluation>([
    [
      flux.key,
      scored({
        key: flux.key,
        company: "FluxCap",
        fit: {
          total: 85,
          recommendation: "strong_apply",
          recommendedResume: "AI",
          scoredAt: "2026-10-11T00:00:00.000Z",
          promptVersion: "jd-recovery-v1:base-ai",
          breakdown: { categories: { stackFit: 16 }, hardGates: [] },
        },
      } as ApplicationEvaluation),
    ],
    [
      intern.key,
      scored({
        key: intern.key,
        company: "Heritage",
        role: "Software Engineer Intern",
        fit: {
          total: 25,
          recommendation: "weak",
          recommendedResume: "BASE",
          scoredAt: "2026-09-02T00:00:00.000Z",
          promptVersion: "older-v0",
          breakdown: { categories: { stackFit: 8 }, hardGates: ["Role seniority/staff bar exceeds early-career profile."] },
        },
      } as ApplicationEvaluation),
    ],
    [
      missing.key,
      {
        key: missing.key,
        company: "GapCo",
        role: "Engineer",
        appliedAt: "2026-10-01T00:00:00.000Z",
        recovery: { status: "not_found", attempts: [], serperQueries: 0 },
        outcome: { status: "applied", updatedAt: "2026-10-01T00:00:00.000Z", history: [] },
        createdAt: "2026-10-01T00:00:00.000Z",
        updatedAt: "2026-10-01T00:00:00.000Z",
      } as ApplicationEvaluation,
    ],
  ]);

  it("returns only scored rows with filters and omits JD text", () => {
    const listed = listScoredApplicationsForAudit([flux, intern, missing], evaluations, {
      offset: 0,
      limit: 20,
    });
    expect(listed.totalMatched).toBe(2);
    expect(listed.applications.map((row) => row.applicationKey)).toEqual(["flux:fde", "bank:intern"]);
    expect(JSON.stringify(listed)).not.toContain("Build TypeScript");

    const high = listScoredApplicationsForAudit([flux, intern, missing], evaluations, {
      offset: 0,
      limit: 20,
      minScore: 80,
      recommendation: "strong_apply",
      resumeVariant: "AI",
    });
    expect(high.applications).toHaveLength(1);
    expect(high.applications[0]?.applicationKey).toBe("flux:fde");
    expect(high.applications[0]?.hardGateFired).toBe(false);

    const gated = listScoredApplicationsForAudit([flux, intern, missing], evaluations, {
      offset: 0,
      limit: 20,
      maxScore: 40,
      outcome: "rejected",
      promptVersion: "older-v0",
    });
    expect(gated.applications).toHaveLength(1);
    expect(gated.applications[0]?.hardGateFired).toBe(true);
  });
});

describe("buildScoringAuditContext", () => {
  it("returns stored JD and current profile, flags missing snapshots, and omits resume paths", () => {
    const evaluation = scored({
      key: "acme:engineer",
      company: "Acme",
      recovery: {
        status: "scored",
        attempts: [{ url: "https://attempt-secret.example/job/1", source: "email_link", ok: false }],
        serperQueries: 0,
        url: "https://boards.example/jobs/1",
        notes: ["internal_note_secret"],
        foundVia: "mcp",
        match: { level: "low", signals: ["user_picked_candidate"] },
      },
    } as ApplicationEvaluation);
    const packet = buildScoringAuditContext({
      app: app({
        key: "acme:engineer",
        company: "Acme",
        from: "recruiter@acme.com",
        refreshToken: "refresh-secret",
      } as GmailApplication & { from: string; refreshToken: string }),
      evaluation,
      profile: exampleUserProfile,
      resumeContexts: resumes,
    });

    expect(packet.readOnly).toBe(true);
    expect(packet.jobDescription.text).toContain("TypeScript");
    expect(packet.candidate.profile.headline).toBe(exampleUserProfile.headline);
    expect(packet.candidate.profileIsCurrentNotHistorical).toBe(true);
    expect(packet.scoring.evidenceGaps).toEqual(
      expect.arrayContaining([
        "scoringDetailMissing",
        "llmCategoriesMissing",
        "profileNotSnapshottedAtScoring",
        "resumeNotSnapshottedAtScoring",
        "promptVersionIsPipelineLabel",
      ]),
    );
    expect(packet.scoring.recommendationFromScore).toBe("apply");
    expect(packet.scoring.recommendationBoundary?.cutoffs).toEqual({
      strong_apply: 80,
      apply: 65,
      stretch: 50,
    });
    expect(packet.scoring.recommendationBoundary?.recommendation).toBe("apply");
    expect(packet.scoring.stackPenalty?.combinedStackPressure.note).toMatch(/diagnostic only/i);
    expect(packet.scoring.total).toBe(72);
    expect(packet.scoring.evaluationFingerprint).toBe(evaluationFingerprint(evaluation));
    expect(packet.scoring.evaluationFingerprint).not.toBe(packet.jobDescription.textHash);
    expect(packet.candidate.recommendedResumeEvidence?.rawText).toContain("TypeScript");
    expect(JSON.stringify(packet)).not.toContain("/secret/home");
    expect(JSON.stringify(packet)).not.toContain("recruiter@acme.com");
    expect(JSON.stringify(packet)).not.toContain("refresh-secret");
    expect(JSON.stringify(packet)).not.toContain("attempt-secret.example");
    expect(JSON.stringify(packet)).not.toContain("internal_note_secret");
    expect(AUDIT_PROTOCOL.readOnly).toBe(true);
  });

  it("does not imply a stack-mismatch clamp for a Ro-style stored evaluation that never clamped", () => {
    const evaluation = scored({
      key: "ro::ai engineer",
      company: "Ro",
      role: "AI Engineer",
      jd: {
        text: "Ro — AI Engineer\nStrong Python and experience shipping LLM/RAG systems.",
        textHash: "ro-hash",
        title: "AI Engineer",
        company: "Ro",
      },
      fit: {
        total: 80,
        recommendation: "strong_apply",
        recommendedResume: "BASE",
        scoredAt: "2026-10-02T00:00:00.000Z",
        promptVersion: "jd-recovery-v1:base-ai",
        breakdown: {
          categories: { stackFit: 16, levelFit: 15, functionalOverlap: 15 },
          capability: 86,
          survivability: 0.58,
          gapDock: 5,
          hardGates: [],
          topMatch: "Python LLM work",
          mainRisk: "years",
        },
        detail: {
          recommendation: "strong_apply",
          recommendedResume: "BASE",
          topMatch: "Python LLM work",
          mainRisk: "years",
          rationale: [],
          risks: [],
          resumeRationale: [],
          extracted: {
            company: "Ro",
            title: "AI Engineer",
            stack: ["Python"],
            requiredSkills: ["Python"],
            preferredSkills: [],
            domainTags: [],
            requirements: ["Strong Python and experience shipping LLM/RAG systems"],
            rawText: "Ro — AI Engineer\nStrong Python and experience shipping LLM/RAG systems.",
          },
          rules: {
            stackMismatch: false,
            coreLanguageGap: [],
            specializationGap: {
              kind: "backend_stack",
              name: "Python backend",
              evidence: "Role leads with Python",
              severity: "moderate",
              lever: "upskill",
              dock: 5,
              jdSide: "Python",
            },
            roleLane: "product_backend",
          },
          score: {
            stackFit: 16,
            levelFit: 15,
            domainFit: 8,
            resumeStoryClarity: 9,
            functionalOverlap: 15,
            recruiterFriendliness: 12,
            careerValue: 9,
            total: 80,
            capability: 86,
            llmCategories: {
              stackFit: 16,
              levelFit: 15,
              domainFit: 8,
              resumeStoryClarity: 9,
              functionalOverlap: 15,
              recruiterFriendliness: 12,
              careerValue: 9,
            },
            scoreDisplay: {
              capability: 86,
              survivability: 0.58,
              final: 80,
              survAdjustment: -1,
              gapDock: 5,
              scoreDerivation: "86 + (-1) − 5 = 80",
              scoreBand: "strong_apply",
              bandHeadline: "Strong apply",
              hardGates: [],
            },
          },
        },
      },
    } as ApplicationEvaluation);
    const packet = buildScoringAuditContext({
      app: app({ key: "ro::ai engineer", company: "Ro", role: "AI Engineer" }),
      evaluation,
      profile: exampleUserProfile,
      resumeContexts: resumes,
    });
    expect(packet.scoring.total).toBe(80);
    expect(packet.scoring.stackPenalty?.originalLlmStackFit).toBe(16);
    expect(packet.scoring.stackPenalty?.adjustedStackFit).toBe(16);
    expect(packet.scoring.stackPenalty?.stackMismatchClampApplied).toBe(false);
    expect(packet.scoring.stackPenalty?.specializationGap?.dock).toBe(5);
  });
});
