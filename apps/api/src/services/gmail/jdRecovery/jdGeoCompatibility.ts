import { userProfile } from "../../../config/userProfile.js";
import type { UserProfile } from "../../../types/userProfile.js";
import type { EvidenceProvenance } from "./jdMatchEvidence.js";
import { cityToken } from "./jdMatchEvidence.js";
import type { RecoveryCandidate } from "./evaluations.repository.js";

export const GEO_COMPATIBILITY_STATES = ["compatible", "incompatible", "needs_review", "unknown"] as const;
export type GeoCompatibilityState = (typeof GEO_COMPATIBILITY_STATES)[number];

export const WORK_ARRANGEMENTS = ["onsite", "hybrid", "remote", "unknown"] as const;
export type WorkArrangement = (typeof WORK_ARRANGEMENTS)[number];

export const REMOTE_ELIGIBILITY = ["remote_us", "remote_nyc", "remote_restricted", "remote_unknown"] as const;
export type RemoteEligibility = (typeof REMOTE_ELIGIBILITY)[number];

export const NEIGHBORHOOD_ZONES = ["green", "yellow", "red", "unknown"] as const;
export type NeighborhoodZone = (typeof NEIGHBORHOOD_ZONES)[number];

export const COMMUTE_CLASSES = ["excellent", "manageable_hybrid", "too_long", "unknown"] as const;
export type CommuteClassification = (typeof COMMUTE_CLASSES)[number];

/** Flatbush Avenue–Brooklyn College (2/5) home-access buffer, in minutes. */
export const HOME_ACCESS_BUFFER_MINUTES = 15;
/** Added only to rough estimates that do not already include transfers. */
export const ROUGH_TRANSFER_ALLOWANCE_MINUTES = 10;
export const COMMUTE_EXCELLENT_MAX_MINUTES = 45;
export const COMMUTE_MANAGEABLE_MAX_MINUTES = 60;

export type CommuteRouteInput = {
  transitMinutes?: number;
  provenance: "verified_route" | "rough_estimate" | "none";
  usesDirect25?: boolean;
  transferCount?: number;
  includesTransfers?: boolean;
  includesFinalWalk?: boolean;
  includesHomeAccess?: boolean;
  finalWalkMinutes?: number;
  officeAddress?: string;
  nearestStation?: string;
  neighborhood?: string;
};

export type CommuteAssessment = {
  totalMinutes?: number;
  classification: CommuteClassification;
  usedVerifiedRoute: boolean;
  usesDirect25?: boolean;
  transferCount?: number;
  assumptions: string[];
  provenance: EvidenceProvenance | "unknown";
};

export type GeoCompatibilityAssessment = {
  status: GeoCompatibilityState;
  reason: string;
  provenance: EvidenceProvenance;
  workArrangement: WorkArrangement;
  remoteEligibility?: RemoteEligibility;
  candidateLocation?: string;
  applicationLocation?: string;
  neighborhoodZone?: NeighborhoodZone;
  commute: CommuteAssessment;
  identityConflict: boolean;
  userPreferenceConflict: boolean;
  excludedFromDefaultReview: boolean;
};

const NYC_RE =
  /\b(new york(?: city)?|nyc|manhattan|brooklyn|queens|bronx|staten island|long island city|lic|williamsburg|greenpoint|bushwick|bay ridge|dumbo|chelsea|west village|union square|midtown|financial district|fidi)\b/i;
const US_REMOTE_RE =
  /\b(remote(?:[-\s]first)?[,\s/|-]+(?:us|usa|united states)|united states\s*[|/]\s*remote|us(?:a)?\s+remote|remote(?:[-\s]first)?(?:\s+in)?\s+(?:the\s+)?(?:us|usa|united states))\b/i;
const NYC_REMOTE_RE = /\b(remote[-\s]?(?:nyc|new york)|new york(?: city)?(?:[-\s]|\/)+remote|nyc(?:[-\s]|\/)+remote)\b/i;
const ONSITE_RE = /\b(onsite|on-site|in[- ]person|in office|office[- ]based)\b/i;
const HYBRID_RE = /\bhybrid\b/i;
const REMOTE_RE = /\bremote\b/i;
const HQ_RE = /\bheadquarter(?:ed|s)?\s+(?:in|at)\s+([^.\n;]+)/i;

const OUT_OF_METRO: Array<{ id: string; re: RegExp; label: string }> = [
  { id: "seattle", re: /\b(seattle|bellevue|redmond)\b/i, label: "Seattle" },
  { id: "sf", re: /\b(san francisco|silicon valley|bay area|palo alto|mountain view)\b/i, label: "San Francisco Bay Area" },
  { id: "la", re: /\b(los angeles|santa monica)\b/i, label: "Los Angeles" },
  { id: "austin", re: /\baustin\b/i, label: "Austin" },
  { id: "denver", re: /\b(denver|boulder)\b/i, label: "Denver" },
  { id: "chicago", re: /\bchicago\b/i, label: "Chicago" },
  { id: "boston", re: /\bboston\b/i, label: "Boston" },
  { id: "dallas", re: /\b(dallas|plano)\b/i, label: "Dallas" },
  { id: "atlanta", re: /\batlanta\b/i, label: "Atlanta" },
  { id: "miami", re: /\bmiami\b/i, label: "Miami" },
  { id: "dc", re: /\b(washington,? d\.?c\.?|arlington,?\s*va)\b/i, label: "Washington DC" },
];

const GREEN_ZONE: Array<{ id: string; re: RegExp; label: string }> = [
  { id: "fidi", re: /\b(financial district|fidi|fulton street|wall street|chambers street)\b/i, label: "Financial District / Fulton / Wall / Chambers" },
  { id: "dtbk", re: /\b(downtown brooklyn|atlantic terminal|atlantic avenue|boro hall)\b/i, label: "Downtown Brooklyn / Atlantic Terminal" },
  { id: "midtown_east", re: /\b(midtown east|grand central|42nd street)\b/i, label: "Midtown East / Grand Central" },
  { id: "midtown_west", re: /\b(midtown west|times square|penn station|herald square)\b/i, label: "Midtown West / Times Square / Penn Station" },
];

const YELLOW_ZONE: Array<{ id: string; re: RegExp; label: string }> = [
  { id: "union_square", re: /\bunion square\b/i, label: "Union Square" },
  { id: "chelsea", re: /\bchelsea\b/i, label: "Chelsea" },
  { id: "west_village", re: /\bwest village\b/i, label: "West Village" },
  { id: "dumbo", re: /\bdumbo\b/i, label: "DUMBO" },
  { id: "lic", re: /\b(long island city|l\.?i\.?c\.?)\b/i, label: "Long Island City" },
];

const RED_ZONE: Array<{ id: string; re: RegExp; label: string }> = [
  { id: "williamsburg", re: /\bwilliamsburg\b/i, label: "Williamsburg" },
  { id: "greenpoint", re: /\bgreenpoint\b/i, label: "Greenpoint" },
  { id: "bushwick", re: /\bbushwick\b/i, label: "Bushwick" },
  { id: "bay_ridge", re: /\bbay ridge\b/i, label: "Bay Ridge" },
  { id: "bronx", re: /\bbronx\b/i, label: "Bronx" },
  { id: "staten_island", re: /\bstaten island\b/i, label: "Staten Island" },
  { id: "nj", re: /\b(new jersey|jersey city|hoboken|newark|jersey)\b/i, label: "New Jersey" },
  { id: "upper_manhattan", re: /\b(harlem|washington heights|inwood|above 96th)\b/i, label: "Upper Manhattan above 96th Street" },
  { id: "outer_queens", re: /\b(flushing|jamaica,?\s*ny|astoria|forest hills|jackson heights)\b/i, label: "Queens outside Long Island City" },
];

const stripHqMentions = (text: string): string => text.replace(/\bheadquarter(?:ed|s)?\s+(?:in|at)\s+([^.\n;]+)/gi, " ");

const firstMatch = <T extends { re: RegExp; label: string }>(blob: string, rows: T[]): T | undefined =>
  rows.find((row) => row.re.test(blob));

export const classifyNeighborhoodZone = (blob: string): { zone: NeighborhoodZone; label?: string } => {
  const red = firstMatch(blob, RED_ZONE);
  if (red) return { zone: "red", label: red.label };
  const green = firstMatch(blob, GREEN_ZONE);
  if (green) return { zone: "green", label: green.label };
  const yellow = firstMatch(blob, YELLOW_ZONE);
  if (yellow) return { zone: "yellow", label: yellow.label };
  return { zone: "unknown" };
};

export const detectWorkArrangement = (blob: string): WorkArrangement => {
  if (HYBRID_RE.test(blob)) return "hybrid";
  if (ONSITE_RE.test(blob) && !REMOTE_RE.test(blob)) return "onsite";
  if (REMOTE_RE.test(blob) && !ONSITE_RE.test(blob)) return "remote";
  if (REMOTE_RE.test(blob) && ONSITE_RE.test(blob)) return "hybrid";
  return "unknown";
};

const restrictedAwayFromNyc = (blob: string): boolean => {
  if (!/\b(must|only|restricted|candidates?\s+must|limited to)\b/i.test(blob)) return false;
  const nycForbidden = /\bno\s+(new york|nyc)|not (?:open|available) to (?:new york|nyc)/i.test(blob);
  if (!nycForbidden && (NYC_RE.test(blob) || /\b(united states|usa)\b/i.test(blob))) return false;
  return /\b(california|canada|uk|united kingdom|europe|eu\b|latam|latin america|india|colorado|texas|washington state)\b/i.test(
    blob,
  );
};

export const classifyRemoteEligibility = (blob: string, arrangement: WorkArrangement): RemoteEligibility | undefined => {
  if (arrangement !== "remote" && arrangement !== "unknown") return undefined;
  if (!REMOTE_RE.test(blob) && arrangement !== "remote") return undefined;
  if (restrictedAwayFromNyc(blob)) return "remote_restricted";
  if (NYC_REMOTE_RE.test(blob) || (REMOTE_RE.test(blob) && NYC_RE.test(blob))) return "remote_nyc";
  if (US_REMOTE_RE.test(blob) || /\b(united states|usa|\bus\b)\b/i.test(blob)) return "remote_us";
  if (REMOTE_RE.test(blob)) return "remote_unknown";
  return undefined;
};

const outOfMetroOffices = (blob: string): string[] =>
  OUT_OF_METRO.filter((row) => row.re.test(blob)).map((row) => row.label);

export const assessCommute = (input: CommuteRouteInput | undefined): CommuteAssessment => {
  if (!input || input.provenance === "none" || input.transitMinutes == null || !Number.isFinite(input.transitMinutes)) {
    return {
      classification: "unknown",
      usedVerifiedRoute: false,
      assumptions: ["No routing service or verified transit duration was supplied; commute minutes were not invented."],
      provenance: "unknown",
    };
  }
  if (input.officeAddress === undefined && input.nearestStation === undefined && input.provenance === "verified_route") {
    // Address/station may be omitted in tests when minutes are the evidence.
  }
  const assumptions: string[] = [];
  let total = input.transitMinutes;
  if (!input.includesHomeAccess) {
    total += HOME_ACCESS_BUFFER_MINUTES;
    assumptions.push(`Added ${HOME_ACCESS_BUFFER_MINUTES}-minute home-access buffer (bus + transfer/wait from Flatbush Avenue–Brooklyn College).`);
  } else {
    assumptions.push("Home-access buffer already included in the supplied estimate.");
  }
  if (input.provenance === "rough_estimate" && input.includesTransfers !== true) {
    total += ROUGH_TRANSFER_ALLOWANCE_MINUTES;
    assumptions.push(`Added ${ROUGH_TRANSFER_ALLOWANCE_MINUTES}-minute conservative transfer allowance because this is a rough estimate that does not already include transfers.`);
  } else if (input.includesTransfers) {
    assumptions.push("Transfer time already included in the supplied estimate; transfer allowance was not double-counted.");
  }
  if (input.provenance !== "none" && input.includesFinalWalk !== true && (input.finalWalkMinutes ?? 0) > 0) {
    total += input.finalWalkMinutes!;
    assumptions.push(`Added ${input.finalWalkMinutes}-minute final walk because the transit estimate did not include it.`);
  } else if (input.includesFinalWalk) {
    assumptions.push("Final walk already included in the supplied estimate.");
  }
  const classification: CommuteClassification =
    total > COMMUTE_MANAGEABLE_MAX_MINUTES ? "too_long" : total < COMMUTE_EXCELLENT_MAX_MINUTES ? "excellent" : "manageable_hybrid";
  if (classification === "too_long") {
    assumptions.push("Verified/estimated gate-to-door commute exceeds the 60-minute maximum and is a strict fail.");
  }
  return {
    totalMinutes: total,
    classification,
    usedVerifiedRoute: input.provenance === "verified_route",
    usesDirect25: input.usesDirect25,
    transferCount: input.transferCount,
    assumptions,
    provenance: input.provenance === "verified_route" ? "verified_source" : "deterministic",
  };
};

export type AssessJdGeoInput = {
  candidate: Pick<RecoveryCandidate, "location" | "text" | "rawText" | "geoOverride">;
  applicationLocation?: string;
  locationProvenance?: EvidenceProvenance;
  commute?: CommuteRouteInput;
  profile?: UserProfile;
};

const trusted = (provenance: EvidenceProvenance): boolean =>
  provenance === "verified_source" || provenance === "deterministic";

export const assessJdGeoCompatibility = (input: AssessJdGeoInput): GeoCompatibilityAssessment => {
  const profile = input.profile ?? userProfile;
  const claimed = input.candidate.location?.trim();
  const storedText = `${input.candidate.text ?? ""}\n${input.candidate.rawText ?? ""}`;
  const claimedSupportedByText = Boolean(claimed && storedText.toLowerCase().includes(claimed.toLowerCase()));
  const includeClaimed =
    claimedSupportedByText ||
    input.locationProvenance === "deterministic" ||
    input.locationProvenance === "verified_source";
  const claimedBlob = stripHqMentions(`${claimed ?? ""}\n${storedText}`);
  const textBlob = stripHqMentions(storedText);
  const officeBlob = includeClaimed ? claimedBlob : textBlob;
  const arrangement = detectWorkArrangement(claimedBlob);
  const remoteEligibility = classifyRemoteEligibility(claimedBlob, arrangement);
  const commute = assessCommute(input.commute);
  const neighborhood = classifyNeighborhoodZone(includeClaimed ? claimedBlob : textBlob);
  const nycListed = NYC_RE.test(claimedBlob) || NYC_RE.test(textBlob);
  const otherMetros = outOfMetroOffices(officeBlob);
  const hqMentioned = HQ_RE.test(`${claimed ?? ""}\n${storedText}`);
  const hqOnly = hqMentioned && outOfMetroOffices(`${claimed ?? ""}\n${storedText}`).length > 0 && otherMetros.length === 0;
  const appCity = cityToken(input.applicationLocation);
  const candCity = cityToken(claimed) ?? (nycListed ? "newyork" : cityToken(otherMetros[0]));
  const identityConflict = Boolean(appCity && candCity && appCity !== candCity && !(appCity === "newyork" && nycListed));
  const provenance: EvidenceProvenance =
    input.locationProvenance ??
    (claimedSupportedByText || nycListed || otherMetros.length
      ? "deterministic"
      : claimed
        ? "claude_reported"
        : "unknown");

  const base = {
    workArrangement: arrangement,
    remoteEligibility,
    candidateLocation: claimed || (nycListed ? "New York" : otherMetros[0]),
    applicationLocation: input.applicationLocation,
    neighborhoodZone: neighborhood.zone,
    commute,
    identityConflict,
  };

  const exclude = (status: GeoCompatibilityState, reason: string, userPreferenceConflict: boolean, extraProvenance = provenance): GeoCompatibilityAssessment => ({
    ...base,
    status,
    reason,
    provenance: extraProvenance,
    userPreferenceConflict,
    excludedFromDefaultReview: status === "incompatible" && trusted(extraProvenance) && !input.candidate.geoOverride,
  });

  if (commute.classification === "too_long" && commute.usedVerifiedRoute) {
    return exclude(
      "incompatible",
      `Verified gate-to-door commute is ${commute.totalMinutes} minutes, over the 60-minute maximum.`,
      true,
      "verified_source",
    );
  }

  if (identityConflict && trusted(provenance) && claimedSupportedByText) {
    return exclude(
      "incompatible",
      `Candidate location (${claimed ?? candCity}) conflicts with the verified application location (${input.applicationLocation}).`,
      false,
    );
  }

  if (arrangement === "remote" || remoteEligibility) {
    if (remoteEligibility === "remote_restricted") {
      return exclude("incompatible", "Remote role is explicitly restricted to a geography the user is not eligible for.", true);
    }
    if (remoteEligibility === "remote_us" || remoteEligibility === "remote_nyc") {
      return exclude("compatible", "Remote role is eligible from NYC / United States. Employer headquarters were not treated as the office.", false);
    }
    if (remoteEligibility === "remote_unknown") {
      return exclude("unknown", "Role is remote but eligibility (US / NYC / restricted states) is not stated.", false);
    }
  }

  if ((input.locationProvenance === "claude_reported" || provenance === "claude_reported") && !claimedSupportedByText && !nycListed && otherMetros.length === 0) {
    return exclude("needs_review", "Location is Claude-reported only and was not verified in the posting text.", false, "claude_reported");
  }

  if (nycListed && otherMetros.length > 0) {
    return exclude(
      "compatible",
      `Posting lists multiple locations including NYC${hqOnly ? "; out-of-city headquarters were ignored" : ""}.`,
      false,
    );
  }

  if (nycListed) {
    if (commute.classification === "too_long") {
      return exclude("incompatible", `NYC office commute is ${commute.totalMinutes} minutes, over the 60-minute maximum.`, true, commute.provenance === "verified_source" ? "verified_source" : "deterministic");
    }
    if (neighborhood.zone === "red" && commute.classification === "unknown") {
      return exclude(
        "needs_review",
        `${neighborhood.label ?? "This NYC neighborhood"} is a presumptive red-zone commute from Flatbush Avenue–Brooklyn College. That heuristic does not hide the candidate without a verified route.`,
        true,
      );
    }
    if (neighborhood.zone === "yellow" && commute.classification === "unknown") {
      return exclude(
        "needs_review",
        `${neighborhood.label ?? "This area"} often needs a transfer from the 2/5. Total commute is not verified.`,
        false,
      );
    }
    if (commute.classification === "excellent" || commute.classification === "manageable_hybrid") {
      return exclude(
        "compatible",
        `NYC ${arrangement === "hybrid" ? "hybrid" : "onsite"} posting with ${commute.classification.replace("_", " ")} commute (${commute.totalMinutes} min).`,
        false,
        commute.provenance === "verified_source" ? "verified_source" : provenance,
      );
    }
    return exclude(
      "compatible",
      arrangement === "hybrid"
        ? "NYC hybrid posting. Neighborhood is in or near the 2/5 green zone or unspecified NYC; commute minutes were not invented."
        : "NYC onsite posting. Employer headquarters elsewhere were not used as the office location.",
      false,
    );
  }

  if (neighborhood.zone === "red") {
    if (commute.classification === "too_long") {
      return exclude(
        "incompatible",
        `Office is in ${neighborhood.label}, and the supplied commute is ${commute.totalMinutes} minutes, over the 60-minute maximum.`,
        true,
        commute.provenance === "verified_source" ? "verified_source" : "deterministic",
      );
    }
    if (commute.classification === "excellent" || commute.classification === "manageable_hybrid") {
      return exclude(
        "compatible",
        `Office is in ${neighborhood.label}, which is usually a long commute, but the supplied route is ${commute.totalMinutes} minutes.`,
        false,
        commute.provenance === "verified_source" ? "verified_source" : "deterministic",
      );
    }
    return exclude(
      "needs_review",
      `${neighborhood.label ?? "This area"} is a presumptive red-zone commute from Flatbush Avenue–Brooklyn College. That heuristic does not hide the candidate without a verified route.`,
      true,
    );
  }

  if (otherMetros.length > 0 && (arrangement === "onsite" || arrangement === "hybrid" || arrangement === "unknown")) {
    return exclude(
      "incompatible",
      `Explicit ${arrangement === "hybrid" ? "hybrid" : "onsite"} posting in ${otherMetros.join(", ")} with no NYC or eligible remote option.`,
      true,
    );
  }

  if (!claimed && !nycListed && otherMetros.length === 0 && !REMOTE_RE.test(officeBlob)) {
    return exclude("unknown", "No posting location was stored or extracted. Missing location is not proof of compatibility.", false, "unknown");
  }

  const prefersNyc = (profile.locationPreferences?.primary ?? []).some((row) => /nyc|new york|remote/i.test(row));
  if (prefersNyc && arrangement === "unknown") {
    return exclude("needs_review", "Location evidence is incomplete or contradictory.", false);
  }

  return exclude("unknown", "Geographic compatibility could not be determined from stored evidence.", false, "unknown");
};

export const isGeoExcludedFromDefaultReview = (assessment: GeoCompatibilityAssessment, geoOverride?: boolean): boolean =>
  Boolean(assessment.excludedFromDefaultReview && !geoOverride);
