import type { ExtractedJobData } from "../types/job.js";
import {
  evaluateDisjunctiveLanguageRequirement,
  filterGapsAfterDisjunctiveMatch,
  languageIsIllustrativeExampleOnly,
  languageOnlyInDisjunctiveChoice,
  lineDisjunctiveRequirementSatisfied,
} from "./disjunctiveLanguageRequirement.js";
import { GO_LANGUAGE_PATTERNS } from "./goLanguage.js";
import { filterLanguagesToJdPresence, termGroundedInJdRawText } from "./jdLanguagePresence.js";
import { termIsPreferredOrNarrativeOnly } from "./jdTagProvenance.js";
import { normalizeText } from "./text.js";
import type { ClaimableStack } from "./claimableStack.js";
import { hasClaimableCoverage } from "./claimableStack.js";

export type StackMismatchTier = "none" | "tier1_core_language" | "tier2_adjacent_framework";

export type StackMismatchAnalysis = {
  tier: StackMismatchTier;
  stackMismatch: boolean;
  coreLanguageGap: string[];
  adjacentFrameworkGap: string[];
};

const SOFT_SKILL_FRAMING =
  /\b(preferred|nice[- ]to[- ]haves?|a plus|bonus|ideally|optional|plus\b|familiarity with|exposure to)\b/i;

const JS_FRAMEWORK_FLEXIBLE_CLAUSE =
  /\b(other|modern|relevant)\s+(?:modern\s+)?(?:php\s+and\s+)?(?:java\s*script|javascript|js|typescript|ts)[^.\n]{0,80}(?:frameworks?|stacks?)\s+(?:accepted|welcome|considered|ok)\b/i;

type TechToken = {
  id: string;
  label: string;
  family: string;
  kind: "core_language" | "framework";
  claimableId?: string;
  patterns: RegExp[];
};

const TECH_TOKENS: TechToken[] = [
  { id: "php", label: "PHP", family: "php", kind: "core_language", patterns: [/\bphp\b/i, /\blaravel\b/i] },
  { id: "java", label: "Java", family: "java", kind: "core_language", patterns: [/\bjava\b/i] },
  { id: "go", label: "Go", family: "go", kind: "core_language", patterns: GO_LANGUAGE_PATTERNS },
  { id: "ruby", label: "Ruby", family: "ruby", kind: "core_language", patterns: [/\bruby\b/i, /\brails\b/i] },
  { id: "csharp", label: "C#/.NET", family: "csharp", kind: "core_language", patterns: [/\bc#\b/i, /\bcsharp\b/i, /\.net\b/i] },
  { id: "cpp", label: "C/C++", family: "cpp", kind: "core_language", patterns: [/\bc\+\+\b/i, /\bc\/c\+\+\b/i] },
  { id: "rust", label: "Rust", family: "rust", kind: "core_language", patterns: [/\brust\b/i] },
  { id: "salesforce", label: "Salesforce/Apex", family: "salesforce", kind: "core_language", patterns: [/\bsalesforce\b/i, /\bapex\b/i] },
  { id: "brightspot", label: "BrightSpot", family: "brightspot", kind: "core_language", patterns: [/\bbrightspot\b/i] },
  { id: "swift", label: "Swift", family: "mobile", kind: "core_language", patterns: [/\bswift\b/i] },
  { id: "kotlin", label: "Kotlin", family: "mobile", kind: "core_language", patterns: [/\bkotlin\b/i] },
  { id: "vue", label: "Vue", family: "javascript", kind: "framework", patterns: [/\bvue(?:\.js)?\b/i] },
  { id: "angular", label: "Angular", family: "javascript", kind: "framework", patterns: [/\bangular\b/i] },
  { id: "typescript", label: "TypeScript", family: "javascript", kind: "framework", claimableId: "typescript", patterns: [/\btype\s*script\b/i] },
  { id: "javascript", label: "JavaScript", family: "javascript", kind: "framework", claimableId: "javascript", patterns: [/\bjava\s*script\b/i] },
  { id: "react", label: "React", family: "javascript", kind: "framework", claimableId: "react", patterns: [/\breact\b/i] },
  { id: "nodejs", label: "Node.js", family: "javascript", kind: "framework", claimableId: "nodejs", patterns: [/\bnode(?:\.js)?\b/i] },
  { id: "python", label: "Python", family: "python", kind: "core_language", claimableId: "python", patterns: [/\bpython\b/i] },
  { id: "terraform", label: "Terraform", family: "infra", kind: "framework", patterns: [/\bterraform\b/i] },
  { id: "redis", label: "Redis", family: "infra", kind: "framework", patterns: [/\bredis\b/i] },
  { id: "kubernetes", label: "Kubernetes", family: "infra", kind: "framework", patterns: [/\bkubernetes\b/i, /\bk8s\b/i] },
];

const INFRA_CORE_STACK_IDS = new Set(["terraform", "redis", "kubernetes"]);

const isSoftContext = (context: string): boolean => SOFT_SKILL_FRAMING.test(context);

const matchTokens = (text: string): TechToken[] => {
  const found: TechToken[] = [];
  for (const token of TECH_TOKENS) {
    if (token.patterns.some((re) => re.test(text))) found.push(token);
  }
  return found;
};

const extractRequiredSkillLines = (job: ExtractedJobData): string[] => {
  const lines: string[] = [];
  for (const skill of job.requiredSkills ?? []) {
    if (
      skill.trim() &&
      termGroundedInJdRawText(skill, job) &&
      !termIsPreferredOrNarrativeOnly(skill, job)
    ) {
      lines.push(skill.trim());
    }
  }
  for (const req of job.requirements ?? []) {
    if (req.trim() && !isSoftContext(req) && termGroundedInJdRawText(req, job)) {
      lines.push(req.trim());
    }
  }
  // JD stack section is an authoritative core-tech list — count even when not
  // echoed verbatim in Requirements bullets (Bubble Scaling / platform roles).
  // Prefer/nice-to-have-only chips must not become required core gaps (Cherry Kotlin).
  for (const stack of job.stack ?? []) {
    if (
      stack.trim() &&
      termGroundedInJdRawText(stack, job) &&
      !termIsPreferredOrNarrativeOnly(stack, job)
    ) {
      lines.push(stack.trim());
    }
  }
  return [...new Set(lines)];
};

const lineFromJdStackArray = (line: string, job: ExtractedJobData): boolean =>
  (job.stack ?? []).some((s) => normalizeText(s) === normalizeText(line));

const lineIsRequired = (line: string, job: ExtractedJobData): boolean => {
  const norm = normalizeText(line);
  if (isSoftContext(norm)) return false;
  if (termIsPreferredOrNarrativeOnly(line, job)) return false;
  if ((job.preferredSkills ?? []).some((p) => normalizeText(p) === norm)) return false;
  const raw = job.rawText ?? "";
  const escaped = line.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const softNear = new RegExp(
    `(preferred|nice[- ]to[- ]haves?|a plus|bonus|ideally|optional|familiarity with)[^.\\n]{0,120}${escaped}|${escaped}[^.\\n]{0,120}(preferred|nice[- ]to[- ]haves?|a plus|bonus|ideally|optional)`,
    "i",
  );
  if (softNear.test(raw) && !/\b(required|must have|minimum)\b/i.test(norm)) return false;
  return true;
};

const isCoreLanguageRequirement = (token: TechToken, line: string, index: number): boolean => {
  const ctx = normalizeText(line);
  if (token.kind !== "core_language") return false;
  if (
    /\b(must have|required|minimum|proficiency in|experience with|experience developing|strong)\b/i.test(
      ctx,
    )
  ) {
    return true;
  }
  if (/\busing\s+(php|ruby|java|go|python|laravel)\b/i.test(ctx)) return true;
  if (
    /\b(apis?|applications?)\s+(using|in|with)\b/i.test(ctx) &&
    token.patterns.some((re) => re.test(ctx))
  ) {
    return true;
  }
  if (/\bcustom\s+php\b|\bphp\s+full[-\s]?stack\b|\bphp\s+development\b/i.test(ctx)) return true;
  if (/\bprimary\s+(backend\s+)?language\b/i.test(ctx)) return true;
  if (index < 2 && token.patterns.some((re) => re.test(ctx))) return true;
  if (/\b(full[-\s]?stack|backend|development)\b/i.test(ctx) && token.patterns.some((re) => re.test(ctx))) {
    return true;
  }
  return false;
};

const isCoreFrameworkRequirement = (token: TechToken, line: string, index: number): boolean => {
  if (token.kind !== "framework") return false;
  const ctx = normalizeText(line);
  if (isSoftContext(ctx)) return false;
  if (/\b(must have|required|proficiency|experience with|strong)\b/i.test(ctx)) return true;
  if (index < 2 && token.patterns.some((re) => re.test(ctx))) return true;
  return token.patterns.some((re) => re.test(ctx)) && !JS_FRAMEWORK_FLEXIBLE_CLAUSE.test(ctx);
};

const candidateCoversFamily = (family: string, claimable: ClaimableStack): boolean => {
  const familyClaimableIds: Record<string, string[]> = {
    javascript: ["typescript", "javascript", "nodejs", "react"],
    python: ["python"],
  };
  const ids = familyClaimableIds[family] ?? [];
  return ids.some((id) => hasClaimableCoverage(claimable, id));
};

const pythonFlexibleWithJsTs = (blob: string): boolean =>
  /\bpython\b/i.test(blob) &&
  /\b(type\s*script|typescript|javascript|node\.?js|js)\b/i.test(blob) &&
  (/\bpython\s+(and\s*\/\s*or|and\/or|or)\s+(java\s*script|typescript|js|node)\b/i.test(blob) ||
    /\b(java\s*script|typescript|js|node)\s+(and\s*\/\s*or|and\/or|or)\s+python\b/i.test(blob) ||
    /\b(either|any)\s+(of\s+)?(python|typescript|javascript)\b/i.test(blob));

const STACK_INVENTORY_FRAMING =
  /\b(our (?:tech )?stack|tech stack|we (?:use|work with)|stack includes|technologies we use|comfortable working across both front-end and back-end)\b/i;

const CONJUNCTIVE_ALL_REQUIRED =
  /\b(must (?:have|know) all|required to know all|proficiency in all of)\b/i;

const PYTHON_EXCLUSIVE =
  /\b(must have|required|primary (?:backend )?language|professional experience with|strong proficiency in)\b[^.\n]{0,60}\bpython\b|\bpython\b[^.\n]{0,60}\b(required|must have|primary)\b/i;

const PYTHON_CONJUNCTIVE_AND =
  /\b(must (?:have|know)|required(?: skills)?:?|proficiency in)\b[^.\n]{0,120}\band\b[^.\n]{0,80}\bpython\b/i;

const PYTHON_BACKEND_FRAMEWORK = /\b(fastapi|django|flask)\b/i;

const lineHasJsOrTs = (line: string): boolean =>
  /\b(type\s*script|typescript|javascript|node(?:\.js)?|react)\b/i.test(line);

/** Descriptive "our stack: A, B, C" inventories — not "must know A, B, and C". */
export const lineLooksLikeTechStackInventory = (line: string): boolean => {
  const t = normalizeText(line);
  if (!t || CONJUNCTIVE_ALL_REQUIRED.test(t)) return false;
  if (STACK_INVENTORY_FRAMING.test(t)) return true;
  if (/\btech stack\s*:/i.test(t)) return true;
  return false;
};

const sentenceContainsPythonInventory = (job: ExtractedJobData): boolean => {
  const blob = [job.rawText ?? "", ...(job.requirements ?? []), ...(job.requiredSkills ?? [])].join(
    "\n",
  );
  return blob.split(/[\n.;]/).some((sentence) => {
    const s = sentence.trim();
    return lineLooksLikeTechStackInventory(s) && /\bpython\b/i.test(s) && lineHasJsOrTs(s);
  });
};

export const pythonIsExclusiveCoreRequirement = (job: ExtractedJobData): boolean => {
  if (/\bpython\b/i.test(job.title ?? "")) return true;
  const blob = [
    job.rawText ?? "",
    ...(job.requirements ?? []),
    ...(job.requiredSkills ?? []),
    ...(job.responsibilities ?? []),
  ].join("\n");
  for (const line of blob.split(/\n/)) {
    const t = line.trim();
    if (!/\bpython\b/i.test(t) && !PYTHON_BACKEND_FRAMEWORK.test(t)) continue;
    if (lineLooksLikeTechStackInventory(t) && lineHasJsOrTs(t)) continue;
    if (PYTHON_EXCLUSIVE.test(t) && !lineHasJsOrTs(t)) return true;
    if (PYTHON_EXCLUSIVE.test(t) && !lineLooksLikeTechStackInventory(t)) return true;
    if (PYTHON_CONJUNCTIVE_AND.test(t) && !lineLooksLikeTechStackInventory(t)) return true;
    if (
      /\bstrong fundamentals\b/i.test(t) &&
      /\bpython\b/i.test(t) &&
      !lineLooksLikeTechStackInventory(t) &&
      !/\b(?:such as|e\.g\.|and\s*\/\s*or|\bor\b)\b/i.test(t)
    ) {
      return true;
    }
    if (
      PYTHON_BACKEND_FRAMEWORK.test(t) &&
      !lineHasJsOrTs(t) &&
      /\b(experience|required|must|proficiency|apis?|backend|build)\b/i.test(t)
    ) {
      return true;
    }
  }
  return false;
};

/** Python listed beside TS/React as a team stack, not as the required primary language. */
export const pythonOnMixedStackInventory = (job: ExtractedJobData, line?: string): boolean => {
  if (pythonIsExclusiveCoreRequirement(job)) return false;
  if (line && lineLooksLikeTechStackInventory(line) && /\bpython\b/i.test(line) && lineHasJsOrTs(line)) {
    return true;
  }
  return sentenceContainsPythonInventory(job);
};

/**
 * Two-tier stack mismatch: Tier 1 = missing required core language; Tier 2 = same-family framework gap.
 * Only required skills count — preferred / nice-to-have are ignored for gap detection.
 */
export const analyzeStackMismatch = (
  job: ExtractedJobData,
  claimable: ClaimableStack,
): StackMismatchAnalysis => {
  const requiredLines = extractRequiredSkillLines(job).filter(
    (line) => lineFromJdStackArray(line, job) || lineIsRequired(line, job),
  );
  const qualificationBullets = (job.requirements ?? []).filter((r) => !isSoftContext(r)).slice(0, 2);
  const blob = normalizeText(
    [job.title, job.rawText, ...requiredLines, ...(job.requirements ?? [])].join("\n"),
  );
  const jsFrameworkFlexible = JS_FRAMEWORK_FLEXIBLE_CLAUSE.test(blob);
  const pythonFlexible = pythonFlexibleWithJsTs(blob);

  const coreLanguageGaps: string[] = [];
  const adjacentFrameworkGaps: string[] = [];

  const allScanLines = [...qualificationBullets, ...requiredLines];
  for (let i = 0; i < allScanLines.length; i++) {
    const line = allScanLines[i]!;
    if (lineDisjunctiveRequirementSatisfied(line, claimable)) continue;
    const tokens = matchTokens(line);
    for (const token of tokens) {
      if (token.claimableId && hasClaimableCoverage(claimable, token.claimableId)) continue;
      if (token.id === "python" && pythonFlexible) continue;
      if (token.id === "python" && pythonOnMixedStackInventory(job, line)) continue;

      if (token.kind === "core_language") {
        if (!isCoreLanguageRequirement(token, line, i) && !lineFromJdStackArray(line, job)) continue;
        if (token.id === "python" && pythonOnMixedStackInventory(job, line)) continue;
        if (jsFrameworkFlexible && token.family === "javascript") continue;
        coreLanguageGaps.push(token.label);
        continue;
      }

      if (token.kind === "framework") {
        const fromStack = lineFromJdStackArray(line, job);
        if (!isCoreFrameworkRequirement(token, line, i) && !fromStack) continue;
        if (token.claimableId && hasClaimableCoverage(claimable, token.claimableId)) continue;
        // Core infra stack chips (Terraform/Redis/K8s) listed on the JD stack → tier-1 gap.
        if (INFRA_CORE_STACK_IDS.has(token.id) && (fromStack || isCoreFrameworkRequirement(token, line, i))) {
          coreLanguageGaps.push(token.label);
          continue;
        }
        if (token.family === "javascript" && candidateCoversFamily("javascript", claimable)) {
          adjacentFrameworkGaps.push(token.label);
        } else if (token.family !== "javascript" && !token.claimableId) {
          // Non-JS framework with no claimable path and required/stack grounding.
          coreLanguageGaps.push(token.label);
        } else if (token.family === "javascript" && !candidateCoversFamily("javascript", claimable)) {
          adjacentFrameworkGaps.push(token.label);
        }
      }
    }
  }

  for (const line of [...(job.requirements ?? []), ...requiredLines]) {
    if (/\bcustom\s+php\b|\bphp\s+full[-\s]?stack\b|\bphp\s+development\b/i.test(line)) {
      if (!coreLanguageGaps.includes("PHP")) coreLanguageGaps.push("PHP");
      continue;
    }
    if (
      /\b(laravel|php)\b/i.test(line) &&
      /\b(experience|developing|backend|apis?|applications?)\b/i.test(line) &&
      !lineDisjunctiveRequirementSatisfied(line, claimable)
    ) {
      const label = /\blaravel\b/i.test(line) ? "PHP/Laravel" : "PHP";
      if (!coreLanguageGaps.includes(label)) coreLanguageGaps.push(label);
    }
  }

  const disjunctive = evaluateDisjunctiveLanguageRequirement(job, claimable);
  const uniqueCoreRaw = filterGapsAfterDisjunctiveMatch([...new Set(coreLanguageGaps)], disjunctive);
  // Language gaps must appear in JD language set; infra stack chips must appear in JD rawText.
  // Preferred/nice-to-have-only languages never become tier-1 core gaps.
  // Example-only languages ("such as Go", "e.g., Python/Go") are not mandatory even when
  // the example set is unsatisfied; conjunctive "TypeScript, Python, and React" stays.
  const jdValidatedCore = uniqueCoreRaw.filter((label) => {
    if (termIsPreferredOrNarrativeOnly(label, job)) return false;
    if (languageIsIllustrativeExampleOnly(job, label)) return false;
    if (languageOnlyInDisjunctiveChoice(job, label) && disjunctive.satisfied) return false;
    if (/^(Terraform|Redis|Kubernetes)$/i.test(label)) {
      return termGroundedInJdRawText(label, job);
    }
    return filterLanguagesToJdPresence([label], job).includes(label);
  });
  const uniqueAdjacent = [...new Set(adjacentFrameworkGaps)].filter(
    (label) => !jdValidatedCore.includes(label),
  );

  if (jdValidatedCore.length > 0) {
    return {
      tier: "tier1_core_language",
      stackMismatch: true,
      coreLanguageGap: jdValidatedCore,
      adjacentFrameworkGap: uniqueAdjacent,
    };
  }

  if (uniqueAdjacent.length > 0) {
    return {
      tier: "tier2_adjacent_framework",
      stackMismatch: false,
      coreLanguageGap: [],
      adjacentFrameworkGap: uniqueAdjacent,
    };
  }

  return {
    tier: "none",
    stackMismatch: false,
    coreLanguageGap: [],
    adjacentFrameworkGap: [],
  };
};
