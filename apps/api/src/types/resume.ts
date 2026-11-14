export const RESUME_TYPES = ["BASE", "AI", "FDE"] as const;
export type ResumeType = (typeof RESUME_TYPES)[number];

/** Resume variants retired on 2026-10-01; still present on older stored jobs. */
export const LEGACY_RESUME_TYPES = ["SWE", "SIE", "EARLY_CAREER"] as const;
export type LegacyResumeType = (typeof LEGACY_RESUME_TYPES)[number];

export type StoredResumeType = ResumeType | LegacyResumeType;

export const isActiveResumeType = (value: unknown): value is ResumeType =>
  typeof value === "string" && (RESUME_TYPES as readonly string[]).includes(value);

/** Legacy variants have no resume file anymore; score them against BASE. */
export const toActiveResumeType = (value: StoredResumeType | undefined | null): ResumeType =>
  isActiveResumeType(value) ? value : "BASE";

export type ResumeProfile = {
  type: ResumeType;
  label: string;
  bestFor: string[];
  avoidFor: string[];
  summaryStyle: string;
  emphasisKeywords: string[];
  exampleRationale: string[];
};

export type ResumeSelection = {
  recommendedResume: ResumeType;
  confidence: number;
  rationale: string[];
};
