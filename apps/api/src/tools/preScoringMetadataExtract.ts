/**
 * Deterministic pre-scoring metadata for scraped job-board layouts
 * (Next Match AI / comma-title formats / location-prefixed titles).
 */
import { logger } from "../lib/logger.js";
import { isBoardMatchChromeLine } from "./jobBoardMatchExtract.js";
import {
  extractCompanyFromPostedHeader,
  extractDuplicateCompanyBeforeEmployeeCount,
  isPostedTimestampLine,
  isValidCompanyCandidate,
  resolveCompanyFromText,
} from "./companyCandidateRules.js";

export type PreScoringJobMetadata = {
  companyName: string | null;
  jobTitle: string | null;
  location: string | null;
  rawTitleSource: string;
  confidence: "high" | "medium" | "low";
};

const METADATA_LABELS = new Set(["position", "time", "remote", "seniority", "money", "date"]);

const SCRAPED_NOISE_EXACT = new Set(
  [
    "position",
    "time",
    "remote",
    "seniority",
    "money",
    "date",
    "follow",
    "job",
    "company",
    "role",
    "who you are",
    "what the job involves",
    "responsibilities",
    "qualification",
    "required",
    "desirable",
    "insider connection",
    "find any email",
    "share this job",
    "report a problem with this job",
    "hide company",
    "offers equity",
    "creator home",
  ].map((s) => s.toLowerCase()),
);

const SCRAPED_NOISE_PREFIXES = ["badno h1b", "no h1b"];

const TITLE_LIKE_RE =
  /\b((?:full[\s-]?stack|fullstack|frontend|backend|platform|infrastructure|machine learning|site reliability|product)\s+)?(?:engineer|developer|software|devops|sre|scientist|architect|analyst|designer|programmer|enablement)\b|\b(?:forward deployed|ai enablement|ai engineer|full stack|fullstack)\b/i;

const RELATIVE_TIMESTAMP_RE = /^[·•]\s*\d+.*\bago\b/i;
const SALARY_SCRAPE_RE = /^\$[\d,.]+(?:k)?(?:\s*-\s*\$?[\d,.]+(?:k)?)?$/i;
const LOCATION_COUNTRY_RE = /^(united states|united kingdom|canada|australia|germany|france|india|remote)$/i;
const LOCATION_CITY_STATE_RE = /^[A-Za-z][A-Za-z .'-]+,\s*[A-Z]{2}(?:,\s*(?:USA|US))?$/;

const lineLower = (line: string): string => line.trim().toLowerCase();

export const normalizeJobLines = (rawJobText: string): string[] =>
  rawJobText
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

export const isTitleLikeLine = (line: string): boolean => {
  const t = line.trim();
  if (!t || t.length > 120) return false;
  if (METADATA_LABELS.has(lineLower(t))) return false;
  if (RELATIVE_TIMESTAMP_RE.test(t)) return false;
  return TITLE_LIKE_RE.test(t);
};

export const looksLikeLocation = (line: string): boolean => {
  const t = line.trim();
  if (!t) return false;
  if (LOCATION_COUNTRY_RE.test(t)) return true;
  if (LOCATION_CITY_STATE_RE.test(t)) return true;
  if (/^(remote|hybrid|on-site|onsite)$/i.test(t)) return true;
  return false;
};

export const isScrapedNoiseLine = (line: string): boolean => {
  const low = lineLower(line);
  if (!low) return true;
  if (isBoardMatchChromeLine(line.trim())) return true;
  if (SCRAPED_NOISE_EXACT.has(low)) return true;
  if (SCRAPED_NOISE_PREFIXES.some((p) => low.includes(p))) return true;
  if (RELATIVE_TIMESTAMP_RE.test(line.trim()) || isPostedTimestampLine(line)) return true;
  if (SALARY_SCRAPE_RE.test(line.trim())) return true;
  if (/^junior and mid level$/i.test(low)) return true;
  return false;
};

export const isMetadataLabelLine = (line: string): boolean => METADATA_LABELS.has(lineLower(line));

export const parseCommaTitleCompany = (line: string): { jobTitle: string; companyName: string } | null => {
  const idx = line.lastIndexOf(",");
  if (idx <= 0) return null;
  const jobTitle = line.slice(0, idx).trim();
  const companyName = line.slice(idx + 1).trim();
  if (!jobTitle || !companyName) return null;
  if (!isTitleLikeLine(jobTitle)) return null;
  if (looksLikeLocation(companyName)) return null;
  if (companyName.length > 40) return null;
  // "Software Engineer, Reflections" / "Software Engineer, AI Platforms" —
  // team/org qualifiers must stay in the title, not become the company.
  if (looksLikeTeamOrgQualifier(companyName)) return null;
  if (!isValidCompanyCandidate(companyName)) return null;
  return { jobTitle, companyName };
};

const CORPORATE_COMPANY_RE =
  /\b(inc\.?|llc|ltd\.?|corp\.?|corporation|company|co\.|technologies|labs?|group|systems|holdings|partners|plc)\b/i;

const KNOWN_EMPLOYER_AFTER_COMMA_RE =
  /^(google|meta|amazon|apple|netflix|microsoft|uber|stripe|airbnb|spotify|openai|anthropic|ibm|oracle|salesforce|bloomberg)$/i;

/**
 * Team/org unit after a role title comma — not an employer name.
 * Single brand tokens (Plaid, Patreon) are companies unless they match the team lexicon.
 */
const TEAM_ORG_EXACT = new Set(
  [
    "reflections",
    "product",
    "platform",
    "platforms",
    "engineering",
    "marketing",
    "growth",
    "news",
    "content",
    "data",
    "research",
    "privacy",
    "operations",
    "enablement",
    "infrastructure",
    "workforce",
    "identity",
    "payments",
    "billing",
    "search",
    "ads",
    "mobile",
    "web",
    "core",
    "media",
    "editorial",
    "video",
    "commerce",
    "trust",
    "safety",
    "home",
    "equity",
    "it product",
    "ai platforms",
    "interactive news",
    "app experience",
    "workforce operations",
    "marketing and privacy",
    "content data products",
  ].map((s) => s.toLowerCase()),
);

const TEAM_ORG_MULTI_RE =
  /\b(platforms?|reflections|news|products?|experience|operations|enablement|privacy|infrastructure|engineering|growth|content|marketing|workforce|identity|payments?)\b/i;

const foldTeamOrgKey = (s: string): string =>
  s.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase();

export const looksLikeTeamOrgQualifier = (name: string): boolean => {
  const s = name.trim();
  if (!s || s.length > 48) return false;
  if (CORPORATE_COMPANY_RE.test(s)) return false;
  if (KNOWN_EMPLOYER_AFTER_COMMA_RE.test(s)) return false;
  if (looksLikeLocation(s)) return false;
  const words = s.split(/\s+/).filter(Boolean);
  if (words.length < 1 || words.length > 4) return false;
  const key = foldTeamOrgKey(s);
  if (TEAM_ORG_EXACT.has(key)) return true;
  if (words.length >= 2 && TEAM_ORG_MULTI_RE.test(s.normalize("NFKD"))) return true;
  return false;
};

export const normalizeLocationPrefixedTitle = (
  title: string,
): { jobTitle: string; location: string | null } => {
  const trimmed = title.trim();
  const dash = trimmed.match(/^(.+?)\s*-\s*(.+)$/);
  if (!dash) return { jobTitle: trimmed, location: null };
  const prefix = dash[1]!.trim();
  const rest = dash[2]!.trim();
  if (looksLikeLocation(prefix) && isTitleLikeLine(rest)) {
    logger.warn("Stripped location prefix from job title", {
      originalTitle: trimmed,
      locationPrefix: prefix,
      normalizedTitle: rest,
    });
    return { jobTitle: rest, location: prefix };
  }
  return { jobTitle: trimmed, location: null };
};

const extractLocationFromPositionLabel = (lines: string[]): string | null => {
  const positionIdx = lines.findIndex((l) => lineLower(l) === "position");
  if (positionIdx === -1 || positionIdx + 1 >= lines.length) return null;
  const next = lines[positionIdx + 1]!.trim();
  if (!next || isMetadataLabelLine(next) || isScrapedNoiseLine(next)) return null;
  return next;
};

const extractCompanyBeforeTimestamp = (lines: string[]): string | null =>
  extractCompanyFromPostedHeader(lines);

const extractTitleBeforePositionLabel = (lines: string[], companyName: string | null): string | null => {
  const positionIdx = lines.findIndex((l) => lineLower(l) === "position");
  if (positionIdx === -1) return null;

  let start = 0;
  const tsIdx = lines.findIndex((l) => RELATIVE_TIMESTAMP_RE.test(l) || isPostedTimestampLine(l));
  if (tsIdx >= 0) start = tsIdx + 1;
  else if (companyName && lines[0] === companyName) start = 1;

  for (let i = start; i < positionIdx; i++) {
    const line = lines[i]!;
    if (isScrapedNoiseLine(line) || isMetadataLabelLine(line)) continue;
    if (companyName && line === companyName) continue;
    if (isTitleLikeLine(line)) return line;
  }
  return null;
};

const findFallbackCompanyBlock = (lines: string[], knownCompany: string | null): string | null => {
  if (knownCompany && isValidCompanyCandidate(knownCompany)) return knownCompany;
  return (
    extractCompanyFromPostedHeader(lines) ??
    extractDuplicateCompanyBeforeEmployeeCount(lines) ??
    resolveCompanyFromText(lines.join("\n"))
  );
};

const computeConfidence = (meta: Omit<PreScoringJobMetadata, "confidence">): "high" | "medium" | "low" => {
  const hasCompany = Boolean(meta.companyName?.trim());
  const hasTitle = Boolean(meta.jobTitle?.trim());
  const hasLocation = Boolean(meta.location?.trim());
  if (hasCompany && hasTitle && (hasLocation || meta.rawTitleSource.includes(","))) return "high";
  if (hasCompany && hasTitle) return "high";
  if (hasTitle && (hasCompany || hasLocation)) return "medium";
  if (hasTitle) return "medium";
  return "low";
};

/** Primary pre-scoring metadata extractor for scraped / labeled JD layouts. */
export const extractPreScoringMetadata = (rawJobText: string): PreScoringJobMetadata => {
  const lines = normalizeJobLines(rawJobText);
  let companyName: string | null = null;
  let jobTitle: string | null = null;
  let location: string | null = null;
  let rawTitleSource = "";

  const commaFirst = lines[0] ? parseCommaTitleCompany(lines[0]) : null;
  if (commaFirst) {
    jobTitle = commaFirst.jobTitle;
    companyName = commaFirst.companyName;
    rawTitleSource = lines[0]!;
  } else if (lines[0] && isTitleLikeLine(lines[0]!)) {
    // Preserve team/org in titles like "Software Engineer, Reflections".
    jobTitle = lines[0]!;
    rawTitleSource = lines[0]!;
  }

  const hasPositionLabel = lines.some((l) => lineLower(l) === "position");
  if (hasPositionLabel) {
    const scrapedCompany = extractCompanyBeforeTimestamp(lines);
    if (scrapedCompany) companyName = companyName ?? scrapedCompany;

    const scrapedTitle = extractTitleBeforePositionLabel(lines, companyName);
    if (scrapedTitle) {
      jobTitle = scrapedTitle;
      rawTitleSource = rawTitleSource || scrapedTitle;
    }

    const scrapedLocation = extractLocationFromPositionLabel(lines);
    if (scrapedLocation) location = scrapedLocation;
  }

  if (!companyName) {
    companyName = findFallbackCompanyBlock(lines, companyName);
  }

  if (jobTitle) {
    const normalized = normalizeLocationPrefixedTitle(jobTitle);
    if (normalized.location && !location) location = normalized.location;
    jobTitle = normalized.jobTitle;
  } else if (lines.length === 1 && lines[0]) {
    const normalized = normalizeLocationPrefixedTitle(lines[0]);
    if (normalized.jobTitle !== lines[0]) {
      jobTitle = normalized.jobTitle;
      location = location ?? normalized.location;
      rawTitleSource = lines[0];
    }
  }

  const result: PreScoringJobMetadata = {
    companyName:
      companyName && isValidCompanyCandidate(companyName)
        ? companyName
        : findFallbackCompanyBlock(lines, null),
    jobTitle,
    location,
    rawTitleSource,
    confidence: "low",
  };
  result.confidence = computeConfidence(result);
  return result;
};

export const isLocationPrefixedTitle = (title: string | undefined | null): boolean => {
  const t = title?.trim();
  if (!t) return false;
  const normalized = normalizeLocationPrefixedTitle(t);
  return normalized.jobTitle !== t;
};
