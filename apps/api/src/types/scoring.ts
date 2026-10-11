import type { CertificationBoostMeta } from "../lib/certificationBoost.js";

/** Score-tier recommendation — derived only from the final score. */
export type Recommendation = "strong_apply" | "apply" | "stretch" | "weak";

export const RECOMMENDATIONS = ["strong_apply", "apply", "stretch", "weak"] as const satisfies readonly Recommendation[];

/** Values persisted before the score-tier model; normalized on read. */
export const LEGACY_RECOMMENDATIONS = [
  "apply_cold",
  "referral_gated",
  "stretch_signal",
  "skip",
  "no",
  "yes",
  "selective_yes",
] as const;

/** Tone bands for generated assets (cover letter / why-company). */
export type LegacyRecommendation = "yes" | "selective_yes" | "no";

export type HardRuleFlag = {
  id: string;
  message: string;
  /** Structured language citation — must be validated against JD language set. */
  citedLanguages?: string[];
};

export type CapabilityGap = {
  kind: "specialization" | "stack_depth";
  reason: string;
};

export type SpecializationGapLever = "none" | "portfolio" | "upskill" | "resume";

/** Where in the JD a skill tag was sourced — drives penalty eligibility. */
export type TagSourceStrength = "REQUIRED" | "PREFERRED" | "NARRATIVE";

export type ExtractedSkillTag = {
  term: string;
  sourceQuote: string;
  strength: TagSourceStrength;
};

export type SpecializationGapKind = "backend_stack" | "design_portfolio" | "enterprise_iam";

export type SpecializationGapSeverity = "central" | "moderate" | "minor";

/** Structured missing-pillar gap — visible to lever logic and recommendation guards. */
export type SpecializationGap = {
  kind: SpecializationGapKind;
  name: string;
  evidence: string;
  severity: SpecializationGapSeverity;
  lever: SpecializationGapLever;
  /** Points docked from the additive final composite. */
  dock: number;
  /** JD-derived pillar label (e.g. Python/Django). */
  jdSide?: string;
  /** Candidate resume primary label (e.g. Node). */
  resumeSide?: string;
};

/** LLM-scored transparency dimensions (not composite axes). */
export type LegacyScoreDimension =
  | "stackFit"
  | "levelFit"
  | "domainFit"
  | "resumeStoryClarity"
  | "functionalOverlap"
  | "recruiterFriendliness"
  | "careerValue";

export type SurvivabilityLever =
  | "referral"
  | "resume"
  | "cover_letter"
  | "credential"
  | "none"
  | "none_in_loop"
  | "portfolio"
  | "upskill";

export type BindingnessTier = "binding" | "material" | "cosmetic" | "structural" | "favorable";

export type CapabilityBreakdown = {
  stackFit: number;
  levelFit: number;
  functionalOverlap: number;
};

export type SurvivabilityDisplayRow = {
  key: string;
  label: string;
  score: number;
  weight: number;
  contribution: number;
  lever: SurvivabilityLever;
  leverLabel: string;
  bindingness: BindingnessTier;
  penaltyName: string;
};

export type SurvivabilityPenalty = {
  message: string;
  lever: SurvivabilityLever;
  leverLabel: string;
};

export type StrategicLeverSelection = {
  key: string;
  lever: SurvivabilityLever;
  leverLabel: string;
  penaltyName: string;
  bindingness: BindingnessTier;
  strategicValue: number;
  isCollapsedReferral: boolean;
};

export type EligibilityFlag = {
  reason: string;
  evidence: string;
  lever: "verify";
  severity: "check";
};

export type ScoreBand = Recommendation;

export type BandHeadline = "Strong apply" | "Apply" | "Apply but weak (stretch)" | "Weak";

export type AdjacentRoleFunctionKind =
  | "implementation_analyst"
  | "business_systems_analyst"
  | "qa_engineer"
  | "solutions_engineer"
  | "technical_analyst"
  | "sales_engineer";

export type RoleLaneLabel =
  | "product_frontend"
  | "product_fullstack"
  | "product_backend"
  | "platform_infra"
  | "adjacent_non_engineering";

export type ScoreDisplay = {
  capability: number;
  capabilityBreakdown: CapabilityBreakdown;
  differentiatorCoverageNote?: string;
  roleFunctionCapNote?: string;
  survivability: number;
  final: number;
  survAdjustment: number;
  gapDock: number;
  scoreDerivation: string;
  scoreBand: ScoreBand;
  bandHeadline: BandHeadline;
  worthTailoring: boolean;
  survivabilityRows: SurvivabilityDisplayRow[];
  hardGates: string[];
  survivabilityPenalties: SurvivabilityPenalty[];
  dominantLever?: StrategicLeverSelection;
  actionLine: string;
  eligibilityAdvisory?: EligibilityFlag;
  eligibilityAdvisories?: EligibilityFlag[];
  /** Set when a listing-relevant cert boosts credentialSignal. */
  credentialBoostNote?: string;
  /** Listing-shape pool friendliness breakdown. */
  poolFriendlinessNote?: string;
  degreePositiveNote?: string;
  contractCaveat?: string;
  /** Employer restricts GenAI-generated application materials. */
  genAiRestrictionWarning?: string;
  /** Fresh niche post — submit default resume immediately. */
  applyNowUrgency?: boolean;
  applyNowUrgencyNote?: string;
};

export type ScoreBreakdown = {
  stackFit: number;
  levelFit: number;
  domainFit: number;
  resumeStoryClarity: number;
  functionalOverlap: number;
  recruiterFriendliness: number;
  careerValue: number;
  /** LLM category scores before deterministic clamps/docks — lets stored scores be replayed exactly. */
  llmCategories?: Pick<
    ScoreBreakdown,
    "stackFit" | "levelFit" | "domainFit" | "resumeStoryClarity" | "functionalOverlap" | "recruiterFriendliness" | "careerValue"
  >;
  /** Capability axis (stack + level + functional), 0–100. */
  capability?: number;
  capabilityBreakdown?: CapabilityBreakdown;
  /** Survivability multiplier, 0.30–1.00. */
  survivability?: number;
  survivabilityBreakdown?: Record<string, number>;
  /** Listing-relevant cert metadata — stored separately from numeric breakdown. */
  certificationBoost?: CertificationBoostMeta;
  /** UI-ready decomposition derived from capability + survivability composite model. */
  scoreDisplay?: ScoreDisplay;
  /** Human-readable band label (strong_apply / apply / skip). */
  recommendationLabel?: string;
  /** Final composite score (capability ± survivability adj − gap dock), 0–100. */
  total: number;
  /** Short note when differentiator coverage caps stack/functional credit. */
  differentiatorCoverageNote?: string;
  /** Short note when adjacent analyst/implementation role caps capability credit. */
  roleFunctionCapNote?: string;
  /** Degree-positive JD breakdown note for survivability display. */
  degreePositiveNote?: string;
  /** Contract employment caveat for report display. */
  contractCaveat?: string;
  /** Approved insights adjustments frozen in when this role was first scored; `total` already includes them. */
  historyAdjustments?: HistoryAdjustment[];
};

export type HistoryAdjustment = { id: string; label: string; points: number };

export type RuleEvaluation = {
  explicitDegreeRisk: boolean;
  traditionalCompanyPenalty: boolean;
  financePenalty: boolean;
  strictNewGradPipeline: boolean;
  earlyCareerFriendlyRole: boolean;
  /** Alias for strictNewGradPipeline (API stability). */
  newGradPenalty: boolean;
  seniorityOverreach: boolean;
  /** Title/label reads senior but the JD asks nothing beyond the profile — soft dock, no gate. */
  seniorityStretch?: boolean;
  /** Proportional dock for the JD's years range / mid-level label vs the candidate's years. */
  experienceGap?: { dock: number; reason: string };
  locationMismatch: boolean;
  visaMismatch: boolean;
  citizenshipMismatch: boolean;
  clearanceMismatch: boolean;
  stackMismatch: boolean;
  /** Required core languages missing from claimable stack (Tier 1). */
  coreLanguageGap?: string[];
  /** Same-language-family framework gaps, e.g. Vue required but React claimable (Tier 2). */
  adjacentFrameworkGap?: string[];
  /** Legacy infra/SRE shape signal — not the same as core-language stackMismatch. */
  infraStackShapeMismatch?: boolean;
  domainMismatch: boolean;
  startupFounderMismatch: boolean;
  /** Big-tech / enterprise-style org where explicit stack gates are usually strict. */
  matureStructuredEmployer?: boolean;
  /** Explicit production-language requirement in JD does not match profile; only set for mature employers. */
  explicitCoreLanguageMismatch?: boolean;
  /** When mismatch is set: `java` | `go` | `python`. */
  explicitCoreLanguage?: string | null;
  /**
   * Forward-deployed / growth-style title without strong external customer-delivery JD:
   * builder-first software engineering; calibrate scores down from inflated 90+ bands.
   */
  fdeBuilderSoftwarePrimary?: boolean;
  /** JD lists Python alongside JS/TS as acceptable — avoid Python-only hard stack framing. */
  pythonStackFlexibleWithJsTs?: boolean;
  /** Healthcare / clinical org but JD is product/full-stack software — do not treat as exotic domain mismatch. */
  healthcareProductEngineering?: boolean;
  /** Backend/product/API role where infra tools are supporting context, not platform-core work. */
  backendProductApiRole?: boolean;
  /** Platform/DevOps/SRE role where infra depth is core to the job shape. */
  infraCoreRole?: boolean;
  /**
   * Thin / generic JD + entry-level applied-AI posting at an unknown startup:
   * damp score inflation, cap recruiter/domain realism.
   */
  vagueEarlyStageAiCalibration?: boolean;
  /** Research-heavy AI role shape (publications/meta-learning/program synthesis/experimental track record). */
  researchHeavyAiRole?: boolean;
  /** Fintech/payments backend role with Go-primary or microservices-heavy production expectations. */
  fintechGoPrimaryStretch?: boolean;
  /** Founding/very-early startup role with high-autonomy ownership risk despite technical overlap. */
  foundingEngineerStretch?: boolean;
  /**
   * Title seniority vs responsibilities disagree by >1 band, or junior/1–2yr tagging
   * conflicts with industry-senior title / high-autonomy responsibilities.
   */
  titleResponsibilityMismatch?: boolean;
  /** High-autonomy JD with no mentorship language at a small early-stage org. */
  highOwnershipLowSupport?: boolean;
  /**
   * Same years bar restated across many independent required quals (4+) —
   * stricter Level-fit dock + dedicated Key Risk; stacks with title/responsibility mismatch.
   */
  reinforcedExperienceFloor?: boolean;
  reinforcedExperienceFloorLineCount?: number;
  reinforcedExperienceFloorThreshold?: number;
  /**
   * JD requires production-scale infra / observability / on-call ownership the profile lacks.
   * Must surface in Key Risks AND Survivability Penalties with a nonzero dock.
   */
  productionInfraOwnershipGap?: boolean;
  /**
   * Narrative Key Risk asserts role likely exceeds early-career exposure —
   * must dock levelFit; set when mismatch flag alone did not already cover it.
   */
  earlyCareerExceedSeverityRisk?: boolean;
  /** Scoring-pipeline inconsistency: severity risk prose present without a levelFit dock. */
  scoringRiskScoreInconsistency?: boolean;
  /**
   * JD requires a CS (or equivalent strict) degree plus multiple finance/accounting, publication,
   * or legacy-OOP gates the profile does not satisfy — generic SWE overlap must not dominate.
   */
  credentialHeavyFintechAlgorithm?: boolean;
  /**
   * JD implies 2+ yrs professional bar, production ownership / meaningful scope, and a competitive hiring
   * context — cap inflation from product/story overlap unless profile shows exact JD stack + production depth.
   */
  productionBarCompetitivePool?: boolean;
  /**
   * Go-first / distributed data-infrastructure role (streaming, warehouses, specialized stores).
   */
  goDistributedDataInfraRole?: boolean;
  /**
   * Candidate lacks demonstrated Go/streaming/warehouse production depth and role is not apprenticeship-oriented.
   */
  goDistributedDataInfraCandidateGap?: boolean;
  /** JD allows related/equivalent experience in lieu of a degree — softens credential penalty. */
  degreeHasEquivalencyClause?: boolean;
  /** Equivalency clause exists, but another line strictly requires a degree in a named field. */
  degreeConflictingRequirement?: boolean;
  /** Candidate satisfies an accepted alternate credential path when JD allows equivalency. */
  degreeEquivalencySatisfied?: boolean;
  /** Non-addressable capability/specialization gap (valid skip driver). */
  capabilityGap?: CapabilityGap;
  /** Structured specialization pillar gap (design/Figma, enterprise IAM, etc.). */
  specializationGap?: SpecializationGap;
  /** Soft geo/work-location advisory — does not affect score or band. */
  eligibilityFlag?: EligibilityFlag;
  /** Soft clearance sponsorship advisory — does not affect score or band. */
  clearanceEligibilityFlag?: EligibilityFlag;
  /** Hire-now clearance without strict hold-active language — survivability dock. */
  clearanceRequiresExistingPenalty?: boolean;
  /** Explicit unambiguous geographic exclusion (hard gate). */
  geoExclusionHardGate?: boolean;
  geoExclusionReason?: string;
  /**
   * True first-pass gates only (UI "Hard-rule flags"): commutable location, degree, explicit core language.
   * Visa/citizenship/clearance and other notes stay in `notes` / key risks.
   */
  hardRuleNotes?: string[];
  /** Post-clamp structural disqualifiers surfaced in UI (Rule 3+). */
  hardRuleFlags?: HardRuleFlag[];
  /** Infra/platform or ML-research role shape outside product SWE lane (Rule 2). */
  roleShapeOutsideLane?: boolean;
  /** Analyst / QA / implementation role outside core product-SWE lane. */
  adjacentRoleFunction?: boolean;
  /** Frontend-primary role: backend/API differentiator benched (consume, don't build). */
  frontendPrimaryRole?: boolean;
  /** Platform/infra/SRE role: engineer-facing platform; aws/backend/api edge not load-bearing. */
  platformInfraRole?: boolean;
  /** Unified Item G primary lane — preferred over re-deriving classifiers. */
  roleLane?: RoleLaneLabel;
  roleLaneKind?: AdjacentRoleFunctionKind | null;
  /** JD explicitly welcomes portfolio / experience over formal degree credentials. */
  jdDegreePositive?: boolean;
  /** JD prohibits GenAI-generated substantive application content. */
  jdProhibitsGenAI?: boolean;
  /** JD accepts any of a listed language set; candidate matches ≥1 — no core-language gate. */
  disjunctiveLanguageRequirementSatisfied?: boolean;
  disjunctiveAcceptedLanguages?: string[];
  /** Named product/platform from "must have experience with X" absent from candidate background. */
  namedHardRequirementGaps?: string[];
  notes: string[];
  penaltyVector?: Record<string, number>;
};

export type SalaryAsk = {
  number?: number;
  rangeMin?: number;
  rangeMax?: number;
};
