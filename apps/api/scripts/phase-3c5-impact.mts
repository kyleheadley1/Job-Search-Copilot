/**
 * Read-only 3C-5 impact: requirement groups + replay after disjunctive isolation.
 * Does not write Mongo, approve revisions, call OpenAI, or change scores.
 */
import "../src/config/env.js";
import { MongoClient } from "mongodb";
import { env } from "../src/config/env.js";
import { userProfile } from "../src/config/userProfile.js";
import { resumeContextService } from "../src/services/resume/resumeContext.js";
import type { ApplicationEvaluation } from "../src/services/gmail/jdRecovery/evaluations.repository.js";
import { recomputeStoredJobScore } from "../src/lib/recomputeStoredJobScore.js";
import { evaluationToJobRecord } from "../src/lib/calibrationBaseline.js";
import { claimableStackFromContexts } from "../src/lib/claimableStack.js";
import { evaluateDisjunctiveLanguageRequirement } from "../src/lib/disjunctiveLanguageRequirement.js";
import {
  CALIBRATION_FIXTURES,
  calibrationSweResumeContexts,
  loadCalibrationFixture,
  scoreCalibrationAnchor,
  type CalibrationFixtureKey,
} from "../src/tests/fixtures/calibrationAnchors.js";

const FOCUS_KEYS = [
  "simeio::full stack ai developer",
  "axios::software engineer",
  "worldquant::",
  "the new york times::software engineer re ections",
  "rippling::software engineer backend it product",
  "meow::software engineer",
  "trunk tools::forward deployed engineer",
];

const PRE_FIX_REPLAY: Record<string, { total: number; rec: string; stackFit: number; cap: number; gap: string[] }> =
  {
    "simeio::full stack ai developer": { total: 82, rec: "strong_apply", stackFit: 17, cap: 83, gap: [] },
    "axios::software engineer": { total: 76, rec: "apply", stackFit: 17, cap: 78, gap: [] },
    "worldquant::": { total: 77, rec: "apply", stackFit: 17, cap: 79, gap: [] },
    "the new york times::software engineer re ections": {
      total: 69,
      rec: "apply",
      stackFit: 17,
      cap: 71,
      gap: [],
    },
    "rippling::software engineer backend it product": {
      total: 79,
      rec: "apply",
      stackFit: 17,
      cap: 83,
      gap: [],
    },
  };

const FIXTURE_KEYS: CalibrationFixtureKey[] = [
  "worldquantFullStackDeveloper",
  "fleetioMarketplace",
  "arbitalHealthFullStack",
  "roAiEngineer",
  "nytReflectionsSupportedFeatureOwnership",
  "augustLawForwardDeployed",
  "eulerityJavaRequired",
  "bisectHostingWebDeveloper",
  "cherryHill",
];

const compactGroups = (evaluation: ReturnType<typeof evaluateDisjunctiveLanguageRequirement>) =>
  evaluation.groups.map((group) => ({
    kind: group.kind,
    languages: group.languages,
    satisfied: group.satisfied,
    matched: group.matchedLabels,
    quote: group.sourceQuote.slice(0, 140),
  }));

const main = async () => {
  const fixtures = FIXTURE_KEYS.map((key) => {
    const fixture = loadCalibrationFixture(key);
    const scored = scoreCalibrationAnchor(key);
    const liveGroups =
      scored.rules.disjunctiveLanguageGroups ??
      evaluateDisjunctiveLanguageRequirement(
        fixture.extracted,
        claimableStackFromContexts(calibrationSweResumeContexts(), "BASE"),
      ).groups;
    return {
      key,
      catalog: CALIBRATION_FIXTURES[key],
      total: scored.score.total,
      rec: scored.recommendation,
      cap: scored.score.capability,
      stackFit: scored.score.stackFit,
      llmStackFit: fixture.storedCategoryScores.stackFit,
      mismatch: scored.rules.stackMismatch,
      gap: scored.rules.coreLanguageGap,
      specDock: scored.rules.specializationGap?.dock ?? 0,
      disjunctiveSatisfied: scored.rules.disjunctiveLanguageRequirementSatisfied,
      groups: liveGroups.map((group) => ({
        kind: group.kind,
        languages: group.languages,
        satisfied: group.satisfied,
        matched: group.matchedLabels,
        quote: group.sourceQuote.slice(0, 140),
      })),
    };
  });

  const client = new MongoClient(env.mongoUri, { ignoreUndefined: true });
  const live: unknown[] = [];
  let liveError: string | undefined;
  try {
    await client.connect();
    const db = client.db(env.mongoDbName);
    const evaluations = db.collection<ApplicationEvaluation>("application_evaluations");
    const resumeContexts = await resumeContextService.getAvailableContexts();
    const claimable = claimableStackFromContexts(resumeContexts, "BASE");
    for (const key of FOCUS_KEYS) {
      const evaluation = await evaluations.findOne({ key });
      if (!evaluation) {
        live.push({ key, missing: true });
        continue;
      }
      const job = evaluationToJobRecord(evaluation);
      const replay = job
        ? recomputeStoredJobScore({ job, profile: userProfile, resumeContexts })
        : null;
      const extracted = job?.extracted
        ? { ...job.extracted, rawText: evaluation.jd?.text || job.extracted.rawText }
        : undefined;
      const groups = extracted ? compactGroups(evaluateDisjunctiveLanguageRequirement(extracted, claimable)) : [];
      const pre = PRE_FIX_REPLAY[key];
      live.push({
        key,
        company: evaluation.company,
        role: evaluation.role,
        historical: {
          total: evaluation.fit?.total,
          rec: evaluation.fit?.recommendation,
          cap: evaluation.fit?.detail?.score.capability ?? evaluation.fit?.breakdown?.capability,
          stackFit: evaluation.fit?.detail?.score.stackFit,
          llmStackFit: evaluation.fit?.detail?.score.llmCategories?.stackFit,
          gap: evaluation.fit?.detail?.rules.coreLanguageGap,
          specDock: evaluation.fit?.detail?.rules.specializationGap?.dock ?? 0,
          mismatch: evaluation.fit?.detail?.rules.stackMismatch,
        },
        preFixReplay: pre ?? null,
        postFixReplay: replay
          ? {
              total: replay.score.total,
              rec: replay.recommendation,
              cap: replay.score.capability,
              stackFit: replay.score.stackFit,
              gap: replay.rules.coreLanguageGap,
              specDock: replay.rules.specializationGap?.dock ?? 0,
              mismatch: replay.rules.stackMismatch,
              disjunctiveSatisfied: replay.rules.disjunctiveLanguageRequirementSatisfied,
              titleResponsibilityMismatch: replay.rules.titleResponsibilityMismatch,
              hardGates: replay.score.scoreDisplay?.hardGates ?? [],
            }
          : null,
        tierChangedFromHistorical:
          replay && evaluation.fit?.recommendation
            ? replay.recommendation !== evaluation.fit.recommendation
            : false,
        groups,
      });
    }
  } catch (err) {
    liveError = err instanceof Error ? err.message : String(err);
  } finally {
    await client.close();
  }

  process.stdout.write(
    `${JSON.stringify({ readOnly: true, paidLlm: false, fixtures, live, liveError }, null, 2)}\n`,
  );
};

await main();
