import { z } from "zod";
import type { AssetGenerationSliceDebug, DebugAssetGeneration, GeneratedAssets, JobRecord } from "../../types/job.js";
import type { ResumeContext } from "../../types/resumeContext.js";
import type { UserProfile } from "../../types/userProfile.js";
import type { StructuredCallResult } from "../../services/llm/responsesClient.js";
import { responsesClient } from "../../services/llm/responsesClient.js";
import {
  buildCoverLetterGuidance,
  applicationStrategyAssetSystemPrompt,
  buildApplicationStrategyAssetUserPrompt,
  buildCoverLetterAssetUserPrompt,
  buildTailoredBulletsAssetUserPrompt,
  buildTalkingPointsAssetUserPrompt,
  buildWhyCompanyAssetUserPrompt,
  coverLetterAssetSystemPrompt,
  tailoredBulletsAssetSystemPrompt,
  talkingPointsAssetSystemPrompt,
  whyCompanyAssetSystemPrompt,
} from "./prompts.js";
import { stripPastedJdHeaderFromCoverLetter } from "../../tools/triageStructuredNormalize.js";
import { toActiveResumeType } from "../../types/resume.js";
import { toLegacyRecommendation } from "../../lib/recommendationMapping.js";
import {
  sanitizeGeneratedAssetList,
  sanitizeGeneratedAssetText,
} from "../../lib/riskDisplaySanitizer.js";
import { termGroundedInJdRawText } from "../../lib/jdLanguagePresence.js";

const legacyRecBand = (rec: JobRecord["recommendation"]): "yes" | "selective_yes" | "no" =>
  toLegacyRecommendation(rec);

const isSkipRec = (rec: JobRecord["recommendation"]): boolean => rec === "weak";

const CoverLetterOut = z.object({ coverLetter: z.string().min(1) });
const WhyCompanyOut = z.object({ whyCompany: z.string().min(1) });
const TalkingOut = z.object({
  talkingPoints: z.array(z.string()).min(3).max(5),
});
const BulletsOut = z.object({
  tailoredBulletCandidates: z.array(z.string()).min(3).max(5),
});
const StrategyOut = z.object({
  emphasize: z.array(z.string()).min(1),
  avoidClaiming: z.array(z.string()).min(1),
  recruiterReplyDraft: z.string().optional(),
});

const toSliceDebug = <T,>(r: StructuredCallResult<T>): AssetGenerationSliceDebug => ({
  success: r.success,
  fallbackUsed: r.diagnostics.fallbackUsed,
  httpStatus: r.diagnostics.httpStatus,
  errorCode: r.diagnostics.errorCode,
  errorType: r.diagnostics.errorType,
  errorMessage: r.diagnostics.errorMessage,
  parseStage: r.diagnostics.parseStage,
  reason: r.diagnostics.reason,
});

export class AssetGenerationSkippedError extends Error {
  readonly code = "ASSET_GENERATION_SKIPPED" as const;
  constructor(message: string) {
    super(message);
    this.name = "AssetGenerationSkippedError";
  }
}

const countWords = (text: string): number => text.trim().split(/\s+/).filter(Boolean).length;

const enforceCoverLetterWordBand = (
  text: string,
  fallback: string,
  opts: { min: number; max: number },
): string => {
  let out = text.trim();
  if (!out) out = fallback.trim();
  if (countWords(out) < opts.min) out = fallback.trim();
  const words = out.split(/\s+/).filter(Boolean);
  if (words.length > opts.max) return `${words.slice(0, opts.max).join(" ")}...`;
  return out;
};

const splitSentences = (text: string): string[] =>
  (text.match(/[^.!?]+[.!?]+|[^.!?]+$/g) ?? []).map((s) => s.trim()).filter(Boolean);

const polishCoverLetterTextbox = (text: string, recommendation: JobRecord["recommendation"]): string => {
  let cleaned = text
    .replace(/\r\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/\s{2,}/g, " ")
    .replace(/\bIn a recent project I\b/gi, "Recently, I")
    .replace(/\bA relevant example from my background is:\s*/gi, "")
    .replace(/\bTwo relevant examples from my background are:\s*/gi, "")
    .trim();
  if (!cleaned) return cleaned;

  const caveatRe = /\b(don['’]t|do not|lack|missing|without|no\s+\w+\s+experience|don['’]t yet have)\b/i;
  const caveatHelpfulRe = /\b(learn|ramp|pick up|eager|quickly)\b/i;
  const allSentences = splitSentences(cleaned);
  const keptSentences: string[] = [];
  let keptCaveat = false;
  let caveatSentence = "";
  for (const sentence of allSentences) {
    if (!caveatRe.test(sentence)) {
      keptSentences.push(sentence);
      continue;
    }
    if (legacyRecBand(recommendation) === "yes") continue;
    if (legacyRecBand(recommendation) === "selective_yes") {
      if (!keptCaveat && caveatHelpfulRe.test(sentence)) {
        caveatSentence = sentence;
        keptCaveat = true;
      }
      continue;
    }
    if (!keptCaveat) {
      caveatSentence = sentence;
      keptCaveat = true;
    }
  }

  const sourceSentences = (keptSentences.length ? keptSentences : allSentences).slice();
  if (caveatSentence) sourceSentences.push(caveatSentence);
  if (!sourceSentences.length) return cleaned;
  const paraCount = sourceSentences.length >= 5 ? 3 : 2;
  const maxPerPara = paraCount === 3 ? 2 : 3;
  const paragraphs: string[] = [];
  let idx = 0;
  for (let p = 0; p < paraCount && idx < sourceSentences.length; p += 1) {
    const take = Math.min(maxPerPara, sourceSentences.length - idx);
    paragraphs.push(sourceSentences.slice(idx, idx + take).join(" ").trim());
    idx += take;
  }
  if (idx < sourceSentences.length) {
    paragraphs[paragraphs.length - 1] = `${paragraphs[paragraphs.length - 1]} ${sourceSentences
      .slice(idx)
      .join(" ")}`.trim();
  }
  cleaned = paragraphs.filter(Boolean).join("\n\n");
  return cleaned;
};

const caveatPatterns = [
  /\bdon['’]t have\b/gi,
  /\black\b/gi,
  /\bmissing\b/gi,
  /\bno bachelor'?s\b/gi,
  /\bwithout\b/gi,
  /\bstretch\b/gi,
];

const caveatHits = (text: string): number =>
  caveatPatterns.reduce((sum, re) => sum + (text.match(re)?.length ?? 0), 0);

const hasExcessiveCaveatLanguage = (text: string, recommendation: JobRecord["recommendation"]): boolean => {
  const hits = caveatHits(text.toLowerCase());
  if (legacyRecBand(recommendation) === "yes") return hits > 1;
  if (legacyRecBand(recommendation) === "selective_yes") return hits > 2;
  return hits > 3;
};

const uniqueKeepOrder = (items: string[]): string[] => {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    const key = item.trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(item.trim());
  }
  return out;
};

const LEAD_VERB_RE = /^(built|shipped|implemented|designed|delivered|translated|coordinated|drove|developed|led|created|contributed)\b/i;

const normalizeSnippetStart = (snippet: string): string => {
  const s = snippet.trim().replace(/^[\s,.;:!?-]+/, "");
  if (!s) return "";
  return s[0].toUpperCase() + s.slice(1);
};

const withLeadVerb = (leadVerb: string, snippet: string): string => {
  const normalized = normalizeSnippetStart(snippet).replace(/\.$/, "");
  if (!normalized) return `${leadVerb}.`;
  if (LEAD_VERB_RE.test(normalized)) return `${normalized}.`;
  return `${leadVerb} ${normalized}.`;
};

/** Honest, template-backed assets when LLM is unavailable or fails — uses only job + profile fields. */
export const buildDeterministicGeneratedAssets = (
  job: JobRecord,
  profile: UserProfile,
  selectedResumeContext?: ResumeContext,
): GeneratedAssets => {
  const { extracted, rules, mainRisk } = job;
  const recommendedResume = toActiveResumeType(job.recommendedResume);
  const company = extracted.company;
  const title = extracted.title;
  const guidance = buildCoverLetterGuidance(job, profile);
  const stackLine = [...extracted.stack, ...extracted.requiredSkills]
    .filter((t) => Boolean(t?.trim()) && termGroundedInJdRawText(t, extracted))
    .join(", ");
  const resp0 = extracted.responsibilities[0];
  const rawSnippet = extracted.rawText?.trim().slice(0, 320);
  const keyPriorities = guidance.priorities.slice(0, 2).join(" and ").replace(/\.$/, "");
  const p1 = `Hello ${company} team, I'm applying for the ${title} role. This role's focus on ${keyPriorities} fits the kind of practical engineering work I do best.`;
  const resumeEvidence =
    selectedResumeContext?.metadata.projectEvidence.map((p) => p.summary).filter(Boolean) ?? [];
  const evidenceBits = (resumeEvidence.length ? resumeEvidence : guidance.selectedProjectSummaries).slice(0, 2);
  const p2 =
    evidenceBits.length > 1
      ? `${normalizeSnippetStart(evidenceBits[0]).replace(/\.$/, "")}. ${normalizeSnippetStart(
          evidenceBits[1],
        ).replace(/\.$/, "")}.`
      : `${normalizeSnippetStart(evidenceBits[0] ?? profile.flagshipProjects[0]?.summary ?? profile.headline).replace(/\.$/, ".")}`;
  const p3ByBand: Record<"yes" | "selective_yes" | "no", string> = {
    yes: `I'd be excited to contribute quickly in this role and keep building practical product value with your team. If helpful, I can share concrete examples of how I'd approach the first few priorities in your posting.`,
    selective_yes: `If this scope is a match, I'd welcome a conversation on how I'd contribute quickly while ramping where needed. I care most about being clear on near-term impact and delivering consistently from there.`,
    no: `I recognize this role may be a stretch in parts, but I'd still bring practical execution and clear communication from day one. If there is flexibility on exact background profile, I'd be glad to discuss where I can add immediate value.`,
  };
  const rawCoverLetter = [p1, p2, p3ByBand[legacyRecBand(job.recommendation)]].join("\n\n");
  const coverLetter = enforceCoverLetterWordBand(polishCoverLetterTextbox(rawCoverLetter, job.recommendation), rawCoverLetter, {
    min: 120,
    max: 200,
  });

  const whyTone: Record<"yes" | "selective_yes" | "no", string> = {
    yes: "This aligns with the direction I want to keep building in.",
    selective_yes: "This is the kind of role I'd pursue where overlap is strong and growth is realistic.",
    no: "This looks more selective for my background, but the role shape still connects to work I care about.",
  };
  const whyCompany = [
    `I'm interested in ${company}'s ${title} role because it emphasizes ${guidance.priorities[0] ?? "practical delivery"} and ${
      guidance.priorities[1] ?? "clear product impact"
    }.`,
    `A relevant overlap from my background is ${guidance.selectedProjectSummaries[0] ?? profile.flagshipProjects[0]?.summary ?? profile.headline}.`,
    whyTone[legacyRecBand(job.recommendation)],
  ].join(" ");

  const talkingPoints: string[] = [];
  if (recommendedResume === "FDE") {
    talkingPoints.push(
      "I turn operational needs into working software: I built internal tools used by 10+ people and integrations across Gmail, OAuth, and job boards.",
    );
    talkingPoints.push(
      "I build AI into practical workflows with guardrails: approval-gated agents, step limits, cost caps, and a scoped MCP server.",
    );
    talkingPoints.push(
      "Nine years coordinating schools, vendors, and staff means I can scope work directly with non-technical teams and follow it through.",
    );
  } else if (recommendedResume === "AI") {
    talkingPoints.push(
      "I built and maintain a RAG codebase assistant, and I measure it: a 50-question golden set took citation validity from under 50% to 100%.",
    );
    talkingPoints.push(
      "I benchmarked a bounded LangGraph agent against fixed RAG and can explain the recall, cost, and latency tradeoffs.",
    );
    talkingPoints.push(
      "For this role, the fit is strongest where AI features need solid full-stack delivery and honest evaluation around them.",
    );
  } else {
    talkingPoints.push(
      "I've shipped backend-leaning full-stack work where APIs and internal tools were core to product delivery.",
    );
    talkingPoints.push(
      "I'm strongest when priorities are ambiguous but measurable: narrow scope, ship a practical version, then iterate with stakeholders.",
    );
    talkingPoints.push(
      "For this role, the fit is strongest around product-minded execution tied to concrete technical overlap.",
    );
  }
  for (const summary of (resumeEvidence.length ? resumeEvidence : guidance.selectedProjectSummaries)) {
    if (talkingPoints.length >= 5) break;
    talkingPoints.push(`Relevant example: ${summary}`);
  }
  while (talkingPoints.length < 3) {
    talkingPoints.push(`Relevant strength I can substantiate: ${profile.strengths[talkingPoints.length]}.`);
  }
  if (legacyRecBand(job.recommendation) !== "yes" && talkingPoints.length < 5) {
    talkingPoints.push(
      "I approach fit risks directly, but keep focus on where I can deliver immediate value in this role.",
    );
  }
  const normalizedTalkingPoints = uniqueKeepOrder(talkingPoints).slice(0, isSkipRec(job.recommendation) ? 3 : 5);

  const bulletLeads =
    recommendedResume === "AI"
      ? ["Built", "Implemented", "Benchmarked", "Designed", "Shipped"]
      : recommendedResume === "FDE"
        ? ["Built", "Integrated", "Automated", "Delivered", "Partnered on"]
        : ["Built", "Shipped", "Implemented", "Designed", "Collaborated on"];
  const baseBullets = (resumeEvidence.length ? resumeEvidence : guidance.selectedProjectSummaries).map((summary, idx) =>
    withLeadVerb(bulletLeads[idx % bulletLeads.length], summary),
  );
  const roleBullets =
    recommendedResume === "AI"
      ? [
          "Built RAG retrieval with embeddings, vector search, and reranking that returns source-grounded, cited answers.",
          "Built an LLM evaluation harness that measures correctness, citation validity, latency, and cost against fixed baselines.",
        ]
      : recommendedResume === "FDE"
        ? [
            "Built integrations and internal tools that connect third-party systems to the workflows real teams rely on.",
            "Scoped requests with non-technical stakeholders and shipped working first versions, then iterated on feedback.",
          ]
        : [
          "Built API-first product features and internal tooling with a backend-leaning full-stack approach.",
          "Collaborated with stakeholders to scope and ship pragmatic increments tied to product needs.",
        ];
  const tailoredBulletCandidates = uniqueKeepOrder([...baseBullets, ...roleBullets]).slice(0, isSkipRec(job.recommendation) ? 3 : 5);

  const emphasize: string[] = [
    ...profile.recurringStory.slice(0, 2),
    ...(selectedResumeContext?.metadata.strongestThemes.slice(0, 2) ?? []),
    job.topMatch,
    `Resume selected for this application: ${recommendedResume} — keep the story consistent with that framing.`,
  ].filter(Boolean);

  const avoidClaiming: string[] = [
    ...profile.hardConstraints,
    ...(selectedResumeContext?.metadata.avoidUseCases ?? []),
  ];
  if (rules.explicitDegreeRisk) {
    avoidClaiming.push(
      "Posting signals a degree gate — do not imply a bachelor's you don't have; be precise about your path or ask about exceptions early.",
    );
  }
  if (rules.visaMismatch) {
    avoidClaiming.push("Visa/sponsorship: do not imply sponsorship where the posting restricts it.");
  }
  if (rules.citizenshipMismatch) {
    avoidClaiming.push("Citizenship requirement: do not claim eligibility you don't meet.");
  }
  if (rules.clearanceMismatch) {
    avoidClaiming.push("Clearance: do not claim cleared work without it.");
  }
  if (rules.seniorityOverreach || rules.seniorityStretch) {
    avoidClaiming.push("Seniority: posting reads above your level story — don't claim staff-level ownership.");
  }
  if (rules.stackMismatch) {
    avoidClaiming.push(
      "Stack: required core language is outside your claimable stack — do not claim production depth in that language.",
    );
  }
  if (rules.domainMismatch) {
    avoidClaiming.push("Domain: don't claim specialized domain depth the posting asks for without overlap.");
  }
  if (rules.strictNewGradPipeline || rules.newGradPenalty) {
    avoidClaiming.push("Pipeline: avoid sounding like a campus-hire program match if you're not in that track.");
  }
  if (rules.financePenalty || rules.traditionalCompanyPenalty) {
    avoidClaiming.push("Employer context: expect stricter screens — keep claims conservative and verifiable.");
  }
  avoidClaiming.push(`Main triage risk to respect: ${mainRisk}`);

  const recruiterReplyDraft = `Thanks for considering my application for ${title} at ${company}. Happy to answer a few scoping questions or share a small work sample that maps to the posting — especially around ${stackLine || "the core responsibilities"}.`;

  const sanitizeCtx = {
    extracted,
    userProfile: profile,
    rules,
  };

  return {
    coverLetter: sanitizeGeneratedAssetText(coverLetter, sanitizeCtx),
    whyCompany: sanitizeGeneratedAssetText(whyCompany, sanitizeCtx),
    talkingPoints: sanitizeGeneratedAssetList(normalizedTalkingPoints, sanitizeCtx),
    tailoredBulletCandidates: sanitizeGeneratedAssetList(tailoredBulletCandidates, sanitizeCtx),
    emphasize: sanitizeGeneratedAssetList(emphasize.slice(0, 6), sanitizeCtx),
    avoidClaiming: sanitizeGeneratedAssetList(avoidClaiming.slice(0, 12), sanitizeCtx),
    recruiterReplyDraft: sanitizeGeneratedAssetText(recruiterReplyDraft, sanitizeCtx),
  };
};

export type GenerateJobAssetsParams = {
  job: JobRecord;
  userProfile: UserProfile;
  selectedResumeContext?: ResumeContext;
  /** When true, generate even if recommendation is "no". */
  force?: boolean;
};

export type GenerateJobAssetsResult = {
  generated: GeneratedAssets;
  debugAssetGeneration?: DebugAssetGeneration;
  skipped?: boolean;
  skipReason?: string;
};

export const generateJobAssets = async (params: GenerateJobAssetsParams): Promise<GenerateJobAssetsResult> => {
  const { job, userProfile, selectedResumeContext, force } = params;

  if (isSkipRec(job.recommendation) && !force) {
    return {
      generated: {},
      skipped: true,
      skipReason: "Recommendation is 'Weak'; asset generation is skipped unless force=true.",
    };
  }

  const fb = buildDeterministicGeneratedAssets(job, userProfile, selectedResumeContext);

  const [cl, why, talk, bullets, strat] = await Promise.all([
    responsesClient.runStructured({
      systemPrompt: coverLetterAssetSystemPrompt,
      userPrompt: buildCoverLetterAssetUserPrompt({ job, userProfile, selectedResumeContext }),
      schema: CoverLetterOut,
      fallback: () => ({ coverLetter: fb.coverLetter ?? "" }),
    }),
    responsesClient.runStructured({
      systemPrompt: whyCompanyAssetSystemPrompt,
      userPrompt: buildWhyCompanyAssetUserPrompt({ job, userProfile, selectedResumeContext }),
      schema: WhyCompanyOut,
      fallback: () => ({ whyCompany: fb.whyCompany ?? "" }),
    }),
    responsesClient.runStructured({
      systemPrompt: talkingPointsAssetSystemPrompt,
      userPrompt: buildTalkingPointsAssetUserPrompt({ job, userProfile, selectedResumeContext }),
      schema: TalkingOut,
      fallback: () => ({ talkingPoints: fb.talkingPoints ?? [] }),
    }),
    responsesClient.runStructured({
      systemPrompt: tailoredBulletsAssetSystemPrompt,
      userPrompt: buildTailoredBulletsAssetUserPrompt({ job, userProfile, selectedResumeContext }),
      schema: BulletsOut,
      fallback: () => ({ tailoredBulletCandidates: fb.tailoredBulletCandidates ?? [] }),
    }),
    responsesClient.runStructured({
      systemPrompt: applicationStrategyAssetSystemPrompt,
      userPrompt: buildApplicationStrategyAssetUserPrompt({ job, userProfile, selectedResumeContext }),
      schema: StrategyOut,
      fallback: () => ({
        emphasize: fb.emphasize ?? [],
        avoidClaiming: fb.avoidClaiming ?? [],
        recruiterReplyDraft: fb.recruiterReplyDraft,
      }),
    }),
  ]);

  const pick = <T,>(ok: boolean, primary: T, alt: T): T => (ok ? primary : alt);

  let coverLetter = pick(cl.success, cl.data.coverLetter, fb.coverLetter);
  if (typeof coverLetter === "string" && coverLetter.trim()) {
    coverLetter = stripPastedJdHeaderFromCoverLetter(job, coverLetter);
    coverLetter = polishCoverLetterTextbox(coverLetter, job.recommendation);
    coverLetter = enforceCoverLetterWordBand(coverLetter, fb.coverLetter ?? "", { min: 110, max: 200 });
    if (hasExcessiveCaveatLanguage(coverLetter, job.recommendation)) {
      coverLetter = fb.coverLetter ?? coverLetter;
    }
  }

  let whyCompany = pick(why.success, why.data.whyCompany, fb.whyCompany);

  const sanitizeCtx = {
    extracted: job.extracted,
    userProfile,
    rules: job.rules,
  };

  if (typeof coverLetter === "string" && coverLetter.trim()) {
    coverLetter = sanitizeGeneratedAssetText(coverLetter, sanitizeCtx);
  }
  if (typeof whyCompany === "string" && whyCompany.trim()) {
    whyCompany = sanitizeGeneratedAssetText(whyCompany, sanitizeCtx);
  }

  const talkingPoints = sanitizeGeneratedAssetList(
    pick(talk.success, talk.data.talkingPoints, fb.talkingPoints) ?? [],
    sanitizeCtx,
  );
  const tailoredBulletCandidates = sanitizeGeneratedAssetList(
    pick(bullets.success, bullets.data.tailoredBulletCandidates, fb.tailoredBulletCandidates) ?? [],
    sanitizeCtx,
  );
  const emphasize = sanitizeGeneratedAssetList(
    pick(strat.success, strat.data.emphasize, fb.emphasize) ?? [],
    sanitizeCtx,
  );
  const avoidClaiming = sanitizeGeneratedAssetList(
    pick(strat.success, strat.data.avoidClaiming, fb.avoidClaiming) ?? [],
    sanitizeCtx,
  );
  let recruiterReplyDraft = pick(
    strat.success,
    strat.data.recruiterReplyDraft ?? fb.recruiterReplyDraft,
    fb.recruiterReplyDraft,
  );
  if (typeof recruiterReplyDraft === "string" && recruiterReplyDraft.trim()) {
    recruiterReplyDraft = sanitizeGeneratedAssetText(recruiterReplyDraft, sanitizeCtx);
  }

  const generated: GeneratedAssets = {
    coverLetter,
    whyCompany,
    talkingPoints,
    tailoredBulletCandidates,
    emphasize,
    avoidClaiming,
    recruiterReplyDraft,
  };

  const debugAssetGeneration: DebugAssetGeneration = {
    slices: {
      coverLetter: toSliceDebug(cl),
      whyCompany: toSliceDebug(why),
      talkingPoints: toSliceDebug(talk),
      tailoredBulletCandidates: toSliceDebug(bullets),
      applicationStrategy: toSliceDebug(strat),
    },
  };

  return { generated, debugAssetGeneration };
};
