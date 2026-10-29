import { parseJobText } from "../../../tools/parseJobText.js";

/** Exact lines that are aggregator chrome, not job content. */
const EXACT_CLUTTER = new Set([
  "easy apply",
  "indeed apply",
  "apply now",
  "apply",
  "apply on company website",
  "apply on company site",
  "save",
  "save job",
  "show more",
  "show less",
  "sign in",
  "join now",
  "log in",
  "home",
  "jobs",
  "messaging",
  "notifications",
  "my network",
  "network",
  "skip to main content",
  "skip to content",
  "report job",
  "report this job",
  "promoted",
  "actively recruiting",
  "set alert",
  "create job alert",
  "similar jobs",
  "see more jobs",
  "more jobs",
  "follow",
  "following",
  "not interested",
  "share",
  "see who you know",
  "ask for a referral",
  "how you match",
  "profile match",
  "skills match",
  "be an early applicant",
  "privacy policy",
  "cookie policy",
  "terms of use",
  "for business",
  "learning",
  "linkedin",
  "indeed",
  "glassdoor",
  "ziprecruiter",
]);

const CLUTTER_RE = [
  /^\d{1,3}%(\s*match)?$/i,
  /^(you('?re| are) a )?(strong |good |great )?match$/i,
  /^(fit|match|platform)\s*(score|rating)?\s*[:\-]?\s*\d{1,3}\s*%?$/i,
  /\b(fit|match)\s*score\b/i,
  /\byour profile matches\b/i,
  /\byour skills match\b/i,
  /\bpeople you may know\b/i,
  /\bmessage (the )?(job poster|recruiter|hiring manager)\b/i,
  /\b\d+\s*(people|employees|alumni|connections|school alumni)\s+(work|work here|at this)\b/i,
  /\b\d+\s*(applicants?|people clicked apply)\b/i,
  /^posted\s+\d+\s+(minute|hour|day|week|month)s?\s+ago$/i,
  /^employer active(\s+\d+\s+(minute|hour|day|week|month)s?\s+ago)?$/i,
  /^responsive employer$/i,
  /^premium( career)?( insights?)?$/i,
  /^try premium/i,
  /^see all \d+ employees/i,
  /^uploaded resume/i,
  /^use my last application/i,
];

const isAggregatorClutter = (line: string): boolean => {
  const compact = line.replace(/\s+/g, " ").trim();
  if (!compact) return true;
  if (EXACT_CLUTTER.has(compact.toLowerCase())) return true;
  return CLUTTER_RE.some((re) => re.test(compact));
};

/**
 * Drop aggregator UI chrome from a pasted JD. Leaves requirements, responsibilities,
 * salary, and other job content unchanged. Deterministic — no LLM.
 */
export const cleanProspectJd = (rawText: string): string => {
  const { lines } = parseJobText(rawText);
  return lines.filter((line) => !isAggregatorClutter(line)).join("\n");
};
