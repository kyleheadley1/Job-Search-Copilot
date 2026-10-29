import { describe, expect, it } from "vitest";
import {
  assessHistoricalEvaluation,
  summarizeHistoricalImpact,
} from "../../lib/historicalScoringImpact.js";
import type { ApplicationEvaluation } from "../../services/gmail/jdRecovery/evaluations.repository.js";
import type { ExtractedJobData } from "../../types/job.js";
import type { RuleEvaluation, ScoreBreakdown } from "../../types/scoring.js";

const rules = (over: Partial<RuleEvaluation>): RuleEvaluation =>
  ({
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
    ...over,
  }) as RuleEvaluation;

const score = (over: Partial<ScoreBreakdown>): ScoreBreakdown => ({
  stackFit: 16,
  levelFit: 14,
  domainFit: 8,
  resumeStoryClarity: 8,
  functionalOverlap: 12,
  recruiterFriendliness: 10,
  careerValue: 7,
  total: 60,
  ...over,
});

const evaluation = (
  over: Partial<ApplicationEvaluation> &
    Pick<ApplicationEvaluation, "key" | "company"> & {
      extracted?: Partial<ExtractedJobData>;
      fitOver?: ApplicationEvaluation["fit"];
    },
): ApplicationEvaluation =>
  ({
    role: over.role ?? "Engineer",
    appliedAt: "2026-10-01T00:00:00.000Z",
    recovery: { status: "scored", attempts: [], serperQueries: 0 },
    outcome: { status: "applied", updatedAt: "2026-10-01T00:00:00.000Z", history: [] },
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
    ...over,
    fit:
      over.fitOver ??
      over.fit ?? {
        total: 72,
        recommendation: "apply",
        recommendedResume: "BASE",
        scoredAt: "2026-10-02T00:00:00.000Z",
        promptVersion: "v1",
        detail: {
          recommendation: "apply",
          recommendedResume: "BASE",
          topMatch: "x",
          mainRisk: "y",
          rationale: [],
          risks: [],
          resumeRationale: [],
          score: score({}),
          rules: rules({}),
          extracted: {
            company: over.company,
            title: over.role ?? "Engineer",
            stack: [],
            requiredSkills: [],
            preferredSkills: [],
            domainTags: [],
            responsibilities: [],
            requirements: [],
            ...(over.extracted ?? {}),
          },
        },
      },
  }) as ApplicationEvaluation;

describe("historical scoring impact (read-only)", () => {
  it("confirms TELCOR-style conflicting totals from stored evidence", () => {
    const telcor = evaluation({
      key: "telcor:ai",
      company: "TELCOR",
      role: "AI Platform Engineer",
      fitOver: {
        total: 79,
        recommendation: "apply",
        recommendedResume: "BASE",
        scoredAt: "2026-10-02T00:00:00.000Z",
        promptVersion: "v1",
        detail: {
          recommendation: "stretch",
          recommendedResume: "BASE",
          topMatch: "React",
          mainRisk: "platform",
          rationale: [],
          risks: [],
          resumeRationale: [],
          score: score({
            total: 60,
            capability: 62,
            scoreDisplay: { final: 60, scoreBand: "stretch", hardGates: [] } as ScoreBreakdown["scoreDisplay"],
          }),
          rules: rules({ roleLane: "platform_infra" }),
          extracted: {
            company: "TELCOR",
            title: "AI Platform Engineer",
            stack: ["TypeScript", "React"],
            requiredSkills: ["TypeScript", "React", "LLMs"],
            preferredSkills: [],
            domainTags: [],
            responsibilities: ["Build AI-powered products"],
            requirements: ["2+ years of experience with TypeScript"],
          },
        },
      },
      jd: {
        text: "AI Platform Engineer. Product-minded engineer shipping React and TypeScript LLM experiences. 2+ years of experience with TypeScript.",
        textHash: "h",
        title: "AI Platform Engineer",
      },
    });
    const row = assessHistoricalEvaluation(telcor);
    expect(row.issues.some((i) => i.kind === "conflicting_totals" && i.confidence === "confirmed")).toBe(
      true,
    );
    expect(row.issues.some((i) => i.kind === "role_lane" && i.confidence === "confirmed")).toBe(true);
  });

  it("marks Genius AI / Sydecar platform_infra rows for later review only", () => {
    const genius = evaluation({
      key: "genius:platform",
      company: "Genius AI",
      role: "Platform Engineer",
      extracted: { title: "Platform Engineer", stack: ["Kubernetes"] },
      fitOver: {
        total: 55,
        recommendation: "stretch",
        recommendedResume: "BASE",
        scoredAt: "2026-10-02T00:00:00.000Z",
        promptVersion: "v1",
        detail: {
          recommendation: "stretch",
          recommendedResume: "BASE",
          topMatch: "infra",
          mainRisk: "k8s",
          rationale: [],
          risks: [],
          resumeRationale: [],
          score: score({ total: 55 }),
          rules: rules({ roleLane: "platform_infra" }),
          extracted: {
            company: "Genius AI",
            title: "Platform Engineer",
            stack: ["Kubernetes"],
            requiredSkills: ["Kubernetes"],
            preferredSkills: [],
            domainTags: [],
            responsibilities: [],
            requirements: [],
          },
        },
      },
    });
    const row = assessHistoricalEvaluation(genius);
    expect(row.issues.some((i) => i.kind === "role_lane" && i.laterReviewOnly)).toBe(true);
  });

  it("summarizes confirmed vs heuristic without writing records", () => {
    const report = summarizeHistoricalImpact([
      evaluation({
        key: "ok:eng",
        company: "OkCo",
        fitOver: {
          total: 72,
          recommendation: "apply",
          recommendedResume: "BASE",
          scoredAt: "2026-10-02T00:00:00.000Z",
          promptVersion: "v1",
        },
      }),
      evaluation({
        key: "meow:fs",
        company: "Meow",
        role: "Full-Stack Engineer",
        jd: {
          text: "Our tech stack: TypeScript, React, Python (FastAPI), Postgres, AWS. Comfortable working across both front-end and back-end.",
          textHash: "m",
        },
        fitOver: {
          total: 55,
          recommendation: "stretch",
          recommendedResume: "BASE",
          scoredAt: "2026-10-02T00:00:00.000Z",
          promptVersion: "v1",
          detail: {
            recommendation: "stretch",
            recommendedResume: "BASE",
            topMatch: "React",
            mainRisk: "Python",
            rationale: [],
            risks: [],
            resumeRationale: [],
            score: score({ total: 55 }),
            rules: rules({ coreLanguageGap: ["Python"], stackMismatch: true }),
            extracted: {
              company: "Meow",
              title: "Full-Stack Engineer",
              stack: ["TypeScript", "React", "Python"],
              requiredSkills: ["TypeScript", "React", "Python"],
              preferredSkills: [],
              domainTags: [],
              responsibilities: [],
              requirements: ["Our tech stack: TypeScript, React, Python (FastAPI), Postgres, AWS"],
            },
          },
        },
      }),
    ]);
    expect(report.evaluated).toBe(2);
    expect(report.potentiallyAffected).toBe(1);
    expect(report.coreLanguageGaps).toHaveLength(1);
    expect(report.confirmed[0]?.key).toBe("meow:fs");
  });
});
