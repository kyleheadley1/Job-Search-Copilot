import type { ExtractedJobData } from "../types/job.js";
import { jdDutiesBlob } from "./jdGroundedRiskNotes.js";
import { classifyJdLines } from "./jdTagProvenance.js";
import { logger } from "./logger.js";
import { normalizeText } from "./text.js";

const NUMBERED_ENGINEER_TITLE =
  /\b(?:software\s+)?(?:engineer|developer|programmer)\s*(?:ii|iii|iv|2|3|4)\b/i;
const TITLE_SENIOR_TOKEN = /\b(senior|staff|principal|sr\.|lead\s+engineer)\b/i;

const YEAR_NUM = String.raw`(\d{1,2}(?:\.\d+)?)`;

/** Explicit YOE clauses: "1.5+ years of experience", "2–4 years professional software engineering". */
const YEARS_CLAUSE_RE = new RegExp(
  String.raw`(?:\b${YEAR_NUM}\s*(?:[–-]|to)\s*)?\b${YEAR_NUM}\s*\+?\s*(?:years?|yrs)\s+(?:of\s+)?(?:experience|engineering|software|industry|professional|building|developing)`,
  "gi",
);

export type GroundedYearsClause = {
  min: number;
  max?: number;
  raw: string;
};

const parseClause = (match: RegExpMatchArray): GroundedYearsClause | null => {
  const a = match[1] != null ? Number.parseFloat(match[1]) : undefined;
  const b = match[2] != null ? Number.parseFloat(match[2]) : undefined;
  if (b == null || !Number.isFinite(b)) return null;
  if (a != null && Number.isFinite(a)) {
    return { min: Math.min(a, b), max: Math.max(a, b), raw: match[0]!.trim() };
  }
  return { min: b, raw: match[0]!.trim() };
};

const uniqueMins = (clauses: GroundedYearsClause[]): number[] => {
  const seen: number[] = [];
  for (const c of clauses) {
    if (!seen.some((n) => Math.abs(n - c.min) < 0.05)) seen.push(c.min);
  }
  return seen.sort((x, y) => x - y);
};

const PREFERRED_YEARS_CUE =
  /\b(nice[- ]to[- ]have|nice to haves?|a plus|preferred|bonus|ideally|optional)\b/i;

const clausesIn = (blob: string): GroundedYearsClause[] => {
  const found: GroundedYearsClause[] = [];
  if (!blob) return found;
  YEARS_CLAUSE_RE.lastIndex = 0;
  for (const match of blob.matchAll(YEARS_CLAUSE_RE)) {
    const clause = parseClause(match);
    if (clause) found.push(clause);
  }
  return found;
};

const bucketedYearsFromRawText = (
  rawText: string,
): { required: GroundedYearsClause[]; preferred: GroundedYearsClause[]; other: GroundedYearsClause[] } => {
  const required: GroundedYearsClause[] = [];
  const preferred: GroundedYearsClause[] = [];
  const other: GroundedYearsClause[] = [];
  for (const { line, strength } of classifyJdLines(rawText)) {
    const found = clausesIn(line);
    if (!found.length) continue;
    if (strength === "PREFERRED" || PREFERRED_YEARS_CUE.test(line)) preferred.push(...found);
    else if (strength === "REQUIRED") required.push(...found);
    else other.push(...found);
  }
  return { required, preferred, other };
};

export const extractPreferredYearsClauses = (job: ExtractedJobData): GroundedYearsClause[] =>
  bucketedYearsFromRawText(job.rawText ?? "").preferred;

/**
 * Mandatory years floors only. Preferred / nice-to-have years (Seso 3–5+ as a plus)
 * never become the required experience floor when a must-have floor exists.
 */
export const extractGroundedYearsClauses = (job: ExtractedJobData): GroundedYearsClause[] => {
  const { required, other } = bucketedYearsFromRawText(job.rawText ?? "");
  if (required.length > 0) return required;

  const fromDuties = clausesIn(jdDutiesBlob(job)).filter((clause) => !PREFERRED_YEARS_CUE.test(clause.raw));
  if (fromDuties.length > 0) return fromDuties;

  if (other.length > 0) return other;
  return [];
};

export type YearsReconciliationResult = {
  job: ExtractedJobData;
  changed: boolean;
  ambiguous: boolean;
};

const withYears = (
  job: ExtractedJobData,
  years: NonNullable<ExtractedJobData["yearsExperience"]> | undefined,
): ExtractedJobData => {
  if (!years) {
    const { yearsExperience: _drop, ...rest } = job;
    return rest;
  }
  return { ...job, yearsExperience: years };
};

/**
 * Prefer explicit JD year floors over LLM-inferred seniority years.
 * If multiple grounded floors conflict, drop `min` rather than inventing one.
 */
export const reconcileYearsExperience = (job: ExtractedJobData): YearsReconciliationResult => {
  const clauses = extractGroundedYearsClauses(job);
  const mins = uniqueMins(clauses);
  const extracted = job.yearsExperience;
  const extractedMin = extracted?.min;

  if (mins.length === 0) {
    const preferred = extractPreferredYearsClauses(job);
    if (
      extractedMin != null &&
      preferred.some((clause) => Math.abs(clause.min - extractedMin) < 0.05)
    ) {
      logger.info("Years reconciliation: dropping preferred-only years floor", {
        title: job.title,
        extractedMin,
      });
      return {
        job: withYears(job, {
          ...extracted,
          raw: extracted?.raw ?? String(extractedMin),
          min: undefined,
        }),
        changed: true,
        ambiguous: false,
      };
    }
    if (extractedMin == null) return { job, changed: false, ambiguous: false };
    // Numbered Engineer II/III titles are not a years signal. Drop an ungrounded
    // 5+ floor inferred from the title so it cannot fire a seniority gate.
    const title = normalizeText(job.title ?? "");
    if (NUMBERED_ENGINEER_TITLE.test(title) && !TITLE_SENIOR_TOKEN.test(title) && extractedMin >= 5) {
      logger.info("Years reconciliation: dropping ungrounded min on numbered engineer title", {
        title: job.title,
        extractedMin,
      });
      return {
        job: withYears(job, {
          ...extracted,
          raw: extracted.raw ?? String(extractedMin),
          min: undefined,
        }),
        changed: true,
        ambiguous: true,
      };
    }
    return { job, changed: false, ambiguous: false };
  }

  if (mins.length > 1) {
    const raw = clauses.map((c) => c.raw).join("; ");
    logger.info("Years reconciliation: conflicting grounded year floors — leaving min unset", {
      title: job.title,
      mins,
    });
    return {
      job: withYears(job, {
        raw,
        reinforcedLineCount: extracted?.reinforcedLineCount,
      }),
      changed: extractedMin != null,
      ambiguous: true,
    };
  }

  const groundedMin = mins[0]!;
  const groundedMax = clauses.find((c) => Math.abs(c.min - groundedMin) < 0.05)?.max;
  const groundedRaw =
    clauses.find((c) => Math.abs(c.min - groundedMin) < 0.05)?.raw ?? extracted?.raw ?? `${groundedMin}+ years`;

  if (extractedMin != null && Math.abs(extractedMin - groundedMin) < 0.05) {
    return { job, changed: false, ambiguous: false };
  }

  logger.info("Years reconciliation: explicit JD floor overrides extracted min", {
    title: job.title,
    extractedMin,
    groundedMin,
  });

  return {
    job: withYears(job, {
      raw: groundedRaw,
      min: groundedMin,
      max: groundedMax ?? extracted?.max,
      reinforcedLineCount: extracted?.reinforcedLineCount,
    }),
    changed: true,
    ambiguous: false,
  };
};
