import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { evaluateRules } from "../../agents/jobAgent/rules.js";
import { selectResume } from "../../agents/jobAgent/resumeSelector.js";
import { userProfile } from "../../config/userProfile.js";
import { deriveClaimableStackFromText } from "../../lib/claimableStack.js";
import { computeCompositeScore, resolveCompositeRecommendation } from "../../lib/compositeScoreModel.js";
import { applyScoringClampLayer } from "../../lib/scoringClampLayer.js";
import { reconcileSeniority } from "../../lib/seniorityReconciliation.js";
import { analyzeStackMismatch } from "../../lib/stackMismatchAnalysis.js";
import type { ExtractedJobData } from "../../types/job.js";
import type { ResumeContextSet } from "../../types/resumeContext.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SWE_RESUME = fs.readFileSync(
  path.resolve(__dirname, "../fixtures/resumes/swe_resume.txt"),
  "utf8",
);

const mockResumeContexts = (): ResumeContextSet => ({
  BASE: {
    type: "BASE",
    sourcePath: "swe_resume.txt",
    sourceKind: "txt",
    loadedAt: new Date().toISOString(),
    rawText: SWE_RESUME,
    metadata: {
      strongestThemes: [],
      projectEvidence: [],
      keywords: [],
      bestFitRoleShapes: ["product_fullstack"],
      avoidUseCases: [],
      claimSupport: [],
    },
  },
});

const makeJob = (overrides: Partial<ExtractedJobData>): ExtractedJobData => ({
  company: "TestCo",
  title: "Software Engineer",
  stack: [],
  requiredSkills: [],
  preferredSkills: [],
  domainTags: [],
  responsibilities: [],
  requirements: [],
  remoteType: "remote",
  ...overrides,
});

const rulesFor = (job: Partial<ExtractedJobData>) =>
  evaluateRules(makeJob(job), userProfile, { resumeContexts: mockResumeContexts() });

describe("claimable stack from resume", () => {
  it("derives full coverage from experience bullets and partial from skills-only", () => {
    const stack = deriveClaimableStackFromText(SWE_RESUME);
    const byId = new Map(stack.skills.map((s) => [s.id, s.coverage]));
    expect(byId.get("typescript")).toBe("partial");
    expect(byId.get("react")).toBe("full");
    expect(byId.get("python")).toBe("full");
    expect(byId.get("nodejs")).toBe("full");
    expect(byId.get("tailwind")).toBe("partial");
  });
});

describe("stack mismatch two-tier detection", () => {
  it("PHP-core role with JS framework acceptance → Tier 1 (e.Republic shape)", () => {
    const job = makeJob({
      company: "e.Republic",
      title: "Junior Full-Stack Developer",
      stack: ["PHP", "JavaScript", "MySQL"],
      requiredSkills: ["PHP", "Custom PHP full-stack development", "MySQL"],
      requirements: [
        "Custom PHP full-stack development for content management systems.",
        "Relevant experience with other modern PHP and JavaScript frameworks accepted.",
        "Collaborate with product on shipped production features.",
      ],
      responsibilities: ["Build and maintain production web applications."],
      rawText:
        "Remote. Custom PHP full-stack development. Relevant experience with other modern PHP and JavaScript frameworks accepted.",
    });
    const claimable = deriveClaimableStackFromText(SWE_RESUME);
    const analysis = analyzeStackMismatch(job, claimable);
    expect(analysis.stackMismatch).toBe(true);
    expect(analysis.coreLanguageGap).toContain("PHP");

    const rules = rulesFor(job);
    expect(rules.stackMismatch).toBe(true);
    expect(rules.coreLanguageGap).toContain("PHP");

    const rawScore = {
      stackFit: 17,
      levelFit: 16,
      domainFit: 8,
      resumeStoryClarity: 9,
      functionalOverlap: 13,
      recruiterFriendliness: 12,
      careerValue: 8,
      total: 0,
    };
    const clamped = applyScoringClampLayer({ score: rawScore, extracted: job, rules });
    expect(clamped.score.stackFit).toBeLessThanOrEqual(10);
    expect(clamped.score.resumeStoryClarity).toBeLessThanOrEqual(5);
    expect(clamped.score.functionalOverlap).toBeLessThanOrEqual(7);

    const composite = computeCompositeScore({
      rawScore: clamped.score,
      rules: clamped.rules,
      extracted: job,
      profile: userProfile,
      resumeText: SWE_RESUME,
    });
    expect(composite.score.capability).toBeLessThan(75);
    expect(composite.recommendation).not.toBe("strong_apply");
  });

  it("Node/TS/React role with all required core present → no mismatch", () => {
    const job = makeJob({
      title: "Full-Stack Engineer",
      stack: ["TypeScript", "Node.js", "React"],
      requiredSkills: ["TypeScript", "Node.js", "React", "REST APIs"],
      requirements: ["Build production APIs and React features."],
    });
    const rules = rulesFor(job);
    expect(rules.stackMismatch).toBe(false);
    expect(rules.coreLanguageGap).toEqual([]);
    expect(rules.adjacentFrameworkGap).toEqual([]);

    const composite = computeCompositeScore({
      rawScore: {
        stackFit: 18,
        levelFit: 16,
        domainFit: 8,
        resumeStoryClarity: 9,
        functionalOverlap: 13,
        recruiterFriendliness: 12,
        careerValue: 8,
        total: 0,
      },
      rules,
      extracted: job,
      profile: userProfile,
      resumeText: SWE_RESUME,
    });
    expect(composite.score.stackFit).toBe(18);
    expect(composite.score.capability).toBeGreaterThan(70);
  });

  it("Go-core service role without Go → Tier 1 caps", () => {
    const job = makeJob({
      title: "Backend Engineer",
      requiredSkills: ["Go", "Microservices"],
      requirements: ["Strong proficiency in Go required.", "Production microservices experience."],
      rawText: "Go is our primary backend language.",
    });
    const rules = rulesFor(job);
    expect(rules.stackMismatch).toBe(true);
    expect(rules.coreLanguageGap).toContain("Go");

    const clamped = applyScoringClampLayer({
      score: {
        stackFit: 19,
        levelFit: 15,
        domainFit: 7,
        resumeStoryClarity: 9,
        functionalOverlap: 12,
        recruiterFriendliness: 11,
        careerValue: 7,
        total: 0,
      },
      extracted: job,
      rules,
    });
    expect(clamped.score.stackFit).toBeLessThanOrEqual(10);
  });

  it("Vue required with React claimable → Tier 2, not full stackMismatch", () => {
    const job = makeJob({
      title: "Frontend Engineer",
      requiredSkills: ["Vue.js", "JavaScript"],
      requirements: ["Must have production Vue.js experience."],
    });
    const rules = rulesFor(job);
    expect(rules.stackMismatch).toBe(false);
    expect(rules.adjacentFrameworkGap).toContain("Vue");

    const clamped = applyScoringClampLayer({
      score: {
        stackFit: 18,
        levelFit: 14,
        domainFit: 7,
        resumeStoryClarity: 8,
        functionalOverlap: 12,
        recruiterFriendliness: 11,
        careerValue: 7,
        total: 0,
      },
      extracted: job,
      rules,
    });
    expect(clamped.score.stackFit).toBeLessThanOrEqual(15);
    expect(clamped.score.stackFit).toBeGreaterThan(10);
  });

  it("PHP only under nice-to-have with Node core → no mismatch", () => {
    const job = makeJob({
      title: "Backend Engineer",
      stack: ["Node.js", "TypeScript"],
      requiredSkills: ["Node.js", "TypeScript", "REST APIs"],
      preferredSkills: ["PHP"],
      requirements: ["Node.js backend development required."],
      rawText: "Nice to have: PHP, Laravel.",
    });
    const rules = rulesFor(job);
    expect(rules.stackMismatch).toBe(false);
    expect(rules.coreLanguageGap).toEqual([]);
  });
});

describe("mixed-stack language classification", () => {
  const claimableWithoutPython = () => {
    const full = deriveClaimableStackFromText(SWE_RESUME);
    return { ...full, skills: full.skills.filter((s) => s.id !== "python") };
  };

  it("Meow-style TypeScript/React/Python inventory is not a Python core gap", () => {
    const extracted = makeJob({
      company: "Meow",
      title: "Full-Stack Engineer",
      stack: ["TypeScript", "React", "Python", "Postgres", "AWS"],
      requiredSkills: ["TypeScript", "React", "Python"],
      requirements: [
        "Comfortable working across both front-end and back-end",
        "Our tech stack: TypeScript, React, Python (FastAPI), Postgres, AWS",
      ],
      rawText: [
        "Full-Stack Engineer at Meow.",
        "Comfortable working across both front-end and back-end.",
        "Our tech stack: TypeScript, React, Python (FastAPI), Postgres, AWS.",
      ].join("\n"),
    });
    const analysis = analyzeStackMismatch(extracted, claimableWithoutPython());
    expect(analysis.coreLanguageGap).not.toContain("Python");
    expect(analysis.tier).not.toBe("tier1_core_language");
  });

  it("FastAPI-heavy Python backend still treats Python as a core language", () => {
    const extracted = makeJob({
      company: "DataCamp",
      title: "Backend Engineer",
      stack: ["Python", "FastAPI", "Postgres"],
      requiredSkills: ["Python", "FastAPI"],
      requirements: [
        "Professional experience with Python required",
        "Build production APIs with FastAPI",
      ],
      rawText: [
        "Backend Engineer. Professional experience with Python required.",
        "Build production APIs with FastAPI and Postgres.",
      ].join("\n"),
    });
    const analysis = analyzeStackMismatch(extracted, claimableWithoutPython());
    expect(analysis.coreLanguageGap).toContain("Python");
    expect(analysis.tier).toBe("tier1_core_language");
  });

  it("must-have conjunctive Python with TypeScript stays required", () => {
    const extracted = makeJob({
      title: "Full-Stack Engineer",
      stack: ["TypeScript", "Python"],
      requiredSkills: ["TypeScript", "Python"],
      requirements: ["Must have experience with TypeScript, React, and Python"],
      rawText: "Must have experience with TypeScript, React, and Python.",
    });
    expect(analyzeStackMismatch(extracted, claimableWithoutPython()).coreLanguageGap).toContain("Python");
  });
});

describe("seniority reconciliation", () => {
  it("reconciles junior title when parsed seniority conflicts", () => {
    const job = makeJob({
      title: "Junior Software Engineer",
      seniority: "senior",
      rawText: "Junior Software Engineer — build production features.",
    });
    const { job: reconciled, conflictLogged } = reconcileSeniority(job);
    expect(reconciled.seniority).toBe("junior");
    expect(conflictLogged).toBe(true);
  });
});

describe("resume variant selection", () => {
  const score = {
    stackFit: 16,
    levelFit: 14,
    domainFit: 7,
    resumeStoryClarity: 8,
    functionalOverlap: 12,
    recruiterFriendliness: 11,
    careerValue: 7,
    total: 72,
  };

  it("Junior title with production work and no new-grad language → SWE (e.Republic shape)", async () => {
    const extracted = makeJob({
      company: "e.Republic",
      title: "Junior Full-Stack Developer",
      stack: ["PHP", "JavaScript"],
      requiredSkills: ["PHP"],
      requirements: ["Ship production CMS features.", "Custom PHP full-stack development."],
      rawText: "Junior role building production web applications. No new grad program.",
    });
    const result = await selectResume({
      extracted,
      score,
      topMatch: "Partial overlap",
      mainRisk: "PHP gap",
      userProfile,
      resumeContexts: mockResumeContexts(),
    });
    expect(result.recommendedResume).toBe("BASE");
  });
});
