import { z } from "zod";
import type { GmailApplication } from "../services/gmail/gmailApplications.js";
import type { ApplicationEvaluation } from "../services/gmail/jdRecovery/evaluations.repository.js";
import {
  AlreadyScoredError,
  EvaluationNotFoundError,
} from "../services/gmail/jdRecovery/runRecovery.js";
import {
  CandidatesFullError,
  CompanyMismatchError,
  InvalidJdCandidateError,
  listMissingJobDescriptions,
  type SubmitJdCandidateInput,
  type SubmitJdCandidateResult,
} from "../services/gmail/jdRecovery/jdCandidates.service.js";
import type { SaveJobProspectInput, SaveJobProspectResult } from "../services/gmail/jdRecovery/jobProspects.service.js";
import type { InsightsRun } from "../services/insights/insights.repository.js";
import { toDetailsView, toInsightsView, toListRow } from "./views.js";

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
  getLatestInsightsRun: () => Promise<InsightsRun | null>;
  saveJobProspect: (input: SaveJobProspectInput) => Promise<SaveJobProspectResult>;
  submitJdCandidate: (input: SubmitJdCandidateInput) => Promise<SubmitJdCandidateResult>;
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
  const evaluations = await deps.getEvaluationsByKeys(page.map((app) => app.key));
  return {
    days: args.days,
    totalMatched: matched.length,
    applications: page.map((app) => toListRow(app, evaluations.get(app.key))),
  };
};

const getApplicationDetails = async (args: z.infer<typeof GetApplicationDetailsInput>, deps: McpDeps) => {
  const apps = await deps.getApplications(MCP_MAX_DAYS);
  const app = apps.find((row) => row.key === args.key);
  if (!app) {
    throw new McpToolError("NOT_FOUND", `No application with key ${args.key}`);
  }
  const evaluations = await deps.getEvaluationsByKeys([app.key]);
  return toDetailsView(app, evaluations.get(app.key));
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

const mapSubmitError = (error: unknown): never => {
  if (error instanceof EvaluationNotFoundError) throw new McpToolError("NOT_FOUND", error.message);
  if (error instanceof CompanyMismatchError) throw new McpToolError("COMPANY_MISMATCH", error.message);
  if (error instanceof AlreadyScoredError) throw new McpToolError("ALREADY_SCORED", error.message);
  if (error instanceof InvalidJdCandidateError) throw new McpToolError("INVALID_CANDIDATE", error.message);
  if (error instanceof CandidatesFullError) throw new McpToolError("CANDIDATES_FULL", error.message);
  throw error;
};

const submitCandidate = async (args: z.infer<typeof SubmitJdCandidateInputSchema>, deps: McpDeps) => {
  try {
    return await deps.submitJdCandidate({
      applicationKey: args.applicationKey,
      company: args.company,
      title: args.title,
      originalText: args.originalText,
      sourceUrl: args.sourceUrl,
      sourceType: args.sourceType,
      retrievedAt: args.retrievedAt,
      matchEvidence: args.matchEvidence,
      completeness: args.completeness,
    });
  } catch (error) {
    return mapSubmitError(error);
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
      "Save a pasted job description as a prospect for Gmail matching. Extract company and title from the JD and pass the original pasted text plus any other structured fields you have. Location, seniority, requisition ID, posting URL, and salary are optional. The save itself does not create an application or score the role, but it may start a background JD recovery run: if the prospect matches a Gmail application, that run can attach it, score the application, and sync the tracker. `recoveryQueued: true` means a run was started or already running, not that matching or scoring finished; check get_application_details afterwards.",
    inputSchema: SaveJobProspectInputSchema,
    execute: saveJobProspect,
  },
  {
    name: "list_missing_job_descriptions" as const,
    description:
      "List applications that still need a job description (not scored). Returns an allowlisted page: application key, company, title, applied date if known, recovery status, and submitted candidate source metadata. No email bodies, senders, JD text, or credentials. Use this before submit_jd_candidate. Does not start recovery or scoring.",
    inputSchema: ListMissingJobDescriptionsInput,
    execute: listMissing,
  },
  {
    name: "submit_jd_candidate" as const,
    description:
      "Submit a web-retrieved job posting as a review candidate for an existing Gmail application key. Requires the original retrieved text, source URL, source type, match evidence, and completeness (full or partial). Stores original plus cleaned text on the existing evaluation. Does not score, does not pick a winner among competing candidates, and does not overwrite a scored evaluation. Partial JDs are stored for review but are ineligible to score. The user must confirm the match in the dashboard before scoring. Self-reported confidence is not an input and is never treated as proof of a match.",
    inputSchema: SubmitJdCandidateInputSchema,
    execute: submitCandidate,
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
