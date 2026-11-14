import { toLegacyRecommendation } from "../../lib/recommendationMapping.js";
import type { JobPostingMetadata } from '../../tools/jobPostingMetadataExtract.js';
import { stripBoardMatchChromeFromText } from '../../tools/jobBoardMatchExtract.js';
import { SCORING_CANONICAL_POLICY } from '../../config/scoringPolicy.js';
import type { ExtractedJobData, JobRecord } from '../../types/job.js';
import { toActiveResumeType, type StoredResumeType } from '../../types/resume.js';
import type { ResumeContext } from "../../types/resumeContext.js";
import type { RuleEvaluation, ScoreBreakdown } from '../../types/scoring.js';
import type { UserProfile } from '../../types/userProfile.js';

console.log('PROMPT_VERSION_2');

export const extractionSystemPrompt = `
You extract job posting details into ONE flat JSON object (no wrapper keys like "job" or "data").
Rules:
- Only include facts supported by the posting text.
- Never guess missing values.
- Use "unknown" or omit when uncertain.
- Keep arrays deduplicated and concise (strings only inside arrays).
- Output only valid JSON.

Required shape (field names must match exactly):
- company: non-empty string
- title: non-empty string
- url: OPTIONAL. Omit this key entirely unless you have a valid absolute http(s) URL from the input. Never use null, "", "none", or placeholders.
- location: OPTIONAL string only. If you include it, it must be a single human-readable line (e.g. "Remote (US)", "Hybrid — New York, NY"). Never return an object or array for location.
- remoteType: optional enum string: "remote" | "hybrid" | "onsite" | "unknown"
- locationIsCommutable: optional boolean. Set true when the role lists New York, NY / NYC / hybrid or onsite in the NYC metro, or clearly commutable North Jersey, as a work location option. Set false only when the role requires a non-NYC metro with no NYC/NJ option. Do not mark non-commutable for hybrid in NYC.
- salary, seniority, visaRequirement, etc.: only when clearly supported; use numbers for salary min/max.
- yearsExperience: if present, MUST be an object like { "raw": "2+", "min": 2, "max": 4 } — never a bare number or bare string at the top level.
- degreeRequirement: if present, MUST be an object like { "raw": "Bachelor's required", "level": "required" } — never a bare string.
- stack, requiredSkills, preferredSkills, domainTags, responsibilities, requirements: arrays of strings (empty arrays allowed).
- Every stack/requiredSkills/preferredSkills entry MUST appear verbatim (or as an unambiguous synonym like React.js→React) in the posting text. Never invent tool names (e.g. do not add Figma unless "Figma" appears in the JD).
- Narrative/culture prose ("Who You Are", "good design", "delightful UX") is NOT a hard requirement — do not put those concepts in requiredSkills.
- Simplify "Required Skills" chip lists are preference hints unless the same skill appears in Qualifications/Requirements prose with must-have language.
- Use the provided parsed companyName unless it is null or obviously incorrect. Do not replace a concrete company name with "Unknown Company".
- Do not infer company from the role title. Ignore page chrome (Simplify+, Open user menu, Updated on, History, Summary, Full Job Posting).
- For scraped layouts with metadata labels (position, time, remote, seniority, money, date), use pre-parsed company/title/location — the value after "position" is usually location, not job title.
`.trim();

export const metadataExtractionSystemPrompt = `
You extract structured job posting metadata only.
Return JSON with exactly these keys (use null when unknown):
companyName, jobTitle, employmentType, location, seniority, salary, workModel.

Rules:
- Do not infer a company from the role title.
- Ignore page chrome such as Simplify+, Open user menu, Updated on, History, Summary, and Full Job Posting.
- Company names often appear near employee-count lines or repeated consecutively.
- Never guess; use null when uncertain.
`.trim();

export const buildMetadataExtractionPrompt = (rawText: string): string => `
Extract structured metadata from this pasted job posting.

${rawText}
`.trim();

export const buildExtractionPrompt = (input: {
  url?: string;
  rawText?: string;
  companyHint?: string;
  preParsed?: JobPostingMetadata;
}): string => `
Extract a job posting into the required schema.
Company hint: ${input.companyHint ?? 'none'}
URL: ${input.url ?? 'none'}

Pre-parsed fields (deterministic; prefer these for company/title when present):
${JSON.stringify(input.preParsed ?? {}, null, 2)}

Job text:
${input.rawText ?? 'No raw text provided.'}
`;

export const scoringSystemPrompt = `
You are a conservative job-screen evaluator.

${SCORING_CANONICAL_POLICY}

Rules:
- Prioritize landability and recruiter-screen realism. Weigh each factor ONCE during category scoring.
- Hard gates (visa, citizenship, clearance, credential-heavy fintech, Go data-infra gap, strict new-grad pipeline, research-heavy AI, seniority overreach, location mismatch, explicit degree without equivalent escape, explicit core-language at mature employer) are applied as deterministic total caps AFTER you score — score categories honestly; do not pre-discount for gates already flagged in rules.
- Do not infer experience or accomplishments not present.
- For junior/early-career roles, do not over-credit aspirational language unless profile/rules support it.

Category guidance (score each factor once here):
- stackFit (0–20): Applied-AI role + AI-tooling profile → usually 13–14/20 unless hard core-language gate. Python-primary with strong LLM/RAG/API overlap → 13–14/20, not low teens. Python+JS/TS flexible JD → minor Python caveat only. Backend/API/product JD → mid band ~11+/20; do not collapse for supporting K8s/AWS mentions. Mature employer + explicit core-language mismatch → score honestly low; cap applied later. IMPORTANT: A stackFit score below 13/20 requires a documented reason such as a hard core-language mismatch or an explicit infra-only role. Do not score below 13/20 simply because the JD does not list TypeScript, React, or Node.js by name. For roles describing full-stack AI product work — especially when the JD names tools like Claude Code, custom MCPs, LLM workflows, copilots, or subagents — the candidate profile is a strong match. Score 14–17/20 for these roles.
- levelFit (0–20): 2–4 years + ownership/roadmap influence → usually 13–16/20. Senior/staff/principal/5+ required/leading teams → score lower; cap applied later if overreach flag set. levelFit max is 20. Calibration anchors: explicit 1–3 year requirement, junior/mid title, no seniority language = 18–19/20. Role requires 2–4 years with ownership language = 14–16/20. Senior/staff/principal or 5+ years required = 6–9/20. Do not carry over score values calibrated to a previous max of 15 — the scale has changed.
- domainFit (0–10): Applied AI JD + profile LLM/RAG shipping → 7–8/10 unless domainMismatch. Healthcare product/full-stack (not clinical SME) → 6–7/10.
- functionalOverlap (0–15): End-to-end AI workflows + profile with shipped LLM/RAG projects → 12–13/15 unless hard rule contradicts.
- resumeStoryClarity (0–10): Clear role arc match → 9–10/10; fragmented/off-topic → lower.
- recruiterFriendliness (0–15): NYC/hybrid NYC viable → boost. traditionalCompanyPenalty/financePenalty/vagueEarlyStageAiCalibration → reflect stricter screen (~9–10/15 for vague early-stage AI at unknown employer unless strong company).
- careerValue (0–10): Founding-engineer stretch or strong product/AI trajectory → note upside; vague startup AI buzzwords alone → do not inflate.

Soft rule flags (weigh in categories above — NOT re-applied later):
- rules.pythonStackFlexibleWithJsTs, rules.healthcareProductEngineering, rules.backendProductApiRole, rules.infraCoreRole, rules.fdeBuilderSoftwarePrimary (builder-first SWE; strong fit ~78–84 total, not 90+), rules.vagueEarlyStageAiCalibration, rules.foundingEngineerStretch, rules.productionBarCompetitivePool (conservative recruiter realism unless profile shows production depth).

Narrative:
- risks: strongest blocker in mainRisk + one distinct risks[] line. Priority: stack/language → level → travel/onsite.
- Never frame Preferred-only / nice-to-have skills (e.g. Kubernetes or CI/CD under Preferred Qualifications) as a "significant stretch" or hard gap. Cite Required/Basic qualifications and Responsibilities for stretch severity; Preferred items are soft notes at most.
- Before calling a background "weaker" (infra/DevOps/CI/CD/SRE), check the candidate strengths and resume tech lines — if they already show CI/CD (e.g. GitHub Actions), narrow the gap to what is actually missing (e.g. Kubernetes) rather than general DevOps weakness.
- rationale: exactly 2 bullets — JD-shaped fit, then concrete profile proof. No generic filler.
- topMatch: one role-specific sentence that names the title/team (e.g. Reflections / AI Platforms), not only the employer — concurrent reqs at the same company must be distinguishable.
- When stating risks, prefer "this Reflections role" / the specific title over vague "this role" / company-only phrasing when the JD includes a team or specialty in the title.
- Output ONE flat JSON object with ONLY the keys listed in the user message.
`.trim();

const extractedForScoring = (extracted: ExtractedJobData): ExtractedJobData => {
  if (!extracted.rawText?.trim()) return extracted;
  return {
    ...extracted,
    rawText: stripBoardMatchChromeFromText(extracted.rawText),
  };
};

export const buildScoringPrompt = (params: {
  extracted: ExtractedJobData;
  rules: RuleEvaluation;
  userProfile: UserProfile;
  scoringPolicy: unknown;
  parsedMetadata?: {
    companyName: string | null;
    jobTitle: string | null;
    location: string | null;
    confidence?: "high" | "medium" | "low";
  };
}): string =>
  `
Evaluate this role with conservative realism.
Use extracted.company as the employer unless it is missing or clearly wrong (e.g. employment type or page chrome). Do not substitute "Unknown Company" when a concrete company is provided.

Trusted parsed metadata (deterministic pre-score extraction — do NOT infer title/company/location from metadata labels when these are present):
${JSON.stringify(params.parsedMetadata ?? { companyName: params.extracted.company, jobTitle: params.extracted.title, location: params.extracted.location ?? null, confidence: "medium" }, null, 2)}
When parsedMetadata.confidence is "high" or "medium", treat companyName, jobTitle, and location as authoritative. Do not rewrite them from page labels such as position, time, remote, seniority, money, or date.

Return EXACTLY these keys (and no others):
{
  "score": {
    "stackFit": number (0-20),
    "levelFit": number (0-20),
    "domainFit": number (0-10),
    "resumeStoryClarity": number (0-10),
    "functionalOverlap": number (0-15),
    "recruiterFriendliness": number (0-15),
    "careerValue": number (0-10),
    "total": number (0-100)
  },
  "recommendation": "strong_apply" | "apply" | "stretch" | "weak",
  "topMatch": string (one short sentence; never boolean),
  "mainRisk": string (one short sentence; never boolean),
  "rationale": string[],
  "risks": string[]
}

Notes:
- "score.total" must equal the sum of the seven category scores (integer math). Hard-gate caps are applied deterministically after your output.
- Recommendation is derived from capped total — your recommendation field is advisory only.
- Keep rationale decision-useful: exactly 2 strings — JD-shaped fit, then concrete shipped proof.
- "risks" array: max 1 entry after mainRisk (two distinct risks total).
- "topMatch" should be role-specific; avoid generic profile-only phrasing.
- When comparing the candidate to a JD's years-of-experience bar (levelFit, risks), use userProfile.screeningYears when present (else estimatedProfessionalYears). A range like "2–6 years" is met at its floor; the upper end only means stronger competition, not a disqualifier.

Extracted job:
${JSON.stringify(extractedForScoring(params.extracted), null, 2)}

Rule evaluation:
${JSON.stringify(params.rules, null, 2)}

User profile:
${JSON.stringify(params.userProfile, null, 2)}

Scoring policy:
${JSON.stringify(params.scoringPolicy, null, 2)}
`.trim();

export const resumeSelectionSystemPrompt = `
Choose one resume type: BASE, AI, or FDE.
Rules:
- AI when building LLM, RAG, retrieval/search, agent, or AI-evaluation systems is core to the day-to-day work (AI engineer, applied AI, AI product engineer, or a full-stack role whose product is AI-centric).
- FDE for forward-deployed, solutions, implementation, and application engineering roles, and roles whose core work is third-party integrations, data sync between systems, internal tools or automation for operations/clinical/GTM teams, or delivering directly with non-technical stakeholders or customers. AI may be present but is practical workflow tooling, not the research focus.
- BASE for general product, full-stack, backend, and junior/associate roles without an integration or stakeholder-delivery emphasis, including roles that only mention AI as a nice-to-have.
- Do not pick AI for ML research or model-training roles; the candidate has no training/fine-tuning experience.
- Use role shape and expected recruiter screen; do not choose from title alone.
- Output valid JSON only.
`;

export const buildResumeSelectionPrompt = (params: {
  extracted: ExtractedJobData;
  score: ScoreBreakdown;
  topMatch: string;
  mainRisk: string;
  userProfile: UserProfile;
}): string => `
Select the best resume profile and explain why.
Return:
{
  "recommendedResume": "BASE|AI|FDE",
  "confidence": number 0-1,
  "rationale": string[]
}

Job:
${JSON.stringify(params.extracted, null, 2)}

Score:
${JSON.stringify(params.score, null, 2)}

Top match: ${params.topMatch}
Main risk: ${params.mainRisk}

User profile:
${JSON.stringify(params.userProfile, null, 2)}
`;

/** Reduce copy-paste repetition across assets for the same job. */
export const ASSET_EVIDENCE_DIVERSITY = `
Evidence rotation (important):
- Use BOTH flagship projects where they add distinct proof — do not repeat the same opening project sentence across paragraphs or bullets unless necessary.
- Match the angle to this job's shape: RAG / evals / agent benchmarking for AI-centric roles; shipped full-stack product work, APIs, and internal tools for BASE roles; fundamentals and learning velocity for explicitly junior roles.
- At most one asset section should lead with the same flagship project name; vary which project anchors bullets vs. cover letter when both are relevant.
`.trim();

/** Shared across all asset-generation prompts — keep in sync with product expectations. */
export const ASSET_GROUNDING_RULES = `
Grounding and honesty (non-negotiable):
- Use ONLY claims supportable from the provided user profile and extracted job data.
- Do NOT invent years of experience, titles, team size, leadership scope, production scale, or domain expertise.
- Do NOT claim technologies for the candidate unless they appear in the user profile (strengths, projects, recurring story) or are clearly framed as "the role uses X" rather than "I shipped X at scale".
- Do NOT oversell fit because the role scored well; acknowledge gaps where rules/risks flag them.
- Do NOT fabricate company facts not present in the posting.
- Keep language direct, human, and textbox-usable — not corporate fluff, not repetitive hype, not "thrilled to synergize".
- Prefer short sentences. Avoid em dashes stacked for fake polish.
`.trim();

export const buildResumeAngleBlock = (resume: StoredResumeType): string => {
  if (toActiveResumeType(resume) === 'FDE') {
    return `
Resume angle: FDE (integrations, internal tools, and applied AI delivery).
Emphasize: turning operational needs into working software, third-party integrations (REST, OAuth, Gmail, MCP), internal tools used by real teams, approval-gated AI agents, and clear communication with non-technical stakeholders from nine years of operations work.
Avoid: claiming customer-facing consulting tenure, on-site deployments, or enterprise scale not in the profile.
`.trim();
  }
  if (toActiveResumeType(resume) === 'AI') {
    return `
Resume angle: AI (AI-enabled application engineering).
Emphasize: RAG retrieval and grounding, LLM evaluation (golden sets, citation validity), bounded tool-using agents and benchmarking, plus the full-stack TypeScript/Node/React delivery around them.
Avoid: claiming model training, fine-tuning, ML research, or production scale not in the profile.
`.trim();
  }
  return `
Resume angle: BASE (full-stack product engineering).
Emphasize: shipped full-stack product work, REST APIs, auth, async pipelines, internal tools, AWS and CI/CD; AI work as supporting evidence when relevant.
Avoid: sounding like pure SRE/infra ownership, artificially senior scope, or long industry tenure.
`.trim();
};

const tokenize = (text: string): string[] =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9+\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2);

const ARCHETYPE_KEYWORDS: Record<string, string[]> = {
  implementation: ["integration", "onboarding", "stakeholder", "customer", "delivery", "implementation"],
  product: ["product", "feature", "shipping", "internal", "tool", "api", "full-stack"],
  early: ["junior", "entry", "early", "growth", "mentor", "learn"],
};

const hashText = (text: string): number => {
  let h = 0;
  for (let i = 0; i < text.length; i++) h = (h * 31 + text.charCodeAt(i)) >>> 0;
  return h;
};

export type CoverLetterBand = "yes" | "selective_yes" | "no";

export type CoverLetterGuidance = {
  archetype: "implementation" | "product" | "early";
  priorities: string[];
  selectedProjectNames: string[];
  selectedProjectSummaries: string[];
  bandInstruction: string;
};

function deriveArchetype(job: JobRecord): "implementation" | "product" | "early" {
  const blob = `${job.extracted.title} ${job.extracted.responsibilities.join(" ")} ${job.extracted.requirements.join(" ")}`.toLowerCase();
  if (/(integration|implementation|customer|onboarding|deployment)/.test(blob)) return "implementation";
  if (/(junior|entry|new grad|early career)/.test(blob)) return "early";
  return "product";
}

function deriveTopPriorities(job: JobRecord, archetype: "implementation" | "product" | "early"): string[] {
  const candidates = [
    ...job.extracted.responsibilities,
    ...job.extracted.requirements,
    ...job.extracted.requiredSkills.map((s) => `Needs ${s}`),
  ]
    .map((s) => s.trim())
    .filter(Boolean);
  const picked: string[] = [];
  const targetKeywords = ARCHETYPE_KEYWORDS[archetype];
  for (const line of candidates) {
    const words = tokenize(line);
    if (picked.length < 2 && words.some((w) => targetKeywords.includes(w))) {
      picked.push(line);
    }
    if (picked.length >= 3) break;
  }
  for (const line of candidates) {
    if (picked.length >= 3) break;
    if (!picked.includes(line)) picked.push(line);
  }
  if (!picked.length) {
    if (archetype === "implementation") return ["Delivery-focused implementation with integrations and stakeholder communication."];
    if (archetype === "early") return ["Early-career shipping role with growth potential and practical collaboration."];
    return ["Product-minded full-stack shipping with practical API and internal tooling overlap."];
  }
  return picked.slice(0, 3).map((p) => (p.length > 120 ? `${p.slice(0, 117)}...` : p));
}

function selectProjectEvidence(job: JobRecord, profile: UserProfile, archetype: "implementation" | "product" | "early"): {
  names: string[];
  summaries: string[];
} {
  const roleWords = new Set(
    tokenize(
      [
        job.extracted.title,
        ...job.extracted.stack,
        ...job.extracted.requiredSkills,
        ...job.extracted.responsibilities,
        ...job.extracted.requirements,
      ].join(" "),
    ),
  );
  const archetypeWords = ARCHETYPE_KEYWORDS[archetype];
  const tieSeed = hashText(`${job.extracted.company}|${job.extracted.title}`);
  const scored = profile.flagshipProjects.map((p, idx) => {
    const projectWords = tokenize([p.name, p.summary, ...p.tech, ...p.outcomes].join(" "));
    const overlap = projectWords.filter((w) => roleWords.has(w)).length;
    const archetypeBoost = projectWords.filter((w) => archetypeWords.includes(w)).length;
    const tieBreaker = ((tieSeed + idx * 17) % 1000) / 1000;
    return { p, score: overlap * 3 + archetypeBoost * 2 + tieBreaker };
  });
  scored.sort((a, b) => b.score - a.score);
  const top = scored.slice(0, 2).map((s) => s.p);
  return {
    names: top.map((p) => p.name),
    summaries: top.map((p) => p.summary),
  };
}

function recommendationBandInstruction(band: CoverLetterBand): string {
  if (band === "yes") {
    return "Tone band: yes. Be confident and direct; strongest overlap first; no defensive caveat paragraph.";
  }
  if (band === "selective_yes") {
    return "Tone band: selective_yes. Positive but measured; emphasize concrete overlap and keep one brief caveat subordinate if needed.";
  }
  return "Tone band: no (forced generation). Keep restrained and candid. Do not sound like a strong-fit pitch.";
}

export function buildCoverLetterGuidance(job: JobRecord, userProfile: UserProfile): CoverLetterGuidance {
  const archetype = deriveArchetype(job);
  const priorities = deriveTopPriorities(job, archetype);
  const selected = selectProjectEvidence(job, userProfile, archetype);
  return {
    archetype,
    priorities,
    selectedProjectNames: selected.names,
    selectedProjectSummaries: selected.summaries,
    bandInstruction: recommendationBandInstruction(toLegacyRecommendation(job.recommendation)),
  };
}

export const buildAssetGuidanceJson = (job: JobRecord, userProfile: UserProfile): string =>
  JSON.stringify(buildCoverLetterGuidance(job, userProfile), null, 2);

export const buildSelectedResumeContextJson = (selectedResumeContext?: ResumeContext): string => {
  if (!selectedResumeContext) return "none";
  return JSON.stringify(
    {
      type: selectedResumeContext.type,
      strongestThemes: selectedResumeContext.metadata.strongestThemes,
      projectEvidence: selectedResumeContext.metadata.projectEvidence,
      claimSupport: selectedResumeContext.metadata.claimSupport,
      bestFitRoleShapes: selectedResumeContext.metadata.bestFitRoleShapes,
      avoidUseCases: selectedResumeContext.metadata.avoidUseCases,
    },
    null,
    2,
  );
};

export const buildAssetJobContextJson = (job: JobRecord): string =>
  JSON.stringify(
    {
      extracted: job.extracted,
      rules: job.rules,
      score: job.score,
      recommendation: job.recommendation,
      recommendedResume: job.recommendedResume,
      resumeRationale: job.resumeRationale,
      topMatch: job.topMatch,
      mainRisk: job.mainRisk,
      rationale: job.rationale,
      risks: job.risks,
      salaryAsk: job.salaryAsk,
    },
    null,
    2,
  );

export const coverLetterAssetSystemPrompt = `
You write short, textbox-style cover letters for software job applications.
${ASSET_GROUNDING_RULES}
Formatting:
- Start with a normal greeting ("Hello {company} team", "Dear hiring team", etc.).
- Never begin with a raw job-description header line (e.g. "{company} — {title}" copied from the posting).
Default output contract:
- 130–200 words.
- 2–3 short paragraphs (prefer short textbox-ready flow, not dense blocks).
- Paragraph 1: direct role interest + why this company/role fit based on real JD priorities.
- Paragraph 2: 1–2 strongest relevant examples only (no laundry list).
- Paragraph 3: concise close tied to role value/growth.
- Keep each paragraph concise (usually 1–2 sentences).
- Avoid heavy project-dump framing ("In a recent project I...") and avoid compressed resume-summary tone.
- Keep caveats brief and subordinate; never make them the center of the letter.
- For selective_yes: keep tone positive but measured; do not foreground stack-gap disclaimers unless they are central blockers.
- For selective_yes: include at most one brief caveat sentence and keep it in the close when needed.
- Do not make a single missing language/framework (for example Go) a dominant beat unless the JD clearly makes it a strict blocker.
Output valid JSON only with a single key "coverLetter".
`.trim();

export const buildCoverLetterAssetUserPrompt = (params: {
  job: JobRecord;
  userProfile: UserProfile;
  selectedResumeContext?: ResumeContext;
}): string =>
  `
${buildResumeAngleBlock(params.job.recommendedResume)}

${ASSET_EVIDENCE_DIVERSITY}

Cover-letter guidance:
${JSON.stringify(buildCoverLetterGuidance(params.job, params.userProfile), null, 2)}

Selected resume context (ONLY grounding resume to use):
${buildSelectedResumeContextJson(params.selectedResumeContext)}

User profile:
${JSON.stringify(params.userProfile, null, 2)}

Job + evaluation context:
${buildAssetJobContextJson(params.job)}

Write the cover letter. Reference the company and role concretely. Do not restate the entire job description.
Use the guidance priorities and selected project evidence. Avoid generic profile summary mode.
`.trim();

export const whyCompanyAssetSystemPrompt = `
You write a concise "Why this company?" answer for an application form.
${ASSET_GROUNDING_RULES}
Ground the answer in the company name, role title, and specific problems/responsibilities/stack mentioned in the posting — not generic startup enthusiasm.
Output valid JSON only: { "whyCompany": string }.
Contract:
- 3–5 concise sentences (or two short paragraphs with line breaks), textbox-friendly.
- Include: (1) specific role/company hook, (2) strongest overlap evidence, (3) believable close tied to trajectory.
- Do not use generic praise ("innovative", "fast-paced", "mission-driven") unless directly grounded in provided JD context.
- Tone by recommendation band: yes=confident, selective_yes=measured positive, no/forced=restrained and candid.
`.trim();

export const buildWhyCompanyAssetUserPrompt = (params: {
  job: JobRecord;
  userProfile: UserProfile;
  selectedResumeContext?: ResumeContext;
}): string =>
  `
${buildResumeAngleBlock(params.job.recommendedResume)}

${ASSET_EVIDENCE_DIVERSITY}

Shared generation guidance:
${buildAssetGuidanceJson(params.job, params.userProfile)}

Selected resume context (ONLY grounding resume to use):
${buildSelectedResumeContextJson(params.selectedResumeContext)}

User profile:
${JSON.stringify(params.userProfile, null, 2)}

Job + evaluation context:
${buildAssetJobContextJson(params.job)}
`.trim();

export const talkingPointsAssetSystemPrompt = `
You produce 3–5 practical talking points the candidate could use in a screen or recruiter call.
${ASSET_GROUNDING_RULES}
Contract:
- 3–5 points; mostly one sentence each (max two short sentences when needed).
- These must sound like things the candidate can actually say out loud in recruiter/interview conversation.
- Include at least one direct "why me for this role" point.
- Include at most one caveat-aware point, and only if the role risk justifies it.
- Do not output resume bullets in disguise.
- Tone by recommendation band: yes=confident, selective_yes=measured, no/forced=restrained but still useful.
Output valid JSON: { "talkingPoints": string[] } with length 3–5.
`.trim();

export const buildTalkingPointsAssetUserPrompt = (params: {
  job: JobRecord;
  userProfile: UserProfile;
  selectedResumeContext?: ResumeContext;
}): string =>
  `
${buildResumeAngleBlock(params.job.recommendedResume)}

${ASSET_EVIDENCE_DIVERSITY}

Shared generation guidance:
${buildAssetGuidanceJson(params.job, params.userProfile)}

Selected resume context (ONLY grounding resume to use):
${buildSelectedResumeContextJson(params.selectedResumeContext)}

User profile:
${JSON.stringify(params.userProfile, null, 2)}

Job + evaluation context:
${buildAssetJobContextJson(params.job)}
`.trim();

export const tailoredBulletsAssetSystemPrompt = `
You produce 3–5 resume bullet CANDIDATES (not final resume lines) adapted from the user's real projects and strengths.
${ASSET_GROUNDING_RULES}
Contract:
- 3–5 concise resume-style bullet candidates, not interview talking points.
- Resume-type-aware:
  - BASE: APIs, full-stack product features, internal tools, async pipelines, pragmatic technical tradeoffs.
  - AI: RAG retrieval and grounding, LLM evals, tool-using agents and benchmarks, with the surrounding full-stack delivery.
- Tailor to JD priorities and selected evidence angles.
- Vary lead-ins; do not start every bullet with the same phrasing pattern.
- Keep honesty constraints; no invented scale/years/scope.
- Tone by recommendation band: yes strongest overlap, selective_yes measured, no/forced restrained.
Output valid JSON: { "tailoredBulletCandidates": string[] } with length 3–5.
`.trim();

export const buildTailoredBulletsAssetUserPrompt = (params: {
  job: JobRecord;
  userProfile: UserProfile;
  selectedResumeContext?: ResumeContext;
}): string =>
  `
${buildResumeAngleBlock(params.job.recommendedResume)}

${ASSET_EVIDENCE_DIVERSITY}

Shared generation guidance:
${buildAssetGuidanceJson(params.job, params.userProfile)}

Selected resume context (ONLY grounding resume to use):
${buildSelectedResumeContextJson(params.selectedResumeContext)}

User profile:
${JSON.stringify(params.userProfile, null, 2)}

Job + evaluation context:
${buildAssetJobContextJson(params.job)}
`.trim();

export const applicationStrategyAssetSystemPrompt = `
You produce application strategy guidance: what to emphasize, what to avoid claiming, and a very short recruiter follow-up line.
${ASSET_GROUNDING_RULES}
The "avoidClaiming" list MUST explicitly warn against overclaiming wherever rules/score/risks indicate realistic recruiter-screen risk (examples: degree gates, sponsorship/citizenship, clearance, seniority overreach, stack mismatch, domain mismatch, traditional pipeline mismatch).
Output valid JSON:
{
  "emphasize": string[],
  "avoidClaiming": string[],
  "recruiterReplyDraft": string
}
Use 3–6 items in each array when risks warrant it; fewer if the role is clean. recruiterReplyDraft: one or two short sentences max, practical tone.
`.trim();

export const buildApplicationStrategyAssetUserPrompt = (params: {
  job: JobRecord;
  userProfile: UserProfile;
  selectedResumeContext?: ResumeContext;
}): string =>
  `
${buildResumeAngleBlock(params.job.recommendedResume)}

${ASSET_EVIDENCE_DIVERSITY}

User profile:
${JSON.stringify(params.userProfile, null, 2)}

Selected resume context (ONLY grounding resume to use):
${buildSelectedResumeContextJson(params.selectedResumeContext)}

Job + evaluation context:
${buildAssetJobContextJson(params.job)}
`.trim();
