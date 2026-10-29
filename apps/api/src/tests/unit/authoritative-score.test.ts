import { describe, expect, it } from "vitest";
import { evaluateRules } from "../../agents/jobAgent/rules.js";
import { userProfile } from "../../config/userProfile.js";
import {
  presentFitForDisplay,
  resolveStoredFitScore,
  sealAuthoritativeScore,
} from "../../lib/authoritativeScore.js";
import { computeCompositeScore } from "../../lib/compositeScoreModel.js";
import { recommendationForScore } from "../../lib/compositeScoring.js";
import { applyScoringClampLayer } from "../../lib/scoringClampLayer.js";
import { buildScoreDisplay } from "../../lib/scoreDisplayModel.js";
import { fitFromJob } from "../../services/gmail/jdRecovery/runRecovery.js";
import { toEvaluationSummary } from "../../services/gmail/jdRecovery/summary.js";
import type { ApplicationEvaluation } from "../../services/gmail/jdRecovery/evaluations.repository.js";
import type { ExtractedJobData, JobRecord } from "../../types/job.js";
import type { Recommendation, RuleEvaluation, ScoreBreakdown } from "../../types/scoring.js";

const CATEGORY_SCORE: ScoreBreakdown = {
  stackFit: 18,
  levelFit: 16,
  domainFit: 8,
  resumeStoryClarity: 9,
  functionalOverlap: 13,
  recruiterFriendliness: 12,
  careerValue: 8,
  total: 0,
};

const BASE_JOB: ExtractedJobData = {
  company: "Acme",
  title: "Software Engineer",
  stack: ["TypeScript", "React"],
  requiredSkills: ["TypeScript", "React"],
  preferredSkills: [],
  domainTags: [],
  responsibilities: ["Build product features"],
  requirements: ["2+ years of experience with TypeScript"],
  rawText: "Software Engineer. Build product features with TypeScript and React. 2+ years of experience with TypeScript.",
};

const emptyRules = (): RuleEvaluation =>
  evaluateRules(BASE_JOB, userProfile, { activeResumeType: "BASE" });

describe("authoritative score", () => {
  it("TELCOR-style conflicting totals prefer scoreDisplay.final without mutating storage", () => {
    const stored = {
      total: 79,
      recommendation: "apply",
      detail: {
        recommendation: "stretch",
        score: {
          total: 60,
          capability: 62,
          scoreDisplay: {
            final: 60,
            scoreBand: "stretch",
            scoreDerivation: "62 + (-2) = 60",
            hardGates: [],
          },
        },
      },
    };
    const original = structuredClone(stored);
    const resolved = resolveStoredFitScore(stored);
    expect(resolved.source).toBe("composite_display");
    expect(resolved.total).toBe(60);
    expect(resolved.recommendation).toBe("stretch");
    expect(resolved.conflict).toBe(true);

    const presented = presentFitForDisplay(stored);
    expect(presented.total).toBe(60);
    expect(presented.recommendation).toBe("stretch");
    expect(presented.scoreConflict).toBe(true);
    expect(presented.storedFitTotal).toBe(79);
    expect(stored).toEqual(original);
  });

  it("flags unresolved totals when fit, detail, and display all disagree", () => {
    const resolved = resolveStoredFitScore({
      total: 79,
      recommendation: "apply",
      detail: {
        score: {
          total: 70,
          scoreDisplay: { final: 60, scoreBand: "stretch", hardGates: [] },
        },
      },
    });
    expect(resolved.source).toBe("unresolved");
    expect(resolved.total).toBeNull();
    expect(resolved.conflict).toBe(true);
    const presented = presentFitForDisplay({
      total: 79,
      recommendation: "apply",
      detail: {
        score: {
          total: 70,
          scoreDisplay: { final: 60, scoreBand: "stretch", hardGates: [] },
        },
      },
    });
    expect(presented.total).toBe(79);
    expect(presented.scoreConflict).toBe(true);
    expect(presented.authoritativeSource).toBe("unresolved");
  });

  it("seals new evaluations so total, display final, and recommendation agree", () => {
    const rules = emptyRules();
    const composite = computeCompositeScore({
      rawScore: CATEGORY_SCORE,
      rules,
      extracted: BASE_JOB,
      profile: userProfile,
      resumeText: "TypeScript React engineer",
    });
    const display = buildScoreDisplay({
      score: composite.score,
      rules,
      extracted: BASE_JOB,
      recommendation: composite.recommendation,
    });
    const sealed = sealAuthoritativeScore({
      score: { ...composite.score, scoreDisplay: display },
      recommendation: composite.recommendation,
    });
    expect(sealed.score.total).toBe(display!.final);
    expect(sealed.recommendation).toBe(display!.scoreBand);
    expect(sealed.recommendation).toBe(recommendationForScore(sealed.score.total));
  });

  it("hard-gated scores persist the floor and weak recommendation", () => {
    const job: ExtractedJobData = {
      ...BASE_JOB,
      title: "Staff Software Engineer",
      seniority: "Staff",
      requirements: ["10+ years of professional software engineering experience"],
      rawText: "Staff Software Engineer. 10+ years of professional software engineering experience.",
    };
    const rules = evaluateRules(job, userProfile, { activeResumeType: "BASE" });
    expect(rules.seniorityOverreach).toBe(true);
    const composite = computeCompositeScore({
      rawScore: CATEGORY_SCORE,
      rules,
      extracted: job,
      profile: userProfile,
    });
    expect(composite.hardGateFired).toBe(true);
    expect(composite.score.total).toBe(25);
    const display = buildScoreDisplay({
      score: composite.score,
      rules,
      extracted: job,
      recommendation: composite.recommendation,
      hardGateReasons: composite.hardGateReasons,
    });
    const sealed = sealAuthoritativeScore({
      score: { ...composite.score, scoreDisplay: display },
      recommendation: composite.recommendation,
    });
    expect(sealed.score.total).toBe(25);
    expect(sealed.recommendation).toBe("weak");
    expect(display!.hardGates.length).toBeGreaterThan(0);
    expect(display!.final).toBe(25);
  });

  it("capped platform/infra scores use the post-cap composite, not a 7-category sum", () => {
    const job: ExtractedJobData = {
      company: "StubHub",
      title: "Core Compute Platform Engineer",
      stack: ["Kubernetes", "Terraform", "Go"],
      requiredSkills: ["Kubernetes", "Terraform"],
      preferredSkills: [],
      domainTags: [],
      responsibilities: ["Run Kubernetes clusters and CI/CD"],
      requirements: ["3+ years of experience with Terraform"],
      rawText:
        "Platform Engineer. Run our Kubernetes clusters and CI/CD deployment pipelines. 3+ years of experience with Terraform.",
    };
    const rules = evaluateRules(job, userProfile, { activeResumeType: "BASE" });
    const clamped = applyScoringClampLayer({
      score: CATEGORY_SCORE,
      extracted: job,
      rules,
    });
    const composite = computeCompositeScore({
      rawScore: clamped.score,
      rules: clamped.rules,
      extracted: job,
      profile: userProfile,
    });
    const display = buildScoreDisplay({
      score: composite.score,
      rules: clamped.rules,
      extracted: job,
      recommendation: composite.recommendation,
    });
    const sealed = sealAuthoritativeScore({
      score: { ...composite.score, scoreDisplay: display },
      recommendation: composite.recommendation,
    });
    const categorySum =
      CATEGORY_SCORE.stackFit +
      CATEGORY_SCORE.levelFit +
      CATEGORY_SCORE.domainFit +
      CATEGORY_SCORE.resumeStoryClarity +
      CATEGORY_SCORE.functionalOverlap +
      CATEGORY_SCORE.recruiterFriendliness +
      CATEGORY_SCORE.careerValue;
    expect(sealed.score.total).toBe(display!.final);
    expect(sealed.score.total).toBeLessThan(categorySum);
    expect(composite.score.capabilityBreakdown?.stackFit ?? 99).toBeLessThanOrEqual(18);
  });

  it("fitFromJob persists one total on fit and detail.score", () => {
    const rules = emptyRules();
    const composite = computeCompositeScore({
      rawScore: CATEGORY_SCORE,
      rules,
      extracted: BASE_JOB,
      profile: userProfile,
    });
    const display = buildScoreDisplay({
      score: composite.score,
      rules,
      extracted: BASE_JOB,
      recommendation: composite.recommendation,
    });
    const conflictingDisplay = {
      ...display!,
      final: 60,
      scoreBand: "stretch" as const,
      bandHeadline: "Apply but weak (stretch)" as const,
    };
    const job = {
      extracted: BASE_JOB,
      rules,
      score: {
        ...composite.score,
        total: 79,
        scoreDisplay: conflictingDisplay,
      },
      recommendation: "apply" as Recommendation,
      recommendedResume: "BASE",
      topMatch: "TypeScript",
      mainRisk: "none",
      rationale: [],
      risks: [],
      resumeRationale: [],
    } as unknown as JobRecord;

    const fit = fitFromJob(job);
    expect(fit.total).toBe(60);
    expect(fit.detail?.score.total).toBe(60);
    expect(fit.detail?.score.scoreDisplay?.final).toBe(60);
    expect(fit.recommendation).toBe("stretch");
  });

  it("dashboard evaluation summary overlays TELCOR-style conflict without mutating storage", () => {
    const evaluation = {
      key: "TELCOR:Gmail",
      company: "TELCOR",
      role: "Software Engineer",
      appliedAt: "2026-05-13T00:00:00.000Z",
      recovery: { status: "scored", attempts: [], serperQueries: 0 },
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
          rules: emptyRules(),
          extracted: BASE_JOB,
        },
      },
      outcome: { status: "applied", updatedAt: "2026-05-13T00:00:00.000Z", history: [] },
      createdAt: "2026-05-13T00:00:00.000Z",
      updatedAt: "2026-05-13T00:00:00.000Z",
    } as ApplicationEvaluation;
    const originalTotal = evaluation.fit!.total;
    const summary = toEvaluationSummary(evaluation);
    expect(summary.fitTotal).toBe(60);
    expect(summary.recommendation).toBe("stretch");
    expect(summary.scoreConflict).toBe(true);
    expect(summary.storedFitTotal).toBe(79);
    expect(evaluation.fit!.total).toBe(originalTotal);
  });
});
