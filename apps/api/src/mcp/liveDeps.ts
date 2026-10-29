import { getGmailApplications } from "../services/gmail/gmailApplications.js";
import { evaluationsRepository } from "../services/gmail/jdRecovery/evaluations.repository.js";
import { saveJobProspect } from "../services/gmail/jdRecovery/jobProspects.service.js";
import { insightsRepository } from "../services/insights/insights.repository.js";
import type { McpDeps } from "./catalog.js";

/** Production wiring: the same local Mongo collections the API already reads. */
export const createLiveDeps = (): McpDeps => ({
  getApplications: getGmailApplications,
  getEvaluationsByKeys: (keys) => evaluationsRepository.findByKeys(keys),
  getLatestInsightsRun: () => insightsRepository.latestRun(),
  saveJobProspect,
});
