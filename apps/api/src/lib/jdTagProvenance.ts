import type { ExtractedJobData } from "../types/job.js";
import { normalizeText } from "./text.js";
import { GO_LANGUAGE_PATTERNS } from "./goLanguage.js";

/** Where in the JD a tag was sourced — drives penalty eligibility. */
export type TagSourceStrength = "REQUIRED" | "PREFERRED" | "NARRATIVE";

export type ExtractedSkillTag = {
  term: string;
  sourceQuote: string;
  strength: TagSourceStrength;
};

const REQUIRED_SECTION_RE =
  /^(requirements?|qualifications?|basic qualifications?|minimum qualifications?|your experience|must[- ]haves?|what you(?:'?ll)? need|what we'?re looking for|responsibilities|what you'?ll do|in this role)\b/i;

/** Short identity headers that must not match body lines like "You have a passion…". */
const REQUIRED_SHORT_HEADER_RE = /^(you have|you bring)$/i;

const PREFERRED_SECTION_RE =
  /^(nice[- ]to[- ]haves?|considered a plus|bonus(?:\s+points)?|preferred qualifications?|preferred skills?|what'?s a plus|optional)\b/i;

const NARRATIVE_SECTION_RE =
  /^(who you are|about the team|about us|who we are|about this role|culture|our values|why join|the role|about the role|what success looks like)$/i;

/** Simplify / board skill-chip cloud — not authoritative Required prose. */
const SKILL_CHIP_SECTION_RE = /^required skills$/i;

const DESIGN_TOOL_TERMS =
  /\b(figma|sketch|adobe\s*xd|invision|framer|design\s+portfolio|wireframe|prototyp|pixel[-\s]?perfect)\b/i;

const DESIGN_NARRATIVE_ONLY =
  /\b(good design|delightful\s+ux|design[-\s]craft|visual\s+craft|design\s+sense|eye for design)\b/i;

/** Canonical aliases → regex patterns that must match in raw JD text. */
const TERM_PRESENCE: Array<{ norm: string; patterns: RegExp[] }> = [
  { norm: "figma", patterns: [/\bfigma\b/i] },
  { norm: "typescript", patterns: [/\btype\s*script\b/i, /\btypescript\b/i] },
  { norm: "javascript", patterns: [/\bjava\s*script\b/i, /\bjavascript\b/i] },
  { norm: "react", patterns: [/\breact(?:\.js)?\b/i] },
  { norm: "ruby on rails", patterns: [/\bruby\s+on\s+rails\b/i] },
  { norm: "ruby", patterns: [/\bruby\b/i, /\brails\b/i] },
  { norm: "postgres", patterns: [/\bpostgres(?:ql)?\b/i] },
  { norm: "postgresql", patterns: [/\bpostgres(?:ql)?\b/i] },
  { norm: "node.js", patterns: [/\bnode(?:\.js)?\b/i] },
  { norm: "python", patterns: [/\bpython\b/i] },
  { norm: "go", patterns: GO_LANGUAGE_PATTERNS },
  { norm: "ui/ux design", patterns: [/\bui\s*\/\s*ux\b/i, /\bui\/ux\s+design\b/i] },
  { norm: "ui/ux", patterns: [/\bui\s*\/\s*ux\b/i] },
  { norm: "rest apis", patterns: [/\brest\s+apis?\b/i, /\brestful\b/i] },
  { norm: "graphql", patterns: [/\bgraphql\b/i] },
  { norm: "docker", patterns: [/\bdocker\b/i] },
  { norm: "kubernetes", patterns: [/\bkubernetes\b/i, /\bk8s\b/i] },
  { norm: "aws", patterns: [/\baws\b/i] },
];

const normalizeTerm = (term: string): string =>
  term
    .trim()
    .toLowerCase()
    .replace(/\.js$/i, "")
    .replace(/\s+/g, " ");

const termLiterallyInText = (term: string, rawText: string): boolean => {
  const blob = rawText;
  const norm = normalizeTerm(term);
  for (const entry of TERM_PRESENCE) {
    if (norm.includes(entry.norm) || entry.norm.includes(norm)) {
      if (entry.patterns.some((re) => re.test(blob))) return true;
    }
  }
  // Fallback: significant tokens from the label appear verbatim (≥4 chars).
  const words = norm.split(/\s+/).filter((w) => w.length >= 4);
  if (words.length === 0) return new RegExp(`\\b${escapeRegExp(norm)}\\b`, "i").test(blob);
  return words.every((w) => new RegExp(`\\b${escapeRegExp(w)}\\b`, "i").test(blob));
};

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const classifyLineStrength = (line: string, section: TagSourceStrength | null): TagSourceStrength => {
  const trimmed = line.trim();
  // Strip trailing chrome ("Nice-to-Haves: Familiarity with our stack").
  const headerProbe = trimmed.replace(/:\s*.*$/, "").trim();
  if (SKILL_CHIP_SECTION_RE.test(headerProbe) || SKILL_CHIP_SECTION_RE.test(trimmed)) {
    return "PREFERRED";
  }
  if (
    REQUIRED_SECTION_RE.test(headerProbe) ||
    REQUIRED_SECTION_RE.test(trimmed) ||
    REQUIRED_SHORT_HEADER_RE.test(headerProbe)
  ) {
    return "REQUIRED";
  }
  if (PREFERRED_SECTION_RE.test(headerProbe) || PREFERRED_SECTION_RE.test(trimmed)) return "PREFERRED";
  if (NARRATIVE_SECTION_RE.test(headerProbe) || NARRATIVE_SECTION_RE.test(trimmed)) return "NARRATIVE";
  // Under an explicit Preferred section, do not upgrade "Experience with …" / "Familiarity with …" to REQUIRED.
  if (section === "PREFERRED") {
    if (/\b(must have|required|mandatory)\b/i.test(trimmed)) return "REQUIRED";
    return "PREFERRED";
  }
  const preferredCue =
    /\b(nice[- ]to[- ]haves?|considered a plus|bonus|preferred|ideally|optional|familiarity with|is a plus|\ba plus\b)\b/i.test(
      trimmed,
    );
  if (preferredCue && !/\b(must have|required|mandatory)\b/i.test(trimmed)) {
    return "PREFERRED";
  }
  if (
    /\b(must have|required|minimum|proficiency in|strong fundamentals|experience with|primary (?:backend )?language)\b/i.test(
      trimmed,
    )
  ) {
    return "REQUIRED";
  }
  return section ?? "NARRATIVE";
};

const strengthRank = (s: TagSourceStrength): number =>
  s === "REQUIRED" ? 3 : s === "PREFERRED" ? 2 : 1;

const maxStrength = (a: TagSourceStrength, b: TagSourceStrength): TagSourceStrength =>
  strengthRank(a) >= strengthRank(b) ? a : b;

/** Map each JD line to its section strength while scanning top-to-bottom. */
export const classifyJdLines = (rawText: string): Array<{ line: string; strength: TagSourceStrength }> => {
  const out: Array<{ line: string; strength: TagSourceStrength }> = [];
  let section: TagSourceStrength | null = null;
  for (const rawLine of rawText.split(/\n+/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const headerProbe = line.replace(/:\s*.*$/, "").trim();
    const isHeader =
      REQUIRED_SECTION_RE.test(headerProbe) ||
      REQUIRED_SECTION_RE.test(line) ||
      REQUIRED_SHORT_HEADER_RE.test(headerProbe) ||
      PREFERRED_SECTION_RE.test(headerProbe) ||
      PREFERRED_SECTION_RE.test(line) ||
      NARRATIVE_SECTION_RE.test(headerProbe) ||
      NARRATIVE_SECTION_RE.test(line) ||
      SKILL_CHIP_SECTION_RE.test(headerProbe) ||
      SKILL_CHIP_SECTION_RE.test(line);
    if (isHeader) {
      section = classifyLineStrength(line, null);
      out.push({ line, strength: section });
      continue;
    }
    out.push({ line, strength: classifyLineStrength(line, section) });
  }
  return out;
};

const findSourceQuote = (term: string, classified: Array<{ line: string; strength: TagSourceStrength }>): {
  quote: string;
  strength: TagSourceStrength;
} | null => {
  const norm = normalizeTerm(term);
  let best: { quote: string; strength: TagSourceStrength } | null = null;
  for (const { line, strength } of classified) {
    if (!termLiterallyInText(term, line) && !line.toLowerCase().includes(norm)) continue;
    if (!best || strengthRank(strength) > strengthRank(best.strength)) {
      best = { quote: line.slice(0, 240), strength };
    }
  }
  return best;
};

/** Build provenance records for all stack/skill tags present in extraction arrays. */
export const buildJdTagProvenance = (job: ExtractedJobData): ExtractedSkillTag[] => {
  const raw = job.rawText?.trim() ?? "";
  if (!raw) return [];
  const classified = classifyJdLines(raw);
  const terms = [
    ...(job.stack ?? []),
    ...(job.requiredSkills ?? []),
    ...(job.preferredSkills ?? []),
    ...(job.domainTags ?? []),
  ];
  const seen = new Set<string>();
  const tags: ExtractedSkillTag[] = [];
  for (const term of terms) {
    const key = normalizeTerm(term);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    if (!termLiterallyInText(term, raw)) continue;
    const hit = findSourceQuote(term, classified);
    if (!hit) continue;
    tags.push({ term, sourceQuote: hit.quote, strength: hit.strength });
  }
  return tags;
};

const filterArrayByProvenance = (
  items: string[],
  provenance: Map<string, ExtractedSkillTag>,
  minStrength: TagSourceStrength,
): string[] =>
  items.filter((term) => {
    const key = normalizeTerm(term);
    const tag = provenance.get(key);
    if (!tag) return false;
    return strengthRank(tag.strength) >= strengthRank(minStrength);
  });

/** Drop hallucinated / narrative-only tags; downgrade Simplify chip-only skills. */
export const sanitizeExtractedTags = (job: ExtractedJobData): ExtractedJobData => {
  const raw = job.rawText?.trim() ?? "";
  if (!raw) return job;

  const provenanceList = buildJdTagProvenance(job);
  const provenance = new Map(provenanceList.map((t) => [normalizeTerm(t.term), t]));

  // Strip terms not literally grounded in JD text.
  const grounded = (items: string[]) =>
    items.filter((term) => termLiterallyInText(term, raw));

  let stack = grounded(job.stack ?? []);
  let requiredSkills = grounded(job.requiredSkills ?? []);
  let preferredSkills = grounded(job.preferredSkills ?? []);

  // Figma / design-tool tags require literal tool mention — never infer from "good design".
  const stripInventedDesignTools = (items: string[]) =>
    items.filter((term) => {
      const norm = normalizeTerm(term);
      if (!DESIGN_TOOL_TERMS.test(term) && !/\bui\s*\/\s*ux\b/i.test(term)) return true;
      if (DESIGN_TOOL_TERMS.test(raw)) return true;
      if (/\bui\s*\/\s*ux\b/i.test(term) && /\bui\s*\/\s*ux\b/i.test(raw)) {
        // UI/UX only counts when literally in JD — still may be chip-only (PREFERRED).
        return true;
      }
      return false;
    });

  stack = stripInventedDesignTools(stack);
  requiredSkills = stripInventedDesignTools(requiredSkills);
  preferredSkills = stripInventedDesignTools(preferredSkills);

  // Required arrays: only REQUIRED-strength tags (not narrative / chip-only).
  requiredSkills = filterArrayByProvenance(requiredSkills, provenance, "REQUIRED");
  // Stack follows required + preferred grounded tags.
  stack = [...new Set([...filterArrayByProvenance(stack, provenance, "PREFERRED"), ...requiredSkills])];

  // Skill-chip-only tags (UI/UX Design) belong in preferred, not required.
  for (const term of grounded(job.requiredSkills ?? [])) {
    const tag = provenance.get(normalizeTerm(term));
    if (tag?.strength === "PREFERRED" && !preferredSkills.includes(term)) {
      preferredSkills.push(term);
    }
  }
  preferredSkills = [...new Set([...preferredSkills, ...filterArrayByProvenance(preferredSkills, provenance, "PREFERRED")])];

  return {
    ...job,
    stack,
    requiredSkills,
    preferredSkills,
    skillTags: provenanceList,
  };
};

/** Highest provenance strength for a term, or null when absent from JD text. */
export const termProvenanceStrength = (
  term: string,
  job: ExtractedJobData,
): TagSourceStrength | null => {
  const tags = job.skillTags?.length ? job.skillTags : buildJdTagProvenance(job);
  const key = normalizeTerm(term);
  const hit = tags.find((t) => normalizeTerm(t.term) === key);
  if (hit) return hit.strength;
  const raw = job.rawText?.trim() ?? "";
  if (!raw || !termLiterallyInText(term, raw)) return null;
  const classified = classifyJdLines(raw);
  const quote = findSourceQuote(term, classified);
  return quote?.strength ?? null;
};

/** True when the term is only preferred/narrative in the JD (never required). */
export const termIsPreferredOrNarrativeOnly = (term: string, job: ExtractedJobData): boolean => {
  if ((job.preferredSkills ?? []).some((p) => normalizeTerm(p) === normalizeTerm(term))) {
    const strength = termProvenanceStrength(term, job);
    if (strength === "REQUIRED") return false;
    return true;
  }
  const strength = termProvenanceStrength(term, job);
  return strength === "PREFERRED" || strength === "NARRATIVE";
};

/** Tags at or above min strength — for scoring / gap detection. */
export const tagsAtLeastStrength = (
  job: ExtractedJobData,
  minStrength: TagSourceStrength,
): ExtractedSkillTag[] =>
  (job.skillTags ?? buildJdTagProvenance(job)).filter(
    (t) => strengthRank(t.strength) >= strengthRank(minStrength),
  );

/** True when JD has explicit design-tool / portfolio requirements (not narrative UX prose). */
export const jdHasExplicitDesignToolRequirement = (job: ExtractedJobData): boolean => {
  const reqBlob = normalizeText([...(job.requirements ?? [])].join("\n"));
  if (DESIGN_TOOL_TERMS.test(reqBlob)) return true;
  return tagsAtLeastStrength(job, "REQUIRED").some(
    (t) => DESIGN_TOOL_TERMS.test(t.term) || /\bdesign\s+portfolio\b/i.test(t.term),
  );
};

/** Narrative-only design language must not drive penalties. */
export const jdHasNarrativeDesignLanguageOnly = (job: ExtractedJobData): boolean => {
  if (jdHasExplicitDesignToolRequirement(job)) return false;
  const raw = job.rawText ?? "";
  return DESIGN_NARRATIVE_ONLY.test(raw) || /\bdelightful\s+ux\b/i.test(raw);
};
