import { extractJobPostingMetadata } from "../../../tools/jobPostingMetadataExtract.js";
import { normalizeCompany } from "../gmailApplications.js";
import { HIGH_ROLE_SIMILARITY } from "./assessJdMatch.js";
import { extractRequisitionId } from "./emailEvidence.js";
import { seniorityConflict } from "./prospectMatch.js";
import { strictTitleSimilarity } from "./titleMatch.js";
export type JdCompleteness = "full" | "partial";
export type JdSourceType = "company_site" | "ats" | "aggregator" | "other";

export const EVIDENCE_PROVENANCES = [
  "verified_source",
  "deterministic",
  "claude_reported",
  "unknown",
] as const;

export type EvidenceProvenance = (typeof EVIDENCE_PROVENANCES)[number];
export type EvidenceVerdict = "match" | "mismatch" | "unknown";

export type EvidenceSignal = {
  verdict: EvidenceVerdict;
  provenance: EvidenceProvenance;
  applicationValue?: string;
  candidateValue?: string;
  note?: string;
};

export type CompetingPostingRef = { url: string; title?: string };

export type JdMatchEvidenceSignals = {
  company: EvidenceSignal;
  title: EvidenceSignal;
  requisitionId: EvidenceSignal;
  location: EvidenceSignal;
  postingDate: EvidenceSignal;
  completeness: EvidenceSignal;
  competingPostings: EvidenceSignal & { items: CompetingPostingRef[] };
};

export type ClaudeReportedEvidence = {
  provenance: "claude_reported";
  explanation: string[];
  /** 0–100. Never treated as proof and never used as a positive match signal. */
  confidence?: number;
};

export type JdMatchEvidenceSnapshot = {
  capturedAt: string;
  applicationKey: string;
  application: {
    company: string;
    role: string | null;
    appliedAt: string;
    appliedAtKnown: boolean;
    requisitionId?: string;
  };
  candidate: {
    url?: string;
    sourceType?: JdSourceType;
    title?: string;
    company?: string;
    location?: string;
    requisitionId?: string;
    datePosted?: string;
    completeness: JdCompleteness;
    claimedCompleteness?: JdCompleteness;
    textHash?: string;
  };
  signals: JdMatchEvidenceSignals;
  claude: ClaudeReportedEvidence;
};

const compact = (value: string): string => value.toLowerCase().replace(/[^a-z0-9]+/g, "");
export const compactRequisitionId = (value: string): string => value.toUpperCase().replace(/[^A-Z0-9]/g, "");

const CITY_NOISE = /^(remote|hybrid|onsite|on-site|united states|usa|us|worldwide|global)$/i;

export const cityToken = (location: string | undefined): string | undefined => {
  if (!location?.trim()) return undefined;
  const city = location.split(/[,;/|(]| - /)[0]?.trim() ?? "";
  if (city.length < 4 || CITY_NOISE.test(city)) return undefined;
  return compact(city) || undefined;
};

const parseFlexibleDate = (raw: string | undefined): string | undefined => {
  if (!raw?.trim()) return undefined;
  const parsed = Date.parse(raw);
  if (!Number.isNaN(parsed)) return new Date(parsed).toISOString();
  return undefined;
};

const POSTED_DATE_RE =
  /(?:posted|published|date posted|listed)\s*(?:on|:)?\s*([A-Za-z]{3,9}\s+\d{1,2},?\s+\d{4}|\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2}\/\d{2,4})/i;

export const extractPostedDate = (text: string, claimed?: string): { value?: string; provenance: EvidenceProvenance } => {
  const fromClaim = parseFlexibleDate(claimed);
  const match = text.match(POSTED_DATE_RE)?.[1];
  const fromText = parseFlexibleDate(match);
  if (fromText) return { value: fromText, provenance: "deterministic" };
  if (fromClaim) return { value: fromClaim, provenance: "claude_reported" };
  return { provenance: "unknown" };
};

export const extractCandidateRequisitionId = (
  text: string,
  url: string | undefined,
  claimed?: string,
): { value?: string; provenance: EvidenceProvenance } => {
  const fromUrl = url ? extractRequisitionId(url, "") : undefined;
  const fromText = extractRequisitionId("", text.slice(0, 4000));
  if (fromUrl) return { value: compactRequisitionId(fromUrl), provenance: "verified_source" };
  if (fromText) return { value: compactRequisitionId(fromText), provenance: "deterministic" };
  if (claimed?.trim()) return { value: compactRequisitionId(claimed), provenance: "claude_reported" };
  return { provenance: "unknown" };
};

const hostContainsCompany = (url: string | undefined, company: string): boolean => {
  if (!url) return false;
  try {
    const host = new URL(url).hostname.replace(/^www\./, "");
    const slug = compact(company);
    return slug.length >= 4 && compact(host).includes(slug);
  } catch {
    return false;
  }
};

const compareCompany = (appCompany: string, postingCompany: string | undefined, url?: string): EvidenceSignal => {
  const want = normalizeCompany(appCompany);
  const got = postingCompany ? normalizeCompany(postingCompany) : "";
  if (got && want && got === want) {
    return {
      verdict: "match",
      provenance: "deterministic",
      applicationValue: appCompany,
      candidateValue: postingCompany,
    };
  }
  if (hostContainsCompany(url, appCompany)) {
    return {
      verdict: "match",
      provenance: "verified_source",
      applicationValue: appCompany,
      candidateValue: postingCompany,
      note: "Company slug appears in the posting host",
    };
  }
  if (got && want && got !== want) {
    return {
      verdict: "mismatch",
      provenance: "deterministic",
      applicationValue: appCompany,
      candidateValue: postingCompany,
    };
  }
  return {
    verdict: "unknown",
    provenance: "unknown",
    applicationValue: appCompany,
    candidateValue: postingCompany,
  };
};

const compareTitle = (appRole: string | null, postingTitle: string | undefined): EvidenceSignal => {
  if (!appRole || !postingTitle) {
    return {
      verdict: "unknown",
      provenance: "unknown",
      applicationValue: appRole ?? undefined,
      candidateValue: postingTitle,
      note: appRole ? "Candidate title unavailable" : "Application title unavailable",
    };
  }
  if (seniorityConflict(appRole, { title: postingTitle })) {
    return {
      verdict: "mismatch",
      provenance: "deterministic",
      applicationValue: appRole,
      candidateValue: postingTitle,
      note: "Explicit seniority or campus/new-grad labels conflict",
    };
  }
  const similarity = strictTitleSimilarity(appRole, postingTitle);
  if (similarity >= 0.9) {
    return { verdict: "match", provenance: "deterministic", applicationValue: appRole, candidateValue: postingTitle, note: `strict_title:${similarity.toFixed(2)}` };
  }
  if (similarity >= HIGH_ROLE_SIMILARITY) {
    return { verdict: "match", provenance: "deterministic", applicationValue: appRole, candidateValue: postingTitle, note: `strict_title:${similarity.toFixed(2)}` };
  }
  if (similarity < 0.5) {
    return { verdict: "mismatch", provenance: "deterministic", applicationValue: appRole, candidateValue: postingTitle, note: `strict_title:${similarity.toFixed(2)}` };
  }
  return {
    verdict: "unknown",
    provenance: "deterministic",
    applicationValue: appRole,
    candidateValue: postingTitle,
    note: `strict_title:${similarity.toFixed(2)}; not strong enough to count as positive evidence`,
  };
};

const compareReq = (appReq?: string, candidateReq?: string, provenance: EvidenceProvenance = "unknown"): EvidenceSignal => {
  if (appReq && candidateReq) {
    const same = compactRequisitionId(appReq) === compactRequisitionId(candidateReq);
    return {
      verdict: same ? "match" : "mismatch",
      provenance,
      applicationValue: appReq,
      candidateValue: candidateReq,
    };
  }
  return {
    verdict: "unknown",
    provenance: appReq || candidateReq ? provenance : "unknown",
    applicationValue: appReq,
    candidateValue: candidateReq,
    note: !appReq && !candidateReq ? "Requisition IDs unavailable on both sides" : "Requisition ID missing on one side",
  };
};

const compareLocation = (appLocation?: string, candidateLocation?: string): EvidenceSignal => {
  const appCity = cityToken(appLocation);
  const candCity = cityToken(candidateLocation);
  if (appCity && candCity) {
    return {
      verdict: appCity === candCity ? "match" : "mismatch",
      provenance: "deterministic",
      applicationValue: appLocation,
      candidateValue: candidateLocation,
    };
  }
  return {
    verdict: "unknown",
    provenance: candidateLocation || appLocation ? "deterministic" : "unknown",
    applicationValue: appLocation,
    candidateValue: candidateLocation,
  };
};

const compareDates = (appliedAt: string, appliedAtKnown: boolean, postedAt?: string, provenance: EvidenceProvenance = "unknown"): EvidenceSignal => {
  if (!appliedAtKnown || !postedAt) {
    return {
      verdict: "unknown",
      provenance: postedAt ? provenance : "unknown",
      applicationValue: appliedAtKnown ? appliedAt : undefined,
      candidateValue: postedAt,
      note: !appliedAtKnown ? "Application date is estimated or unknown" : "Posting date unavailable",
    };
  }
  const applied = Date.parse(appliedAt);
  const posted = Date.parse(postedAt);
  if (Number.isNaN(applied) || Number.isNaN(posted)) {
    return { verdict: "unknown", provenance: "unknown", applicationValue: appliedAt, candidateValue: postedAt };
  }
  const deltaDays = (posted - applied) / 86_400_000;
  if (deltaDays > 7) {
    return {
      verdict: "mismatch",
      provenance,
      applicationValue: appliedAt,
      candidateValue: postedAt,
      note: "Posting date is more than a week after the application",
    };
  }
  if (deltaDays < -180) {
    return {
      verdict: "unknown",
      provenance,
      applicationValue: appliedAt,
      candidateValue: postedAt,
      note: "Posting date is far earlier than the application; could be a leftover listing",
    };
  }
  return {
    verdict: "match",
    provenance,
    applicationValue: appliedAt,
    candidateValue: postedAt,
    note: "Posting date is on or before the application, or within a week after",
  };
};

export type BuildEvidenceSnapshotInput = {
  applicationKey: string;
  company: string;
  role: string | null;
  appliedAt: string;
  appliedAtKnown: boolean;
  applicationRequisitionId?: string;
  applicationLocation?: string;
  candidate: {
    url?: string;
    sourceType?: JdSourceType;
    title?: string;
    company?: string;
    location?: string;
    requisitionId?: string;
    datePosted?: string;
    completeness?: JdCompleteness;
    claimedCompleteness?: JdCompleteness;
    text?: string;
    matchEvidence?: string[];
    claudeConfidence?: number;
    competingPostings?: CompetingPostingRef[];
  };
  siblingPostings?: CompetingPostingRef[];
  nowIso?: string;
  textHash?: string;
};

export const buildMatchEvidenceSnapshot = (input: BuildEvidenceSnapshotInput): JdMatchEvidenceSnapshot => {
  const text = input.candidate.text ?? "";
  const meta = text.trim() ? extractJobPostingMetadata(text) : undefined;
  const postingCompany = input.candidate.company ?? meta?.companyName ?? undefined;
  const postingTitle = input.candidate.title ?? meta?.jobTitle ?? undefined;
  const postingLocation = input.candidate.location ?? meta?.location ?? undefined;
  const req = extractCandidateRequisitionId(text, input.candidate.url, input.candidate.requisitionId);
  const posted = extractPostedDate(text, input.candidate.datePosted);
  const company = compareCompany(input.company, postingCompany, input.candidate.url);
  const title = compareTitle(input.role, postingTitle);
  const competing = [
    ...(input.candidate.competingPostings ?? []),
    ...(input.siblingPostings ?? []),
  ].filter((item, index, all) => item.url && all.findIndex((row) => row.url === item.url) === index);
  const completeness: EvidenceSignal = {
    verdict: input.candidate.completeness === "full" ? "match" : "mismatch",
    provenance: "deterministic",
    candidateValue: input.candidate.completeness,
    note:
      input.candidate.claimedCompleteness && input.candidate.claimedCompleteness !== input.candidate.completeness
        ? `Claude claimed ${input.candidate.claimedCompleteness}; server stored ${input.candidate.completeness}`
        : undefined,
  };

  return {
    capturedAt: input.nowIso ?? new Date().toISOString(),
    applicationKey: input.applicationKey,
    application: {
      company: input.company,
      role: input.role,
      appliedAt: input.appliedAt,
      appliedAtKnown: input.appliedAtKnown,
      requisitionId: input.applicationRequisitionId,
    },
    candidate: {
      url: input.candidate.url,
      sourceType: input.candidate.sourceType,
      title: postingTitle,
      company: postingCompany,
      location: postingLocation,
      requisitionId: req.value ?? input.candidate.requisitionId,
      datePosted: posted.value ?? input.candidate.datePosted,
      completeness: input.candidate.completeness ?? "partial",
      claimedCompleteness: input.candidate.claimedCompleteness,
      textHash: input.textHash,
    },
    signals: {
      company,
      title,
      requisitionId: compareReq(input.applicationRequisitionId, req.value ?? input.candidate.requisitionId, req.provenance),
      location: compareLocation(input.applicationLocation, postingLocation),
      postingDate: compareDates(input.appliedAt, input.appliedAtKnown, posted.value, posted.provenance),
      completeness,
      competingPostings: {
        verdict: competing.length > 0 ? "unknown" : "match",
        provenance: competing.length > 0 ? "deterministic" : "unknown",
        items: competing,
        note: competing.length > 0 ? `${competing.length} other plausible posting(s) recorded` : "No competing postings recorded",
      },
    },
    claude: {
      provenance: "claude_reported",
      explanation: input.candidate.matchEvidence ?? [],
      confidence: Number.isFinite(input.candidate.claudeConfidence) ? input.candidate.claudeConfidence : undefined,
    },
  };
};

export const isPendingReviewCandidate = (candidate: {
  reviewStatus?: "pending" | "rejected" | "removed";
  text?: string;
  url?: string;
}): boolean =>
  candidate.reviewStatus !== "rejected" &&
  candidate.reviewStatus !== "removed" &&
  Boolean(candidate.text?.trim() || candidate.url);
