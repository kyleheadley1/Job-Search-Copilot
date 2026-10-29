import {
  ADJACENT_ROLE_FUNCTION,
  FRONTEND_PRIMARY_ROLE,
  PLATFORM_INFRA_ROLE,
} from "../config/capabilitySurvivabilityPolicy.js";
import type { ExtractedJobData } from "../types/job.js";
import type {
  AdjacentRoleFunctionKind,
  CapabilityBreakdown,
  RoleLaneLabel,
} from "../types/scoring.js";
import {
  countStrongSieRoleDescriptorHits,
  hasBuilderFirstSoftwareContext,
  isFdeBuilderSoftwarePrimaryShape,
} from "./fdeBuilderRole.js";
import { structuredFirstJobBlob } from "./structuredFirstJobBlob.js";
import { normalizeMatcherText, normalizeText } from "./text.js";

export type { AdjacentRoleFunctionKind, RoleLaneLabel };

export type RoleLaneClassification = {
  label: RoleLaneLabel;
  adjacentKind: AdjacentRoleFunctionKind | null;
  note: string;
};

export type RoleFunctionClassification = {
  detected: boolean;
  kind: AdjacentRoleFunctionKind | null;
  label: string | null;
  note: string;
  sieResumeSignal: boolean;
};

export type FrontendPrimaryClassification = {
  detected: boolean;
  note: string;
};

export type PlatformInfraClassification = {
  detected: boolean;
  note: string;
};

const jobBlob = (job: ExtractedJobData): string => structuredFirstJobBlob(job);

const ADJACENT_TITLE_PATTERNS: Array<{ kind: AdjacentRoleFunctionKind; pattern: RegExp }> = [
  { kind: "implementation_analyst", pattern: /\b(?:technical\s+)?implementation\s+analyst\b/i },
  { kind: "business_systems_analyst", pattern: /\bbusiness\s+systems?\s+analyst\b/i },
  { kind: "qa_engineer", pattern: /\bqa\s+engineer\b/i },
  { kind: "solutions_engineer", pattern: /\bsolutions\s+engineer\b/i },
  { kind: "technical_analyst", pattern: /\btechnical\s+analyst\b/i },
  { kind: "sales_engineer", pattern: /\bsales\s+engineer\b/i },
];

const ANALYST_CORE_PATTERNS: RegExp[] = [
  /\brequirements?\s+doc(?:umentation)?\b/i,
  /\bfunctional\s+requirements?\b/i,
  /\btest\s+plans?\b/i,
  /\bqa\s+test\b/i,
  /\buat\b/i,
  /\buser\s+acceptance\b/i,
  /\bstakeholder\s+coordination\b/i,
  /\bcross[-\s]?functional\s+coordination\b/i,
  /\bimplementation\s+support\b/i,
  /\bconfiguration\s+and\s+testing\b/i,
  /\bvalidate\s+(?:api|integration|system)\b/i,
  /\bapi\s+validat(?:e|ion)\b/i,
  /\bintegration\s+validat(?:e|ion)\b/i,
  /\bprocess\s+documentation\b/i,
  /\bbusiness\s+analysis\b/i,
  /\bworkflow\s+mapping\b/i,
];

const SOFTWARE_BUILDING_PATTERNS: RegExp[] = [
  /\b(?:build|develop|write|ship|own|design|implement)\s+(?:and\s+)?(?:software|code|features?|systems?|services?|applications?)\b/i,
  /\bsoftware\s+engineer(?:ing)?\b/i,
  /\bbackend\s+engineer\b/i,
  /\bfull[-\s]?stack\s+engineer\b/i,
  /\bplatform\s+engineer\b/i,
  /\bproduction\s+code\b/i,
  /\b(?:build|develop|implement).{0,40}\b(?:api|rest|graphql|microservice)\b/i,
  /\b(?:api|rest|graphql|microservice).{0,40}\b(?:build|develop|implement|design|own)\b/i,
];

const QA_AS_PRODUCT_RE =
  /\b(testing as a service|test automation service|managed qa|quality assurance services?|qa wolf|scalence)\b/i;

const CORE_SWE_TITLE_RE =
  /\b(software engineer|backend engineer|full[-\s]?stack engineer|platform engineer|product engineer|machine learning engineer|ai engineer)\b/i;

const FRONTEND_TITLE_RE =
  /\b(front[\s-]?end(?:\s+engineer|\s+developer)?|frontend(?:\s+engineer|\s+developer)?|ui\s+engineer|ui\s+developer|web\s+design\s+engineer|design\s+engineer|(?:ui|ux)\/(?:ui|ux)\s+engineer)\b/i;

const FULL_STACK_OR_BACKEND_TITLE_RE =
  /\b(full[\s-]?stack|back[\s-]?end(?:\s+engineer|\s+developer)?|backend(?:\s+engineer|\s+developer)?)\b/i;

const FRONTEND_WORK_PATTERNS: RegExp[] = [
  /\bbuild(?:ing)?\s+ui\b/i,
  /\bui\s+components?\b/i,
  /\btranslate\s+ux\b/i,
  /\bux\s+designs?\b/i,
  /\bresponsive\s+design\b/i,
  /\baccessibility\b/i,
  /\bcross[\s-]?browser\b/i,
  /\bdesign\s+systems?\b/i,
  /\bcomponent\s+library\b/i,
  /\b(ui|user)\s+interface\b/i,
  /\bcustomer[\s-]?facing\s+(?:ui|react|components?)\b/i,
  /\bfrontend\s+(?:product|features?|systems?|engineering|reliability|architecture)\b/i,
  /\breact\s+(?:components?|applications?|native)\b/i,
  /\bpolished\s+(?:ux|ui)\b/i,
  /\bfigma\b/i,
  /\bpixel[-\s]?perfect\b/i,
  /\bvisual\s+design\b/i,
];

const BACKEND_BUILDING_PATTERNS: RegExp[] = [
  /\b(?:build|design|develop|implement|create|own|ship).{0,48}\b(?:apis?|rest\s+apis?|graphql|microservices?|backend\s+services?)\b/i,
  /\b(?:apis?|rest\s+apis?|graphql|microservices?).{0,48}\b(?:build|design|develop|implement|own|services?)\b/i,
  /\bback[\s-]?end\s+development\b/i,
  /\bserver[\s-]?side\b/i,
  /\bdata\s+models?\b/i,
  /\bbackend\s+services?\b/i,
  /\b(?:node\.?js|express).{0,40}\b(?:backend|apis?|services?)\b/i,
];

const API_CONSUMPTION_PATTERNS: RegExp[] = [
  /\bintegrat(?:e|ing|ion)\s+with\b[^.\n]{0,40}\b(?:backend\s+)?(?:apis?|rest|graphql|services?)\b/i,
  /\bconsum(?:e|ing)\s+(?:apis?|rest|graphql)\b/i,
  /\bconnect(?:ing)?\s+(?:the\s+)?frontend\s+to\s+(?:services?|apis?|backends?)\b/i,
  /\bwork(?:ing)?\s+with\b[^.\n]{0,40}\b(?:apis?|node\.?js\s+services?)\b/i,
  /\bpartner\s+closely\s+with\s+backend\b/i,
];

const PLATFORM_INFRA_TITLE_RE =
  /\b(core\s+compute\s+platform|platform\s+engineer(?:ing)?|infrastructure\s+engineer|site\s+reliability|sre\b|devops\s+engineer|developer\s+experience|developer\s+platform|platform\s+infrastructure|compute\s+platform)\b/i;

const PLATFORM_ENABLEMENT_PATTERNS: RegExp[] = [
  /\bdeveloper\s+enablement\b/i,
  /\breusable\s+sdks?\b/i,
  /\bplatform\s+interfaces?\b/i,
  /\breduce(?:s|ing)?\s+engineer\s+cognitive\s+load\b/i,
  /\bcognitive\s+load\b/i,
  /\bself[\s-]?serve\s+platform\b/i,
  /\binternal\s+(?:developers?|engineering\s+teams?|product\s+engineering)\b/i,
  /\bconsumed\s+by\s+other\s+engineers?\b/i,
  /\benables?\s+product\s+engineering\b/i,
  /\bdeveloper\s+experience\b/i,
  /\bplatform\s+services?\b/i,
  /\bkubernetes\s+platform\b/i,
  /\binfrastructure\s+as\s+code\b/i,
  /\bterraform\b/i,
];

/** Infrastructure work itself, as opposed to merely using cloud services. */
const INFRA_CORE_PATTERNS: RegExp[] = [
  /\bkubernetes\b|\bk8s\b/i,
  /\bterraform\b|\binfrastructure[\s-]as[\s-]code\b|\biac\b/i,
  /\bnetworking\b|\bservice\s+mesh\b/i,
  /\bobservability\b|\bmonitoring\s+(?:and|&)\s+alerting\b/i,
  /\bsite\s+reliability\b|\bsre\b|\bon[\s-]?call\b/i,
  /\b(?:cloud|platform|core)\s+infrastructure\b|\binfrastructure\s+platform\b/i,
  /\b(?:internal\s+)?developer\s+platform\b/i,
  /\bdeploy(?:ment)?\s+(?:systems?|pipelines?|tooling|infrastructure)\b|\bci\/cd\b/i,
  /\bdistributed\s+systems?\b|\bclusters?\b/i,
  /\bcontainer(?:s|ization)?\b|\bdocker\b/i,
];

/** Product-builder work: UI, user experience, AI features, end-to-end feature ownership. */
const PRODUCT_BUILDER_PATTERNS: RegExp[] = [
  /\breact(?:js|\.js)?\b|\bfront[\s-]?end\b/i,
  /\buser\s+experiences?\b|\bux\b/i,
  /\bproduct\s+experiences?\b|\bproduct[\s-]minded\b|\bai[\s-]powered\s+(?:products?|features?|experiences?)\b/i,
  /\bllms?\b|\blarge\s+language\s+models?\b/i,
  /\bend[\s-]to[\s-]end\b|\bown(?:ing)?\s+features?\b|\bship(?:ping)?\s+fast\b/i,
];

const PRODUCT_USER_FACING_PATTERNS: RegExp[] = [
  /\bcustomer[\s-]?facing\b/i,
  /\bend[\s-]?users?\b/i,
  /\bship(?:ping|s)?\s+(?:to\s+)?(?:users?|customers?|readers?)\b/i,
  /\buser[\s-]?facing\s+(?:product|features?|apps?|applications?)\b/i,
  /\bconsumer\s+(?:product|app|experience)\b/i,
  /\bfull[\s-]?stack\b/i,
];

const countPatternHits = (patterns: RegExp[], blob: string): number =>
  patterns.reduce((count, pattern) => {
    pattern.lastIndex = 0;
    return count + (pattern.test(blob) ? 1 : 0);
  }, 0);

const matchAdjacentTitle = (
  title: string,
): { kind: AdjacentRoleFunctionKind; label: string } | null => {
  for (const { kind, pattern } of ADJACENT_TITLE_PATTERNS) {
    const match = title.match(pattern);
    if (match?.[0]) {
      return { kind, label: match[0].trim() };
    }
  }
  return null;
};

export const hasSiePrimaryResumeSignal = (job: ExtractedJobData): boolean => {
  const blob = jobBlob(job);
  const strongSie = countStrongSieRoleDescriptorHits(blob) >= 2;
  const builderFirst = hasBuilderFirstSoftwareContext(blob) || isFdeBuilderSoftwarePrimaryShape(job);
  return strongSie && !builderFirst;
};

/** Short heading lines from the JD — used when extracted title omitted "Front-End". */
const headingTitleLines = (job: ExtractedJobData): string[] => {
  const lines: string[] = [];
  if (job.title?.trim()) lines.push(job.title.trim());
  for (const raw of (job.rawText ?? "").split(/\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (line.length > 70 || /[.!?]/.test(line)) continue;
    lines.push(line);
    if (lines.length >= 8) break;
  }
  return lines;
};

const lineLooksFrontendTitle = (value: string, requireEngineerToken = false): boolean => {
  const title = normalizeMatcherText(value);
  const matched =
    FRONTEND_TITLE_RE.test(title) ||
    /\bsoftware engineer,\s*frontend\b/i.test(value) ||
    /\bassociate software engineer,\s*frontend\b/i.test(value);
  if (!matched) return false;
  if (requireEngineerToken && !/\b(engineer|developer)\b/i.test(value)) return false;
  return true;
};

export const classifyFrontendPrimaryRole = (
  job: ExtractedJobData,
): FrontendPrimaryClassification => {
  const title = normalizeMatcherText(job.title ?? "");
  const blob = jobBlob(job);
  const matcherBlob = normalizeMatcherText(blob);
  const headings = headingTitleLines(job);

  if (
    FULL_STACK_OR_BACKEND_TITLE_RE.test(title) &&
    !headings.some((line, index) => lineLooksFrontendTitle(line, index > 0))
  ) {
    return { detected: false, note: "" };
  }

  const titleIsFrontend = headings.some((line, index) => lineLooksFrontendTitle(line, index > 0));

  if (!titleIsFrontend) {
    return { detected: false, note: "" };
  }

  const frontendHits = countPatternHits(FRONTEND_WORK_PATTERNS, blob);
  const backendBuildHits = countPatternHits(BACKEND_BUILDING_PATTERNS, blob);
  const consumptionHits = countPatternHits(API_CONSUMPTION_PATTERNS, blob);

  const backendBuildingDominant =
    backendBuildHits >= 2 && backendBuildHits > consumptionHits && frontendHits < 2;
  const titleIsExplicitFrontend = headings.some((line, index) => lineLooksFrontendTitle(line, index > 0));

  // A Front-End Engineer title stays frontend unless the body has no UI work at all.
  if (titleIsExplicitFrontend && (frontendHits >= 1 || consumptionHits >= 1 || backendBuildHits < 3)) {
    return {
      detected: true,
      note: FRONTEND_PRIMARY_ROLE.FLAG,
    };
  }

  if (backendBuildingDominant) {
    return { detected: false, note: "" };
  }

  if (frontendHits >= 1 || backendBuildHits === 0 || consumptionHits >= 1) {
    return {
      detected: true,
      note: FRONTEND_PRIMARY_ROLE.FLAG,
    };
  }

  if (titleIsFrontend && !/\bfull[\s-]?stack\b/.test(matcherBlob) && backendBuildHits < 2) {
    return {
      detected: true,
      note: FRONTEND_PRIMARY_ROLE.FLAG,
    };
  }

  return { detected: false, note: "" };
};

/**
 * Platform/infra role: title/core function is Platform/SRE/DevOps/infra; work enables
 * other engineers. Must NOT fire on product roles that merely mention AWS/backend.
 */
export const classifyPlatformInfraRole = (job: ExtractedJobData): PlatformInfraClassification => {
  const title = job.title?.trim() ?? "";
  const blob = jobBlob(job);
  const titleMatch =
    PLATFORM_INFRA_TITLE_RE.test(title) ||
    PLATFORM_INFRA_TITLE_RE.test(normalizeMatcherText(title));

  const enablementHits = countPatternHits(PLATFORM_ENABLEMENT_PATTERNS, blob);
  const productHits = countPatternHits(PRODUCT_USER_FACING_PATTERNS, blob);
  const infraHits = countPatternHits(INFRA_CORE_PATTERNS, blob);
  const builderHits = countPatternHits(PRODUCT_BUILDER_PATTERNS, blob);
  const platformSignals = enablementHits + infraHits;

  if (productHits >= 2 && productHits > enablementHits) {
    return { detected: false, note: "" };
  }

  // "AI Platform Engineer" building React + LLM product features is product work, whatever the title.
  if (builderHits >= 3 && platformSignals < 2) {
    return { detected: false, note: "" };
  }

  if (titleMatch && platformSignals >= 1) {
    return { detected: true, note: PLATFORM_INFRA_ROLE.FLAG };
  }

  if (!titleMatch && enablementHits >= 3 && productHits === 0) {
    return { detected: true, note: PLATFORM_INFRA_ROLE.FLAG };
  }

  return { detected: false, note: "" };
};

/**
 * Adjacent non-product-SWE roles (analyst / QA-as-a-service / solutions).
 * Same shape as frontend-primary / platform-infra: title as core function +
 * responsibilities language. SIE resume signal is corroborating only.
 * (Unified taxonomy deferred to Item G / Tier 4.)
 */
export const classifyRoleFunction = (job: ExtractedJobData): RoleFunctionClassification => {
  const blob = jobBlob(job);
  const title = job.title?.trim() ?? "";
  const titleMatch = matchAdjacentTitle(title);
  const analystSignals = countPatternHits(ANALYST_CORE_PATTERNS, blob);
  const buildingSignals = countPatternHits(SOFTWARE_BUILDING_PATTERNS, blob);
  const sieResumeSignal = hasSiePrimaryResumeSignal(job);
  const qaAsProduct =
    QA_AS_PRODUCT_RE.test(blob) ||
    (/\bqa\s+engineer\b/i.test(title) &&
      /\b(test automation|manual testing|quality assurance|test plans?|bug reports?)\b/i.test(blob));

  const titleIsCoreSwe = CORE_SWE_TITLE_RE.test(title);
  if (titleIsCoreSwe && buildingSignals >= 2 && analystSignals === 0) {
    return {
      detected: false,
      kind: null,
      label: null,
      note: "",
      sieResumeSignal,
    };
  }

  const detected =
    Boolean(titleMatch) ||
    qaAsProduct ||
    (analystSignals >= 2 && buildingSignals < 2) ||
    (Boolean(titleMatch) && analystSignals >= 1) ||
    (sieResumeSignal && analystSignals >= 1 && buildingSignals < 2);

  if (!detected) {
    return {
      detected: false,
      kind: null,
      label: null,
      note: "",
      sieResumeSignal,
    };
  }

  const kind = titleMatch?.kind ?? (qaAsProduct ? "qa_engineer" : "implementation_analyst");
  const label = titleMatch?.label ?? kind.replace(/_/g, " ");

  return {
    detected: true,
    kind,
    label,
    note: ADJACENT_ROLE_FUNCTION.FLAG,
    sieResumeSignal,
  };
};

export const applyAdjacentRoleFunctionCap = (
  breakdown: CapabilityBreakdown,
  job: ExtractedJobData,
): { breakdown: CapabilityBreakdown; classification: RoleFunctionClassification } => {
  const classification = classifyRoleFunction(job);
  if (!classification.detected) {
    return { breakdown, classification };
  }

  const cap = ADJACENT_ROLE_FUNCTION.CAP;
  return {
    breakdown: {
      ...breakdown,
      stackFit: Math.min(breakdown.stackFit, cap.stackFit),
      functionalOverlap: Math.min(breakdown.functionalOverlap, cap.functionalOverlap),
    },
    classification,
  };
};

export const applyFrontendPrimaryRoleCap = (
  breakdown: CapabilityBreakdown,
  job: ExtractedJobData,
): { breakdown: CapabilityBreakdown; classification: FrontendPrimaryClassification } => {
  const classification = classifyFrontendPrimaryRole(job);
  if (!classification.detected) {
    return { breakdown, classification };
  }

  const cap = FRONTEND_PRIMARY_ROLE.CAP;
  return {
    breakdown: {
      ...breakdown,
      stackFit: Math.min(breakdown.stackFit, cap.stackFit),
      functionalOverlap: Math.min(breakdown.functionalOverlap, cap.functionalOverlap),
    },
    classification,
  };
};

export const applyPlatformInfraRoleCap = (
  breakdown: CapabilityBreakdown,
  job: ExtractedJobData,
): { breakdown: CapabilityBreakdown; classification: PlatformInfraClassification } => {
  const classification = classifyPlatformInfraRole(job);
  if (!classification.detected) {
    return { breakdown, classification };
  }

  const cap = PLATFORM_INFRA_ROLE.CAP;
  return {
    breakdown: {
      ...breakdown,
      stackFit: Math.min(breakdown.stackFit, cap.stackFit),
      functionalOverlap: Math.min(breakdown.functionalOverlap, cap.functionalOverlap),
    },
    classification,
  };
};

/** Backend/API product SWE (not platform/infra) — structured-first blob. */
export const detectBackendProductApiShape = (job: ExtractedJobData): boolean => {
  const blob = jobBlob(job);
  const productApi =
    /\b(backend|api|full[-\s]?stack|product engineer|product engineering|customer problems?|feature development|features|reliable systems?|testing|debugging|production systems?)\b/i.test(
      blob,
    );
  const infraCore =
    /\b(sre|site reliability|platform engineering|devops|terraform|iac|infrastructure tooling|airgapped|linux internals|container runtime|supply chain security|security hardening)\b/i.test(
      blob,
    );
  return productApi && !infraCore;
};

/**
 * Single primary role-lane label per JD (Item G). Runs narrow classifiers once.
 * Priority: adjacent > platform_infra > product_frontend > product_backend > product_fullstack.
 */
export const classifyRoleLane = (job: ExtractedJobData): RoleLaneClassification => {
  const adjacent = classifyRoleFunction(job);
  if (adjacent.detected) {
    return {
      label: "adjacent_non_engineering",
      adjacentKind: adjacent.kind,
      note: adjacent.note,
    };
  }

  const platform = classifyPlatformInfraRole(job);
  if (platform.detected) {
    return {
      label: "platform_infra",
      adjacentKind: null,
      note: platform.note,
    };
  }

  const frontend = classifyFrontendPrimaryRole(job);
  if (frontend.detected) {
    return {
      label: "product_frontend",
      adjacentKind: null,
      note: frontend.note,
    };
  }

  if (detectBackendProductApiShape(job)) {
    return {
      label: "product_backend",
      adjacentKind: null,
      note: "role-type: backend/API product engineering",
    };
  }

  return {
    label: "product_fullstack",
    adjacentKind: null,
    note: "",
  };
};

/** Boolean views of classifyRoleLane — keep call sites stable. */
export const roleLaneIsAdjacent = (lane: RoleLaneLabel): boolean =>
  lane === "adjacent_non_engineering";
export const roleLaneIsFrontendPrimary = (lane: RoleLaneLabel): boolean =>
  lane === "product_frontend";
export const roleLaneIsPlatformInfra = (lane: RoleLaneLabel): boolean =>
  lane === "platform_infra";
export const roleLaneIsBackendProduct = (lane: RoleLaneLabel): boolean =>
  lane === "product_backend";
