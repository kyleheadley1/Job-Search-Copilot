/**
 * Read-only 3C-4 review: replay bridges, Ro diagnostic consistency, metadata inventory.
 * Does not write Mongo, approve revisions, call OpenAI, or change scores.
 */
import "../src/config/env.js";
import { MongoClient } from "mongodb";
import { env } from "../src/config/env.js";
import { userProfile } from "../src/config/userProfile.js";
import { resumeContextService } from "../src/services/resume/resumeContext.js";
import type { ApplicationEvaluation } from "../src/services/gmail/jdRecovery/evaluations.repository.js";
import type { GmailApplication } from "../src/services/gmail/gmailApplications.js";
import type { ScoreRevision } from "../src/services/scoring/scoreRevision.types.js";
import { recomputeStoredJobScore } from "../src/lib/recomputeStoredJobScore.js";
import { evaluationToJobRecord } from "../src/lib/calibrationBaseline.js";
import { buildStackPenaltyAudit } from "../src/lib/scoringAuditDiagnostics.js";
import { classifyLanguageRequirementSource } from "../src/lib/scoringAuditDiagnostics.js";
import { evaluateTitleResponsibilitySeniority } from "../src/lib/titleResponsibilitySeniority.js";
import { extractJobPostingMetadata, isWeakJobTitle } from "../src/tools/jobPostingMetadataExtract.js";
import { isValidCompanyCandidate } from "../src/tools/companyCandidateRules.js";
import { pythonIsExclusiveCoreRequirement, pythonOnMixedStackInventory } from "../src/lib/stackMismatchAnalysis.js";
import {
  languageOnlyInDisjunctiveChoice,
  languageIsIllustrativeExampleOnly,
} from "../src/lib/disjunctiveLanguageRequirement.js";
import { loadCalibrationFixture, scoreCalibrationAnchor } from "../src/tests/fixtures/calibrationAnchors.js";
import { buildScoringAuditContext } from "../src/mcp/scoringAudit.js";
import type { ResumeContextSet } from "../src/types/resumeContext.js";

const FOCUS_KEYS = [
  "simeio::full stack ai developer",
  "axios::software engineer",
  "worldquant::",
  "trunk tools::forward deployed engineer",
  "rippling::software engineer backend it product",
  "meow::software engineer",
  "the new york times::software engineer re ections",
];

const METADATA_NEEDLES = ["Plaid", "Patreon", "New York Times", "Rippling", "Afresh", "Petfolk"];

const pickEval = (evaluation: ApplicationEvaluation) => {
  const job = evaluationToJobRecord(evaluation);
  return {
    key: evaluation.key,
    company: evaluation.company,
    role: evaluation.role,
    jdTitle: evaluation.jd?.title,
    jdCompany: evaluation.jd?.company,
    jdChars: evaluation.jd?.text?.length ?? 0,
    stored: {
      total: evaluation.fit?.total,
      rec: evaluation.fit?.recommendation,
      capability: evaluation.fit?.detail?.score.capability ?? evaluation.fit?.breakdown?.capability,
      stackFit: evaluation.fit?.detail?.score.stackFit,
      llmStackFit: evaluation.fit?.detail?.score.llmCategories?.stackFit,
      levelFit: evaluation.fit?.detail?.score.levelFit,
      llmLevelFit: evaluation.fit?.detail?.score.llmCategories?.levelFit,
      functionalOverlap: evaluation.fit?.detail?.score.functionalOverlap,
      llmFunctional: evaluation.fit?.detail?.score.llmCategories?.functionalOverlap,
      recruiterFriendliness: evaluation.fit?.detail?.score.recruiterFriendliness,
      llmRecruiter: evaluation.fit?.detail?.score.llmCategories?.recruiterFriendliness,
      capabilityBreakdown: evaluation.fit?.detail?.score.capabilityBreakdown,
      survAdjustment: evaluation.fit?.detail?.score.scoreDisplay?.survAdjustment,
      gapDock: evaluation.fit?.detail?.score.scoreDisplay?.gapDock ?? evaluation.fit?.breakdown?.gapDock,
      stackMismatch: evaluation.fit?.detail?.rules.stackMismatch,
      coreLanguageGap: evaluation.fit?.detail?.rules.coreLanguageGap,
      specDock: evaluation.fit?.detail?.rules.specializationGap?.dock ?? 0,
      lane: evaluation.fit?.detail?.rules.roleLane,
      titleResponsibilityMismatch: evaluation.fit?.detail?.rules.titleResponsibilityMismatch,
      earlyCareerFriendly: evaluation.fit?.detail?.rules.earlyCareerFriendlyRole,
      disjunctiveSatisfied: evaluation.fit?.detail?.rules.disjunctiveLanguageRequirementSatisfied,
      disjunctiveAccepted: evaluation.fit?.detail?.rules.disjunctiveAcceptedLanguages,
      pythonFlexible: evaluation.fit?.detail?.rules.pythonStackFlexibleWithJsTs,
    },
    job,
    extracted: evaluation.fit?.detail?.extracted,
    jdText: evaluation.jd?.text ?? "",
  };
};

const replayBridge = (evaluation: ApplicationEvaluation, resumeContexts: ResumeContextSet) => {
  const picked = pickEval(evaluation);
  const replay = picked.job
    ? recomputeStoredJobScore({ job: picked.job, profile: userProfile, resumeContexts })
    : null;
  const extracted = picked.extracted
    ? { ...picked.extracted, rawText: picked.jdText || picked.extracted.rawText }
    : undefined;
  const titleEval = extracted ? evaluateTitleResponsibilitySeniority(extracted) : null;
  const langs = ["Python", "Go", "Java"] as const;
  return {
    key: picked.key,
    company: picked.company,
    role: picked.role,
    jdChars: picked.jdChars,
    stored: picked.stored,
    replay: replay
      ? {
          total: replay.score.total,
          rec: replay.recommendation,
          capability: replay.score.capability,
          stackFit: replay.score.stackFit,
          levelFit: replay.score.levelFit,
          functionalOverlap: replay.score.functionalOverlap,
          recruiterFriendliness: replay.score.recruiterFriendliness,
          capabilityBreakdown: replay.score.capabilityBreakdown,
          survAdjustment: replay.score.scoreDisplay?.survAdjustment,
          gapDock: replay.score.scoreDisplay?.gapDock,
          stackMismatch: replay.rules.stackMismatch,
          coreLanguageGap: replay.rules.coreLanguageGap,
          specDock: replay.rules.specializationGap?.dock ?? 0,
          lane: replay.rules.roleLane,
          titleResponsibilityMismatch: replay.rules.titleResponsibilityMismatch,
          earlyCareerFriendly: replay.rules.earlyCareerFriendlyRole,
          disjunctiveSatisfied: replay.rules.disjunctiveLanguageRequirementSatisfied,
          disjunctiveAccepted: replay.rules.disjunctiveAcceptedLanguages,
          pythonFlexible: replay.rules.pythonStackFlexibleWithJsTs,
        }
      : null,
    deltas: replay
      ? {
          total: (replay.score.total ?? 0) - (picked.stored.total ?? 0),
          capability: (replay.score.capability ?? 0) - (picked.stored.capability ?? 0),
          stackFit: (replay.score.stackFit ?? 0) - (picked.stored.stackFit ?? 0),
          levelFit: (replay.score.levelFit ?? 0) - (picked.stored.levelFit ?? 0),
          functionalOverlap:
            (replay.score.functionalOverlap ?? 0) - (picked.stored.functionalOverlap ?? 0),
          recruiterFriendliness:
            (replay.score.recruiterFriendliness ?? 0) - (picked.stored.recruiterFriendliness ?? 0),
          survAdjustment:
            (replay.score.scoreDisplay?.survAdjustment ?? 0) - (picked.stored.survAdjustment ?? 0),
          gapDock: (replay.score.scoreDisplay?.gapDock ?? 0) - (picked.stored.gapDock ?? 0),
        }
      : null,
    languageClasses: extracted
      ? Object.fromEntries(
          langs.map((language) => [
            language,
            {
              sourceClass: classifyLanguageRequirementSource(extracted, language),
              exclusivePython:
                language === "Python" ? pythonIsExclusiveCoreRequirement(extracted) : undefined,
              mixedInventory:
                language === "Python" ? pythonOnMixedStackInventory(extracted) : undefined,
              disjunctiveOnly: languageOnlyInDisjunctiveChoice(extracted, language),
              illustrativeOnly: languageIsIllustrativeExampleOnly(extracted, language),
            },
          ]),
        )
      : null,
    titleResponsibilityNow: titleEval
      ? {
          mismatch: titleEval.mismatch,
          titleBand: titleEval.titleBand,
          responsibilityBand: titleEval.responsibilityBand,
          statedEarlyCareer: titleEval.statedEarlyCareer,
          highAutonomy: titleEval.highAutonomy,
          hasManagedTeamStructure: titleEval.hasManagedTeamStructure,
          highOwnershipLowSupport: titleEval.highOwnershipLowSupport,
        }
      : null,
    stackPenaltyStored: buildStackPenaltyAudit({
      extracted,
      rules: evaluation.fit?.detail?.rules,
      score: evaluation.fit?.detail?.score,
      gapDock: evaluation.fit?.breakdown?.gapDock ?? evaluation.fit?.detail?.score.scoreDisplay?.gapDock,
    }),
    stackPenaltyReplay: replay
      ? buildStackPenaltyAudit({
          extracted,
          rules: replay.rules,
          score: replay.score,
          gapDock: replay.score.scoreDisplay?.gapDock,
        })
      : null,
  };
};

const roleTokens = (role: string): string[] =>
  role
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);

const hypotheticalKey = (company: string, title: string | null): string => {
  const companyKey = company.trim().toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  return `${companyKey}::${title ? roleTokens(title).join(" ") : ""}`;
};

const main = async () => {
  const client = new MongoClient(env.mongoUri, { ignoreUndefined: true });
  try {
    await client.connect();
    const db = client.db(env.mongoDbName);
    const evaluations = db.collection<ApplicationEvaluation>("application_evaluations");
    const applications = db.collection<GmailApplication>("gmail_applications");
    const revisions = db.collection<ScoreRevision>("score_revisions");
    const resumeContexts = await resumeContextService.getAvailableContexts();

    const focus = [];
    for (const key of FOCUS_KEYS) {
      const evaluation = await evaluations.findOne({ key });
      if (!evaluation) {
        focus.push({ key, missing: true });
        continue;
      }
      focus.push(replayBridge(evaluation, resumeContexts));
    }

    const roLive = await evaluations.findOne({
      "recovery.status": "scored",
      company: { $regex: "^Ro$", $options: "i" },
    });
    let roReport = null;
    if (roLive) {
      const bridge = replayBridge(roLive, resumeContexts);
      const dummyApp = {
        key: roLive.key,
        company: roLive.company,
        role: roLive.role,
        appliedAt: roLive.appliedAt,
        appliedAtKnown: true,
        appliedAtSource: "email",
        status: "applied",
        furthestStage: "applied",
        interviewRounds: [],
        activelyInterviewing: false,
        lastUpdateAt: roLive.updatedAt,
        emails: [],
      } as GmailApplication;
      const packet = buildScoringAuditContext({
        app: dummyApp,
        evaluation: roLive,
        profile: userProfile,
        resumeContexts,
      });
      roReport = {
        key: roLive.key,
        company: roLive.company,
        role: roLive.role,
        bridge,
        auditStackPenalty: packet.scoring.stackPenalty,
        auditTotal: packet.scoring.total,
        auditImpliesClamp: packet.scoring.stackPenalty?.stackMismatchClampApplied === true,
        replayImpliesClamp: bridge.stackPenaltyReplay?.stackMismatchClampApplied === true,
      };
    }

    const roFixture = loadCalibrationFixture("roAiEngineer");
    const roFixtureScored = scoreCalibrationAnchor("roAiEngineer");
    const roFixturePenalty = buildStackPenaltyAudit({
      extracted: roFixture.extracted,
      rules: roFixtureScored.rules,
      score: roFixtureScored.score,
      gapDock: roFixtureScored.score.scoreDisplay?.gapDock,
    });

    const scoredEvals = await evaluations
      .find({ "recovery.status": "scored" })
      .project({
        key: 1,
        company: 1,
        role: 1,
        jd: 1,
        fit: 1,
      })
      .toArray();
    const apps = await applications
      .find({})
      .project({ key: 1, company: 1, role: 1, status: 1, trackerStatus: 1, emails: 1 })
      .toArray();
    const appByKey = new Map(apps.map((app) => [app.key, app]));
    const allRevisions = await revisions
      .find({})
      .project({
        revisionId: 1,
        applicationKey: 1,
        status: 1,
        correctionType: 1,
        original: 1,
        corrected: 1,
      })
      .toArray();
    const revisionsByKey = new Map<string, typeof allRevisions>();
    for (const revision of allRevisions) {
      const list = revisionsByKey.get(revision.applicationKey) ?? [];
      list.push(revision);
      revisionsByKey.set(revision.applicationKey, list);
    }

    const known = [];
    for (const needle of METADATA_NEEDLES) {
      const matches = scoredEvals.filter((evaluation) =>
        new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i").test(
          `${evaluation.company} ${evaluation.role ?? ""} ${evaluation.jd?.company ?? ""} ${evaluation.jd?.title ?? ""} ${evaluation.fit?.detail?.extracted.company ?? ""} ${evaluation.fit?.detail?.extracted.title ?? ""}`,
        ),
      );
      for (const evaluation of matches) {
        const raw = evaluation.jd?.text ?? evaluation.fit?.detail?.extracted.rawText ?? "";
        const meta = raw ? extractJobPostingMetadata(raw) : null;
        const storedCompany =
          evaluation.company ||
          evaluation.jd?.company ||
          evaluation.fit?.detail?.extracted.company ||
          "";
        const storedTitle =
          evaluation.role ||
          evaluation.jd?.title ||
          evaluation.fit?.detail?.extracted.title ||
          null;
        const correctedCompany = meta?.companyName;
        const correctedTitle = meta?.jobTitle;
        const currentKey = evaluation.key;
        const nextKey =
          correctedCompany && isValidCompanyCandidate(correctedCompany)
            ? hypotheticalKey(correctedCompany, correctedTitle)
            : null;
        const app = appByKey.get(evaluation.key);
        known.push({
          needle,
          storedCompany,
          storedTitle,
          jdCompany: evaluation.jd?.company,
          jdTitle: evaluation.jd?.title,
          extractedCompany: evaluation.fit?.detail?.extracted.company,
          extractedTitle: evaluation.fit?.detail?.extracted.title,
          correctedCompany,
          correctedTitle,
          weakTitle: isWeakJobTitle(storedTitle),
          currentKey,
          correctedKey: nextKey,
          keyWouldDiffer: Boolean(nextKey && nextKey !== currentKey),
          gmailGroupKey: app?.key ?? null,
          gmailCompany: app?.company ?? null,
          gmailRole: app?.role ?? null,
          emailCount: app?.emails?.length ?? 0,
          trackerStatus: app?.trackerStatus ?? null,
          revisions: (revisionsByKey.get(evaluation.key) ?? []).map((revision) => ({
            revisionId: revision.revisionId,
            status: revision.status,
            correctionType: revision.correctionType,
          })),
        });
      }
    }

    const malformed = [];
    for (const evaluation of scoredEvals) {
      const storedCompany = evaluation.company ?? evaluation.jd?.company ?? "";
      const storedTitle = evaluation.role ?? evaluation.jd?.title ?? "";
      const raw = evaluation.jd?.text ?? "";
      if (!raw) continue;
      const meta = extractJobPostingMetadata(raw);
      const companyBad =
        !isValidCompanyCandidate(storedCompany) ||
        (meta.companyName &&
          storedCompany &&
          meta.companyName.toLowerCase() !== storedCompany.toLowerCase() &&
          !isValidCompanyCandidate(storedCompany));
      const titleBad = isWeakJobTitle(storedTitle);
      if (!companyBad && !titleBad) continue;
      malformed.push({
        key: evaluation.key,
        storedCompany,
        storedTitle,
        correctedCompany: meta.companyName,
        correctedTitle: meta.jobTitle,
        companyBad,
        titleBad,
      });
    }

    process.stdout.write(
      `${JSON.stringify(
        {
          readOnly: true,
          paidLlm: false,
          historicalImmutable: true,
          focus,
          roLive: roReport,
          roFixture: {
            stackPenalty: roFixturePenalty,
            replayTotal: roFixtureScored.score.total,
            replayStackFit: roFixtureScored.score.stackFit,
            llmStackFit: roFixture.storedCategoryScores.stackFit,
            mismatch: roFixtureScored.rules.stackMismatch,
            specDock: roFixtureScored.rules.specializationGap?.dock ?? 0,
            clampApplied: roFixturePenalty.stackMismatchClampApplied,
          },
          knownMetadata: known,
          otherMalformed: malformed.slice(0, 40),
          otherMalformedCount: malformed.length,
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
