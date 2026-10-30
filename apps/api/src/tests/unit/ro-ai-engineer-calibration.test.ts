import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { evaluateRules } from "../../agents/jobAgent/rules.js";
import { userProfile } from "../../config/userProfile.js";
import { evaluateHardGates } from "../../lib/hardGates.js";
import { computeCompositeScore } from "../../lib/compositeScoreModel.js";
import { evaluateDifferentiatorCoverage } from "../../lib/differentiatorCoverage.js";
import { buildScoreDisplay } from "../../lib/scoreDisplayModel.js";
import { recomputeStoredJobScore } from "../../lib/recomputeStoredJobScore.js";
import {
  detectRoleSeniorityOverreach,
  roleTitleSignalsSeniority,
  seniorityFieldSignalsOverreach,
} from "../../lib/seniorityGate.js";
import { detectSpecializationGap } from "../../lib/capabilityGap.js";
import { findLiteralLeadsWithSourceQuote } from "../../lib/disjunctiveLanguageRequirement.js";
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

const RO_AI_ENGINEER_FIXTURE = loadCalibrationFixture("roAiEngineer");
const RO_AI_ENGINEER_JOB = RO_AI_ENGINEER_FIXTURE.extracted;

describe("seniority gate — role level only", () => {
  it("does not fire when rawText mentions team seniors but title/years/seniority are early-career", () => {
    expect(roleTitleSignalsSeniority("AI Engineer")).toBe(false);
    expect(seniorityFieldSignalsOverreach("Junior, Mid")).toBe(false);
    expect(detectRoleSeniorityOverreach(RO_AI_ENGINEER_JOB)).toBe(false);

    const rules = evaluateRules(RO_AI_ENGINEER_JOB, userProfile, { activeResumeType: "BASE" });
    expect(rules.seniorityOverreach).toBe(false);
    expect(evaluateHardGates(rules, RO_AI_ENGINEER_JOB).fired).toBe(false);
  });

  it("still fires for senior title when early-career veto does not apply", () => {
    expect(
      detectRoleSeniorityOverreach({ ...RO_AI_ENGINEER_JOB, title: "Senior AI Engineer" }),
    ).toBe(false);
    expect(
      detectRoleSeniorityOverreach({
        ...RO_AI_ENGINEER_JOB,
        title: "Senior AI Engineer",
        seniority: "Senior Level",
        yearsExperience: { min: 6, raw: "6+ years" },
      }),
    ).toBe(true);
    // Empty structured seniority + body years alone → fail safe (manual review), not gate.
    expect(
      detectRoleSeniorityOverreach({
        ...RO_AI_ENGINEER_JOB,
        title: "AI Engineer",
        seniority: undefined,
        yearsExperience: { min: 6, raw: "6+ years" },
        rawText: "AI Engineer\n6+ years experience building products.",
      }),
    ).toBe(false);
    // Early-career chrome + polluted years ≥5 → fail safe, not silent gate.
    expect(
      detectRoleSeniorityOverreach({
        ...RO_AI_ENGINEER_JOB,
        title: "AI Engineer",
        yearsExperience: { min: 6, raw: "6+ years" },
      }),
    ).toBe(false);
  });
});

describe("Ro AI Engineer calibration", () => {
  it("treats Strong Python as a literal Python-primary requirement", () => {
    expect(findLiteralLeadsWithSourceQuote(RO_AI_ENGINEER_JOB, "Python")).toMatch(/Strong Python/i);
    const gap = detectSpecializationGap(
      RO_AI_ENGINEER_JOB,
      undefined,
      calibrationSweResumeContexts().BASE?.rawText,
    );
    expect(gap?.kind).toBe("backend_stack");
    expect(gap?.name).toMatch(/Python backend/i);
    expect(gap?.dock).toBeGreaterThan(0);
  });

  it("scores without false seniority gate; one final; referral-advised apply band", () => {
    const result = recomputeStoredJobScore({
      job: fixtureToJobRecord(RO_AI_ENGINEER_FIXTURE),
      resumeContexts: calibrationSweResumeContexts(),
    });

    expect(result.rules.seniorityOverreach).toBe(false);
    expect(result.score.survivability).toBeGreaterThan(0);
    expect(result.score.survivability!).toBeGreaterThanOrEqual(0.45);
    expect(result.score.survivability!).toBeLessThanOrEqual(0.58);
    expect(result.score.total!).toBeGreaterThanOrEqual(78);
    expect(result.score.total!).toBeLessThanOrEqual(82);
    expect(evaluateDifferentiatorCoverage(RO_AI_ENGINEER_JOB).tier).toBe("strong");
    expect(result.rules.specializationGap?.name).toMatch(/Python backend/i);

    const display = result.score.scoreDisplay!;
    expect(display.final).toBe(result.score.total);
    expect(display.hardGates).toEqual([]);
    expect(["apply", "strong_apply"]).toContain(display.scoreBand);
    expect(display.actionLine).toMatch(/^(Apply|Strong apply) — /);
    expect(display.actionLine.toLowerCase()).toMatch(/python|node|backend|resume/);
  });
});

describe("hard gate display consistency", () => {
  it("keeps survivability sub-factors when a legitimate gate fires; badge matches display final", () => {
    const job: ExtractedJobData = {
      ...RO_AI_ENGINEER_JOB,
      title: "Staff AI Engineer",
      seniority: "Staff",
      yearsExperience: { min: 8, raw: "8+ years" },
      requirements: ["8+ years of professional software engineering experience"],
      rawText: "Staff AI Engineer. 8+ years of professional software engineering experience.",
    };
    const rules = evaluateRules(job, userProfile, { activeResumeType: "BASE" });
    expect(rules.seniorityOverreach).toBe(true);

    const composite = computeCompositeScore({
      rawScore: { ...RO_AI_ENGINEER_FIXTURE.storedCategoryScores, total: 0 },
      rules,
      extracted: job,
      profile: userProfile,
      resumeText: SWE_RESUME,
    });

    expect(composite.hardGateFired).toBe(true);
    expect(composite.score.survivability).toBeGreaterThan(0);

    const display = buildScoreDisplay({
      score: composite.score,
      rules,
      extracted: job,
      profile: userProfile,
      recommendation: composite.recommendation,
      hardGateReasons: composite.hardGateReasons,
    });

    expect(display!.final).toBe(composite.score.total);
    expect(display!.final).toBe(25);
    expect(display!.scoreBand).toBe("weak");
    expect(display!.actionLine).toMatch(/^Weak — hard gate: /);
  });
});
