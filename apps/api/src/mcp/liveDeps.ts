import { userProfile } from "../config/userProfile.js";
import { getGmailApplications } from "../services/gmail/gmailApplications.js";
import { evaluationsRepository } from "../services/gmail/jdRecovery/evaluations.repository.js";
import { submitJdCandidate } from "../services/gmail/jdRecovery/jdCandidates.service.js";
import { saveJobProspect } from "../services/gmail/jdRecovery/jobProspects.service.js";
import { insightsRepository } from "../services/insights/insights.repository.js";
import { resumeContextService } from "../services/resume/resumeContext.js";
import { proposeClaudeScoringCorrection } from "../services/scoring/claudeScoringProposal.js";
import { loadApprovedOverlays } from "../services/scoring/scoreRevisions.service.js";
import { MCP_MAX_DAYS, type McpDeps } from "./catalog.js";

/** Production wiring: the same local Mongo collections the API already reads. */
export const createLiveDeps = (): McpDeps => ({
  getApplications: getGmailApplications,
  getEvaluationsByKeys: (keys) => evaluationsRepository.findByKeys(keys),
  getActiveScoreRevisions: loadApprovedOverlays,
  getLatestInsightsRun: () => insightsRepository.latestRun(),
  getUserProfile: () => userProfile,
  getResumeContexts: () => resumeContextService.getAvailableContexts(),
  saveJobProspect,
  submitJdCandidate: (input) =>
    submitJdCandidate(input, {
      getApplications: getGmailApplications,
      findByKey: (key) => evaluationsRepository.findByKey(key),
      upsertIfUnscored: (evaluation) => evaluationsRepository.upsertIfUnscored(evaluation),
    }, MCP_MAX_DAYS),
  proposeScoringCorrection: proposeClaudeScoringCorrection,
});
