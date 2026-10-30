import { describe, expect, it } from "vitest";
import { userProfile } from "../../config/userProfile.js";
import { deriveClaimableStackFromText } from "../../lib/claimableStack.js";
import {
  evaluateDisjunctiveLanguageRequirement,
  extractLanguageRequirementGroups,
} from "../../lib/disjunctiveLanguageRequirement.js";
import { applyScoringClampLayer } from "../../lib/scoringClampLayer.js";
import { analyzeStackMismatch } from "../../lib/stackMismatchAnalysis.js";
import { detectBackendStackSpecializationGap } from "../../lib/capabilityGap.js";
import {
  calibrationSweResumeContexts,
  loadCalibrationFixture,
  scoreCalibrationAnchor,
} from "../fixtures/calibrationAnchors.js";
import type { ExtractedJobData } from "../../types/job.js";
import type { ScoreBreakdown } from "../../types/scoring.js";

const tsOnly = () => deriveClaimableStackFromText("TypeScript React Node.js JavaScript");
const pythonResume = () =>
  deriveClaimableStackFromText(
    calibrationSweResumeContexts().BASE?.rawText ?? "TypeScript Python React Node.js",
  );

const job = (overrides: Partial<ExtractedJobData>): ExtractedJobData => ({
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

const llm = (stackFit: number): ScoreBreakdown => ({
  stackFit,
  levelFit: 14,
  domainFit: 8,
  resumeStoryClarity: 9,
  functionalOverlap: 12,
  recruiterFriendliness: 11,
  careerValue: 8,
  total: 0,
});

describe("independent language requirement groups", () => {
  it("WorldQuant closed set is independent of React/TypeScript", () => {
    const extracted = job({
      company: "WorldQuant",
      title: "Full Stack Developer",
      stack: ["Python", "Java", "C++", "React", "TypeScript"],
      requiredSkills: ["Python", "Java", "C++", "React", "TypeScript"],
      requirements: [
        "Proficiency in at least one general purpose programming language from Python, Java, and C++.",
        "Experience building web UIs with React and TypeScript",
      ],
      rawText:
        "Proficiency in at least one general purpose programming language from Python, Java, and C++.\nExperience building web UIs with React and TypeScript",
    });
    const groups = extractLanguageRequirementGroups(extracted, tsOnly());
    const closed = groups.find((group) => group.kind === "closed_mandatory_alternatives");
    expect(closed?.languages).toEqual(expect.arrayContaining(["Python", "Java", "C++"]));
    expect(closed?.satisfied).toBe(false);
    const evaled = evaluateDisjunctiveLanguageRequirement(extracted, tsOnly());
    expect(evaled.satisfied).toBe(false);
    const mismatch = analyzeStackMismatch(extracted, tsOnly());
    expect(mismatch.stackMismatch).toBe(true);
    expect(mismatch.coreLanguageGap.some((gap) => /python|java|c\+\+/i.test(gap))).toBe(true);

    const withPython = evaluateDisjunctiveLanguageRequirement(extracted, pythonResume());
    expect(withPython.satisfied).toBe(true);
    expect(analyzeStackMismatch(extracted, pythonResume()).stackMismatch).toBe(false);
  });

  it("Axios frontend JS/TS/React does not satisfy backend Go/Python", () => {
    const extracted = job({
      company: "Axios",
      title: "Software Engineer",
      stack: ["Go", "Python", "JavaScript", "TypeScript", "React"],
      requiredSkills: ["Go", "Python", "JavaScript", "TypeScript", "React"],
      preferredSkills: ["Go", "Python"],
      requirements: [
        "Our backend systems primarily use Go and Python, and you should be comfortable working in or learning either language.",
        "Professional experience with JavaScript or TypeScript and React.",
      ],
      rawText:
        "Required\nOur backend systems primarily use Go and Python, and you should be comfortable working in or learning either language.\nProfessional experience with JavaScript or TypeScript and React.\nPreferred\nProduction experience with Go or Python.",
    });
    const evaled = evaluateDisjunctiveLanguageRequirement(extracted, tsOnly());
    const backend = evaled.groups.find(
      (group) => group.languages.includes("Go") && group.languages.includes("Python"),
    );
    const frontend = evaled.groups.find(
      (group) =>
        group.languages.includes("TypeScript") ||
        group.languages.includes("JavaScript") ||
        group.languages.includes("React"),
    );
    expect(backend?.kind).toBe("ambiguous");
    expect(backend?.satisfied).toBe(false);
    expect(frontend?.satisfied).toBe(true);
    expect(evaled.satisfied).toBe(true);
    const mismatch = analyzeStackMismatch(extracted, tsOnly());
    expect(mismatch.stackMismatch).toBe(false);
    expect(mismatch.coreLanguageGap.some((gap) => /go|python/i.test(gap))).toBe(false);
    expect(mismatch.coreLanguageGap).not.toContain("React");
  });

  it("Simeio Node.js satisfies Python-or-Node without a Python-exclusive gap or stackFit floor", () => {
    const extracted = job({
      company: "Simeio",
      title: "Full Stack AI Developer",
      stack: ["Python", "Node.js"],
      requiredSkills: ["Python", "Node.js"],
      requirements: [
        "Strong hands-on experience with Python, Node.js or similar technologies.",
        "Experience building MCP servers.",
      ],
      responsibilities: ["Design and develop backend services using Python and Node.js."],
      rawText:
        "Strong hands-on experience with Python, Node.js or similar technologies.\nDesign and develop backend services using Python and Node.js.",
    });
    const evaled = evaluateDisjunctiveLanguageRequirement(extracted, tsOnly());
    const group = evaled.groups.find(
      (item) => item.languages.includes("Python") && item.languages.includes("Node.js"),
    );
    expect(group?.kind).toBe("disjunctive_mandatory");
    expect(group?.satisfied).toBe(true);
    expect(evaled.satisfied).toBe(true);
    const mismatch = analyzeStackMismatch(extracted, tsOnly());
    expect(mismatch.stackMismatch).toBe(false);
    expect(mismatch.coreLanguageGap).not.toContain("Python");

    const clamped = applyScoringClampLayer({
      score: llm(15),
      extracted,
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
        notes: [],
        disjunctiveLanguageRequirementSatisfied: true,
        disjunctiveAcceptedLanguages: evaled.acceptedLabels,
        disjunctiveLanguageGroups: evaled.groups,
      },
    });
    expect(clamped.score.stackFit).toBe(15);
  });

  it("NYT illustrative Go stays nonmandatory and JS/TS does not floor stackFit", () => {
    const extracted = job({
      company: "The New York Times",
      title: "Software Engineer, Reflections",
      stack: ["Go", "Node.js", "TypeScript", "React"],
      requiredSkills: ["TypeScript", "React", "JavaScript", "Node.js"],
      requirements: [
        "2+ years of professional experience with modern JavaScript technologies, including React, Node.js, TypeScript, JavaScript, HTML, and CSS",
        "2+ years of experience building backend services and working with technologies such as Go, Node.js/Express, GraphQL, and cloud platforms (GCP or AWS)",
      ],
      rawText:
        "2+ years of professional experience with modern JavaScript technologies, including React, Node.js, TypeScript, JavaScript, HTML, and CSS\n2+ years of experience building backend services and working with technologies such as Go, Node.js/Express, GraphQL, and cloud platforms (GCP or AWS)",
    });
    const evaled = evaluateDisjunctiveLanguageRequirement(extracted, tsOnly());
    const goGroup = evaled.groups.find((group) => group.languages.includes("Go"));
    expect(goGroup?.kind).toBe("illustrative");
    expect(analyzeStackMismatch(extracted, tsOnly()).coreLanguageGap).not.toContain("Go");
    const scored = scoreCalibrationAnchor("nytReflectionsSupportedFeatureOwnership");
    expect(scored.score.stackFit).toBeLessThanOrEqual(scored.fixture.storedCategoryScores.stackFit);
    expect(scored.score.stackFit).toBeLessThan(17);
    expect(scored.rules.coreLanguageGap ?? []).not.toContain("Go");
  });

  it("Rippling e.g. Python/Go stays illustrative with no specialization dock", () => {
    const extracted = job({
      company: "Rippling",
      title: "Software Engineer, Backend, IT Product",
      stack: ["Python", "Go", "React", "TypeScript"],
      requiredSkills: ["Python", "Go", "React", "TypeScript"],
      requirements: [
        "2+ years of professional experience with a focus on full-stack development, demonstrating the ability to deliver reliable, end-to-end products using a backend language (e.g., Python/Go) and frontend technologies like React/TypeScript.",
      ],
      rawText:
        "Software Engineer II, Backend - IT Product.\n2+ years of professional experience with a focus on full-stack development, demonstrating the ability to deliver reliable, end-to-end products using a backend language (e.g., Python/Go) and frontend technologies like React/TypeScript.",
    });
    const evaled = evaluateDisjunctiveLanguageRequirement(extracted, tsOnly());
    const pythonGroup = evaled.groups.find((group) => group.languages.includes("Python"));
    expect(pythonGroup?.kind).toBe("illustrative");
    expect(analyzeStackMismatch(extracted, tsOnly()).stackMismatch).toBe(false);
    expect(analyzeStackMismatch(extracted, tsOnly()).coreLanguageGap).not.toContain("Python");
    const resume = calibrationSweResumeContexts().BASE?.rawText;
    expect(detectBackendStackSpecializationGap(extracted, resume)).toBeUndefined();
  });

  it("keeps Ro Strong Python, Arbital conjunctive Python, UJET exclusive Python, and Meow inventory", () => {
    const ro = loadCalibrationFixture("roAiEngineer");
    const roScored = scoreCalibrationAnchor("roAiEngineer");
    expect(roScored.score.stackFit).toBe(16);
    expect(roScored.rules.specializationGap?.dock).toBe(5);

    const arbital = job({
      company: "Arbital Health",
      title: "Full Stack Engineer",
      stack: ["TypeScript", "Python", "React"],
      requiredSkills: ["TypeScript", "Python", "React"],
      requirements: ["Strong fundamentals in TypeScript, Python, and React."],
      rawText: "Strong fundamentals in TypeScript, Python, and React.",
    });
    const arbitalGroups = extractLanguageRequirementGroups(arbital, tsOnly());
    expect(arbitalGroups.some((group) => group.kind === "conjunctive_mandatory")).toBe(true);
    expect(analyzeStackMismatch(arbital, tsOnly()).coreLanguageGap).toContain("Python");

    const ujet = job({
      company: "UJET",
      title: "Backend Engineer",
      stack: ["Python", "Django"],
      requiredSkills: ["Python", "Django"],
      requirements: ["Professional experience with Python required"],
      rawText: "Backend Engineer. Professional experience with Python required. Django in production.",
    });
    expect(analyzeStackMismatch(ujet, tsOnly()).coreLanguageGap).toContain("Python");

    const meow = job({
      company: "Meow",
      title: "Software Engineer",
      stack: ["TypeScript", "React", "Python"],
      requiredSkills: ["TypeScript", "React", "Python"],
      requirements: ["Comfortable working across both front-end and back-end"],
      rawText:
        "Our tech stack: TypeScript, React, Python (FastAPI), Postgres, AWS. Comfortable working across both front-end and back-end.",
    });
    expect(analyzeStackMismatch(meow, tsOnly()).stackMismatch).toBe(false);
    expect(analyzeStackMismatch(meow, tsOnly()).coreLanguageGap).not.toContain("Python");
    expect(ro.extracted.requirements?.join(" ")).toMatch(/Strong Python/i);
  });

  it("preserves exclusive Go/Java and Trunk Tools early-career FDE ramp", () => {
    const goJob = job({
      company: "GoCo",
      title: "Backend Engineer",
      stack: ["Go"],
      requiredSkills: ["Go"],
      requirements: ["Must have professional Go experience in production microservices."],
      rawText: "Must have professional Go experience. Go is our primary backend language.",
    });
    expect(analyzeStackMismatch(goJob, tsOnly()).coreLanguageGap).toContain("Go");

    const java = scoreCalibrationAnchor("eulerityJavaRequired");
    expect(java.rules.coreLanguageGap).toContain("Java");
    expect(java.score.stackFit).toBeLessThanOrEqual(10);

    const trunk = scoreCalibrationAnchor("augustLawForwardDeployed");
    expect(trunk.rules.titleResponsibilityMismatch).toBe(true);
  });
});
