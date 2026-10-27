import { env } from "../../config/env.js";
import { RECOMMENDATION_LABELS } from "../../config/capabilitySurvivabilityPolicy.js";
import { recommendationForScore } from "../../lib/compositeScoring.js";
import { resolveEmployerScale } from "../../lib/employerScale.js";
import { computePoolFriendliness } from "../../lib/poolFriendliness.js";
import type { ExtractedJobData } from "../../types/job.js";
import type { StoredResumeType } from "../../types/resume.js";
import type { RuleEvaluation, ScoreBreakdown } from "../../types/scoring.js";

/** What is known about a role before applying; the same shape exists for a brand-new score. */
export type FeatureSubject = {
  fit: number | null;
  extracted?: Omit<ExtractedJobData, "rawText">;
  rules?: RuleEvaluation;
  score?: ScoreBreakdown;
  recommendedResume?: StoredResumeType;
  postingUrl?: string;
  appliedAt?: string | null;
  addedFromGmail?: boolean;
};

export type Feature = {
  key: string;
  label: string;
  /** Can be computed for a new role at scoring time, so a pattern here may become a score adjustment. */
  scorable: boolean;
  /** Bucket(s) the role falls in; empty when unknown, so it's left out of this comparison. */
  values: (s: FeatureSubject) => string[];
};

const one = (v: string | null | undefined): string[] => (v ? [v] : []);

const lower = (s: string | undefined) => (s ?? "").toLowerCase();

const channelOf = (url: string | undefined): string | null => {
  if (!url) return null;
  let host = "";
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
  const known: Array<[RegExp, string]> = [
    [/greenhouse\.io$/, "Greenhouse"],
    [/lever\.co$/, "Lever"],
    [/ashbyhq\.com$/, "Ashby"],
    [/myworkdayjobs\.com$|workday\.com$/, "Workday"],
    [/linkedin\.com$/, "LinkedIn"],
    [/indeed\.com$/, "Indeed"],
    [/smartrecruiters\.com$/, "SmartRecruiters"],
    [/workable\.com$/, "Workable"],
    [/ziprecruiter\.com$/, "ZipRecruiter"],
  ];
  for (const [re, name] of known) if (re.test(host)) return name;
  return "Company site / other";
};

export const SENIORITY_BUCKETS = [
  "Campus / new-grad",
  "Junior / SWE I",
  "Mid / SWE II / unlabeled",
  "Senior / lead",
] as const;
export type SeniorityBucket = (typeof SENIORITY_BUCKETS)[number];

export const DEGREE_BUCKETS = ["Required", "Preferred / equivalent", "None stated"] as const;
export type DegreeBucket = (typeof DEGREE_BUCKETS)[number];

const CAMPUS_RE = /\b(new[\s-]?grad|campus|university hire|grad(uate)? program)\b/;
const SENIOR_RE = /\b(senior|sr\.?|staff|principal|lead)\b/;
const JUNIOR_RE =
  /\b(junior|jr\.?|entry[\s-]?level|associate|intern)\b|\b(software engineer|swe|engineer)\s+(i|1)\b/;

/** Title + years + new-grad pipeline; campus is separate from ordinary junior openings. */
export const screeningSeniority = (s: FeatureSubject): SeniorityBucket | null => {
  const title = `${lower(s.extracted?.seniority)} ${lower(s.extracted?.title)}`;
  const min = s.extracted?.yearsExperience?.min;
  if (s.rules?.strictNewGradPipeline || CAMPUS_RE.test(title)) return "Campus / new-grad";
  if (SENIOR_RE.test(title) || (min != null && min >= 5)) return "Senior / lead";
  const juniorField = /\b(i|1|junior|jr\.?|entry)\b/.test(lower(s.extracted?.seniority ?? ""));
  if (JUNIOR_RE.test(title) || juniorField || (min != null && min <= 1)) return "Junior / SWE I";
  if (title.trim() || min != null) return "Mid / SWE II / unlabeled";
  return null;
};

const seniorityOf = (s: FeatureSubject): string | null => screeningSeniority(s);

export const degreeBucketOf = (s: FeatureSubject): DegreeBucket | null => {
  if (!s.extracted) return null;
  const level = s.extracted.degreeRequirement?.level;
  if (level === "required") return "Required";
  if (level === "preferred" || level === "equivalent_allowed") return "Preferred / equivalent";
  return "None stated";
};

const AI_TAG_RE = /\b(ai|ml|llm|machine learning|applied ai)\b/;
const AI_TITLE_RE = /\b(forward[\s-]?deployed|fde|applied ai|machine learning|ml engineer)\b/;

/** Cross-cut: a role can be junior and specialized AI / FDE at once. */
export const isSpecializedAiFde = (s: FeatureSubject): boolean | null => {
  if (!s.extracted && !s.rules) return null;
  if (s.rules?.researchHeavyAiRole || s.rules?.fdeBuilderSoftwarePrimary) return true;
  const tags = (s.extracted?.domainTags ?? []).join(" ");
  if (AI_TAG_RE.test(tags)) return true;
  return AI_TITLE_RE.test(lower(s.extracted?.title));
};

const minYearsOf = (s: FeatureSubject): string | null => {
  const min = s.extracted?.yearsExperience?.min;
  if (min == null) return s.extracted ? "Not stated" : null;
  if (min <= 1) return "0-1 years";
  if (min <= 2) return "2 years";
  if (min <= 4) return "3-4 years";
  return "5+ years";
};

const salaryOf = (s: FeatureSubject): string | null => {
  const sal = s.extracted?.salary;
  if (!s.extracted) return null;
  const mid = sal?.min && sal?.max ? (sal.min + sal.max) / 2 : (sal?.min ?? sal?.max);
  if (!mid || mid < 20_000) return "Not stated";
  if (mid < 100_000) return "Under $100k";
  if (mid < 130_000) return "$100-130k";
  if (mid < 160_000) return "$130-160k";
  return "$160k+";
};

const locationOf = (s: FeatureSubject): string | null => {
  const e = s.extracted;
  if (!e) return null;
  if (e.remoteType === "remote") return "Remote";
  if (/new york|nyc|brooklyn|manhattan/i.test(e.location ?? "")) return e.remoteType === "hybrid" ? "NYC hybrid" : "NYC onsite";
  if (e.remoteType === "hybrid" || e.remoteType === "onsite") return "Other city (hybrid/onsite)";
  return null;
};

const employerScaleOf = (s: FeatureSubject): string | null => {
  if (!s.extracted) return null;
  const scale = resolveEmployerScale(s.extracted);
  if (scale.isLargeEmployer || scale.isBrandName) return "Large / well-known";
  if (scale.isStartupSmallByHeadcount) return "Startup / small team";
  if (scale.employeeCount != null) return "Mid-size";
  return "Unknown";
};

const poolOf = (s: FeatureSubject): string | null => {
  if (!s.extracted) return null;
  const pool = computePoolFriendliness(s.extracted as ExtractedJobData).score;
  if (pool < 0.45) return "Crowded pool";
  if (pool > 0.55) return "Friendlier pool";
  return "Neutral pool";
};

const etDay = (iso: string): number | null => {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  const name = new Intl.DateTimeFormat("en-US", { weekday: "short", timeZone: env.userTimezone }).format(new Date(t));
  return ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(name);
};

const postingAgeOf = (s: FeatureSubject): string | null => {
  const posted = s.extracted?.postedAt ? Date.parse(s.extracted.postedAt) : NaN;
  const applied = s.appliedAt ? Date.parse(s.appliedAt) : NaN;
  if (!Number.isFinite(posted) || !Number.isFinite(applied)) return null;
  const days = (applied - posted) / 86_400_000;
  if (days < 0) return null;
  if (days <= 3) return "Applied within 3 days of posting";
  if (days <= 14) return "4-14 days after posting";
  return "15+ days after posting";
};

export const FEATURES: Feature[] = [
  {
    key: "tier",
    label: "Score tier",
    scorable: false,
    values: (s) => (s.fit == null ? [] : [RECOMMENDATION_LABELS[recommendationForScore(s.fit)]]),
  },
  { key: "resume", label: "Resume used", scorable: true, values: (s) => one(s.recommendedResume) },
  { key: "location", label: "Location / work model", scorable: true, values: (s) => one(locationOf(s)) },
  { key: "seniority", label: "Seniority in title", scorable: true, values: (s) => one(seniorityOf(s)) },
  { key: "minYears", label: "Minimum years asked", scorable: true, values: (s) => one(minYearsOf(s)) },
  { key: "employer", label: "Employer scale", scorable: true, values: (s) => one(employerScaleOf(s)) },
  { key: "pool", label: "Applicant pool shape", scorable: true, values: (s) => one(poolOf(s)) },
  {
    key: "domain",
    label: "Domain",
    scorable: true,
    values: (s) => [...new Set((s.extracted?.domainTags ?? []).map((t) => t.trim().toLowerCase()).filter(Boolean))],
  },
  {
    key: "languageGap",
    label: "Required language you don't list",
    scorable: true,
    values: (s) =>
      s.rules ? [s.rules.coreLanguageGap?.length || s.rules.explicitCoreLanguageMismatch ? "Yes" : "No"] : [],
  },
  {
    key: "experienceGap",
    label: "Experience gap dock",
    scorable: true,
    values: (s) => (s.rules ? [(s.rules.experienceGap?.dock ?? 0) > 0 || s.rules.seniorityStretch ? "Yes" : "No"] : []),
  },
  {
    key: "degree",
    label: "Degree requirement",
    scorable: true,
    values: (s) => one(degreeBucketOf(s)),
  },
  {
    key: "hardGate",
    label: "Hard gate fired",
    scorable: false,
    values: (s) => (s.score ? [(s.score.scoreDisplay?.hardGates?.length ?? 0) > 0 ? "Yes" : "No"] : []),
  },
  { key: "salary", label: "Posted salary midpoint", scorable: true, values: (s) => one(salaryOf(s)) },
  { key: "channel", label: "Where the posting lives", scorable: true, values: (s) => one(channelOf(s.postingUrl ?? s.extracted?.url)) },
  { key: "postingAge", label: "Posting age when applied", scorable: false, values: (s) => one(postingAgeOf(s)) },
  {
    key: "weekday",
    label: "Day applied",
    scorable: false,
    values: (s) => {
      const d = s.appliedAt ? etDay(s.appliedAt) : null;
      if (d == null || d < 0) return [];
      return [d === 0 || d === 6 ? "Weekend" : d === 1 ? "Monday" : d === 5 ? "Friday" : "Tue-Thu"];
    },
  },
];

export const featureByKey = new Map(FEATURES.map((f) => [f.key, f]));
