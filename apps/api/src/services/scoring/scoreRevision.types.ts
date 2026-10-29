import type { Recommendation } from "../../types/scoring.js";

export const SCORING_REVISION_VERSION = "score-revision-v1";

export const SCORE_REVISION_METHODS = [
  "deterministic_replay",
  "human_correction",
  "claude_audit_proposal",
] as const;
export type ScoreRevisionMethod = (typeof SCORE_REVISION_METHODS)[number];

export const SCORE_REVISION_STATUSES = ["proposed", "approved", "rolled_back"] as const;
export type ScoreRevisionStatus = (typeof SCORE_REVISION_STATUSES)[number];

export const SCORE_REVISION_INPUTS = [
  "yearsExperience",
  "seniority",
  "stackMismatch",
  "roleLane",
  "seniorityOverreach",
] as const;
export type ScoreRevisionInputId = (typeof SCORE_REVISION_INPUTS)[number];

export type ScoreRevisionSnapshot = {
  total: number;
  recommendation: Recommendation;
  capability?: number;
  derivation?: string;
  hardGates: string[];
  categories?: {
    stackFit?: number;
    levelFit?: number;
    domainFit?: number;
    resumeStoryClarity?: number;
    functionalOverlap?: number;
    recruiterFriendliness?: number;
    careerValue?: number;
  };
  yearsExperience?: { raw?: string; min?: number; max?: number };
  seniority?: string;
  roleLane?: string;
  stackMismatch?: boolean;
  coreLanguageGap?: string[];
  seniorityOverreach?: boolean;
};

export type ScoreRevisionInputChange = {
  id: ScoreRevisionInputId;
  from: unknown;
  to: unknown;
};

export const SCORE_CORRECTION_TYPES = [
  "years_experience_minimum",
  "inferred_seniority",
  "stack_language_classification",
  "role_lane",
] as const;
export type ScoreCorrectionType = (typeof SCORE_CORRECTION_TYPES)[number];

export const SCORE_REVISION_CONFIDENCE = ["high", "medium", "low"] as const;
export type ScoreRevisionConfidence = (typeof SCORE_REVISION_CONFIDENCE)[number];

export type ScoreRevisionProvenance = {
  actor: "user" | "claude";
  via: "api" | "dashboard" | "mcp";
  at: string;
  note?: string;
};

export type ScoreRevision = {
  revisionId: string;
  applicationKey: string;
  evaluationFingerprint: string;
  scoringVersion: string;
  pipelineVersionLabel: string;
  method: ScoreRevisionMethod;
  status: ScoreRevisionStatus;
  inputsChanged: ScoreRevisionInputId[];
  inputChanges: ScoreRevisionInputChange[];
  evidence: string[];
  explanation: string;
  recommendationTierChanged: boolean;
  original: ScoreRevisionSnapshot;
  corrected: ScoreRevisionSnapshot;
  createdAt: string;
  createdBy: ScoreRevisionProvenance;
  approvedAt?: string;
  approvedBy?: ScoreRevisionProvenance;
  rolledBackAt?: string;
  rolledBackBy?: ScoreRevisionProvenance;
  /** Claude-proposed allowlisted correction; omitted on dashboard deterministic replays. */
  correctionType?: ScoreCorrectionType;
  confidence?: ScoreRevisionConfidence;
  uncertainty?: string;
  /** Set after approval re-runs deterministic replay and confirms the stored totals. */
  independentlyVerifiedAt?: string;
  /** Set only while status is approved — sparse unique index enforces one active revision. */
  activeApplicationKey?: string;
};

export type ApprovedRevisionOverlay = {
  revisionId: string;
  applicationKey: string;
  evaluationFingerprint: string;
  status: "approved";
  correctedTotal: number;
  correctedRecommendation: Recommendation;
  originalTotal: number;
  originalRecommendation: string;
};
