import { describe, expect, it } from "vitest";
import {
  applyDockPolicies,
  classifyCalibrationDifference,
  classifyLargeReplayDeltaCauses,
  doubleCountAssessment,
} from "../../lib/calibrationBaseline.js";

describe("calibration baseline classification", () => {
  it("marks totals within 0.5 as aligned", () => {
    expect(
      classifyCalibrationDifference({
        historicalTotal: 80,
        historicalRec: "strong_apply",
        effectiveTotal: 80,
        effectiveSource: "stored_evaluation",
        replayTotal: 80,
        replayRec: "strong_apply",
        storedLane: "product_backend",
        replayLane: "product_backend",
        storedCoreGap: [],
        replayCoreGap: [],
        storedStackMismatch: false,
        replayStackMismatch: false,
        specializationDock: 0,
      }),
    ).toBe("aligned");
  });

  it("classifies an approved revision overlay first", () => {
    expect(
      classifyCalibrationDifference({
        historicalTotal: 72,
        historicalRec: "apply",
        effectiveTotal: 80,
        effectiveSource: "approved_revision",
        replayTotal: 80,
        replayRec: "strong_apply",
        storedLane: "product_backend",
        replayLane: "product_backend",
        storedCoreGap: ["Python"],
        replayCoreGap: [],
        storedStackMismatch: true,
        replayStackMismatch: false,
        specializationDock: 0,
      }),
    ).toBe("approved_revision");
  });

  it("classifies a newly detected language gap as a corrected requirement", () => {
    expect(
      classifyCalibrationDifference({
        historicalTotal: 85,
        historicalRec: "strong_apply",
        effectiveTotal: 85,
        effectiveSource: "stored_evaluation",
        replayTotal: 80,
        replayRec: "strong_apply",
        storedLane: "product_backend",
        replayLane: "product_backend",
        storedCoreGap: [],
        replayCoreGap: [],
        storedStackMismatch: false,
        replayStackMismatch: false,
        specializationDock: 5,
      }),
    ).toBe("corrected_requirement");
  });

  it("classifies a lane change when gaps are unchanged", () => {
    expect(
      classifyCalibrationDifference({
        historicalTotal: 70,
        historicalRec: "apply",
        effectiveTotal: 70,
        effectiveSource: "stored_evaluation",
        replayTotal: 62,
        replayRec: "stretch",
        storedLane: "product_fullstack",
        replayLane: "product_frontend",
        storedCoreGap: [],
        replayCoreGap: [],
        storedStackMismatch: false,
        replayStackMismatch: false,
        specializationDock: 0,
      }),
    ).toBe("role_lane");
  });

  it("flags possible double-count when stackFit is already clamped and a dock also applies", () => {
    expect(
      doubleCountAssessment({
        storedStackFit: 9,
        replayStackFit: 9,
        replayStackMismatch: true,
        replayCoreGap: ["Python"],
        specializationDock: 0,
        gapDock: 13,
      }),
    ).toMatch(/possible_double_count/);
  });

  it("in-memory policy B drops the spec dock only when LLM stackFit is already ≤ 10", () => {
    const arbital = applyDockPolicies({
      llmStackFit: 9,
      adjustedStackFit: 9,
      specializationDock: 13,
      capability: 55,
      survAdjustment: -6,
      gapDock: 13,
      contractDock: 0,
      hardGate: false,
    });
    expect(arbital.find((row) => row.id === "A")).toMatchObject({ final: 36, rec: "weak", specDock: 13 });
    expect(arbital.find((row) => row.id === "B")).toMatchObject({ final: 49, rec: "weak", specDock: 0 });
    expect(arbital.find((row) => row.id === "C")).toMatchObject({ specDock: 7 });

    const ro = applyDockPolicies({
      llmStackFit: 16,
      adjustedStackFit: 16,
      specializationDock: 5,
      capability: 86,
      survAdjustment: -1,
      gapDock: 5,
      contractDock: 0,
      hardGate: false,
    });
    expect(ro.find((row) => row.id === "B")).toMatchObject({ final: 80, specDock: 5 });
    expect(ro.every((row) => row.specDock === 5)).toBe(true);
  });

  it("confirms Rippling-scale replay deltas from clamp lift and cleared language gaps", () => {
    const causes = classifyLargeReplayDeltaCauses({
      storedStackMismatch: true,
      replayStackMismatch: false,
      storedCoreGap: ["Python"],
      replayCoreGap: [],
      storedSpecializationDock: 13,
      specializationDock: 0,
      storedLane: "product_backend",
      replayLane: "product_backend",
      historicalRec: "weak",
      replayRec: "apply",
      storedCapability: 61,
      replayCapability: 83,
      storedLanguageSourceClasses: ["illustrative"],
    });
    expect(causes.confirmed).toEqual(
      expect.arrayContaining([
        "stack_mismatch_clamp_lifted",
        "specialization_dock_removed",
        "requirement_grounding_change",
        "core_language_gap_cleared",
        "illustrative_language_no_longer_mandatory",
        "recommendation_tier_change",
      ]),
    );
    expect(causes.unresolved).toEqual([]);
  });

  it("treats a specialization dock with unclamped stackFit as a first penalty", () => {
    expect(
      doubleCountAssessment({
        storedStackFit: 16,
        replayStackFit: 16,
        replayStackMismatch: false,
        replayCoreGap: [],
        specializationDock: 5,
        gapDock: 5,
      }),
    ).toMatch(/deterministic_dock_only/);
  });
});
