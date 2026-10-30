import { describe, expect, it } from "vitest";
import { evaluateRules } from "../../agents/jobAgent/rules.js";
import { userProfile } from "../../config/userProfile.js";
import { extractJdBackendLabel } from "../../lib/capabilityGap.js";
import { claimableStackFromContexts, deriveClaimableStackFromText } from "../../lib/claimableStack.js";
import {
  evaluateDisjunctiveLanguageRequirement,
  findLiteralLeadsWithSourceQuote,
  languageOnlyInDisjunctiveChoice,
  lineDisjunctiveRequirementSatisfied,
  spanLooksDisjunctive,
} from "../../lib/disjunctiveLanguageRequirement.js";
import { polishRisksAndMain } from "../../lib/scoringOutputPolish.js";
import { analyzeStackMismatch } from "../../lib/stackMismatchAnalysis.js";
import { sanitizeExtractedTags } from "../../lib/jdTagProvenance.js";
import {
  calibrationSweResumeContexts,
  loadCalibrationFixture,
  scoreCalibrationAnchor,
} from "../fixtures/calibrationAnchors.js";
import type { ExtractedJobData } from "../../types/job.js";

const claimable = () => claimableStackFromContexts(calibrationSweResumeContexts(), "BASE");

/**
 * Disjunctive language = meaning (any one listed language satisfies), not one keyword pattern.
 * Permanent fixtures: Fleetio (and/or), Cherry (section provenance companion), WorldQuant (at least one from).
 */
describe("disjunctive language — Fleetio + Cherry + WorldQuant", () => {
  describe("phrasing coverage (meaning-based)", () => {
    const phrasings = [
      "2+ years experience with Ruby on Rails, React, and/or Typescript",
      "Proficiency in at least one general purpose programming language from Python, Java, and C++.",
      "Expertise in at least 1 server-side web technology (e.g. Node.js, Java, Python, Scala, C#, C++, Go)",
      "Experience with one of the following: Python, Java, or C++",
      "Strong skills in any of Python, Java, C++",
      "Proficiency in one or more of: TypeScript, Python, Go",
    ];

    it.each(phrasings)("treats as disjunctive: %s", (line) => {
      expect(spanLooksDisjunctive(line)).toBe(true);
    });

    it("Python on the resume satisfies the WorldQuant closed set; JS/TS does not", () => {
      const worldquant =
        "Proficiency in at least one general purpose programming language from Python, Java, and C++.";
      expect(lineDisjunctiveRequirementSatisfied(worldquant, claimable())).toBe(true);
      expect(
        lineDisjunctiveRequirementSatisfied(
          worldquant,
          deriveClaimableStackFromText("TypeScript React Node.js JavaScript"),
        ),
      ).toBe(false);
    });

    it("detects WorldQuant multi-line at-least-one / from split", () => {
      const job: ExtractedJobData = {
        company: "WorldQuant",
        title: "Full Stack Developer",
        stack: ["Python", "Java", "C++"],
        requiredSkills: ["Python", "Java", "C++"],
        preferredSkills: [],
        domainTags: [],
        responsibilities: [],
        requirements: [],
        rawText:
          "What You Need\nProficiency in at least one general purpose programming language\nfrom Python, Java, and C++.\n",
      };
      const disjunctive = evaluateDisjunctiveLanguageRequirement(job, claimable());
      expect(disjunctive.satisfied).toBe(true);
      expect(disjunctive.acceptedLabels).toEqual(
        expect.arrayContaining(["Python", "Java", "C++"]),
      );
      expect(analyzeStackMismatch(job, claimable()).coreLanguageGap).not.toContain("Java");

      const tsOnly = deriveClaimableStackFromText("TypeScript React Node.js JavaScript");
      const tsEval = evaluateDisjunctiveLanguageRequirement(job, tsOnly);
      expect(tsEval.satisfied).toBe(false);
      expect(analyzeStackMismatch(job, tsOnly).stackMismatch).toBe(true);
    });
  });

  describe("Fleetio Marketplace — and/or", () => {
    const fixture = loadCalibrationFixture("fleetioMarketplace");
    const sanitized = sanitizeExtractedTags(fixture.extracted);

    it("React+TypeScript satisfies Rails/React/and-or TypeScript", () => {
      const disjunctive = evaluateDisjunctiveLanguageRequirement(sanitized, claimable());
      expect(disjunctive.satisfied).toBe(true);
      expect(analyzeStackMismatch(sanitized, claimable()).stackMismatch).toBe(false);
    });
  });

  describe("Cherry Technologies — companion fixture still preferred-only for Kotlin", () => {
    const fixture = loadCalibrationFixture("cherryTechnologiesMidLevel");
    const sanitized = sanitizeExtractedTags(fixture.extracted);

    it("does not invent Kotlin as a required core gap", () => {
      expect(analyzeStackMismatch(sanitized, claimable()).coreLanguageGap).not.toContain("Kotlin");
    });
  });

  describe("WorldQuant Full Stack Developer — at least one from Python/Java/C++", () => {
    const fixture = loadCalibrationFixture("worldquantFullStackDeveloper");

    it("Python clears the disjunctive requirement; Java is not a required gap", () => {
      const disjunctive = evaluateDisjunctiveLanguageRequirement(fixture.extracted, claimable());
      expect(disjunctive.satisfied).toBe(true);
      expect(disjunctive.acceptedLabels).toEqual(
        expect.arrayContaining(["Python", "Java", "C++"]),
      );

      const mismatch = analyzeStackMismatch(fixture.extracted, claimable());
      expect(mismatch.stackMismatch).toBe(false);
      expect(mismatch.coreLanguageGap).not.toContain("Java");
      expect(mismatch.coreLanguageGap).not.toContain("C++");

      const rules = evaluateRules(fixture.extracted, userProfile, {
        resumeContexts: calibrationSweResumeContexts(),
        activeResumeType: "BASE",
      });
      expect(rules.disjunctiveLanguageRequirementSatisfied).toBe(true);
      expect(rules.coreLanguageGap ?? []).not.toContain("Java");
      expect(rules.stackMismatch).toBe(false);
      expect(rules.notes.join("\n")).not.toMatch(/Missing required Java|Required core language gap:\s*Java/i);
    });

    it("does not assert role leads with Python (no literal JD priority)", () => {
      expect(languageOnlyInDisjunctiveChoice(fixture.extracted, "Python")).toBe(true);
      expect(findLiteralLeadsWithSourceQuote(fixture.extracted, "Python")).toBeNull();
      expect(extractJdBackendLabel(fixture.extracted)).toBeUndefined();

      const polished = polishRisksAndMain({
        mainRisk: "Role leads with Python on the backend; resume leads with Node.",
        risks: ["Missing required Java experience"],
        extracted: fixture.extracted,
        userProfile,
        rules: {
          ...evaluateRules(fixture.extracted, userProfile, {
            resumeContexts: calibrationSweResumeContexts(),
            activeResumeType: "BASE",
          }),
        },
        max: 3,
      });
      expect(polished.mainRisk).not.toMatch(/role leads with Python/i);
      expect(polished.risks.join("\n")).not.toMatch(/Missing required Java|role leads with/i);
    });

    it("full score path does not Skip on fabricated Java gap", () => {
      const scored = scoreCalibrationAnchor("worldquantFullStackDeveloper");
      expect(scored.rules.disjunctiveLanguageRequirementSatisfied).toBe(true);
      expect(scored.rules.coreLanguageGap ?? []).not.toContain("Java");
      expect(scored.recommendation).not.toBe("weak");
      const blob = [
        ...(scored.rules.notes ?? []),
        scored.score.scoreDisplay?.bandHeadline ?? "",
        ...(scored.score.scoreDisplay?.survivabilityPenalties ?? []).map((p) => p.message),
      ].join("\n");
      expect(blob).not.toMatch(/Required core language gap:\s*Java|Missing required Java|role leads with Python/i);
      expect(scored.score.total).toBeGreaterThan(50);
      expect(scored.score.stackFit).toBe(fixture.storedCategoryScores.stackFit);
    });

    it("does not clear the closed Python/Java/C++ set because React/TypeScript is satisfied", () => {
      const fixture = loadCalibrationFixture("worldquantFullStackDeveloper");
      const tsOnly = deriveClaimableStackFromText("TypeScript React Node.js JavaScript");
      const disjunctive = evaluateDisjunctiveLanguageRequirement(fixture.extracted, tsOnly);
      const closed = disjunctive.groups.find((group) =>
        group.languages.includes("Python") && group.languages.includes("Java"),
      );
      expect(closed?.kind).toBe("closed_mandatory_alternatives");
      expect(closed?.satisfied).toBe(false);
      expect(disjunctive.satisfied).toBe(false);
      const mismatch = analyzeStackMismatch(fixture.extracted, tsOnly);
      expect(mismatch.stackMismatch).toBe(true);
      expect(mismatch.coreLanguageGap.some((gap) => /python|java|c\+\+/i.test(gap))).toBe(true);
    });
  });
});
