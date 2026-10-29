import { describe, expect, it } from "vitest";
import { userProfile } from "../../config/userProfile.js";
import { analyzeCoreLanguageRequirement } from "../../lib/coreLanguageRequirements.js";
import { deriveClaimableStackFromText } from "../../lib/claimableStack.js";
import {
  evaluateDisjunctiveLanguageRequirement,
  isExclusiveCoreLanguageRequirement,
} from "../../lib/disjunctiveLanguageRequirement.js";
import { analyzeStackMismatch } from "../../lib/stackMismatchAnalysis.js";
import type { ExtractedJobData } from "../../types/job.js";

const claimableFromProfile = () =>
  deriveClaimableStackFromText(
    [
      userProfile.headline,
      ...userProfile.strengths,
      "TypeScript Node.js Python",
    ].join(" "),
  );

describe("disjunctive vs exclusive language gates", () => {
  it("does not stack-mismatch on disjunctive list when candidate has Node.js", () => {
    const job: ExtractedJobData = {
      company: "Aledade",
      title: "Software Engineer I",
      stack: [],
      requiredSkills: [],
      preferredSkills: [],
      domainTags: [],
      responsibilities: [],
      requirements: [
        "Expertise in at least 1 server-side web technology (e.g. Node.js, Java, Python, Scala, C#, C++, Go, JVM)",
      ],
      rawText:
        "Expertise in at least 1 server-side web technology (e.g. Node.js, Java, Python, Scala, C#, C++, Go, JVM).",
    };
    const claimable = claimableFromProfile();
    const analysis = analyzeStackMismatch(job, claimable);
    expect(analysis.stackMismatch).toBe(false);
    expect(analysis.coreLanguageGap).toEqual([]);

    const core = analyzeCoreLanguageRequirement(job, userProfile, claimable);
    expect(core.explicitHardRequirement).toBe(false);
  });

  it("still flags exclusive Go-only requirement", () => {
    const job: ExtractedJobData = {
      company: "GoCo",
      title: "Backend Engineer",
      stack: [],
      requiredSkills: ["Go"],
      preferredSkills: [],
      domainTags: [],
      responsibilities: [],
      requirements: ["Must have professional Go experience in production microservices."],
      rawText: "Must have professional Go experience. Go is our primary backend language.",
    };
    const claimable = claimableFromProfile();
    const analysis = analyzeStackMismatch(job, claimable);
    expect(analysis.stackMismatch).toBe(true);
    expect(analysis.coreLanguageGap).toContain("Go");

    const blob = job.rawText ?? "";
    expect(isExclusiveCoreLanguageRequirement(blob, "Go")).toBe(true);
    expect(evaluateDisjunctiveLanguageRequirement(job, claimable).satisfied).toBe(false);
  });

  it("does not require every language in NYT-style 'technologies such as' examples", () => {
    const job: ExtractedJobData = {
      company: "The New York Times",
      title: "Software Engineer, Reflections",
      stack: ["Go", "Node.js", "GraphQL"],
      requiredSkills: ["Go", "Node.js"],
      preferredSkills: [],
      domainTags: [],
      responsibilities: ["Lead feature development with support from senior engineers"],
      requirements: ["Experience with technologies such as Go, Node.js/Express, GraphQL."],
      rawText:
        "Software Engineer, Reflections. Experience with technologies such as Go, Node.js/Express, GraphQL.",
    };
    const analysis = analyzeStackMismatch(job, claimableFromProfile());
    expect(analysis.stackMismatch).toBe(false);
    expect(analysis.coreLanguageGap).not.toContain("Go");
  });

  it("does not treat Rippling-style backend-language examples as mandatory Python and Go", () => {
    const job: ExtractedJobData = {
      company: "Rippling",
      title: "Software Engineer, Backend, IT Product",
      stack: ["Python", "Go"],
      requiredSkills: ["Python", "Go"],
      preferredSkills: [],
      domainTags: [],
      responsibilities: ["Build backend services for IT product"],
      requirements: ["Experience using a backend language (e.g., Python/Go)."],
      rawText:
        "Software Engineer, Backend, IT Product. Experience using a backend language (e.g., Python/Go).",
    };
    const tsOnly = deriveClaimableStackFromText("TypeScript React Node.js JavaScript");
    const analysis = analyzeStackMismatch(job, tsOnly);
    expect(analysis.stackMismatch).toBe(false);
    expect(analysis.coreLanguageGap).not.toContain("Python");
    expect(analysis.coreLanguageGap).not.toContain("Go");
  });

  it("keeps conjunctive TypeScript, Python, and React as a Python core requirement", () => {
    const job: ExtractedJobData = {
      company: "Arbital Health",
      title: "Full Stack Engineer",
      stack: ["TypeScript", "Python", "React"],
      requiredSkills: ["TypeScript", "Python", "React"],
      preferredSkills: [],
      domainTags: [],
      responsibilities: ["Build full-stack product features"],
      requirements: ["Strong fundamentals in TypeScript, Python, and React."],
      rawText:
        "Full Stack Engineer.\nRequirements:\nStrong fundamentals in TypeScript, Python, and React.",
    };
    const tsOnly = deriveClaimableStackFromText("TypeScript React Node.js JavaScript");
    const analysis = analyzeStackMismatch(job, tsOnly);
    expect(analysis.stackMismatch).toBe(true);
    expect(analysis.coreLanguageGap).toContain("Python");
  });
});
