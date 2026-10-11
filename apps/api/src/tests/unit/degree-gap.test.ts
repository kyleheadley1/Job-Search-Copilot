import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { evaluateRules } from "../../agents/jobAgent/rules.js";
import { userProfile } from "../../config/userProfile.js";
import {
  computeDegreeGapDock,
  DEGREE_DOCK_BY_TIER,
  resolveDegreeGapTier,
} from "../../lib/degreeGap.js";
import { computeCompositeScore } from "../../lib/compositeScoreModel.js";
import { computeGapDock, formatScoreDerivation } from "../../lib/compositeScoring.js";
import { applyScoringClampLayer } from "../../lib/scoringClampLayer.js";
import {
  buildScoreDisplay,
  buildSurvivabilityPenalties,
  buildSurvivabilityRows,
} from "../../lib/scoreDisplayModel.js";
import type { ExtractedJobData } from "../../types/job.js";
import type { RuleEvaluation, ScoreBreakdown } from "../../types/scoring.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SWE_RESUME = fs.readFileSync(
  path.resolve(__dirname, "../fixtures/resumes/swe_resume.txt"),
  "utf8",
);

const IBM_JOB: ExtractedJobData = {
  company: "IBM",
  title: "Software Engineer",
  location: "Remote",
  remoteType: "remote",
  stack: ["Node.js", "TypeScript"],
  requiredSkills: ["Node.js", "TypeScript"],
  preferredSkills: [],
  domainTags: ["product"],
  degreeRequirement: {
    level: "required",
    raw: "Bachelor's degree in Computer Science required",
  },
  requirements: ["Bachelor's degree in Computer Science required"],
  responsibilities: ["Build full-stack product features"],
  rawText:
    "IBM Software Engineer. Bachelor's degree in Computer Science required. Internal referral from Alex Chen welcomed.",
};

const OPTIMIZELY_JOB: ExtractedJobData = {
  company: "Optimizely",
  title: "Software Engineer II",
  location: "Remote",
  remoteType: "remote",
  stack: ["SAML", "OAuth"],
  requiredSkills: ["SAML"],
  preferredSkills: [],
  domainTags: [],
  degreeRequirement: {
    level: "required",
    raw: "Bachelor's or related experience required",
  },
  requirements: ["Bachelor's or related experience required"],
  responsibilities: [],
  rawText: "Bachelor's or related experience required.",
};

const NO_DEGREE_JOB: ExtractedJobData = {
  company: "Startup",
  title: "Software Engineer",
  location: "Remote",
  remoteType: "remote",
  stack: ["TypeScript"],
  requiredSkills: ["TypeScript"],
  preferredSkills: [],
  domainTags: [],
  responsibilities: [],
  requirements: ["Strong TypeScript experience"],
  rawText: "Strong TypeScript experience.",
};

const IBM_RAW: ScoreBreakdown = {
  stackFit: 17,
  levelFit: 15,
  domainFit: 7,
  resumeStoryClarity: 8,
  functionalOverlap: 14,
  recruiterFriendliness: 10,
  careerValue: 8,
  total: 0,
};

const credentialAndDegreeLevers = (
  rules: RuleEvaluation,
  job: ExtractedJobData,
  breakdown: NonNullable<ScoreBreakdown["survivabilityBreakdown"]>,
) => {
  const credentialRow = buildSurvivabilityRows(breakdown, rules).find(
    (r) => r.key === "credentialSignal",
  );
  const degreePenalty = buildSurvivabilityPenalties(rules, job).find((p) =>
    p.message.match(/degree gate|degree listed/i),
  );
  return { credentialRow, degreePenalty };
};

describe("degree dock tiers", () => {
  it("no degree mentioned → dock 0", () => {
    const rules = evaluateRules(NO_DEGREE_JOB, userProfile, { activeResumeType: "BASE" });
    expect(resolveDegreeGapTier(rules, userProfile)).toBe("none");
    expect(computeDegreeGapDock(rules, userProfile)).toBe(0);
  });

  it("neutral JD (no degree language) uses neutral credential lever label, not NONE", () => {
    const rules = evaluateRules(NO_DEGREE_JOB, userProfile, { activeResumeType: "BASE" });
    const composite = computeCompositeScore({
      rawScore: IBM_RAW,
      rules,
      extracted: NO_DEGREE_JOB,
      profile: userProfile,
      resumeText: SWE_RESUME,
    });
    const credentialRow = buildSurvivabilityRows(
      composite.score.survivabilityBreakdown!,
      rules,
    ).find((r) => r.key === "credentialSignal");
    expect(credentialRow?.leverLabel).toMatch(/neutral — no explicit degree language/i);
    expect(credentialRow?.leverLabel).not.toMatch(/NONE/i);
  });

  it("equivalency clause → soft tier only", () => {
    const rules = evaluateRules(OPTIMIZELY_JOB, userProfile, { activeResumeType: "BASE" });
    expect(rules.degreeHasEquivalencyClause).toBe(true);
    expect(rules.explicitDegreeRisk).toBe(false);
    expect(resolveDegreeGapTier(rules, userProfile)).toBe("soft");
    expect(computeDegreeGapDock(rules, userProfile)).toBe(DEGREE_DOCK_BY_TIER.soft);
    expect(computeDegreeGapDock(rules, userProfile)).toBeLessThan(DEGREE_DOCK_BY_TIER.medium);
  });

  it("strict field-degree line plus a separate 'or equivalent' line → conflicting tier", () => {
    const breezeJob: ExtractedJobData = {
      ...NO_DEGREE_JOB,
      company: "Breeze",
      title: "Full Stack Engineer - Junior",
      degreeRequirement: { level: "required", raw: "Bachelors Degree in Computer Science" },
      rawText: [
        "What We're Looking For",
        "Bachelors Degree in Computer Science ",
        "2+ years of professional software engineering experience.",
        "Solid full stack experience with React.js, Node.js, and TypeScript.",
        "Bachelor's degree or equivalent practical experience.",
      ].join("\n"),
    };
    const rules = evaluateRules(breezeJob, userProfile, { activeResumeType: "BASE" });
    expect(rules.degreeHasEquivalencyClause).toBe(true);
    expect(rules.degreeConflictingRequirement).toBe(true);
    expect(resolveDegreeGapTier(rules, userProfile)).toBe("conflicting");
    expect(computeDegreeGapDock(rules, userProfile)).toBe(DEGREE_DOCK_BY_TIER.conflicting);
    expect(DEGREE_DOCK_BY_TIER.conflicting).toBeGreaterThan(DEGREE_DOCK_BY_TIER.soft);
    expect(DEGREE_DOCK_BY_TIER.conflicting).toBeLessThan(DEGREE_DOCK_BY_TIER.medium);
  });

  it("field degree with the alternative on the same line stays soft", () => {
    const job: ExtractedJobData = {
      ...NO_DEGREE_JOB,
      degreeRequirement: { level: "required", raw: "BS in Computer Science or equivalent experience" },
      rawText: "Requirements\nBS in Computer Science or equivalent experience\n3+ years TypeScript",
    };
    const rules = evaluateRules(job, userProfile, { activeResumeType: "BASE" });
    expect(rules.degreeConflictingRequirement).toBe(false);
    expect(resolveDegreeGapTier(rules, userProfile)).toBe("soft");
  });

  it("unconditional degree at structured employer → high tier", () => {
    const rules = evaluateRules(IBM_JOB, userProfile, { activeResumeType: "BASE" });
    expect(rules.explicitDegreeRisk).toBe(true);
    expect(rules.degreeHasEquivalencyClause).toBeFalsy();
    expect(rules.matureStructuredEmployer).toBe(true);
    expect(resolveDegreeGapTier(rules, userProfile)).toBe("high");
    expect(computeDegreeGapDock(rules, userProfile)).toBe(DEGREE_DOCK_BY_TIER.high);
  });
});

describe("IBM degree gate consistency", () => {
  it("credential row and degree penalty share none_in_loop; high dock; final below prior ~73", () => {
    const rules = evaluateRules(IBM_JOB, userProfile, { activeResumeType: "BASE" });
    const clamped = applyScoringClampLayer({ score: IBM_RAW, extracted: IBM_JOB, rules });
    const composite = computeCompositeScore({
      rawScore: clamped.score,
      rules: clamped.rules,
      extracted: IBM_JOB,
      profile: userProfile,
      resumeText: SWE_RESUME,
    });

    const breakdown = composite.score.survivabilityBreakdown!;
    const { credentialRow, degreePenalty } = credentialAndDegreeLevers(
      clamped.rules,
      IBM_JOB,
      breakdown,
    );

    expect(credentialRow?.lever).toBe("none_in_loop");
    expect(degreePenalty?.lever).toBe("none_in_loop");
    expect(credentialRow?.lever).toBe(degreePenalty?.lever);
    expect(credentialRow?.leverLabel).toBe(degreePenalty?.leverLabel);

    const display = buildScoreDisplay({
      score: composite.score,
      rules: clamped.rules,
      extracted: IBM_JOB,
      recommendation: composite.recommendation,
    });

    expect(display?.gapDock).toBeGreaterThanOrEqual(DEGREE_DOCK_BY_TIER.high);
    expect(display?.final).toBeLessThan(73);
    expect(display?.scoreDerivation).toMatch(/ − \d+ = /);
    expect(display?.scoreDerivation).not.toMatch(/pool|credential/i);
  });
});

describe("single degree dock in derivation", () => {
  it("gapDock includes degree dock once inside composite derivation", () => {
    const rules = evaluateRules(IBM_JOB, userProfile, { activeResumeType: "BASE" });
    const dock = computeGapDock(rules, userProfile);
    expect(dock).toBe(DEGREE_DOCK_BY_TIER.high);

    const composite = computeCompositeScore({
      rawScore: IBM_RAW,
      rules,
      extracted: IBM_JOB,
      profile: userProfile,
      resumeText: SWE_RESUME,
    });
    const derivation = formatScoreDerivation({
      capability: composite.score.capability ?? 0,
      survivability: composite.score.survivability ?? 0,
      survAdjustment: 0,
      gapDock: dock,
      final: (composite.score.capability ?? 0) - dock,
    });
    const dockMatches = derivation.match(/ − (\d+)/g) ?? [];
    expect(dockMatches.length).toBeLessThanOrEqual(1);
  });
});

describe("credential rows never use resume framing for degree gaps", () => {
  it("no credential/degree row renders resume/framing for unconditional IBM gate", () => {
    const rules = evaluateRules(IBM_JOB, userProfile, { activeResumeType: "BASE" });
    const penalties = buildSurvivabilityPenalties(rules, IBM_JOB);
    const degreeLike = penalties.filter((p) => p.message.match(/degree/i));
    for (const penalty of degreeLike) {
      expect(penalty.lever).not.toBe("resume");
      expect(penalty.leverLabel.toLowerCase()).not.toContain("resume framing");
    }
  });
});
