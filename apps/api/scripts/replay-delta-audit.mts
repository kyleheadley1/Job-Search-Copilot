/**
 * Read-only historical vs deterministic-replay delta audit.
 * Does not call OpenAI, write Mongo, overwrite scores, or approve revisions.
 */
import "../src/config/env.js";
import { MongoClient } from "mongodb";
import { env } from "../src/config/env.js";
import {
  buildCalibrationBaselineRow,
  buildLargeReplayDeltaReport,
  evaluationToJobRecord,
  LARGE_REPLAY_DELTA_ABS,
  type LargeReplayDeltaReport,
} from "../src/lib/calibrationBaseline.js";
import { recomputeStoredJobScore } from "../src/lib/recomputeStoredJobScore.js";
import { userProfile } from "../src/config/userProfile.js";
import { resumeContextService } from "../src/services/resume/resumeContext.js";
import type { ApplicationEvaluation } from "../src/services/gmail/jdRecovery/evaluations.repository.js";
import { toApprovedOverlay } from "../src/services/scoring/scoreRevisions.repository.js";
import type { ScoreRevision } from "../src/services/scoring/scoreRevision.types.js";

const PRIORITY_COMPANY = /rippling/i;

const compact = (row: LargeReplayDeltaReport) => ({
  application: `${row.company} — ${row.role ?? row.key}`,
  key: row.key,
  historicalAuthoritative: row.historicalAuthoritative,
  effectiveApprovedRevision: row.effectiveApprovedRevision,
  currentReplay: row.currentReplay,
  absDelta: row.absDelta,
  capabilityDelta: row.capabilityDelta,
  survivabilityDelta: row.survivabilityDelta,
  gapDockDelta: row.gapDockDelta,
  capability: `${row.capabilityHistorical ?? "?"} → ${row.capabilityReplay ?? "?"}`,
  gapDock: `${row.gapDockHistorical ?? "?"} → ${row.gapDockReplay ?? "?"}`,
  roleLane: `${row.storedLane ?? "?"} → ${row.replayLane ?? "?"}`,
  laneChanged: row.laneChanged,
  requirementGrounding: `${JSON.stringify(row.storedCoreGap)} → ${JSON.stringify(row.replayCoreGap)}`,
  requirementGroundingChanged: row.requirementGroundingChanged,
  tier: `${row.historicalRec ?? "?"} → ${row.replayRec ?? "?"}`,
  tierChanged: row.tierChanged,
  confirmedCauses: row.confirmedCauses,
  unresolvedCauses: row.unresolvedCauses,
  differenceClass: row.differenceClass,
});

const main = async () => {
  const client = new MongoClient(env.mongoUri, { ignoreUndefined: true });
  try {
    await client.connect();
    const db = client.db(env.mongoDbName);
    const evaluations = db.collection<ApplicationEvaluation>("application_evaluations");
    const revisions = db.collection<ScoreRevision>("score_revisions");
    const resumeContexts = await resumeContextService.getAvailableContexts();

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

    const scored = await evaluations
      .find({ "recovery.status": "scored" })
      .project({
        key: 1,
        company: 1,
        role: 1,
        appliedAt: 1,
        recovery: 1,
        jd: 1,
        fit: 1,
        outcome: 1,
        createdAt: 1,
        updatedAt: 1,
      })
      .toArray();

    const deltas: LargeReplayDeltaReport[] = [];
    const skipped: Array<{ key: string; company: string; reason: string }> = [];

    for (const evaluation of scored) {
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
      if (replayError) {
        skipped.push({ key: evaluation.key, company: evaluation.company, reason: replayError });
        continue;
      }
      const row = buildCalibrationBaselineRow({
        evaluation,
        revision: overlayByKey.get(evaluation.key) ?? null,
        replay,
      });
      const delta = buildLargeReplayDeltaReport(row);
      if (delta) deltas.push(delta);
    }

    deltas.sort((a, b) => {
      const aPriority = PRIORITY_COMPANY.test(a.company) ? 1 : 0;
      const bPriority = PRIORITY_COMPANY.test(b.company) ? 1 : 0;
      if (aPriority !== bPriority) return bPriority - aPriority;
      return b.absDelta - a.absDelta;
    });

    process.stdout.write(
      `${JSON.stringify(
        {
          readOnly: true,
          paidLlm: false,
          historicalImmutable: true,
          noRevisionApproval: true,
          threshold: LARGE_REPLAY_DELTA_ABS,
          scoredCount: scored.length,
          largeDeltaCount: deltas.length,
          skippedCount: skipped.length,
          skipped: skipped.slice(0, 20),
          largeDeltas: deltas.map(compact),
        },
        null,
        2,
      )}\n`,
    );
  } finally {
    await client.close();
  }
};

await main();
