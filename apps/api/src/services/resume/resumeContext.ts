import fs from "node:fs/promises";
import { PDFParse } from "pdf-parse";
import { logger } from "../../lib/logger.js";
import { RESUME_TYPES, type ResumeType } from "../../types/resume.js";
import type {
  ResumeClaimSupport,
  ResumeContext,
  ResumeContextMetadata,
  ResumeContextSet,
  ResumeProjectEvidence,
  ResumeRoleShape,
} from "../../types/resumeContext.js";
import { pickResumeSourcePath } from "../../config/resumeContext.js";

type CacheEntry = { attempted: boolean; context: ResumeContext | null };

const STOPWORDS = new Set([
  "the",
  "and",
  "with",
  "for",
  "that",
  "this",
  "from",
  "into",
  "your",
  "you",
  "have",
  "role",
  "team",
  "work",
  "using",
  "used",
  "build",
  "built",
  "engineer",
  "engineering",
  "software",
  "experience",
]);

const CLAIM_PATTERNS: Array<{ claim: string; re: RegExp }> = [
  { claim: "TypeScript development", re: /\btypescript\b/i },
  { claim: "Node.js backend work", re: /\bnode(\.js)?\b/i },
  { claim: "React frontend work", re: /\breact\b/i },
  { claim: "API design and integration", re: /\bapi(s)?\b|\bintegration(s)?\b/i },
  { claim: "Internal tools/product systems", re: /\binternal tools?\b|\bproduct\b/i },
  { claim: "Stakeholder collaboration", re: /\bstakeholder\b|\bcross-functional\b/i },
  { claim: "Implementation/delivery execution", re: /\bimplementation\b|\bdelivery\b|\bonboarding\b/i },
];

const ROLE_SHAPES: Record<ResumeType, ResumeRoleShape[]> = {
  BASE: ["product_fullstack", "early_career"],
  AI: ["applied_ai", "product_fullstack"],
  FDE: ["integration_delivery", "product_fullstack", "applied_ai"],
};

const AVOID_USE_CASES: Record<ResumeType, string[]> = {
  BASE: ["Roles whose core work is LLM/RAG/agent systems (use AI)", "Deep platform/SRE ownership claims"],
  AI: ["General product/full-stack roles with no AI component", "ML research or model-training roles (no training experience)"],
  FDE: ["Roles whose core work is LLM evaluation or agent research (use AI)", "Deep platform/SRE ownership claims"],
};

const clip = (s: string, n: number): string => (s.length <= n ? s : `${s.slice(0, n - 3)}...`);

const normalizeText = (raw: string): string =>
  raw
    .replace(/\r/g, "\n")
    .replace(/\t/g, " ")
    .replace(/[ ]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

const cleanResumeLine = (line: string): string =>
  line
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .replace(/^[\s•●▪◦‣·\-–—*]+\s*/u, "")
    .replace(/\s+/g, " ")
    .replace(/\s+([,.;:!?])/g, "$1")
    .trim();

const sentenceLikeSnippet = (line: string): string => {
  const cleaned = cleanResumeLine(line);
  if (!cleaned) return "";
  const parts = cleaned
    .split(/(?<=[.!?])\s+/)
    .map((p) => p.trim())
    .filter(Boolean);
  const longEnough = parts.find((p) => p.length >= 45) ?? parts[0] ?? cleaned;
  return clip(longEnough, 220);
};

const tokenize = (text: string): string[] =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9+\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOPWORDS.has(w));

const topKeywords = (text: string, limit = 24): string[] => {
  const counts = new Map<string, number>();
  for (const word of tokenize(text)) {
    counts.set(word, (counts.get(word) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([k]) => k);
};

const linesWithSignal = (raw: string): string[] => {
  const lines = raw
    .split("\n")
    .map((l) => sentenceLikeSnippet(l))
    .filter(Boolean);
  return lines.filter((line) =>
    /\b(built|implemented|designed|developed|led|shipped|integrated|delivered|created|improved)\b/i.test(line),
  );
};

const extractEvidenceSnippets = (raw: string, re: RegExp): string[] => {
  const snippets: string[] = [];
  for (const line of raw.split("\n")) {
    const snippet = sentenceLikeSnippet(line);
    if (snippet && re.test(snippet)) snippets.push(snippet);
    if (snippets.length >= 3) break;
  }
  return snippets;
};

const inferThemes = (type: ResumeType, raw: string): string[] => {
  const lower = raw.toLowerCase();
  const seeds =
    type === "AI"
      ? ["rag systems", "llm evaluation", "agentic workflows", "ai-enabled product engineering"]
      : type === "FDE"
        ? ["third-party integrations", "internal tools and automation", "stakeholder-facing delivery", "practical ai workflows"]
        : ["api-first product engineering", "backend-leaning full-stack", "internal tools", "pragmatic delivery"];
  if (type === "BASE" && /\bllm|ai[-\s]?enabled|rag\b/i.test(lower)) seeds.push("ai-enabled workflows");
  return seeds;
};

const extractProjectEvidence = (raw: string): ResumeProjectEvidence[] => {
  const signals = Array.from(new Set(linesWithSignal(raw))).slice(0, 4);
  return signals.map((line, idx) => ({
    name: `Evidence ${idx + 1}`,
    summary: sentenceLikeSnippet(line),
    technologies: Array.from(line.matchAll(/\b(TypeScript|JavaScript|Node(?:\.js)?|React|MongoDB|Express|API|LLM)\b/gi)).map(
      (m) => m[1],
    ),
    outcomes: [],
    evidenceSnippets: [sentenceLikeSnippet(line)],
  }));
};

const extractClaimSupport = (raw: string): ResumeClaimSupport[] =>
  CLAIM_PATTERNS.map(({ claim, re }) => ({
    claim,
    evidenceSnippets: extractEvidenceSnippets(raw, re),
  })).filter((c) => c.evidenceSnippets.length > 0);

const buildMetadata = (type: ResumeType, raw: string): ResumeContextMetadata => ({
  strongestThemes: inferThemes(type, raw),
  projectEvidence: extractProjectEvidence(raw),
  keywords: topKeywords(raw),
  bestFitRoleShapes: ROLE_SHAPES[type],
  avoidUseCases: AVOID_USE_CASES[type],
  claimSupport: extractClaimSupport(raw),
});

const readResumeRaw = async (type: ResumeType): Promise<{ text: string; sourcePath: string; sourceKind: "txt" | "pdf" } | null> => {
  const source = pickResumeSourcePath(type);
  if (!source) return null;
  if (source.kind === "txt") {
    const text = await fs.readFile(source.path, "utf8");
    return { text, sourcePath: source.path, sourceKind: "txt" };
  }
  const buf = await fs.readFile(source.path);
  const parser = new PDFParse({ data: buf });
  const parsed = await parser.getText();
  await parser.destroy();
  return { text: parsed.text ?? "", sourcePath: source.path, sourceKind: "pdf" };
};

export class ResumeContextService {
  private readonly cache = new Map<ResumeType, CacheEntry>();

  private async loadOne(type: ResumeType): Promise<ResumeContext | null> {
    const cached = this.cache.get(type);
    if (cached?.attempted) return cached.context;
    try {
      const source = await readResumeRaw(type);
      if (!source) {
        logger.warn("Resume context file missing; continuing without resume grounding", { resumeType: type });
        this.cache.set(type, { attempted: true, context: null });
        return null;
      }
      const rawText = normalizeText(source.text);
      const context: ResumeContext = {
        type,
        sourcePath: source.sourcePath,
        sourceKind: source.sourceKind,
        loadedAt: new Date().toISOString(),
        rawText,
        metadata: buildMetadata(type, rawText),
      };
      this.cache.set(type, { attempted: true, context });
      return context;
    } catch (error) {
      logger.warn("Resume context load failed; continuing without resume grounding", {
        resumeType: type,
        error: error instanceof Error ? error.message : String(error),
      });
      this.cache.set(type, { attempted: true, context: null });
      return null;
    }
  }

  async getContext(type: ResumeType): Promise<ResumeContext | null> {
    return this.loadOne(type);
  }

  async getAvailableContexts(): Promise<ResumeContextSet> {
    const out: ResumeContextSet = {};
    for (const type of RESUME_TYPES) {
      const context = await this.loadOne(type);
      if (context) out[type] = context;
    }
    return out;
  }
}

export const resumeContextService = new ResumeContextService();
