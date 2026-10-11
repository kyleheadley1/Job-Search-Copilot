import type { RuleEvaluation, SurvivabilityLever } from "../types/scoring.js";
import type { UserProfile } from "../types/userProfile.js";

export type DegreeGapTier = "none" | "soft" | "conflicting" | "medium" | "high";

export const DEGREE_DOCK_BY_TIER: Record<DegreeGapTier, number> = {
  none: 0,
  soft: 3,
  conflicting: 8,
  medium: 10,
  high: 14,
};

export const NONE_IN_LOOP_LEVER_LABEL = "NONE in-loop — external route only";
export const STRUCTURAL_LEVER_LABEL = "NONE — structural, can't fix";

/** Single source for degree-gap tier — gates dock and lever display. */
export const resolveDegreeGapTier = (
  rules: RuleEvaluation,
  profile: UserProfile,
): DegreeGapTier => {
  if (profile.degreeStatus.hasBachelors) return "none";
  if (rules.degreeEquivalencySatisfied) return "none";

  if (rules.degreeHasEquivalencyClause && !rules.explicitDegreeRisk) {
    return rules.degreeConflictingRequirement ? "conflicting" : "soft";
  }

  if (!rules.explicitDegreeRisk) return "none";

  if (rules.matureStructuredEmployer) return "high";
  return "medium";
};

export const computeDegreeGapDock = (
  rules: RuleEvaluation,
  profile: UserProfile,
): number => DEGREE_DOCK_BY_TIER[resolveDegreeGapTier(rules, profile)];

export type DegreeGapLeverPair = {
  lever: SurvivabilityLever;
  leverLabel: string;
};

/** Shared lever for credential-signal row and degree-gate penalty rows. */
export const resolveDegreeGapLever = (
  rules: RuleEvaluation,
  profile: UserProfile,
): DegreeGapLeverPair | null => {
  const tier = resolveDegreeGapTier(rules, profile);
  if (tier === "soft" || tier === "conflicting") {
    return {
      lever: "resume",
      leverLabel: "tailor resume to emphasize related experience",
    };
  }
  if (tier === "medium" || tier === "high") {
    return {
      lever: "none_in_loop",
      leverLabel: NONE_IN_LOOP_LEVER_LABEL,
    };
  }
  return null;
};

export const isCredentialDegreeGap = (
  rules: RuleEvaluation,
  profile: UserProfile,
): boolean => resolveDegreeGapTier(rules, profile) !== "none";
