/**
 * Read-only calibration baseline: stored JDs + stored LLM categories + current rules.
 * Does not call OpenAI, does not write Mongo, does not approve revisions.
 */
import "../src/config/env.js";
import { MongoClient } from "mongodb";
import { env } from "../src/config/env.js";
import {
  buildCalibrationBaselineRow,
  evaluationToJobRecord,
  type CalibrationBaselineRow,
} from "../src/lib/calibrationBaseline.js";
import { recomputeStoredJobScore } from "../src/lib/recomputeStoredJobScore.js";
import { userProfile } from "../src/config/userProfile.js";
import { resumeContextService } from "../src/services/resume/resumeContext.js";
import type { ApplicationEvaluation } from "../src/services/gmail/jdRecovery/evaluations.repository.js";
import {
  toApprovedOverlay,
} from "../src/services/scoring/scoreRevisions.repository.js";
import type { ScoreRevision } from "../src/services/scoring/scoreRevision.types.js";
import {
  CALIBRATION_FIXTURES,
  calibrationSweResumeContexts,
  loadCalibrationFixture,
  scoreCalibrationAnchor,
  type CalibrationFixtureKey,
} from "../src/tests/fixtures/calibrationAnchors.js";

const FIXTURE_SAMPLE: Array<{ key: CalibrationFixtureKey; bucket: string }> = [
  { key: "cherryHill", bucket: "confirmed_strong" },
  { key: "picnicFrontend", bucket: "frontend" },
  { key: "fuboFrontend", bucket: "frontend" },
  { key: "preciselyAssociateSweFrontend", bucket: "frontend_early" },
  { key: "eulerityJavaRequired", bucket: "backend_java_mandatory" },
  { key: "jsrTechConsultingRequiredNode", bucket: "backend_node" },
  { key: "arbitalHealthFullStack", bucket: "fullstack_python_mandatory" },
  { key: "worldquantFullStackDeveloper", bucket: "fullstack" },
  { key: "trabaAppliedAi", bucket: "early_career_fde" },
  { key: "augustLawForwardDeployed", bucket: "senior_fde" },
  { key: "roAiEngineer", bucket: "ai_enabled_python_primary" },
  { key: "nytNewsMultimodal", bucket: "ai_enabled" },
  { key: "nytCdpRequiredLanguage", bucket: "illustrative_language" },
  { key: "preferredOnlyGapVerbiage", bucket: "preferred_only" },
  { key: "ibmDegreeGate", bucket: "hard_gate" },
  { key: "wexSde1ResidencyRadiusGate", bucket: "hard_gate" },
  { key: "civisCattleCall", bucket: "confirmed_weak" },
  { key: "metaBrand", bucket: "confirmed_weak" },
];

/** Last known deterministic totals before this phase's requirement repair. */
const PREVIOUS_DETERMINISTIC: Partial<Record<CalibrationFixtureKey, { total: number; rec: string }>> = {
  roAiEngineer: { total: 85, rec: "strong_apply" },
};

const LIVE_COMPANY_NEEDLES = [
  "^Ro$",
  "Arbital",
  "^Meow$",
  "Rippling",
  "^UJET$",
  "Eulerity",
  "Traba",
  "^Affirm$",
  "Fluxcap",
  "Picnic",
  "August Law",
  "Cherry Hill",
  "^IBM$",
  "^WEX$",
  "Mathpix",
  "New York Times",
  "WorldQuant",
  "Fleetio",
  "^Bubble$",
  "Luminos",
  "Vercel",
  "Justworks",
];

const compact = (row: CalibrationBaselineRow, extra?: Record<string, unknown>) => ({
  key: row.key,
  company: row.company,
  role: row.role,
  historical: row.historicalTotal == null ? null : `${row.historicalTotal}/${row.historicalRec}`,
  effective: row.effectiveTotal == null ? null : `${row.effectiveTotal}/${row.effectiveRec} (${row.effectiveSource})`,
  replay: row.replayTotal == null ? null : `${row.replayTotal}/${row.replayRec}`,
  lane: `${row.storedLane ?? "?"} → ${row.replayLane ?? "?"}`,
  capability: row.capability,
  survAdj: row.survAdjustment,
  gapDock: row.gapDock,
  contractDock: row.contractDock,
  stackFit: `${row.storedStackFit ?? "?"} → ${row.replayStackFit ?? "?"}`,
  coreGap: `${JSON.stringify(row.storedCoreGap)} → ${JSON.stringify(row.replayCoreGap)}`,
  mismatch: `${row.storedStackMismatch} → ${row.replayStackMismatch}`,
  specDock: row.specializationDock,
  hardGates: row.hardGates,
  caps: row.caps,
  promptVersion: row.promptVersion,
  scorer: row.pipelineVersionLabel,
  class: row.differenceClass,
  doubleCount: row.doubleCount,
  notes: row.notes,
  ...extra,
});

const fixtureRows = () =>
  FIXTURE_SAMPLE.map(({ key, bucket }) => {
    const fixture = loadCalibrationFixture(key);
    const replay = scoreCalibrationAnchor(key);
    const previous = PREVIOUS_DETERMINISTIC[key];
    const synthetic = {
      key,
      company: fixture.extracted.company,
      role: fixture.extracted.title,
      appliedAt: "2026-01-01T00:00:00.000Z",
      recovery: { status: "scored" as const, attempts: [], serperQueries: 0 },
      jd: { text: fixture.extracted.rawText ?? "", textHash: "fixture" },
      fit: {
        total: previous?.total ?? replay.score.total ?? 0,
        recommendation: previous?.rec ?? replay.recommendation,
        recommendedResume: "BASE" as const,
        scoredAt: "2026-01-01T00:00:00.000Z",
        promptVersion: "fixture",
        detail: {
          recommendation: replay.recommendation,
          recommendedResume: "BASE" as const,
          topMatch: "",
          mainRisk: "",
          rationale: [],
          risks: [],
          resumeRationale: [],
          score: replay.score,
          rules: replay.rules,
          extracted: fixture.extracted,
        },
      },
      outcome: { status: "applied" as const, updatedAt: "2026-01-01T00:00:00.000Z", history: [] },
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    } satisfies ApplicationEvaluation;
    const row = buildCalibrationBaselineRow({ evaluation: synthetic, replay });
    return compact(row, { bucket, fixtureId: fixture.id, catalog: CALIBRATION_FIXTURES[key] });
  });

const liveRows = async (): Promise<unknown[]> => {
  const client = new MongoClient(env.mongoUri, { ignoreUndefined: true });
  try {
    await client.connect();
    const db = client.db(env.mongoDbName);
    const evaluations = db.collection<ApplicationEvaluation>("application_evaluations");
    const revisions = db.collection<ScoreRevision>("score_revisions");
    const resumeContexts = await resumeContextService.getAvailableContexts();
    const rows: unknown[] = [];
    const seen = new Set<string>();

    const approved = await revisions
      .find({ status: "approved", activeApplicationKey: { $exists: true } })
      .project({
        revisionId: 1,
        applicationKey: 1,
        evaluationFingerprint: 1,
        status: 1,
        corrected: 1,
        original: 1,
      })
      .toArray();
    const overlayByKey = new Map(
      approved.map((revision) => [revision.applicationKey, toApprovedOverlay(revision as ScoreRevision)]),
    );

    for (const needle of LIVE_COMPANY_NEEDLES) {
      const evaluation = await evaluations.findOne({
        "recovery.status": "scored",
        company: { $regex: needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), $options: "i" },
      });
      if (!evaluation || seen.has(evaluation.key)) continue;
      seen.add(evaluation.key);
      const job = evaluationToJobRecord(evaluation);
      let replay = null;
      let replayError: string | undefined;
      if (!job) {
        replayError = "missing stored snapshot or JD text";
      } else {
        try {
          replay = recomputeStoredJobScore({
            job,
            profile: userProfile,
            resumeContexts,
          });
        } catch (err) {
          replayError = err instanceof Error ? err.message : String(err);
        }
      }
      const row = buildCalibrationBaselineRow({
        evaluation,
        revision: overlayByKey.get(evaluation.key) ?? null,
        replay,
        replayError,
      });
      rows.push(compact(row, { source: "live_evaluation", matchedCompany: needle }));
    }

    for (const [applicationKey, overlay] of overlayByKey) {
      if (seen.has(applicationKey)) continue;
      const evaluation = await evaluations.findOne({ key: applicationKey });
      if (!evaluation) continue;
      seen.add(evaluation.key);
      const job = evaluationToJobRecord(evaluation);
      const replay = job
        ? recomputeStoredJobScore({ job, profile: userProfile, resumeContexts })
        : null;
      const row = buildCalibrationBaselineRow({
        evaluation,
        revision: overlay,
        replay,
        replayError: job ? undefined : "missing stored snapshot or JD text",
      });
      rows.push(compact(row, { source: "approved_revision_extra" }));
    }

    return rows;
  } finally {
    await client.close();
  }
};

const main = async () => {
  const fixtures = fixtureRows();
  let live: unknown[] = [];
  let liveError: string | undefined;
  try {
    live = await liveRows();
  } catch (err) {
    liveError = err instanceof Error ? err.message : String(err);
  }
  process.stdout.write(
    `${JSON.stringify(
      {
        readOnly: true,
        paidLlm: false,
        historicalImmutable: true,
        fixtureCount: fixtures.length,
        liveCount: live.length,
        liveError,
        fixtures,
        live,
      },
      null,
      2,
    )}\n`,
  );
};

await main();
