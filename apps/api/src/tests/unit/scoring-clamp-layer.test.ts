import { describe, expect, it } from "vitest";
import { userProfile } from "../../config/userProfile.js";
import { computeCompositeScore } from "../../lib/compositeScoreModel.js";
import {
  applyScoringClampLayer,
  buildHardRuleFlags,
  detectRoleShapeOutsideLane,
  detectStaffAugContractRole,
} from "../../lib/scoringClampLayer.js";
import { classifyRoleLane } from "../../lib/roleFunctionClassifier.js";
import { stripBoardMatchChromeFromText } from "../../tools/jobBoardMatchExtract.js";
import type { ExtractedJobData } from "../../types/job.js";
import type { RuleEvaluation, ScoreBreakdown } from "../../types/scoring.js";

const cleanRules = (): RuleEvaluation => ({
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

const inflatedLlmScore = (): ScoreBreakdown => ({
  stackFit: 18,
  levelFit: 14,
  domainFit: 8,
  resumeStoryClarity: 9,
  functionalOverlap: 14,
  recruiterFriendliness: 12,
  careerValue: 8,
  total: 0,
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
  ...overrides,
});

const finalizeWithClamp = (
  score: ScoreBreakdown,
  extracted: ExtractedJobData,
  rules: RuleEvaluation,
) => {
  const clamped = applyScoringClampLayer({ score, extracted, rules });
  const composite = computeCompositeScore({
    rawScore: clamped.score,
    rules: clamped.rules,
    extracted,
    profile: userProfile,
  });
  return { score: composite.score, rules: clamped.rules, recommendation: composite.recommendation };
};

describe("scoring clamp layer", () => {
  it("Rule 1 — caps story and functional under core-language mismatch", () => {
    const extracted = makeJob({
      company: "Jane Street",
      stack: ["OCaml"],
      responsibilities: ["Build trading systems in OCaml"],
      rawText: "Core backend in OCaml. Proprietary trading. Senior software engineer.",
      seniority: "Senior",
    });
    const rules = {
      ...cleanRules(),
      stackMismatch: true,
      coreLanguageGap: ["OCaml"],
      explicitCoreLanguageMismatch: true,
      seniorityOverreach: true,
    };
    const { score, rules: clampedRules, recommendation } = finalizeWithClamp(
      inflatedLlmScore(),
      extracted,
      rules,
    );
    expect(score.resumeStoryClarity).toBeLessThanOrEqual(5);
    expect(score.functionalOverlap).toBeLessThanOrEqual(7);
    expect(clampedRules.hardRuleFlags?.some((f) => f.id === "coreLanguageMismatch")).toBe(true);
    expect(recommendation).toBe("weak");
    expect(score.total).toBeLessThanOrEqual(45);
  });

  it("Rule 2 — MLB-style edge/platform role clamps stackFit even when Node/TS keywords match", () => {
    const extracted = makeJob({
      company: "MLB",
      title: "Senior Software Engineer",
      stack: ["Node.js", "TypeScript", "React"],
      responsibilities: [
        "Own edge computing platform architecture",
        "Deploy services on Cloudflare Workers",
      ],
      rawText: "Edge platform, observability, Kubernetes, Terraform",
    });
    expect(
      classifyRoleLane(extracted).label === "platform_infra" ||
        detectRoleShapeOutsideLane(extracted),
    ).toBe(true);
    const rules = {
      ...cleanRules(),
      matureStructuredEmployer: true,
      explicitDegreeRisk: true,
      seniorityOverreach: true,
    };
    const { score } = finalizeWithClamp(inflatedLlmScore(), extracted, rules);
    expect(score.stackFit).toBeLessThanOrEqual(13);
    expect(score.recruiterFriendliness).toBeLessThanOrEqual(8);
  });

  it("Rule 4+7 — JSR Prudential contract fires finance penalty and caps career value", () => {
    const extracted = makeJob({
      company: "JSR Tech Consulting",
      agencyCompanyName: "JSR Tech Consulting",
      employerCompanyName: "Prudential",
      listingCompanyName: "JSR Tech Consulting",
      domainTags: ["insurance", "retirement"],
      rawText: "Hourly W2 contract. Prudential retirement services. Staffing placement.",
      requirements: ["Bachelor's degree required"],
    });
    expect(detectStaffAugContractRole(extracted)).toBe(true);
    const rules = {
      ...cleanRules(),
      explicitDegreeRisk: true,
      matureStructuredEmployer: true,
    };
    const { score, rules: clampedRules } = finalizeWithClamp(inflatedLlmScore(), extracted, rules);
    expect(score.careerValue).toBeLessThanOrEqual(6);
    expect(score.domainFit).toBeLessThanOrEqual(5);
    expect(clampedRules.financePenalty).toBe(true);
    expect(clampedRules.hardRuleFlags?.some((f) => f.id === "financePenalty")).toBe(true);
    expect(clampedRules.hardRuleFlags?.some((f) => f.id === "degreeGateStructuredEmployer")).toBe(
      true,
    );
  });

  it("Rule 1 — AirGarage PHP stack mismatch caps transferable-skills inflation", () => {
    const extracted = makeJob({
      company: "AirGarage",
      stack: ["PHP", "Laravel"],
      requiredSkills: ["PHP"],
      rawText: "Backend engineer. Strong PHP and Laravel required.",
    });
    const rules = {
      ...cleanRules(),
      stackMismatch: true,
      coreLanguageGap: ["PHP"],
    };
    const { score } = finalizeWithClamp(inflatedLlmScore(), extracted, rules);
    expect(score.resumeStoryClarity).toBeLessThanOrEqual(5);
    expect(score.functionalOverlap).toBeLessThanOrEqual(7);
  });

  it("Rule 3 — hardRuleFlags surface seniority and degree gates (never empty when triggers fire)", () => {
    const extracted = makeJob({ company: "BigCo", rawText: "Senior software engineer" });
    const rules = {
      ...cleanRules(),
      seniorityOverreach: true,
      explicitDegreeRisk: true,
      matureStructuredEmployer: true,
    };
    const flags = buildHardRuleFlags(extracted, rules);
    expect(flags.some((f) => f.id === "seniorityOverreach")).toBe(true);
    expect(flags.some((f) => f.id === "degreeGateStructuredEmployer")).toBe(true);
    expect(flags.length).toBeGreaterThanOrEqual(2);
  });

  it("Rule 9 — strips board match chrome from scoring input text", () => {
    const raw = ["92%", "STRONG MATCH", "Experience Level", "Skill 100%", "Real job title"].join(
      "\n",
    );
    const stripped = stripBoardMatchChromeFromText(raw);
    expect(stripped).not.toMatch(/92%/);
    expect(stripped).toContain("Real job title");
  });

  it("does not floor stackFit to 17 when a disjunctive group is satisfied", () => {
    const extracted = makeJob({
      company: "Simeio",
      title: "Full Stack AI Developer",
      stack: ["Python", "Node.js"],
      requirements: ["Strong hands-on experience with Python, Node.js or similar technologies."],
      rawText: "Strong hands-on experience with Python, Node.js or similar technologies.",
    });
    const rules = {
      ...cleanRules(),
      disjunctiveLanguageRequirementSatisfied: true,
      disjunctiveAcceptedLanguages: ["Python", "Node.js"],
      stackMismatch: false,
    };
    const { score } = applyScoringClampLayer({
      score: { ...inflatedLlmScore(), stackFit: 12 },
      extracted,
      rules,
    });
    expect(score.stackFit).toBe(12);
  });
});
