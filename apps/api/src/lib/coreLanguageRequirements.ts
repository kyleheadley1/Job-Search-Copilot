import type { ExtractedJobData } from "../types/job.js";
import type { UserProfile } from "../types/userProfile.js";
import type { ClaimableStack } from "./claimableStack.js";
import {
  evaluateDisjunctiveLanguageRequirement,
  languageClearedBySatisfiedDisjunctiveGroup,
} from "./disjunctiveLanguageRequirement.js";
import { GO_LANGUAGE_RE, textMentionsGoLanguage } from "./goLanguage.js";
import { languagePresentInJd } from "./jdLanguagePresence.js";
import { normalizeText } from "./text.js";

export type CoreLanguageId = "java" | "go" | "python";

export type CoreLanguageAnalysis = {
  /** Primary explicitly required production language when hard requirement detected. */
  language: CoreLanguageId | null;
  /** JD uses direct requirement language (not only preferred / flexible stack). */
  explicitHardRequirement: boolean;
  /** Candidate profile shows credible production use of `language`. */
  candidateHasProductionLanguage: boolean;
};

const SOFT_STACK_FRAMING =
  /\b(preferred|nice to have|a plus|bonus|ideally|familiarity with|exposure to|equivalent experience|or equivalent|modern programming language|language agnostic|flexible.*stack|polyglot|any modern)\b/i;

/** Big tech / mature engineering orgs where explicit stack gates are usually strict. */
const MATURE_EMPLOYER_TOKEN =
  /\b(spotify|google|alphabet|meta|facebook|amazon|aws|microsoft|apple|netflix|oracle|salesforce|adobe|linkedin|uber|airbnb|stripe|shopify|twitter|x\.com|snap|robinhood|coinbase|goldman|jpmorgan|jpm\b|morgan stanley|citi|citigroup|bank of america|wells fargo|deutsche bank|barclays|blackrock|bloomberg|ibm|intel|nvidia|cisco|vmware|servicenow|workday|palantir|databricks|snowflake)\b/i;

const EXPLICIT_JAVA = [
  /(\byou have\s+)?\bexperience[^.]{0,120}\bdeveloping[^.]{0,80}\bbackend[^.]{0,40}\busing\s+java\b/i,
  /\bprofessional experience with\s+java\b/i,
  /\bmust have[^.]{0,60}\bjava\b/i,
  /\brequired[^.]{0,60}\bjava\b|\bjava\b[^.]{0,40}required\b/i,
  /\bjava\s+backend\b/i,
  /\bstrong[^.]{0,40}\bjava\b[^.]{0,40}\b(production|backend|experience)\b/i,
  /\bjava\b[^.]{0,50}\b(production|professional|commercial)\s+experience\b/i,
];

const EXPLICIT_GO = [
  /\bgolang\s+required\b/i,
  /\bgo\s+lang(uage)?\s+required\b/i,
  /\bmust have[^.]{0,60}\bgo\b[^.]{0,20}\b(lang|language)?\b/i,
  /\bprofessional experience with\s+go\b/i,
];

const EXPLICIT_PYTHON = [
  /\bpython\s+production\s+experience\s+required\b/i,
  /\bmust have[^.]{0,60}\bpython\b[^.]{0,40}\b(production|professional)\b/i,
  /\brequired[^.]{0,60}\bpython\b[^.]{0,40}\b(production|backend)\b/i,
];

/** JD treats Python as interchangeable with JS/TS or lists multiple acceptable languages — not a hard Python-only gate. */
export function jdPythonFlexibleWithJsOrTs(blob: string): boolean {
  const t = normalizeText(blob);
  if (!/\bpython\b/.test(t)) return false;
  if (!/\b(type\s*script|typescript|javascript|node\.?js|js)\b/.test(t)) return false;
  if (
    /\bpython\s+(and\s*\/\s*or|and\/or|or)\s+(java\s*script|typescript|js|node)\b/i.test(t) ||
    /\b(java\s*script|typescript|js|node)\s+(and\s*\/\s*or|and\/or|or)\s+python\b/i.test(t) ||
    /\b(python|typescript|javascript)\s*,\s*(python|typescript|javascript|node)\b/i.test(t) ||
    /\b(either|any)\s+(of\s+)?(python|typescript|javascript)\b/i.test(t) ||
    /\bpreferred[^.]{0,160}\b(python|typescript|javascript)[^.]{0,160}\b(python|typescript|javascript|node|js)\b/i.test(
      t,
    ) ||
    /\b(polyglot|multi[-\s]?language|language\s+agnostic|flexible\s+(on\s+)?(the\s+)?stack)\b/i.test(t) ||
    /\b(comfortable\s+with|proficient\s+in)\s+[^.]{0,40}\b(python|typescript|javascript)[^.]{0,80}\b(python|typescript|javascript|node)\b/i.test(
      t,
    )
  ) {
    return true;
  }
  return false;
}

function blobForLanguageScan(job: ExtractedJobData): string {
  return normalizeText(
    [
      job.title,
      job.rawText ?? "",
      ...(job.requirements ?? []),
      ...(job.responsibilities ?? []),
      ...(job.stack ?? []),
    ].join("\n"),
  );
}

function profileLanguageBlob(profile: UserProfile): string {
  return normalizeText(
    [
      profile.headline,
      ...profile.strengths,
      ...profile.recurringStory,
      ...profile.targetRoles,
      ...profile.flagshipProjects.flatMap((p) => [p.name, p.summary, ...p.tech]),
    ].join(" "),
  );
}

function hasProductionJava(profileBlob: string): boolean {
  return /\bjava\b/i.test(profileBlob) && /\b(production|professional|ship|built|backend|spring|jvm|kotlin)\b/i.test(profileBlob);
}

function hasProductionGo(profileBlob: string): boolean {
  return textMentionsGoLanguage(profileBlob) && /\b(production|professional|ship|built|backend)\b/i.test(profileBlob);
}

function hasProductionPython(profileBlob: string): boolean {
  return (
    /\bpython\b/i.test(profileBlob) &&
    /\b(production|professional|ship|built|backend|django|fastapi|flask)\b/i.test(profileBlob)
  );
}

function matchesExplicitSet(blob: string, patterns: RegExp[]): boolean {
  return patterns.some((re) => {
    re.lastIndex = 0;
    return re.test(blob);
  });
}

/**
 * Detect explicit core-language requirements vs soft / flexible wording.
 * Used with mature-employer heuristics to avoid over-optimistic stack scores.
 */
export function analyzeCoreLanguageRequirement(
  job: ExtractedJobData,
  profile: UserProfile,
  claimable?: ClaimableStack,
): CoreLanguageAnalysis {
  const blob = blobForLanguageScan(job);
  const profileBlob = profileLanguageBlob(profile);
  const disjunctive = claimable
    ? evaluateDisjunctiveLanguageRequirement(job, claimable)
    : null;

  let language: CoreLanguageId | null = null;
  let explicit = false;

  if (matchesExplicitSet(blob, EXPLICIT_JAVA)) {
    language = "java";
    explicit = true;
  } else if (matchesExplicitSet(blob, EXPLICIT_GO)) {
    language = "go";
    explicit = true;
  } else if (matchesExplicitSet(blob, EXPLICIT_PYTHON)) {
    language = "python";
    explicit = true;
  }

  if (language === "python" && explicit && jdPythonFlexibleWithJsOrTs(blob)) {
    language = null;
    explicit = false;
  }

  if (language === "java" && !languagePresentInJd("Java", job)) {
    language = null;
    explicit = false;
  } else if (language === "go" && !languagePresentInJd("Go", job)) {
    language = null;
    explicit = false;
  } else if (language === "python" && !languagePresentInJd("Python", job)) {
    language = null;
    explicit = false;
  }

  if (explicit && language) {
    const windowAround = (needle: RegExp): string => {
      const m = blob.match(needle);
      if (!m || m.index === undefined) return blob;
      const i = m.index;
      return blob.slice(Math.max(0, i - 80), Math.min(blob.length, i + (m[0]?.length ?? 0) + 80));
    };
    const ctx =
      language === "java"
        ? windowAround(/\bjava\b/i)
        : language === "go"
          ? windowAround(GO_LANGUAGE_RE)
          : windowAround(/\bpython\b/i);
    if (SOFT_STACK_FRAMING.test(ctx) && !/\b(must|required)\b/i.test(ctx)) {
      explicit = false;
      language = null;
    }
  }

  if (disjunctive && language) {
    const label = language === "java" ? "Java" : language === "go" ? "Go" : "Python";
    if (languageClearedBySatisfiedDisjunctiveGroup(disjunctive, label)) {
      return {
        language: null,
        explicitHardRequirement: false,
        candidateHasProductionLanguage: true,
      };
    }
  }

  let candidateHasProductionLanguage = false;
  if (language === "java") candidateHasProductionLanguage = hasProductionJava(profileBlob);
  else if (language === "go") candidateHasProductionLanguage = hasProductionGo(profileBlob);
  else if (language === "python") candidateHasProductionLanguage = hasProductionPython(profileBlob);

  return {
    language,
    explicitHardRequirement: explicit && Boolean(language),
    candidateHasProductionLanguage,
  };
}

/** Single canonical recruiter-screen line for polish + rule notes. */
export function explicitCoreLanguageRiskSummary(language: CoreLanguageId): string {
  const lab = language === "java" ? "Java" : language === "go" ? "Go" : "Python";
  return `Explicit ${lab} backend requirement vs TypeScript-first profile at a mature employer — major recruiter-screen risk.`;
}

export function isMatureStructuredEmployer(company: string, combinedText: string): boolean {
  const c = normalizeText(company);
  const t = normalizeText(combinedText);
  if (MATURE_EMPLOYER_TOKEN.test(c) || MATURE_EMPLOYER_TOKEN.test(t)) return true;
  if (/\b(inc\.|corp\.|corporation|plc|ltd\.|llc)\b/i.test(c) && /\b(engineering|technology|software)\b/i.test(t)) {
    return /\b\d{2,4}\s*engineers\b|\bthousands of\b|\bglobal\b/i.test(t);
  }
  return false;
}
