import {
  explicitCoreLanguageRiskSummary,
  type CoreLanguageId,
} from "./coreLanguageRequirements.js";
import { riskContradictsSatisfiedDisjunctiveRequirement } from "./disjunctiveLanguageRequirement.js";
import { riskLineReferencesAbsentJdConcepts } from "./riskJdConceptGrounding.js";
import {
  EARLY_CAREER_EXCEED_SEVERITY_LEVEL_FIT_MAX,
  TITLE_RESPONSIBILITY_MISMATCH_LEVEL_FIT_MAX,
  textSignalsEarlyCareerExceedSeverity,
} from "./titleResponsibilitySeniority.js";
import { jdMentionsDegreeLanguage } from "./degreeEquivalency.js";
import { fdeBuilderPrimaryRiskSummary } from "./fdeBuilderRole.js";
import type { ExtractedJobData } from "../types/job.js";
import type { LegacyScoreDimension, RuleEvaluation, ScoreBreakdown } from "../types/scoring.js";
import type { UserProfile } from "../types/userProfile.js";
import { normalizeText } from "./text.js";
import { goMentionedAsPreferred, textMentionsGoLanguage } from "./goLanguage.js";
import {
  sanitizeVisibleNarrativeLine,
  sanitizeVisibleRiskLine,
  type VisibleSanitizeContext,
} from "./riskDisplaySanitizer.js";

export type ScoringNarrative = {
  score: ScoreBreakdown;
  topMatch: string;
  mainRisk: string;
  rationale: string[];
  risks: string[];
};

const sumScoreParts = (s: ScoreBreakdown): number =>
  s.stackFit +
  s.levelFit +
  s.domainFit +
  s.resumeStoryClarity +
  s.functionalOverlap +
  s.recruiterFriendliness +
  s.careerValue;

const jobTextBlob = (job: ExtractedJobData): string =>
  normalizeText(
    [
      job.title,
      job.company,
      job.rawText ?? "",
      ...(job.requirements ?? []),
      ...(job.responsibilities ?? []),
      ...(job.stack ?? []),
    ].join("\n"),
  );

/** Profile reads as nontraditional / early-career for recruiter-realism adjustments. */
export function isNonTraditionalEarlyCareerProfile(profile: UserProfile): boolean {
  if (!profile.degreeStatus.hasBachelors) return true;
  const blob = normalizeText(
    [
      profile.degreeStatus.note,
      profile.headline,
      profile.training.program,
      ...profile.targetRoles,
    ].join(" "),
  );
  return /\b(nontraditional|bootcamp|career\s+change|early[-\s]career|self[-\s]taught|immersive)\b/i.test(
    blob,
  );
}

export function profileHasDirectProductionEvidence(profile: UserProfile): boolean {
  const blob = normalizeText(
    [
      profile.headline,
      ...profile.strengths,
      ...profile.recurringStory,
      ...profile.flagshipProjects.flatMap((p) => [p.name, p.summary, ...p.tech, ...p.outcomes]),
    ].join(" "),
  );
  return /\b(production|production[-\s]grade|shipped|operating|operations|customer[-\s]facing|sla|on[-\s]call|end[-\s]to[-\s]end|owned|operational|live systems?)\b/i.test(
    blob,
  );
}

const JD_STACK_EVIDENCE_GATES: Array<{ jd: RegExp; profile: RegExp }> = [
  { jd: /\bpython\b/i, profile: /\bpython\b/i },
  { jd: /\b(postgresql|postgres)\b/i, profile: /\b(postgresql|postgres|psql)\b/i },
  { jd: /\b(nest\.?js|nest\b)/i, profile: /\b(nest\.?js|nestjs|nest\b)/i },
  { jd: /\bvue(\.js)?\b/i, profile: /\bvue(\.js)?\b/i },
  { jd: /\bcouchbase\b/i, profile: /\bcouchbase\b/i },
  { jd: /\bmongodb\b/i, profile: /\bmongodb\b/i },
];

/**
 * True when the profile shows direct production depth and every JD-mentioned gate stack
 * (Python/Postgres/Nest/Vue/Couchbase/Mongo, etc.) appears in strengths or project tech.
 */
export function profilePassesProductionBarEvidence(jdBlob: string, profile: UserProfile): boolean {
  if (!profileHasDirectProductionEvidence(profile)) return false;
  const prof = normalizeText(
    [
      profile.headline,
      ...profile.strengths,
      ...profile.recurringStory,
      ...profile.flagshipProjects.flatMap((p) => [...p.tech, p.summary]),
    ].join(" "),
  );
  for (const g of JD_STACK_EVIDENCE_GATES) {
    if (g.jd.test(jdBlob) && !g.profile.test(prof)) return false;
  }
  return true;
}

/** Profile shows Go/streaming/warehouse/distributed data infra in a production-relevant way. */
export function profileHasGoDataInfraProductionEvidence(profile: UserProfile): boolean {
  const blob = normalizeText(
    [
      profile.headline,
      ...profile.strengths,
      ...profile.recurringStory,
      ...profile.flagshipProjects.flatMap((p) => [...p.tech, p.summary, ...p.outcomes]),
    ].join(" "),
  );
  if (!blob.trim()) return false;
  const go = textMentionsGoLanguage(blob);
  const stream = /\b(kafka|kinesis|amazon\s*sqs|\bsqs\b|pulsar|event streaming|stream processing)\b/i.test(
    blob,
  );
  const warehouse = /\b(redshift|snowflake|clickhouse|trino|iceberg|bigquery|databricks|data warehouse)\b/i.test(
    blob,
  );
  const specialized = /\b(elasticsearch|opensearch|scylladb|aerospike|tidb)\b/i.test(blob);
  const distributed = /\b(distributed systems?|distributed backend|data infrastructure|analytics infrastructure)\b/i.test(
    blob,
  );
  const prod = /\b(production|operating|shipped|on[-\s]call|sla|at scale)\b/i.test(blob);
  if (go && prod) return true;
  if (stream && prod) return true;
  if (warehouse && prod) return true;
  if (specialized && prod) return true;
  if (distributed && (stream || warehouse || go)) return true;
  return false;
}

/**
 * 2+ yrs professional bar + production-ownership hiring context: cap product/story inflation unless
 * the profile matches JD gate stack(s) and production depth. Tighten recruiter-screen for early-career profiles.
 */
export function applyProductionCompetitiveHiringBarCalibration(params: {
  score: ScoreBreakdown;
  extracted: ExtractedJobData;
  userProfile: UserProfile;
  rules: RuleEvaluation;
}): ScoreBreakdown {
  const { score, extracted, userProfile, rules } = params;
  if (!rules.productionBarCompetitivePool) return score;
  if (rules.goDistributedDataInfraCandidateGap) return score;
  if (rules.credentialHeavyFintechAlgorithm || rules.researchHeavyAiRole) return score;

  const jdBlob = jobTextBlob(extracted);
  const strong = profilePassesProductionBarEvidence(jdBlob, userProfile);
  const early = isNonTraditionalEarlyCareerProfile(userProfile);

  let next = { ...score };

  if (!strong) {
    type Dim = LegacyScoreDimension;
    const pullOrder: Dim[] = [
      "resumeStoryClarity",
      "functionalOverlap",
      "stackFit",
      "recruiterFriendliness",
      "levelFit",
    ];
    const mins: Partial<Record<Dim, number>> = {
      resumeStoryClarity: 10,
      functionalOverlap: 7,
      stackFit: 12,
      recruiterFriendliness: 5,
      levelFit: 8,
      domainFit: 5,
      careerValue: 7,
    };
    let guard = 0;
    while (next.total > 80 && guard < 50) {
      guard += 1;
      let progressed = false;
      for (const d of pullOrder) {
        const minV = mins[d] ?? 0;
        if (next[d] > minV) {
          next = { ...next, [d]: (next[d] as number) - 1 } as ScoreBreakdown;
          next.total = sumScoreParts(next);
          progressed = true;
          break;
        }
      }
      if (!progressed) break;
    }
    next.resumeStoryClarity = Math.min(next.resumeStoryClarity, 14);
    next.functionalOverlap = Math.min(next.functionalOverlap, 9);
    next.total = sumScoreParts(next);
  }

  if (early) {
    next.recruiterFriendliness = Math.min(next.recruiterFriendliness, strong ? 9 : 8);
    next.total = sumScoreParts(next);
  }

  let floorGuard = 0;
  while (next.total < 70 && floorGuard < 30) {
    floorGuard += 1;
    if (next.careerValue < 10) {
      next = { ...next, careerValue: next.careerValue + 1 } as ScoreBreakdown;
      next.total = sumScoreParts(next);
    } else {
      break;
    }
  }

  return next;
}

/** JD emphasizes applied AI / LLM product work (domain alignment with AI systems). */
export const jdHasAppliedAiSystemsOverlap = (blob: string): boolean =>
  /\b(llm|large language model|rag\b|retrieval[-\s]?augmented|agentic|ai agents?|generative ai|vector\s+(search|db|database)|embedding|ai workflow|applied ai|customer[-\s]?facing ai|production ai|evals?\b|evaluation framework)\b/i.test(
    blob,
  );

/** Profile supports RAG / LLM shipping (per user profile + projects). */
export const profileHasAiToolingEvidence = (profile: UserProfile): boolean => {
  const blob = normalizeText(
    [
      profile.headline,
      ...profile.strengths,
      ...profile.recurringStory,
      ...profile.targetRoles,
      ...profile.flagshipProjects.flatMap((p) => [p.name, p.summary, ...p.tech, ...p.outcomes]),
    ].join(" "),
  );
  return /\b(rag|llm|ai[-\s]?enabled|generative|vector|embedding|workflow|internal tooling.*llm)\b/i.test(
    blob,
  );
};

/** JD names concrete RAG/LLM/vector/agent systems AND profile backs that lane (not generic "AI" only). */
export const jdExplicitProfileAiDomainOverlap = (blob: string, profile: UserProfile): boolean => {
  if (!jdHasAppliedAiSystemsOverlap(blob)) return false;
  const jdSpecific = /\b(rag\b|retrieval|llm|vector\s+(search|db|database)|embedding|agentic|evals?\b|ai workflow)\b/i.test(
    blob,
  );
  return jdSpecific && profileHasAiToolingEvidence(profile);
};

/**
 * Applied-AI-shaped JD that is thin on concrete stack, responsibilities, and system surface area.
 * Used to damp "generic AI startup" score inflation.
 */
export const jdIsStructurallyVague = (extracted: ExtractedJobData): boolean => {
  const blob = jobTextBlob(extracted);
  if (!jdHasAppliedAiSystemsOverlap(blob)) return false;
  const stacks = [...(extracted.stack ?? []), ...(extracted.requiredSkills ?? [])].join(" ").toLowerCase();
  const stackTokenHits =
    (stacks.match(
      /\b(python|typescript|javascript|java|go|rust|react|vue|angular|node\.?js|kubernetes|docker|postgres|graphql|grpc|fastapi|django|flask)\b/gi,
    ) ?? []).length;
  const hasConcreteStack =
    (extracted.stack?.length ?? 0) + (extracted.requiredSkills?.length ?? 0) >= 2 || stackTokenHits >= 2;
  const bullets = extracted.responsibilities ?? [];
  const substantive = bullets.filter((b) => b.trim().length > 38).length;
  const hasSpecificResponsibilities = substantive >= 2 || bullets.length >= 4;
  const hasSystemTypes =
    /\b(rest\s*api|graphql|grpc|microservice|kubernetes|k8s|infra|database|postgres|mysql|inference|training|pipeline|rag\b|llm|embedding|vector|retrieval|agents?|evals?|distributed|observability|backend\s+service)\b/i.test(
      blob,
    );
  const thinDetail = blob.length < 720;
  const fewBullets = bullets.length <= 2;
  const fewStack = (extracted.stack?.length ?? 0) + (extracted.requiredSkills?.length ?? 0) <= 1;
  if (thinDetail && fewBullets && fewStack && !hasSystemTypes) return true;
  return thinDetail && (!hasConcreteStack || !hasSpecificResponsibilities || !hasSystemTypes);
};

/** Max travel % mentioned in JD; used for lifestyle risk. */
export const extractMaxTravelPercent = (blob: string): number | undefined => {
  let max = 0;
  const patterns: RegExp[] = [
    /travel\s*[:.]?\s*(\d+)\s*[%％]\s*[-–]\s*(\d+)\s*[%％]/gi,
    /travel\s+(\d+)\s*[-–]\s*(\d+)\s*[%％]/gi,
    /(\d+)\s*[%％]\s*[-–]\s*(\d+)\s*[%％]\s*(?:for\s+)?travel/gi,
    /(\d+)\s*[%％]\s*[-–]\s*(\d+)\s*[%％]\s*annually/gi,
    /travel\s*[:.]?\s*(\d+)\s*[%％]\s*(?:-\s*(\d+)\s*[%％])?/gi,
    /(\d+)\s*[%％]\s*travel/gi,
    /up to\s*(\d+)\s*[%％]\s*travel/gi,
    /travel\s*(?:requirement|expected)[^.]{0,40}?(\d+)\s*[%％]/gi,
  ];
  for (const re of patterns) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(blob)) !== null) {
      const a = Number.parseInt(m[1] ?? "0", 10);
      const b = m[2] ? Number.parseInt(m[2], 10) : a;
      if (Number.isFinite(a)) max = Math.max(max, a, b);
    }
  }
  return max > 0 ? max : undefined;
};

/** Human label when JD states a travel range (e.g. "travel 10–20%"). */
export const extractTravelRangeLabel = (blob: string): string | undefined => {
  const r1 = blob.match(/travel\s*[:.]?\s*(\d+)\s*[%％]\s*[-–]\s*(\d+)\s*[%％]/i);
  if (r1) return `${r1[1]}–${r1[2]}%`;
  const r1b = blob.match(/travel\s+(\d+)\s*[-–]\s*(\d+)\s*[%％]/i);
  if (r1b) return `${r1b[1]}–${r1b[2]}%`;
  const r2 = blob.match(/(\d+)\s*[%％]\s*[-–]\s*(\d+)\s*[%％]\s*(?:for\s+)?travel/i);
  if (r2) return `${r2[1]}–${r2[2]}%`;
  return undefined;
};

/**
 * Always surface travel % from the JD as a practical risk when detectable.
 * 25%+ uses stronger wording (high-signal lifestyle blocker).
 */
export const travelRiskLine = (blob: string): string | undefined => {
  const pct = extractMaxTravelPercent(blob);
  if (pct === undefined) return undefined;
  const rangeLabel = extractTravelRangeLabel(blob);
  const label = rangeLabel ?? `~${pct}%`;
  if (pct >= 25) {
    return `Significant travel (${label}) may be a constraint versus low-travel or office-heavy preferences.`;
  }
  return `Travel requirement (${label}) may be a constraint if you need minimal travel or fixed hybrid cadence.`;
};

const tokenSet = (s: string): Set<string> =>
  new Set(
    normalizeText(s)
      .split(" ")
      .filter((t) => t.length > 2),
  );

const similarSentence = (a: string, b: string): boolean => {
  const A = tokenSet(a);
  const B = tokenSet(b);
  if (!A.size || !B.size) return false;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter += 1;
  return inter / Math.max(A.size, B.size) >= 0.72;
};

const jdRequiresDeepDomainSpecialization = (jd: string): boolean =>
  /\b(deep\s+domain|subject\s+matter\s+expert|industry\s+expert|10\+\s*years\s+in|ph\.?d\.?\s+in|licensed\s+\w+\s+professional)\b/i.test(
    jd,
  );

/** Drop vague "enterprise/domain expertise" caveats unless JD demands deep specialization. */
export const isLowSignalEnterpriseDomainRisk = (risk: string, jdBlob: string): boolean => {
  if (jdRequiresDeepDomainSpecialization(jdBlob)) return false;
  if (/forward[-\s]?deployed\s+or\s+growth[-\s]?engineering/i.test(risk)) return false;
  const t = risk.toLowerCase();
  if (!/\b(enterprise|domain|industry|vertical)\b/.test(t)) return false;
  if (!/\b(lack|limited|missing|gap|no |without|insufficient|weak|light)\b/.test(t)) return false;
  return true;
};

/** Ungrounded "no bachelor's / degree could hurt" lines when the JD never mentions a degree. */
export const isUngroundedDegreeRisk = (
  risk: string,
  extracted: ExtractedJobData,
  rules?: RuleEvaluation,
): boolean => {
  if (rules?.explicitDegreeRisk) return false;
  if (jdMentionsDegreeLanguage(extracted)) return false;
  const t = risk.toLowerCase();
  if (!/\b(degree|bachelor|bs\b|b\.s\.|credential)\b/.test(t)) return false;
  return (
    /\b(no |lack|lacking|without|missing|absent|not(ed)?\s+on|could\s+(hurt|disadvantage)|disadvantage|ats\s+filter|conservative\s+(financial|screens?))\b/.test(
      t,
    ) || /\bno bachelor'?s?\s+degree\s+noted\b/.test(t)
  );
};

const riskPriority = (risk: string, jdBlob: string, rules?: RuleEvaluation): number => {
  const t = normalizeText(risk);
  if (/explicit\s+\w+\s+backend requirement vs type/i.test(t)) return 98;
  if (/title\s*\/\s*responsibility\s+mismatch/i.test(t)) return 99;
  if (textSignalsEarlyCareerExceedSeverity(risk)) return 98;
  if (/high ownership,\s*low support/i.test(t)) return 95;
  /** Third-priority stretch risk: after Python/stack and travel/hybrid. */
  if (
    /customer[-\s]?facing production ai|production ai ownership/.test(t) &&
    /potential mismatch|depth of ownership|above.*experience/.test(t)
  ) {
    return 84;
  }
  let p = 50;
  // Decision-blocker order: language/stack → level/ownership → travel (25%+) → travel (lower) → onsite/hybrid
  if (/\bpython\b/.test(t) && /\b(type ?script|javascript|node|primary|first)\b/.test(t)) {
    p = rules?.pythonStackFlexibleWithJsTs ? 62 : 100;
  }
  else if (/forward[-\s]?deployed\s+or\s+growth[-\s]?engineering/i.test(t)) p = 97;
  else if (/\b(stack|language|framework|go\b|ruby|java(?!script))\b/.test(t)) p = 96;
  if (/\b(senior|staff|principal|ownership|years of|leadership scope|enterprise production ai)\b/.test(t))
    p = Math.max(p, 94);
  if (/\btravel\b/.test(t)) {
    const maxT = extractMaxTravelPercent(jdBlob);
    p = Math.max(p, maxT !== undefined && maxT >= 25 ? 90 : 86);
  }
  if (/\b(onsite|in[-\s]?office|days?\s+per\s+week|relocation|commute|hybrid)\b/.test(t)) p = Math.max(p, 83);
  if (/\b(degree|bachelor|clearance|citizenship|sponsorship)\b/.test(t)) p = Math.max(p, 78);
  if (isLowSignalEnterpriseDomainRisk(risk, jdBlob)) p = Math.min(p, 15);
  if (/\b(required|must|hard)\b/.test(t)) p += 5;
  return p;
};

/** Practical = lifestyle/logistics; technical = stack, level, ownership, gates. */
export const riskBucket = (risk: string): "technical" | "practical" =>
  /\b(travel|onsite|hybrid|in[-\s]?office|commute|relocation|timezone|days?\s+per\s+week|office\s+days|lifestyle)\b/i.test(
    risk,
  )
    ? "practical"
    : "technical";

/** Prefer top priority first, then one from the other bucket when possible (hiring-manager scan). */
export function pickBalancedRiskOrder(sorted: string[], max: number): string[] {
  if (sorted.length === 0) return [];
  if (max <= 1) return [sorted[0]];
  const main = sorted[0];
  const wantOther = riskBucket(main) === "technical" ? "practical" : "technical";
  const second =
    sorted.slice(1).find((r) => riskBucket(r) === wantOther && !similarSentence(r, main)) ??
    sorted.slice(1).find((r) => !similarSentence(r, main));
  const out: string[] = [main];
  if (second) out.push(second);
  for (const r of sorted) {
    if (out.length >= max) break;
    if (out.some((x) => similarSentence(x, r))) continue;
    out.push(r);
  }
  return out.slice(0, max);
}

const uniqueRisks = (items: string[]): string[] => {
  const out: string[] = [];
  for (const raw of items) {
    const s = raw.trim();
    if (!s) continue;
    if (out.some((x) => similarSentence(x, s))) continue;
    out.push(s);
  }
  return out;
};

const PRODUCTION_AI_OWNERSHIP_RISK =
  "Customer-facing production AI ownership is a potential mismatch with the depth of ownership shown in this profile.";

export function polishRisksAndMain(params: {
  mainRisk: string;
  risks: string[];
  extracted: ExtractedJobData;
  travelLine?: string;
  max?: number;
  rules?: RuleEvaluation;
  userProfile?: UserProfile;
  resumeRawText?: string;
}): { mainRisk: string; risks: string[] } {
  const jdBlob = jobTextBlob(params.extracted);
  const max = params.max ?? 3;
  const rawList = [params.mainRisk, ...(params.risks ?? [])].filter((x): x is string => Boolean(x?.trim()));
  if (params.rules?.explicitCoreLanguageMismatch && params.rules.explicitCoreLanguage) {
    const line = explicitCoreLanguageRiskSummary(params.rules.explicitCoreLanguage as CoreLanguageId);
    if (!rawList.some((r) => /explicit.*mature employer/i.test(r))) {
      rawList.unshift(line);
    }
  }
  if (params.rules?.fdeBuilderSoftwarePrimary) {
    if (!rawList.some((r) => similarSentence(r, fdeBuilderPrimaryRiskSummary))) {
      rawList.unshift(fdeBuilderPrimaryRiskSummary);
    }
  }
  const mismatchNotes = (params.rules?.notes ?? []).filter((n) =>
    /title\s*\/\s*responsibility\s+mismatch/i.test(n),
  );
  for (const n of [...mismatchNotes].reverse()) {
    if (!rawList.some((r) => similarSentence(r, n))) rawList.unshift(n);
  }
  const highOwnNotes = (params.rules?.notes ?? []).filter((n) =>
    /high ownership,\s*low support/i.test(n),
  );
  for (const n of highOwnNotes) {
    if (!rawList.some((r) => similarSentence(r, n))) rawList.push(n);
  }
  const reinforcedNotes = (params.rules?.notes ?? []).filter((n) =>
    /experience bar is restated across/i.test(n),
  );
  for (const n of reinforcedNotes) {
    if (!rawList.some((r) => similarSentence(r, n))) rawList.push(n);
  }
  const infraOwnNotes = (params.rules?.notes ?? []).filter((n) =>
    /limited hands-on production-scale/i.test(n),
  );
  for (const n of infraOwnNotes) {
    if (!rawList.some((r) => similarSentence(r, n))) rawList.push(n);
  }
  const suggestOwnershipRisk =
    max >= 3 &&
    /\b(customer[-\s]?facing|production ai)\b/i.test(jdBlob) &&
    /\b(llm|rag|applied ai|ai systems?)\b/i.test(jdBlob) &&
    !rawList.some((r) => similarSentence(r, PRODUCTION_AI_OWNERSHIP_RISK) || /ownership.*production ai/i.test(r));
  if (suggestOwnershipRisk) rawList.push(PRODUCTION_AI_OWNERSHIP_RISK);

  const merged = uniqueRisks(
    [...rawList, params.travelLine].filter((x): x is string => Boolean(x?.trim())),
  );
  const filtered = merged.filter(
    (r) =>
      !isLowSignalEnterpriseDomainRisk(r, jdBlob) &&
      !isUngroundedDegreeRisk(r, params.extracted, params.rules) &&
      !(params.rules && riskContradictsSatisfiedDisjunctiveRequirement(r, params.rules)) &&
      !riskLineReferencesAbsentJdConcepts(r, params.extracted),
  );
  const sorted = [...filtered].sort(
    (a, b) => riskPriority(b, jdBlob, params.rules) - riskPriority(a, jdBlob, params.rules),
  );
  const top = pickBalancedRiskOrder(sorted, max);
  const fallbackMain =
    params.mainRisk.trim() || "Standard recruiter-screen gaps may still apply for unverified claims.";
  const ctx: VisibleSanitizeContext = {
    extracted: params.extracted,
    userProfile: params.userProfile,
    rules: params.rules,
    resumeRawText: params.resumeRawText,
  };
  const mainSan = sanitizeVisibleRiskLine(top[0] ?? fallbackMain, ctx);
  const restSan = (top.length > 1 ? top.slice(1) : []).map((r) => sanitizeVisibleRiskLine(r, ctx));
  return {
    mainRisk: mainSan,
    risks: restSan,
  };
}

const PROOF_HINT =
  /\b(shipped|built|implemented|delivered|owned|bootcamp|project|production|internship|experience|profile|flagship|led|scaled)\b/i;
/** Second bullet must tie to engineering artifacts, not generic praise (embeddings, pipelines, shipped AI delivery). */
export const CONCRETE_ENGINEERING_PROOF =
  /\b(embedding|embeddings|vector\s*(search|database|db)?|ingestion|pipeline|pipelines|rag\b|retrieval|semantic|chunk|evals?|evaluations?|agents?|openapi|kubernetes|lambda|typescript|node\.?js|rest\s*api)\b/i;
const VAGUE_FIT_RE =
  /\b(solid\s+match|strategic\s+capability|strategic\s+readiness|generic\s+fit|generic\s+overlap)\b/gi;

const hasVagueFitPhrase = (s: string): boolean =>
  /\b(solid\s+match|strategic\s+capability|strategic\s+readiness|generic\s+fit|generic\s+overlap)\b/i.test(s);

/** Remove reusable vague praise from Why consider lines. */
export function stripVagueWhyConsiderPhrases(text: string): string {
  let t = text.replace(VAGUE_FIT_RE, "").replace(/\s{2,}/g, " ").replace(/\s*,\s*,/g, ",").trim();
  t = t.replace(/^[,;]\s*/, "").replace(/\s*[,;]\s*$/g, "").trim();
  return t;
}

/** Capability / fit angle for bullet 1 — not concrete proof. */
const CAPABILITY_HINT =
  /\b(overlap|align|match|fit|role|scope|stack|workflow|systems|shape)\b/i;

const appliedAiTriple =
  /\b(llm|rag|vector\s+(search|embedding)|rest\s*api|api\s+integration|applied[-\s]?ai)\b/gi;

/** Reduce repeated LLM/RAG/API clusters across the two "why consider" lines. */
export function dampDuplicateAppliedAiPhrasing(first: string, second: string): string {
  let b = second.trim();
  const hitsFirst = (first.match(appliedAiTriple) ?? []).length;
  const hitsSecond = (b.match(appliedAiTriple) ?? []).length;
  if (hitsFirst < 2 || hitsSecond < 2) return b;
  b = b.replace(/^\s*(strong\s+|clear\s+)?(applied[-\s]?ai\s+)?(product\s+)?/i, "");
  b = b.replace(/\b(via|from|including)\s+[^,.]+(?:llm|rag|api)[^.]*\.?/i, (m) =>
    /\b(shipped|built|owned|delivered)\b/i.test(m) ? m : "",
  );
  b = b.replace(/\s*\.?\s*$/, "");
  if (b.length < 28) return second.trim();
  return b.replace(/^,\s*/, "").trim();
}

/** Trim trailing commas, fix clipped applied-AI summary lines, avoid sentence fragments. */
export function sanitizeNarrativeSentence(text: string, minLen = 55): string {
  let t = stripVagueWhyConsiderPhrases(text.trim()).replace(/,\s*$/, "").replace(/\s+$/, "");
  t = t.replace(/\s*\b(and|or)\s*$/i, "").trim();
  if (t.length < minLen && /(llm|rag|applied[-\s]?ai|ai workflow)/i.test(t)) {
    if (!/\b(integration|end[-\s]to[-\s]end|workflow experience)\b/i.test(t)) {
      t = `${t.replace(/[.,;]$/, "")}, with API integration and end-to-end AI workflow experience`;
    }
  }
  return t.replace(/,\s*$/, "").trim();
}

function pickConcreteProofLine(
  candidates: string[],
  avoid: string | undefined,
): string | undefined {
  const avoidNorm = avoid ? normalizeText(avoid) : "";
  const scored = candidates.filter((r) => r && !similarSentence(r, avoid ?? ""));
  const concrete = scored.find((r) => CONCRETE_ENGINEERING_PROOF.test(r) && PROOF_HINT.test(r));
  if (concrete) return concrete;
  return scored.find((r) => CONCRETE_ENGINEERING_PROOF.test(r)) ?? scored.find((r) => PROOF_HINT.test(r));
}

export function polishRationaleBullets(
  rationale: string[],
  max = 2,
  ctx?: VisibleSanitizeContext,
): string[] {
  const items = rationale.map((s) => sanitizeNarrativeSentence(s.trim())).filter(Boolean);
  const deduped: string[] = [];
  for (const item of items) {
    if (deduped.some((d) => similarSentence(d, item))) continue;
    deduped.push(item);
  }
  const proofLines = deduped.filter((r) => PROOF_HINT.test(r));
  const nonProof = deduped.filter((r) => !PROOF_HINT.test(r));
  let capability =
    nonProof.find((r) => CAPABILITY_HINT.test(r) && !hasVagueFitPhrase(r)) ??
    nonProof.find((r) => !hasVagueFitPhrase(r)) ??
    nonProof[0] ??
    deduped.find((r) => CAPABILITY_HINT.test(r)) ??
    deduped[0];
  if (capability) capability = stripVagueWhyConsiderPhrases(capability);

  let proof = pickConcreteProofLine(deduped, capability);
  if (proof === capability) proof = pickConcreteProofLine([...proofLines, ...deduped], capability);
  if (!proof || proof === capability) proof = deduped.find((r) => r !== capability);

  const out: string[] = [];
  if (capability) out.push(capability);
  if (proof && proof !== capability) out.push(dampDuplicateAppliedAiPhrasing(capability ?? "", proof));
  for (const r of deduped) {
    if (out.length >= max) break;
    const adj = out.length === 1 && out[0] ? dampDuplicateAppliedAiPhrasing(out[0], r) : r;
    if (out.some((x) => x === r || similarSentence(x, adj))) continue;
    out.push(adj);
  }
  const sliced = out.slice(0, max).map((s) => sanitizeNarrativeSentence(s));
  if (sliced.length === 2) {
    sliced[1] = sanitizeNarrativeSentence(dampDuplicateAppliedAiPhrasing(sliced[0], sliced[1]));
    if (!CONCRETE_ENGINEERING_PROOF.test(sliced[1]) && !/\b(shipped|built|implemented|delivered|owned|production)\b/i.test(sliced[1])) {
      const alt = pickConcreteProofLine(deduped, sliced[0]);
      if (alt && !similarSentence(sliced[0], alt)) {
        sliced[1] = sanitizeNarrativeSentence(dampDuplicateAppliedAiPhrasing(sliced[0], alt));
      }
    }
  }
  if (ctx) {
    return sliced.map((s) => sanitizeVisibleNarrativeLine(s, ctx));
  }
  return sliced;
}

/** Raise domain fit when JD + profile show direct applied-AI overlap (unless hard domain mismatch). */
export function applyAppliedAiDomainFloor(params: {
  score: ScoreBreakdown;
  extracted: ExtractedJobData;
  userProfile: UserProfile;
  rules: RuleEvaluation;
}): ScoreBreakdown {
  const { score, extracted, userProfile, rules } = params;
  if (rules.researchHeavyAiRole) return score;
  if (rules.domainMismatch) return score;
  if (rules.goDistributedDataInfraCandidateGap) return score;
  const blob = jobTextBlob(extracted);
  if (
    rules.productionBarCompetitivePool &&
    !profilePassesProductionBarEvidence(blob, userProfile)
  ) {
    return score;
  }
  if (!jdHasAppliedAiSystemsOverlap(blob) || !profileHasAiToolingEvidence(userProfile)) return score;
  if (rules.vagueEarlyStageAiCalibration) {
    const explicit = jdExplicitProfileAiDomainOverlap(blob, userProfile);
    let domainFit = Math.min(score.domainFit, explicit ? 8 : 7);
    domainFit = Math.max(0, domainFit);
    if (domainFit === score.domainFit) return score;
    const next = { ...score, domainFit };
    return { ...next, total: sumScoreParts(next) };
  }
  let domainFit = score.domainFit;
  if (domainFit < 7) domainFit = 7;
  else if (domainFit === 7 && /\b(agent|agents|evaluation|evals)\b/i.test(blob)) domainFit = 8;
  domainFit = Math.min(10, domainFit);
  if (domainFit === score.domainFit) return score;
  const next = { ...score, domainFit };
  return { ...next, total: sumScoreParts(next) };
}

/**
 * Calibrate stack (≈16–17) and functional (≈8–9) for applied-AI roles when JD + profile align.
 * Python-primary is one stack caveat only — do not compound into functional collapse when RAG/API/TS overlap exists.
 */
export function applyAppliedAiStackFunctionalCalibration(params: {
  score: ScoreBreakdown;
  extracted: ExtractedJobData;
  userProfile: UserProfile;
  rules: RuleEvaluation;
}): ScoreBreakdown {
  const { score, extracted, userProfile, rules } = params;
  if (rules.researchHeavyAiRole) return score;
  if (rules.goDistributedDataInfraCandidateGap) return score;
  if (rules.domainMismatch || rules.stackMismatch) return score;
  /** Do not inflate stack for applied-AI overlap when mature employer + explicit core-language gate applies. */
  if (rules.explicitCoreLanguageMismatch) return score;
  /** Builder-first FDE / growth roles: post-process caps scores; skip stack inflation here. */
  if (rules.fdeBuilderSoftwarePrimary) return score;
  /** Generic thin AI startup JDs: do not inflate stack/functional from broad AI overlap alone. */
  if (rules.vagueEarlyStageAiCalibration) return score;
  const blob = jobTextBlob(extracted);
  if (
    rules.productionBarCompetitivePool &&
    !profilePassesProductionBarEvidence(blob, userProfile)
  ) {
    return score;
  }
  if (!jdHasAppliedAiSystemsOverlap(blob) || !profileHasAiToolingEvidence(userProfile)) return score;

  const compensatingOverlap =
    /\b(rag|llm|vector|embedding|rest\s*api|api\b|typescript|javascript|node\.?js|react|integration|applied ai|generative ai|ai workflow)\b/i.test(
      blob,
    );
  if (!compensatingOverlap) return score;

  const pythonOverwhelming =
    !rules.pythonStackFlexibleWithJsTs &&
    /\bpython\b/i.test(blob) &&
    !/\btypescript|javascript|node\.?js\b/i.test(blob) &&
    /\b(primary\s+language|python[-\s]first|expert\s+in\s+python|strong\s+python)\b/i.test(blob);

  let stackFit = score.stackFit;
  let functionalOverlap = score.functionalOverlap;

  if (stackFit < 16) {
    stackFit = pythonOverwhelming ? 16 : 17;
  } else if (stackFit === 16 && !pythonOverwhelming) {
    stackFit = 17;
  }

  const jdRichFunctional =
    (/\b(workflow|retrieval|rag\b|agents?|evals?|integration|customer[-\s]facing|production|iterate|system)\b/i.test(
      blob,
    ) &&
      /\b(llm|ai system|applied ai|generative)\b/i.test(blob)) ||
    /\b(end[-\s]?to[-\s]?end).{0,40}\b(ai|llm|workflow)\b/i.test(blob);

  if (jdRichFunctional && functionalOverlap < 8) {
    functionalOverlap = 8;
  }
  if (jdRichFunctional && functionalOverlap === 8 && !pythonOverwhelming) {
    functionalOverlap = 9;
  }

  stackFit = Math.min(25, stackFit);
  functionalOverlap = Math.min(10, functionalOverlap);

  if (stackFit === score.stackFit && functionalOverlap === score.functionalOverlap) return score;
  const next = { ...score, stackFit, functionalOverlap };
  return { ...next, total: sumScoreParts(next) };
}

/** Python listed flexibly with JS/TS: recover ~2 stack points vs TypeScript-primary profile (minor caveat only). */
export function applyPythonFlexibleStackSupport(params: {
  score: ScoreBreakdown;
  rules: RuleEvaluation;
}): ScoreBreakdown {
  if (!params.rules.pythonStackFlexibleWithJsTs || params.rules.stackMismatch) return params.score;
  const stackFit = Math.min(22, params.score.stackFit + 2);
  if (stackFit === params.score.stackFit) return params.score;
  const next = { ...params.score, stackFit };
  return { ...next, total: sumScoreParts(next) };
}

/**
 * 2–4y + ownership / roadmap influence without explicit senior JD: keep level in realistic mid-band (not <10).
 */
export function applyMidLevelOwnershipLevelCalibration(params: {
  score: ScoreBreakdown;
  extracted: ExtractedJobData;
  rules: RuleEvaluation;
}): ScoreBreakdown {
  if (params.rules.goDistributedDataInfraCandidateGap) return params.score;
  if (params.rules.seniorityOverreach) return params.score;
  const blob = jobTextBlob(params.extracted);
  const midOwnership =
    /\b(2\+|3\+|at\s+least\s+2|2\s*[-–]\s*5|2\s+to\s+4|3\s+to\s+5)\s*years?\b/i.test(blob) &&
    /\b(ownership|own\s+the|technical\s+ownership|influence\s+(the\s+)?(roadmap|priorities)|contribute\s+to\s+decisions?|shape\s+features|end[-\s]?to[-\s]?end)\b/i.test(
      blob,
    );
  if (!midOwnership) return params.score;
  const levelFit = Math.min(12, Math.max(11, params.score.levelFit));
  if (levelFit === params.score.levelFit) return params.score;
  const next = { ...params.score, levelFit };
  return { ...next, total: sumScoreParts(next) };
}

/**
 * Associate/entry backend-platform roles with broad "familiarity with" basics should stay accessible.
 * Preferred stack deltas (Go/GraphQL/cloud platform) are caveats, not score-killers.
 */
export function applyAssociateEntryBackendPlatformCalibration(params: {
  score: ScoreBreakdown;
  extracted: ExtractedJobData;
  rules: RuleEvaluation;
}): ScoreBreakdown {
  const { score, extracted, rules } = params;
  const blob = jobTextBlob(extracted);
  const associateEntry =
    /\b(associate|entry[-\s]?level|early[-\s]?career|new grad|new graduate|junior)\b/i.test(blob);
  const backendPlatform =
    /\b(backend|platform|core software|service|infrastructure|content platform|publishing systems?|api)\b/i.test(
      blob,
    );
  if (!associateEntry || !backendPlatform) return score;
  if (rules.seniorityOverreach || rules.explicitCoreLanguageMismatch || rules.stackMismatch) return score;

  const familiarityHeavy =
    (blob.match(/\bfamiliarity\s+with\b/gi)?.length ?? 0) >= 2 ||
    /\bfamiliarity\s+(building|with)\s+(backend|relational databases?|development process|unit testing|integration testing)\b/i.test(
      blob,
    );
  const preferredOnlyAdvanced =
    /\bpreferred[^.\n]{0,160}\b(graphql|docker|kubernetes|cloud)\b/i.test(blob) ||
    /\b(graphql|docker|kubernetes|cloud)\b[^.\n]{0,160}\b(preferred|nice to have|plus)\b/i.test(blob) ||
    goMentionedAsPreferred(blob);
  if (!familiarityHeavy && !preferredOnlyAdvanced) return score;

  let next = { ...score };
  next.levelFit = Math.max(13, next.levelFit);
  next.stackFit = Math.max(16, next.stackFit);
  next.functionalOverlap = Math.max(8, next.functionalOverlap);
  next.domainFit = Math.max(8, next.domainFit);
  next.resumeStoryClarity = Math.max(14, next.resumeStoryClarity);
  next.careerValue = Math.max(9, next.careerValue);
  if (next.recruiterFriendliness < 10) next.recruiterFriendliness = 10;
  next.total = sumScoreParts(next);

  const targetLo = 79;
  const targetHi = 82;
  const ups: Array<LegacyScoreDimension> = [
    "careerValue",
    "recruiterFriendliness",
    "functionalOverlap",
    "stackFit",
    "levelFit",
    "domainFit",
    "resumeStoryClarity",
  ];
  const upsMax: Partial<Record<LegacyScoreDimension, number>> = {
    careerValue: 10,
    recruiterFriendliness: 11,
    functionalOverlap: 9,
    stackFit: 17,
    levelFit: 14,
    domainFit: 8,
    resumeStoryClarity: 15,
  };
  let upGuard = 0;
  while (next.total < targetLo && upGuard < 30) {
    upGuard += 1;
    let changed = false;
    for (const d of ups) {
      if (next[d] < (upsMax[d] ?? 99)) {
        next = { ...next, [d]: (next[d] as number) + 1 } as ScoreBreakdown;
        next.total = sumScoreParts(next);
        changed = true;
        break;
      }
    }
    if (!changed) break;
  }

  if (next.total > 82) {
    const dims: Array<LegacyScoreDimension> = [
      "stackFit",
      "recruiterFriendliness",
      "functionalOverlap",
      "domainFit",
      "levelFit",
      "careerValue",
      "resumeStoryClarity",
    ];
    const mins: Partial<Record<LegacyScoreDimension, number>> = {
      stackFit: 16,
      recruiterFriendliness: 10,
      functionalOverlap: 8,
      domainFit: 8,
      levelFit: 13,
      careerValue: 9,
      resumeStoryClarity: 14,
    };
    let guard = 0;
    while (next.total > 82 && guard < 40) {
      guard += 1;
      let changed = false;
      for (const d of dims) {
        if (next[d] > (mins[d] ?? 0)) {
          next = { ...next, [d]: (next[d] as number) - 1 } as ScoreBreakdown;
          next.total = sumScoreParts(next);
          changed = true;
          break;
        }
      }
      if (!changed) break;
    }
  }
  if (next.total > targetHi) {
    let guard = 0;
    const dims: Array<LegacyScoreDimension> = [
      "stackFit",
      "recruiterFriendliness",
      "functionalOverlap",
      "domainFit",
      "levelFit",
      "careerValue",
      "resumeStoryClarity",
    ];
    const mins: Partial<Record<LegacyScoreDimension, number>> = {
      stackFit: 16,
      recruiterFriendliness: 10,
      functionalOverlap: 8,
      domainFit: 8,
      levelFit: 13,
      careerValue: 9,
      resumeStoryClarity: 14,
    };
    while (next.total > targetHi && guard < 30) {
      guard += 1;
      let changed = false;
      for (const d of dims) {
        if (next[d] > (mins[d] ?? 0)) {
          next = { ...next, [d]: (next[d] as number) - 1 } as ScoreBreakdown;
          next.total = sumScoreParts(next);
          changed = true;
          break;
        }
      }
      if (!changed) break;
    }
  }
  return next;
}

/** NYT publishing/content engineering is high-signal career value for this profile when no hard blockers. */
export function applyNytCareerValueCalibration(params: {
  score: ScoreBreakdown;
  extracted: ExtractedJobData;
  rules: RuleEvaluation;
}): ScoreBreakdown {
  const { score, extracted, rules } = params;
  if (rules.domainMismatch || rules.locationMismatch) return score;
  const blob = jobTextBlob(extracted);
  const nyt = /\b(new york times|nyt)\b/i.test(blob);
  const contentPlatform =
    /\b(publishing|content platform|newsroom|editorial systems?|media platform|content systems?)\b/i.test(blob);
  if (!nyt || !contentPlatform) return score;
  let next = { ...score };
  next.careerValue = Math.max(next.careerValue, 9);
  if (next.domainFit < 8) next.domainFit = 8;
  next.total = sumScoreParts(next);
  return next;
}

/** Healthcare org + product/full-stack JD: avoid domain scores in the gutter for generic “no clinical SME” noise. */
export function applyHealthcareProductDomainCalibration(params: {
  score: ScoreBreakdown;
  rules: RuleEvaluation;
}): ScoreBreakdown {
  if (!params.rules.healthcareProductEngineering || params.rules.domainMismatch) return params.score;
  let domainFit = params.score.domainFit;
  if (domainFit < 6) domainFit = 6;
  else if (domainFit > 7) domainFit = Math.min(domainFit, 8);
  if (domainFit === params.score.domainFit) return params.score;
  const next = { ...params.score, domainFit };
  return { ...next, total: sumScoreParts(next) };
}

/**
 * Mature backend/API product roles that mention infra tooling should not collapse stack to single digits.
 * Keep stack in a realistic 14+ band when API/backend overlap is strong and infra is not the core job.
 */
export function applyBackendApiInfraCalibration(params: {
  score: ScoreBreakdown;
  extracted: ExtractedJobData;
  rules: RuleEvaluation;
}): ScoreBreakdown {
  const { score, extracted, rules } = params;
  if (rules.goDistributedDataInfraCandidateGap) return score;
  if (!rules.backendProductApiRole || rules.infraCoreRole) return score;
  const blob = jobTextBlob(extracted);
  const backendApiSignals =
    /\b(backend|api|rest\s*api|full[-\s]?stack|product features?|debugging|testing|ownership|reliable systems?)\b/i.test(
      blob,
    );
  const infraSupportingSignals =
    /\b(kubernetes|docker|aws|postgres|sql|cloud)\b/i.test(blob);
  if (!backendApiSignals) return score;

  let next = { ...score };
  if (infraSupportingSignals && next.stackFit < 14) next.stackFit = 14;
  if (infraSupportingSignals && next.stackFit < 15 && !rules.stackMismatch) next.stackFit = 15;
  if (next.functionalOverlap < 8) next.functionalOverlap = 8;
  if (next.levelFit < 12 && !rules.seniorityOverreach) next.levelFit = 12;
  if (next.domainFit < 6) next.domainFit = 6;
  if (next.recruiterFriendliness > 9) next.recruiterFriendliness = 9;

  const changed =
    next.stackFit !== score.stackFit ||
    next.functionalOverlap !== score.functionalOverlap ||
    next.levelFit !== score.levelFit ||
    next.domainFit !== score.domainFit ||
    next.recruiterFriendliness !== score.recruiterFriendliness;
  if (!changed) return score;
  return { ...next, total: sumScoreParts(next) };
}

/**
 * Mature employer + explicit core-language mismatch: pull stack/recruiter-screen realism down
 * so strong domain/story cannot fully offset a hard language gate (target low–mid 70s total).
 */
export function applyMatureExplicitLanguageCalibration(params: {
  score: ScoreBreakdown;
  rules: RuleEvaluation;
}): ScoreBreakdown {
  if (!params.rules.explicitCoreLanguageMismatch) return params.score;
  let next = { ...params.score };
  next.stackFit = Math.min(next.stackFit, 14);
  next.levelFit = Math.min(next.levelFit, 9);
  next.recruiterFriendliness = Math.min(next.recruiterFriendliness, 8);
  next.functionalOverlap = Math.min(next.functionalOverlap, 9);
  next.careerValue = Math.min(next.careerValue, 10);
  let total = sumScoreParts(next);
  while (total > 74 && next.stackFit > 12) {
    next = { ...next, stackFit: next.stackFit - 1 };
    total = sumScoreParts(next);
  }
  while (total > 74 && next.recruiterFriendliness > 6) {
    next = { ...next, recruiterFriendliness: next.recruiterFriendliness - 1 };
    total = sumScoreParts(next);
  }
  while (total > 74 && next.levelFit > 7) {
    next = { ...next, levelFit: next.levelFit - 1 };
    total = sumScoreParts(next);
  }
  while (total > 74 && next.functionalOverlap > 7) {
    next = { ...next, functionalOverlap: next.functionalOverlap - 1 };
    total = sumScoreParts(next);
  }
  return { ...next, total };
}

/**
 * Forward-deployed / growth title without external customer-implementation core:
 * keep strong fit in the mid-80s (not 90+) — builder lane vs solutions consulting.
 */
export function applyFdeBuilderScoreCalibration(params: {
  score: ScoreBreakdown;
  rules: RuleEvaluation;
}): ScoreBreakdown {
  if (!params.rules.fdeBuilderSoftwarePrimary) return params.score;
  let next = { ...params.score };
  next.stackFit = Math.min(20, next.stackFit);
  next.levelFit = Math.min(12, next.levelFit);
  next.domainFit = Math.min(8, next.domainFit);
  next.resumeStoryClarity = Math.min(15, next.resumeStoryClarity);
  next.functionalOverlap = Math.min(9, next.functionalOverlap);
  next.recruiterFriendliness = Math.min(12, next.recruiterFriendliness);
  next.careerValue = Math.min(10, next.careerValue);

  type Dim = LegacyScoreDimension;
  const order: Dim[] = [
    "stackFit",
    "recruiterFriendliness",
    "levelFit",
    "functionalOverlap",
    "domainFit",
    "careerValue",
    "resumeStoryClarity",
  ];
  const mins: Partial<Record<Dim, number>> = {
    stackFit: 17,
    recruiterFriendliness: 8,
    levelFit: 10,
    functionalOverlap: 7,
    domainFit: 6,
    careerValue: 7,
    resumeStoryClarity: 14,
  };

  let total = sumScoreParts(next);
  let guard = 0;
  while (total > 86 && guard < 80) {
    guard += 1;
    let progressed = false;
    for (const key of order) {
      const minV = mins[key] ?? 0;
      if (next[key] > minV) {
        next = { ...next, [key]: (next[key] as number) - 1 } as ScoreBreakdown;
        total = sumScoreParts(next);
        progressed = true;
        break;
      }
    }
    if (!progressed) break;
  }
  return { ...next, total };
}

const KNOWN_STRONG_EMPLOYER_RE =
  /\b(google|alphabet|meta|facebook|amazon|aws|microsoft|apple|netflix|uber|spotify|salesforce|oracle|ibm|stripe|airbnb|databricks|palantir|openai|anthropic|goldman|jpmorgan|jp\s*morgan|bloomberg)\b/i;

/**
 * Vague entry-level applied-AI startup posting: small total trim, recruiter cap, domain already handled in domain pass.
 */
export function applyVagueEarlyStageAiCalibration(params: {
  score: ScoreBreakdown;
  extracted: ExtractedJobData;
  rules: RuleEvaluation;
}): ScoreBreakdown {
  if (!params.rules.vagueEarlyStageAiCalibration) return params.score;
  const blob = jobTextBlob(params.extracted);
  const strongCompany = KNOWN_STRONG_EMPLOYER_RE.test(normalizeText(params.extracted.company ?? ""));
  const stackStrong = !params.rules.stackMismatch && params.score.stackFit >= 19;
  const escapeRecruiterCap = strongCompany || stackStrong;

  let next = { ...params.score };
  if (!escapeRecruiterCap) {
    next.recruiterFriendliness = Math.min(next.recruiterFriendliness, 10);
  }
  type Dim = LegacyScoreDimension;
  const order: Dim[] = [
    "stackFit",
    "functionalOverlap",
    "careerValue",
    "levelFit",
    "resumeStoryClarity",
    "recruiterFriendliness",
    "domainFit",
  ];
  const mins: Partial<Record<Dim, number>> = {
    stackFit: 12,
    functionalOverlap: 5,
    careerValue: 5,
    levelFit: 6,
    resumeStoryClarity: 10,
    recruiterFriendliness: 7,
    domainFit: 5,
  };

  let total = sumScoreParts(next);
  let targetDrop = 4;
  let guard = 0;
  while (total > 0 && targetDrop > 0 && guard < 40) {
    guard += 1;
    let progressed = false;
    for (const key of order) {
      const minV = mins[key] ?? 0;
      if (next[key] > minV) {
        next = { ...next, [key]: (next[key] as number) - 1 } as ScoreBreakdown;
        total = sumScoreParts(next);
        targetDrop -= 1;
        progressed = true;
        break;
      }
    }
    if (!progressed) break;
  }
  return { ...next, total };
}

/**
 * Research-heavy AI roles (publications/meta-learning/program synthesis/experiments)
 * should not be inflated by product LLM overlap alone.
 */
export function applyResearchHeavyAiCalibration(params: {
  score: ScoreBreakdown;
  rules: RuleEvaluation;
}): ScoreBreakdown {
  if (!params.rules.researchHeavyAiRole) return params.score;
  let next = { ...params.score };
  next.stackFit = Math.min(next.stackFit, 11);
  next.levelFit = Math.min(next.levelFit, 8);
  next.domainFit = Math.min(next.domainFit, 8);
  next.resumeStoryClarity = Math.min(next.resumeStoryClarity, 9);
  next.functionalOverlap = Math.min(next.functionalOverlap, 6);
  next.recruiterFriendliness = Math.min(next.recruiterFriendliness, 6);
  next.careerValue = Math.max(next.careerValue, 9);
  next.total = sumScoreParts(next);

  const targetLo = 55;
  const targetHi = 60;
  type Dim = LegacyScoreDimension;
  const downOrder: Dim[] = [
    "stackFit",
    "resumeStoryClarity",
    "functionalOverlap",
    "recruiterFriendliness",
    "levelFit",
    "domainFit",
  ];
  const mins: Partial<Record<Dim, number>> = {
    stackFit: 9,
    resumeStoryClarity: 7,
    functionalOverlap: 5,
    recruiterFriendliness: 4,
    levelFit: 6,
    domainFit: 6,
    careerValue: 9,
  };
  let guard = 0;
  while (next.total > targetHi && guard < 60) {
    guard += 1;
    let progressed = false;
    for (const key of downOrder) {
      if (next[key] > (mins[key] ?? 0)) {
        next = { ...next, [key]: (next[key] as number) - 1 } as ScoreBreakdown;
        next.total = sumScoreParts(next);
        progressed = true;
        break;
      }
    }
    if (!progressed) break;
  }
  const upOrder: Dim[] = ["careerValue", "domainFit", "levelFit", "recruiterFriendliness"];
  const maxs: Partial<Record<Dim, number>> = {
    careerValue: 10,
    domainFit: 8,
    levelFit: 8,
    recruiterFriendliness: 6,
  };
  guard = 0;
  while (next.total < targetLo && guard < 40) {
    guard += 1;
    let progressed = false;
    for (const key of upOrder) {
      if (next[key] < (maxs[key] ?? 99)) {
        next = { ...next, [key]: (next[key] as number) + 1 } as ScoreBreakdown;
        next.total = sumScoreParts(next);
        progressed = true;
        break;
      }
    }
    if (!progressed) break;
  }
  return next;
}

/**
 * Fintech/payments backend roles with Go-primary or microservices-heavy expectations:
 * viable but lower-priority stretch for TypeScript-first profile.
 */
export function applyFintechGoPrimaryCalibration(params: {
  score: ScoreBreakdown;
  extracted: ExtractedJobData;
  rules: RuleEvaluation;
}): ScoreBreakdown {
  const { score, extracted, rules } = params;
  if (!rules.fintechGoPrimaryStretch) return score;
  const blob = jobTextBlob(extracted);
  const goPrimary =
    /\b(go|golang)\s+is\s+our\s+primary\s+backend\s+language\b/i.test(blob) ||
    /\bprimary\s+backend\s+language\b[^.\n]{0,60}\b(go|golang)\b/i.test(blob) ||
    /\bstrong\s+proficiency\s+in\s+(go|golang)\b/i.test(blob);
  const jsPythonAcceptable =
    /\b(java|python|javascript|typescript)\b[^.\n]{0,70}\b(acceptable|also accepted|or equivalent|or similar)\b/i.test(
      blob,
    ) ||
    /\b(acceptable|equivalent|similar)\b[^.\n]{0,90}\b(java|python|javascript|typescript)\b/i.test(blob);

  let next = { ...score };
  const stackCap = goPrimary ? (jsPythonAcceptable ? 15 : 14) : 15;
  next.stackFit = Math.min(next.stackFit, stackCap);
  next.resumeStoryClarity = Math.min(next.resumeStoryClarity, 12);
  next.domainFit = Math.min(next.domainFit, 5);
  next.functionalOverlap = Math.min(next.functionalOverlap, 8);
  if (goPrimary) next.recruiterFriendliness = Math.min(next.recruiterFriendliness, 7);
  next.total = sumScoreParts(next);

  const targetLo = 66;
  const targetHi = 70;
  type Dim = LegacyScoreDimension;
  const downOrder: Dim[] = [
    "stackFit",
    "resumeStoryClarity",
    "domainFit",
    "functionalOverlap",
    "recruiterFriendliness",
    "levelFit",
  ];
  const mins: Partial<Record<Dim, number>> = {
    stackFit: 14,
    resumeStoryClarity: 11,
    domainFit: 4,
    functionalOverlap: 7,
    recruiterFriendliness: 6,
    levelFit: 9,
    careerValue: 8,
  };
  let guard = 0;
  while (next.total > targetHi && guard < 50) {
    guard += 1;
    let progressed = false;
    for (const k of downOrder) {
      if (next[k] > (mins[k] ?? 0)) {
        next = { ...next, [k]: (next[k] as number) - 1 } as ScoreBreakdown;
        next.total = sumScoreParts(next);
        progressed = true;
        break;
      }
    }
    if (!progressed) break;
  }
  const upOrder: Dim[] = ["functionalOverlap", "resumeStoryClarity", "stackFit", "recruiterFriendliness"];
  const maxs: Partial<Record<Dim, number>> = {
    stackFit: 15,
    resumeStoryClarity: 12,
    domainFit: 5,
    functionalOverlap: 8,
    recruiterFriendliness: 8,
  };
  guard = 0;
  while (next.total < targetLo && guard < 40) {
    guard += 1;
    let progressed = false;
    for (const k of upOrder) {
      if (next[k] < (maxs[k] ?? 99)) {
        next = { ...next, [k]: (next[k] as number) + 1 } as ScoreBreakdown;
        next.total = sumScoreParts(next);
        progressed = true;
        break;
      }
    }
    if (!progressed) break;
  }
  return next;
}

/**
 * Founding/early-startup roles: keep strong technical overlap visible,
 * but separate recruiter/level risk from stack-fit optimism.
 */
export function applyFoundingEngineerStretchCalibration(params: {
  score: ScoreBreakdown;
  extracted: ExtractedJobData;
  rules: RuleEvaluation;
}): ScoreBreakdown {
  const { score, extracted, rules } = params;
  if (!rules.foundingEngineerStretch) return score;
  const blob = jobTextBlob(extracted);
  const healthcareOps =
    /\b(healthcare|clinical|patient|compliance|hipaa|care operations)\b/i.test(blob);
  let next = { ...score };
  next.stackFit = Math.max(21, Math.min(next.stackFit, 23));
  next.levelFit = Math.max(8, Math.min(next.levelFit, 9));
  next.domainFit = Math.max(7, Math.min(next.domainFit, 7));
  next.resumeStoryClarity = Math.max(13, Math.min(next.resumeStoryClarity, 14));
  next.functionalOverlap = Math.max(9, Math.min(next.functionalOverlap, 9));
  next.recruiterFriendliness = Math.max(7, Math.min(next.recruiterFriendliness, 8));
  next.careerValue = Math.max(10, Math.min(next.careerValue, 10));
  if (healthcareOps && next.domainFit < 7) next.domainFit = 7;
  next.total = sumScoreParts(next);

  const targetLo = 77;
  const targetHi = 79;
  type Dim = LegacyScoreDimension;
  const downOrder: Dim[] = ["stackFit", "resumeStoryClarity", "recruiterFriendliness", "levelFit"];
  const mins: Partial<Record<Dim, number>> = {
    stackFit: 21,
    resumeStoryClarity: 13,
    recruiterFriendliness: 7,
    levelFit: 8,
    domainFit: 7,
    functionalOverlap: 9,
    careerValue: 10,
  };
  let guard = 0;
  while (next.total > targetHi && guard < 40) {
    guard += 1;
    let progressed = false;
    for (const k of downOrder) {
      if (next[k] > (mins[k] ?? 0)) {
        next = { ...next, [k]: (next[k] as number) - 1 } as ScoreBreakdown;
        next.total = sumScoreParts(next);
        progressed = true;
        break;
      }
    }
    if (!progressed) break;
  }
  const upOrder: Dim[] = ["recruiterFriendliness", "levelFit", "resumeStoryClarity", "stackFit"];
  const maxs: Partial<Record<Dim, number>> = {
    stackFit: 23,
    resumeStoryClarity: 14,
    recruiterFriendliness: 8,
    levelFit: 9,
    domainFit: 7,
    functionalOverlap: 9,
    careerValue: 10,
  };
  guard = 0;
  while (next.total < targetLo && guard < 40) {
    guard += 1;
    let progressed = false;
    for (const k of upOrder) {
      if (next[k] < (maxs[k] ?? 99)) {
        next = { ...next, [k]: (next[k] as number) + 1 } as ScoreBreakdown;
        next.total = sumScoreParts(next);
        progressed = true;
        break;
      }
    }
    if (!progressed) break;
  }
  return next;
}

/**
 * Credentialed fintech / accounting-systems roles (strict CS degree, GAAP/ASC 606, publication-depth):
 * keep totals in a skip band; career value can stay high.
 */
export function applyCredentialHeavyFintechAlgorithmCalibration(params: {
  score: ScoreBreakdown;
  rules: RuleEvaluation;
}): ScoreBreakdown {
  if (!params.rules.credentialHeavyFintechAlgorithm) return params.score;
  let next = { ...params.score };
  next.stackFit = Math.min(next.stackFit, 8);
  next.levelFit = Math.min(next.levelFit, 6);
  next.domainFit = Math.min(next.domainFit, 4);
  next.resumeStoryClarity = Math.min(next.resumeStoryClarity, 6);
  next.functionalOverlap = Math.min(next.functionalOverlap, 6);
  next.recruiterFriendliness = Math.min(next.recruiterFriendliness, 3);
  next.careerValue = Math.max(next.careerValue, 9);
  next.total = sumScoreParts(next);

  const targetLo = 35;
  const targetHi = 45;
  type Dim = LegacyScoreDimension;
  const downOrder: Dim[] = [
    "stackFit",
    "resumeStoryClarity",
    "functionalOverlap",
    "levelFit",
    "domainFit",
    "recruiterFriendliness",
  ];
  const mins: Partial<Record<Dim, number>> = {
    stackFit: 6,
    levelFit: 4,
    domainFit: 2,
    resumeStoryClarity: 4,
    functionalOverlap: 4,
    recruiterFriendliness: 1,
    careerValue: 9,
  };
  let guard = 0;
  while (next.total > targetHi && guard < 80) {
    guard += 1;
    let progressed = false;
    for (const key of downOrder) {
      if (next[key] > (mins[key] ?? 0)) {
        next = { ...next, [key]: (next[key] as number) - 1 } as ScoreBreakdown;
        next.total = sumScoreParts(next);
        progressed = true;
        break;
      }
    }
    if (!progressed) break;
  }
  const upOrder: Dim[] = [
    "careerValue",
    "stackFit",
    "resumeStoryClarity",
    "domainFit",
    "levelFit",
    "functionalOverlap",
    "recruiterFriendliness",
  ];
  const maxs: Partial<Record<Dim, number>> = {
    stackFit: 8,
    levelFit: 6,
    domainFit: 4,
    resumeStoryClarity: 6,
    functionalOverlap: 6,
    recruiterFriendliness: 3,
    careerValue: 10,
  };
  guard = 0;
  while (next.total < targetLo && guard < 80) {
    guard += 1;
    let progressed = false;
    for (const key of upOrder) {
      if (next[key] < (maxs[key] ?? 99)) {
        next = { ...next, [key]: (next[key] as number) + 1 } as ScoreBreakdown;
        next.total = sumScoreParts(next);
        progressed = true;
        break;
      }
    }
    if (!progressed) break;
  }
  guard = 0;
  while (next.total > targetHi && guard < 80) {
    guard += 1;
    let progressed = false;
    for (const key of downOrder) {
      if (next[key] > (mins[key] ?? 0)) {
        next = { ...next, [key]: (next[key] as number) - 1 } as ScoreBreakdown;
        next.total = sumScoreParts(next);
        progressed = true;
        break;
      }
    }
    if (!progressed) break;
  }
  return next;
}

/**
 * Go-first distributed data infrastructure (streaming, warehouses, specialized stores):
 * keep totals in a skip / one-click band; do not let generic API overlap inflate stack.
 */
export function applyGoDistributedDataInfraCalibration(params: {
  score: ScoreBreakdown;
  rules: RuleEvaluation;
}): ScoreBreakdown {
  if (!params.rules.goDistributedDataInfraCandidateGap) return params.score;
  if (params.rules.credentialHeavyFintechAlgorithm) return params.score;

  let next = { ...params.score };
  next.stackFit = Math.min(next.stackFit, 10);
  next.levelFit = Math.min(next.levelFit, 8);
  next.domainFit = Math.min(next.domainFit, 6);
  next.resumeStoryClarity = Math.min(next.resumeStoryClarity, 9);
  next.functionalOverlap = Math.min(next.functionalOverlap, 7);
  next.recruiterFriendliness = Math.min(next.recruiterFriendliness, 6);
  next.careerValue = Math.max(7, Math.min(9, next.careerValue));
  next.total = sumScoreParts(next);

  const targetLo = 48;
  const targetHi = 55;
  type Dim = LegacyScoreDimension;
  const downOrder: Dim[] = [
    "stackFit",
    "resumeStoryClarity",
    "functionalOverlap",
    "levelFit",
    "domainFit",
    "recruiterFriendliness",
  ];
  const mins: Partial<Record<Dim, number>> = {
    stackFit: 6,
    levelFit: 6,
    domainFit: 4,
    resumeStoryClarity: 6,
    functionalOverlap: 5,
    recruiterFriendliness: 4,
    careerValue: 7,
  };
  let guard = 0;
  while (next.total > targetHi && guard < 80) {
    guard += 1;
    let progressed = false;
    for (const key of downOrder) {
      if (next[key] > (mins[key] ?? 0)) {
        next = { ...next, [key]: (next[key] as number) - 1 } as ScoreBreakdown;
        next.total = sumScoreParts(next);
        progressed = true;
        break;
      }
    }
    if (!progressed) break;
  }
  const upOrder: Dim[] = ["careerValue", "stackFit", "resumeStoryClarity", "domainFit", "levelFit"];
  const maxs: Partial<Record<Dim, number>> = {
    stackFit: 10,
    levelFit: 8,
    domainFit: 6,
    resumeStoryClarity: 9,
    functionalOverlap: 7,
    recruiterFriendliness: 6,
    careerValue: 9,
  };
  guard = 0;
  while (next.total < targetLo && guard < 80) {
    guard += 1;
    let progressed = false;
    for (const key of upOrder) {
      if (next[key] < (maxs[key] ?? 99)) {
        next = { ...next, [key]: (next[key] as number) + 1 } as ScoreBreakdown;
        next.total = sumScoreParts(next);
        progressed = true;
        break;
      }
    }
    if (!progressed) break;
  }
  guard = 0;
  while (next.total > targetHi && guard < 80) {
    guard += 1;
    let progressed = false;
    for (const key of downOrder) {
      if (next[key] > (mins[key] ?? 0)) {
        next = { ...next, [key]: (next[key] as number) - 1 } as ScoreBreakdown;
        next.total = sumScoreParts(next);
        progressed = true;
        break;
      }
    }
    if (!progressed) break;
  }
  return next;
}

/**
 * Charlie Health–shaped healthcare product engineering: keep totals in a realistic high-80s band
 * (internal calibration; visible copy must stay company-specific via risk sanitizer).
 */
export function applyCharlieHealthProductCalibration(params: {
  score: ScoreBreakdown;
  extracted: ExtractedJobData;
  rules: RuleEvaluation;
  userProfile: UserProfile;
}): ScoreBreakdown {
  const { score, extracted, rules, userProfile } = params;
  if (rules.goDistributedDataInfraCandidateGap) return score;
  if (!/\bcharlie\s+health\b/i.test((extracted.company ?? "").trim())) return score;
  if (!rules.healthcareProductEngineering || rules.domainMismatch || rules.stackMismatch) return score;
  if (rules.explicitCoreLanguageMismatch || rules.fdeBuilderSoftwarePrimary || rules.vagueEarlyStageAiCalibration) {
    return score;
  }

  const conservativeBar =
    Boolean(rules.productionBarCompetitivePool) && isNonTraditionalEarlyCareerProfile(userProfile);

  type Dim = LegacyScoreDimension;
  const bands: Record<Dim, [number, number]> = conservativeBar
    ? {
        stackFit: [18, 21],
        levelFit: [10, 11],
        domainFit: [6, 7],
        resumeStoryClarity: [12, 14],
        functionalOverlap: [8, 9],
        recruiterFriendliness: [7, 8],
        careerValue: [8, 9],
      }
    : {
        stackFit: [20, 22],
        levelFit: [11, 12],
        domainFit: [6, 7],
        resumeStoryClarity: [14, 15],
        functionalOverlap: [9, 10],
        recruiterFriendliness: [10, 11],
        careerValue: [8, 9],
      };

  let next: ScoreBreakdown = { ...score };
  (Object.keys(bands) as Dim[]).forEach((k) => {
    const [lo, hi] = bands[k];
    next[k] = Math.min(hi, Math.max(lo, next[k])) as ScoreBreakdown[typeof k];
  });
  next.total = sumScoreParts(next);

  const targetLo = conservativeBar ? 76 : 82;
  const targetHi = conservativeBar ? 80 : 85;
  let guard = 0;
  while (next.total < targetLo && guard < 28) {
    guard += 1;
    let progressed = false;
    for (const k of Object.keys(bands) as Dim[]) {
      const [lo, hi] = bands[k];
      const cur = next[k] as number;
      if (cur < hi) {
        next = { ...next, [k]: cur + 1 } as ScoreBreakdown;
        next.total = sumScoreParts(next);
        progressed = true;
        break;
      }
    }
    if (!progressed) break;
  }
  guard = 0;
  while (next.total > targetHi && guard < 28) {
    guard += 1;
    let progressed = false;
    for (const k of Object.keys(bands) as Dim[]) {
      const [lo, hi] = bands[k];
      const cur = next[k] as number;
      if (cur > lo) {
        next = { ...next, [k]: cur - 1 } as ScoreBreakdown;
        next.total = sumScoreParts(next);
        progressed = true;
        break;
      }
    }
    if (!progressed) break;
  }
  return next;
}

export function appendMatureLanguageShotGuidance(topMatch: string, rules: RuleEvaluation): string {
  if (!rules.explicitCoreLanguageMismatch || !rules.matureStructuredEmployer) return topMatch;
  const lab =
    rules.explicitCoreLanguage === "java"
      ? "Java"
      : rules.explicitCoreLanguage === "go"
        ? "Go"
        : rules.explicitCoreLanguage === "python"
          ? "Python"
          : "the stated core language";
  const tail = `Apply, but treat as a lower-probability shot because the explicit ${lab} backend requirement is a major recruiter-screen risk.`;
  const base = topMatch.trim();
  if (!base) return tail;
  if (/\blower[-\s]?probability\b/i.test(base)) return base;
  return `${base.replace(/\.\s*$/, "")}. ${tail}`;
}

export function appendLotteryTicketGuidance(topMatch: string, params: {
  score: ScoreBreakdown;
  rules: RuleEvaluation;
}): string {
  if (params.rules.credentialHeavyFintechAlgorithm) return topMatch;
  if (params.rules.goDistributedDataInfraCandidateGap) return topMatch;
  if (params.score.total >= 60) return topMatch;
  if (!params.rules.researchHeavyAiRole && params.score.careerValue < 9) return topMatch;
  if (/\blottery[-\s]?ticket\b/i.test(topMatch)) return topMatch;
  const suffix = "At this fit level, treat this as a lottery-ticket only application.";
  const base = topMatch.trim();
  return base ? `${base.replace(/\.\s*$/, "")}. ${suffix}` : suffix;
}

export function appendFintechGoStretchGuidance(topMatch: string, params: {
  rules: RuleEvaluation;
  extracted: ExtractedJobData;
}): string {
  if (!params.rules.fintechGoPrimaryStretch) return topMatch;
  const stretch = textMentionsGoLanguage(jobTextBlob(params.extracted))
    ? "Go-primary fintech infrastructure"
    : "multi-service payments infrastructure";
  return `Moderate backend/API fit with useful product collaboration overlap, but ${stretch} makes this a stretch.`;
}

export function appendFoundingStretchGuidance(topMatch: string, params: {
  rules: RuleEvaluation;
}): string {
  if (!params.rules.foundingEngineerStretch) return topMatch;
  return "Strong technical fit, meaningful founding-engineer risk. This is a high-alignment stretch rather than a top-confidence screen pass.";
}

export function appendCredentialedAccountingSystemsGuidance(topMatch: string, params: {
  rules: RuleEvaluation;
}): string {
  if (!params.rules.credentialHeavyFintechAlgorithm) return topMatch;
  return "This is a credentialed fintech/accounting systems profile, not a general full-stack AI role.";
}

export function appendGoDistributedDataInfraStretchGuidance(topMatch: string, params: {
  rules: RuleEvaluation;
}): string {
  if (!params.rules.goDistributedDataInfraCandidateGap) return topMatch;
  return "Low-fit backend/data-infrastructure stretch with minor API/database overlap.";
}

export function polishScoringNarrative(params: {
  narrative: Pick<ScoringNarrative, "topMatch" | "mainRisk" | "risks" | "rationale">;
  score: ScoreBreakdown;
  extracted: ExtractedJobData;
  userProfile: UserProfile;
  rules: RuleEvaluation;
  resumeRawText?: string;
}): ScoringNarrative {
  const travelLine = travelRiskLine(jobTextBlob(params.extracted));
  const visibleCtx: VisibleSanitizeContext = {
    extracted: params.extracted,
    userProfile: params.userProfile,
    rules: params.rules,
    resumeRawText: params.resumeRawText,
  };
  const riskMax =
    params.rules.credentialHeavyFintechAlgorithm ||
    params.rules.goDistributedDataInfraCandidateGap ||
    params.rules.titleResponsibilityMismatch ||
    params.rules.highOwnershipLowSupport ||
    params.rules.reinforcedExperienceFloor ||
    params.rules.productionInfraOwnershipGap
      ? 3
      : 2;
  const { mainRisk, risks } = polishRisksAndMain({
    mainRisk: params.narrative.mainRisk,
    risks: params.narrative.risks,
    extracted: params.extracted,
    travelLine,
    max: riskMax,
    rules: params.rules,
    userProfile: params.userProfile,
    resumeRawText: params.resumeRawText,
  });

  // Bug 1: severity-flagged Key Risk prose must dock Level fit — not leave Strong Yes intact.
  const riskBlob = [mainRisk, ...risks, ...(params.rules.notes ?? [])].join("\n");
  const severityInProse = textSignalsEarlyCareerExceedSeverity(riskBlob);
  let score = params.score;
  if (params.rules.titleResponsibilityMismatch) {
    if (score.levelFit > TITLE_RESPONSIBILITY_MISMATCH_LEVEL_FIT_MAX) {
      const next = {
        ...score,
        levelFit: TITLE_RESPONSIBILITY_MISMATCH_LEVEL_FIT_MAX,
      };
      score = { ...next, total: sumScoreParts(next) };
    }
  } else if (severityInProse && score.levelFit > EARLY_CAREER_EXCEED_SEVERITY_LEVEL_FIT_MAX) {
    const next = {
      ...score,
      levelFit: EARLY_CAREER_EXCEED_SEVERITY_LEVEL_FIT_MAX,
    };
    score = { ...next, total: sumScoreParts(next) };
  }

  const rationale = polishRationaleBullets(params.narrative.rationale, 2, visibleCtx);
  const rawTop = params.narrative.topMatch?.trim() ?? "";
  let topMatch = appendMatureLanguageShotGuidance(
    rawTop ? sanitizeNarrativeSentence(rawTop, 50) : rawTop,
    params.rules,
  );
  topMatch = appendFintechGoStretchGuidance(topMatch, { rules: params.rules, extracted: params.extracted });
  topMatch = appendFoundingStretchGuidance(topMatch, { rules: params.rules });
  topMatch = appendCredentialedAccountingSystemsGuidance(topMatch, { rules: params.rules });
  topMatch = appendGoDistributedDataInfraStretchGuidance(topMatch, { rules: params.rules });
  topMatch = appendLotteryTicketGuidance(topMatch, { score, rules: params.rules });
  topMatch = sanitizeVisibleNarrativeLine(topMatch, visibleCtx);
  return { score, topMatch, mainRisk, risks, rationale };
}
