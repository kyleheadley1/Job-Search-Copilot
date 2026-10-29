import { describe, expect, it } from "vitest";
import { evaluateRules } from "../../agents/jobAgent/rules.js";
import { userProfile } from "../../config/userProfile.js";
import {
  detectBackendStackSpecializationGap,
  extractJdBackendLabel,
} from "../../lib/capabilityGap.js";
import { analyzeLanguageRequirementStrength } from "../../lib/languageRequirementStrength.js";
import {
  detectRoleSeniorityOverreach,
  earlyCareerConflictsWithYears,
  seniorityNeedsManualReview,
} from "../../lib/seniorityGate.js";
import {
  extractCompanyFromPostedHeader,
  extractDuplicateCompanyBeforeEmployeeCount,
  normalizeJobLines,
  resolveCompanyFromText,
} from "../../tools/companyCandidateRules.js";
import { extractFromRawText } from "../../tools/deterministicRawTextExtract.js";
import { loadCalibrationFixture, scoreCalibrationAnchor } from "../fixtures/calibrationAnchors.js";

const FIXTURE = loadCalibrationFixture("extractionFailureCascade");
const JOB = FIXTURE.extracted;
const RAW = JOB.rawText!;

describe("extraction failure cascade (Link/Stripe chrome)", () => {
  it("raw text confirms dual extraction failures: company Link + unlabeled Junior/Mid without Seniority label", () => {
    expect(RAW).toMatch(/^Full Stack Engineer\nLink\nPosted on/m);
    expect(RAW).toMatch(/Stripe\nStripe\n10,001\+ employees/);
    expect(RAW).toMatch(/Junior, Mid/);
    expect(RAW).not.toMatch(/^seniority$/im);
    expect(JOB.company).toBe("Link");
    expect(JOB.seniority?.toLowerCase()).toContain("junior");
    expect(JOB.yearsExperience?.min).toBe(10);
  });

  it("company extractor prefers Stripe employee-count card over title-adjacent Link chrome", () => {
    const lines = normalizeJobLines(RAW);
    expect(extractCompanyFromPostedHeader(lines)).toBeNull();
    expect(extractDuplicateCompanyBeforeEmployeeCount(lines)).toBe("Stripe");
    expect(resolveCompanyFromText(RAW)).toBe("Stripe");
  });

  it("years parser reads 2–10+ as min=2, not 10+ from the upper band alone", () => {
    const heur = extractFromRawText(RAW);
    expect(heur.partial.yearsExperience?.min).toBe(2);
    expect(heur.partial.yearsExperience?.max).toBe(10);
  });

  it("seniority gate fails safe — does not fire on polluted years when early chrome conflicts", () => {
    expect(earlyCareerConflictsWithYears(JOB)).toBe(true);
    expect(seniorityNeedsManualReview(JOB)).toBe(true);
    expect(detectRoleSeniorityOverreach(JOB)).toBe(false);

    const rules = evaluateRules(JOB, userProfile, { activeResumeType: "BASE" });
    expect(rules.seniorityOverreach).toBe(false);
    // Grounded 2–10+ floor replaces the polluted min 10, so the early-career veto applies.
  });

  it("empty structured seniority + years ≥5 also fails safe (no prose gate)", () => {
    const empty = {
      ...JOB,
      seniority: undefined,
      yearsExperience: { min: 10, raw: "10+ years" },
      rawText: "Full Stack Engineer\nStripe\nRequirements\n10+ years of experience\nStrong coding skills in any programming language",
    };
    expect(seniorityNeedsManualReview(empty)).toBe(true);
    expect(detectRoleSeniorityOverreach(empty)).toBe(false);
  });

  it("language-lead reads Requirements prose, not Kubernetes/Python skill-tag order", () => {
    expect(extractJdBackendLabel(JOB)).toBeUndefined();
    expect(analyzeLanguageRequirementStrength(JOB, "Python")).toBe("soft");
    expect(detectBackendStackSpecializationGap(JOB, "Node.js TypeScript React backend")).toBeUndefined();
  });

  it("re-scores without seniority hard gate from the cascade", () => {
    const scored = scoreCalibrationAnchor("extractionFailureCascade");
    expect(scored.rules.seniorityOverreach).toBe(false);
    expect(scored.score.scoreDisplay?.hardGates ?? []).not.toContainEqual(
      expect.stringMatching(/seniority/i),
    );
  });
});
