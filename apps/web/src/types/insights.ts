export type Verdict = "conclusive" | "suggestive" | "no_signal";

export type Interval = { rate: number; lo: number; hi: number };

export type PatternRow = {
  feature: string;
  featureLabel: string;
  bucket: string;
  scorable: boolean;
  k: number;
  n: number;
  rate: Interval;
  restK: number;
  restN: number;
  restRate: number;
  diffPp: number;
  p: number;
  q: number;
  verdict: Verdict;
  unknownN?: number;
};

export type ProposedAdjustment = {
  id: string;
  feature: string;
  featureLabel: string;
  bucket: string;
  points: number;
  evidence: { k: number; n: number; rate: number; restRate: number; diffPp: number; q: number };
};

export type AdjustmentStatus = "proposed" | "approved" | "dismissed" | "disabled" | "withdrawn";

export type ScoringAdjustment = ProposedAdjustment & {
  status: AdjustmentStatus;
  createdAt: string;
  updatedAt: string;
  approvedAt?: string;
};

export type UnscoredReason =
  | "not_found"
  | "fetch_failed"
  | "unverified"
  | "triage_failed"
  | "tracker_never_scored"
  | "no_jd";

export type CoverageCounts = {
  applications: number;
  positive: number;
  negative: number;
  tooEarly: number;
  decided: number;
  withFit: number;
  withoutFit?: number;
  scoredCallbacks?: number;
  unscoredCallbacks?: number;
  confirmedApplied?: number;
  inferredApplied?: number;
  unscoredReasons?: Partial<Record<UnscoredReason, number>>;
};

export type ScreeningCell = { bucket: string; k: number; n: number; rate: Interval };

export type ScreeningCross = { seniority: string; degree: string; k: number; n: number; rate: Interval };

export type ScreeningAnalysis = {
  seniority?: ScreeningCell[];
  seniorityUnknown?: number;
  degree?: ScreeningCell[];
  degreeUnknown?: number;
  specialized?: { k: number; n: number; rate: Interval; restK: number; restN: number };
  specializedUnknown?: number;
  bySeniorityAndDegree?: ScreeningCross[];
};

export type InsightsRun = {
  id: string;
  trigger: "weekly" | "manual";
  generatedAt: string;
  summary?: string;
  counts: CoverageCounts;
  baseRate: Interval & { k: number; n: number };
  scoreBands: Array<{ band: string; k: number; n: number; rate: Interval }>;
  scorePredicts: { auc: number; p: number; n: number; k?: number; rate?: Interval; verdict: Verdict; note: string };
  screening?: ScreeningAnalysis;
  patterns: PatternRow[];
  goodFit: { k: number; n: number; rate: Interval; patterns: PatternRow[] };
  proposals: ProposedAdjustment[];
  conclusion: Verdict;
  headline: string;
  quietGoodFits: Array<{ id: string; company: string; role: string | null; fit: number; appliedAt: string | null }>;
};

export type InsightsPanel = {
  run: InsightsRun | null;
  adjustments: ScoringAdjustment[];
  budget: { monthlyUsd: number; spentThisMonthUsd: number };
  running: boolean;
};
