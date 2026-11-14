import { z } from "zod";
import { env } from "../../config/env.js";
import { resumeProfiles } from "../../config/resumeProfiles.js";
import type { ExtractedJobData } from "../../types/job.js";
import type { ResumeSelection, ResumeType } from "../../types/resume.js";
import type { ResumeContextSet } from "../../types/resumeContext.js";
import type { ScoreBreakdown } from "../../types/scoring.js";
import type { UserProfile } from "../../types/userProfile.js";
import { responsesClient } from "../../services/llm/responsesClient.js";
import { buildResumeSelectionPrompt, resumeSelectionSystemPrompt } from "./prompts.js";
import { normalizeText } from "../../lib/text.js";
import { logger } from "../../lib/logger.js";
import { RESUME_TYPES } from "../../types/resume.js";

const ResumeSelectionSchema = z.object({
  recommendedResume: z.enum(RESUME_TYPES),
  confidence: z.number().min(0).max(1),
  rationale: z.array(z.string()).default([]),
});

/**
 * JD-only resume preview — does not need a score. Call this before scoreJob so
 * survivability can use the same resume text as recommendedResume.
 */
export const deterministicResumeSelection = (
  job: ExtractedJobData,
  resumeContexts?: ResumeContextSet,
): ResumeSelection & { ambiguous: boolean } => {
  const title = normalizeText(job.title ?? "");
  const body = normalizeText(
    [
      job.rawText ?? "",
      (job.requirements ?? []).join(" "),
      (job.responsibilities ?? []).join(" "),
      (job.stack ?? []).join(" "),
      (job.requiredSkills ?? []).join(" "),
      (job.preferredSkills ?? []).join(" "),
    ].join(" "),
  );

  const titleIsAi = AI_TITLE_RE.test(title);
  const aiHits = AI_CORE_SIGNALS.filter((re) => re.test(body)).length;

  let aiScore = aiHits + (titleIsAi ? 4 : 0);
  if (resumeContexts?.AI?.metadata && resumeContexts.BASE?.metadata) {
    const words = new Set(body.split(/\s+/).filter(Boolean));
    const overlap = (type: ResumeType) =>
      resumeContexts[type]!.metadata.keywords.filter((k) => words.has(k)).length;
    aiScore += Math.sign(overlap("AI") - overlap("BASE"));
  }

  const titleIsFde = FDE_TITLE_RE.test(title);
  const fdeHits = FDE_CORE_SIGNALS.filter((re) => re.test(body)).length;
  const fdeAvailable = !resumeContexts || Boolean(resumeContexts.FDE);

  // FDE title wins (a "Forward Deployed AI Engineer" still wants the integration-led resume);
  // otherwise AI-core roles keep AI, and integration/internal-tools-heavy roles get FDE.
  let recommendedResume: ResumeType;
  if (fdeAvailable && titleIsFde) recommendedResume = "FDE";
  else if (aiScore >= AI_THRESHOLD) recommendedResume = "AI";
  else if (fdeAvailable && fdeHits >= FDE_THRESHOLD) recommendedResume = "FDE";
  else recommendedResume = "BASE";

  const aiBorderline = aiScore === AI_THRESHOLD - 1 || aiScore === AI_THRESHOLD;
  const fdeBorderline = fdeAvailable && !titleIsFde && fdeHits === FDE_THRESHOLD - 1;
  const ambiguous = !titleIsFde && (aiBorderline || fdeBorderline);
  const profile = resumeProfiles.find((r) => r.type === recommendedResume);
  return {
    recommendedResume,
    confidence: ambiguous ? 0.62 : 0.84,
    rationale: profile?.exampleRationale ?? ["Resume selected from stable role-shape heuristics."],
    ambiguous,
  };
};

const AI_TITLE_RE =
  /\b(ai|a\.i\.|ml|llm|genai|gen ai|generative ai|machine learning|applied ai|ai\/ml|agentic|agents?)\b/i;

/** Distinct signals that AI work is core to the role, not a nice-to-have mention. */
const AI_CORE_SIGNALS: RegExp[] = [
  /\bllms?\b|\blarge language models?\b/i,
  /\brag\b|\bretrieval[-\s]augmented\b/i,
  /\bembeddings?\b|\bvector (search|database|db|store)s?\b/i,
  /\bagentic\b|\bai agents?\b|\btool[-\s]using agents?\b|\blanggraph\b|\blangchain\b/i,
  /\b(llm|model|ai) evals?\b|\bevaluations? (harness|framework)s?\b|\bevals\b/i,
  /\bprompt engineering\b|\bprompting\b/i,
  /\bopenai\b|\banthropic\b|\bclaude\b|\bgpt-?\d/i,
  /\bgenerative ai\b|\bgenai\b/i,
  /\bmachine learning\b|\bml (systems|pipelines|models)\b/i,
];

/** title (+4) plus ~1 core signal, or 3+ core signals without an AI title. */
const AI_THRESHOLD = 3;

const FDE_TITLE_RE =
  /\b(forward[-\s]deployed|solutions? engineer(ing)?|implementation engineer|integrations? engineer|application engineer|deployment engineer|internal tools)\b/i;

/** Distinct signals that integrations, internal tooling, or stakeholder-facing delivery is the core of the job. */
const FDE_CORE_SIGNALS: RegExp[] = [
  /\bthird[-\s]party (systems?|apis?|integrations?|services?|data)\b|\bintegrations? (challenges|frameworks?|across)\b|\bconnect(ing)? (third[-\s]party )?systems\b/i,
  /\binternal (tools?|tooling|applications?|apps?|platforms?)\b/i,
  /\b(synchroni[sz]e|sync(ing)?) (patient |customer |user )?data\b|\bdata sync\b/i,
  /\bautomat(e|ing|ion) (of )?(operational|business|manual) (processes|workflows?)\b|\bworkflow automation\b/i,
  /\b(operations|clinical|gtm|go[-\s]to[-\s]market|sales|support|care) (teams?|staff)\b|\bnon[-\s](technical|engineering) (stakeholders|teams?|teammates|users)\b/i,
  /\b(customer|client)[-\s]facing (implementations?|deployments?|engineering|roles?|work)\b|\b(customer|client) (deployments?|implementations?|onboarding)\b|\bwork(ing)? directly with (customers|clients)\b/i,
];

/** Three distinct integration/internal-tools signals without an FDE title (two is borderline). */
const FDE_THRESHOLD = 3;

export const selectResume = async (params: {
  extracted: ExtractedJobData;
  score: ScoreBreakdown;
  topMatch: string;
  mainRisk: string;
  userProfile: UserProfile;
  resumeContexts?: ResumeContextSet;
}): Promise<ResumeSelection> => {
  const deterministic = deterministicResumeSelection(params.extracted, params.resumeContexts);
  if (
    !deterministic.ambiguous ||
    !env.openAiApiKey ||
    (env.triageFastMode && env.triageSkipLlmResumeSelectionInFastMode)
  ) {
    return {
      recommendedResume: deterministic.recommendedResume,
      confidence: deterministic.confidence,
      rationale: deterministic.rationale,
    };
  }

  const fallback = () => ({
    recommendedResume: deterministic.recommendedResume,
    confidence: deterministic.confidence,
    rationale: deterministic.rationale,
  });
  const selected = await responsesClient.runStructured({
    systemPrompt: resumeSelectionSystemPrompt,
    userPrompt: buildResumeSelectionPrompt(params),
    schema: ResumeSelectionSchema,
    fallback,
  });
  if (!selected.success) {
    logger.warn("Resume selection used deterministic fallback", {
      fallbackUsed: selected.diagnostics.fallbackUsed,
      httpStatus: selected.diagnostics.httpStatus,
      errorCode: selected.diagnostics.errorCode,
      parseStage: selected.diagnostics.parseStage,
      reason: selected.diagnostics.reason,
    });
  }
  return selected.data;
};
