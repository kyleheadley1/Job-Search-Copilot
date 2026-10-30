import { z } from "zod";
import type { GmailApplication } from "../services/gmail/gmailApplications.js";
import type { ApplicationEvaluation } from "../services/gmail/jdRecovery/evaluations.repository.js";
import {
  AlreadyScoredError,
  EvaluationNotFoundError,
} from "../services/gmail/jdRecovery/runRecovery.js";
import {
  InvalidPostingKindError,
  type ClassifyPostingKindResult,
} from "../services/gmail/jdRecovery/applicationPostingKind.js";
import { POSTING_KINDS } from "../services/gmail/jdRecovery/postingKind.js";
import {
  ApplicationUnresolvedError,
  CandidatesFullError,
  CompanyMismatchError,
  InvalidJdCandidateError,
  listMissingJobDescriptions,
  type SubmitJdCandidateInput,
  type SubmitJdCandidateResult,
} from "../services/gmail/jdRecovery/jdCandidates.service.js";
import {
  JD_RECOVERY_DEFAULT_BATCH,
  JD_RECOVERY_MAX_BATCH,
  JD_RECOVERY_OUTCOMES,
  type ClaimJdRecoveryBatchInput,
  type JdRecoveryProgressInput,
  type RecordJdRecoveryOutcomeInput,
} from "../services/gmail/jdRecovery/jdRecoveryQueue.types.js";
import type { SaveJobProspectInput, SaveJobProspectResult } from "../services/gmail/jdRecovery/jobProspects.service.js";
import type { ApprovedRevisionOverlay } from "../services/scoring/scoreRevision.types.js";
import {
  isReviewRequiredCode,
  ProposeScoringCorrectionInput,
  type ProposeScoringCorrectionInput as ProposeScoringCorrectionArgs,
} from "../services/scoring/claudeScoringProposal.js";
import { ScoreRevisionError } from "../services/scoring/scoreRevisions.service.js";
import type { InsightsRun } from "../services/insights/insights.repository.js";
import type { UserProfile } from "../types/userProfile.js";
import type { ResumeContextSet } from "../types/resumeContext.js";
import { LEGACY_RESUME_TYPES, RESUME_TYPES } from "../types/resume.js";
import { toDetailsView, toInsightsView, toListRow } from "./views.js";
import {
  AUDIT_PROTOCOL,
  AUDIT_ROLE_CATEGORIES,
  SCORING_MODEL_FOR_AUDIT,
  buildScoringAuditContext,
  isScoredEvaluation,
  listScoredApplicationsForAudit,
} from "./scoringAudit.js";

/** Same lookback ceiling as the Gmail applications query. Details always use this window. */
export const MCP_MAX_DAYS = 120;
export const MCP_DEFAULT_DAYS = 30;
export const MCP_MAX_LIMIT = 50;
export const MCP_DEFAULT_LIMIT = 20;

const APPLICATION_STATUSES = ["applied", "assessment", "interviewing", "rejected", "offer"] as const;

export class McpToolError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "McpToolError";
  }
}

/**
 * Read-only access to the same local Mongo the API uses.
 * The MCP process is the OS user who launched it (same trust as `npm run dev`).
 * There is no extra identity argument and no second database.
 */
export type McpDeps = {
  getApplications: (days: number) => Promise<GmailApplication[]>;
  getEvaluationsByKeys: (keys: string[]) => Promise<Map<string, ApplicationEvaluation>>;
  getActiveScoreRevisions: (keys: string[]) => Promise<Map<string, ApprovedRevisionOverlay>>;
  getLatestInsightsRun: () => Promise<InsightsRun | null>;
  getUserProfile: () => UserProfile;
  getResumeContexts: () => Promise<ResumeContextSet>;
  saveJobProspect: (input: SaveJobProspectInput) => Promise<SaveJobProspectResult>;
  submitJdCandidate: (input: SubmitJdCandidateInput) => Promise<SubmitJdCandidateResult>;
  proposeScoringCorrection: (input: ProposeScoringCorrectionArgs) => Promise<unknown>;
  claimJdRecoveryBatch?: (input: ClaimJdRecoveryBatchInput) => Promise<unknown>;
  recordJdRecoveryOutcome?: (input: RecordJdRecoveryOutcomeInput) => Promise<unknown>;
  getJdRecoveryProgress?: (input: JdRecoveryProgressInput) => Promise<unknown>;
  syncJdRecoveryQueueAfterCandidate?: (result: SubmitJdCandidateResult) => Promise<void>;
  classifyApplicationPostingKind?: (input: {
    applicationKey: string;
    postingKind: (typeof POSTING_KINDS)[number];
    reason: string;
    evidence?: string[];
  }) => Promise<ClassifyPostingKindResult>;
};

export const ListApplicationsInput = z
  .object({
    query: z.string().trim().min(1).max(200).optional(),
    status: z.enum(APPLICATION_STATUSES).optional(),
    days: z.number().int().min(1).max(MCP_MAX_DAYS).default(MCP_DEFAULT_DAYS),
    limit: z.number().int().min(1).max(MCP_MAX_LIMIT).default(MCP_DEFAULT_LIMIT),
  })
  .strict();

export const GetApplicationDetailsInput = z
  .object({
    key: z.string().trim().min(1).max(500),
  })
  .strict();

export const GetApplicationInsightsInput = z.object({}).strict();

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .optional()
    .transform((value) => (value ? value : undefined));

export const ListScoredApplicationsForAuditInput = z
  .object({
    query: z.string().trim().min(1).max(200).optional(),
    roleCategory: z.enum(AUDIT_ROLE_CATEGORIES).optional(),
    minScore: z.number().min(0).max(100).optional(),
    maxScore: z.number().min(0).max(100).optional(),
    recommendation: z.enum(["strong_apply", "apply", "stretch", "weak"]).optional(),
    resumeVariant: z.enum([...RESUME_TYPES, ...LEGACY_RESUME_TYPES]).optional(),
    outcome: z.enum(APPLICATION_STATUSES).optional(),
    promptVersion: z.string().trim().min(1).max(80).optional(),
    appliedAfter: z.string().trim().min(10).max(40).optional(),
    appliedBefore: z.string().trim().min(10).max(40).optional(),
    days: z.number().int().min(1).max(MCP_MAX_DAYS).default(MCP_MAX_DAYS),
    limit: z.number().int().min(1).max(MCP_MAX_LIMIT).default(MCP_DEFAULT_LIMIT),
    offset: z.number().int().min(0).max(10_000).default(0),
  })
  .strict();

export const GetScoringAuditContextInput = z
  .object({
    key: z.string().trim().min(1).max(500),
  })
  .strict();

export const ListMissingJobDescriptionsInput = z
  .object({
    query: z.string().trim().min(1).max(200).optional(),
    days: z.number().int().min(1).max(MCP_MAX_DAYS).default(MCP_DEFAULT_DAYS),
    limit: z.number().int().min(1).max(MCP_MAX_LIMIT).default(MCP_DEFAULT_LIMIT),
    offset: z.number().int().min(0).max(10_000).default(0),
  })
  .strict();

const isoTimestamp = z
  .string()
  .trim()
  .min(10)
  .max(40)
  .refine((value) => !Number.isNaN(Date.parse(value)), { message: "retrievedAt must be an ISO timestamp" });

export const SubmitJdCandidateInputSchema = z
  .object({
    applicationKey: z.string().trim().min(1).max(500),
    company: z.string().trim().min(1).max(200),
    title: optionalText(300),
    originalText: z.string().min(40).max(80_000),
    sourceUrl: z.string().url(),
    sourceType: z.enum(["company_site", "ats", "aggregator", "other"]),
    retrievedAt: isoTimestamp.optional(),
    matchEvidence: z.array(z.string().trim().min(1).max(400)).min(1).max(10),
    completeness: z.enum(["full", "partial"]),
    location: optionalText(200),
    requisitionId: optionalText(80),
    datePosted: optionalText(40),
    competingPostings: z
      .array(z.object({ url: z.string().url(), title: optionalText(300) }).strict())
      .max(8)
      .optional(),
    claudeConfidence: z.number().min(0).max(100).optional(),
  })
  .strict();

export { ProposeScoringCorrectionInput };

export const ClaimJdRecoveryBatchInputSchema = z
  .object({
    days: z.number().int().min(1).max(MCP_MAX_DAYS).default(MCP_MAX_DAYS),
    limit: z.number().int().min(1).max(JD_RECOVERY_MAX_BATCH).default(JD_RECOVERY_DEFAULT_BATCH),
    mode: z.enum(["default", "retry_only"]).default("default"),
    sessionId: z.string().trim().min(8).max(80).optional(),
    includeSkipped: z.boolean().optional(),
  })
  .strict();

export const RecordJdRecoveryOutcomeInputSchema = z
  .object({
    applicationKey: z.string().trim().min(1).max(500),
    outcome: z.enum(JD_RECOVERY_OUTCOMES),
    reason: z.string().trim().min(3).max(400).optional(),
    evidence: z.array(z.string().trim().min(1).max(240)).max(8).optional(),
    sourceUrl: z.string().url().optional(),
    sessionId: z.string().trim().min(8).max(80).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.outcome !== "candidate_submitted" && !value.reason) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "reason is required unless outcome is candidate_submitted",
        path: ["reason"],
      });
    }
  });

export const ClassifyApplicationPostingKindInputSchema = z
  .object({
    applicationKey: z.string().trim().min(1).max(500),
    postingKind: z.enum(POSTING_KINDS),
    reason: z.string().trim().min(3).max(400),
    evidence: z.array(z.string().trim().min(1).max(240)).max(8).optional(),
  })
  .strict();

export const GetJdRecoveryProgressInputSchema = z
  .object({
    days: z.number().int().min(1).max(MCP_MAX_DAYS).default(MCP_MAX_DAYS),
  })
  .strict();

export const SaveJobProspectInputSchema = z
  .object({
    rawText: z.string().min(50).max(80_000),
    company: z.string().trim().min(1).max(200),
    title: z.string().trim().min(1).max(300),
    location: optionalText(200),
    seniority: optionalText(100),
    requisitionId: optionalText(80),
    sourceUrl: z.preprocess(
      (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
      z.string().url().optional(),
    ),
    salary: optionalText(200),
  })
  .strict();

const saveJobProspect = async (args: z.infer<typeof SaveJobProspectInputSchema>, deps: McpDeps) =>
  deps.saveJobProspect({
    rawText: args.rawText,
    company: args.company,
    title: args.title,
    location: args.location,
    seniority: args.seniority,
    requisitionId: args.requisitionId,
    sourceUrl: args.sourceUrl,
    salary: args.salary,
  });

const matchesQuery = (app: GmailApplication, query: string | undefined): boolean => {
  if (!query) return true;
  const q = query.toLowerCase();
  return app.company.toLowerCase().includes(q) || (app.role ?? "").toLowerCase().includes(q);
};

const listApplications = async (args: z.infer<typeof ListApplicationsInput>, deps: McpDeps) => {
  const apps = await deps.getApplications(args.days);
  const matched = apps.filter((app) => (!args.status || app.status === args.status) && matchesQuery(app, args.query));
  const page = matched.slice(0, args.limit);
  const keys = page.map((app) => app.key);
  const [evaluations, revisions] = await Promise.all([
    deps.getEvaluationsByKeys(keys),
    deps.getActiveScoreRevisions(keys),
  ]);
  return {
    days: args.days,
    totalMatched: matched.length,
    applications: page.map((app) => toListRow(app, evaluations.get(app.key), revisions.get(app.key))),
  };
};

const getApplicationDetails = async (args: z.infer<typeof GetApplicationDetailsInput>, deps: McpDeps) => {
  const apps = await deps.getApplications(MCP_MAX_DAYS);
  const app = apps.find((row) => row.key === args.key);
  if (!app) {
    throw new McpToolError("NOT_FOUND", `No application with key ${args.key}`);
  }
  const [evaluations, revisions] = await Promise.all([
    deps.getEvaluationsByKeys([app.key]),
    deps.getActiveScoreRevisions([app.key]),
  ]);
  return toDetailsView(app, evaluations.get(app.key), revisions.get(app.key));
};

const getApplicationInsights = async (_args: z.infer<typeof GetApplicationInsightsInput>, deps: McpDeps) =>
  toInsightsView(await deps.getLatestInsightsRun());

const listMissing = async (args: z.infer<typeof ListMissingJobDescriptionsInput>, deps: McpDeps) => {
  const apps = await deps.getApplications(args.days);
  const evaluations = await deps.getEvaluationsByKeys(apps.map((app) => app.key));
  const page = listMissingJobDescriptions(apps, evaluations, {
    offset: args.offset,
    limit: args.limit,
    query: args.query,
  });
  return { days: args.days, offset: args.offset, ...page };
};

const listScoredForAudit = async (args: z.infer<typeof ListScoredApplicationsForAuditInput>, deps: McpDeps) => {
  const apps = await deps.getApplications(args.days);
  const keys = apps.map((app) => app.key);
  const [evaluations, revisions] = await Promise.all([
    deps.getEvaluationsByKeys(keys),
    deps.getActiveScoreRevisions(keys),
  ]);
  const page = listScoredApplicationsForAudit(
    apps,
    evaluations,
    {
      query: args.query,
      roleCategory: args.roleCategory,
      minScore: args.minScore,
      maxScore: args.maxScore,
      recommendation: args.recommendation,
      resumeVariant: args.resumeVariant,
      outcome: args.outcome,
      promptVersion: args.promptVersion,
      appliedAfter: args.appliedAfter,
      appliedBefore: args.appliedBefore,
      offset: args.offset,
      limit: args.limit,
    },
    revisions,
  );
  return {
    readOnly: true as const,
    days: args.days,
    offset: args.offset,
    scoringModel: SCORING_MODEL_FOR_AUDIT,
    auditProtocol: AUDIT_PROTOCOL,
    ...page,
  };
};

const getScoringAuditContext = async (args: z.infer<typeof GetScoringAuditContextInput>, deps: McpDeps) => {
  const apps = await deps.getApplications(MCP_MAX_DAYS);
  const app = apps.find((row) => row.key === args.key);
  if (!app) {
    throw new McpToolError("NOT_FOUND", `No application with key ${args.key}`);
  }
  const [evaluations, revisions] = await Promise.all([
    deps.getEvaluationsByKeys([app.key]),
    deps.getActiveScoreRevisions([app.key]),
  ]);
  const evaluation = evaluations.get(app.key);
  if (!isScoredEvaluation(evaluation)) {
    throw new McpToolError("NOT_SCORED", `${args.key} is not a scored application`);
  }
  return buildScoringAuditContext({
    app,
    evaluation,
    profile: deps.getUserProfile(),
    resumeContexts: await deps.getResumeContexts(),
    revision: revisions.get(app.key),
  });
};

const mapSubmitError = (error: unknown): never => {
  if (error instanceof ApplicationUnresolvedError) throw new McpToolError("APPLICATION_UNRESOLVED", error.message);
  if (error instanceof EvaluationNotFoundError) throw new McpToolError("NOT_FOUND", error.message);
  if (error instanceof CompanyMismatchError) throw new McpToolError("COMPANY_MISMATCH", error.message);
  if (error instanceof AlreadyScoredError) throw new McpToolError("ALREADY_SCORED", error.message);
  if (error instanceof InvalidJdCandidateError) throw new McpToolError("INVALID_CANDIDATE", error.message);
  if (error instanceof CandidatesFullError) throw new McpToolError("CANDIDATES_FULL", error.message);
  throw error;
};

const proposeScoringCorrection = async (args: ProposeScoringCorrectionArgs, deps: McpDeps) => {
  try {
    return await deps.proposeScoringCorrection(args);
  } catch (error) {
    if (error instanceof ScoreRevisionError) {
      if (isReviewRequiredCode(error.code)) {
        return {
          status: "review_required" as const,
          approved: false as const,
          code: error.code,
          message: error.message,
        };
      }
      throw new McpToolError(error.code, error.message);
    }
    throw error;
  }
};

const submitCandidate = async (args: z.infer<typeof SubmitJdCandidateInputSchema>, deps: McpDeps) => {
  try {
    const result = await deps.submitJdCandidate({
      applicationKey: args.applicationKey,
      company: args.company,
      title: args.title,
      originalText: args.originalText,
      sourceUrl: args.sourceUrl,
      sourceType: args.sourceType,
      retrievedAt: args.retrievedAt,
      matchEvidence: args.matchEvidence,
      completeness: args.completeness,
      location: args.location,
      requisitionId: args.requisitionId,
      datePosted: args.datePosted,
      competingPostings: args.competingPostings,
      claudeConfidence: args.claudeConfidence,
    });
    await deps.syncJdRecoveryQueueAfterCandidate?.(result);
    return result;
  } catch (error) {
    if (error instanceof ApplicationUnresolvedError) return error.toResult();
    return mapSubmitError(error);
  }
};

const requireQueue = <T>(fn: T | undefined, name: string): T => {
  if (!fn) throw new McpToolError("UNAVAILABLE", `${name} is not wired in this MCP process`);
  return fn;
};

const claimJdRecoveryBatch = async (
  args: z.infer<typeof ClaimJdRecoveryBatchInputSchema>,
  deps: McpDeps,
) => requireQueue(deps.claimJdRecoveryBatch, "claim_next_jd_recovery_batch")(args);

const recordJdRecoveryOutcome = async (
  args: z.infer<typeof RecordJdRecoveryOutcomeInputSchema>,
  deps: McpDeps,
) => {
  if (args.outcome === "not_a_job_posting") {
    const classify = requireQueue(deps.classifyApplicationPostingKind, "classify_application_posting_kind");
    const classified = await classify({
      applicationKey: args.applicationKey,
      postingKind: "talent_pool_or_event",
      reason: args.reason ?? "not_a_job_posting",
      evidence: args.evidence,
    });
    const recorded = await requireQueue(deps.recordJdRecoveryOutcome, "record_jd_recovery_outcome")(args);
    return { ...recorded, postingKind: classified.postingKind, postingKindNote: classified.note };
  }
  return requireQueue(deps.recordJdRecoveryOutcome, "record_jd_recovery_outcome")(args);
};

const getJdRecoveryProgress = async (
  args: z.infer<typeof GetJdRecoveryProgressInputSchema>,
  deps: McpDeps,
) => requireQueue(deps.getJdRecoveryProgress, "get_jd_recovery_progress")(args);

const classifyApplicationPostingKind = async (
  args: z.infer<typeof ClassifyApplicationPostingKindInputSchema>,
  deps: McpDeps,
) => {
  try {
    return await requireQueue(deps.classifyApplicationPostingKind, "classify_application_posting_kind")(args);
  } catch (error) {
    if (error instanceof EvaluationNotFoundError) throw new McpToolError("NOT_FOUND", error.message);
    if (error instanceof AlreadyScoredError) throw new McpToolError("ALREADY_SCORED", error.message);
    if (error instanceof InvalidPostingKindError) throw new McpToolError("INVALID_POSTING_KIND", error.message);
    throw error;
  }
};

export const MCP_TOOLS = [
  {
    name: "list_applications" as const,
    description:
      "List compact job-application rows from the local Job Search Copilot database (synced Gmail + tracker). Filter by company/role text, status, and lookback days.",
    inputSchema: ListApplicationsInput,
    execute: listApplications,
  },
  {
    name: "get_application_details" as const,
    description:
      "Get one application by key: stage, recent email subjects (not bodies or senders), interview rounds, and fit totals. No job-description text.",
    inputSchema: GetApplicationDetailsInput,
    execute: getApplicationDetails,
  },
  {
    name: "get_application_insights" as const,
    description:
      "Return the latest stored insights run (coverage counts, sample sizes, screening tables, headline). Does not start a new analysis or spend LLM budget.",
    inputSchema: GetApplicationInsightsInput,
    execute: getApplicationInsights,
  },
  {
    name: "save_job_prospect" as const,
    description:
      "Save a pasted job description as a prospect for Gmail matching. Extract company and title from the JD and pass the original pasted text plus any other structured fields you have. Location, seniority, requisition ID, posting URL, and salary are optional. Returns explicit `matchStatus`: awaiting_gmail_application, queued_for_scoring, pending_review, scored, or unmatched, plus a `note` you must report to the user. The save itself does not create an application. Unique company/title matches may start a background recovery run that attaches, scores, and tracker-syncs; `recoveryQueued: true` means that run was started or already running, not that scoring finished. `matchStatus: scored` is the only value that means an authoritative fit already exists. Uncertain matches stay pending_review for dashboard confirmation. Check get_application_details afterwards when queued.",
    inputSchema: SaveJobProspectInputSchema,
    execute: saveJobProspect,
  },
  {
    name: "list_missing_job_descriptions" as const,
    description:
      "List applications that still need a job description (not scored). Returns an allowlisted page: application key, company, title, applied date if known, recovery status, and submitted candidate source metadata. No email bodies, senders, JD text, or credentials. `days` only filters eligibility after applications are grouped over the full 120-day identity window, so keys match submit_jd_candidate. For newest-first recovery work prefer claim_next_jd_recovery_batch (default 120 days, limit 5) instead of shrinking this window. Does not start recovery or scoring.",
    inputSchema: ListMissingJobDescriptionsInput,
    execute: listMissing,
  },
  {
    name: "submit_jd_candidate" as const,
    description:
      "Submit a web-retrieved job posting as a review candidate for an existing Gmail application key. Requires the original retrieved text, source URL, source type, match evidence, and completeness (full or partial). Optional location, requisition ID, posting date, competing postings, and claudeConfidence (0–100) are stored as Claude-reported assertions and never treated as proof. The server captures a deterministic evidence snapshot and a shadow auto-confirm recommendation; shadow never confirms or scores. Partial JDs are stored for review but are ineligible to score. If the claimed applicationKey is not in the current Gmail listing, returns status application_unresolved with same-company keys as hints only — do not merge keys. If this exact URL was previously removed or rejected, the tool returns previously_removed or previously_rejected and does not reactivate the candidate — search for a different posting. The user must confirm the match in the JD Review page or dashboard before scoring.",
    inputSchema: SubmitJdCandidateInputSchema,
    execute: submitCandidate,
  },
  {
    name: "claim_next_jd_recovery_batch" as const,
    description:
      "Atomically claim the next unscored Gmail applications that still need a job description. Default batch is five. Omit `days` (default 120, the MCP max) to take the newest five eligible applications across the normal lookback; do not shrink `days` just to get recent work — newest-first ordering already does that. `days` only restricts eligibility after applications are grouped over the full 120-day identity window so claimed keys match submit_jd_candidate. Prioritizes never-attempted keys, newest appliedAt first, then older unattempted rows, then retry_due (also newest first). Excludes scored rows, pending human JD confirmation, talent-pool/event registrations, unresolved orphan keys, skipped_requires_review (unless includeSkipped), and not_found rows until their retry date. skipped_requires_review is not a posting miss and is not claimed automatically. Returns allowlisted Gmail metadata for searching (no bodies, senders, JD text, or credentials). Uses a Mongo lease so overlapping Claude sessions cannot claim the same work; expired leases become eligible again. Does not search, submit, confirm, or score.",
    inputSchema: ClaimJdRecoveryBatchInputSchema,
    annotations: {
      title: "Claim JD recovery batch",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
    execute: claimJdRecoveryBatch,
  },
  {
    name: "record_jd_recovery_outcome" as const,
    description:
      "Record the result of a claimed JD search: candidate_submitted, not_found, temporary_error, skipped_requires_review, not_a_job_posting, or unresolved_application. not_found waits seven days before retry. skipped_requires_review is held for a human (identity conflict, ambiguous req ID, etc.): it is not a posting miss, has no retry date, and is excluded from automatic and retry_only batches unless includeSkipped is set. not_a_job_posting is an explicit talent-pool/event classification (never inferred from completeness); it is distinct from not_found and excluded from recovery until restored. If the applicationKey is missing from Gmail, the queue row is preserved as unresolved_application and is not silently dropped from progress. temporary_error is retryable sooner and stays distinguishable from a posting miss. candidate_submitted requires an existing submit_jd_candidate row and never marks the job completed or scored. Completed only after dashboard confirmation and a successful score. Releases the claim lease.",
    inputSchema: RecordJdRecoveryOutcomeInputSchema,
    annotations: {
      title: "Record JD recovery outcome",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
    execute: recordJdRecoveryOutcome,
  },
  {
    name: "get_jd_recovery_progress" as const,
    description:
      "Read-only JD recovery backlog summary: total Gmail applications in the lookback window, scored, unattempted, in progress, pending human JD review, not found (retry not due), skipped requires review, not-a-job registrations, retry due, and temporary failures. Queue keys missing from Gmail or outside the requested days are reported in unresolvedQueue (missingGmailRecord vs outsideLookback) instead of disappearing from totals. Counts of listed Gmail apps are mutually exclusive. skippedRequiresReview is not counted as not_found. Does not search, claim, confirm, or score.",
    inputSchema: GetJdRecoveryProgressInputSchema,
    annotations: {
      title: "JD recovery progress",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    execute: getJdRecoveryProgress,
  },
  {
    name: "classify_application_posting_kind" as const,
    description:
      "Explicitly classify one Gmail application as job_posting, talent_pool_or_event, or unknown. Requires a reason. Does not infer from completeness, compensation, or geography. talent_pool_or_event preserves the Gmail record and any submitted candidate evidence, excludes the key from JD recovery, and refuses scoring; it is distinct from not_found. Classify back to job_posting or unknown to restore. Refuses scored evaluations. Does not bulk-classify or create applications.",
    inputSchema: ClassifyApplicationPostingKindInputSchema,
    annotations: {
      title: "Classify application posting kind",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
    execute: classifyApplicationPostingKind,
  },
  {
    name: "list_scored_applications_for_audit" as const,
    description:
      "Read-only scored-application sample list for a scoring audit. Returns paginated metadata (effective displayed score, recommendation, resume variant, role category, outcome, evidence-completeness flags) plus the scoring model and audit protocol. Uses the approved historical revision when one exists. Does not rescore, does not approve revisions, does not call OpenAI, and does not return JD text, email bodies, senders, or credentials.",
    inputSchema: ListScoredApplicationsForAuditInput,
    execute: listScoredForAudit,
  },
  {
    name: "get_scoring_audit_context" as const,
    description:
      "Read-only scoring audit packet for one scored application: stored JD, persisted fit breakdown and scoring snapshot when present, current candidate profile, the recommended resume variant, and scoring.evaluationFingerprint (the canonical stored-evaluation hash required by propose_scoring_correction — not jobDescription.textHash). The displayed total is the approved historical revision when one exists, otherwise the stored authoritative overlay. Uses stored scoring outputs only — does not rescore, does not approve or create revisions, does not call OpenAI, and does not write evaluations. Missing historical internals are listed in evidenceGaps instead of being reconstructed. For supported interpretation errors, use propose_scoring_correction with JD quotes; do not treat a verbal corrected score as a write.",
    inputSchema: GetScoringAuditContextInput,
    execute: getScoringAuditContext,
  },
  {
    name: "propose_scoring_correction" as const,
    description:
      "Submit an evidence-backed correction to an allowlisted scoring input (years-of-experience minimum, inferred seniority, mixed-stack vs exclusive core language, or role lane). Requires the exact application key, current evaluation fingerprint, original and proposed values, and JD quotes that appear in the stored posting. The scoring engine independently recomputes the score; any numeric score you supply is ignored and rejected. Creates a proposed revision only — does not approve, roll back, change weights, modify the stored evaluation, update the tracker, call the paid scorer, or regenerate insights. Role-lane changes require allowRoleLaneChange after explicit review. The user must approve in the dashboard.",
    inputSchema: ProposeScoringCorrectionInput,
    annotations: {
      title: "Propose scoring correction",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
    execute: proposeScoringCorrection,
  },
];

export const MCP_TOOL_NAMES = MCP_TOOLS.map((tool) => tool.name);

export const runMcpTool = async (name: string, rawArgs: unknown, deps: McpDeps): Promise<unknown> => {
  const tool = MCP_TOOLS.find((entry) => entry.name === name);
  if (!tool) {
    throw new McpToolError("UNKNOWN_TOOL", `Unknown tool ${name}`);
  }
  const args = tool.inputSchema.parse(rawArgs ?? {});
  return tool.execute(args as never, deps);
};
