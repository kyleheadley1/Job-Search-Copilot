export type ResumeType = "BASE" | "AI" | "SWE" | "SIE" | "EARLY_CAREER";
export type Recommendation = "strong_apply" | "apply" | "stretch" | "weak";

export const RECOMMENDATION_LABELS: Record<Recommendation, string> = {
  strong_apply: "Strong apply",
  apply: "Apply",
  stretch: "Apply but weak (stretch)",
  weak: "Weak",
};
export type JobStatus =
  | "to_review"
  | "applied"
  | "skip"
  | "rejected"
  | "interviewing"
  | "assessment"
  | "closed"
  | "offer"
  | "lapsed";

export type ExtractedJobData = {
  company: string;
  title: string;
  url?: string;
  rawText?: string;
  location?: string;
  remoteType?: "remote" | "hybrid" | "onsite" | "unknown";
  employmentType?: string;
  seniority?: string;
  stack: string[];
  requiredSkills: string[];
  preferredSkills: string[];
  domainTags: string[];
  responsibilities: string[];
  requirements: string[];
  listingCompanyName?: string;
  employerCompanyName?: string | null;
  agencyCompanyName?: string | null;
  companyDisplayName?: string;
  companyConfidence?: "direct_or_unclear" | "agency_only" | "explicit_employer" | "low";
  companyExtractionNotes?: string[];
  skillTags?: Array<{
    term: string;
    sourceQuote: string;
    strength: "REQUIRED" | "PREFERRED" | "NARRATIVE";
  }>;
};

export type RuleEvaluation = {
  explicitDegreeRisk: boolean;
  traditionalCompanyPenalty: boolean;
  financePenalty: boolean;
  strictNewGradPipeline: boolean;
  earlyCareerFriendlyRole: boolean;
  newGradPenalty: boolean;
  seniorityOverreach: boolean;
  locationMismatch: boolean;
  visaMismatch: boolean;
  citizenshipMismatch: boolean;
  clearanceMismatch: boolean;
  stackMismatch: boolean;
  coreLanguageGap?: string[];
  adjacentFrameworkGap?: string[];
  infraStackShapeMismatch?: boolean;
  domainMismatch: boolean;
  startupFounderMismatch: boolean;
  matureStructuredEmployer?: boolean;
  explicitCoreLanguageMismatch?: boolean;
  explicitCoreLanguage?: string | null;
  fdeBuilderSoftwarePrimary?: boolean;
  pythonStackFlexibleWithJsTs?: boolean;
  healthcareProductEngineering?: boolean;
  backendProductApiRole?: boolean;
  infraCoreRole?: boolean;
  vagueEarlyStageAiCalibration?: boolean;
  researchHeavyAiRole?: boolean;
  fintechGoPrimaryStretch?: boolean;
  foundingEngineerStretch?: boolean;
  titleResponsibilityMismatch?: boolean;
  highOwnershipLowSupport?: boolean;
  reinforcedExperienceFloor?: boolean;
  productionInfraOwnershipGap?: boolean;
  earlyCareerExceedSeverityRisk?: boolean;
  scoringRiskScoreInconsistency?: boolean;
  credentialHeavyFintechAlgorithm?: boolean;
  productionBarCompetitivePool?: boolean;
  goDistributedDataInfraRole?: boolean;
  goDistributedDataInfraCandidateGap?: boolean;
  hardRuleNotes?: string[];
  hardRuleFlags?: Array<{ id: string; message: string }>;
  roleShapeOutsideLane?: boolean;
  jdDegreePositive?: boolean;
  jdProhibitsGenAI?: boolean;
  disjunctiveLanguageRequirementSatisfied?: boolean;
  disjunctiveAcceptedLanguages?: string[];
  notes: string[];
};

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

export type ScoreBreakdown = {
  stackFit: number;
  levelFit: number;
  domainFit: number;
  resumeStoryClarity: number;
  functionalOverlap: number;
  recruiterFriendliness: number;
  careerValue: number;
  capability?: number;
  capabilityBreakdown?: {
    stackFit: number;
    levelFit: number;
    functionalOverlap: number;
  };
  survivability?: number;
  survivabilityBreakdown?: Record<string, number>;
  scoreDisplay?: ScoreDisplay;
  recommendationLabel?: string;
  total: number;
  /** Approved insights adjustments frozen in at first scoring; already included in `total`. */
  historyAdjustments?: Array<{ id: string; label: string; points: number }>;
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

export type ScoreDisplay = {
  capability: number;
  capabilityBreakdown: {
    stackFit: number;
    levelFit: number;
    functionalOverlap: number;
  };
  differentiatorCoverageNote?: string;
  survivability: number;
  final: number;
  survAdjustment: number;
  gapDock: number;
  scoreDerivation: string;
  scoreBand: Recommendation;
  bandHeadline: "Strong apply" | "Apply" | "Apply but weak (stretch)" | "Weak";
  worthTailoring: boolean;
  survivabilityRows: SurvivabilityDisplayRow[];
  hardGates: string[];
  survivabilityPenalties: SurvivabilityPenalty[];
  dominantLever?: StrategicLeverSelection;
  actionLine: string;
  credentialBoostNote?: string;
  poolFriendlinessNote?: string;
  degreePositiveNote?: string;
  contractCaveat?: string;
  genAiRestrictionWarning?: string;
  applyNowUrgency?: boolean;
  applyNowUrgencyNote?: string;
  eligibilityAdvisory?: EligibilityFlag;
  eligibilityAdvisories?: EligibilityFlag[];
};

export type GeneratedAssets = {
  whyCompany?: string;
  coverLetter?: string;
  talkingPoints?: string[];
  tailoredBulletCandidates?: string[];
  emphasize?: string[];
  avoidClaiming?: string[];
  recruiterReplyDraft?: string;
};

export type AssetGenerationSliceDebug = {
  success: boolean;
  fallbackUsed: boolean;
  httpStatus?: number;
  errorCode?: string;
  errorType?: string;
  errorMessage?: string;
  parseStage?: string;
  reason?: string;
};

export type DebugAssetGeneration = {
  slices: Record<string, AssetGenerationSliceDebug>;
};

export type TrackerSpreadsheetFields = {
  rank?: string;
  discussed?: string;
  company?: string;
  role?: string;
  latestScore?: string;
  originalAltScore?: string;
  priority?: string;
  recommendedAction?: string;
  statusOutcome?: string;
  salaryAsk?: string;
  jdInput?: string;
  topMatch?: string;
  mainRisk?: string;
  notes?: string;
  resume?: string;
  agencyCompanyName?: string;
  employerCompanyName?: string;
  companyConfidence?: string;
  companyExtractionNotes?: string;
};

export type JobRecord = {
  id: string;
  extracted: ExtractedJobData;
  rules: RuleEvaluation;
  score: ScoreBreakdown;
  recommendation: Recommendation;
  salaryAsk: { number?: number; rangeMin?: number; rangeMax?: number };
  recommendedResume: ResumeType;
  resumeRationale: string[];
  topMatch: string;
  mainRisk: string;
  rationale: string[];
  risks: string[];
  referralPathwayAvailable?: boolean;
  referralPathwayNotes?: string;
  generated: GeneratedAssets;
  debugAssetGeneration?: DebugAssetGeneration;
  trackerSpreadsheet?: Partial<TrackerSpreadsheetFields>;
  importKey?: string;
  tracker: {
    priority?: string;
    recommendedAction?: string;
    statusOutcome?: string;
    color?: "green" | "yellow" | "red" | "blue";
    shortlist?: boolean;
    shortlistTag?: string;
    freshnessTier?: string;
    postedAt?: string;
    /** Manual override for date applied (ISO). Wins over statusHistory-derived appliedAt. */
    appliedAt?: string;
    /** You marked that this application reached a person (recruiter screen or later). */
    reachedHuman?: boolean;
    notes?: string;
  };
  status: JobStatus;
  createdAt: string;
  updatedAt: string;
  effectiveScore?: {
    total: number;
    recommendation: string;
    storedTrackerTotal: number;
    applicationKey: string;
    scoreRevised?: boolean;
    fingerprintStale?: boolean;
    revisionId?: string;
    staleRevisionTotal?: number;
    originalAuthoritativeTotal?: number;
    authoritativeSource?: string;
  };
  scoreHistory?: Array<{
    scoredAt: string;
    score: ScoreBreakdown;
    recommendation: Recommendation;
  }>;
  statusHistory?: Array<{
    id: string;
    jobId: string;
    fromStatus?: JobStatus;
    toStatus: JobStatus;
    note?: string;
    createdAt: string;
  }>;
};
