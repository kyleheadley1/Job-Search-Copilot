import { describe, expect, it } from "vitest";
import {
  buildRecommendationBoundaryAudit,
  buildStackPenaltyAudit,
  classifyLanguageRequirementSource,
} from "../../lib/scoringAuditDiagnostics.js";
import type { ExtractedJobData } from "../../types/job.js";
import type { RuleEvaluation, ScoreBreakdown } from "../../types/scoring.js";
import { loadCalibrationFixture, scoreCalibrationAnchor } from "../fixtures/calibrationAnchors.js";

const ripplingLike: ExtractedJobData = {
  company: "Rippling",
  title: "Software Engineer, Platform",
  rawText:
    "Software Engineer, Platform\nRippling\nWhat We Build\nBuild product infrastructure in a backend language (e.g., Python/Go) and TypeScript.",
  requirements: ["Experience with a backend language (e.g., Python/Go)."],
  stack: ["TypeScript", "Python", "Go"],
  requiredSkills: ["TypeScript"],
  preferredSkills: [],
  domainTags: [],
  responsibilities: [],
};

const exclusivePython: ExtractedJobData = {
  company: "ExclusivePythonCo",
  title: "AI Engineer",
  rawText:
    "AI Engineer\nExclusivePythonCo\nRequirements\nStrong Python. Professional experience with Python backends.",
  requirements: ["Strong Python", "Professional experience with Python backends"],
  stack: ["Python"],
  requiredSkills: ["Python"],
  preferredSkills: [],
  domainTags: [],
  responsibilities: [],
};

describe("stack-penalty audit diagnostics", () => {
  it("classifies Rippling Python/Go as illustrative and does not change totals", () => {
    expect(classifyLanguageRequirementSource(ripplingLike, "Python")).toBe("illustrative");
    const audit = buildStackPenaltyAudit({
      extracted: ripplingLike,
      rules: {
        stackMismatch: false,
        coreLanguageGap: [],
        explicitCoreLanguageMismatch: false,
      } as Pick<RuleEvaluation, "stackMismatch" | "coreLanguageGap" | "specializationGap" | "explicitCoreLanguageMismatch">,
      score: {
        stackFit: 16,
        llmCategories: { stackFit: 16 },
      } as ScoreBreakdown,
      gapDock: 0,
    });
    expect(audit.originalLlmStackFit).toBe(16);
    expect(audit.adjustedStackFit).toBe(16);
    expect(audit.stackMismatchClampApplied).toBe(false);
    expect(audit.specializationGap).toBeNull();
    expect(audit.gapDock).toBe(0);
    expect(audit.combinedStackPressure.note).toMatch(/not be treated as an exact causal estimate/i);
    expect(audit.combinedStackPressure.categoryScoreEffects.clampReduction).toBe(0);
    expect(audit.combinedStackPressure.explicitDeductions.specializationDock).toBe(0);
  });

  it("exposes original vs clamped stackFit and mandatory-language quote provenance", () => {
    const audit = buildStackPenaltyAudit({
      extracted: exclusivePython,
      rules: {
        stackMismatch: true,
        coreLanguageGap: ["Python"],
        explicitCoreLanguageMismatch: true,
        specializationGap: {
          kind: "backend_stack",
          name: "Python backend",
          evidence: "JD leads with Python",
          severity: "moderate",
          lever: "upskill",
          dock: 5,
          jdSide: "Python",
          resumeSide: "Node",
        },
      },
      score: {
        stackFit: 10,
        llmCategories: { stackFit: 16 },
      } as ScoreBreakdown,
      gapDock: 5,
    });
    expect(audit.originalLlmStackFit).toBe(16);
    expect(audit.adjustedStackFit).toBe(10);
    expect(audit.stackMismatchClampApplied).toBe(true);
    expect(audit.clampReducedStackFit).toBe(6);
    expect(audit.coreLanguageGapEvidence[0]?.language).toBe("Python");
    expect(audit.coreLanguageGapEvidence[0]?.sourceClass).toBe("mandatory");
    expect(audit.coreLanguageGapEvidence[0]?.sourceQuote).toMatch(/Python/i);
    expect(audit.specializationGap?.dock).toBe(5);
    expect(audit.specializationGap?.sourceClass).toBe("mandatory");
    expect(audit.combinedStackPressure.categoryScoreEffects.clampReduction).toBe(6);
    expect(audit.combinedStackPressure.explicitDeductions.specializationDock).toBe(5);
  });
});

describe("recommendation-boundary sensitivity", () => {
  it("flags scores within two points of 80/65/50 without renaming tiers", () => {
    const at79 = buildRecommendationBoundaryAudit(79);
    expect(at79.recommendation).toBe("apply");
    expect(at79.nearestCutoff).toBe(80);
    expect(at79.distanceToNearestCutoff).toBe(-1);
    expect(at79.withinTwoPoints).toBe(true);
    expect(at79.tierAboveCutoff).toBe("strong_apply");
    expect(at79.tierBelowCutoff).toBe("apply");
    expect(at79.cutoffs).toEqual({ strong_apply: 80, apply: 65, stretch: 50 });

    const at66 = buildRecommendationBoundaryAudit(66);
    expect(at66.recommendation).toBe("apply");
    expect(at66.nearestCutoff).toBe(65);
    expect(at66.withinTwoPoints).toBe(true);
    expect(at66.tierAboveCutoff).toBe("apply");
    expect(at66.tierBelowCutoff).toBe("stretch");

    const at72 = buildRecommendationBoundaryAudit(72);
    expect(at72.withinTwoPoints).toBe(false);
    expect(at72.recommendation).toBe("apply");
  });
});

describe("Ro calibration fixture vs synthetic clamp example", () => {
  it("does not imply a stack-mismatch clamp on the actual Ro scoring path", () => {
    const fixture = loadCalibrationFixture("roAiEngineer");
    const scored = scoreCalibrationAnchor("roAiEngineer");
    const audit = buildStackPenaltyAudit({
      extracted: fixture.extracted,
      rules: scored.rules,
      score: {
        ...scored.score,
        llmCategories: fixture.storedCategoryScores,
      },
      gapDock: scored.score.scoreDisplay?.gapDock,
    });
    expect(scored.rules.stackMismatch).toBe(false);
    expect(scored.score.stackFit).toBe(16);
    expect(audit.originalLlmStackFit).toBe(16);
    expect(audit.adjustedStackFit).toBe(16);
    expect(audit.stackMismatchClampApplied).toBe(false);
    expect(audit.clampReducedStackFit).toBe(0);
    expect(audit.specializationGap?.dock).toBe(5);
    expect(audit.specializationGap?.sourceQuote).toMatch(/Strong Python/i);
  });
});
