import { z } from 'zod';
import { SCORE_CATEGORY_MAXES } from '../../config/scoringPolicy.js';
import { TRACKER_EXPORT_HEADERS } from '../../tracker/canonicalSpreadsheet.js';
import { preprocessExtractionInput } from '../../tools/triageStructuredNormalize.js';
import { LEGACY_RESUME_TYPES, RESUME_TYPES } from '../../types/resume.js';
import { normalizeRecommendation } from '../../lib/compositeScoring.js';
import { RECOMMENDATIONS } from '../../types/scoring.js';

export const ResumeTypeSchema = z.enum([...RESUME_TYPES, ...LEGACY_RESUME_TYPES]);
export const RecommendationSchema = z.preprocess(
  (raw) => normalizeRecommendation(raw),
  z.enum(RECOMMENDATIONS),
);
export const JobStatusSchema = z.enum([
  'to_review',
  'applied',
  'skip',
  'rejected',
  'interviewing',
  'assessment',
  'closed',
  'offer',
  'lapsed',
]);

export const ExtractedJobDataSchema = z.object({
  company: z.string().min(1),
  title: z.string().min(1),
  url: z.string().url().optional(),
  rawText: z.string().optional(),
  location: z.string().optional(),
  remoteType: z.enum(['remote', 'hybrid', 'onsite', 'unknown']).optional(),
  locationIsCommutable: z.boolean().optional(),
  salary: z
    .object({
      min: z.number().optional(),
      max: z.number().optional(),
      currency: z.string().optional(),
    })
    .optional(),
  seniority: z.string().optional(),
  employmentType: z.string().optional(),
  yearsExperience: z
    .object({
      raw: z.string().optional(),
      min: z.number().optional(),
      max: z.number().optional(),
      reinforcedLineCount: z.number().optional(),
    })
    .optional(),
  stack: z.array(z.string()).default([]),
  requiredSkills: z.array(z.string()).default([]),
  preferredSkills: z.array(z.string()).default([]),
  domainTags: z.array(z.string()).default([]),
  degreeRequirement: z
    .object({
      raw: z.string().optional(),
      level: z
        .enum([
          'none',
          'preferred',
          'required',
          'equivalent_allowed',
          'unknown',
        ])
        .optional(),
    })
    .optional(),
  visaRequirement: z.string().optional(),
  citizenshipRequirement: z.string().optional(),
  clearanceRequirement: z
    .union([
      z.string(),
      z.object({
        required: z.boolean(),
        timing: z.enum(["active_upfront", "sponsorable", "unspecified"]),
        raw: z.string().optional(),
      }),
    ])
    .optional(),
  relocationRequired: z.boolean().optional(),
  responsibilities: z.array(z.string()).default([]),
  /** ISO posting date when known from JD chrome or import. */
  postedAt: z.string().optional(),
  requirements: z.array(z.string()).default([]),
  listingCompanyName: z.string().optional(),
  employerCompanyName: z.string().nullable().optional(),
  agencyCompanyName: z.string().nullable().optional(),
  companyDisplayName: z.string().optional(),
  companyConfidence: z.enum(["direct_or_unclear", "agency_only", "explicit_employer", "low"]).optional(),
  companyEmployeeCount: z.number().optional(),
  companyExtractionNotes: z.array(z.string()).optional(),
  skillTags: z
    .array(
      z.object({
        term: z.string(),
        sourceQuote: z.string(),
        strength: z.enum(["REQUIRED", "PREFERRED", "NARRATIVE"]),
      }),
    )
    .optional(),
  geoScope: z
    .object({
      titleRegion: z.string().nullable(),
      postingLocation: z.string().nullable(),
      cardLocation: z.string().nullable(),
      remoteType: z.enum(['remote', 'hybrid', 'onsite', 'unknown']).optional(),
    })
    .optional(),
});

/** Live extraction JSON normalized then validated (safer URL/location/array coercion). */
export const ExtractedJobFromModelSchema = z.preprocess(
  preprocessExtractionInput,
  ExtractedJobDataSchema,
);

/** Fallback metadata-only extraction when deterministic company parse fails. */
export const JobMetadataFromModelSchema = z.object({
  companyName: z.string().nullable(),
  jobTitle: z.string().nullable(),
  employmentType: z.string().nullable(),
  location: z.string().nullable(),
  seniority: z.string().nullable(),
  salary: z.string().nullable(),
  workModel: z.string().nullable(),
});

export const RuleEvaluationSchema = z.object({
  explicitDegreeRisk: z.boolean(),
  traditionalCompanyPenalty: z.boolean(),
  financePenalty: z.boolean(),
  strictNewGradPipeline: z.boolean(),
  earlyCareerFriendlyRole: z.boolean(),
  newGradPenalty: z.boolean(),
  seniorityOverreach: z.boolean(),
  seniorityStretch: z.boolean().optional(),
  experienceGap: z.object({ dock: z.number(), reason: z.string() }).optional(),
  locationMismatch: z.boolean(),
  visaMismatch: z.boolean(),
  citizenshipMismatch: z.boolean(),
  clearanceMismatch: z.boolean(),
  stackMismatch: z.boolean(),
  coreLanguageGap: z.array(z.string()).optional().default([]),
  adjacentFrameworkGap: z.array(z.string()).optional().default([]),
  infraStackShapeMismatch: z.boolean().optional().default(false),
  domainMismatch: z.boolean(),
  startupFounderMismatch: z.boolean(),
  matureStructuredEmployer: z.boolean().optional().default(false),
  explicitCoreLanguageMismatch: z.boolean().optional().default(false),
  explicitCoreLanguage: z.string().nullable().optional(),
  fdeBuilderSoftwarePrimary: z.boolean().optional().default(false),
  pythonStackFlexibleWithJsTs: z.boolean().optional().default(false),
  healthcareProductEngineering: z.boolean().optional().default(false),
  backendProductApiRole: z.boolean().optional().default(false),
  infraCoreRole: z.boolean().optional().default(false),
  vagueEarlyStageAiCalibration: z.boolean().optional().default(false),
  researchHeavyAiRole: z.boolean().optional().default(false),
  fintechGoPrimaryStretch: z.boolean().optional().default(false),
  foundingEngineerStretch: z.boolean().optional().default(false),
  titleResponsibilityMismatch: z.boolean().optional().default(false),
  highOwnershipLowSupport: z.boolean().optional().default(false),
  reinforcedExperienceFloor: z.boolean().optional().default(false),
  reinforcedExperienceFloorLineCount: z.number().optional(),
  reinforcedExperienceFloorThreshold: z.number().optional(),
  productionInfraOwnershipGap: z.boolean().optional().default(false),
  earlyCareerExceedSeverityRisk: z.boolean().optional().default(false),
  scoringRiskScoreInconsistency: z.boolean().optional().default(false),
  credentialHeavyFintechAlgorithm: z.boolean().optional().default(false),
  productionBarCompetitivePool: z.boolean().optional().default(false),
  goDistributedDataInfraRole: z.boolean().optional().default(false),
  goDistributedDataInfraCandidateGap: z.boolean().optional().default(false),
  degreeHasEquivalencyClause: z.boolean().optional().default(false),
  degreeConflictingRequirement: z.boolean().optional().default(false),
  degreeEquivalencySatisfied: z.boolean().optional().default(false),
  jdDegreePositive: z.boolean().optional().default(false),
  jdProhibitsGenAI: z.boolean().optional().default(false),
  capabilityGap: z
    .object({
      kind: z.enum(["specialization", "stack_depth"]),
      reason: z.string(),
    })
    .optional(),
  specializationGap: z
    .object({
      kind: z.enum(["backend_stack", "design_portfolio", "enterprise_iam"]),
      name: z.string(),
      evidence: z.string(),
      severity: z.enum(["central", "moderate", "minor"]),
      lever: z.enum(["none", "portfolio", "upskill", "resume"]),
      dock: z.number().min(0).max(20),
      jdSide: z.string().optional(),
      resumeSide: z.string().optional(),
    })
    .optional(),
  eligibilityFlag: z
    .object({
      reason: z.string(),
      evidence: z.string(),
      lever: z.literal("verify"),
      severity: z.literal("check"),
    })
    .optional(),
  clearanceEligibilityFlag: z
    .object({
      reason: z.string(),
      evidence: z.string(),
      lever: z.literal("verify"),
      severity: z.literal("check"),
    })
    .optional(),
  clearanceRequiresExistingPenalty: z.boolean().optional(),
  geoExclusionHardGate: z.boolean().optional().default(false),
  geoExclusionReason: z.string().optional(),
  hardRuleNotes: z.array(z.string()).optional().default([]),
  hardRuleFlags: z
    .array(
      z.object({
        id: z.string(),
        message: z.string(),
        citedLanguages: z.array(z.string()).optional(),
      }),
    )
    .optional()
    .default([]),
  roleShapeOutsideLane: z.boolean().optional().default(false),
  adjacentRoleFunction: z.boolean().optional().default(false),
  frontendPrimaryRole: z.boolean().optional().default(false),
  platformInfraRole: z.boolean().optional().default(false),
  roleLane: z
    .enum([
      "product_frontend",
      "product_fullstack",
      "product_backend",
      "platform_infra",
      "adjacent_non_engineering",
    ])
    .optional(),
  roleLaneKind: z
    .enum([
      "implementation_analyst",
      "business_systems_analyst",
      "qa_engineer",
      "solutions_engineer",
      "technical_analyst",
      "sales_engineer",
    ])
    .nullable()
    .optional(),
  disjunctiveLanguageRequirementSatisfied: z.boolean().optional().default(false),
  disjunctiveAcceptedLanguages: z.array(z.string()).optional().default([]),
  namedHardRequirementGaps: z.array(z.string()).optional().default([]),
  notes: z.array(z.string()).default([]),
  penaltyVector: z.record(z.string(), z.number()).optional(),
});

export const CapabilityBreakdownSchema = z.object({
  stackFit: z.number(),
  levelFit: z.number(),
  functionalOverlap: z.number(),
});

const survivabilityLeverSchema = z.enum([
  "referral",
  "resume",
  "cover_letter",
  "credential",
  "none",
  "none_in_loop",
  "portfolio",
  "upskill",
]);

export const SurvivabilityDisplayRowSchema = z.object({
  key: z.string(),
  label: z.string(),
  score: z.number(),
  weight: z.number(),
  contribution: z.number(),
  lever: survivabilityLeverSchema,
  leverLabel: z.string(),
  bindingness: z.enum(["binding", "material", "cosmetic", "structural", "favorable"]),
  penaltyName: z.string(),
});

export const StrategicLeverSelectionSchema = z.object({
  key: z.string(),
  lever: survivabilityLeverSchema,
  leverLabel: z.string(),
  penaltyName: z.string(),
  bindingness: z.enum(["binding", "material", "cosmetic", "structural", "favorable"]),
  strategicValue: z.number(),
  isCollapsedReferral: z.boolean(),
});

export const ScoreDisplaySchema = z.object({
  capability: z.number(),
  capabilityBreakdown: CapabilityBreakdownSchema,
  differentiatorCoverageNote: z.string().optional(),
  roleFunctionCapNote: z.string().optional(),
  degreePositiveNote: z.string().optional(),
  contractCaveat: z.string().optional(),
  genAiRestrictionWarning: z.string().optional(),
  applyNowUrgency: z.boolean().optional(),
  applyNowUrgencyNote: z.string().optional(),
  survivability: z.number(),
  final: z.number(),
  survAdjustment: z.number(),
  gapDock: z.number(),
  scoreDerivation: z.string(),
  scoreBand: z.enum(RECOMMENDATIONS),
  bandHeadline: z.enum(["Strong apply", "Apply", "Apply but weak (stretch)", "Weak"]),
  worthTailoring: z.boolean(),
  survivabilityRows: z.array(SurvivabilityDisplayRowSchema),
  hardGates: z.array(z.string()),
  survivabilityPenalties: z.array(
    z.object({
      message: z.string(),
      lever: survivabilityLeverSchema,
      leverLabel: z.string(),
    }),
  ),
  dominantLever: StrategicLeverSelectionSchema.optional(),
  actionLine: z.string(),
  credentialBoostNote: z.string().optional(),
  poolFriendlinessNote: z.string().optional(),
  eligibilityAdvisory: z
    .object({
      reason: z.string(),
      evidence: z.string(),
      lever: z.literal("verify"),
      severity: z.literal("check"),
    })
    .optional(),
  eligibilityAdvisories: z
    .array(
      z.object({
        reason: z.string(),
        evidence: z.string(),
        lever: z.literal("verify"),
        severity: z.literal("check"),
      }),
    )
    .optional(),
});

const CertificationBoostSchema = z.object({
  certName: z.string(),
  status: z.enum(["active", "lapsed"]),
  matchedSkills: z.array(z.string()),
  overlapCount: z.number(),
  boost: z.number(),
  note: z.string(),
});

export const ScoreBreakdownSchema = z
  .object({
    stackFit: z.number().min(0).max(SCORE_CATEGORY_MAXES.stackFit),
    levelFit: z.number().min(0).max(SCORE_CATEGORY_MAXES.levelFit),
    domainFit: z.number().min(0).max(SCORE_CATEGORY_MAXES.domainFit),
    resumeStoryClarity: z.number().min(0).max(SCORE_CATEGORY_MAXES.resumeStoryClarity),
    functionalOverlap: z.number().min(0).max(SCORE_CATEGORY_MAXES.functionalOverlap),
    recruiterFriendliness: z.number().min(0).max(SCORE_CATEGORY_MAXES.recruiterFriendliness),
    careerValue: z.number().min(0).max(SCORE_CATEGORY_MAXES.careerValue),
    capability: z.number().min(0).max(100).optional(),
    capabilityBreakdown: CapabilityBreakdownSchema.optional(),
    survivability: z.number().min(0).max(1).optional(),
    survivabilityBreakdown: z.record(z.string(), z.number()).optional(),
    certificationBoost: CertificationBoostSchema.optional(),
    scoreDisplay: ScoreDisplaySchema.optional(),
    recommendationLabel: z.string().optional(),
    total: z.number().min(0).max(100),
    historyAdjustments: z
      .array(z.object({ id: z.string(), label: z.string(), points: z.number() }))
      .optional(),
  })
  .superRefine((v, ctx) => {
    const legacySum =
      v.stackFit +
      v.levelFit +
      v.domainFit +
      v.resumeStoryClarity +
      v.functionalOverlap +
      v.recruiterFriendliness +
      v.careerValue;
    if (v.capability == null && v.total > legacySum + 2) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Legacy score total cannot exceed category sum.",
      });
    }
  });

export const GeneratedAssetsSchema = z.object({
  whyCompany: z.string().optional(),
  coverLetter: z.string().optional(),
  talkingPoints: z.array(z.string()).optional(),
  tailoredBulletCandidates: z.array(z.string()).optional(),
  emphasize: z.array(z.string()).optional(),
  avoidClaiming: z.array(z.string()).optional(),
  recruiterReplyDraft: z.string().optional(),
});

/** OpenAI / Mongo may emit null for absent optional debug fields — accept nullish. */
const debugOptionalString = z.string().nullish();
const debugOptionalNumber = z.number().nullish();

export const TriageStageDebugSchema = z.object({
  success: z.boolean(),
  fallbackUsed: z.boolean(),
  httpStatus: debugOptionalNumber,
  errorCode: debugOptionalString,
  errorType: debugOptionalString,
  errorMessage: debugOptionalString,
  parseStage: debugOptionalString,
  reason: debugOptionalString,
});

export const TriageDebugExtractionSchema = z.object({
  /** True when live extraction did not validate (legacy aggregate). */
  fallbackUsed: z.boolean(),
  extraction: TriageStageDebugSchema,
  scoring: TriageStageDebugSchema,
  extractedFromRawText: z.array(z.string()),
  missingCriticalFields: z.array(z.string()),
});

export const AssetGenerationSliceDebugSchema = z.object({
  success: z.boolean(),
  fallbackUsed: z.boolean(),
  httpStatus: debugOptionalNumber,
  errorCode: debugOptionalString,
  errorType: debugOptionalString,
  errorMessage: debugOptionalString,
  parseStage: debugOptionalString,
  reason: debugOptionalString,
});

export const DebugAssetGenerationSchema = z.object({
  slices: z.record(z.string(), AssetGenerationSliceDebugSchema),
});

export const StatusHistoryRecordSchema = z.object({
  id: z.string(),
  jobId: z.string(),
  fromStatus: JobStatusSchema.optional(),
  toStatus: JobStatusSchema,
  note: z.string().optional(),
  createdAt: z.string(),
});

export const JobImportSourceSchema = z.object({
  spreadsheetPath: z.string(),
  sheetName: z.string(),
  rowNumber: z.number(),
  fileFingerprint: z.string(),
});

export const TrackerSpreadsheetFieldsSchema = z
  .object({
    rank: z.string().optional(),
    discussed: z.string().optional(),
    company: z.string().optional(),
    role: z.string().optional(),
    latestScore: z.string().optional(),
    originalAltScore: z.string().optional(),
    priority: z.string().optional(),
    recommendedAction: z.string().optional(),
    statusOutcome: z.string().optional(),
    salaryAsk: z.string().optional(),
    jdInput: z.string().optional(),
    topMatch: z.string().optional(),
    mainRisk: z.string().optional(),
    notes: z.string().optional(),
    resume: z.string().optional(),
  })
  .optional();

export const JobRecordSchema = z.object({
  id: z.string(),
  extracted: ExtractedJobDataSchema,
  rules: RuleEvaluationSchema,
  score: ScoreBreakdownSchema,
  recommendation: RecommendationSchema,
  salaryAsk: z
    .object({
      number: z.number().optional(),
      rangeMin: z.number().optional(),
      rangeMax: z.number().optional(),
    })
    .default({}),
  recommendedResume: ResumeTypeSchema,
  resumeRationale: z.array(z.string()).default([]),
  topMatch: z.string(),
  mainRisk: z.string(),
  rationale: z.array(z.string()).default([]),
  risks: z.array(z.string()).default([]),
  referralPathwayAvailable: z.boolean().optional().default(false),
  referralPathwayNotes: z.string().optional().default(""),
  generated: GeneratedAssetsSchema.default({}),
  debugExtraction: TriageDebugExtractionSchema.optional(),
  debugAssetGeneration: DebugAssetGenerationSchema.optional(),
  tracker: z
    .object({
      priority: z.string().optional(),
      recommendedAction: z.string().optional(),
      statusOutcome: z.string().optional(),
      color: z.enum(['green', 'yellow', 'red', 'blue']).optional(),
      shortlist: z.boolean().optional(),
      shortlistTag: z.string().optional(),
      freshnessTier: z.string().optional(),
      postedAt: z.string().optional(),
      appliedAt: z.string().optional(),
      notes: z.string().optional(),
      reachedHuman: z.boolean().optional(),
    })
    .default({}),
  trackerSpreadsheet: TrackerSpreadsheetFieldsSchema,
  importKey: z.string().optional(),
  importSource: JobImportSourceSchema.optional(),
  status: JobStatusSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
  scoreHistory: z
    .array(
      z.object({
        scoredAt: z.string(),
        score: ScoreBreakdownSchema,
        recommendation: RecommendationSchema,
      }),
    )
    .optional(),
  statusHistory: z.array(StatusHistoryRecordSchema).optional(),
  scoringJdTextHash: z.string().optional(),
});

export const TriageRequestSchema = z
  .object({
    url: z.string().url().optional(),
    rawText: z.string().optional(),
    companyHint: z.string().optional(),
    fullPrep: z.boolean().optional().default(false),
  })
  .refine((v) => Boolean(v.url || v.rawText), {
    message: 'Provide either url or rawText.',
    path: ['url'],
  });

export const GenerateAssetsForIdBodySchema = z.object({
  force: z.boolean().optional(),
});

export const GenerateAssetsFromJobBodySchema = z.object({
  job: JobRecordSchema,
  persist: z.boolean().optional(),
  force: z.boolean().optional(),
});

export const UpdateJobStatusBodySchema = z.object({
  status: JobStatusSchema,
  note: z.string().trim().min(1).max(4000).optional(),
});

export const UpdateJobNotesBodySchema = z.object({
  notes: z.string().trim().max(10000),
});

/** true = reached a person, false = no call or interview (overrides Gmail), null = clear the mark. */
export const UpdateJobReachedHumanBodySchema = z.object({ reachedHuman: z.boolean().nullable() });

export const UpdateJobAppliedAtBodySchema = z.object({
  appliedAt: z
    .string()
    .trim()
    .min(1)
    .refine(
      (v) => /^\d{4}-\d{2}-\d{2}$/.test(v) || !Number.isNaN(new Date(v).getTime()),
      "Expected YYYY-MM-DD or a valid ISO date.",
    ),
});

const parseBooleanQuery = z.union([
  z.boolean(),
  z
    .string()
    .trim()
    .refine((t) => ['true', 'false', '1', '0'].includes(t.toLowerCase()), {
      message: 'Expected boolean-like query value.',
    })
    .transform((t) => t.toLowerCase() === 'true' || t === '1'),
]);

export const JobListQuerySchema = z.object({
  status: JobStatusSchema.optional(),
  shortlist: parseBooleanQuery.optional(),
  resume: ResumeTypeSchema.optional(),
  recommendation: RecommendationSchema.optional(),
  minScore: z.coerce.number().min(0).max(100).optional(),
  company: z.string().trim().min(1).optional(),
});

export const ExportFormatSchema = z.enum(['json', 'csv']).default('json');

export const JobExportQuerySchema = JobListQuerySchema.extend({
  format: ExportFormatSchema.optional(),
});

const jobExportRowShape = Object.fromEntries(
  TRACKER_EXPORT_HEADERS.map((h) => [h, z.string()]),
) as Record<(typeof TRACKER_EXPORT_HEADERS)[number], z.ZodString>;

export const JobExportRowSchema = z.object(jobExportRowShape);

export const TriageResponseSchema = JobRecordSchema;

export type TriageRequest = z.infer<typeof TriageRequestSchema>;
export type TriageResponse = z.infer<typeof TriageResponseSchema>;
export type GenerateAssetsFromJobBody = z.infer<
  typeof GenerateAssetsFromJobBodySchema
>;
