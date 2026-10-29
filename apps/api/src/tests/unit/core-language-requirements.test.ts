import { describe, expect, it } from "vitest";
import { userProfile } from "../../config/userProfile.js";
import {
  analyzeCoreLanguageRequirement,
  explicitCoreLanguageRiskSummary,
  isMatureStructuredEmployer,
} from "../../lib/coreLanguageRequirements.js";
import { applyMatureExplicitLanguageCalibration } from "../../lib/scoringOutputPolish.js";
import type { ExtractedJobData } from "../../types/job.js";
import type { RuleEvaluation } from "../../types/scoring.js";

const spotifyJavaJd: ExtractedJobData = {
  company: "Spotify",
  title: "Backend Engineer, Artist-First AI Music Lab",
  stack: ["Java"],
  requiredSkills: [],
  preferredSkills: [],
  domainTags: [],
  responsibilities: [
    "You have experience developing backend systems using Java.",
    "Ship LLM-powered features for creators.",
  ],
  requirements: [],
  rawText:
    "You have experience developing backend systems using Java. We work on applied AI and RAG for music discovery.",
};

describe("coreLanguageRequirements", () => {
  it("detects explicit Java requirement for Spotify-style JD", () => {
    const a = analyzeCoreLanguageRequirement(spotifyJavaJd, userProfile);
    expect(a.explicitHardRequirement).toBe(true);
    expect(a.language).toBe("java");
    expect(a.candidateHasProductionLanguage).toBe(false);
  });

  it("does not treat Python as hard when JD lists Python flexibly with TypeScript/JavaScript", () => {
    const job: ExtractedJobData = {
      company: "HealthCo",
      title: "Software Engineer",
      stack: ["Python", "TypeScript"],
      requiredSkills: [],
      preferredSkills: [],
      domainTags: [],
      responsibilities: [
        "Must have Python production experience for backend services.",
        "We work in Python and/or TypeScript across the stack.",
      ],
      requirements: [],
      rawText: "",
    };
    const a = analyzeCoreLanguageRequirement(job, userProfile);
    expect(a.explicitHardRequirement).toBe(false);
    expect(a.language).toBeNull();
  });

  it("does not treat Java as hard when only soft framing appears", () => {
    const job: ExtractedJobData = {
      ...spotifyJavaJd,
      responsibilities: ["Java is a nice to have; we use Kotlin and TypeScript."],
      rawText: "",
    };
    const a = analyzeCoreLanguageRequirement(job, userProfile);
    expect(a.explicitHardRequirement).toBe(false);
  });

  it("recognizes Spotify as mature structured employer", () => {
    expect(isMatureStructuredEmployer("Spotify", "engineering org")).toBe(true);
  });

  it("risk summary uses consistent copy", () => {
    expect(explicitCoreLanguageRiskSummary("java")).toContain("Java");
    expect(explicitCoreLanguageRiskSummary("java")).toContain("mature employer");
  });

  it("mature explicit calibration caps total near low 70s", () => {
    const rules: RuleEvaluation = {
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
      matureStructuredEmployer: true,
      explicitCoreLanguageMismatch: true,
      explicitCoreLanguage: "java",
      notes: [],
    };
    const score = {
      stackFit: 22,
      levelFit: 11,
      domainFit: 9,
      resumeStoryClarity: 15,
      functionalOverlap: 9,
      recruiterFriendliness: 12,
      careerValue: 10,
      total: 88,
    };
    const out = applyMatureExplicitLanguageCalibration({ score, rules });
    expect(out.stackFit).toBeLessThanOrEqual(14);
    expect(out.recruiterFriendliness).toBeLessThanOrEqual(8);
    expect(out.total).toBeLessThanOrEqual(74);
  });
});
