import { describe, expect, it } from "vitest";
import { userProfile } from "../../config/userProfile.js";
import { polishRisksAndMain } from "../../lib/scoringOutputPolish.js";
import { recomputeStoredJobScore } from "../../lib/recomputeStoredJobScore.js";
import {
  evaluateTitleResponsibilitySeniority,
  textSignalsEarlyCareerExceedSeverity,
  TITLE_RESPONSIBILITY_MISMATCH_LEVEL_FIT_MAX,
} from "../../lib/titleResponsibilitySeniority.js";
import {
  calibrationSweResumeContexts,
  fixtureToJobRecord,
  loadCalibrationFixture,
} from "../fixtures/calibrationAnchors.js";

describe("title/responsibility seniority — August Law FDE", () => {
  const fixture = loadCalibrationFixture("augustLawForwardDeployed");
  const extracted = fixture.extracted;

  it("detects title/responsibility mismatch and high-ownership/low-support", () => {
    const evaled = evaluateTitleResponsibilitySeniority(extracted);
    expect(evaled.mismatch).toBe(true);
    expect(evaled.titleBand).toBeGreaterThanOrEqual(2);
    expect(evaled.responsibilityBand).toBeGreaterThanOrEqual(2);
    expect(evaled.statedEarlyCareer).toBe(true);
    expect(evaled.highOwnershipLowSupport).toBe(true);
    expect(evaled.mismatchRiskNote).toMatch(/title\/responsibility mismatch/i);
  });

  it("re-score docks Level fit, drops Strong Yes, and surfaces named mismatch risk", async () => {
    const scored = recomputeStoredJobScore({
      job: fixtureToJobRecord(fixture),
      resumeContexts: calibrationSweResumeContexts(),
    });

    expect(scored.rules.titleResponsibilityMismatch).toBe(true);
    expect(scored.rules.highOwnershipLowSupport).toBe(true);
    expect(scored.score.levelFit).toBeLessThanOrEqual(TITLE_RESPONSIBILITY_MISMATCH_LEVEL_FIT_MAX);
    expect(scored.score.total).toBeLessThan(85);
    expect(scored.score.total).toBeLessThan(80);
    expect(scored.recommendation).not.toBe("strong_apply");

    const survRows = scored.score.scoreDisplay?.survivabilityRows ?? [];
    expect(survRows.some((r) => r.key === "highOwnershipLowSupport")).toBe(true);

    const { buildKeyRisks } = await import("../../../../web/src/lib/resultSummary.ts");
    const polished = polishRisksAndMain({
      mainRisk:
        "The role requires deep, hands-on integrations with enterprise legal systems (iManage, NetDocs, SharePoint, Word add-ins) and live-migration debugging that may exceed typical early-career exposure.",
      risks: [],
      extracted,
      rules: scored.rules,
      userProfile,
      max: 5,
    });
    const job = {
      ...fixtureToJobRecord(fixture),
      rules: scored.rules,
      mainRisk: polished.mainRisk,
      risks: polished.risks,
    };
    const keyRisks = buildKeyRisks(job, 5);
    expect(keyRisks.some((r) => /title\/responsibility mismatch/i.test(r))).toBe(true);
    // Severity-flagged prose (if present) is docked via earlyCareerExceedSeverityRisk;
    // structured mismatch note is the required named risk line.
    expect(
      keyRisks.some((r) => /title\/responsibility mismatch/i.test(r)) ||
        textSignalsEarlyCareerExceedSeverity(polished.mainRisk),
    ).toBe(true);
  });
});

describe("title/responsibility seniority — Eulerity Associate", () => {
  const fixture = loadCalibrationFixture("eulerityTitleResponsibilityMismatch");

  it("flags Associate title with senior-autonomy responsibilities", () => {
    const evaled = evaluateTitleResponsibilitySeniority(fixture.extracted);
    expect(evaled.mismatch).toBe(true);
    expect(evaled.titleBand).toBe(0);
    expect(evaled.responsibilityBand).toBeGreaterThanOrEqual(2);
  });

  it("re-score docks Level fit and names title/responsibility mismatch", async () => {
    const scored = recomputeStoredJobScore({
      job: fixtureToJobRecord(fixture),
      resumeContexts: calibrationSweResumeContexts(),
    });
    expect(scored.rules.titleResponsibilityMismatch).toBe(true);
    expect(scored.score.levelFit).toBeLessThanOrEqual(TITLE_RESPONSIBILITY_MISMATCH_LEVEL_FIT_MAX);

    const { buildKeyRisks } = await import("../../../../web/src/lib/resultSummary.ts");
    const polished = polishRisksAndMain({
      mainRisk: "",
      risks: [],
      extracted: fixture.extracted,
      rules: scored.rules,
      userProfile,
      max: 5,
    });
    const keyRisks = buildKeyRisks(
      {
        ...fixtureToJobRecord(fixture),
        rules: scored.rules,
        mainRisk: polished.mainRisk,
        risks: polished.risks,
      },
      5,
    );
    expect(keyRisks.some((r) => /title\/responsibility mismatch/i.test(r))).toBe(true);
  });
});

describe("early-career-exceed severity language", () => {
  it("matches the August Law Key Risk phrasing", () => {
    expect(
      textSignalsEarlyCareerExceedSeverity(
        "live-migration debugging that may exceed typical early-career exposure.",
      ),
    ).toBe(true);
  });
});

describe("title/responsibility seniority — NYT Reflections (supported feature ownership)", () => {
  const fixture = loadCalibrationFixture("nytReflectionsSupportedFeatureOwnership");
  const extracted = fixture.extracted;

  it("does not treat Lead feature development as unsupervised senior ownership", () => {
    const evaled = evaluateTitleResponsibilitySeniority(extracted);
    expect(evaled.hasManagedTeamStructure).toBe(true);
    expect(evaled.highAutonomy).toBe(false);
    expect(evaled.mismatch).toBe(false);
    expect(evaled.highOwnershipLowSupport).toBe(false);
    expect(evaled.responsibilityBand).toBeLessThan(2);
  });

  it("Level fit mismatch and high-ownership/low-support agree — neither fires", () => {
    const scored = recomputeStoredJobScore({
      job: fixtureToJobRecord(fixture),
      resumeContexts: calibrationSweResumeContexts(),
    });
    expect(scored.rules.titleResponsibilityMismatch).toBe(false);
    expect(scored.rules.highOwnershipLowSupport).toBe(false);
    expect(
      scored.rules.notes.some((n) => /title\/responsibility mismatch/i.test(n)),
    ).toBe(false);
    expect(
      (scored.score.scoreDisplay?.survivabilityRows ?? []).some(
        (r) => r.key === "highOwnershipLowSupport",
      ),
    ).toBe(false);
  });
});

describe("title/responsibility seniority — early-career FDE ramp", () => {
  it("does not penalize an explicit 0–3 year FDE role that learns under experienced FDEs", () => {
    const extracted = {
      company: "Trunk Tools",
      title: "Forward Deployed Engineer",
      stack: ["TypeScript"],
      requiredSkills: ["TypeScript"],
      preferredSkills: [],
      domainTags: [],
      yearsExperience: { min: 0, max: 3, raw: "0-3 years" },
      seniority: "entry",
      responsibilities: ["Learn under experienced FDEs while delivering customer deployments."],
      requirements: ["0–3 years of experience. Early-career role with mentorship."],
      rawText:
        "Forward Deployed Engineer. Early-career role requiring 0 to 3 years of software experience. You will be learning under experienced FDEs.",
    };
    const evaled = evaluateTitleResponsibilitySeniority(extracted);
    expect(evaled.statedEarlyCareer).toBe(true);
    expect(evaled.hasManagedTeamStructure).toBe(true);
    expect(evaled.mismatch).toBe(false);
  });

  it("still flags an early-tagged FDE with unsupervised ownership and no support", () => {
    const extracted = {
      company: "Afresh",
      title: "Forward Deployed Engineer",
      stack: ["Python"],
      requiredSkills: ["Python"],
      preferredSkills: [],
      domainTags: [],
      yearsExperience: { min: 0, max: 3, raw: "0-3 years" },
      seniority: "entry",
      responsibilities: ["Own deployments end to end. Decide what done means."],
      requirements: ["0–3 years of experience."],
      rawText:
        "Forward Deployed Engineer. 0–3 years of experience. Own deployments end to end. Decide what done means.",
    };
    const evaled = evaluateTitleResponsibilitySeniority(extracted);
    expect(evaled.highAutonomy).toBe(true);
    expect(evaled.mismatch).toBe(true);
  });

  it("does not suppress a Senior FDE title even when the listing also uses a 0–3 year range", () => {
    const extracted = {
      company: "Afresh",
      title: "Senior Forward Deployed Engineer",
      stack: ["Python"],
      requiredSkills: ["Python"],
      preferredSkills: [],
      domainTags: [],
      yearsExperience: { min: 0, max: 3, raw: "0-3 years" },
      seniority: "entry",
      responsibilities: ["Own deployments end to end. Decide what done means."],
      requirements: ["0–3 years of experience. Own deployments end to end."],
      rawText:
        "Senior Forward Deployed Engineer. 0 to 3 years of experience. Own deployments end to end. Decide what done means.",
    };
    const evaled = evaluateTitleResponsibilitySeniority(extracted);
    expect(evaled.titleBand).toBeGreaterThanOrEqual(2);
    expect(evaled.highAutonomy).toBe(true);
    expect(evaled.mismatch).toBe(true);
  });
});
