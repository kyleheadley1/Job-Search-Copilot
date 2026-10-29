import { createHash } from "node:crypto";
import type { ApplicationEvaluation } from "../services/gmail/jdRecovery/evaluations.repository.js";

/** Canonical hash of the score-relevant stored evaluation. Approval fails if this drifts. */
export const evaluationFingerprint = (evaluation: ApplicationEvaluation): string => {
  const fit = evaluation.fit;
  const score = fit?.detail?.score;
  const extracted = fit?.detail?.extracted;
  const rules = fit?.detail?.rules;
  const payload = JSON.stringify({
    total: fit?.total ?? null,
    recommendation: fit?.recommendation ?? null,
    detailTotal: score?.total ?? null,
    displayFinal: score?.scoreDisplay?.final ?? null,
    promptVersion: fit?.promptVersion ?? null,
    recommendedResume: fit?.recommendedResume ?? null,
    llmCategories: score?.llmCategories ?? null,
    years: extracted?.yearsExperience ?? null,
    seniority: extracted?.seniority ?? null,
    roleLane: rules?.roleLane ?? null,
    stackMismatch: rules?.stackMismatch ?? null,
    coreLanguageGap: rules?.coreLanguageGap ?? null,
    seniorityOverreach: rules?.seniorityOverreach ?? null,
    jdTextHash: evaluation.jd?.textHash ?? null,
  });
  return createHash("sha256").update(payload, "utf8").digest("hex");
};
