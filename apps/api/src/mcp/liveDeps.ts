import { userProfile } from "../config/userProfile.js";
import { APPLICATION_IDENTITY_LOOKBACK_DAYS, getGmailApplications } from "../services/gmail/gmailApplications.js";
import { classifyPostingKind } from "../services/gmail/jdRecovery/applicationPostingKind.js";
import { evaluationsRepository } from "../services/gmail/jdRecovery/evaluations.repository.js";
import { submitJdCandidate } from "../services/gmail/jdRecovery/jdCandidates.service.js";
import { createLiveJdRecoveryQueueService } from "../services/gmail/jdRecovery/jdRecoveryQueue.service.js";
import { saveJobProspect } from "../services/gmail/jdRecovery/jobProspects.service.js";
import { insightsRepository } from "../services/insights/insights.repository.js";
import { resumeContextService } from "../services/resume/resumeContext.js";
import { proposeClaudeScoringCorrection } from "../services/scoring/claudeScoringProposal.js";
import { loadApprovedOverlays } from "../services/scoring/scoreRevisions.service.js";
import {
  createLiveLinkProspectDeps,
  createLiveProspectApplicationDeps,
  linkProspectToApplication,
  listUnconfirmedProspects,
  markProspectApplied,
  ProspectApplicationError,
} from "../services/gmail/jdRecovery/prospectApplication.service.js";
import { repairReceiptScores } from "../services/gmail/jdRecovery/applicationReceipt.js";
import { PROSPECT_MATCH_LOOKBACK_DAYS } from "../services/gmail/jdRecovery/prospectMatch.js";
import { MCP_MAX_DAYS, McpToolError, type McpDeps } from "./catalog.js";

const asToolError = (error: unknown): never => {
  if (error instanceof ProspectApplicationError) {
    const options = error.options?.length ? ` Options: ${JSON.stringify(error.options)}` : "";
    throw new McpToolError(error.code, `${error.message}${options}`);
  }
  throw error;
};

/** Production wiring: the same local Mongo collections the API already reads. */
export const createLiveDeps = (): McpDeps => {
  const queue = createLiveJdRecoveryQueueService({
    getApplications: getGmailApplications,
    getEvaluationsByKeys: (keys) => evaluationsRepository.findByKeys(keys),
  });
  return {
    getApplications: getGmailApplications,
    getEvaluationsByKeys: (keys) => evaluationsRepository.findByKeys(keys),
    getActiveScoreRevisions: loadApprovedOverlays,
    getLatestInsightsRun: () => insightsRepository.latestRun(),
    getUserProfile: () => userProfile,
    getResumeContexts: () => resumeContextService.getAvailableContexts(),
    saveJobProspect,
    markProspectApplied: (input) =>
      markProspectApplied(input, createLiveProspectApplicationDeps()).catch(asToolError),
    linkProspectToApplication: (input) =>
      linkProspectToApplication(input, createLiveLinkProspectDeps()).catch(asToolError),
    repairReceiptScores: (input) =>
      repairReceiptScores(input, {
        listScoredSince: (since) => evaluationsRepository.listSince(since),
        invalidateScore: (key, reason) => evaluationsRepository.invalidateScore(key, reason),
        restartRecovery: async () => {
          const { startRecoveryRun } = await import("../services/gmail/jdRecovery/runRecovery.js");
          return startRecoveryRun(PROSPECT_MATCH_LOOKBACK_DAYS);
        },
      }),
    listUnconfirmedProspects: (input) =>
      listUnconfirmedProspects(input, createLiveProspectApplicationDeps()).catch(asToolError),
    submitJdCandidate: (input) =>
      submitJdCandidate(input, {
        getApplications: getGmailApplications,
        findByKey: (key) => evaluationsRepository.findByKey(key),
        upsertIfUnscored: (evaluation) => evaluationsRepository.upsertIfUnscored(evaluation),
      }, MCP_MAX_DAYS),
    proposeScoringCorrection: proposeClaudeScoringCorrection,
    claimJdRecoveryBatch: queue.claim,
    recordJdRecoveryOutcome: queue.record,
    getJdRecoveryProgress: queue.progress,
    syncJdRecoveryQueueAfterCandidate: queue.syncAfterCandidateSubmitted,
    classifyApplicationPostingKind: async (input) => {
      const { evaluation, result } = await classifyPostingKind(input, {
        getApplications: getGmailApplications,
        findByKey: (key) => evaluationsRepository.findByKey(key),
        upsertIfUnscored: (row) => evaluationsRepository.upsertIfUnscored(row),
        identityLookbackDays: APPLICATION_IDENTITY_LOOKBACK_DAYS,
      });
      await queue.syncAfterPostingKindChange(evaluation);
      return result;
    },
  };
};
