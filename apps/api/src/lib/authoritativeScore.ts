import { SURVIVABILITY_TUNING } from "../config/capabilitySurvivabilityPolicy.js";
import type { ApprovedRevisionOverlay } from "../services/scoring/scoreRevision.types.js";
import type { Recommendation, ScoreBreakdown, ScoreDisplay } from "../types/scoring.js";
import { recommendationForScore } from "./compositeScoring.js";
import { evaluationFingerprint } from "./evaluationFingerprint.js";
import type { ApplicationEvaluation } from "../services/gmail/jdRecovery/evaluations.repository.js";

const TOTAL_EPS = 0.51;

export const totalsAgree = (a: number | undefined, b: number | undefined): boolean => {
  if (a == null || b == null || !Number.isFinite(a) || !Number.isFinite(b)) return false;
  return Math.abs(a - b) < TOTAL_EPS;
};

const finiteTotal = (n: unknown): number | undefined =>
  typeof n === "number" && Number.isFinite(n) ? n : undefined;

export type StoredFitScoreFields = {
  total?: number;
  recommendation?: string;
  detail?: {
    recommendation?: string;
    score?: {
      total?: number;
      capability?: number;
      scoreDisplay?: {
        final?: number;
        scoreDerivation?: string;
        scoreBand?: string;
        hardGates?: string[];
      };
    };
  };
};

export type AuthoritativeScoreSource =
  | "aligned"
  | "composite_display"
  | "composite_score_total"
  | "fit_total_only"
  | "approved_revision"
  | "unresolved";

export type AuthoritativeScoreResolution = {
  total: number | null;
  recommendation: Recommendation | null;
  source: AuthoritativeScoreSource;
  conflict: boolean;
  storedFitTotal?: number;
  storedDetailTotal?: number;
  storedDisplayFinal?: number;
  storedRecommendation?: string;
  note?: string;
};

const recFromTotal = (total: number, hardGate: boolean): Recommendation =>
  recommendationForScore(total, hardGate);

const hasHardGate = (fit: StoredFitScoreFields): boolean => {
  const gates = fit.detail?.score?.scoreDisplay?.hardGates ?? [];
  if (gates.length > 0) return true;
  const t = finiteTotal(fit.detail?.score?.total) ?? finiteTotal(fit.total);
  return t === SURVIVABILITY_TUNING.hardGateScoreFloor;
};

/**
 * Read-only: pick one display total from a stored evaluation without writing.
 * Prefers the post-cap composite (scoreDisplay.final / detail.score.total) when
 * those fields agree. Does not invent a number when evidence conflicts.
 */
export const resolveStoredFitScore = (
  fit: StoredFitScoreFields | null | undefined,
): AuthoritativeScoreResolution => {
  if (!fit) {
    return { total: null, recommendation: null, source: "unresolved", conflict: false };
  }

  const storedFitTotal = finiteTotal(fit.total);
  const storedDetailTotal = finiteTotal(fit.detail?.score?.total);
  const storedDisplayFinal = finiteTotal(fit.detail?.score?.scoreDisplay?.final);
  const storedRecommendation = fit.recommendation ?? fit.detail?.recommendation;
  const hardGate = hasHardGate(fit);
  const capabilityPresent = typeof fit.detail?.score?.capability === "number";
  const displayPresent = storedDisplayFinal != null;

  const present = [storedFitTotal, storedDetailTotal, storedDisplayFinal].filter(
    (n): n is number => n != null,
  );

  if (present.length === 0) {
    return {
      total: null,
      recommendation: null,
      source: "unresolved",
      conflict: false,
      storedRecommendation,
      note: "No persisted total on fit, detail.score, or scoreDisplay.",
    };
  }

  const allAgree = present.every((n) => totalsAgree(n, present[0]));
  if (allAgree) {
    const total = present[0]!;
    return {
      total,
      recommendation: recFromTotal(total, hardGate),
      source: "aligned",
      conflict: false,
      storedFitTotal,
      storedDetailTotal,
      storedDisplayFinal,
      storedRecommendation,
    };
  }

  if (displayPresent && (storedDetailTotal == null || totalsAgree(storedDisplayFinal, storedDetailTotal))) {
    return {
      total: storedDisplayFinal!,
      recommendation: recFromTotal(storedDisplayFinal!, hardGate),
      source: "composite_display",
      conflict: true,
      storedFitTotal,
      storedDetailTotal,
      storedDisplayFinal,
      storedRecommendation,
      note: "fit.total disagrees with the stored composite (scoreDisplay.final).",
    };
  }

  if (capabilityPresent && storedDetailTotal != null && storedDisplayFinal == null) {
    return {
      total: storedDetailTotal,
      recommendation: recFromTotal(storedDetailTotal, hardGate),
      source: "composite_score_total",
      conflict: storedFitTotal != null && !totalsAgree(storedFitTotal, storedDetailTotal),
      storedFitTotal,
      storedDetailTotal,
      storedDisplayFinal,
      storedRecommendation,
      note:
        storedFitTotal != null && !totalsAgree(storedFitTotal, storedDetailTotal)
          ? "fit.total disagrees with detail.score.total; using composite total (capability present)."
          : undefined,
    };
  }

  if (storedFitTotal != null && storedDetailTotal == null && storedDisplayFinal == null) {
    return {
      total: storedFitTotal,
      recommendation: recFromTotal(storedFitTotal, hardGate),
      source: "fit_total_only",
      conflict: false,
      storedFitTotal,
      storedRecommendation,
    };
  }

  return {
    total: null,
    recommendation: null,
    source: "unresolved",
    conflict: true,
    storedFitTotal,
    storedDetailTotal,
    storedDisplayFinal,
    storedRecommendation,
    note: "Persisted totals disagree and there is not enough composite evidence to pick one.",
  };
};

export type PresentedFitFields = {
  total: number;
  recommendation: string;
  storedFitTotal?: number;
  scoreConflict?: boolean;
  authoritativeSource?: AuthoritativeScoreSource;
  revisionId?: string;
  scoreRevised?: boolean;
  originalAuthoritativeTotal?: number;
  fingerprintStale?: boolean;
  staleRevisionTotal?: number;
};

const overlayFitForDisplay = <T extends StoredFitScoreFields>(fit: T): T & PresentedFitFields => {
  const resolved = resolveStoredFitScore(fit);
  if (resolved.source === "unresolved") {
    return {
      ...fit,
      total: fit.total as number,
      recommendation: fit.recommendation ?? "weak",
      storedFitTotal: fit.total,
      scoreConflict: resolved.conflict,
      authoritativeSource: resolved.source,
    };
  }
  if (!resolved.conflict) {
    return {
      ...fit,
      total: resolved.total!,
      recommendation: resolved.recommendation ?? fit.recommendation ?? "weak",
      authoritativeSource: resolved.source,
    };
  }
  return {
    ...fit,
    total: resolved.total!,
    recommendation: resolved.recommendation ?? fit.recommendation ?? "weak",
    storedFitTotal: fit.total,
    scoreConflict: true,
    authoritativeSource: resolved.source,
  };
};

export type PresentFitOptions = {
  revision?: ApprovedRevisionOverlay | null;
  /** Required to apply an approved revision; without it the overlay is used. */
  evaluation?: Pick<ApplicationEvaluation, "fit" | "jd" | "key"> | null;
};

/**
 * Effective displayed score, in order:
 * 1. Current approved revision whose fingerprint still matches.
 * 2. Authoritative composite display overlay.
 * 3. Legacy stored fit.total when no better source exists.
 */
export const presentFitForDisplay = <T extends StoredFitScoreFields>(
  fit: T,
  options?: PresentFitOptions,
): T & PresentedFitFields => {
  const overlay = overlayFitForDisplay(fit);
  const revision = options?.revision;
  if (!revision || revision.status !== "approved") return overlay;

  const stale = {
    fingerprintStale: true as const,
    revisionId: revision.revisionId,
    staleRevisionTotal: revision.correctedTotal,
  };
  const evaluation = options?.evaluation;
  if (!evaluation?.fit) {
    return { ...overlay, ...stale };
  }
  const currentFingerprint = evaluationFingerprint(evaluation as ApplicationEvaluation);
  if (currentFingerprint !== revision.evaluationFingerprint) {
    return { ...overlay, ...stale };
  }

  return {
    ...fit,
    total: revision.correctedTotal,
    recommendation: revision.correctedRecommendation,
    storedFitTotal: overlay.storedFitTotal ?? fit.total,
    originalAuthoritativeTotal: overlay.total,
    scoreConflict: true,
    scoreRevised: true,
    revisionId: revision.revisionId,
    authoritativeSource: "approved_revision",
  };
};

/** Compact provenance fields for list/MCP payloads. */
export const effectiveScoreProvenance = (presented: PresentedFitFields): Partial<PresentedFitFields> => {
  const stale = presented.fingerprintStale
    ? {
        fingerprintStale: true as const,
        revisionId: presented.revisionId,
        staleRevisionTotal: presented.staleRevisionTotal,
      }
    : {};
  if (presented.authoritativeSource === "approved_revision") {
    return {
      storedFitTotal: presented.storedFitTotal,
      originalAuthoritativeTotal: presented.originalAuthoritativeTotal,
      scoreConflict: true,
      scoreRevised: true,
      revisionId: presented.revisionId,
      authoritativeSource: presented.authoritativeSource,
    };
  }
  if (presented.scoreConflict || presented.authoritativeSource === "unresolved") {
    return {
      storedFitTotal: presented.storedFitTotal,
      scoreConflict: presented.scoreConflict,
      authoritativeSource: presented.authoritativeSource,
      ...stale,
    };
  }
  return stale;
};

/**
 * After composite + scoreDisplay, the persisted total and recommendation are
 * the post-cap, post-gate display final — never a separate category sum.
 */
export const sealAuthoritativeScore = (params: {
  score: ScoreBreakdown;
  recommendation: Recommendation;
}): { score: ScoreBreakdown; recommendation: Recommendation } => {
  const display: ScoreDisplay | undefined = params.score.scoreDisplay;
  if (!display || !Number.isFinite(display.final)) {
    return {
      score: params.score,
      recommendation: recommendationForScore(params.score.total, false),
    };
  }
  const hardGate = (display.hardGates?.length ?? 0) > 0;
  const recommendation = display.scoreBand ?? recommendationForScore(display.final, hardGate);
  return {
    score: {
      ...params.score,
      total: display.final,
      recommendationLabel: display.bandHeadline,
    },
    recommendation,
  };
};
