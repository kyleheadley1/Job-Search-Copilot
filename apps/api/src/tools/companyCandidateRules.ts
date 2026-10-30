/**
 * Centralized company candidate validation and ranked extraction.
 * Every company source must pass isValidCompanyCandidate before merge/display.
 */
import { isBoardMatchChromeLine } from "./jobBoardMatchExtract.js";

export type CompanySource =
  | "user_hint"
  | "posted_header"
  | "duplicate_before_employee_count"
  | "labeled_field"
  | "view_more_jobs"
  | "self_description"
  | "at_company"
  | "domain"
  | "follow_company"
  | "about_header"
  | "recruiter_disclaimer"
  | "llm"
  | "fallback_scoring";

export const COMPANY_SOURCE_RANK: Record<CompanySource, number> = {
  user_hint: 100,
  posted_header: 95,
  duplicate_before_employee_count: 90,
  labeled_field: 88,
  view_more_jobs: 87,
  self_description: 86,
  at_company: 85,
  domain: 84,
  follow_company: 83,
  about_header: 80,
  recruiter_disclaimer: 82,
  llm: 60,
  fallback_scoring: 40,
};

export type CompanyCandidate = {
  value: string;
  source: CompanySource;
  rank: number;
};

export const LOCATION_COMPANY_REJECT_EXACT = new Set(
  [
    "us",
    "u.s",
    "u.s.",
    "usa",
    "u.s.a",
    "u.s.a.",
    "united states",
    "united states of america",
    "remote",
    "onsite",
    "on-site",
    "hybrid",
    "in person",
    "new york",
    "ny",
    "nyc",
    "san francisco",
    "sf",
    "california",
    "ca",
    "bay area",
    "location",
    "locations",
    "more locations",
  ].map((s) => s.toLowerCase()),
);

export const SENIORITY_COMPANY_REJECT_EXACT = new Set(
  [
    "entry level",
    "entry-level",
    "mid level",
    "mid-level",
    "senior level",
    "senior-level",
    "junior level",
    "junior-level",
    "junior",
    "senior",
    "staff",
    "principal",
    "lead",
    "intern",
    "internship",
    "associate",
    "director",
    "manager",
    "junior and mid level",
  ].map((s) => s.toLowerCase()),
);

export const METADATA_LABEL_LINES = new Set(
  ["position", "time", "remote", "seniority", "money", "date", "category"].map((s) => s.toLowerCase()),
);

export const LEGAL_ENTITY_SUFFIX_RE =
  /(?:,\s*)?(Inc|LLC|Corp|Corporation|Ltd|Co|Company|LP|LLP|PLC|GmbH)\.?$/i;

export const COMPANY_PROSE_REJECTORS: RegExp[] = [
  /\b(including|using|with|within|through|across|between|among|for|from|to)\b/i,
  /\b(stakeholders|clients|customers|users|teams|members|leaders|engineers|scientists|mathematicians|statisticians|epidemiologist|developers|operators|executives)\b/i,
  /\b(communicating|solving|conducting|participating|managing|developing|designing|implementing|maintaining|working|collaborating|debugging|shipping|building|owning|deploying)\b/i,
  /\b(requirements?|responsibilities|qualification|qualifications|preferred|required|skills?|experience|ability|knowledge|benefits|salary|compensation|category|connection|history|summary)\b/i,
];

/** Sentence-starters / pronouns — never valid company names when scraped from JD prose. */
export const COMPANY_NAME_STOPWORDS = new Set(
  [
    "this",
    "the",
    "we",
    "our",
    "you",
    "their",
    "as",
    "at",
    "join",
    "work",
    "build",
    "apply",
    "here",
    "it",
    "that",
    "these",
    "those",
    "a",
    "an",
    "there",
  ].map((s) => s.toLowerCase()),
);

const JOB_BOARD_DOMAIN_SLUGS = new Set([
  "greenhouse",
  "lever",
  "ashby",
  "workday",
  "linkedin",
  "indeed",
  "glassdoor",
  "jobs",
  "www",
  "apply",
  "careers",
]);

export function isCompanyNameStopword(name: string): boolean {
  const trimmed = name.trim();
  if (!trimmed) return true;
  const key = normalizeCompanyCandidateKey(trimmed);
  if (COMPANY_NAME_STOPWORDS.has(key)) return true;
  if (!trimmed.includes(" ") && COMPANY_NAME_STOPWORDS.has(key)) return true;
  // "This Role" / "The Company" from "About This Role" section chrome — not employers.
  if (/^(this|the|our|a|an)\s+(role|company|team|job|position|opportunity)$/i.test(trimmed)) {
    return true;
  }
  return false;
}

export function companyNameFromDomainSlug(slug: string): string | null {
  const cleaned = slug
    .trim()
    .toLowerCase()
    .replace(/\.(com|io|co|ai|dev|app|org|net)$/i, "")
    .replace(/[_-]+/g, " ");
  if (!cleaned || cleaned.length < 2 || cleaned.length > 32) return null;
  if (JOB_BOARD_DOMAIN_SLUGS.has(cleaned)) return null;
  if (isCompanyNameStopword(cleaned)) return null;
  const words = cleaned.split(/\s+/).filter(Boolean);
  const titled = words
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
  return isValidCompanyCandidate(titled) ? titled : null;
}

const JOB_TITLE_LIKE_RE =
  /\b((?:full[\s-]?stack|frontend|backend|platform|product|deployment|forward deployed|machine learning|site reliability|ai enablement)\s+)?(?:engineer|developer|software|devops|sre|scientist|architect|analyst|designer|programmer|manager|director|lead|specialist|coordinator)\b|\b(?:product\s*&\s*deployment|forward deployed)\b/i;

export const POSTED_TIMESTAMP_RE =
  /^(?:[·•\-|]\s*)?(?:reposted|posted)?\s*(?:\d+\s+(?:minute|minutes|hour|hours|day|days|week|weeks|month|months)\s+ago|on\s+\d{1,2}\/\d{1,2}\/\d{2,4}|on\s+[A-Z][a-z]+\s+\d{1,2},?\s+\d{4})/i;

export const EMPLOYEE_COUNT_RE =
  /^\d{1,3}(?:,\d{3})?(?:\s*-\s*\d{1,3}(?:,\d{3})?|\+)?\s+employees$/i;

export const BODY_SECTION_HEADER_RE =
  /^(responsibilities|qualification|qualifications|required|preferred|what you.?ll do|what you.?ll be doing|what we.?re looking for|who we are|who you are|about the role|about this role|about the company|about you|overview|company|role|this role|the role|what success looks like|this role is for you if|this role is likely not for you if|our tech stack|our benefits|workplace policy|equal opportunity|candidate privacy notice|accommodations|what the job involves|what we\s*build|why this(?:\s+job)?)$/i;

/** Verbs in "{Company} is reinventing/building/..." or "{Company} delivers/provides/..." hiring-entity intros. */
const HIRING_ENTITY_SELF_DESCRIPTION_RE =
  /^(.{2,48}?)\s+(?:is\s+(?:a|an|the|building|hiring|looking|seeking|reinventing|transforming|leading|helping|partnering|creating|developing|scaling|growing|expanding|disrupting|delivering|providing|offering|empowering|powering|launching|operating|on a mission)|delivers|provides|offers|builds|helps|powers|enables)\b/i;

/** @deprecated use POSTED_TIMESTAMP_RE */
export const ACTIVITY_TIMESTAMP_RE = POSTED_TIMESTAMP_RE;
/** @deprecated use POSTED_TIMESTAMP_RE */
export const ACTIVITY_LINE_RE = POSTED_TIMESTAMP_RE;

export function normalizeJobLines(rawJobText: string): string[] {
  return rawJobText
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
}

export function normalizeCompanyCandidateKey(line: string): string {
  return line
    .trim()
    .toLowerCase()
    .replace(/['']/g, "'")
    .replace(/\s+/g, " ")
    .replace(/[:;,]+$/g, "");
}

/** Job-board UI tab/section headers — never valid company names. */
export const JOB_BOARD_UI_SECTION_HEADERS = new Set(
  [
    "why this",
    "why this job",
    "why this job is a match",
    "what we build",
    "offers equity",
    "creator home",
    "summary",
    "full job posting",
    "history",
    "company",
    "role",
    "about the role",
    "about this role",
    "this role",
    "the role",
    "our team",
    "the company",
    "about us",
    "what success looks like",
    "about the company",
    "what you'll do",
    "what you'll be doing",
    "what we're looking for",
    "overview",
    "who we are",
    "simplify",
    "simplify+",
    "compensation overview",
  ].map((s) => normalizeCompanyCandidateKey(s)),
);

export function isJobBoardUiSectionHeader(line: string): boolean {
  const key = normalizeCompanyCandidateKey(line);
  if (JOB_BOARD_UI_SECTION_HEADERS.has(key)) return true;
  if (key === "why this" || key.startsWith("why this ")) return true;
  if (key === "what we build" || key.startsWith("what we build ")) return true;
  return false;
}

/** Generic org/section words that are never a hiring-entity name. */
const GENERIC_ORG_AS_COMPANY = new Set(
  ["product", "equity", "home", "engineering", "marketing", "news", "content", "about"].map((s) =>
    s.toLowerCase(),
  ),
);

/** Strip leading emoji / decorative glyphs so "👶 About Junior" still matches. */
export function stripLeadingLineDecorators(line: string): string {
  return line
    .trim()
    .replace(/^(?:[\p{Extended_Pictographic}\p{Emoji_Presentation}\uFE0F\u200D]+\s*)+/gu, "")
    .trim();
}

/**
 * When About/self-desc captures a seniority-colliding short brand ("Junior") that fails
 * validation, upgrade to a fuller brand present in the listing ("Junior AI").
 */
export function expandSeniorityCollidingBrand(shortName: string, lines: string[]): string | null {
  const key = normalizeCompanyCandidateKey(shortName);
  if (!key || !SENIORITY_COMPANY_REJECT_EXACT.has(key)) return null;
  for (const line of lines.slice(0, 50)) {
    const trimmed = stripLeadingLineDecorators(line);
    const lineKey = normalizeCompanyCandidateKey(trimmed);
    if (!lineKey.startsWith(`${key} `)) continue;
    if (isValidCompanyCandidate(trimmed)) return trimmed;
  }
  return null;
}

/** Simplify company-card followers after a duplicated employer name. */
export function isCompanyCardFollowerLine(line: string): boolean {
  const trimmed = line.trim();
  if (EMPLOYEE_COUNT_RE.test(trimmed)) return true;
  const key = normalizeCompanyCandidateKey(trimmed);
  return key === "compensation overview";
}

export function isLocationOrCountryCompanyCandidate(line: string): boolean {
  const trimmed = line.trim();
  const key = normalizeCompanyCandidateKey(trimmed);

  if (!key) return true;
  if (LOCATION_COMPANY_REJECT_EXACT.has(key)) return true;
  if (/^[a-z]{1,3}$/.test(trimmed)) return true;
  if (/\b(?:USA|U\.S\.|United States)\b/i.test(trimmed)) return true;
  if (/\bmore locations?\b/i.test(trimmed)) return true;
  if (/\bremote in\b/i.test(trimmed)) return true;
  if (/\+\s*\d+\s+more/i.test(trimmed)) return true;
  if (/^remote\b/i.test(trimmed) && trimmed.split(/\s+/).length > 1) return true;
  if (LEGAL_ENTITY_SUFFIX_RE.test(trimmed)) return false;
  if (
    /^[A-Z][A-Za-z .'-]+,\s*[A-Z]{2}\b(?:,\s*(?:USA|U\.S\.|United States))?\s*$/i.test(trimmed)
  ) {
    return true;
  }
  return false;
}

export function isSeniorityOrLevelCompanyCandidate(line: string): boolean {
  const key = normalizeCompanyCandidateKey(line);
  if (!key) return true;
  if (SENIORITY_COMPANY_REJECT_EXACT.has(key)) return true;
  if (/^(entry|junior|mid|senior|staff|principal|lead)[\s-]?level$/i.test(key)) return true;
  return false;
}

export function followsMetadataLabelLine(lines: string[], index: number): boolean {
  if (index <= 0) return false;
  return METADATA_LABEL_LINES.has(normalizeCompanyCandidateKey(lines[index - 1] ?? ""));
}

export function isLegalEntityCompanyName(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed || trimmed.length > 48) return false;
  if (!LEGAL_ENTITY_SUFFIX_RE.test(trimmed)) return false;
  if (!/^[A-Z]/.test(trimmed)) return false;
  if (isSeniorityOrLevelCompanyCandidate(trimmed)) return false;
  if (isLocationOrCountryCompanyCandidate(trimmed)) return false;
  if (isJobTitleLikeLine(trimmed)) return false;
  if (trimmed.split(/\s+/).length > 6) return false;
  return true;
}

export function isJobTitleLikeLine(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed) return false;
  // Employer names like "MNJ SOFTWARE" — not job titles.
  if (/^[A-Z][A-Za-z0-9&.'-]+\s+Software$/i.test(trimmed)) return false;
  return JOB_TITLE_LIKE_RE.test(trimmed);
}

/** Short dotted brands (e.Republic, St. Jude) — not prose despite punctuation. */
export function isStylizedDottedBrandName(name: string): boolean {
  const trimmed = name.trim();
  if (!trimmed || trimmed.length > 32) return false;
  return /^[A-Za-z0-9]{1,4}\.[A-Za-z][A-Za-z0-9'-]{0,24}$/.test(trimmed);
}

export function isCompanyProseCandidate(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed) return true;
  if (isStylizedDottedBrandName(trimmed)) return false;
  if (isJobTitleLikeLine(trimmed)) return true;
  if (isSeniorityOrLevelCompanyCandidate(trimmed)) return true;
  if (isLegalEntityCompanyName(trimmed)) return false;
  if (trimmed.length > 60) return true;
  if (trimmed.split(/\s+/).length > 5) return true;
  if (/[,.;:!?]/.test(trimmed)) return true;
  return COMPANY_PROSE_REJECTORS.some((re) => re.test(trimmed));
}

const COMPANY_NAME_PARTICLES = new Set(["of", "the", "and", "&"]);

/**
 * Simplify-style "Tria Federal (Tria)" — brand + parenthetical short alias.
 * Returns the core name without the alias when the paren looks like a short brand tag.
 */
export function stripParentheticalCompanyAlias(line: string): string {
  const trimmed = line.trim();
  const m = trimmed.match(/^(.+?)\s*\(([A-Za-z0-9&'.-]{1,24})\)\s*$/);
  if (!m?.[1] || !m[2]) return trimmed;
  const core = m[1].trim();
  if (!core || core.length > 40) return trimmed;
  // Avoid stripping legal-entity or location-looking paren noise.
  if (/^(inc|llc|ltd|corp|co|usa|us)$/i.test(m[2])) return trimmed;
  return core;
}

function hasAcceptableCompanyWordCasing(trimmed: string): boolean {
  const words = trimmed.split(/\s+/);
  return words.every((word, index) => {
    if (index > 0 && COMPANY_NAME_PARTICLES.has(word.toLowerCase())) return true;
    return /^[A-Z0-9&]/.test(word);
  });
}

export function isBrandLikeCompany(line: string): boolean {
  const trimmed = line.trim();
  const core = stripParentheticalCompanyAlias(trimmed);
  // Validate the core brand when Simplify appends "(ShortName)".
  if (core !== trimmed) return isBrandLikeCompany(core);

  const words = trimmed.split(/\s+/);

  if (!trimmed) return false;
  if (words.length < 1 || words.length > 4) return false;
  if (trimmed.length > 45) return false;
  if (isSeniorityOrLevelCompanyCandidate(trimmed)) return false;
  if (isLegalEntityCompanyName(trimmed)) return true;
  if (isLocationOrCountryCompanyCandidate(trimmed)) return false;
  if (isCompanyProseCandidate(trimmed)) return false;

  if (
    /^(posted|reposted|position|time|remote|seniority|money|category|required|preferred|summary|history|full job posting|why this(?: job)?|why this job is a match|what we build|offers equity|creator home|contract|full-time|full time|part-time|part time|internship|temporary|freelance|strong match|experience\. level|industry exp\.?)$/i.test(
      trimmed,
    )
  ) {
    return false;
  }

  if (
    /^[A-Z][A-Za-z0-9&'.-]*(?:\s+[A-Z][A-Za-z0-9&'.-]*){0,3}$/.test(trimmed) ||
    isStylizedDottedBrandName(trimmed) ||
    (hasAcceptableCompanyWordCasing(trimmed) &&
      /^[A-Z][A-Za-z0-9&'.-]*/.test(trimmed) &&
      words.length <= 4)
  ) {
    return true;
  }

  return (
    /\b(Inc|LLC|Labs|AI|Technologies|Systems|Group|Health|Research|Corporation|Corp|University|Institute|Ventures|Capital)\b/.test(
      trimmed,
    ) ||
    (/^[A-Z0-9&.+]{2,}$/.test(trimmed) && words.length === 1)
  );
}

export function isValidCompanyCandidate(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed) return false;
  if (isJobBoardUiSectionHeader(trimmed)) return false;
  if (GENERIC_ORG_AS_COMPANY.has(normalizeCompanyCandidateKey(trimmed))) return false;
  if (isCompanyNameStopword(trimmed)) return false;
  if (isBoardMatchChromeLine(trimmed)) return false;
  if (/^\d{1,3}%$/.test(trimmed)) return false;
  if (isSeniorityOrLevelCompanyCandidate(trimmed)) return false;
  // Parenthetical alias: validate core brand ("Tria Federal (Tria)" → "Tria Federal").
  const core = stripParentheticalCompanyAlias(trimmed);
  if (core !== trimmed) return isValidCompanyCandidate(core);
  if (isLegalEntityCompanyName(trimmed)) return true;
  if (isLocationOrCountryCompanyCandidate(trimmed)) return false;
  if (isCompanyProseCandidate(trimmed)) return false;
  if (!isBrandLikeCompany(trimmed)) return false;
  return true;
}

export function isRejectedCompanyCandidate(line: string): boolean {
  return !isValidCompanyCandidate(line);
}

/** @deprecated use isValidCompanyCandidate */
export function isHardRejectedCompanyCandidate(line: string): boolean {
  return isRejectedCompanyCandidate(line);
}

/** @deprecated use isBrandLikeCompany */
export function looksLikeBrandCompanyName(line: string): boolean {
  return isBrandLikeCompany(line);
}

export function isPostedTimestampLine(line: string): boolean {
  return POSTED_TIMESTAMP_RE.test(line.trim());
}

/** @deprecated use isPostedTimestampLine */
export const isActivityTimestampLine = isPostedTimestampLine;

export function isBodySectionHeaderLine(line: string): boolean {
  const trimmed = line.trim();
  return isJobBoardUiSectionHeader(trimmed) || BODY_SECTION_HEADER_RE.test(trimmed);
}

export function isAfterBodySection(lines: string[], index: number): boolean {
  for (let i = 0; i <= index; i++) {
    if (isBodySectionHeaderLine(lines[i] ?? "")) return true;
  }
  return false;
}

export function findBodySectionStartIndex(lines: string[]): number {
  for (let i = 0; i < lines.length; i++) {
    if (isBodySectionHeaderLine(lines[i]!)) return i;
  }
  return lines.length;
}

export const isInBodySection = isAfterBodySection;

export function parseExplicitCompanyLabel(line: string): string | null {
  const trimmed = line.trim();
  const labeled = trimmed.match(/^(?:company|employer)\s*:\s*(.+)$/i);
  if (labeled?.[1]) {
    const value = labeled[1].trim();
    return isValidCompanyCandidate(value) ? value : null;
  }
  const about = trimmed.match(/^about\s+(.+)$/i);
  if (about?.[1]) {
    const value = about[1].trim();
    return isValidCompanyCandidate(value) ? value : null;
  }
  return null;
}

/**
 * Company immediately before a Posted/Reposted timestamp — but NOT the chrome
 * line sandwiched between a job title and the date (e.g. Simplify "Link" UI).
 * Prefer duplicate-before-employee-count / labeled Company when that pattern appears.
 * Tolerate a lone middot/bullet line between company and "N hours ago".
 */
export function extractCompanyFromPostedHeader(lines: string[]): string | null {
  const clean = lines.map((l) => l.trim()).filter(Boolean);
  for (let i = 0; i < Math.min(clean.length - 1, 8); i++) {
    const current = clean[i]!;
    if (isJobTitleLikeLine(current)) continue;
    // Title → chrome → "Posted on …" is UI noise, not an employer field.
    if (i > 0 && isJobTitleLikeLine(clean[i - 1]!)) continue;

    let nextIdx = i + 1;
    // Simplify often inserts a lone "·" between company and "3 hours ago".
    if (nextIdx < clean.length && /^[·•\-|]$/.test(clean[nextIdx]!)) {
      nextIdx += 1;
    }
    const next = clean[nextIdx];
    if (!next) continue;

    if (isValidCompanyCandidate(current) && isPostedTimestampLine(next)) {
      return current;
    }
  }
  return null;
}

/** @deprecated use extractCompanyFromPostedHeader */
export const extractHeaderCompanyBeforeActivity = extractCompanyFromPostedHeader;

export function extractDuplicateCompanyBeforeEmployeeCount(lines: string[]): string | null {
  const clean = lines.map((l) => l.trim()).filter(Boolean);
  for (let i = 2; i < clean.length; i++) {
    const current = clean[i]!;
    const prev = clean[i - 1]!;
    const prevPrev = clean[i - 2]!;
    // GreenLite/Stripe: Company\nCompany\n51-200 employees
    // Junior AI: Company\nCompany\nCompensation Overview
    if (!isCompanyCardFollowerLine(current)) continue;
    if (prev !== prevPrev) continue;
    if (!isValidCompanyCandidate(prev)) continue;
    return prev;
  }
  return null;
}

export function extractCompanyFromAboutHeader(lines: string[]): string | null {
  for (const line of lines) {
    const trimmed = stripLeadingLineDecorators(line);
    const match = trimmed.match(
      /^About\s+([A-Z][A-Za-z0-9&'.-]*(?:\s+[A-Z][A-Za-z0-9&'.-]*){0,3})$/i,
    );
    if (!match?.[1]) continue;
    const company = match[1].trim();
    if (isValidCompanyCandidate(company)) return company;
    const expanded = expandSeniorityCollidingBrand(company, lines);
    if (expanded) return expanded;
  }
  return null;
}

export function extractCompanyFromSelfDescriptionLines(lines: string[]): string | null {
  for (const line of lines) {
    const trimmed = stripLeadingLineDecorators(line);
    const match = trimmed.match(HIRING_ENTITY_SELF_DESCRIPTION_RE);
    if (!match?.[1]) continue;
    const company = match[1].trim();
    if (isCompanyNameStopword(company)) continue;
    if (isJobBoardUiSectionHeader(company)) continue;
    if (isValidCompanyCandidate(company)) return company;
    const expanded = expandSeniorityCollidingBrand(company, lines);
    if (expanded) return expanded;
  }
  return null;
}

/** Prefer in-body hiring entity from "{Company} is reinventing/..." or "About {Company}". */
export function extractBodyHiringEntityFromJd(rawJobText: string): string | null {
  const lines = normalizeJobLines(rawJobText);
  const selfDesc = extractCompanyFromSelfDescriptionLines(lines);
  if (selfDesc) return selfDesc;
  const about = extractCompanyFromAboutHeader(lines);
  if (about) return about;
  return null;
}

export function extractCompanyFromRecruiterDisclaimer(rawJobText: string): string | null {
  const match = rawJobText.match(
    /\bno\s+fee\s+(?:the\s+)?([A-Z][A-Za-z0-9&.'\- ]{2,48}?)\s+(?:does\s+not|do\s+not)\s+charge\b/i,
  );
  if (!match?.[1]) return null;
  const company = match[1].trim().replace(/^the\s+/i, "").replace(/[,.;:]+$/, "");
  if (!company || isCompanyNameStopword(company)) return null;
  // High-confidence disclaimer wording — accept even when trailing "Software" trips title heuristics.
  if (isValidCompanyCandidate(company)) return company;
  if (/^[A-Z][A-Za-z0-9&.'-]+(?:\s+[A-Z][A-Za-z0-9&.'-]+){0,3}$/.test(company)) return company;
  return null;
}

export function extractCompanyFromViewMoreJobs(rawJobText: string): string | null {
  const match = rawJobText.match(
    /\bview\s+\d+\s+more\s+jobs?\s+at\s+([A-Z][A-Za-z0-9&.'\- ]{1,48})\b/i,
  );
  if (!match?.[1]) return null;
  const company = match[1].trim().replace(/[,.;:]+$/, "");
  return isValidCompanyCandidate(company) ? company : null;
}

export function extractCompanyFromAtCompany(rawJobText: string): string | null {
  const match = rawJobText.match(/\bAt\s+([A-Z][A-Za-z0-9&.'\- ]{1,48}),/);
  if (!match?.[1]) return null;
  const company = match[1].trim();
  return isValidCompanyCandidate(company) ? company : null;
}

export function extractCompanyFromFollowPattern(lines: string[]): string | null {
  for (const line of lines.slice(0, 40)) {
    const match = line.trim().match(/^Follow\s+(@?)([A-Z][A-Za-z0-9&.'\- ]{1,48})\s*$/i);
    if (!match?.[2]) continue;
    const company = match[2].trim();
    if (isValidCompanyCandidate(company)) return company;
  }
  return null;
}

export function extractCompanyFromDomain(rawJobText: string): string | null {
  const blob = rawJobText.slice(0, 12_000);
  const utm = blob.match(/[?&]utm_source=([a-z0-9][a-z0-9._-]{1,30})/i);
  if (utm?.[1]) {
    const fromUtm = companyNameFromDomainSlug(utm[1]);
    if (fromUtm) return fromUtm;
  }

  const boardSlug = blob.match(
    /\b(?:greenhouse|lever|ashby|workday)\.(?:io|com)\/([a-z0-9][a-z0-9_-]{1,30})\b/i,
  );
  if (boardSlug?.[1]) {
    const fromBoard = companyNameFromDomainSlug(boardSlug[1]);
    if (fromBoard) return fromBoard;
  }

  const domainMatches = blob.matchAll(
    /(?:https?:\/\/)?(?:www\.)?([a-z0-9][a-z0-9-]{1,30})\.(com|io|co|ai|dev|app)\b/gi,
  );
  for (const domainMatch of domainMatches) {
    const fromDomain = companyNameFromDomainSlug(domainMatch[1]!);
    if (fromDomain) return fromDomain;
  }

  return null;
}

export function extractCompanyFromApplicationsFooter(rawJobText: string): string | null {
  const match = rawJobText.match(
    /\b([A-Z][A-Za-z0-9&.'-]+(?:\s+[A-Z][A-Za-z0-9&.'-]+){0,3})\s+accepts applications\b/i,
  );
  if (!match?.[1]) return null;
  const company = match[1].trim();
  return isValidCompanyCandidate(company) ? company : null;
}

export function extractCompanyFromSelfDescription(rawJobText: string): string | null {
  return extractCompanyFromSelfDescriptionLines(normalizeJobLines(rawJobText));
}

export function pickBestCompanyCandidate(candidates: CompanyCandidate[]): CompanyCandidate | null {
  return (
    candidates
      .filter((candidate) => isValidCompanyCandidate(candidate.value))
      .sort((a, b) => b.rank - a.rank || a.value.localeCompare(b.value))[0] ?? null
  );
}

export function collectLabeledFieldCandidates(lines: string[]): CompanyCandidate[] {
  const out: CompanyCandidate[] = [];
  for (const line of lines) {
    const labeled = parseExplicitCompanyLabel(line);
    if (labeled) {
      out.push({ value: labeled, source: "labeled_field", rank: COMPANY_SOURCE_RANK.labeled_field });
    }
  }
  return out;
}

export function collectFallbackScoringCandidates(lines: string[]): CompanyCandidate[] {
  const out: CompanyCandidate[] = [];
  const titleIdx = lines.findIndex((l) =>
    /\b(engineer|developer|software|devops|sre|scientist|architect|analyst|designer|programmer)\b/i.test(l),
  );
  const headerEnd = Math.min(titleIdx >= 0 ? titleIdx : 15, findBodySectionStartIndex(lines), 20);

  for (let i = 0; i < Math.min(lines.length, 30); i++) {
    const line = lines[i]!;
    if (isJobBoardUiSectionHeader(line)) continue;
    if (isAfterBodySection(lines, i) && !parseExplicitCompanyLabel(line)) continue;
    if (followsMetadataLabelLine(lines, i)) continue;
    if (isJobTitleLikeLine(line)) continue;
    if (!isValidCompanyCandidate(line)) continue;
    if (i >= headerEnd && i > 12) continue;
    out.push({
      value: line,
      source: "fallback_scoring",
      rank: COMPANY_SOURCE_RANK.fallback_scoring + Math.max(0, 8 - i),
    });
  }
  return out;
}

export function resolveCompanyFromText(
  rawJobText: string,
  options?: {
    companyHint?: string | null;
    llmCompany?: string | null;
    preScoringCompany?: string | null;
  },
): string | null {
  const lines = normalizeJobLines(rawJobText);
  const candidates: CompanyCandidate[] = [];

  const hint = options?.companyHint?.trim();
  if (hint && isValidCompanyCandidate(hint)) {
    candidates.push({ value: hint, source: "user_hint", rank: COMPANY_SOURCE_RANK.user_hint });
  }

  const posted = extractCompanyFromPostedHeader(lines);
  const duplicate = extractDuplicateCompanyBeforeEmployeeCount(lines);
  // Duplicate company before employee-count is a real Simplify company card.
  // Prefer it over posted_header when they disagree — header proximity alone is not a company field.
  if (
    posted &&
    (!duplicate ||
      normalizeCompanyCandidateKey(posted) === normalizeCompanyCandidateKey(duplicate))
  ) {
    candidates.push({
      value: posted,
      source: "posted_header",
      rank: COMPANY_SOURCE_RANK.posted_header,
    });
  }

  if (duplicate) {
    candidates.push({
      value: duplicate,
      source: "duplicate_before_employee_count",
      rank: COMPANY_SOURCE_RANK.duplicate_before_employee_count,
    });
  }

  candidates.push(...collectLabeledFieldCandidates(lines));

  const viewMore = extractCompanyFromViewMoreJobs(rawJobText);
  if (viewMore) {
    candidates.push({
      value: viewMore,
      source: "view_more_jobs",
      rank: COMPANY_SOURCE_RANK.view_more_jobs,
    });
  }

  const selfDesc = extractCompanyFromSelfDescriptionLines(lines);
  if (selfDesc) {
    candidates.push({
      value: selfDesc,
      source: "self_description",
      rank: COMPANY_SOURCE_RANK.self_description,
    });
  }

  const atCompany = extractCompanyFromAtCompany(rawJobText);
  if (atCompany) {
    candidates.push({
      value: atCompany,
      source: "at_company",
      rank: COMPANY_SOURCE_RANK.at_company,
    });
  }

  const fromDomain = extractCompanyFromDomain(rawJobText);
  if (fromDomain) {
    candidates.push({
      value: fromDomain,
      source: "domain",
      rank: COMPANY_SOURCE_RANK.domain,
    });
  }

  const follow = extractCompanyFromFollowPattern(lines);
  if (follow) {
    candidates.push({
      value: follow,
      source: "follow_company",
      rank: COMPANY_SOURCE_RANK.follow_company,
    });
  }

  const disclaimer = extractCompanyFromRecruiterDisclaimer(rawJobText);
  if (disclaimer) {
    candidates.push({
      value: disclaimer,
      source: "recruiter_disclaimer",
      rank: COMPANY_SOURCE_RANK.recruiter_disclaimer,
    });
  }

  const about = extractCompanyFromAboutHeader(lines);
  if (about) {
    candidates.push({ value: about, source: "about_header", rank: COMPANY_SOURCE_RANK.about_header });
  }

  const preScoring = options?.preScoringCompany?.trim();
  if (preScoring && isValidCompanyCandidate(preScoring)) {
    candidates.push({ value: preScoring, source: "fallback_scoring", rank: 55 });
  }

  const llm = options?.llmCompany?.trim();
  if (llm && isValidCompanyCandidate(llm)) {
    candidates.push({ value: llm, source: "llm", rank: COMPANY_SOURCE_RANK.llm });
  }

  candidates.push(...collectFallbackScoringCandidates(lines));

  return pickBestCompanyCandidate(candidates)?.value ?? null;
}

export function isPlaceholderCompanyName(company: string): boolean {
  const trimmed = company.trim();
  if (!trimmed) return true;
  return /^unknown company$/i.test(trimmed);
}

/** Never return blank — schema + API responses require a non-empty company string. */
export function ensureCompanyName(company: string | null | undefined): string {
  const trimmed = company?.trim();
  return trimmed || "Unknown Company";
}

export function ensureJobTitle(title: string | null | undefined): string {
  const trimmed = title?.trim();
  return trimmed || "Unknown Title";
}

export function sanitizeCompanyName(
  company: string | null | undefined,
  rawJobText?: string,
  companyHint?: string,
): string | null {
  const trimmed = company?.trim();
  if (trimmed && !isPlaceholderCompanyName(trimmed) && isValidCompanyCandidate(trimmed)) return trimmed;
  if (rawJobText?.trim()) {
    return resolveCompanyFromText(rawJobText, { companyHint, llmCompany: trimmed ?? null });
  }
  const hint = companyHint?.trim();
  if (hint && isValidCompanyCandidate(hint)) return hint;
  return null;
}
