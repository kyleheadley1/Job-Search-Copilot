import { scoringPolicy } from '../../config/scoringPolicy.js';
import type { ExtractedJobData } from '../../types/job.js';
import type { RuleEvaluation } from '../../types/scoring.js';
import type { UserProfile } from '../../types/userProfile.js';
import type { ResumeContextSet } from '../../types/resumeContext.js';
import type { ResumeType } from '../../types/resume.js';
import { normalizeMatcherText, normalizeText } from '../../lib/text.js';
import { claimableStackFromContexts } from '../../lib/claimableStack.js';
import { analyzeStackMismatch } from '../../lib/stackMismatchAnalysis.js';
import {
  detectStrictFinanceEmployerContext,
  detectTraditionalEmployerContextStrict,
  textImpliesNycMetroOrCommutableNj,
} from '../../lib/employerLocationSignals.js';
import {
  analyzeCoreLanguageRequirement,
  explicitCoreLanguageRiskSummary,
  isMatureStructuredEmployer,
  jdPythonFlexibleWithJsOrTs,
} from '../../lib/coreLanguageRequirements.js';
import {
  evaluateDisjunctiveLanguageRequirement,
  filterGapsAfterDisjunctiveMatch,
  languageIsIllustrativeExampleOnly,
} from '../../lib/disjunctiveLanguageRequirement.js';
import { classifyJdLines, termIsPreferredOrNarrativeOnly } from '../../lib/jdTagProvenance.js';
import { goMentionedAsPreferred, textMentionsGoLanguage } from '../../lib/goLanguage.js';
import { isFdeBuilderSoftwarePrimaryShape } from '../../lib/fdeBuilderRole.js';
import { evaluateTitleResponsibilitySeniority } from '../../lib/titleResponsibilitySeniority.js';
import {
  detectReinforcedExperienceFloor,
  estimateCandidateProfessionalYears,
} from '../../lib/reinforcedExperienceFloor.js';
import { detectProductionInfraOwnershipGap } from '../../lib/namedCapabilityRiskPenalty.js';
import { classifyRoleLane, detectBackendProductApiShape } from '../../lib/roleFunctionClassifier.js';
import { isStartupSmallTeamScale } from '../../lib/employerScale.js';
import { assessRoleSeniority, resolveStructuredSeniorityLevel, seniorityNeedsManualReview } from '../../lib/seniorityGate.js';
import { reconcileSeniority } from '../../lib/seniorityReconciliation.js';
import { reconcileYearsExperience } from '../../lib/yearsExperienceReconciliation.js';
import { COMPOSITE_SCORING } from '../../config/capabilitySurvivabilityPolicy.js';
import { computeExperienceGap, levelFitCeilingForSeniorityDock } from '../../lib/experienceGap.js';
import {
  citeBackendApiSpan,
  citeFintechDomainSpan,
  citeProductionRigorSpan,
  citeSeniorDepthSpan,
  firstJdMatch,
  jdDutiesBlob,
} from '../../lib/jdGroundedRiskNotes.js';
import {
  jdHasAppliedAiSystemsOverlap,
  jdIsStructurallyVague,
  profileHasGoDataInfraProductionEvidence,
} from '../../lib/scoringOutputPolish.js';
import { filterLanguagesToJdPresence } from '../../lib/jdLanguagePresence.js';
import { evaluateGeoEligibility } from '../../lib/geoEligibility.js';
import { evaluateClearanceCitizenship } from '../../lib/clearanceCitizenship.js';
import {
  detectCompetitivePoolSignals,
  isVentureFundedStartupShape,
} from '../../lib/poolCompetitiveness.js';
import {
  jdHasDegreeEquivalencyClause,
  jdIsDegreePositive,
  jdHasStrictFieldDegreeLine,
  resolveDegreeEquivalencyRules,
} from '../../lib/degreeEquivalency.js';
import { jdProhibitsGenAI } from '../../lib/genAiRestriction.js';
import { detectNamedHardRequirementGaps } from '../../lib/namedHardRequirement.js';
import { repairMidWordLineBreaks } from '../../lib/repairMidWordLineBreaks.js';

const includesAny = (haystack: string, needles: string[]): boolean =>
  needles.some((needle) => haystack.includes(needle));

const RAW_VISA =
  /\bno\s+(visa\s+)?sponsorship\b|\bunable\s+to\s+sponsor\b|\bmust\s+be\s+authorized\s+to\s+work\s+in\s+the\s+u\.?s\.?\b|\bauthorized\s+to\s+work\s+in\s+the\s+u\.?s\.?\b/i;
const RAW_DEGREE =
  /\b(bachelor'?s?\s+degree|bachelors\s+degree|bs\s+in|b\.s\.|ba\s+in)[^.\n]{0,160}\brequired\b|\bdegree\s+in\s+(computer science|cs|engineering)\s+required\b/i;

const NEW_GRAD_WORD = /\b(new\s+graduate|new\s+grad)\b/i;

function profileHasCsDegreeCred(profile: UserProfile): boolean {
  if (!profile.degreeStatus.hasBachelors) return false;
  const blob = normalizeText(
    [profile.degreeStatus.note, profile.training?.program ?? '', profile.headline].join(' '),
  );
  return /\b(computer science|comp sci|cs degree|b\.?s\.?\s*(in\s*)?cs|bachelor[^.\n]{0,60}computer science)\b/i.test(
    blob,
  );
}

function jdExplicitCsDegreeHard(
  combinedText: string,
  degreeRaw: string,
  degreeLevel: string | undefined,
): boolean {
  if (jdHasDegreeEquivalencyClause(combinedText, degreeLevel, degreeRaw)) return false;
  const dr = normalizeText(degreeRaw);
  const csInStructured =
    (dr.includes('computer science') || /\bcs degree\b/i.test(dr)) &&
    /\b(bachelor|bs|b\.s\.|degree|ms|m\.s\.)\b/i.test(dr);
  const csInBlob =
    /\b(bachelor'?s?|bs|b\.s\.|ms|m\.s\.)\b[^.\n]{0,100}\b(computer science|comp sci|cs)\b/i.test(
      combinedText,
    ) ||
    /\b(computer science|comp sci)\b[^.\n]{0,80}\b(bachelor|bs|b\.s\.|degree|ms)\b/i.test(combinedText) ||
    /\b(bs\/ms|bs|ms)\s+in\s+(computer science|cs)\b/i.test(combinedText) ||
    csInStructured;
  if (!csInBlob) return false;
  return (
    degreeLevel === 'required' ||
    /\b(must have|required)\b[^.\n]{0,160}\b(bachelor|bs|computer science|cs degree|bs\/ms)\b/i.test(
      combinedText,
    ) ||
    /\b(bachelor|bs)[^.\n]{0,100}\b(computer science|cs)\b[^.\n]{0,40}\brequired\b/i.test(combinedText)
  );
}

/** Language that usually indicates a formal campus / graduate / rotation hiring track. */
const hasStrongPipelineMarkers = (combinedText: string): boolean =>
  NEW_GRAD_WORD.test(combinedText) ||
  includesAny(combinedText, [
    'graduate program',
    'campus hire',
    'campus recruiting',
    'rotational program',
    'rotation program',
    'university graduate',
    'early career program',
  ]);

export const evaluateRules = (
  job: ExtractedJobData,
  profile: UserProfile,
  options?: {
    resumeContexts?: ResumeContextSet;
    activeResumeType?: ResumeType;
  },
): RuleEvaluation => {
  job = reconcileSeniority(reconcileYearsExperience(job).job).job;
  const notes: string[] = [];
  const penaltyVector: Record<string, number> = {};

  const rawRepaired = repairMidWordLineBreaks(job.rawText ?? '');
  const companyNorm = normalizeText(job.company ?? '');

  const structuredParts = [
    job.title,
    job.seniority,
    job.location,
    job.visaRequirement,
    job.citizenshipRequirement,
    job.clearanceRequirement,
    ...(job.domainTags ?? []),
    ...(job.stack ?? []),
    ...(job.requirements ?? []),
    ...(job.responsibilities ?? []),
  ]
    .filter(Boolean)
    .join(' ');

  const combinedText = normalizeText(
    [companyNorm, structuredParts, rawRepaired].filter(Boolean).join(' '),
  );
  const matcherText = normalizeMatcherText(
    [companyNorm, structuredParts, rawRepaired].filter(Boolean).join(' '),
  );
  const jdDegreePositive = jdIsDegreePositive(job);
  const jdProhibitsGenAIContent = jdProhibitsGenAI(job);

  const isFinance = detectStrictFinanceEmployerContext(combinedText, companyNorm);
  const traditionalSignal = detectTraditionalEmployerContextStrict(combinedText, companyNorm);
  const startupSmallTeam = isStartupSmallTeamScale(job, combinedText);
  const isTraditionalCompany = traditionalSignal && !startupSmallTeam;

  const harshEmployerContext = isTraditionalCompany || isFinance;

  const degreeLevel = job.degreeRequirement?.level ?? 'unknown';
  const degreeRaw = normalizeText(job.degreeRequirement?.raw ?? '');
  const jdFinanceAccountingHard =
    /\b(gaap|asc\s*606|asc606|generally accepted accounting|revenue recognition|accounting principles)\b/i.test(
      combinedText,
    ) ||
    (/\b(financial workflow|finance workflow|accounting workflow)\b/i.test(combinedText) &&
      /\b(build|building|software|application|engineer|saas)\b/i.test(combinedText));
  const jdAlgorithmPublicationHard =
    /\bdemonstrated algorithm expertise\b/i.test(combinedText) ||
    /\bacademic or industry publications\b/i.test(combinedText) ||
    (/\bpublications?\b/i.test(combinedText) &&
      /\b(algorithm|big data algorithms|distributed systems|high[-\s]?performance computing|\bhpc\b)\b/i.test(
        combinedText,
      ));
  const jdJavaCppOopHard =
    /\b(java|c\+\+)\b[^.\n]{0,120}\b(object[-\s]oriented|oop)\b/i.test(combinedText) ||
    /\bjava\s*\/\s*c\+\+\s*style\b/i.test(combinedText) ||
    (/\bobject[-\s]oriented programming\b/i.test(combinedText) &&
      /\b(java|c\+\+)\b/i.test(combinedText));
  const jdB2bSaasExperienceHard =
    /\bb2b\b/i.test(combinedText) &&
    /\bsaas\b/i.test(combinedText) &&
    /\b(\d\+\s*years?|years?\s+of|must have|required)\b/i.test(combinedText);
  const credentialHardSignalCount = [
    jdFinanceAccountingHard,
    jdAlgorithmPublicationHard,
    jdJavaCppOopHard,
    jdB2bSaasExperienceHard,
  ].filter(Boolean).length;
  const explicitCsDegreeHard = jdExplicitCsDegreeHard(combinedText, degreeRaw, degreeLevel);
  const credentialHeavyFintechAlgorithm =
    explicitCsDegreeHard &&
    !profileHasCsDegreeCred(profile) &&
    credentialHardSignalCount >= 2;

  const degreeRequiredSignal =
    degreeLevel === 'required' ||
    degreeRaw.includes('bachelor') ||
    degreeRaw.includes('bs in computer science') ||
    RAW_DEGREE.test(job.rawText ?? '');

  const {
    degreeHasEquivalencyClause,
    degreeEquivalencySatisfied,
    explicitDegreeRisk,
  } = resolveDegreeEquivalencyRules(
    profile,
    combinedText,
    degreeRequiredSignal,
    degreeLevel,
    job.degreeRequirement?.raw ?? '',
  );
  const degreeConflictingRequirement =
    degreeRequiredSignal &&
    degreeHasEquivalencyClause &&
    !degreeEquivalencySatisfied &&
    jdHasStrictFieldDegreeLine(`${job.rawText ?? ''}\n${job.degreeRequirement?.raw ?? ''}`);

  const strictNewGradPipeline =
    hasStrongPipelineMarkers(combinedText) &&
    (harshEmployerContext || explicitDegreeRisk);

  const earlyCareerShape =
    includesAny(matcherText, [
      'early career',
      'entry level',
      'entry-level',
      'software engineer i',
      'engineer i',
      'swe i',
      'associate engineer',
      'associate software',
      'students welcome',
      'freelancers welcome',
      'builders welcome',
      'show the work',
    ]) ||
    (hasStrongPipelineMarkers(matcherText) &&
      !harshEmployerContext &&
      !explicitDegreeRisk);

  const earlyCareerFriendlyRole = earlyCareerShape && !strictNewGradPipeline;

  const seniorityAssessment = assessRoleSeniority(job);
  const seniorityOverreach = seniorityAssessment === 'overreach';
  const seniorityStretch = seniorityAssessment === 'stretch';
  if (seniorityNeedsManualReview(job)) {
    notes.push(
      'Seniority gate deferred for manual review — structured Seniority field missing, unbacked by the title/years, or conflicts with years parse; do not treat it as a hard gate.',
    );
  }

  const primaryNonNycMetroInLocationLine =
    /\b(location|based|office)\s*:\s*[^.\n]{0,100}\b(dallas|austin|seattle|san francisco|sf\b|los angeles|chicago|denver|atlanta|boston|miami|philadelphia|phoenix|detroit|houston|portland)\b/i.test(
      combinedText,
    );
  const nycOrNjViableInText =
    textImpliesNycMetroOrCommutableNj(combinedText) && !primaryNonNycMetroInLocationLine;
  const locationIsPreference =
    /\b(preferred|preference|flexible|open to remote|remote (?:ok|considered|possible|friendly))\b/i.test(
      job.location ?? '',
    ) || /\b(?:based in|located in|location)\b[^.\n]{0,80}\b(?:preferred|flexible)\b/i.test(job.rawText ?? '');
  const locationMismatch =
    (job.remoteType === 'onsite' || job.remoteType === 'hybrid') &&
    job.locationIsCommutable === false &&
    !nycOrNjViableInText &&
    !locationIsPreference;

  const jdSignalsVisaSponsorshipConstraint =
    includesAny(normalizeText(job.visaRequirement ?? ''), [
      'no sponsorship',
      'must be authorized',
      'unable to sponsor',
    ]) || RAW_VISA.test(job.rawText ?? '');

  const visaMismatch = profile.requiresSponsorship && jdSignalsVisaSponsorshipConstraint;

  const clearanceCitizenship = evaluateClearanceCitizenship(job, profile);
  const citizenshipMismatch = clearanceCitizenship.citizenshipMismatch;
  const clearanceMismatch = clearanceCitizenship.clearanceMismatch;

  const roleLaneEarly = classifyRoleLane(job);
  const backendProductApiRole =
    roleLaneEarly.label === "product_backend" ||
    (roleLaneEarly.label !== "platform_infra" &&
      roleLaneEarly.label !== "adjacent_non_engineering" &&
      roleLaneEarly.label !== "product_frontend" &&
      detectBackendProductApiShape(job));
  const infraCoreRole = roleLaneEarly.label === "platform_infra";
  const infraStackShapeMismatch =
    !backendProductApiRole &&
    !includesAny(combinedText, [
      'typescript',
      'javascript',
      'node',
      'react',
      'api',
      'full-stack',
    ]) &&
    includesAny(combinedText, [
      'sre',
      'infrastructure',
      'devops',
      'observability',
      'platform',
    ]);

  const claimable = claimableStackFromContexts(options?.resumeContexts, options?.activeResumeType ?? 'BASE');
  const resumeType = options?.activeResumeType ?? 'BASE';
  const resumeRaw =
    options?.resumeContexts?.[resumeType]?.rawText ??
    options?.resumeContexts?.BASE?.rawText ??
    '';
  const candidateBackgroundBlob = [
    resumeRaw,
    profile.headline,
    ...(profile.strengths ?? []),
    ...(profile.recurringStory ?? []),
    ...(profile.flagshipProjects ?? []).flatMap((p) => [p.name, ...(p.tech ?? [])]),
    ...(profile.certifications ?? []).flatMap((c) => [c.name, ...(c.relatedSkills ?? [])]),
    profile.training?.program ?? '',
    ...claimable.skills.map((s) => s.label),
  ]
    .filter(Boolean)
    .join('\n');

  const namedHardRequirementGaps = detectNamedHardRequirementGaps(job, candidateBackgroundBlob).map(
    (g) => g.name,
  );
  for (const name of [...namedHardRequirementGaps].reverse()) {
    notes.unshift(
      `JD requires named tool/platform ${name} — no experience found in your background.`,
    );
  }

  const stackAnalysis = analyzeStackMismatch(job, claimable);
  const disjunctiveLanguage = evaluateDisjunctiveLanguageRequirement(job, claimable);
  let stackMismatch = stackAnalysis.stackMismatch;
  let coreLanguageGap = filterGapsAfterDisjunctiveMatch(
    stackAnalysis.coreLanguageGap,
    disjunctiveLanguage,
  );
  coreLanguageGap = filterLanguagesToJdPresence(coreLanguageGap, job).filter(
    (label) => !languageIsIllustrativeExampleOnly(job, label),
  );
  if (coreLanguageGap.length === 0) stackMismatch = false;
  const adjacentFrameworkGap = stackAnalysis.adjacentFrameworkGap;

  const hardDomainDutyText = normalizeText(
    [job.title, jdDutiesBlob(job), ...(job.requiredSkills ?? [])].filter(Boolean).join(' '),
  );
  const actuarialCredentialRole =
    /\b(actuary|actuarial (?:analyst|associate|exam|credential|fellowship|experience required))\b/i.test(
      hardDomainDutyText,
    );
  const hardDomainMismatch =
    includesAny(hardDomainDutyText, ['medical billing', 'quantitative research', 'embedded firmware']) ||
    actuarialCredentialRole;
  const HEALTHCARE_CUE =
    /\b(healthcare|health\s+care|behavioral\s+health|clinical|patient|hospital|therapy|ehr|hipaa)\b/i;
  const healthcareIdentity = /\b(healthcare|clinical|eclinical|hipaa)\b/i.test(
    `${job.company} ${job.title}`,
  );
  const healthcareRequiredProse = [
    ...(job.requirements ?? []),
    ...(job.responsibilities ?? []),
    ...classifyJdLines(job.rawText ?? "")
      .filter(({ strength, line }) => strength === "REQUIRED" && !/\b(a plus|preferred|nice[- ]to[- ]have)\b/i.test(line))
      .map(({ line }) => line),
  ].some((line) => HEALTHCARE_CUE.test(line) && !/\b(a plus|preferred|nice[- ]to[- ]have)\b/i.test(line));
  const healthcarePreferredOnly =
    !healthcareIdentity &&
    !healthcareRequiredProse &&
    (termIsPreferredOrNarrativeOnly("healthcare", job) ||
      classifyJdLines(job.rawText ?? "").some(
        ({ line, strength }) => HEALTHCARE_CUE.test(line) && (strength === "PREFERRED" || /\ba plus\b/i.test(line)),
      ));
  const healthcareProductEngineering =
    !hardDomainMismatch &&
    !healthcarePreferredOnly &&
    HEALTHCARE_CUE.test(combinedText) &&
    /\b(product\s+engineer|full[-\s]?stack|software\s+engineer|typescript|javascript|react|api|revenue|growth|internal\s+tools|crm)\b/i.test(
      combinedText,
    );
  const domainMismatch = hardDomainMismatch;

  const startupFounderMismatch = includesAny(combinedText, [
    'founding engineer',
    'first engineer',
    'build from scratch with no support',
  ]);
  const foundingSignals =
    /\b(founding engineer|founding full[-\s]?stack engineer|founding team|1st engineer|2nd engineer|3rd engineer|4th engineer)\b/i.test(
      combinedText,
    ) ||
    /\b(shape engineering culture|own major technical decisions|build from scratch|limited mentorship|low mentorship)\b/i.test(
      combinedText,
    );
  const healthcareOpsComplexity =
    !healthcarePreferredOnly &&
    /\b(healthcare|clinical|patient|care operations|compliance|hipaa)\b/i.test(combinedText);
  const foundingEngineerStretch = foundingSignals;
  const fintechPaymentsRole =
    /\b(fintech|payments?|credit card|co[-\s]?branded|issuing|cardholder|banking api|financial infrastructure|underwriting)\b/i.test(
      combinedText,
    );
  const goPrimaryBackend =
    /\b(go|golang)\s+is\s+our\s+primary\s+backend\s+language\b/i.test(combinedText) ||
    /\bprimary\s+backend\s+language\b[^.\n]{0,60}\b(go|golang)\b/i.test(combinedText) ||
    /\bstrong\s+proficiency\s+in\s+(go|golang)\b/i.test(combinedText) ||
    /\b(go|golang)\b[^.\n]{0,60}\bprimary\b[^.\n]{0,40}\bbackend\b/i.test(combinedText);
  const microservicesHeavy =
    /\b(microservices?|service[-\s]?oriented|distributed systems?|on[-\s]?call|production troubleshooting|incident response)\b/i.test(
      combinedText,
    );
  const fintechGoPrimaryStretch =
    fintechPaymentsRole && backendProductApiRole && (goPrimaryBackend || microservicesHeavy);
  const researchHeavyAiRole =
    /\b(applied ai researcher|research scientist|ai researcher|research engineer)\b/i.test(combinedText) &&
    /\b(research track record|publications?|meta[-\s]?learning|program synthesis|evolutionary computation|self[-\s]?constructing systems?|recursive systems?|self[-\s]?architecting|frontier research|model experiments?|data analysis)\b/i.test(
      combinedText,
    );
  const dataInfraStreaming =
    /\b(kafka|kinesis|amazon\s*kinesis|amazon\s*sqs|\bsqs\b|managed streaming|event stream|stream processing|streaming pipeline)\b/i.test(
      combinedText,
    );
  const dataWarehouseAnalytics =
    /\b(redshift|snowflake|clickhouse|trino|apache iceberg|iceberg tables|\biceberg\b|data warehouse|analytics database|olap)\b/i.test(
      combinedText,
    );
  const specializedDataStores =
    /\b(elasticsearch|opensearch|scylladb|scylla|aerospike|tidb)\b/i.test(combinedText);
  const largeDataPerf =
    /\b(large datasets?|big data|petabyte|terabyte|billions?\s+of rows|high throughput|low latency|memory optimization|performance optimization)\b/i.test(
      combinedText,
    );
  const dataInfraCoreContext =
    infraCoreRole ||
    /\b(data infrastructure|analytics infrastructure|data platform|stats?\s*(and|&)\s*analytics|metrics platform|analytics engine)\b/i.test(
      combinedText,
    );
  const hasGoMention = textMentionsGoLanguage(combinedText);
  const goDistributedDataInfraRole =
    hasGoMention &&
    (goPrimaryBackend || dataInfraCoreContext) &&
    (dataInfraStreaming || dataWarehouseAnalytics || specializedDataStores) &&
    (microservicesHeavy || largeDataPerf || dataInfraStreaming || dataWarehouseAnalytics) &&
    !researchHeavyAiRole &&
    !credentialHeavyFintechAlgorithm;
  const apprenticeshipDataInfraOk =
    /\b(apprenticeship|apprentice\s+program|new\s+grad\s+program|graduate\s+program|training\s+program|rotational\s+program|engineering\s+residency|intern\s+to\s+full)\b/i.test(
      combinedText,
    );
  const goDistributedDataInfraCandidateGap =
    goDistributedDataInfraRole &&
    !profileHasGoDataInfraProductionEvidence(profile) &&
    !apprenticeshipDataInfraOk;
  const associateEntryRole =
    /\b(associate|entry[-\s]?level|early[-\s]?career|junior|new grad|new graduate)\b/i.test(combinedText);
  const preferredPlatformStackGap =
    /\b(preferred|nice to have|plus)\b[^.\n]{0,180}\b(graphql|docker|kubernetes|cloud)\b/i.test(combinedText) ||
    /\b(graphql|docker|kubernetes|cloud)\b[^.\n]{0,120}\b(preferred|nice to have|plus)\b/i.test(combinedText) ||
    goMentionedAsPreferred(combinedText);

  const productionOwnershipJd =
    /\b(production ownership|meaningful scope|on[-\s]?call|end[-\s]?to[-\s]?end|own(s|\s+the)?\s+(the\s+)?(features?|roadmap|slice|technical|service|area|product)|technical ownership|operate in production|production systems?|ship(ped|ping)?[^.\n]{0,60}production)\b/i.test(
      combinedText,
    );
  const twoPlusProfessionalBar =
    (job.yearsExperience?.min ?? 0) >= 2 ||
    (/\b(2\+|3\+|4\+|at\s+least\s+2|minimum\s+of\s+2|2\s*[-–]\s*6|2\s+to\s+6)\s*years?\b/i.test(combinedText) &&
      /\b(professional|commercial|software engineering|engineering experience|years of experience)\b/i.test(
        combinedText,
      ));
  const competitiveHiringContext =
    /\b(charlie\s+health|liveperson)\b/i.test(companyNorm) ||
    /\b(liveperson|charlie\s+health)\b/i.test(combinedText) ||
    /\b(series\s+[bcd]|unicorn|post[-\s]?ipo|public(?:ly)?\s+traded)\b/i.test(combinedText) ||
    /\b(competitive\s+(applicant|candidate|talent|pool|salary)|high\s+bar|best[-\s]?in[-\s]?class|top\s+engineers?)\b/i.test(
      combinedText,
    ) ||
    (healthcareProductEngineering &&
      /\b(series\s+[ab]|well[-\s]?funded|growth|scaling|mature)\b/i.test(combinedText)) ||
    isTraditionalCompany ||
    isFinance ||
    /\b(fortune\b|enterprise\s+saas|global\s+scale)\b/i.test(combinedText);
  const competitivePoolSignals = detectCompetitivePoolSignals(job, combinedText);
  const productionBarCompetitivePool =
    (!earlyCareerFriendlyRole &&
      !associateEntryRole &&
      !researchHeavyAiRole &&
      !credentialHeavyFintechAlgorithm &&
      !foundingEngineerStretch &&
      !goDistributedDataInfraCandidateGap &&
      productionOwnershipJd &&
      twoPlusProfessionalBar &&
      competitiveHiringContext) ||
    competitivePoolSignals.signalCount >= 3;

  const jdDutiesText = normalizeText(
    [...(job.requirements ?? []), ...(job.responsibilities ?? [])].join("\n"),
  );
  const productionRigorInDuties =
    /\b(production ownership|meaningful scope|on[-\s]?call|end[-\s]?to[-\s]?end|own(s|\s+the)?\s+(the\s+)?(features?|roadmap|slice|technical|service|area|product)|technical ownership|operate in production|production systems?|ship(ped|ping)?[^.\n]{0,60}production|reliability|slo|incident|operational maturity|scale)\b/i.test(
      jdDutiesText,
    );
  const paymentsOrFintechInDuties =
    /\b(plaid|stripe|fintech|payments|banking[-\s]?api|financial infrastructure|payment)\b/i.test(
      jdDutiesText,
    );

  if (degreeConflictingRequirement) {
    notes.push(
      'JD conflicts on the degree: one line requires a specific degree, another allows equivalent experience — expect the specific line to drive screening.',
    );
  } else if (degreeRequiredSignal && degreeHasEquivalencyClause && !degreeEquivalencySatisfied) {
    notes.push(
      'Degree mentioned but JD allows equivalent, project, or bootcamp experience — treat as a soft screen note, not a hard gate.',
    );
  }
  if (degreeEquivalencySatisfied) {
    notes.push(
      'JD lists degree paths but candidate satisfies an accepted alternate credential (associate and/or certificate-in-lieu).',
    );
  }
  if (credentialHeavyFintechAlgorithm) {
    penaltyVector.credentialHeavy = 30;
    notes.push(
      'Explicit CS degree requirement is a major screen risk.',
      'Role requires finance/accounting workflow experience, including GAAP and ASC 606, which is not demonstrated.',
      'JD asks for Java/C++ style OOP and algorithm-publication evidence, which do not match the current profile.',
    );
  }
  if (explicitDegreeRisk) {
    penaltyVector.degree =
      isTraditionalCompany || strictNewGradPipeline
        ? scoringPolicy.hardPenalties.degreeRequiredTraditional
        : scoringPolicy.hardPenalties.degreeRequiredGeneral;
  }
  if (isTraditionalCompany) {
    penaltyVector.traditional = 4;
    notes.push(
      'Traditional employer signal suggests stricter screening behavior.',
    );
  }
  if (isFinance && !fintechGoPrimaryStretch) {
    penaltyVector.finance = 5;
    notes.push('Finance/banking role context typically screens more strictly.');
  } else if (fintechGoPrimaryStretch) {
    penaltyVector.finance = 5;
    const domainCite = citeFintechDomainSpan(job, combinedText);
    notes.push(
      `No prior experience matching this JD's "${domainCite}" focus may create a steeper ramp and stricter screening.`,
    );
  }
  if (strictNewGradPipeline) {
    penaltyVector.newGrad = scoringPolicy.hardPenalties.newGradPipelineMismatch;
    notes.push(
      'Traditional new-grad / campus pipeline language appears mismatched to target profile.',
    );
  } else if (earlyCareerFriendlyRole) {
    penaltyVector.earlyCareerSoft =
      scoringPolicy.hardPenalties.earlyCareerSoftMismatch;
    notes.push(
      'Early-career framing adds junior-screen realism without a harsh pipeline gate.',
    );
  }
  if (seniorityOverreach) {
    penaltyVector.seniority = scoringPolicy.hardPenalties.seniorityOverreach;
    const depthCite = citeSeniorDepthSpan(job);
    const band =
      resolveStructuredSeniorityLevel(job) || job.seniority?.trim() || 'senior/staff';
    const titleBit = job.title?.trim() ? ` for "${job.title.trim()}"` : '';
    notes.push(
      depthCite
        ? `JD Required cites "${depthCite}"${titleBit}, which may exceed the early-career profile for recruiter screen.`
        : `JD seniority (${band})${titleBit} may exceed the early-career profile for recruiter screen.`,
    );
  } else if (seniorityStretch) {
    penaltyVector.seniority = COMPOSITE_SCORING.SENIORITY_STRETCH_DOCK;
    notes.push(
      `Title${job.title?.trim() ? ` "${job.title.trim()}"` : ''      } reads senior, but the JD asks for no 5+ years, senior-depth, or people-leadership experience — ambitious stretch (level fit capped at ${levelFitCeilingForSeniorityDock(COMPOSITE_SCORING.SENIORITY_STRETCH_DOCK)}/20), not a hard gate.`,
    );
  }
  if (locationMismatch) {
    penaltyVector.location = scoringPolicy.hardPenalties.locationMismatch;
  }
  if (visaMismatch) {
    penaltyVector.visa = scoringPolicy.hardPenalties.sponsorshipMismatch;
    notes.push(
      'Visa/sponsorship language indicates risk for first-pass progression.',
    );
  }
  if (citizenshipMismatch) {
    penaltyVector.citizenship = scoringPolicy.hardPenalties.citizenshipMismatch;
    notes.push('Citizenship requirement is a likely hard gate.');
  }
  if (clearanceMismatch) {
    penaltyVector.clearance = scoringPolicy.hardPenalties.clearanceMismatch;
    notes.push('Security clearance requirement is a likely hard gate.');
  }
  if (stackMismatch) {
    penaltyVector.stack = scoringPolicy.hardPenalties.stackMismatch;
    notes.push(
      `Required core language gap: ${coreLanguageGap.join(', ')} — not in claimable stack.`,
    );
  } else if (adjacentFrameworkGap.length > 0) {
    notes.push(
      `Adjacent framework gap (${adjacentFrameworkGap.join(', ')}) — same language family, learnable stretch.`,
    );
  } else if (infraStackShapeMismatch) {
    penaltyVector.stack = scoringPolicy.hardPenalties.stackMismatch;
    notes.push('Core technical story does not align with role stack shape (infra/SRE).');
  } else if (associateEntryRole && preferredPlatformStackGap) {
    const jdLangs = filterLanguagesToJdPresence(["Go"], job);
    const goNote = jdLangs.includes("Go")
      ? "Preferred Go/GraphQL/platform stack is not the candidate's strongest lane, but baseline backend expectations appear accessible."
      : "Preferred GraphQL/platform stack is not the candidate's strongest lane, but baseline backend expectations appear accessible.";
    notes.push(goNote);
  } else if (backendProductApiRole && !infraCoreRole) {
    const companyLabel = job.company?.trim() || 'This company';
    const backendApiGroundingText = jdDutiesText.replace(
      /\b(ai\s+apis?|api\s+management)\b/gi,
      " ",
    );
    const backendOrApiInDuties =
      /\b(backend|rest|graphql|microservices?|infra(?:structure)?|serverside|server[-\s]?side)\b/i.test(
        backendApiGroundingText,
      ) ||
      /\b(build|develop|design|implement|maintain|own|ship)\b[^.\n]{0,80}\bapis?\b/i.test(
        backendApiGroundingText,
      ) ||
      /\bapis?\b[^.\n]{0,80}\b(build|develop|design|implement|maintain|own|ship|services?)\b/i.test(
        backendApiGroundingText,
      );
    // Require payments/fintech + rigor language in Required/Responsibilities —
    // do not infer a mature payments hiring bar from company/industry alone.
    if (paymentsOrFintechInDuties && productionRigorInDuties) {
      const payCite =
        firstJdMatch(jdDutiesText, [
          /\b(payment(?:s)?\s+(?:platform|infrastructure|processing|flows?|systems?|apis?|product))\b/i,
          /\b(fintech|financial infrastructure|banking api|issuing)\b/i,
          /\bpayments?\b/i,
        ]) ?? citeFintechDomainSpan(job, jdDutiesText);
      const rigorCite = citeProductionRigorSpan(jdDutiesText);
      notes.push(
        `${companyLabel} Required/Responsibilities mention "${payCite}" alongside "${rigorCite}" — screeners may probe production reliability and backend fundamentals for this listing.`,
      );
    } else if (backendOrApiInDuties) {
      const apiCite = citeBackendApiSpan(backendApiGroundingText);
      notes.push(
        `${companyLabel} Required/Responsibilities mention "${apiCite}" — screeners may still probe scale and fundamentals without treating this as pure platform engineering.`,
      );
    }
  } else if (infraCoreRole) {
    notes.push(
      'Role appears platform/infra-core; deeper production infra background may be screened more strictly.',
    );
  }
  if (domainMismatch) {
    penaltyVector.domain = scoringPolicy.hardPenalties.domainMismatch;
    notes.push('Specialized domain requirements look materially mismatched.');
  }
  if (startupFounderMismatch) {
    penaltyVector.founding = scoringPolicy.hardPenalties.startupFounderMismatch;
    notes.push(
      'Founding-style expectations do not match strongest current story.',
    );
  }
  if (foundingEngineerStretch) {
    penaltyVector.foundingStretch = Math.max(penaltyVector.foundingStretch ?? 0, 10);
    notes.push(
      'Founding engineer role may require more independent production ownership and architectural judgment than the profile clearly demonstrates.',
    );
    if (healthcareOpsComplexity) {
      notes.push(
        'Healthcare AI workflows may involve clinical, compliance, and operational complexity that could create a steeper ramp.',
      );
    }
    notes.push('Early-stage team may offer limited mentorship or structure.');
  }
  if (researchHeavyAiRole) {
    penaltyVector.research = 15;
    notes.push(
      'Role is research-heavy and asks for self-constructing systems, meta-learning, program synthesis, and agent architecture research not clearly demonstrated in the current profile.',
    );
    notes.push(
      'Proven track record of research results is a major recruiter-screen gap.',
    );
  }
  if (fintechGoPrimaryStretch && goPrimaryBackend) {
    notes.push(
      'Go-primary backend expectations are outside the strongest TypeScript/Node lane and are a major stack caveat.',
    );
  }
  if (productionBarCompetitivePool && productionRigorInDuties) {
    const rigorCite = citeProductionRigorSpan(jdDutiesText);
    notes.push(
      `JD Required/Responsibilities cite "${rigorCite}" in a competitive hiring context — keep recruiter-screen realism conservative unless the profile matches this listing's stack details and production depth.`,
    );
  }
  if (goDistributedDataInfraCandidateGap) {
    penaltyVector.dataInfraGo = 20;
    notes.push(
      'Go-first distributed data infrastructure role with streaming and analytics databases outside strongest TypeScript/Node lane.',
      'Requires production-scale backend/data systems experience, including Kafka/Kinesis and warehouse/analytics technologies not demonstrated.',
    );
    if (
      /\b(adtech|advertising\s+technology|programmatic|dsp|ssp|real[-\s]?time bidding|rtb|bidder)\b/i.test(
        combinedText,
      )
    ) {
      notes.push('Adtech analytics domain and optimization-heavy technical screen may be a poor fit.');
    }
  }

  const pythonStackFlexibleWithJsTs = jdPythonFlexibleWithJsOrTs(combinedText);

  const fdeBuilderSoftwarePrimary = isFdeBuilderSoftwarePrimaryShape(job);
  if (fdeBuilderSoftwarePrimary) {
    notes.push(
      'Forward-deployed / growth title without strong external customer-implementation JD — default builder-first SWE screen story (SIE only as secondary angle).',
    );
  }

  const titleRespSeniority = evaluateTitleResponsibilitySeniority(job);
  const titleResponsibilityMismatch = titleRespSeniority.mismatch;
  const highOwnershipLowSupport = titleRespSeniority.highOwnershipLowSupport;
  if (titleResponsibilityMismatch && titleRespSeniority.mismatchRiskNote) {
    notes.unshift(titleRespSeniority.mismatchRiskNote);
  }
  if (highOwnershipLowSupport && titleRespSeniority.highOwnershipLowSupportNote) {
    notes.push(titleRespSeniority.highOwnershipLowSupportNote);
  }

  const reinforcedFloor = detectReinforcedExperienceFloor(job);
  const candidateYears = estimateCandidateProfessionalYears({
    profile,
    resumeText: resumeRaw,
  });
  const reinforcedExperienceFloor =
    reinforcedFloor.active &&
    (candidateYears == null || candidateYears < reinforcedFloor.thresholdYears);
  if (reinforcedExperienceFloor && reinforcedFloor.riskNote) {
    notes.push(reinforcedFloor.riskNote);
  }
  const experienceGap = computeExperienceGap(job, profile, {
    floorAlreadyDocked: reinforcedExperienceFloor,
  });
  if (experienceGap) penaltyVector.experience = experienceGap.dock;

  const productionInfraGap = detectProductionInfraOwnershipGap({
    job,
    resumeText: resumeRaw,
    claimable,
  });
  const productionInfraOwnershipGap = productionInfraGap.active;
  if (productionInfraOwnershipGap && productionInfraGap.riskNote) {
    notes.push(productionInfraGap.riskNote);
  }

  const coreLang = analyzeCoreLanguageRequirement(job, profile, claimable);
  const ventureFundedStartup = isVentureFundedStartupShape(job, combinedText);
  const matureStructuredEmployer =
    !ventureFundedStartup &&
    (isMatureStructuredEmployer(job.company ?? '', combinedText) || harshEmployerContext);
  const explicitCoreLanguageMismatch =
    matureStructuredEmployer &&
    coreLang.explicitHardRequirement &&
    !coreLang.candidateHasProductionLanguage &&
    !disjunctiveLanguage.satisfied;
  const knownStrongEmployer =
    /\b(google|alphabet|meta|facebook|amazon|aws|microsoft|apple|netflix|uber|spotify|salesforce|oracle|ibm|stripe|airbnb|databricks|palantir|openai|anthropic|goldman|jpmorgan|jp\s*morgan|bloomberg)\b/i.test(
      companyNorm,
    );
  const startupOrWeakEmployerShape =
    /\b(seed|series\s+[ab]|pre-seed|stealth|early-stage|early stage|startup|founding team|y\s*combinator|yc\s*backed)\b/i.test(
      combinedText,
    );
  const unknownWeakEmployer =
    !knownStrongEmployer && (startupOrWeakEmployerShape || companyNorm.length < 36);
  const entryLevelAiSignals =
    earlyCareerFriendlyRole ||
    (job.yearsExperience?.min ?? 99) <= 2 ||
    /\b(intern|internship|associate\s+engineer|junior|entry[-\s]?level)\b/i.test(combinedText);
  const vagueEarlyStageAiCalibration =
    !harshEmployerContext &&
    jdHasAppliedAiSystemsOverlap(combinedText) &&
    jdIsStructurallyVague(job) &&
    unknownWeakEmployer &&
    entryLevelAiSignals;
  if (vagueEarlyStageAiCalibration) {
    notes.push(
      'Vague or thin JD for an entry-level AI posting at a non-name employer — scores calibrated down for generic-posting inflation.',
    );
  }

  const hardRuleNotes: string[] = [];
  if (locationMismatch) {
    hardRuleNotes.push('Onsite/hybrid requirement appears non-commutable.');
  }
  if (credentialHeavyFintechAlgorithm) {
    hardRuleNotes.push(
      'Credentialed fintech/accounting-systems gates (CS degree, GAAP/ASC 606, publication-style depth) are likely hard screens.',
    );
  } else if (explicitDegreeRisk) {
    hardRuleNotes.push('Explicit degree requirement may be a first-pass recruiter filter.');
  }
  if (explicitCoreLanguageMismatch && coreLang.language) {
    hardRuleNotes.push(explicitCoreLanguageRiskSummary(coreLang.language));
  } else if (stackMismatch && coreLanguageGap.length > 0) {
    hardRuleNotes.push(
      `Required core stack gap (${coreLanguageGap.join(', ')}) — major recruiter-screen risk.`,
    );
  }

  const geoEligibility = evaluateGeoEligibility(job, profile);
  if (geoEligibility.eligibilityFlag) {
    notes.push(geoEligibility.eligibilityFlag.reason);
  }
  if (clearanceCitizenship.clearanceEligibilityFlag) {
    notes.push(clearanceCitizenship.clearanceEligibilityFlag.reason);
  }

  if (jdDegreePositive) {
    notes.push(
      'Degree-positive JD: employer welcomes non-degree / show-the-work candidates — credential drag neutralized.',
    );
  }
  if (jdProhibitsGenAIContent) {
    notes.push(
      'Employer restricts GenAI-generated application content — use drafts as outlines only.',
    );
  }

  return {
    explicitDegreeRisk,
    degreeHasEquivalencyClause,
    degreeConflictingRequirement,
    degreeEquivalencySatisfied,
    jdDegreePositive,
    jdProhibitsGenAI: jdProhibitsGenAIContent,
    traditionalCompanyPenalty: isTraditionalCompany,
    financePenalty: isFinance,
    strictNewGradPipeline,
    earlyCareerFriendlyRole,
    newGradPenalty: strictNewGradPipeline,
    seniorityOverreach,
    seniorityStretch,
    experienceGap,
    locationMismatch,
    visaMismatch,
    citizenshipMismatch,
    clearanceMismatch,
    stackMismatch,
    coreLanguageGap,
    adjacentFrameworkGap,
    infraStackShapeMismatch,
    domainMismatch,
    startupFounderMismatch,
    matureStructuredEmployer,
    explicitCoreLanguageMismatch,
    explicitCoreLanguage: explicitCoreLanguageMismatch ? coreLang.language : null,
    fdeBuilderSoftwarePrimary,
    pythonStackFlexibleWithJsTs,
    healthcareProductEngineering,
    backendProductApiRole,
    infraCoreRole,
    vagueEarlyStageAiCalibration,
    researchHeavyAiRole,
    fintechGoPrimaryStretch,
    foundingEngineerStretch,
    titleResponsibilityMismatch,
    highOwnershipLowSupport,
    reinforcedExperienceFloor,
    reinforcedExperienceFloorLineCount: reinforcedFloor.reinforcingLineCount || undefined,
    reinforcedExperienceFloorThreshold: reinforcedFloor.active
      ? reinforcedFloor.thresholdYears
      : undefined,
    productionInfraOwnershipGap,
    earlyCareerExceedSeverityRisk: false,
    scoringRiskScoreInconsistency: false,
    credentialHeavyFintechAlgorithm,
    productionBarCompetitivePool,
    goDistributedDataInfraRole,
    goDistributedDataInfraCandidateGap,
    disjunctiveLanguageRequirementSatisfied: disjunctiveLanguage.satisfied,
    disjunctiveAcceptedLanguages: disjunctiveLanguage.acceptedLabels,
    eligibilityFlag: geoEligibility.eligibilityFlag,
    clearanceEligibilityFlag: clearanceCitizenship.clearanceEligibilityFlag,
    clearanceRequiresExistingPenalty: clearanceCitizenship.clearanceRequiresExistingPenalty,
    geoExclusionHardGate: geoEligibility.geoExclusionHardGate,
    geoExclusionReason: geoEligibility.geoExclusionReason,
    hardRuleNotes,
    namedHardRequirementGaps,
    notes: [...new Set(notes)],
    penaltyVector,
  };
};

export const isLikelyTraditionalEmployer = (job: ExtractedJobData): boolean => {
  const blob = normalizeText(
    `${job.company} ${job.title} ${(job.domainTags ?? []).join(' ')} ${job.rawText ?? ''}`,
  );
  return detectTraditionalEmployerContextStrict(blob, normalizeText(job.company ?? ''));
};
