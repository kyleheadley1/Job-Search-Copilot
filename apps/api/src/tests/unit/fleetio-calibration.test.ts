import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { userProfile } from "../../config/userProfile.js";
import { detectDesignFigmaSpecializationGap, detectSpecializationGap } from "../../lib/capabilityGap.js";
import { computeCapabilityBreakdown } from "../../lib/compositeScoreModel.js";
import {
  evaluateDisjunctiveLanguageRequirement,
  lineDisjunctiveRequirementSatisfied,
} from "../../lib/disjunctiveLanguageRequirement.js";
import {
  buildJdTagProvenance,
  jdHasExplicitDesignToolRequirement,
  sanitizeExtractedTags,
} from "../../lib/jdTagProvenance.js";
import { analyzeStackMismatch } from "../../lib/stackMismatchAnalysis.js";
import { claimableStackFromContexts } from "../../lib/claimableStack.js";
import { buildScoreDisplay } from "../../lib/scoreDisplayModel.js";
import { recomputeStoredJobScore } from "../../lib/recomputeStoredJobScore.js";
import {
  calibrationSweResumeContexts,
  fixtureToJobRecord,
  loadCalibrationFixture,
} from "../fixtures/calibrationAnchors.js";
import type { ExtractedJobData } from "../../types/job.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SWE_RESUME = fs.readFileSync(
  path.resolve(__dirname, "../fixtures/resumes/swe_resume.txt"),
  "utf8",
);

describe("Fleetio Marketplace — tag provenance & disjunctive stack", () => {
  const rawFixture = loadCalibrationFixture("fleetioMarketplace");
  const sanitized = sanitizeExtractedTags(rawFixture.extracted);

  it("strips hallucinated Figma and downgrades Simplify chip-only UI/UX from required", () => {
    expect(rawFixture.extracted.requiredSkills).toContain("Figma");
    expect(sanitized.requiredSkills).not.toContain("Figma");
    expect(sanitized.requiredSkills).not.toContain("UI/UX Design");
    expect(sanitized.requiredSkills.some((s) => /react/i.test(s))).toBe(true);
    expect(sanitized.requiredSkills.some((s) => /typescript/i.test(s))).toBe(true);
    expect(sanitized.preferredSkills).toContain("UI/UX Design");
    expect(jdHasExplicitDesignToolRequirement(sanitized)).toBe(false);
  });

  it("every retained tag has provenance with a source quote in the JD", () => {
    const tags = buildJdTagProvenance(sanitized);
    expect(tags.length).toBeGreaterThan(0);
    for (const tag of tags) {
      expect(tag.sourceQuote.length).toBeGreaterThan(3);
    }
    expect(tags.some((t) => t.term.toLowerCase().includes("figma"))).toBe(false);
  });

  it("does not produce design/Figma survivability specialization gap", () => {
    expect(detectDesignFigmaSpecializationGap(sanitized, SWE_RESUME)).toBeUndefined();
    expect(detectSpecializationGap(sanitized, undefined, SWE_RESUME)).toBeUndefined();
  });

  it("treats Rails/React/and-or Typescript as disjunctive — satisfied by React + TypeScript", () => {
    const claimable = claimableStackFromContexts(calibrationSweResumeContexts(), "BASE");
    const line = "2+ years experience with Ruby on Rails, React, and/or Typescript";
    expect(lineDisjunctiveRequirementSatisfied(line, claimable)).toBe(true);

    const disjunctive = evaluateDisjunctiveLanguageRequirement(sanitized, claimable);
    expect(disjunctive.satisfied).toBe(true);
    expect(disjunctive.acceptedLabels).toEqual(
      expect.arrayContaining(["React", "TypeScript"]),
    );

    const stack = analyzeStackMismatch(sanitized, claimable);
    expect(stack.stackMismatch).toBe(false);
    expect(stack.coreLanguageGap).not.toContain("Ruby");
  });

  it("re-score moves meaningfully above 63 without design-portfolio penalty", () => {
    const job = {
      ...fixtureToJobRecord(rawFixture),
      extracted: sanitized,
    };
    const scored = recomputeStoredJobScore({
      job,
      resumeContexts: calibrationSweResumeContexts(),
    });

    expect(scored.rules.specializationGap).toBeUndefined();
    expect(scored.rules.stackMismatch).toBe(false);
    expect(scored.rules.disjunctiveLanguageRequirementSatisfied).toBe(true);

    const breakdown = computeCapabilityBreakdown(scored.score);
    // LLM stackFit 13 is preserved; a satisfied and/or group must not floor to 17.
    expect(scored.score.stackFit).toBe(rawFixture.storedCategoryScores.stackFit);
    expect(breakdown.stackFit).toBeGreaterThanOrEqual(22);
    expect(scored.score.total).toBeGreaterThan(63);

    const display = buildScoreDisplay({
      score: scored.score,
      rules: scored.rules,
      extracted: sanitized,
      profile: userProfile,
      recommendation: scored.recommendation,
      referralPathwayAvailable: false,
    });
    expect(
      display?.survivabilityPenalties.some((p) => /design\/figma|figma|portfolio/i.test(p.message)),
    ).toBe(false);
  });

  it("Key risks do not claim unmet Rails when and/or line is satisfied via React+TypeScript", async () => {
    const { buildKeyRisks } = await import("../../../../web/src/lib/resultSummary.ts");
    const { polishRisksAndMain } = await import("../../lib/scoringOutputPolish.js");
    const job = {
      ...fixtureToJobRecord(rawFixture),
      extracted: sanitized,
      mainRisk:
        "No demonstrated Ruby on Rails experience (role lists RoR as a primary accepted language).",
      risks: [],
    };
    const scored = recomputeStoredJobScore({
      job,
      resumeContexts: calibrationSweResumeContexts(),
    });
    job.rules = scored.rules;

    const polished = polishRisksAndMain({
      mainRisk: job.mainRisk,
      risks: job.risks,
      extracted: sanitized,
      rules: scored.rules,
      max: 5,
    });
    job.mainRisk = polished.mainRisk;
    job.risks = polished.risks;

    const keyRisks = buildKeyRisks(job, 5);
    expect(keyRisks.some((r) => /\b(rails|ror|ruby)\b/i.test(r))).toBe(false);
  });

  it("recomputeStoredJobScore is deterministic for identical inputs", () => {
    const job = {
      ...fixtureToJobRecord(rawFixture),
      extracted: sanitized,
    };
    const ctx = { job, resumeContexts: calibrationSweResumeContexts() };
    const a = recomputeStoredJobScore(ctx);
    const b = recomputeStoredJobScore(ctx);
    expect(a.score.levelFit).toBe(b.score.levelFit);
    expect(a.score.survivabilityBreakdown?.domainMatchForListing).toBe(
      b.score.survivabilityBreakdown?.domainMatchForListing,
    );
    expect(a.score.total).toBe(b.score.total);
  });
});

describe("and/or disjunctive regression", () => {
  it("matches and/or phrasing in requirement lines", () => {
    const job: ExtractedJobData = {
      company: "Fleetio",
      title: "Software Engineer",
      stack: [],
      requiredSkills: [],
      preferredSkills: [],
      domainTags: [],
      responsibilities: [],
      requirements: ["2+ years experience with Ruby on Rails, React, and/or Typescript"],
      rawText: "Qualifications\n2+ years experience with Ruby on Rails, React, and/or Typescript",
    };
    const claimable = claimableStackFromContexts(calibrationSweResumeContexts(), "BASE");
    expect(evaluateDisjunctiveLanguageRequirement(job, claimable).satisfied).toBe(true);
  });
});
