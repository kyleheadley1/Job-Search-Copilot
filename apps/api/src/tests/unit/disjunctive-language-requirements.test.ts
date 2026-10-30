import { describe, expect, it } from "vitest";
import { userProfile } from "../../config/userProfile.js";
import { analyzeCoreLanguageRequirement } from "../../lib/coreLanguageRequirements.js";
import { deriveClaimableStackFromText } from "../../lib/claimableStack.js";
import { detectBackendStackSpecializationGap } from "../../lib/capabilityGap.js";
import {
  evaluateDisjunctiveLanguageRequirement,
  findLiteralLeadsWithSourceQuote,
  isExclusiveCoreLanguageRequirement,
  languageOnlyInIllustrativeExample,
  spanLooksDisjunctive,
} from "../../lib/disjunctiveLanguageRequirement.js";
import { analyzeStackMismatch } from "../../lib/stackMismatchAnalysis.js";
import { calibrationSweResumeContexts } from "../fixtures/calibrationAnchors.js";
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

  it("treats Strong Go and Strong Java as named-language primary requirements", () => {
    const goJob: ExtractedJobData = {
      company: "GoPrimary",
      title: "Backend Engineer",
      stack: ["Go"],
      requiredSkills: ["Go"],
      preferredSkills: [],
      domainTags: [],
      responsibilities: ["Build services"],
      requirements: ["Strong Go and experience shipping production services"],
      rawText: "Backend Engineer.\nStrong Go and experience shipping production services.",
    };
    const javaJob: ExtractedJobData = {
      company: "JavaPrimary",
      title: "Backend Engineer",
      stack: ["Java"],
      requiredSkills: ["Java"],
      preferredSkills: [],
      domainTags: [],
      responsibilities: ["Build services"],
      requirements: ["Strong Java and experience shipping production services"],
      rawText: "Backend Engineer.\nStrong Java and experience shipping production services.",
    };
    const goQuote = findLiteralLeadsWithSourceQuote(goJob, "Go");
    const javaQuote = findLiteralLeadsWithSourceQuote(javaJob, "Java");
    expect(goQuote).toEqual(expect.stringMatching(/Strong Go/i));
    expect(javaQuote).toEqual(expect.stringMatching(/Strong Java/i));
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

  it("does not treat Rippling live 'professional experience with ... (e.g., Python/Go)' as Python specialization", () => {
    const line =
      "2+ years of professional experience with a focus on full-stack development, demonstrating the ability to deliver reliable, end-to-end products using a backend language (e.g., Python/Go) and frontend technologies like React/TypeScript.";
    expect(spanLooksDisjunctive(line)).toBe(true);
    const job: ExtractedJobData = {
      company: "Rippling",
      title: "Software Engineer II, Backend - IT Product",
      stack: ["Python", "Go", "React", "TypeScript"],
      requiredSkills: ["Python", "Go", "React", "TypeScript"],
      preferredSkills: [],
      domainTags: [],
      responsibilities: [
        "Design and implement features with an emphasis on backend logic, API development, and data integrity, while also contributing to the frontend implementation.",
      ],
      requirements: [line],
      rawText: `Software Engineer II, Backend - IT Product.\n${line}`,
    };
    const resume = calibrationSweResumeContexts().BASE?.rawText;
    expect(languageOnlyInIllustrativeExample(job, "Python")).toBe(true);
    expect(findLiteralLeadsWithSourceQuote(job, "Python")).toBeNull();
    expect(detectBackendStackSpecializationGap(job, resume)).toBeUndefined();
    const tsOnly = deriveClaimableStackFromText("TypeScript React Node.js JavaScript");
    expect(analyzeStackMismatch(job, tsOnly).stackMismatch).toBe(false);
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

  it("does not treat Strong Python as an illustrative or mixed-stack inventory", () => {
    const job: ExtractedJobData = {
      company: "Ro",
      title: "AI Engineer",
      stack: ["Python", "TypeScript"],
      requiredSkills: ["Python"],
      preferredSkills: ["TypeScript"],
      domainTags: [],
      responsibilities: ["Build LLM workflows in Python"],
      requirements: ["Strong Python and experience shipping LLM/RAG systems"],
      rawText:
        "AI Engineer. Build LLM workflows in Python for healthcare products. TypeScript a plus. Strong Python and experience shipping LLM/RAG systems.",
    };
    expect(findLiteralLeadsWithSourceQuote(job, "Python")).toMatch(/Strong Python/i);
    expect(findLiteralLeadsWithSourceQuote(job, "TypeScript")).toBeNull();
  });

  it("still treats a genuine UJET-style Python production requirement as exclusive", () => {
    const job: ExtractedJobData = {
      company: "UJET",
      title: "Backend Engineer",
      stack: ["Python", "Django"],
      requiredSkills: ["Python", "Django"],
      preferredSkills: [],
      domainTags: [],
      responsibilities: ["Build production APIs"],
      requirements: ["Professional experience with Python required"],
      rawText: "Backend Engineer. Professional experience with Python required. Django in production.",
    };
    const tsOnly = deriveClaimableStackFromText("TypeScript React Node.js JavaScript");
    const analysis = analyzeStackMismatch(job, tsOnly);
    expect(findLiteralLeadsWithSourceQuote(job, "Python")).toMatch(/Python/i);
    expect(analysis.stackMismatch).toBe(true);
    expect(analysis.coreLanguageGap).toContain("Python");
  });

  it("does not treat Meow inventory Python as a leads-with quote", () => {
    const job: ExtractedJobData = {
      company: "Meow",
      title: "Software Engineer",
      stack: ["TypeScript", "React", "Python"],
      requiredSkills: ["TypeScript", "React", "Python"],
      preferredSkills: [],
      domainTags: [],
      responsibilities: [],
      requirements: ["Comfortable working across both front-end and back-end"],
      rawText:
        "Our tech stack: TypeScript, React, Python (FastAPI), Postgres, AWS. Comfortable working across both front-end and back-end.",
    };
    const tsOnly = deriveClaimableStackFromText("TypeScript React Node.js JavaScript");
    const resume = calibrationSweResumeContexts().BASE?.rawText;
    expect(findLiteralLeadsWithSourceQuote(job, "Python")).toBeNull();
    expect(detectBackendStackSpecializationGap(job, resume)).toBeUndefined();
    expect(analyzeStackMismatch(job, tsOnly).stackMismatch).toBe(false);
    expect(analyzeStackMismatch(job, tsOnly).coreLanguageGap).not.toContain("Python");
  });
});
