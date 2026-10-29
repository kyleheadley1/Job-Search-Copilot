import { z } from "zod";
import type { GmailApplication } from "../services/gmail/gmailApplications.js";
import type { ApplicationEvaluation } from "../services/gmail/jdRecovery/evaluations.repository.js";
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
