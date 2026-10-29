import { getGmailApplications } from "../services/gmail/gmailApplications.js";
import { evaluationsRepository } from "../services/gmail/jdRecovery/evaluations.repository.js";
import { submitJdCandidate } from "../services/gmail/jdRecovery/jdCandidates.service.js";
import { saveJobProspect } from "../services/gmail/jdRecovery/jobProspects.service.js";
import { insightsRepository } from "../services/insights/insights.repository.js";
import { MCP_MAX_DAYS, type McpDeps } from "./catalog.js";

/** Production wiring: the same local Mongo collections the API already reads. */
export const createLiveDeps = (): McpDeps => ({
  getApplications: getGmailApplications,
  getEvaluationsByKeys: (keys) => evaluationsRepository.findByKeys(keys),
  getLatestInsightsRun: () => insightsRepository.latestRun(),
  saveJobProspect,
  submitJdCandidate: (input) =>
    submitJdCandidate(input, {
      getApplications: getGmailApplications,
      findByKey: (key) => evaluationsRepository.findByKey(key),
      upsertIfUnscored: (evaluation) => evaluationsRepository.upsertIfUnscored(evaluation),
    }, MCP_MAX_DAYS),
});
