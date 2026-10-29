import {
  CLEARANCE_REQUIRES_EXISTING_SURV_PENALTY,
  HIGH_OWNERSHIP_LOW_SUPPORT_SURV_PENALTY,
  SURVIVABILITY_TUNING,
  SURVIVABILITY_WEIGHTS,
  type SurvivabilitySubFactorKey,
} from "../config/capabilitySurvivabilityPolicy.js";
import {
  PRODUCTION_INFRA_OWNERSHIP_SURV_PENALTY,
} from "./namedCapabilityRiskPenalty.js";
import type { ExtractedJobData } from "../types/job.js";
import type { RuleEvaluation, ScoreBreakdown } from "../types/scoring.js";
import type { UserProfile } from "../types/userProfile.js";
import { applyCertificationBoost, type CertificationBoostMeta } from "./certificationBoost.js";
import {
  isHardStructuredDegreeGate,
  profileHasAssociateDegree,
  profileHasBootcampCert,
  profileHasPortfolio,
} from "./degreeEquivalency.js";
import { computePoolFriendliness, type PoolFriendlinessMeta } from "./poolFriendliness.js";
import { normalizeText } from "./text.js";

export type SurvivabilityBreakdown = Record<SurvivabilitySubFactorKey, number> & {
  weightedAverage: number;
  multiplier: number;
  certificationBoost?: CertificationBoostMeta;
  poolFriendlinessMeta?: PoolFriendlinessMeta;
};

/** Fixed precision before threshold compares (avoids 0.1-style binary accumulation noise). */
export const roundSurvivabilityScalar = (
  n: number,
  decimals: number = SURVIVABILITY_TUNING.decimalPlaces,
): number => {
  const factor = 10 ** decimals;
  return Math.round(n * factor) / factor;
};

export const toPersistedSurvivabilityBreakdown = (
  breakdown: SurvivabilityBreakdown,
): Record<string, number> => ({
  employerRecognizability: breakdown.employerRecognizability,
  credentialSignal: breakdown.credentialSignal,
  impactMetricQuality: breakdown.impactMetricQuality,
  resumeStoryCoherence: breakdown.resumeStoryCoherence,
  domainMatchForListing: breakdown.domainMatchForListing,
  poolFriendliness: breakdown.poolFriendliness,
  weightedAverage: breakdown.weightedAverage,
  multiplier: breakdown.multiplier,
});

export const hydrateSurvivabilityBreakdown = (
  score: Pick<ScoreBreakdown, "survivabilityBreakdown" | "survivability" | "certificationBoost">,
): SurvivabilityBreakdown | undefined => {
  const raw = score.survivabilityBreakdown;
  if (!raw) return undefined;

  return {
    employerRecognizability: raw.employerRecognizability ?? 0,
    credentialSignal: raw.credentialSignal ?? 0,
    impactMetricQuality: raw.impactMetricQuality ?? 0,
    resumeStoryCoherence: raw.resumeStoryCoherence ?? 0,
    domainMatchForListing: raw.domainMatchForListing ?? 0,
    poolFriendliness: raw.poolFriendliness ?? 0,
    weightedAverage: raw.weightedAverage ?? score.survivability ?? 0,
    multiplier: raw.multiplier ?? score.survivability ?? 0,
    certificationBoost: score.certificationBoost,
  };
};

const KNOWN_EMPLOYER_FT =
  /\b(full[-\s]?time|software engineer|engineer)\b[^.\n]{0,120}\b(google|meta|amazon|microsoft|apple|netflix|stripe|spotify|uber|airbnb|salesforce|databricks|openai|anthropic)\b/i;

const clamp01 = (n: number): number => Math.min(1, Math.max(0, n));

const jobBlob = (job: ExtractedJobData): string =>
  normalizeText(
    [
      job.company,
      job.title,
      job.rawText ?? "",
      ...(job.domainTags ?? []),
      ...(job.requirements ?? []),
      ...(job.responsibilities ?? []),
    ].join("\n"),
  );

function profileHasCsDegree(profile: UserProfile): boolean {
  if (!profile.degreeStatus.hasBachelors) return false;
  const blob = normalizeText(
    [profile.degreeStatus.note, profile.training?.program ?? "", profile.headline].join(" "),
  );
  return /\b(computer science|comp sci|cs degree|b\.?s\.?\s*(in\s*)?cs)\b/i.test(blob);
}

export const scoreEmployerRecognizability = (resumeText: string): number => {
  const t = normalizeText(resumeText);
  if (KNOWN_EMPLOYER_FT.test(t)) return 0.95;
  if (/\b(full[-\s]?time|fte)\b/i.test(t) && /\b(inc\.|corp|corporation)\b/i.test(t)) return 0.75;
  if (/\b(residency|resident engineer|fellowship|cohort program|open[-\s]?source product residency)\b/i.test(t)) {
    return 0.38;
  }
  if (/\b(contract|contractor|consulting|staff aug)\b/i.test(t)) return 0.28;
  return 0.32;
};

export const scoreCredentialSignal = (
  profile: UserProfile,
  rules: RuleEvaluation,
  params?: { extracted?: ExtractedJobData; resumeText?: string },
): number => {
  const densePool =
    Boolean(rules.productionBarCompetitivePool) ||
    Boolean(rules.matureStructuredEmployer && !rules.degreeHasEquivalencyClause) ||
    (rules.explicitDegreeRisk && !rules.degreeEquivalencySatisfied);

  const associateBaseline = (pool: boolean): number => (pool ? 0.38 : 0.52);
  const bootcampBaseline = (pool: boolean): number => (pool ? 0.4 : 0.58);

  if (
    params?.extracted &&
    rules.jdDegreePositive &&
    profileHasPortfolio(profile, params.resumeText) &&
    !isHardStructuredDegreeGate(rules)
  ) {
    let baseline = densePool ? 0.32 : 0.5;
    if (profileHasAssociateDegree(profile)) baseline = associateBaseline(densePool);
    else if (
      profile.training?.program &&
      /\b(bootcamp|immersive|residency|fellowship)\b/i.test(profile.training.program)
    ) {
      baseline = bootcampBaseline(densePool);
    }
    return Math.min(0.75, baseline + 0.15);
  }

  if (rules.degreeEquivalencySatisfied) {
    if (profileHasCsDegree(profile)) return 0.95;
    if (profileHasAssociateDegree(profile) || profileHasBootcampCert(profile)) {
      return densePool ? 0.68 : 0.78;
    }
    return densePool ? 0.62 : 0.72;
  }
  if (profileHasCsDegree(profile)) return 0.95;
  if (profile.degreeStatus.hasBachelors && !densePool) return 0.72;
  if (rules.degreeHasEquivalencyClause) {
    if (/\b(associate of arts|associate(?:'?s)?\s+degree|associate'?s)\b/i.test(profile.degreeStatus.note)) {
      return densePool ? 0.48 : 0.58;
    }
    if (profile.training?.program && /\b(bootcamp|immersive|residency|fellowship)\b/i.test(profile.training.program)) {
      return densePool ? 0.5 : 0.62;
    }
    return densePool ? 0.55 : 0.65;
  }
  if (/\b(associate of arts|associate(?:'?s)?\s+degree|associate'?s)\b/i.test(profile.degreeStatus.note)) {
    return densePool ? 0.38 : 0.52;
  }
  if (profile.training?.program && /\b(bootcamp|immersive|residency|fellowship)\b/i.test(profile.training.program)) {
    return densePool ? 0.4 : 0.58;
  }
  return densePool ? 0.32 : 0.5;
};

export const scoreImpactMetricQuality = (resumeText: string): number => {
  const t = normalizeText(resumeText);
  // Honest hedges (~30%, "(est.)") are NOT weak markers: \b before "~" never matched
  // anyway, so "~30% (est.)" never fired; keeping them out of weak is intentional —
  // early-career hedged metrics must not score identically to "no metric / pilot only."
  const weak =
    /\b(\d+\+\s+internal|10\+ internal|small[-\s]?scale|pilot)\b/i.test(t);
  const strong =
    /\b(\d{1,3}[mMbBkK]\+?\s+(users|customers|requests|transactions)|million|billion|\d{2,3}%[^~]{0,20}(increase|reduction|growth|improvement))\b/i.test(
      t,
    );
  if (strong && !weak) return 0.88;
  if (strong && weak) return 0.62;
  if (weak) return 0.32;
  return 0.52;
};

export const scoreResumeStoryCoherence = (
  resumeText: string,
  rawScore: ScoreBreakdown,
): number => {
  const t = normalizeText(resumeText);
  const llmNorm = rawScore.resumeStoryClarity / 10;
  let penalty = 0;
  if (/\b(residency|contract|contractor)\b/i.test(t)) penalty += 0.22;
  if (/\b(internal tools|internal users|internal web)\b/i.test(t)) penalty += 0.08;
  if (!/\bfull[-\s]?time\b/i.test(t)) penalty += 0.12;
  return clamp01(llmNorm * 0.55 + (1 - penalty) * 0.45);
};

export const scoreDomainMatchForListing = (
  job: ExtractedJobData,
  resumeText: string,
  rules: RuleEvaluation,
  rawScore: ScoreBreakdown,
): number => {
  const blob = jobBlob(job);
  const resume = normalizeText(resumeText);
  if (rules.domainMismatch) return 0.18;
  // Healthcare product SWE roles are in-lane for this candidate profile; keyword docks
  // (ehr/hipaa/clinical without resume domain words) must not flatten domainMatch to 0.32.
  if (rules.healthcareProductEngineering) {
    return clamp01((rawScore.domainFit / 10) * 0.65 + 0.2);
  }
  const domainSpecificBlob = blob.replace(
    /[^\n]*\b(a plus|preferred|nice[- ]to[- ]have|considered a plus)[^\n]*/gi,
    " ",
  );
  const domainSpecific =
    /\b(ehr|hipaa|clinical|healthcare compliance|medical records|phi|fda|gaap|asc\s*606|payments compliance)\b/i.test(
      domainSpecificBlob,
    );
  const profileDomain = /\b(ehr|hipaa|clinical|healthcare|gaap|payments|fintech)\b/i.test(resume);
  if (domainSpecific && !profileDomain) return 0.32;
  return clamp01((rawScore.domainFit / 10) * 0.65 + 0.2);
};

export { scorePoolFriendliness } from "./poolFriendliness.js";

const PORTFOLIO_ASK_RE =
  /\b(personal\s+projects?|side\s+projects?|open[\s-]?source\s+contributions?|contribut\w*\s+to\s+open[\s-]?source|github\s+profile|link\s+to\s+your\s+github|portfolio\s+of\s+(?:your\s+)?(?:work|projects?))\b/i;

/** Employer and credential signals can't drop below this when the listing screens on portfolio evidence. */
export const PORTFOLIO_FORWARD_SIGNAL_FLOOR = 0.6;

/**
 * The listing explicitly asks for personal projects or open source, and the candidate has them:
 * the screen leans on that evidence, so employer brand and credentials weigh less.
 */
export const isPortfolioForwardMatch = (job: ExtractedJobData, profile: UserProfile, resumeText: string): boolean =>
  PORTFOLIO_ASK_RE.test(jobBlob(job)) && profileHasPortfolio(profile, resumeText);

export const computeSurvivability = (params: {
  extracted: ExtractedJobData;
  rules: RuleEvaluation;
  profile: UserProfile;
  rawScore: ScoreBreakdown;
  resumeText?: string;
}): SurvivabilityBreakdown => {
  const resumeText = params.resumeText ?? "";

  const baseCredentialSignal = scoreCredentialSignal(params.profile, params.rules, {
    extracted: params.extracted,
    resumeText,
  });
  const credentialBoost = applyCertificationBoost(
    baseCredentialSignal,
    params.profile,
    params.extracted,
  );

  const poolMeta = computePoolFriendliness(params.extracted, params.profile);
  const portfolioFloor = isPortfolioForwardMatch(params.extracted, params.profile, resumeText)
    ? PORTFOLIO_FORWARD_SIGNAL_FLOOR
    : 0;

  const subFactors: Record<SurvivabilitySubFactorKey, number> = {
    employerRecognizability: Math.max(portfolioFloor, scoreEmployerRecognizability(resumeText)),
    credentialSignal: Math.max(portfolioFloor, credentialBoost.score),
    impactMetricQuality: scoreImpactMetricQuality(resumeText),
    resumeStoryCoherence: scoreResumeStoryCoherence(resumeText, params.rawScore),
    domainMatchForListing: scoreDomainMatchForListing(
      params.extracted,
      resumeText,
      params.rules,
      params.rawScore,
    ),
    poolFriendliness: poolMeta.score,
  };

  let weightedAverage = 0;
  for (const [key, weight] of Object.entries(SURVIVABILITY_WEIGHTS) as Array<
    [SurvivabilitySubFactorKey, number]
  >) {
    weightedAverage += subFactors[key] * weight;
  }

  if (params.rules.clearanceRequiresExistingPenalty) {
    weightedAverage -= CLEARANCE_REQUIRES_EXISTING_SURV_PENALTY;
  }

  if (params.rules.highOwnershipLowSupport) {
    weightedAverage -= HIGH_OWNERSHIP_LOW_SUPPORT_SURV_PENALTY;
  }

  if (params.rules.productionInfraOwnershipGap) {
    weightedAverage -= PRODUCTION_INFRA_OWNERSHIP_SURV_PENALTY;
  }

  if (
    params.rules.jdDegreePositive &&
    profileHasPortfolio(params.profile, resumeText) &&
    !isHardStructuredDegreeGate(params.rules)
  ) {
    weightedAverage = Math.min(1, weightedAverage + 0.03);
  }

  weightedAverage = roundSurvivabilityScalar(weightedAverage);
  const multiplier = roundSurvivabilityScalar(
    Math.min(1, Math.max(SURVIVABILITY_TUNING.floor, weightedAverage)),
  );

  return {
    ...subFactors,
    weightedAverage,
    multiplier,
    certificationBoost: credentialBoost.boost,
    poolFriendlinessMeta: poolMeta,
  };
};
