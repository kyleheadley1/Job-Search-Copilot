import { jdTextLooksComplete, MIN_COMPLETE_JD_CHARS } from "./jdCompleteness.js";
import type { RecoveryCandidate } from "./evaluations.repository.js";

export const JD_AVAILABILITY_LABELS = [
  "full_jd_saved",
  "partial_jd_saved",
  "url_only",
  "listing_unavailable",
  "removed_from_review",
] as const;

export type JdAvailabilityLabel = (typeof JD_AVAILABILITY_LABELS)[number];

const DISPLAY: Record<JdAvailabilityLabel, string> = {
  full_jd_saved: "Full JD saved",
  partial_jd_saved: "Partial JD saved",
  url_only: "URL only, JD not captured",
  listing_unavailable: "Listing unavailable",
  removed_from_review: "Removed from review",
};

export const hasStoredJdText = (candidate: Pick<RecoveryCandidate, "text" | "rawText">): boolean =>
  Boolean((candidate.text ?? candidate.rawText ?? "").replace(/\s+/g, " ").trim());

/** Stored text that is more than a dead-link stub, using the existing completeness validator. */
export const hasUsableStoredJd = (candidate: Pick<RecoveryCandidate, "text" | "rawText" | "completeness">): boolean => {
  const text = (candidate.text ?? candidate.rawText ?? "").trim();
  if (text.length < MIN_COMPLETE_JD_CHARS / 3) return false;
  return candidate.completeness === "full" || candidate.completeness === "partial" || jdTextLooksComplete(text);
};

export const jdAvailabilityLabel = (
  candidate: Pick<RecoveryCandidate, "text" | "rawText" | "completeness" | "reviewStatus" | "removalReason">,
): JdAvailabilityLabel => {
  if (candidate.reviewStatus === "removed" && candidate.removalReason === "listing_unavailable") {
    return "listing_unavailable";
  }
  if (candidate.reviewStatus === "removed") return "removed_from_review";
  if (candidate.completeness === "full" && hasStoredJdText(candidate)) return "full_jd_saved";
  if (hasUsableStoredJd(candidate) || (candidate.completeness === "partial" && hasStoredJdText(candidate))) {
    return "partial_jd_saved";
  }
  return "url_only";
};

export const jdAvailabilityDisplay = (label: JdAvailabilityLabel): string => DISPLAY[label];
