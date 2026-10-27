import { RECOMMENDATION_LABELS } from "../../config/capabilitySurvivabilityPolicy.js";
import { recommendationForScore } from "../../lib/compositeScoring.js";
import { MAX_POINTS_PER_ADJUSTMENT } from "../../lib/historyAdjustments.js";
import { RECOMMENDATIONS } from "../../types/scoring.js";
import type { InsightRow, UnscoredReason } from "./dataset.js";
import {
  DEGREE_BUCKETS,
  FEATURES,
  SENIORITY_BUCKETS,
  degreeBucketOf,
  isSpecializedAiFde,
  screeningSeniority,
  type Feature,
} from "./features.js";
import { auc, aucPermutationP, benjaminiHochberg, fisherExact, wilson, type Interval } from "./stats.js";

/** Smallest group compared at all, and the size a pattern needs before it can be called. */
export const MIN_SHOWN = 8;
export const MIN_CALLABLE = 15;
/** Positives (or, for a low-response group, expected positives) needed before a pattern can be called. */
export const MIN_POSITIVES = 4;
export const MIN_DIFF_PP = 10;
export const CONCLUSIVE_Q = 0.05;
export const SUGGESTIVE_Q = 0.2;
export const GOOD_FIT = 65;

export type Verdict = "conclusive" | "suggestive" | "no_signal";

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
  /** Decided rows that have no value for this feature. */
  unknownN: number;
};

export type ScoreBand = { band: string; k: number; n: number; rate: Interval };

export type ProposedAdjustment = {
  id: string;
  feature: string;
  featureLabel: string;
  bucket: string;
  points: number;
  evidence: { k: number; n: number; rate: number; restRate: number; diffPp: number; q: number };
};

export type CoverageCounts = {
  applications: number;
  positive: number;
  negative: number;
  tooEarly: number;
  decided: number;
  withFit: number;
  withoutFit: number;
  scoredCallbacks: number;
  unscoredCallbacks: number;
  confirmedApplied: number;
  inferredApplied: number;
  unscoredReasons: Partial<Record<UnscoredReason, number>>;
};

export type ScreeningCell = { bucket: string; k: number; n: number; rate: Interval };

export type ScreeningCross = { seniority: string; degree: string; k: number; n: number; rate: Interval };

export type ScreeningAnalysis = {
  seniority: ScreeningCell[];
  seniorityUnknown: number;
  degree: ScreeningCell[];
  degreeUnknown: number;
  specialized: { k: number; n: number; rate: Interval; restK: number; restN: number };
  specializedUnknown: number;
  bySeniorityAndDegree: ScreeningCross[];
};

export type InsightsAnalysis = {
  generatedAt: string;
  counts: CoverageCounts;
  baseRate: Interval & { k: number; n: number };
  scoreBands: ScoreBand[];
  scorePredicts: { auc: number; p: number; n: number; k: number; rate: Interval; verdict: Verdict; note: string };
  screening: ScreeningAnalysis;
  patterns: PatternRow[];
  goodFit: { k: number; n: number; rate: Interval; patterns: PatternRow[] };
  proposals: ProposedAdjustment[];
  conclusion: Verdict;
  headline: string;
};

const pct = (x: number) => `${(x * 100).toFixed(x > 0 && x < 0.1 ? 1 : 0)}%`;

export const VERDICT_WORDS: Record<Verdict, string> = {
  conclusive: "conclusive",
  suggestive: "worth watching",
  no_signal: "no signal",
};

const verdictFor = (row: Omit<PatternRow, "verdict" | "q">, q: number, baseRate: number): Verdict => {
  const big = row.n >= MIN_CALLABLE && row.restN >= MIN_CALLABLE;
  const higher = row.rate.rate > row.restRate;
  const enoughPositives = higher ? row.k >= MIN_POSITIVES : row.n * baseRate >= MIN_POSITIVES;
  if (!big || !enoughPositives || Math.abs(row.diffPp) < MIN_DIFF_PP) return "no_signal";
  if (q < CONCLUSIVE_Q) return "conclusive";
  if (q < SUGGESTIVE_Q) return "suggestive";
  return "no_signal";
};

/** Every feature bucket vs the rest of the rows that have that feature, with multiple-comparison control. */
export const comparePatterns = (rows: InsightRow[], features: Feature[] = FEATURES): PatternRow[] => {
  const decided = rows.filter((r) => r.outcome !== "too_early");
  const k0 = decided.filter((r) => r.outcome === "positive").length;
  const baseRate = decided.length ? k0 / decided.length : 0;
  const raw: Array<Omit<PatternRow, "verdict" | "q">> = [];
  for (const f of features) {
    const tagged = decided.map((r) => ({ r, values: f.values(r) })).filter((x) => x.values.length > 0);
    const buckets = new Set(tagged.flatMap((x) => x.values));
    for (const bucket of buckets) {
      const inB = tagged.filter((x) => x.values.includes(bucket));
      const rest = tagged.filter((x) => !x.values.includes(bucket));
      if (inB.length < MIN_SHOWN || rest.length < MIN_SHOWN) continue;
      const k = inB.filter((x) => x.r.outcome === "positive").length;
      const restK = rest.filter((x) => x.r.outcome === "positive").length;
      const rate = wilson(k, inB.length);
      const restRate = restK / rest.length;
      raw.push({
        feature: f.key,
        featureLabel: f.label,
        bucket,
        scorable: f.scorable,
        k,
        n: inB.length,
        rate,
        restK,
        restN: rest.length,
        restRate,
        diffPp: Math.round((rate.rate - restRate) * 1000) / 10,
        p: fisherExact(k, inB.length - k, restK, rest.length - restK),
        unknownN: decided.length - tagged.length,
      });
    }
  }
  const q = benjaminiHochberg(raw.map((r) => r.p));
  return raw
    .map((r, i) => ({ ...r, q: q[i]!, verdict: verdictFor(r, q[i]!, baseRate) }))
    .sort((a, b) => a.q - b.q || Math.abs(b.diffPp) - Math.abs(a.diffPp));
};

const pointsFor = (diffPp: number) =>
  Math.sign(diffPp) * Math.min(MAX_POINTS_PER_ADJUSTMENT, Math.max(1, Math.round(Math.abs(diffPp) / 5)));

const headlineFor = (a: Omit<InsightsAnalysis, "headline" | "conclusion">): string => {
  if (a.baseRate.n === 0) return "No decided applications yet.";
  const base = `${a.baseRate.k} of ${a.baseRate.n} decided applications led to a call or interview (${pct(a.baseRate.rate)}).`;
  const score =
    a.scorePredicts.verdict === "no_signal"
      ? ""
      : " Higher fit scores are associated with more callbacks, but the small number of outcomes limits confidence.";
  const all = [...a.patterns, ...a.goodFit.patterns];
  const clear = all.find((p) => p.verdict === "conclusive");
  if (clear) {
    return `${base}${score} One named test stands out: ${clear.featureLabel} = ${clear.bucket} (${pct(clear.rate.rate)} vs ${pct(clear.restRate)}).`;
  }
  if (all.some((p) => p.verdict === "suggestive")) {
    return `${base}${score} Some patterns are worth watching, but none meets the conclusive threshold.`;
  }
  return score
    ? `${base}${score} Beyond the score, no trait stands out from chance.`
    : `${base} No pattern stands out from chance: callbacks look mostly random with respect to everything measured.`;
};

const tally = <T extends string>(rows: InsightRow[], of: (r: InsightRow) => T | null): { cells: ScreeningCell[]; unknown: number } => {
  const decided = rows.filter((r) => r.outcome !== "too_early");
  const counts = new Map<T, { k: number; n: number }>();
  let unknown = 0;
  for (const r of decided) {
    const bucket = of(r);
    if (!bucket) {
      unknown += 1;
      continue;
    }
    const cur = counts.get(bucket) ?? { k: 0, n: 0 };
    counts.set(bucket, { k: cur.k + (r.outcome === "positive" ? 1 : 0), n: cur.n + 1 });
  }
  return {
    cells: [...counts.entries()].map(([bucket, { k, n }]) => ({ bucket, k, n, rate: wilson(k, n) })),
    unknown,
  };
};

const buildScreening = (rows: InsightRow[]): ScreeningAnalysis => {
  const decided = rows.filter((r) => r.outcome !== "too_early");
  const seniorityTally = tally(rows, screeningSeniority);
  const degreeTally = tally(rows, degreeBucketOf);
  const seniority = SENIORITY_BUCKETS.map((bucket) => seniorityTally.cells.find((c) => c.bucket === bucket) ?? { bucket, k: 0, n: 0, rate: wilson(0, 0) });
  const degree = DEGREE_BUCKETS.map((bucket) => degreeTally.cells.find((c) => c.bucket === bucket) ?? { bucket, k: 0, n: 0, rate: wilson(0, 0) });

  const bySeniorityAndDegree: ScreeningCross[] = [];
  for (const sen of SENIORITY_BUCKETS) {
    for (const deg of DEGREE_BUCKETS) {
      const inCell = decided.filter((r) => screeningSeniority(r) === sen && degreeBucketOf(r) === deg);
      const k = inCell.filter((r) => r.outcome === "positive").length;
      bySeniorityAndDegree.push({ seniority: sen, degree: deg, k, n: inCell.length, rate: wilson(k, inCell.length) });
    }
  }

  let specializedUnknown = 0;
  const specializedRows: InsightRow[] = [];
  const restRows: InsightRow[] = [];
  for (const r of decided) {
    const flag = isSpecializedAiFde(r);
    if (flag == null) specializedUnknown += 1;
    else if (flag) specializedRows.push(r);
    else restRows.push(r);
  }
  const specK = specializedRows.filter((r) => r.outcome === "positive").length;
  return {
    seniority,
    seniorityUnknown: seniorityTally.unknown,
    degree,
    degreeUnknown: degreeTally.unknown,
    specialized: {
      k: specK,
      n: specializedRows.length,
      rate: wilson(specK, specializedRows.length),
      restK: restRows.filter((r) => r.outcome === "positive").length,
      restN: restRows.length,
    },
    specializedUnknown,
    bySeniorityAndDegree,
  };
};

const strongest = (verdicts: Verdict[]): Verdict =>
  verdicts.includes("conclusive") ? "conclusive" : verdicts.includes("suggestive") ? "suggestive" : "no_signal";

export const analyzeInsights = (rows: InsightRow[], now = new Date()): InsightsAnalysis => {
  const decided = rows.filter((r) => r.outcome !== "too_early");
  const positive = decided.filter((r) => r.outcome === "positive").length;
  const withFit = decided.filter((r) => r.fit != null);

  const scoreBands: ScoreBand[] = RECOMMENDATIONS.map((rec) => {
    const inBand = withFit.filter((r) => recommendationForScore(r.fit!) === rec);
    const k = inBand.filter((r) => r.outcome === "positive").length;
    return { band: RECOMMENDATION_LABELS[rec], k, n: inBand.length, rate: wilson(k, inBand.length) };
  });

  const scores = withFit.map((r) => r.fit!);
  const labels = withFit.map((r) => r.outcome === "positive");
  const fitPositives = labels.filter(Boolean).length;
  const aucValue = auc(scores, labels);
  const aucP = fitPositives >= MIN_POSITIVES && fitPositives < labels.length ? aucPermutationP(scores, labels) : 1;
  const scoreVerdict: Verdict =
    fitPositives < MIN_POSITIVES ? "no_signal" : aucP < CONCLUSIVE_Q ? "conclusive" : aucP < SUGGESTIVE_Q ? "suggestive" : "no_signal";
  const scoredRate = wilson(fitPositives, withFit.length);
  const scoreNote =
    scoreVerdict === "no_signal"
      ? `The score doesn't separate callbacks from silence better than chance (AUC ${aucValue.toFixed(2)}; ${fitPositives} callbacks among ${withFit.length} scored).`
      : `Higher fit scores are associated with more callbacks (AUC ${aucValue.toFixed(2)}; ${fitPositives} of ${withFit.length} scored, 95% range ${pct(scoredRate.lo)}–${pct(scoredRate.hi)}). The observed pattern is promising, but the small number of positive outcomes limits confidence in its magnitude and stability.`;

  const patterns = comparePatterns(rows);
  const good = rows.filter((r) => r.fit != null && r.fit >= GOOD_FIT);
  const goodDecided = good.filter((r) => r.outcome !== "too_early");
  const goodK = goodDecided.filter((r) => r.outcome === "positive").length;
  const goodPatterns = comparePatterns(good, FEATURES.filter((f) => f.key !== "tier"));

  const proposals: ProposedAdjustment[] = patterns
    .filter((p) => p.verdict === "conclusive" && p.scorable)
    .map((p) => ({
      id: `${p.feature}=${p.bucket}`,
      feature: p.feature,
      featureLabel: p.featureLabel,
      bucket: p.bucket,
      points: pointsFor(p.diffPp),
      evidence: { k: p.k, n: p.n, rate: p.rate.rate, restRate: p.restRate, diffPp: p.diffPp, q: p.q },
    }));

  const unscoredReasons: CoverageCounts["unscoredReasons"] = {};
  for (const r of decided.filter((item) => item.fit == null)) {
    const reason = r.unscoredReason ?? "no_jd";
    unscoredReasons[reason] = (unscoredReasons[reason] ?? 0) + 1;
  }

  const partial = {
    generatedAt: now.toISOString(),
    counts: {
      applications: rows.length,
      positive,
      negative: decided.length - positive,
      tooEarly: rows.length - decided.length,
      decided: decided.length,
      withFit: withFit.length,
      withoutFit: decided.length - withFit.length,
      scoredCallbacks: withFit.filter((r) => r.outcome === "positive").length,
      unscoredCallbacks: decided.filter((r) => r.outcome === "positive" && r.fit == null).length,
      confirmedApplied: decided.filter((r) => r.applyEvidence === "confirmed").length,
      inferredApplied: decided.filter((r) => r.applyEvidence === "inferred").length,
      unscoredReasons,
    },
    baseRate: { ...wilson(positive, decided.length), k: positive, n: decided.length },
    scoreBands,
    scorePredicts: {
      auc: aucValue,
      p: aucP,
      n: withFit.length,
      k: fitPositives,
      rate: scoredRate,
      verdict: scoreVerdict,
      note: scoreNote,
    },
    screening: buildScreening(rows),
    patterns,
    goodFit: { k: goodK, n: goodDecided.length, rate: wilson(goodK, goodDecided.length), patterns: goodPatterns },
    proposals,
  };
  const conclusion = strongest([scoreVerdict, ...patterns.map((p) => p.verdict), ...goodPatterns.map((p) => p.verdict)]);
  return { ...partial, conclusion, headline: headlineFor(partial) };
};
