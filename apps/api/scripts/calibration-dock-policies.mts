/**
 * In-memory 3C-2 experiments. Read-only: no Mongo writes, no LLM, no production policy change.
 */
import "../src/config/env.js";
import { MongoClient } from "mongodb";
import { env } from "../src/config/env.js";
import { applyDockPolicies, evaluationToJobRecord } from "../src/lib/calibrationBaseline.js";
import { recomputeStoredJobScore } from "../src/lib/recomputeStoredJobScore.js";
import { userProfile } from "../src/config/userProfile.js";
import { resumeContextService } from "../src/services/resume/resumeContext.js";
import type { ApplicationEvaluation } from "../src/services/gmail/jdRecovery/evaluations.repository.js";
import {
  calibrationSweResumeContexts,
  fixtureToJobRecord,
  loadCalibrationFixture,
  scoreCalibrationAnchor,
} from "../src/tests/fixtures/calibrationAnchors.js";
import { computePoolFriendliness } from "../src/lib/poolFriendliness.js";
import { sanitizeExtractedTags } from "../src/lib/jdTagProvenance.js";
import { detectBackendStackSpecializationGap } from "../src/lib/capabilityGap.js";

const LIVE_KEYS = [
  "arbital health::full stack engineer",
  "ujet::full stack engineer ai platform",
  "rippling::software engineer backend it product",
  "meow::software engineer",
  "the new york times::software engineer re ections",
];

const pythonOnResume = (text: string) => /\bpython\b/i.test(text);

const experimentRow = (params: {
  key: string;
  source: string;
  company: string;
  role: string | null;
  genuineMandatory: boolean;
  llmStackFit: number | null;
  replay: ReturnType<typeof recomputeStoredJobScore>;
  resumeText: string;
}) => {
  const display = params.replay.score.scoreDisplay;
  const spec = params.replay.rules.specializationGap;
  const policies = applyDockPolicies({
    llmStackFit: params.llmStackFit,
    adjustedStackFit: params.replay.score.stackFit ?? null,
    specializationDock: spec?.dock ?? 0,
    capability: display?.capability ?? params.replay.score.capability ?? 0,
    survAdjustment: display?.survAdjustment ?? 0,
    gapDock: display?.gapDock ?? 0,
    contractDock: 0,
    hardGate: (display?.hardGates?.length ?? 0) > 0,
  });
  return {
    key: params.key,
    source: params.source,
    company: params.company,
    role: params.role,
    genuineMandatory: params.genuineMandatory,
    candidateHasLanguage: pythonOnResume(params.resumeText) || /\bjava\b(?!script)/i.test(params.resumeText),
    llmStackFit: params.llmStackFit,
    adjustedStackFit: params.replay.score.stackFit,
    stackMismatch: params.replay.rules.stackMismatch,
    coreLanguageGap: params.replay.rules.coreLanguageGap ?? [],
    specDock: spec?.dock ?? 0,
    specName: spec?.name ?? null,
    capability: display?.capability,
    survAdj: display?.survAdjustment,
    gapDock: display?.gapDock,
    production: `${params.replay.score.total}/${params.replay.recommendation}`,
    policies: Object.fromEntries(
      policies.map((row) => [row.id, `${row.final}/${row.rec} spec=${row.specDock} combined=${row.combinedStackPenalty}`]),
    ),
    llmAlreadyAtCeiling: policies[0]?.llmAlreadyAtCeiling ?? false,
  };
};

const trabaReport = () => {
  const fixture = loadCalibrationFixture("trabaAppliedAi");
  const job = fixture.extracted;
  const raw = job.rawText ?? "";
  const sanitized = sanitizeExtractedTags(job);
  const inRaw = (term: string) => new RegExp(`\\b${term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(raw);
  const tags = [...new Set([...(job.stack ?? []), ...(job.requiredSkills ?? []), ...(job.preferredSkills ?? [])])];
  const classification = tags.map((term) => {
    const kept = (sanitized.stack ?? []).includes(term) || (sanitized.requiredSkills ?? []).includes(term);
    return {
      term,
      inRawText: inRaw(term),
      keptAfterSanitize: kept,
      kind: inRaw(term) ? "grounded_in_stored_rawText" : "ungrounded_vs_stored_rawText",
    };
  });
  const unsanitizedPool = computePoolFriendliness(job);
  const sanitizedPool = computePoolFriendliness(sanitized);
  const restoredRaw = `${raw}\nPython TypeScript React Native LLM RAG OpenAI REST APIs`;
  const restored = { ...job, rawText: restoredRaw };
  const restoredSanitized = sanitizeExtractedTags(restored);
  const restoredPool = computePoolFriendliness(restoredSanitized);
  const base = scoreCalibrationAnchor("trabaAppliedAi");
  const restoredReplay = recomputeStoredJobScore({
    job: { ...fixtureToJobRecord({ ...fixture, extracted: restored }), extracted: restoredSanitized },
    resumeContexts: calibrationSweResumeContexts(),
  });
  return {
    rawTextChars: raw.length,
    rawTextLooksPartial: raw.length < 800 && !(job.requirements ?? []).some((line) => /\bpython\b/i.test(line)),
    tags: classification,
    droppedUngrounded: classification.filter((row) => !row.inRawText),
    keptGrounded: classification.filter((row) => row.inRawText && row.keptAfterSanitize),
    pool: {
      unsanitized: unsanitizedPool.score,
      unsanitizedAdjustments: unsanitizedPool.adjustments.map((row) => `${row.id}:${row.delta}`),
      sanitized: sanitizedPool.score,
      sanitizedAdjustments: sanitizedPool.adjustments.map((row) => `${row.id}:${row.delta}`),
      restoredIfChipsWereInRawText: restoredPool.score,
    },
    scoringPath: {
      capability: base.score.capability,
      total: base.score.total,
      rec: base.recommendation,
      poolFriendliness: base.poolFriendliness,
    },
    hypotheticalRestoreReplay: {
      capability: restoredReplay.score.capability,
      total: restoredReplay.score.total,
      rec: restoredReplay.recommendation,
      pool: restoredReplay.score.survivabilityBreakdown?.poolFriendliness,
    },
  };
};

const thresholdSensitivity = (totals: number[]) => {
  const bands = [
    { name: "strong_apply", cut: 80, window: [78, 82] as const },
    { name: "apply", cut: 65, window: [63, 67] as const },
    { name: "stretch", cut: 50, window: [48, 52] as const },
  ];
  return {
    n: totals.length,
    bands: bands.map((band) => {
      const near = totals.filter((n) => n >= band.window[0] && n <= band.window[1]);
      const wouldFlipPlus = totals.filter((n) => n >= band.cut && n < band.cut + 2).length;
      const wouldFlipMinus = totals.filter((n) => n < band.cut && n >= band.cut - 2).length;
      return {
        ...band,
        nearCount: near.length,
        nearScores: near.sort((a, b) => a - b),
        flipIfMinus2: wouldFlipMinus,
        flipIfPlus2: wouldFlipPlus,
      };
    }),
  };
};

const main = async () => {
  const resumeContexts = await resumeContextService.getAvailableContexts();
  const resumeText = resumeContexts.BASE?.rawText ?? calibrationSweResumeContexts().BASE?.rawText ?? "";
  const rows: unknown[] = [];

  const roFixture = loadCalibrationFixture("roAiEngineer");
  const roReplay = recomputeStoredJobScore({
    job: fixtureToJobRecord(roFixture),
    resumeContexts: calibrationSweResumeContexts(),
  });
  rows.push(
    experimentRow({
      key: "roAiEngineer",
      source: "fixture",
      company: "Ro",
      role: "AI Engineer",
      genuineMandatory: true,
      llmStackFit: roFixture.storedCategoryScores.stackFit,
      replay: roReplay,
      resumeText: calibrationSweResumeContexts().BASE?.rawText ?? "",
    }),
  );

  const eulerity = loadCalibrationFixture("eulerityJavaRequired");
  const eulerityReplay = recomputeStoredJobScore({
    job: fixtureToJobRecord(eulerity),
    resumeContexts: calibrationSweResumeContexts(),
  });
  rows.push(
    experimentRow({
      key: "eulerityJavaRequired",
      source: "fixture",
      company: "Eulerity",
      role: eulerity.extracted.title,
      genuineMandatory: true,
      llmStackFit: eulerity.storedCategoryScores.stackFit,
      replay: eulerityReplay,
      resumeText: calibrationSweResumeContexts().BASE?.rawText ?? "",
    }),
  );

  const client = new MongoClient(env.mongoUri, { ignoreUndefined: true });
  let liveTotals: number[] = [];
  try {
    await client.connect();
    const evaluations = client.db(env.mongoDbName).collection<ApplicationEvaluation>("application_evaluations");
    liveTotals = (
      await evaluations
        .find({ "recovery.status": "scored", "fit.total": { $type: "number" } })
        .project({ "fit.total": 1 })
        .toArray()
    ).map((row) => row.fit?.total as number);

    for (const key of LIVE_KEYS) {
      const evaluation = await evaluations.findOne({ key });
      if (!evaluation) {
        rows.push({ key, missing: true });
        continue;
      }
      const job = evaluationToJobRecord(evaluation);
      if (!job) {
        rows.push({ key, missing: "snapshot" });
        continue;
      }
      const replay = recomputeStoredJobScore({ job, profile: userProfile, resumeContexts });
      const genuine =
        key.startsWith("arbital") || key.startsWith("ujet")
          ? true
          : key.startsWith("rippling") || key.startsWith("meow") || key.includes("new york times")
            ? false
            : true;
      rows.push(
        experimentRow({
          key,
          source: "live",
          company: evaluation.company,
          role: evaluation.role,
          genuineMandatory: genuine,
          llmStackFit:
            evaluation.fit?.detail?.score?.llmCategories?.stackFit ??
            evaluation.fit?.detail?.score?.stackFit ??
            null,
          replay,
          resumeText,
        }),
      );
    }
  } finally {
    await client.close();
  }

  process.stdout.write(
    `${JSON.stringify(
      {
        readOnly: true,
        productionUnchanged: true,
        ripplingSpecAfterFix: detectBackendStackSpecializationGap(
          loadCalibrationFixture("roAiEngineer").extracted,
          calibrationSweResumeContexts().BASE?.rawText,
        )?.dock,
        rows,
        traba: trabaReport(),
        thresholds: thresholdSensitivity(liveTotals),
        recCuts: { strong_apply: 80, apply: 65, stretch: 50 },
      },
      null,
      2,
    )}\n`,
  );
};

await main();
