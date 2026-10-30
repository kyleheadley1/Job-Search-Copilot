import type { JdMatchEvidenceSnapshot } from "./jdMatchEvidence.js";
import type { ShadowAssessment } from "./jdShadowEligibility.js";

export const JD_REVIEW_ACTIONS = [
  "confirmed",
  "rejected",
  "removed",
  "restored",
  "selected_other",
  "corrected_identity",
  "corrected_source",
  "pasted",
] as const;

export type JdReviewAction = (typeof JD_REVIEW_ACTIONS)[number];

export type JdReviewEvaluationFingerprint = {
  recoveryStatus: string;
  fitTotal?: number;
  jdTextHash?: string;
  scoredAt?: string;
};

export type JdReviewDecision = {
  decisionId: string;
  applicationKey: string;
  candidateId: string;
  decidedAt: string;
  action: JdReviewAction;
  proposedCandidateId?: string;
  evidenceSnapshot: JdMatchEvidenceSnapshot;
  shadowAtDecision: ShadowAssessment;
  currentCompleteness?: "full" | "partial";
  evaluationFingerprint?: JdReviewEvaluationFingerprint;
  note?: string;
};

export type JdShadowReport = {
  shadowMode: true;
  autoConfirmEnabled: false;
  reviewed: number;
  shadowEligible: number;
  eligibleConfirmed: number;
  eligibleRejectedOrCorrected: number;
  falsePositives: number;
  falseNegatives: number;
  disagreementReasons: Array<{ reason: string; count: number }>;
  limitation: string;
};
