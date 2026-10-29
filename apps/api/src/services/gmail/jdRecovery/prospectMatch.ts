import {
  isGenericRole,
  isStageNameRole,
  normalizeCompany,
  roleSimilarity,
  type GmailApplication,
} from "../gmailApplications.js";
import { classifyJobLink } from "./emailEvidence.js";
import { HIGH_ROLE_SIMILARITY } from "./assessJdMatch.js";
import { normalizeSourceUrl } from "../../../lib/normalizeSourceUrl.js";
import type { JobProspect } from "./jobProspects.repository.js";

/** Same window as MCP application reads: attach to Gmail apps already in the local DB. */
export const PROSPECT_MATCH_LOOKBACK_DAYS = 120;

/** Below this, a title is not even a review candidate for a named Gmail role. */
const REVIEW_ROLE_SIMILARITY = 0.5;

export type ProspectMatchDecision = "auto" | "review" | "none";

export type ProspectMatch = {
  decision: ProspectMatchDecision;
  reason: string;
  prospects: JobProspect[];
};

export type IdentityRelation = "match" | "conflict" | "none";

const compactId = (value: string): string => value.toUpperCase().replace(/[^A-Z0-9]/g, "");

/** A URL that identifies one posting, not a company careers homepage. */
export const isSpecificJobUrl = (url: string | undefined): boolean => {
  if (!url) return false;
  const normalized = normalizeSourceUrl(url) ?? url;
  return Boolean(classifyJobLink(normalized));
};

type SeniorityMark = "campus" | "junior" | "senior";

const CAMPUS_RE = /\b(new[\s-]?grad|campus|university hire|grad(uate)? program)\b/;
const SENIOR_RE = /\b(senior|sr\.?|staff|principal|lead)\b/;
const JUNIOR_RE =
  /\b(junior|jr\.?|entry[\s-]?level|associate|intern)\b|\b(software engineer|swe|engineer)\s+(i|1)\b/;

/** Only explicit seniority. Unlabeled / mid is unknown, not a conflict with Senior. */
export const explicitSeniority = (title: string, seniority?: string): SeniorityMark | null => {
  const text = `${seniority ?? ""} ${title}`.toLowerCase();
  if (CAMPUS_RE.test(text)) return "campus";
  if (SENIOR_RE.test(text)) return "senior";
  if (JUNIOR_RE.test(text)) return "junior";
  return null;
};

export const seniorityConflict = (
  appTitle: string | null,
  prospect: Pick<JobProspect, "title" | "seniority">,
): boolean => {
  if (!appTitle) return false;
  const left = explicitSeniority(appTitle);
  const right = explicitSeniority(prospect.title, prospect.seniority);
  return Boolean(left && right && left !== right);
};

export const identityRelation = (
  app: { requisitionId?: string },
  prospect: Pick<JobProspect, "requisitionId" | "sourceUrl" | "normalizedSourceUrl">,
  postingUrl?: string,
): IdentityRelation => {
  if (app.requisitionId && prospect.requisitionId) {
    return compactId(app.requisitionId) === compactId(prospect.requisitionId) ? "match" : "conflict";
  }
  const appUrl = postingUrl && isSpecificJobUrl(postingUrl) ? (normalizeSourceUrl(postingUrl) ?? postingUrl) : undefined;
  const prospectUrl =
    prospect.normalizedSourceUrl ??
    (prospect.sourceUrl && isSpecificJobUrl(prospect.sourceUrl)
      ? (normalizeSourceUrl(prospect.sourceUrl) ?? prospect.sourceUrl)
      : undefined);
  if (appUrl && prospectUrl) return appUrl === prospectUrl ? "match" : "conflict";
  return "none";
};

const usableAppRole = (app: Pick<GmailApplication, "role">): string | null => {
  const role = app.role?.trim() || null;
  if (!role || isStageNameRole(role)) return null;
  return role;
};

const competingAppsFor = (
  prospect: JobProspect,
  app: GmailApplication,
  companyApps: GmailApplication[],
): GmailApplication[] =>
  companyApps.filter((other) => {
    if (other.key === app.key) return false;
    const role = usableAppRole(other);
    if (!role) return false;
    return roleSimilarity(role, prospect.title) >= HIGH_ROLE_SIMILARITY;
  });

export const isDuplicateOf = (
  incoming: {
    title: string;
    cleanedTextHash: string;
    requisitionId?: string;
    normalizedSourceUrl?: string;
    sourceUrl?: string;
  },
  existing: JobProspect,
): boolean => {
  if (incoming.requisitionId && existing.requisitionId) {
    return compactId(incoming.requisitionId) === compactId(existing.requisitionId);
  }
  const incomingUrl =
    incoming.normalizedSourceUrl ??
    (isSpecificJobUrl(incoming.sourceUrl) ? normalizeSourceUrl(incoming.sourceUrl) : undefined);
  const existingUrl =
    existing.normalizedSourceUrl ??
    (isSpecificJobUrl(existing.sourceUrl) ? normalizeSourceUrl(existing.sourceUrl) : undefined);
  if (incomingUrl && existingUrl && isSpecificJobUrl(incomingUrl) && incomingUrl === existingUrl) {
    return true;
  }
  return (
    incoming.cleanedTextHash === existing.cleanedTextHash &&
    roleSimilarity(incoming.title, existing.title) >= HIGH_ROLE_SIMILARITY
  );
};

/**
 * Decide whether an open prospect can attach to this Gmail application.
 * Auto only when the pair is unique, the role is specific (or identity matches),
 * and seniority / req / URL do not conflict.
 */
export const matchProspectsToApplication = (input: {
  app: GmailApplication;
  prospects: JobProspect[];
  companyApps?: GmailApplication[];
  requisitionId?: string;
  postingUrl?: string;
}): ProspectMatch => {
  const companyKey = normalizeCompany(input.app.company);
  if (!companyKey) return { decision: "none", reason: "no_company", prospects: [] };

  const open = input.prospects.filter((p) => p.status === "open" && p.companyKey === companyKey);
  if (open.length === 0) return { decision: "none", reason: "no_prospects", prospects: [] };

  const appRole = usableAppRole(input.app);
  const companyApps = (input.companyApps ?? [input.app]).filter((a) => normalizeCompany(a.company) === companyKey);
  const appIdentity = { requisitionId: input.requisitionId };

  const ranked = open.map((prospect) => {
    const identity = identityRelation(appIdentity, prospect, input.postingUrl);
    const similarity = appRole ? roleSimilarity(appRole, prospect.title) : 0;
    const seniority = seniorityConflict(appRole, prospect);
    const plausible =
      identity === "match" ||
      identity === "conflict" ||
      !appRole ||
      similarity >= REVIEW_ROLE_SIMILARITY;
    return { prospect, identity, similarity, seniority, plausible };
  });

  const plausible = ranked.filter((row) => row.plausible);
  if (plausible.length === 0) return { decision: "none", reason: "role_mismatch", prospects: [] };

  const autoRow = plausible.find((row) => {
    if (row.identity === "conflict" || row.seniority) return false;
    if (plausible.length !== 1) return false;
    if (competingAppsFor(row.prospect, input.app, companyApps).length > 0) return false;
    if (row.identity === "match") return true;
    if (!appRole) return false;
    if (isGenericRole(appRole) || isGenericRole(row.prospect.title)) return false;
    return row.similarity >= HIGH_ROLE_SIMILARITY;
  });

  if (autoRow) {
    return { decision: "auto", reason: autoRow.identity === "match" ? "identity_match" : "unique_company_role", prospects: [autoRow.prospect] };
  }

  const reason = !appRole
    ? "role_unknown"
    : plausible.some((row) => row.identity === "conflict")
      ? "identity_conflict"
      : plausible.some((row) => row.seniority)
        ? "seniority_conflict"
        : plausible.length > 1
          ? "multiple_prospects"
          : competingAppsFor(plausible[0]!.prospect, input.app, companyApps).length > 0
            ? "multiple_applications"
            : isGenericRole(appRole) || isGenericRole(plausible[0]!.prospect.title)
              ? "generic_title"
              : "needs_review";

  return { decision: "review", reason, prospects: plausible.map((row) => row.prospect) };
};
