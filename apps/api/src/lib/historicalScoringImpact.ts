import type { ApplicationEvaluation } from "../services/gmail/jdRecovery/evaluations.repository.js";
import type { ExtractedJobData } from "../types/job.js";
import { resolveStoredFitScore } from "./authoritativeScore.js";
import { classifyRoleLane } from "./roleFunctionClassifier.js";
import { titleIsNumberedEngineerLevel } from "./seniorityReconciliation.js";
import {
  pythonIsExclusiveCoreRequirement,
  pythonOnMixedStackInventory,
} from "./stackMismatchAnalysis.js";
import { extractGroundedYearsClauses } from "./yearsExperienceReconciliation.js";

export type ImpactConfidence = "confirmed" | "heuristic";

export type HistoricalImpactIssue = {
  kind:
    | "conflicting_totals"
    | "seniority_extraction"
    | "core_language_gap"
    | "role_lane";
  confidence: ImpactConfidence;
  detail: string;
  deterministicFromStoredEvidence: boolean;
  needsJdReinterpretation: boolean;
  laterReviewOnly?: boolean;
};

export type HistoricalImpactRow = {
  key: string;
  company: string;
  role: string | null;
  issues: HistoricalImpactIssue[];
};

const LATER_REVIEW_PLATFORM_COMPANIES = /\b(genius\s*ai|sydecar)\b/i;

const reconstructedJob = (evaluation: ApplicationEvaluation): ExtractedJobData | null => {
  const extracted = evaluation.fit?.detail?.extracted;
  if (!extracted) return null;
  return {
    ...extracted,
    rawText: evaluation.jd?.text ?? "",
  };
};

const uniqueMins = (job: ExtractedJobData): number[] => {
  const seen: number[] = [];
  for (const clause of extractGroundedYearsClauses(job)) {
    if (!seen.some((n) => Math.abs(n - clause.min) < 0.05)) seen.push(clause.min);
  }
  return seen.sort((a, b) => a - b);
};

const conflictingTotals = (evaluation: ApplicationEvaluation): HistoricalImpactIssue | null => {
  const resolved = resolveStoredFitScore(evaluation.fit);
  if (!resolved.conflict && resolved.source !== "unresolved") return null;
  if (!resolved.conflict && resolved.source === "unresolved" && resolved.storedFitTotal == null) {
    return null;
  }
  return {
    kind: "conflicting_totals",
    confidence: resolved.source === "unresolved" ? "confirmed" : "confirmed",
    detail:
      resolved.note ??
      `fit.total=${resolved.storedFitTotal} detail.score.total=${resolved.storedDetailTotal} scoreDisplay.final=${resolved.storedDisplayFinal}`,
    deterministicFromStoredEvidence: resolved.source !== "unresolved",
    needsJdReinterpretation: resolved.source === "unresolved",
  };
};

const seniorityIssue = (
  evaluation: ApplicationEvaluation,
  job: ExtractedJobData | null,
): HistoricalImpactIssue | null => {
  const extracted = evaluation.fit?.detail?.extracted;
  const storedMin = extracted?.yearsExperience?.min;
  const storedSeniority = extracted?.seniority;
  const title = extracted?.title ?? evaluation.role ?? evaluation.jd?.title ?? "";
  const numbered = titleIsNumberedEngineerLevel(title);

  if (job) {
    const mins = uniqueMins(job);
    if (storedMin != null && storedMin >= 5 && mins.length === 1 && mins[0]! < 5) {
      return {
        kind: "seniority_extraction",
        confidence: "confirmed",
        detail: `stored years min ${storedMin} vs explicit JD floor ${mins[0]}`,
        deterministicFromStoredEvidence: true,
        needsJdReinterpretation: false,
      };
    }
    if (mins.length > 1 && storedMin != null) {
      return {
        kind: "seniority_extraction",
        confidence: "confirmed",
        detail: `conflicting JD year floors (${mins.join(", ")}); stored min ${storedMin}`,
        deterministicFromStoredEvidence: false,
        needsJdReinterpretation: true,
      };
    }
  }

  if (numbered && storedSeniority && /\bsenior\b/i.test(storedSeniority)) {
    return {
      kind: "seniority_extraction",
      confidence: "confirmed",
      detail: `${title} stored seniority "${storedSeniority}" — numbered engineer level is not senior`,
      deterministicFromStoredEvidence: true,
      needsJdReinterpretation: !job,
    };
  }

  if (storedMin != null && storedMin >= 5 && job && uniqueMins(job).length === 0) {
    return {
      kind: "seniority_extraction",
      confidence: "heuristic",
      detail: `stored years min ${storedMin} with no explicit JD year clause`,
      deterministicFromStoredEvidence: false,
      needsJdReinterpretation: true,
    };
  }

  return null;
};

const coreLanguageIssue = (
  evaluation: ApplicationEvaluation,
  job: ExtractedJobData | null,
): HistoricalImpactIssue | null => {
  const gaps = evaluation.fit?.detail?.rules.coreLanguageGap ?? [];
  const pythonGap = gaps.some((g) => /\bpython\b/i.test(g));
  if (!pythonGap) return null;
  if (!job) {
    return {
      kind: "core_language_gap",
      confidence: "heuristic",
      detail: "Python listed as a core-language gap; JD text missing for mixed-stack check",
      deterministicFromStoredEvidence: false,
      needsJdReinterpretation: true,
    };
  }
  if (pythonIsExclusiveCoreRequirement(job)) return null;
  if (pythonOnMixedStackInventory(job)) {
    return {
      kind: "core_language_gap",
      confidence: "confirmed",
      detail: "Python core-language gap on a mixed TypeScript/React inventory line",
      deterministicFromStoredEvidence: true,
      needsJdReinterpretation: false,
    };
  }
  return {
    kind: "core_language_gap",
    confidence: "heuristic",
    detail: "Python core-language gap; requirement language is not clearly exclusive",
    deterministicFromStoredEvidence: false,
    needsJdReinterpretation: true,
  };
};

const roleLaneIssue = (
  evaluation: ApplicationEvaluation,
  job: ExtractedJobData | null,
): HistoricalImpactIssue | null => {
  const storedLane = evaluation.fit?.detail?.rules.roleLane;
  if (storedLane !== "platform_infra") return null;
  const company = evaluation.company ?? "";
  const laterReview = LATER_REVIEW_PLATFORM_COMPANIES.test(company);

  if (job) {
    const current = classifyRoleLane(job);
    if (current.label.startsWith("product_")) {
      return {
        kind: "role_lane",
        confidence: "confirmed",
        detail: `stored platform_infra; current classifier is ${current.label}`,
        deterministicFromStoredEvidence: true,
        needsJdReinterpretation: false,
        laterReviewOnly: laterReview,
      };
    }
  }

  return {
    kind: "role_lane",
    confidence: "heuristic",
    detail: laterReview
      ? `${company} stored as platform_infra — later review only, do not change score`
      : "stored platform_infra; current lane could not be confirmed from stored evidence",
    deterministicFromStoredEvidence: false,
    needsJdReinterpretation: !job,
    laterReviewOnly: laterReview,
  };
};

export const assessHistoricalEvaluation = (
  evaluation: ApplicationEvaluation,
): HistoricalImpactRow => {
  const job = reconstructedJob(evaluation);
  const issues = [
    conflictingTotals(evaluation),
    seniorityIssue(evaluation, job),
    coreLanguageIssue(evaluation, job),
    roleLaneIssue(evaluation, job),
  ].filter((issue): issue is HistoricalImpactIssue => Boolean(issue));

  return {
    key: evaluation.key,
    company: evaluation.company,
    role: evaluation.role,
    issues,
  };
};

export type HistoricalImpactReport = {
  evaluated: number;
  potentiallyAffected: number;
  conflictingTotals: HistoricalImpactRow[];
  seniorityExtraction: HistoricalImpactRow[];
  coreLanguageGaps: HistoricalImpactRow[];
  roleLane: HistoricalImpactRow[];
  confirmed: HistoricalImpactRow[];
  heuristic: HistoricalImpactRow[];
  deterministicFromStoredEvidence: HistoricalImpactRow[];
  needsJdReinterpretationOrHumanReview: HistoricalImpactRow[];
  laterReviewOnly: HistoricalImpactRow[];
};

export const summarizeHistoricalImpact = (
  evaluations: ApplicationEvaluation[],
): HistoricalImpactReport => {
  const rows = evaluations
    .filter((evaluation) => evaluation.recovery.status === "scored" && evaluation.fit)
    .map(assessHistoricalEvaluation);
  const withIssues = rows.filter((row) => row.issues.length > 0);
  const has = (kind: HistoricalImpactIssue["kind"]) =>
    withIssues.filter((row) => row.issues.some((issue) => issue.kind === kind));
  const hasConfidence = (confidence: ImpactConfidence) =>
    withIssues.filter((row) => row.issues.some((issue) => issue.confidence === confidence));

  return {
    evaluated: rows.length,
    potentiallyAffected: withIssues.length,
    conflictingTotals: has("conflicting_totals"),
    seniorityExtraction: has("seniority_extraction"),
    coreLanguageGaps: has("core_language_gap"),
    roleLane: has("role_lane"),
    confirmed: hasConfidence("confirmed"),
    heuristic: hasConfidence("heuristic"),
    deterministicFromStoredEvidence: withIssues.filter((row) =>
      row.issues.some((issue) => issue.deterministicFromStoredEvidence),
    ),
    needsJdReinterpretationOrHumanReview: withIssues.filter((row) =>
      row.issues.some((issue) => issue.needsJdReinterpretation || issue.laterReviewOnly),
    ),
    laterReviewOnly: withIssues.filter((row) => row.issues.some((issue) => issue.laterReviewOnly)),
  };
};
