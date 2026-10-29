/** Matches MIN_PASTED_JD_CHARS: a complete posting is at least a short real JD, not a snippet. */
export const MIN_COMPLETE_JD_CHARS = 300;
const MIN_SECTION_CHARS = 80;
const MIN_SECTION_UNITS = 2;

const DUTY_HEADING =
  /^(what you'?ll do|what you will do|responsibilities|your responsibilities|day[- ]to[- ]day|in this role|the role|about the role|about the (position|job)|duties)$/i;
const QUAL_HEADING =
  /^(what you'?ll bring|what you will bring|what you'?ll need|qualifications|requirements|what we'?re looking for|who you are|about you|nice to have|good to have|you should have|minimum qualifications|preferred qualifications|basic qualifications|you'?re a great fit if|you are a great fit( if)?|(the )?ideal candidate|who we'?re looking for)$/i;
const OTHER_HEADING =
  /^(compensation|benefits\b.*|interview process|equal opportunity|eeo|location|salary|perks|our values|who we are|what we offer|how to apply|to apply|your first few months|tech stack|about .+)$/i;

/** Role/work language: assigned to the reader, not company marketing. */
const DUTY_LANGUAGE =
  /\b(you will|you'll|we'?ll ask you|contribute to|build|develop|design|implement|work closely|tackle|take on|roll up your sleeves)\b/i;
/** Candidate-attribute language: experience, fit, and "you have / you're" requirements. */
const QUAL_LANGUAGE =
  /\b(experience|expertise|familiar(ity)?|proficien(t|cy)|requirement|qualification|background|years?|you(?:'re| are| have|'ve))\b/i;

export const normalizeJdApostrophes = (text: string): string =>
  text.replace(/[\u2018\u2019\u201B\u2032]/g, "'");

const headingKind = (line: string): "duty" | "qual" | "other" | null => {
  const compact = line.replace(/[:\s]+$/g, "").trim();
  if (!compact || compact.length > 80) return null;
  if (DUTY_HEADING.test(compact)) return "duty";
  if (QUAL_HEADING.test(compact)) return "qual";
  if (OTHER_HEADING.test(compact)) return "other";
  return null;
};

const contentUnits = (text: string): number => {
  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  let units = 0;
  for (const line of lines) {
    if (/^[-*•]/.test(line) || /^\d+[.)]/.test(line)) {
      units += 1;
      continue;
    }
    const sentences = line.split(/(?<=[.!?])\s+/).filter((part) => part.trim().length >= 20);
    units += Math.max(1, sentences.length);
  }
  return units;
};

const sectionLooksReal = (text: string): boolean => {
  const compact = text.replace(/\s+/g, " ").trim();
  return compact.length >= MIN_SECTION_CHARS && contentUnits(text) >= MIN_SECTION_UNITS;
};

const looksTruncated = (text: string): boolean => {
  const trimmed = text.trim();
  if (/(?:\.{3}|…)\s*$/.test(trimmed)) return true;
  const last = trimmed.split("\n").map((line) => line.trim()).filter(Boolean).at(-1) ?? "";
  if (headingKind(last)) return true;
  return last.length >= 50 && /[a-z]$/.test(last) && !/[.!?:;)]$/.test(last);
};

const collectSections = (text: string): { duty: string; qual: string; body: string } => {
  let current: "duty" | "qual" | "other" | null = null;
  let duty = "";
  let qual = "";
  let body = "";
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    const kind = headingKind(line);
    if (kind) {
      current = kind;
      continue;
    }
    if (current === "other") continue;
    body += `${line}\n`;
    if (current === "duty") duty += `${line}\n`;
    if (current === "qual") qual += `${line}\n`;
  }
  return { duty, qual, body };
};

const languageHits = (text: string, pattern: RegExp): boolean => {
  const hits = text
    .split(/\n|(?<=[.!?])\s+/)
    .map((part) => part.replace(/^[-*•]\s*/, "").trim())
    .filter((sentence) => sentence.length >= 20 && pattern.test(sentence));
  const hitText = hits.join(" ");
  return hits.length >= MIN_SECTION_UNITS && hitText.length >= MIN_SECTION_CHARS;
};

export type JdCompletenessAssessment = {
  complete: boolean;
  dutyChars: number;
  qualChars: number;
  truncated: boolean;
  dutyOk: boolean;
  qualOk: boolean;
};

/**
 * Deterministic completeness for retrieved postings. Headings help locate sections,
 * but duty and qualification *content* (paragraphs or lists) must both be present.
 * Company-about and benefits blocks are ignored.
 */
export const assessJdCompleteness = (text: string, minChars = MIN_COMPLETE_JD_CHARS): JdCompletenessAssessment => {
  const normalized = normalizeJdApostrophes(text).trim();
  const truncated = looksTruncated(normalized);
  const { duty, qual, body } = collectSections(normalized);
  const dutyOk = sectionLooksReal(duty) || languageHits(body, DUTY_LANGUAGE);
  const qualOk = sectionLooksReal(qual) || languageHits(body, QUAL_LANGUAGE);
  return {
    complete: normalized.length >= minChars && !truncated && dutyOk && qualOk,
    dutyChars: duty.replace(/\s+/g, " ").trim().length,
    qualChars: qual.replace(/\s+/g, " ").trim().length,
    truncated,
    dutyOk,
    qualOk,
  };
};

export const jdTextLooksComplete = (text: string, minChars = MIN_COMPLETE_JD_CHARS): boolean =>
  assessJdCompleteness(text, minChars).complete;
