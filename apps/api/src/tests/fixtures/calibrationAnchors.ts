import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { userProfile as defaultUserProfile } from "../../config/userProfile.js";
import {
  countDifferentiatorTags,
  evaluateDifferentiatorCoverage,
  jobDescriptionBlob,
} from "../../lib/differentiatorCoverage.js";
import {
  computePoolFriendliness,
  scoreListingEmployerRecognizability,
} from "../../lib/poolFriendliness.js";
import {
  recomputeStoredJobScore,
  type RecomputedStoredJobScore,
} from "../../lib/recomputeStoredJobScore.js";
import type { ExtractedJobData, JobRecord } from "../../types/job.js";
import type { ResumeContextSet } from "../../types/resumeContext.js";
import type { ScoreBreakdown, SurvivabilityLever } from "../../types/scoring.js";
import type { UserProfile } from "../../types/userProfile.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = path.join(__dirname, "calibration");

export const CALIBRATION_FIXTURES = {
  cherryHill: "cherryHill.json",
  fuboFrontend: "fuboFrontend.json",
  civisCattleCall: "civisCattleCall.json",
  metaBrand: "metaBrand.json",
  ibmDegreeGate: "ibmDegreeGate.json",
  roAiEngineer: "roAiEngineer.json",
  trabaAppliedAi: "trabaAppliedAi.json",
  ithosWellness: "ithosWellness.json",
  preciselyAssociateSweFrontend: "preciselyAssociateSweFrontend.json",
  picnicFrontend: "picnicFrontend.json",
  stubHubCoreCompute: "stubHubCoreCompute.json",
  nytNewsMultimodal: "nytNewsMultimodal.json",
  nytContentDataProducts: "nytContentDataProducts.json",
  nytAiPlatformsProducts: "nytAiPlatformsProducts.json",
  saasSellsToFinance: "saasSellsToFinance.json",
  heritageBankInstitution: "heritageBankInstitution.json",
  clinicalInkHealthcare: "clinicalInkHealthcare.json",
  leapHealthcareProduct: "leapHealthcareProduct.json",
  extractionFailureCascade: "extractionFailureCascade.json",
  namedRequiredToolAbsent: "namedRequiredToolAbsent.json",
  eulerityJavaRequired: "eulerityJavaRequired.json",
  nytCdpRequiredLanguage: "nytCdpRequiredLanguage.json",
  preferredOnlyGapVerbiage: "preferredOnlyGapVerbiage.json",
  headlineReasonKeyRiskConsistency: "headlineReasonKeyRiskConsistency.json",
  resumeSurvivabilitySelectionConsistency: "resumeSurvivabilitySelectionConsistency.json",
  neonTextuallyUngrounded: "neonTextuallyUngrounded.json",
  kongAiEnablementUngrounded: "kongAiEnablementUngrounded.json",
  deepscribeSurvivabilityBoundary: "deepscribeSurvivabilityBoundary.json",
  funMultiBandSeniority: "funMultiBandSeniority.json",
  luminosSeniorDepthGuard: "luminosSeniorDepthGuard.json",
  jsrTechConsultingRequiredNode: "jsrTechConsultingRequiredNode.json",
  fleetioMarketplace: "fleetioMarketplace.json",
  bisectHostingWebDeveloper: "bisectHostingWebDeveloper.json",
  augustLawForwardDeployed: "augustLawForwardDeployed.json",
  eulerityTitleResponsibilityMismatch: "eulerityTitleResponsibilityMismatch.json",
  nytReflectionsSupportedFeatureOwnership: "nytReflectionsSupportedFeatureOwnership.json",
  bubbleSoftwareEngineer2Scaling: "bubbleSoftwareEngineer2Scaling.json",
  cherryTechnologiesMidLevel: "cherryTechnologiesMidLevel.json",
  worldquantFullStackDeveloper: "worldquantFullStackDeveloper.json",
  wexSde1ResidencyRadiusGate: "wexSde1ResidencyRadiusGate.json",
  arbitalHealthFullStack: "arbitalHealthFullStack.json",
} as const;

export type CalibrationFixtureKey = keyof typeof CALIBRATION_FIXTURES;

export type StoredCategoryScores = {
  stackFit: number;
  levelFit: number;
  domainFit: number;
  resumeStoryClarity: number;
  functionalOverlap: number;
  recruiterFriendliness: number;
  careerValue: number;
};

export type CalibrationAnchorFixture = {
  id: string;
  anchorNote?: string;
  extracted: ExtractedJobData;
  storedCategoryScores: StoredCategoryScores;
};

export type ScoredCalibrationAnchor = RecomputedStoredJobScore & {
  fixture: CalibrationAnchorFixture;
  employerRecognizability: number;
  poolFriendliness: number;
  poolFriendlinessLever: SurvivabilityLever;
  poolAdjustments: string[];
  differentiatorCoverage: ReturnType<typeof evaluateDifferentiatorCoverage>;
};

const SWE_RESUME = fs.readFileSync(
  path.resolve(__dirname, "./resumes/swe_resume.txt"),
  "utf8",
);

export const calibrationSweResumeContexts = (): ResumeContextSet => ({
  BASE: { rawText: SWE_RESUME, type: "BASE" },
});

export const loadCalibrationFixture = (
  key: CalibrationFixtureKey,
): CalibrationAnchorFixture => {
  const file = path.join(FIXTURE_DIR, CALIBRATION_FIXTURES[key]);
  return JSON.parse(fs.readFileSync(file, "utf8")) as CalibrationAnchorFixture;
};

export const fixtureToJobRecord = (fixture: CalibrationAnchorFixture): JobRecord => ({
  id: fixture.id,
  extracted: fixture.extracted,
  rules: {
    explicitDegreeRisk: false,
    traditionalCompanyPenalty: false,
    financePenalty: false,
    strictNewGradPipeline: false,
    earlyCareerFriendlyRole: false,
    newGradPenalty: false,
    seniorityOverreach: false,
    locationMismatch: false,
    visaMismatch: false,
    citizenshipMismatch: false,
    clearanceMismatch: false,
    stackMismatch: false,
    domainMismatch: false,
    startupFounderMismatch: false,
    notes: [],
  },
  score: { ...fixture.storedCategoryScores, total: 0 } satisfies ScoreBreakdown,
  recommendation: "apply",
  salaryAsk: {},
  recommendedResume: "BASE",
  resumeRationale: [],
  topMatch: "",
  mainRisk: "",
  rationale: [],
  risks: [],
  generated: {},
  tracker: {},
  status: "to_review",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
});

/** Run the full deterministic scoring pipeline on a persisted calibration fixture. */
export const scoreCalibrationAnchor = (
  key: CalibrationFixtureKey,
  options?: { profile?: UserProfile; resumeContexts?: ResumeContextSet },
): ScoredCalibrationAnchor => {
  const fixture = loadCalibrationFixture(key);
  const recomputed = recomputeStoredJobScore({
    job: fixtureToJobRecord(fixture),
    profile: options?.profile ?? defaultUserProfile,
    resumeContexts: options?.resumeContexts ?? calibrationSweResumeContexts(),
  });

  const poolMeta = computePoolFriendliness(
    fixture.extracted,
    options?.profile ?? defaultUserProfile,
  );
  const poolRow = recomputed.score.scoreDisplay?.survivabilityRows.find(
    (row) => row.key === "poolFriendliness",
  );

  return {
    ...recomputed,
    fixture,
    employerRecognizability: scoreListingEmployerRecognizability(fixture.extracted),
    poolFriendliness:
      recomputed.score.survivabilityBreakdown?.poolFriendliness ?? poolMeta.score,
    poolFriendlinessLever: poolRow?.lever ?? poolMeta.lever,
    poolAdjustments: poolMeta.adjustments.map((adjustment) => adjustment.id),
    differentiatorCoverage: evaluateDifferentiatorCoverage(fixture.extracted),
  };
};

export const differentiatorTagsForFixture = (
  fixture: CalibrationAnchorFixture,
): string[] => countDifferentiatorTags(jobDescriptionBlob(fixture.extracted)).matchedTags;
