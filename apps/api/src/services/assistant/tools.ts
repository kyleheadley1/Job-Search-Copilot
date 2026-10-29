import { randomUUID } from "node:crypto";
import type { JobRecord, JobStatus } from "../../types/job.js";
import type { TopJobRecord } from "../../types/topJob.js";
import type { AgentSuggestion } from "../agent/suggestions.repository.js";
import type { GmailApplication } from "../gmail/gmailApplications.js";
import type { ApplicationEvaluation } from "../gmail/jdRecovery/evaluations.repository.js";
import { presentFitForDisplay } from "../../lib/authoritativeScore.js";
import { loadApprovedOverlays } from "../scoring/scoreRevisions.service.js";
import type { MonthSpend } from "../gmail/jdRecovery/recoveryMetrics.js";
import type { ToolDef } from "../llm/responsesClient.js";
import type { AlertListingDoc } from "../topJobs/alertListings.repository.js";
import type { AssistantProposal, ProposalPayload } from "./assistant.repository.js";

export type AssistantToolDeps = {
  loadApps: () => Promise<GmailApplication[]>;
  getEvaluation: (key: string) => Promise<ApplicationEvaluation | null>;
  listTracker: () => Promise<JobRecord[]>;
  getJob: (id: string) => Promise<JobRecord | null>;
  listTopJobs: () => Promise<TopJobRecord[]>;
  listQueue: () => Promise<AlertListingDoc[]>;
  getListing: (key: string) => Promise<AlertListingDoc | null>;
  listNextSteps: () => Promise<AgentSuggestion[]>;
  monthSpend: () => Promise<MonthSpend>;
  saveProposal: (p: AssistantProposal) => Promise<void>;
};

const TRACKER_STATUSES: JobStatus[] = [
  "to_review",
  "applied",
  "skip",
  "rejected",
  "interviewing",
  "assessment",
  "closed",
  "offer",
  "lapsed",
];
const EMAIL_KINDS = ["follow_up", "thank_you", "reply", "withdraw", "other"] as const;
const MAX_JD_CHARS = 4000;
const MAX_EMAIL_CHARS = 1500;

const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
const limitOf = (v: unknown, fallback: number, max: number) =>
  typeof v === "number" && Number.isFinite(v) ? Math.max(1, Math.min(max, Math.floor(v))) : fallback;
const matches = (query: string, ...fields: Array<string | null | undefined>) =>
  !query || fields.some((f) => f?.toLowerCase().includes(query.toLowerCase()));
const day = (iso?: string | null) => (iso ? iso.slice(0, 10) : null);

const appSummary = (a: GmailApplication) => ({
  key: a.key,
  company: a.company,
  role: a.role,
  status: a.status,
  furthestStage: a.furthestStage,
  appliedAt: day(a.appliedAt),
  lastUpdateAt: day(a.lastUpdateAt),
  rounds: a.interviewRounds.length,
  nextInterview:
    a.interviewRounds.find((r) => !r.cancelled && r.scheduledAt && Date.parse(r.scheduledAt) > Date.now())?.scheduledAt ??
    null,
  actionNeeded: a.actionNeeded ? `${a.actionNeeded.type}: ${a.actionNeeded.summary ?? ""}`.trim() : null,
  trackerJobId: a.trackerJobId ?? null,
  trackerStatus: a.trackerStatus ?? null,
});

const jobSummary = (j: JobRecord) => ({
  jobId: j.id,
  company: j.extracted.company,
  title: j.extracted.title,
  status: j.status,
  score: j.effectiveScore?.total ?? j.score?.total ?? null,
  appliedAt: day(j.tracker?.appliedAt),
  updatedAt: day(j.updatedAt),
});

/**
 * Read tools answer from your own data. Propose tools only store a card; nothing changes until you
 * press Approve on that card, which runs the stored proposal (never anything the model says later).
 */
export const buildAssistantTools = (deps: AssistantToolDeps, created: AssistantProposal[]): ToolDef[] => {
  const propose = async (title: string, payload: ProposalPayload) => {
    const proposal: AssistantProposal = {
      id: randomUUID(),
      title,
      payload,
      status: "open",
      createdAt: new Date().toISOString(),
    };
    await deps.saveProposal(proposal);
    created.push(proposal);
    return { proposalId: proposal.id, shownToUser: title, note: "Waiting for the user's approval; nothing has changed yet." };
  };

  return [
    {
      name: "search_applications",
      description:
        "Search applications found in Gmail (last 120 days) by company/role text and/or status. Returns compact rows with keys for get_application.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Company or role text; empty for all" },
          status: { type: "string", description: "applied | interviewing | rejected | offer | assessment" },
          limit: { type: "number" },
        },
      },
      run: async (args) => {
        const query = str(args.query);
        const status = str(args.status);
        const apps = (await deps.loadApps())
          .filter((a) => matches(query, a.company, a.role) && (!status || a.status === status || a.furthestStage === status))
          .sort((a, b) => b.lastUpdateAt.localeCompare(a.lastUpdateAt));
        return { total: apps.length, rows: apps.slice(0, limitOf(args.limit, 20, 40)).map(appSummary) };
      },
    },
    {
      name: "get_application",
      description: "Full detail for one Gmail application: emails, interview rounds, pending action, fit score.",
      parameters: { type: "object", properties: { key: { type: "string" } }, required: ["key"] },
      run: async (args) => {
        const key = str(args.key);
        const app = (await deps.loadApps()).find((a) => a.key === key);
        if (!app) return { error: `No application with key ${key}` };
        const evaluation = await deps.getEvaluation(key);
        const overlays = evaluation?.fit ? await loadApprovedOverlays([key]) : new Map();
        return {
          ...appSummary(app),
          emails: app.emails.slice(-15).map((e) => ({ date: day(e.date), event: e.eventType, from: e.from, subject: e.subject })),
          interviewRounds: app.interviewRounds.map((r) => ({
            label: r.label,
            scheduledAt: r.scheduledAt,
            interviewers: r.interviewers,
            cancelled: r.cancelled,
          })),
          actionDeadline: app.actionNeeded?.deadline ?? null,
          fit: evaluation?.fit
            ? (() => {
                const presented = presentFitForDisplay(evaluation.fit, {
                  revision: overlays.get(key),
                  evaluation,
                });
                return { total: presented.total, recommendation: presented.recommendation };
              })()
            : null,
          postingFound: Boolean(evaluation?.jd?.text),
        };
      },
    },
    {
      name: "get_jd_excerpt",
      description: "The stored job description text for a Gmail application (key) or a tracker job (jobId).",
      parameters: { type: "object", properties: { key: { type: "string" }, jobId: { type: "string" } } },
      run: async (args) => {
        const jobId = str(args.jobId);
        const text = jobId
          ? (await deps.getJob(jobId))?.extracted.rawText
          : (await deps.getEvaluation(str(args.key)))?.jd?.text;
        if (!text) return { error: "No stored job description" };
        return { text: text.slice(0, MAX_JD_CHARS), truncated: text.length > MAX_JD_CHARS };
      },
    },
    {
      name: "list_tracker",
      description: "Rows in the user's job tracker, newest activity first, optionally filtered by status or text.",
      parameters: {
        type: "object",
        properties: {
          status: { type: "string", enum: TRACKER_STATUSES },
          query: { type: "string" },
          limit: { type: "number" },
        },
      },
      run: async (args) => {
        const query = str(args.query);
        const status = str(args.status);
        const jobs = (await deps.listTracker())
          .filter((j) => (!status || j.status === status) && matches(query, j.extracted.company, j.extracted.title))
          .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
        return { total: jobs.length, rows: jobs.slice(0, limitOf(args.limit, 25, 50)).map(jobSummary) };
      },
    },
    {
      name: "list_top_jobs",
      description:
        "Top Jobs: roles already scored and listed, plus the queue of unscored job-alert listings (with the cheap prescreen verdict).",
      parameters: { type: "object", properties: {} },
      run: async () => {
        const [listed, queue] = await Promise.all([deps.listTopJobs(), deps.listQueue()]);
        return {
          listed: listed.slice(0, 20).map((t) => ({
            id: t.id,
            company: t.extracted.company,
            title: t.extracted.title,
            score: t.score.total,
            location: t.location ?? null,
          })),
          queueTotal: queue.length,
          queue: queue.slice(0, 25).map((l) => ({
            listingKey: l._id,
            company: l.company,
            title: l.title,
            location: l.location,
            prescreen: l.prescreen?.verdict ?? null,
          })),
        };
      },
    },
    {
      name: "list_next_steps",
      description: "Open items on the dashboard's Next steps list (follow-ups, thank-yous, interview prep, ghosted roles).",
      parameters: { type: "object", properties: {} },
      run: async () =>
        (await deps.listNextSteps()).map((s) => ({
          kind: s.kind,
          title: s.title,
          reason: s.reason,
          priority: s.priority,
          dueAt: s.dueAt ?? null,
          appKey: s.appKey,
        })),
    },
    {
      name: "cost_summary",
      description: "OpenAI spend this month, by feature, with each feature's monthly cap.",
      parameters: { type: "object", properties: {} },
      run: () => deps.monthSpend(),
    },
    {
      name: "propose_tracker_status",
      description:
        "Propose changing a tracker job's status. Creates an approval card; the change happens only if the user approves.",
      parameters: {
        type: "object",
        properties: {
          jobId: { type: "string" },
          status: { type: "string", enum: TRACKER_STATUSES },
          note: { type: "string", description: "One short reason shown on the card" },
        },
        required: ["jobId", "status"],
      },
      run: async (args) => {
        const status = str(args.status) as JobStatus;
        if (!TRACKER_STATUSES.includes(status)) return { error: `Unknown status ${status}` };
        const job = await deps.getJob(str(args.jobId));
        if (!job) return { error: "Tracker job not found; use list_tracker for jobIds" };
        if (job.status === status) return { error: `Already ${status}` };
        const company = job.extracted.company;
        const title = job.extracted.title;
        return propose(`Mark ${company} · ${title} as ${status} (now ${job.status})`, {
          kind: "tracker_status",
          jobId: job.id,
          company,
          title,
          fromStatus: job.status,
          status,
          note: str(args.note).slice(0, 200) || "Approved from assistant",
        });
      },
    },
    {
      name: "propose_email",
      description:
        "Propose a reply email in an application's Gmail thread (follow-up, thank-you, reply). Creates an approval card where the user can edit it; approving saves a Gmail draft, which the user sends themselves. The app can never send.",
      parameters: {
        type: "object",
        properties: {
          appKey: { type: "string" },
          kind: { type: "string", enum: [...EMAIL_KINDS] },
          body: { type: "string", description: "Plain-text email body, no subject line" },
        },
        required: ["appKey", "kind", "body"],
      },
      run: async (args) => {
        const body = str(args.body);
        if (!body) return { error: "Empty body" };
        if (body.length > MAX_EMAIL_CHARS) return { error: `Keep it under ${MAX_EMAIL_CHARS} characters` };
        const app = (await deps.loadApps()).find((a) => a.key === str(args.appKey));
        if (!app) return { error: "Application not found; use search_applications for keys" };
        const kind = (EMAIL_KINDS as readonly string[]).includes(str(args.kind)) ? str(args.kind) : "other";
        return propose(`Email draft to ${app.company}${app.role ? ` · ${app.role}` : ""} (${kind.replace("_", "-")})`, {
          kind: "email_draft",
          appKey: app.key,
          company: app.company,
          role: app.role,
          emailKind: kind,
          ...(app.actionNeeded?.emailId ? { preferEmailId: app.actionNeeded.emailId } : {}),
          body,
        });
      },
    },
    {
      name: "propose_score_listing",
      description:
        "Propose scoring one queued Top Jobs listing now (about $0.02, counted against the Top Jobs budget). Creates an approval card.",
      parameters: { type: "object", properties: { listingKey: { type: "string" } }, required: ["listingKey"] },
      run: async (args) => {
        const listing = await deps.getListing(str(args.listingKey));
        if (!listing) return { error: "Listing not found; use list_top_jobs for listingKeys" };
        const prescreenSkipped = listing.status === "filtered" && listing.reason === "prescreen";
        if (listing.status !== "pending" && !prescreenSkipped) return { error: `Already processed (${listing.status})` };
        return propose(`Score ${listing.company} · ${listing.title} for Top Jobs (~$0.02)`, {
          kind: "score_listing",
          listingKey: listing._id,
          company: listing.company,
          title: listing.title,
        });
      },
    },
  ];
};
