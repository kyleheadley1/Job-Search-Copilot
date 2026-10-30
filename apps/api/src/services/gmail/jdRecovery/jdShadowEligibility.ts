import type { GeoCompatibilityAssessment } from "./jdGeoCompatibility.js";
import type { EvidenceSignal, JdMatchEvidenceSnapshot } from "./jdMatchEvidence.js";
import type { RecoveryCandidate } from "./evaluations.repository.js";

export const SHADOW_RECOMMENDATIONS = [
  "eligible_for_auto_confirmation",
  "manual_review",
  "reject_mismatch",
] as const;

export type ShadowRecommendation = (typeof SHADOW_RECOMMENDATIONS)[number];

export type ShadowAssessment = {
  recommendation: ShadowRecommendation;
  blockers: string[];
  positives: string[];
  unknowns: string[];
  autoConfirmEnabled: false;
  notes: string[];
};

const isPositive = (signal: EvidenceSignal): boolean =>
  signal.verdict === "match" && (signal.provenance === "verified_source" || signal.provenance === "deterministic");

const parseTitleSimilarity = (signal: EvidenceSignal): number => {
  const raw = signal.note?.match(/strict_title:(\d+\.\d+)/)?.[1];
  return raw ? Number(raw) : 0;
};

const titleIsExact = (signal: EvidenceSignal): boolean => isPositive(signal) && parseTitleSimilarity(signal) >= 0.9;

export type ShadowContext = {
  reviewStatus?: RecoveryCandidate["reviewStatus"];
  geo?: GeoCompatibilityAssessment;
};

/**
 * Conservative, explainable shadow recommendation.
 * Claude confidence is ignored. Unknown signals are never treated as positive evidence.
 */
export const assessShadowEligibility = (snapshot: JdMatchEvidenceSnapshot, context: ShadowContext = {}): ShadowAssessment => {
  const { signals, candidate, claude } = snapshot;
  const blockers: string[] = [];
  const positives: string[] = [];
  const unknowns: string[] = [];
  const notes: string[] = [];

  if (typeof claude.confidence === "number") {
    notes.push("Claude self-reported confidence is recorded and is not used as proof");
  }

  if (signals.company.verdict === "mismatch") blockers.push("conflicting_employer");
  else if (isPositive(signals.company)) positives.push("company_match");
  else unknowns.push("company_unverified");

  if (signals.title.verdict === "mismatch") {
    blockers.push(
      signals.title.note?.includes("seniority") ? "incompatible_title_or_seniority" : "incompatible_title_or_seniority",
    );
  } else if (isPositive(signals.title)) {
    positives.push(parseTitleSimilarity(signals.title) >= 0.9 ? "exact_title" : "title_match");
  } else unknowns.push("title_unverified");

  if (signals.requisitionId.verdict === "mismatch") blockers.push("conflicting_requisition_ids");
  else if (isPositive(signals.requisitionId)) positives.push("requisition_id_match");
  else unknowns.push("requisition_id_unknown");

  if (context.reviewStatus === "removed") blockers.push("removed_from_review");
  if (context.reviewStatus === "rejected") blockers.push("candidate_rejected");
  if (context.geo?.identityConflict && (context.geo.provenance === "verified_source" || context.geo.provenance === "deterministic")) {
    blockers.push("location_identifies_different_requisition");
  } else if (context.geo?.status === "incompatible" && (context.geo.provenance === "verified_source" || context.geo.provenance === "deterministic")) {
    blockers.push("incompatible_work_geography");
  }

  if (signals.location.verdict === "mismatch") blockers.push("location_identifies_different_requisition");
  else if (isPositive(signals.location)) positives.push("location_match");
  else unknowns.push("location_unknown");

  if (signals.completeness.verdict !== "match" || candidate.completeness !== "full") {
    blockers.push("incomplete_jd");
  } else positives.push("complete_jd");

  const competingCount = signals.competingPostings.items.length;
  const hasReqDiscriminator = isPositive(signals.requisitionId);
  if (competingCount > 0 && !hasReqDiscriminator) {
    blockers.push("multiple_plausible_competing_postings");
  } else if (competingCount === 0) {
    notes.push("No competing postings were recorded; uniqueness is not itself positive evidence");
  }

  if (signals.postingDate.verdict === "mismatch") {
    notes.push(signals.postingDate.note ?? "Posting date conflicts with the application date");
  } else if (isPositive(signals.postingDate)) {
    positives.push("date_aligned");
  } else unknowns.push("posting_date_unknown");

  const unique = (items: string[]) => [...new Set(items)];
  const identityBlockers = unique(blockers).filter((item) =>
    [
      "conflicting_employer",
      "conflicting_requisition_ids",
      "incompatible_title_or_seniority",
      "location_identifies_different_requisition",
    ].includes(item),
  );

  if (identityBlockers.length > 0) {
    return {
      recommendation: "reject_mismatch",
      blockers: unique(blockers),
      positives,
      unknowns,
      autoConfirmEnabled: false,
      notes,
    };
  }

  if (blockers.includes("removed_from_review") || blockers.includes("candidate_rejected") || blockers.includes("incompatible_work_geography")) {
    return {
      recommendation: "manual_review",
      blockers: unique(blockers),
      positives,
      unknowns,
      autoConfirmEnabled: false,
      notes: [
        ...notes,
        blockers.includes("incompatible_work_geography")
          ? "Verified geographic incompatibility blocks shadow auto-confirmation and is not a historical identity mismatch by itself."
          : "Removed or rejected candidates are not shadow-auto-confirm eligible.",
      ],
    };
  }

  const trustedSource = candidate.sourceType === "company_site" || candidate.sourceType === "ats";
  const extraDiscriminator =
    hasReqDiscriminator ||
    (positives.includes("date_aligned") && (trustedSource || titleIsExact(signals.title)));

  const eligible =
    positives.includes("company_match") &&
    (positives.includes("title_match") || positives.includes("exact_title")) &&
    positives.includes("complete_jd") &&
    extraDiscriminator &&
    signals.postingDate.verdict !== "mismatch" &&
    !blockers.includes("incomplete_jd") &&
    !blockers.includes("multiple_plausible_competing_postings");

  if (eligible) {
    return {
      recommendation: "eligible_for_auto_confirmation",
      blockers: unique(blockers),
      positives,
      unknowns,
      autoConfirmEnabled: false,
      notes: [
        ...notes,
        "Shadow-only: this recommendation never confirms or scores. A human decision is still required.",
      ],
    };
  }

  if (!extraDiscriminator) {
    notes.push("Eligibility requires a requisition match or aligned posting date plus a trusted source or exact title");
  }
  return {
    recommendation: "manual_review",
    blockers: unique(blockers),
    positives,
    unknowns,
    autoConfirmEnabled: false,
    notes,
  };
};
