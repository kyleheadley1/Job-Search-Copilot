import type { ExtractedJobData } from "../types/job.js";
import type {
  LanguageRequirementGroup,
  LanguageRequirementGroupKind,
  RuleEvaluation,
} from "../types/scoring.js";
import type { ClaimableStack } from "./claimableStack.js";
import { hasClaimableCoverage } from "./claimableStack.js";
import { GO_LANGUAGE_PATTERNS } from "./goLanguage.js";
import { normalizeText } from "./text.js";

/** Languages that may appear in JD disjunctive "at least one of" lists. */
const DISJUNCTIVE_LANGUAGE_CATALOG: Array<{
  id: string;
  label: string;
  claimableIds: string[];
  patterns: RegExp[];
}> = [
  {
    id: "nodejs",
    label: "Node.js",
    claimableIds: ["nodejs", "typescript", "javascript"],
    patterns: [/\bnode(?:\.js)?\b/i],
  },
  {
    id: "javascript",
    label: "JavaScript",
    claimableIds: ["javascript", "typescript", "nodejs"],
    patterns: [/\bjava\s*script\b/i, /\bjs\b/i],
  },
  {
    id: "typescript",
    label: "TypeScript",
    claimableIds: ["typescript", "javascript", "nodejs"],
    patterns: [/\btype\s*script\b/i, /\bts\b/i],
  },
  {
    id: "react",
    label: "React",
    claimableIds: ["react", "typescript", "javascript"],
    patterns: [/\breact(?:\.js)?\b/i],
  },
  {
    id: "vue",
    label: "Vue",
    claimableIds: ["vue", "react", "typescript", "javascript"],
    patterns: [/\bvue(?:\.js)?\b/i, /\bnuxt\b/i],
  },
  {
    id: "rails",
    label: "Ruby on Rails",
    claimableIds: ["ruby"],
    patterns: [/\bruby\s+on\s+rails\b/i, /\brails\b/i],
  },
  {
    id: "python",
    label: "Python",
    claimableIds: ["python"],
    patterns: [/\bpython\b/i],
  },
  {
    id: "java",
    label: "Java",
    claimableIds: ["java"],
    patterns: [/\bjava\b(?!script)/i, /\bjvm\b/i],
  },
  {
    id: "scala",
    label: "Scala",
    claimableIds: ["scala"],
    patterns: [/\bscala\b/i],
  },
  {
    id: "go",
    label: "Go",
    claimableIds: ["go"],
    patterns: GO_LANGUAGE_PATTERNS,
  },
  {
    id: "csharp",
    label: "C#",
    claimableIds: ["csharp"],
    patterns: [/\bc#\b/i, /\bcsharp\b/i, /\.net\b/i],
  },
  {
    id: "cpp",
    label: "C++",
    claimableIds: ["cpp"],
    // Avoid \b after ++ (non-word); allow punctuation/end.
    patterns: [/\bc\+\+(?![a-z0-9])/i, /\bc\/c\+\+/i],
  },
  {
    id: "ruby",
    label: "Ruby",
    claimableIds: ["ruby"],
    patterns: [/\bruby\b/i, /\brails\b/i],
  },
  {
    id: "php",
    label: "PHP",
    claimableIds: ["php"],
    patterns: [/\bphp\b/i],
  },
];

/**
 * Phrasing that means "satisfying any one listed language fulfills the requirement."
 * Match on meaning — not only Fleetio-style "X, Y, and/or Z".
 */
/**
 * Choice-set phrasing. `e.g.` / `eg.` must not require a trailing word boundary —
 * `e.g., Python/Go` has a comma after the period, so `e.g.\b` never matches.
 */
export const DISJUNCTIVE_FRAMING =
  /(?:\b(?:and\s*\/\s*or|\/\s*or|\bor\b|at\s+least\s+(?:one|\d+|1)\b|one\s+of(?:\s+the\s+following)?|any(?:\s+one)?\s+of|one\s+or\s+more\s+of|either\b|such\s+as|including|among|from\s+the\s+following|from\b|proficiency\s+in\s+at\s+least|experience\s+with\s+any\s+of|familiarity\s+with\s+one\s+or\s+more\s+of|general[-\s]?purpose\s+programming\s+language)\b|\b(?:e\.g\.|eg\.))/i;

const CHOICE_LIST_ENUM =
  /\b([A-Za-z+#./]+(?:\s*[A-Za-z+#./]*)?)(?:\s*,\s*([A-Za-z+#./]+(?:\s*[A-Za-z+#./]*)?)){1,12}(?:\s*,?\s*(?:and|or|and\s*\/\s*or)\s+([A-Za-z+#./]+(?:\s*[A-Za-z+#./]*)?))?/i;

const EXCLUSIVE_REQUIREMENT =
  /\b(must have|required|professional experience with|strong proficiency in|strong fundamentals in|primary language is|our (?:main|primary) (?:backend )?language|leads? with)\b/i;

/** "Strong Python" / "Strong Go" / "Strong Java" — named-language emphasis, not "strong coding skills". */
const STRONG_NAMED_LANGUAGE =
  /\b(?:strong|solid|deep|extensive)\s+(python|golang|go|java)\b/i;

const PLUS_OR_PREFERRED_ON_LINE =
  /\b(a plus|is a plus|preferred|nice[- ]to[- ]have|optionally|bonus)\b/i;

const strongNamedLanguageMatches = (line: string, languageLabel: string): boolean => {
  if (PLUS_OR_PREFERRED_ON_LINE.test(line)) return false;
  const match = line.match(STRONG_NAMED_LANGUAGE);
  if (!match?.[1]) return false;
  const named = match[1].toLowerCase();
  const want = languageLabel.toLowerCase().split("/")[0]?.trim() ?? "";
  if (want === "python") return named === "python";
  if (want === "go") return named === "go" || named === "golang";
  if (want === "java") return named === "java";
  return false;
};

/** Illustrative examples — not a closed "must match one of these" set.
 * Do not require a trailing word boundary after `e.g.` (`e.g., Python` has comma, not `\b`).
 */
const ILLUSTRATIVE_EXAMPLE_FRAMING = /\b(?:such as|e\.g\.|eg\.)/i;

/** Closed choice: candidate must match at least one listed language. */
const CLOSED_CHOICE_FRAMING =
  /\b(?:at\s+least\s+(?:one|\d+|1)|one\s+of(?:\s+the\s+following)?|any(?:\s+one)?\s+of|one\s+or\s+more\s+of|proficiency\s+in\s+at\s+least|experience\s+with\s+any\s+of)\b/i;

export type DisjunctiveLanguageEval = {
  /**
   * True only when every mandatory alternative group is satisfied.
   * Satisfying one group never marks an unrelated group satisfied.
   */
  satisfied: boolean;
  /** Languages belonging to satisfied mandatory alternative groups (full group, not a subset). */
  acceptedLabels: string[];
  groups: LanguageRequirementGroup[];
};

const MANDATORY_ALTERNATIVE_KINDS = new Set<LanguageRequirementGroupKind>([
  "closed_mandatory_alternatives",
  "disjunctive_mandatory",
]);

export const groupIsMandatoryAlternative = (kind: LanguageRequirementGroupKind): boolean =>
  MANDATORY_ALTERNATIVE_KINDS.has(kind);

const KIND_PRIORITY: Record<LanguageRequirementGroupKind, number> = {
  conjunctive_mandatory: 0,
  closed_mandatory_alternatives: 1,
  disjunctive_mandatory: 2,
  mixed_stack_inventory: 3,
  preferred: 4,
  illustrative: 5,
  ambiguous: 6,
};

const STACK_INVENTORY_LINE =
  /\b(our (?:tech )?stack|tech stack\s*:|we (?:use|work with)|stack includes|technologies we use|comfortable working across both front-end and back-end)\b/i;

const jobBlob = (job: ExtractedJobData): string =>
  [
    job.title,
    job.rawText ?? "",
    ...(job.requirements ?? []),
    ...(job.responsibilities ?? []),
    ...(job.stack ?? []),
    ...(job.requiredSkills ?? []),
  ]
    .filter(Boolean)
    .join("\n");

/** Collapse mid-sentence newlines so "at least one …\nfrom Python, Java, and C++" stays one span.
 * Only join when the next line continues in lowercase — never merge separate Title Case bullets.
 */
const coalesceProse = (text: string): string =>
  text
    .replace(/\r\n/g, "\n")
    .replace(/([^\n.:;])\n+(?=[a-z(#])/g, "$1 ")
    .replace(/\n{2,}/g, "\n");

const languagesInSpan = (span: string): typeof DISJUNCTIVE_LANGUAGE_CATALOG => {
  const found: typeof DISJUNCTIVE_LANGUAGE_CATALOG = [];
  for (const lang of DISJUNCTIVE_LANGUAGE_CATALOG) {
    if (lang.patterns.some((re) => re.test(span)) && !found.some((f) => f.id === lang.id)) {
      found.push(lang);
    }
  }
  return found;
};

const candidateCoversLanguage = (
  lang: (typeof DISJUNCTIVE_LANGUAGE_CATALOG)[number],
  claimable: ClaimableStack,
): boolean => lang.claimableIds.some((id) => hasClaimableCoverage(claimable, id));

const classifyLanguageSpan = (span: string): LanguageRequirementGroupKind | null => {
  const langs = languagesInSpan(span);
  if (langs.length < 2) return null;

  if (PLUS_OR_PREFERRED_ON_LINE.test(span) && !/\b(required|must have|minimum)\b/i.test(span)) {
    return "preferred";
  }
  if (STACK_INVENTORY_LINE.test(span)) return "mixed_stack_inventory";

  const learnable =
    /\b(?:or learning|willing to learn|comfortable (?:working in or )?learning)\b/i.test(span) &&
    !/\b(?:at\s+least|must have|required|production experience)\b/i.test(span);
  if (learnable) return "ambiguous";

  const closed =
    CLOSED_CHOICE_FRAMING.test(span) ||
    /\b(?:either|at\s+least\s+(?:one|\d+|1))\b/i.test(span);
  if (closed) return "closed_mandatory_alternatives";
  if (ILLUSTRATIVE_EXAMPLE_FRAMING.test(span)) return "illustrative";
  if (spanLooksDisjunctive(span)) return "disjunctive_mandatory";
  if (
    /\band\b/i.test(span) &&
    !/\bor\b/i.test(span) &&
    /\b(must have|required|strong fundamentals|proficiency in|professional experience with)\b/i.test(span)
  ) {
    return "conjunctive_mandatory";
  }
  return null;
};

/** Keep backend Go/Python and frontend React/TS as separate units when both appear. */
const splitBackendFrontendClauses = (span: string): string[] => {
  if (!/\bbackend\b/i.test(span) || !/\bfrontend\b/i.test(span)) return [span];
  if (/\band\s*\/\s*or\b/i.test(span) && !/\bbackend\b[\s\S]+\bfrontend\b/i.test(span)) {
    return [span];
  }
  const parts = span.split(/\band\b/i).map((part) => part.trim()).filter(Boolean);
  const useful = parts.filter((part) => languagesInSpan(part).length >= 1);
  return useful.length >= 2 ? useful : [span];
};

const requirementUnitsFromText = (text: string): string[] => {
  const units: string[] = [];
  for (const line of coalesceProse(text).split(/\n/)) {
    for (const sentence of line.split(/(?<=[.;])\s+/)) {
      const trimmed = sentence.trim();
      if (!trimmed || trimmed.length > 400) continue;
      units.push(...splitBackendFrontendClauses(trimmed));
    }
  }
  return units;
};

const languageKey = (labels: string[]): string =>
  [...labels].map((label) => label.toLowerCase()).sort().join("|");

const evaluateUnitGroup = (
  unit: string,
  claimable: ClaimableStack,
): LanguageRequirementGroup | null => {
  const kind = classifyLanguageSpan(unit);
  const langs = languagesInSpan(unit);
  if (!kind || langs.length < 2) return null;
  const matched = langs.filter((lang) => candidateCoversLanguage(lang, claimable));
  const satisfied =
    kind === "conjunctive_mandatory"
      ? langs.every((lang) => candidateCoversLanguage(lang, claimable))
      : matched.length > 0;
  return {
    kind,
    languages: langs.map((lang) => lang.label),
    sourceQuote: unit.slice(0, 240),
    satisfied,
    matchedLabels: matched.map((lang) => lang.label),
  };
};

const isSoftGroupKind = (kind: LanguageRequirementGroupKind): boolean =>
  kind === "preferred" || kind === "illustrative" || kind === "mixed_stack_inventory";

const keepStrongerGroup = (
  current: LanguageRequirementGroup | undefined,
  next: LanguageRequirementGroup,
): LanguageRequirementGroup => {
  if (!current) return next;
  if (isSoftGroupKind(next.kind) && !isSoftGroupKind(current.kind)) return current;
  if (!isSoftGroupKind(next.kind) && isSoftGroupKind(current.kind)) return next;
  const closed =
    current.kind === "closed_mandatory_alternatives" || next.kind === "closed_mandatory_alternatives";
  if ((current.kind === "ambiguous" || next.kind === "ambiguous") && !closed) {
    return current.kind === "ambiguous" ? current : next;
  }
  if (KIND_PRIORITY[next.kind] < KIND_PRIORITY[current.kind]) return next;
  if (KIND_PRIORITY[next.kind] === KIND_PRIORITY[current.kind] && next.sourceQuote.length < current.sourceQuote.length) {
    return next;
  }
  return current;
};

export const languageOnlyInNonMandatoryGroup = (
  disjunctive: DisjunctiveLanguageEval,
  languageLabel: string,
): boolean => {
  const fold = (value: string): string => value.toLowerCase().split("/")[0]?.trim() ?? "";
  const want = fold(languageLabel);
  if (!want) return false;
  const hits = disjunctive.groups.filter((group) =>
    group.languages.some((label) => fold(label) === want),
  );
  return (
    hits.length > 0 &&
    hits.every(
      (group) =>
        group.kind === "ambiguous" ||
        group.kind === "preferred" ||
        group.kind === "illustrative" ||
        group.kind === "mixed_stack_inventory",
    )
  );
};

/** Independent requirement groups with quotes. Does not merge unrelated language sets. */
export const extractLanguageRequirementGroups = (
  job: ExtractedJobData,
  claimable: ClaimableStack,
): LanguageRequirementGroup[] => {
  const units = [
    ...requirementUnitsFromText(jobBlob(job)),
    ...requirementLinesForDisjunctive(job).flatMap((line) => splitBackendFrontendClauses(line)),
  ];
  const byKey = new Map<string, LanguageRequirementGroup>();
  for (const unit of units) {
    const group = evaluateUnitGroup(unit, claimable);
    if (!group) continue;
    const key = languageKey(group.languages);
    byKey.set(key, keepStrongerGroup(byKey.get(key), group));
  }
  return [...byKey.values()];
};

export const languageClearedBySatisfiedDisjunctiveGroup = (
  disjunctive: DisjunctiveLanguageEval,
  languageLabel: string,
): boolean => {
  const fold = (value: string): string => value.toLowerCase().split("/")[0]?.trim() ?? "";
  const want = fold(languageLabel);
  if (!want) return false;
  return disjunctive.groups.some(
    (group) =>
      group.satisfied &&
      groupIsMandatoryAlternative(group.kind) &&
      group.languages.some((label) => fold(label) === want),
  );
};

/**
 * True when a span is a choice-set (any one satisfies), not a conjunction of must-haves.
 * "Python, Java, and C++" after "at least one … from" is disjunctive; bare "Python and Java required" is not.
 */
export const spanLooksDisjunctive = (span: string): boolean => {
  const t = span.trim();
  if (!t) return false;
  const langs = languagesInSpan(t);
  if (langs.length < 2) return false;

  if (DISJUNCTIVE_FRAMING.test(t)) return true;

  // Explicit and/or or comma-or lists.
  if (/\band\s*\/\s*or\b/i.test(t) || /,\s*or\b/i.test(t)) return true;

  // "from A, B, and C" / "among A, B, or C" / "(e.g., Python/Go)" choice enumerations.
  if (
    (/\b(?:from|among|including|such as)\b/i.test(t) || ILLUSTRATIVE_EXAMPLE_FRAMING.test(t)) &&
    langs.length >= 2 &&
    (CHOICE_LIST_ENUM.test(t) || /\bor\b/i.test(t) || /[/]/.test(t))
  ) {
    return true;
  }

  // "A, B, or C" without and/or token.
  if (/\bor\b/i.test(t) && langs.length >= 2) return true;

  return false;
};

/** Extract spans that look like disjunctive language requirement lists. */
export const extractDisjunctiveLanguageSpans = (blob: string): string[] => {
  const coalesced = coalesceProse(blob);
  const spans: string[] = [];

  const parenLists = coalesced.match(
    /(?:at\s+least\s+(?:one|\d+|1)|one\s+of(?:\s+the\s+following)?|any(?:\s+one)?\s+of|such\s+as|e\.g\.|including|from)[^.\n]{0,80}[\(:][^)\]]{5,400}[\)\]]/gi,
  );
  if (parenLists) spans.push(...parenLists);
  // `(e.g., Python/Go)` — the parenthesis wraps the example, rather than following `e.g.`.
  const wrappedExamples = coalesced.match(
    /\([^)\]]{0,40}(?:e\.g\.|eg\.|such as)[^)\]]{3,200}\)/gi,
  );
  if (wrappedExamples) spans.push(...wrappedExamples);

  // Cross-line / long-sentence: at least one … from A, B, and C
  const atLeastFrom = coalesced.match(
    /(?:proficiency\s+in\s+)?at\s+least\s+(?:one|\d+|1)\b[^.\n]{0,160}?\bfrom\b[^.\n]{5,220}/gi,
  );
  if (atLeastFrom) spans.push(...atLeastFrom);

  const oneOf = coalesced.match(
    /\b(?:one|any(?:\s+one)?)\s+of(?:\s+the\s+following)?\b[^.\n]{5,220}/gi,
  );
  if (oneOf) spans.push(...oneOf);

  for (const line of coalesced.split(/\n/)) {
    if (spanLooksDisjunctive(line)) spans.push(line);
    // Sentence splits within a single line only — never flatten newlines across bullets
    // (BisectHosting: React/Vue/or Nuxt must not absorb a separate PHP Laravel line).
    for (const sentence of line.split(/(?<=[.;])\s+/)) {
      const s = sentence.trim();
      if (s && spanLooksDisjunctive(s) && languagesInSpan(s).length >= 2) {
        spans.push(s);
      }
    }
  }

  const serverSideWindows = coalesced.match(
    /(?:server[-\s]?side|backend|web)\s+(?:web\s+)?(?:technology|technologies|language|languages)[^.]{0,350}/gi,
  );
  if (serverSideWindows) spans.push(...serverSideWindows);

  return [...new Set(spans.map((s) => s.trim()).filter(Boolean))];
};

const requirementLinesForDisjunctive = (job: ExtractedJobData): string[] => {
  const lines: string[] = [];
  for (const req of job.requirements ?? []) {
    const t = req.trim();
    if (t) lines.push(t);
  }
  for (const skill of job.requiredSkills ?? []) {
    const t = skill.trim();
    if (t && !lines.includes(t)) lines.push(t);
  }
  const raw = coalesceProse(job.rawText ?? "");
  for (const line of raw.split(/\n/)) {
    const t = line.trim();
    if (t && spanLooksDisjunctive(t) && !lines.some((l) => l === t)) {
      lines.push(t);
    }
  }
  return lines;
};

/**
 * True when every mandatory alternative group is satisfied independently.
 * A matched frontend/JS group never clears a separate Python/Java/C++ or Go/Python group.
 */
export const evaluateDisjunctiveLanguageRequirement = (
  job: ExtractedJobData,
  claimable: ClaimableStack,
): DisjunctiveLanguageEval => {
  const groups = extractLanguageRequirementGroups(job, claimable);
  const mandatoryAlts = groups.filter((group) => groupIsMandatoryAlternative(group.kind));
  const acceptedLabels = [
    ...new Set(mandatoryAlts.filter((group) => group.satisfied).flatMap((group) => group.languages)),
  ];
  return {
    satisfied: mandatoryAlts.length > 0 && mandatoryAlts.every((group) => group.satisfied),
    acceptedLabels,
    groups,
  };
};

/** Exclusive single-language requirement with no acceptable alternatives in the same clause. */
export const isExclusiveCoreLanguageRequirement = (blob: string, languageLabel: string): boolean => {
  const coalesced = coalesceProse(blob);
  const lines = coalesced.split("\n").filter(
    (l) =>
      new RegExp(
        `\\b${languageLabel.replace(/[+]/g, "\\+").replace(/#/g, "\\#")}\\b`,
        "i",
      ).test(l) ||
      (languageLabel === "C++" && /\bc\+\+/i.test(l)),
  );
  for (const line of lines) {
    const langsInLine = languagesInSpan(line);
    const hasDisjunctive = spanLooksDisjunctive(line) || langsInLine.length >= 2;
    if (EXCLUSIVE_REQUIREMENT.test(line) && !hasDisjunctive) return true;
  }
  return (
    EXCLUSIVE_REQUIREMENT.test(coalesced) &&
    !spanLooksDisjunctive(coalesced) &&
    languagesInSpan(coalesced).length <= 1
  );
};

/**
 * True when a language label appears in the JD inside disjunctive choice phrasing
 * and is not also an exclusive "must have / primary language" claim.
 */
export const languageOnlyInDisjunctiveChoice = (
  job: ExtractedJobData,
  languageLabel: string,
): boolean => {
  const entry = DISJUNCTIVE_LANGUAGE_CATALOG.find(
    (l) => l.label.toLowerCase() === languageLabel.toLowerCase(),
  );
  if (!entry) return false;

  const raw = coalesceProse(jobBlob(job));
  if (!entry.patterns.some((re) => re.test(raw))) return false;

  if (isExclusiveCoreLanguageRequirement(raw, entry.label)) return false;

  const spans = extractDisjunctiveLanguageSpans(raw);
  return spans.some(
    (span) => spanLooksDisjunctive(span) && entry.patterns.some((re) => re.test(span)),
  );
};

/** True when the language appears only inside `e.g.` / `such as` examples, not in the binding prefix. */
export const languageOnlyInIllustrativeExample = (
  job: ExtractedJobData,
  languageLabel: string,
): boolean => {
  const entry = DISJUNCTIVE_LANGUAGE_CATALOG.find(
    (l) => l.label.toLowerCase() === languageLabel.toLowerCase().split("/")[0]?.trim(),
  );
  const mentions = (text: string): boolean =>
    entry
      ? entry.patterns.some((pattern) => pattern.test(text))
      : new RegExp(`\\b${languageLabel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(text);

  const lines = coalesceProse(
    [job.rawText ?? "", ...(job.requirements ?? []), ...(job.responsibilities ?? [])].join("\n"),
  ).split(/\n/);

  let seenInIllustrative = false;
  let seenOutside = false;
  for (const line of lines) {
    if (!mentions(line)) continue;
    const match = line.match(ILLUSTRATIVE_EXAMPLE_FRAMING);
    if (!match || match.index == null) {
      seenOutside = true;
      continue;
    }
    const before = line.slice(0, match.index);
    const example = line.slice(match.index);
    if (mentions(before)) seenOutside = true;
    if (mentions(example)) seenInIllustrative = true;
  }
  return seenInIllustrative && !seenOutside;
};

const languageAppearsInConjunctiveRequirement = (
  raw: string,
  entry: (typeof DISJUNCTIVE_LANGUAGE_CATALOG)[number],
): boolean => {
  for (const line of coalesceProse(raw).split("\n")) {
    if (!entry.patterns.some((re) => re.test(line))) continue;
    if (ILLUSTRATIVE_EXAMPLE_FRAMING.test(line) || spanLooksDisjunctive(line)) continue;
    const langs = languagesInSpan(line);
    if (
      langs.length >= 2 &&
      /\b(must have|required|professional experience|strong (?:proficiency|fundamentals)|proficiency in)\b/i.test(
        line,
      )
    ) {
      return true;
    }
  }
  return false;
};

/**
 * True when a language appears only as an example ("such as" / "e.g.") of a category,
 * not as a closed at-least-one-of set and not as a conjunctive must-have.
 * NYT "technologies such as Go, Node.js" and Rippling "a backend language (e.g., Python/Go)".
 */
export const languageIsIllustrativeExampleOnly = (
  job: ExtractedJobData,
  languageLabel: string,
): boolean => {
  const entry = DISJUNCTIVE_LANGUAGE_CATALOG.find(
    (l) => l.label.toLowerCase() === languageLabel.toLowerCase().split("/")[0]?.trim(),
  );
  if (!entry) return false;

  const raw = coalesceProse(jobBlob(job));
  if (!entry.patterns.some((re) => re.test(raw))) return false;

  const prose = coalesceProse(
    [job.rawText ?? "", ...(job.requirements ?? []), ...(job.responsibilities ?? [])].join("\n"),
  );
  const exampleWindows = [
    ...(prose.match(/(?:such as|e\.g\.|eg\.)[^.\n]{0,200}/gi) ?? []),
    ...(prose.match(/\((?:e\.g\.|eg\.|such as)[^)]{3,220}\)/gi) ?? []),
    ...(prose.match(/\ba backend language\s*\([^)]{3,220}\)/gi) ?? []),
  ];
  const windowIsClosedChoice = (span: string): boolean => {
    if (CLOSED_CHOICE_FRAMING.test(span)) return true;
    const idx = prose.indexOf(span);
    if (idx < 0) return false;
    return CLOSED_CHOICE_FRAMING.test(prose.slice(Math.max(0, idx - 100), idx + span.length));
  };
  const inExampleWindow = exampleWindows.some(
    (span) =>
      entry.patterns.some((re) => re.test(span)) &&
      ILLUSTRATIVE_EXAMPLE_FRAMING.test(span) &&
      !windowIsClosedChoice(span),
  );
  if (inExampleWindow) {
    let rest = prose;
    for (const window of exampleWindows) rest = rest.replace(window, " ");
    if (!entry.patterns.some((re) => re.test(rest))) return true;
  }

  const spans = [
    ...extractDisjunctiveLanguageSpans(prose),
    ...prose.split("\n").map((l) => l.trim()).filter(Boolean),
    ...exampleWindows,
  ];
  let illustrative = false;
  for (const span of spans) {
    if (!entry.patterns.some((re) => re.test(span))) continue;
    if (!ILLUSTRATIVE_EXAMPLE_FRAMING.test(span)) continue;
    if (windowIsClosedChoice(span)) continue;
    if (languagesInSpan(span).length < 2 && !/\b(?:language|technologies|stack)\b/i.test(span)) {
      continue;
    }
    illustrative = true;
  }
  return illustrative;
};

/** True when a requirement line uses and/or (or similar) and candidate matches ≥1 listed stack item. */
export const lineDisjunctiveRequirementSatisfied = (
  line: string,
  claimable: ClaimableStack,
): boolean => {
  if (!spanLooksDisjunctive(line)) return false;
  const langs = languagesInSpan(line);
  if (langs.length < 2) return false;
  return langs.some((l) => candidateCoversLanguage(l, claimable));
};

/** Remove stack gaps that belong to a satisfied alternative group. Unrelated groups stay. */
export const filterGapsAfterDisjunctiveMatch = (
  coreLanguageGap: string[],
  disjunctive: DisjunctiveLanguageEval,
): string[] =>
  coreLanguageGap.filter((gap) => !languageClearedBySatisfiedDisjunctiveGroup(disjunctive, gap));

/** Out-of-lane language labels that belong to a satisfied alternative group should not flag. */
export const filterOutOfLaneAfterDisjunctiveMatch = (
  labels: string[],
  disjunctive: DisjunctiveLanguageEval,
): string[] =>
  labels.filter((label) => !languageClearedBySatisfiedDisjunctiveGroup(disjunctive, label));

const DISJUNCTIVE_GAP_FRAMING =
  /\b(no|without|lacks?|missing|not demonstrated|not listed|not in|unmet|gap|required core language|primary accepted|lists .{0,48} as (?:a )?(?:primary|required|common|accepted)|outside (?:the|your|claimable)|mismatch|weak(?:ness)?|limited|absent)\b/i;

const DISJUNCTIVE_POSITIVE_FRAMING =
  /\b(strong|solid|good|clear|align|match|overlap|proficiency in|demonstrated strength)\b/i;

const labelPatternsForRisk = (label: string): RegExp[] => {
  const entry = DISJUNCTIVE_LANGUAGE_CATALOG.find((l) => l.label === label);
  if (entry) return entry.patterns;
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return [new RegExp(`\\b${escaped}\\b`, "i")];
};

/**
 * True when prose treats a language from a satisfied disjunctive set as an unmet gap.
 * Used to keep Key Risks aligned with stack-fit resolution (and/or = any-one satisfied).
 */
export const riskContradictsSatisfiedDisjunctiveRequirement = (
  line: string,
  rules: Pick<
    RuleEvaluation,
    "disjunctiveLanguageRequirementSatisfied" | "disjunctiveAcceptedLanguages"
  >,
): boolean => {
  if (!rules.disjunctiveLanguageRequirementSatisfied) return false;
  const accepted = rules.disjunctiveAcceptedLanguages ?? [];
  if (accepted.length < 2) return false;

  const t = line.trim();
  if (!t) return false;

  const mentionsAccepted = accepted.some((label) =>
    labelPatternsForRisk(label).some((re) => re.test(t)),
  );
  if (!mentionsAccepted) return false;

  if (DISJUNCTIVE_POSITIVE_FRAMING.test(t) && !DISJUNCTIVE_GAP_FRAMING.test(t)) {
    return false;
  }

  return DISJUNCTIVE_GAP_FRAMING.test(t);
};

/** Drop risk/note lines that contradict a satisfied disjunctive language requirement. */
export const filterDisjunctiveContradictingRiskLines = (
  lines: string[],
  rules: Pick<
    RuleEvaluation,
    "disjunctiveLanguageRequirementSatisfied" | "disjunctiveAcceptedLanguages"
  >,
): string[] =>
  lines.filter((line) => !riskContradictsSatisfiedDisjunctiveRequirement(line, rules));

/**
 * Literal JD source quote required before asserting the role "leads with" a language.
 * Rejects inferred priority from skill-tag order or disjunctive choice lists.
 */
export const findLiteralLeadsWithSourceQuote = (
  job: ExtractedJobData,
  languageLabel: string,
): string | null => {
  const entry = DISJUNCTIVE_LANGUAGE_CATALOG.find(
    (l) => l.label.toLowerCase() === languageLabel.toLowerCase().split("/")[0]?.trim(),
  );
  const langNeedle =
    entry?.patterns[0] ??
    new RegExp(`\\b${languageLabel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");
  const mentionsLanguage = (line: string): boolean =>
    entry ? entry.patterns.some((pattern) => pattern.test(line)) : langNeedle.test(line);

  const LEADS_WITH_LITERAL =
    /\b(?:leads?\s+with|primary\s+(?:backend\s+)?language|our\s+(?:main|primary)\s+(?:backend\s+)?language|backend\s+(?:is|in|using)|written\s+(?:primarily\s+)?in)\b/i;

  const lines = coalesceProse(
    [job.rawText ?? "", ...(job.requirements ?? []), ...(job.responsibilities ?? [])].join("\n"),
  ).split(/\n/);

  for (const line of lines) {
    const strongNamed = strongNamedLanguageMatches(line, languageLabel);
    if (!mentionsLanguage(line) && !strongNamed) continue;
    if (spanLooksDisjunctive(line)) continue;
    if (languageOnlyInIllustrativeExample(job, entry?.label ?? languageLabel)) continue;
    if (languageOnlyInDisjunctiveChoice(job, entry?.label ?? languageLabel)) continue;
    if (
      LEADS_WITH_LITERAL.test(line) ||
      EXCLUSIVE_REQUIREMENT.test(line) ||
      strongNamedLanguageMatches(line, languageLabel)
    ) {
      return line.trim().slice(0, 240);
    }
    // Exclusive production/backend stack statement (not a choice list).
    if (
      /\b(production|backend|required)\b/i.test(line) &&
      languagesInSpan(line).length >= 1 &&
      languagesInSpan(line).length <= 2 &&
      !/\bat\s+least\b|\bone\s+of\b|\bany\s+of\b|\band\s*\/\s*or\b|\bfrom\b/i.test(line)
    ) {
      return line.trim().slice(0, 240);
    }
  }
  return null;
};
