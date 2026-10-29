/**
 * Deterministic parsing for Simplify / Jobright-style pasted job chrome.
 */
import { logger } from "../lib/logger.js";
import { env } from "../config/env.js";
import {
  extractPreScoringMetadata,
  isLocationPrefixedTitle,
  isMetadataLabelLine,
  isTitleLikeLine,
  looksLikeLocation,
  type PreScoringJobMetadata,
} from "./preScoringMetadataExtract.js";
import { isBoardMatchChromeLine } from "./jobBoardMatchExtract.js";
import {
  EMPLOYEE_COUNT_RE,
  extractCompanyFromSelfDescription,
  extractDuplicateCompanyBeforeEmployeeCount,
  findBodySectionStartIndex,
  followsMetadataLabelLine,
  isAfterBodySection,
  isCompanyCardFollowerLine,
  isPostedTimestampLine,
  isValidCompanyCandidate,
  normalizeJobLines as normalizeCompanyLines,
  parseExplicitCompanyLabel,
  resolveCompanyFromText,
  sanitizeCompanyName,
} from "./companyCandidateRules.js";

export { isRejectedCompanyCandidate, isValidCompanyCandidate } from "./companyCandidateRules.js";
import { isRejectedCompanyCandidate } from "./companyCandidateRules.js";

export type { PreScoringJobMetadata } from "./preScoringMetadataExtract.js";

export type JobPostingMetadata = {
  companyName: string | null;
  jobTitle: string | null;
  employmentType: string | null;
  location: string | null;
  seniority: string | null;
  salary: string | null;
  workModel: string | null;
  preScoring?: PreScoringJobMetadata;
};

export type CompanyCandidateScore = {
  line: string;
  index: number;
  score: number;
  reasons: string[];
};

const EMPLOYMENT_TYPES = new Set(
  ["contract", "full-time", "full time", "part-time", "part time", "internship", "temporary", "freelance"].map((s) =>
    s.toLowerCase(),
  ),
);

const SENIORITY_LABELS = new Set(
  ["entry", "junior", "mid level", "mid-level", "senior", "staff", "principal", "lead"].map((s) => s.toLowerCase()),
);

const WORK_MODEL_LABELS = new Set(["remote", "hybrid", "in person", "in-person", "onsite", "on-site"].map((s) => s.toLowerCase()));

const NOISE_PREFIXES = [
  "open user menu",
  "updated on",
  "unlock job analytics with",
  "simplify+",
  "applications through a referral",
  "get referrals",
  "connection",
  "logo",
  "history",
  "summary",
  "full job posting",
  "why this job is a match",
  "see more like this?",
  "yes",
  "no",
  "matched based on",
  "change preferences",
  "category",
  "required skills",
  "compensation overview",
];

const NEGATIVE_COMPANY_PREFIXES = ["what ", "how ", "why ", "about ", "our company", "the "];

const ROLE_TITLE_RE =
  /\b((?:full[\s-]?stack|fullstack|frontend|backend|platform|infrastructure|machine learning|site reliability|product)\s+)?(?:engineer|developer|software|devops|sre|scientist|architect|analyst|designer|programmer|enablement)\b|\b(?:forward deployed|ai enablement|ai engineer|full stack|fullstack)\b/i;

const EMPLOYEE_COUNT_LINE_RE = EMPLOYEE_COUNT_RE;
const UPDATED_ON_RE = /^updated on\b/i;
const LOCATION_RE = /^[A-Za-z][A-Za-z .'-]+,\s*[A-Z]{2}(?:,\s*(?:USA|US))?$/;
const SALARY_LINE_RE = /^\$?\d[\d,k.]*\s*-\s*\$?\d[\d,k.]*\s*\/\s*yr$/i;

export const normalizeJobLines = (rawJobText: string): string[] => normalizeCompanyLines(rawJobText);

const lineLower = (line: string): string => line.trim().toLowerCase();

export const isNoiseLine = (line: string): boolean => {
  const low = lineLower(line);
  if (!low) return true;
  return NOISE_PREFIXES.some((p) => low === p || low.startsWith(p));
};

export const isEmployeeCountLine = (line: string): boolean => EMPLOYEE_COUNT_LINE_RE.test(line.trim());

export const isProbablyNotCompany = (line: string): boolean => isRejectedCompanyCandidate(line);

const isLineUnusableForTitle = (line: string): boolean => {
  const trimmed = line.trim();
  const low = lineLower(trimmed);
  if (!low) return true;
  if (isNoiseLine(trimmed)) return true;
  if (isBoardMatchChromeLine(trimmed)) return true;
  if (isPostedTimestampLine(trimmed)) return true;
  if (isMetadataLabelLine(trimmed)) return true;
  if (EMPLOYMENT_TYPES.has(low)) return true;
  if (looksLikeLocation(trimmed)) return true;
  if (UPDATED_ON_RE.test(low)) return true;
  if (isEmployeeCountLine(trimmed)) return true;
  if (isRejectedCompanyCandidate(trimmed) && !isTitleLikeLine(trimmed)) return true;
  if (/^about\b/i.test(trimmed)) return true;
  return false;
};

const isTitleCaseOrBrand = (line: string): boolean => {
  const words = line.trim().split(/\s+/);
  if (!words.length) return false;
  if (words.length === 1 && /^[A-Z0-9&.+]+$/.test(words[0]!) && words[0]!.length <= 24) return true;
  return words.every((w) => /^[A-Z][A-Za-z0-9&.'-]*$/.test(w) || /^[A-Z]{2,}$/.test(w));
};

const findLineIndex = (lines: string[], pred: (line: string, i: number) => boolean): number => {
  const idx = lines.findIndex((l, i) => pred(l, i));
  return idx;
};

export const extractJobTitleFromLines = (lines: string[]): string | null => {
  const updatedIdx = findLineIndex(lines, (l) => UPDATED_ON_RE.test(l));
  const searchEnd = updatedIdx >= 0 ? updatedIdx : Math.min(lines.length, 12);

  for (let i = 0; i < searchEnd; i++) {
    const line = lines[i]!;
    if (isLineUnusableForTitle(line)) continue;
    if (!ROLE_TITLE_RE.test(line)) continue;
    if (line.length > 120) continue;
    return line;
  }

  for (let i = 0; i < searchEnd; i++) {
    const line = lines[i]!;
    if (isLineUnusableForTitle(line)) continue;
    if (isTitleLikeLine(line)) return line;
    if (line.length >= 8 && line.length <= 100) return line;
  }
  return null;
};

export const extractEmploymentTypeFromLines = (lines: string[]): string | null => {
  for (let i = 0; i < Math.min(lines.length, 8); i++) {
    const line = lines[i]!;
    if (EMPLOYMENT_TYPES.has(lineLower(line))) return line;
  }
  return null;
};

export const extractWorkModelFromLines = (lines: string[]): string | null => {
  for (const line of lines.slice(0, 30)) {
    const low = lineLower(line);
    if (WORK_MODEL_LABELS.has(low)) return line;
  }
  return null;
};

export const extractSeniorityFromLines = (lines: string[]): string | null => {
  for (const line of lines.slice(0, 30)) {
    if (SENIORITY_LABELS.has(lineLower(line))) return line;
  }
  return null;
};

export const extractLocationFromLines = (lines: string[]): string | null => {
  for (const line of lines.slice(0, 30)) {
    if (LOCATION_RE.test(line.trim())) return line;
  }
  return null;
};

export const extractSalaryLabelFromLines = (lines: string[]): string | null => {
  for (const line of lines.slice(0, 30)) {
    const low = lineLower(line);
    if (low === "no salary listed") return line;
    if (SALARY_LINE_RE.test(line)) return line;
  }
  return null;
};

export const scoreCompanyCandidates = (lines: string[]): CompanyCandidateScore[] => {
  const title = extractJobTitleFromLines(lines);
  const titleIdx = title ? lines.findIndex((l) => l === title) : -1;
  const positionIdx = lines.findIndex((l) => lineLower(l) === "position");
  const bodyStart = findBodySectionStartIndex(lines);
  const headerEnd = Math.min(
    titleIdx >= 0 ? titleIdx : lines.length,
    positionIdx >= 0 ? positionIdx : lines.length,
    bodyStart,
    15,
  );
  const scores: CompanyCandidateScore[] = [];

  for (let i = 0; i < Math.min(lines.length, 40); i++) {
    const line = lines[i]!;
    if (isNoiseLine(line)) continue;
    if (title && line === title) continue;
    if (isTitleLikeLine(line)) continue;

    const explicit = parseExplicitCompanyLabel(line);
    if (explicit && isValidCompanyCandidate(explicit)) {
      scores.push({ line: explicit, index: i, score: 500, reasons: ["explicit_label"] });
      continue;
    }

    if (isAfterBodySection(lines, i) && !parseExplicitCompanyLabel(line)) continue;
    if (followsMetadataLabelLine(lines, i)) continue;
    if (!isValidCompanyCandidate(line)) continue;

    let score = 0;
    const reasons: string[] = [];

    const prev = i > 0 ? lines[i - 1]! : "";
    const next = i + 1 < lines.length ? lines[i + 1]! : "";
    const duplicatePattern =
      (prev && lineLower(prev) === lineLower(line)) || (next && lineLower(next) === lineLower(line));

    if (duplicatePattern) {
      score += 55;
      reasons.push("consecutive_duplicate");
    }
    if (next && isCompanyCardFollowerLine(next)) {
      score += 45;
      reasons.push(isEmployeeCountLine(next) ? "before_employee_count" : "before_company_card");
    }
    if (next && isPostedTimestampLine(next)) {
      score += 120;
      reasons.push("before_activity_timestamp");
    }
    if (i < headerEnd) {
      score += 50;
      reasons.push("header_region");
    } else if (!duplicatePattern && !(next && isCompanyCardFollowerLine(next))) {
      continue;
    }
    if (i < 8) {
      score += Math.max(0, 10 - i);
      reasons.push("near_top");
    }
    const wordCount = line.split(/\s+/).length;
    if (wordCount >= 1 && wordCount <= 4) {
      score += 10;
      reasons.push("short_brand_length");
    }
    if (isTitleCaseOrBrand(line)) {
      score += 8;
      reasons.push("brand_casing");
    }

    if (score > 0) scores.push({ line, index: i, score, reasons });
  }

  scores.sort((a, b) => b.score - a.score || a.index - b.index);
  return scores;
};

export const extractCompanyName = (rawJobText: string, options?: {
  companyHint?: string | null;
  llmCompany?: string | null;
  preScoringCompany?: string | null;
}): string | null => resolveCompanyFromText(rawJobText, options);

export const extractJobPostingMetadata = (rawJobText: string): JobPostingMetadata => {
  const lines = normalizeJobLines(rawJobText);
  const preScoring = extractPreScoringMetadata(rawJobText);
  const simplify = {
    companyName: extractCompanyName(rawJobText),
    jobTitle: extractJobTitleFromLines(lines),
    employmentType: extractEmploymentTypeFromLines(lines),
    location: extractLocationFromLines(lines),
    seniority: extractSeniorityFromLines(lines),
    salary: extractSalaryLabelFromLines(lines),
    workModel: extractWorkModelFromLines(lines),
  };

  const preferPreScoring = preScoring.confidence === "high" || preScoring.confidence === "medium";
  const preScoringCompany =
    preScoring.companyName && isValidCompanyCandidate(preScoring.companyName)
      ? preScoring.companyName
      : null;
  const simplifyCompany = simplify.companyName && isValidCompanyCandidate(simplify.companyName)
    ? simplify.companyName
    : null;
  return {
    companyName: preferPreScoring
      ? preScoringCompany ?? simplifyCompany ?? extractCompanyName(rawJobText)
      : simplifyCompany ?? preScoringCompany ?? extractCompanyName(rawJobText),
    jobTitle: preferPreScoring ? preScoring.jobTitle ?? simplify.jobTitle : simplify.jobTitle ?? preScoring.jobTitle,
    location: preScoring.location ?? simplify.location,
    employmentType: simplify.employmentType,
    seniority: simplify.seniority,
    salary: simplify.salary,
    workModel: simplify.workModel,
    preScoring,
  };
};

export const isWeakOrPlaceholderCompany = (company: string | undefined | null): boolean => {
  const t = company?.trim();
  if (!t) return true;
  if (/^unknown company$/i.test(t)) return true;
  return isProbablyNotCompany(t) || isNoiseLine(t);
};

export const isWeakJobTitle = (title: string | undefined | null): boolean => {
  const t = title?.trim();
  if (!t || /^unknown title$/i.test(t)) return true;
  if (/^\d{1,3}%$/.test(t)) return true;
  if (isBoardMatchChromeLine(t)) return true;
  if (EMPLOYMENT_TYPES.has(lineLower(t))) return true;
  if (isNoiseLine(t)) return true;
  if (isLocationPrefixedTitle(t)) return true;
  if (looksLikeLocation(t)) return true;
  if (/^about\b/i.test(t)) return true;
  if (!ROLE_TITLE_RE.test(t) && t.length < 12) return true;
  return false;
};

/** If Unknown/wrong company, recover from repeated line before employee count. */
export const validateExtractedCompany = (
  company: string | null | undefined,
  rawJobText: string,
  companyHint?: string,
): string | null =>
  sanitizeCompanyName(company, rawJobText, companyHint) ??
  resolveCompanyFromText(rawJobText, { companyHint, llmCompany: company ?? null });

export const logJobPostingMetadataDebug = (
  rawJobText: string,
  meta: JobPostingMetadata,
  selectedReason?: string,
): void => {
  if (env.nodeEnv !== "development") return;
  const lines = normalizeJobLines(rawJobText);
  const candidates = scoreCompanyCandidates(lines).slice(0, 8);
  logger.info("job posting metadata extract", {
    firstLines: lines.slice(0, 30),
    extractedJobTitle: meta.jobTitle,
    extractedCompanyName: meta.companyName,
    extractedLocation: meta.location,
    preScoring: meta.preScoring,
    companyCandidates: candidates,
    selectedReason: selectedReason ?? (candidates[0]?.reasons.join(", ") || meta.preScoring?.rawTitleSource || "none"),
  });
};
