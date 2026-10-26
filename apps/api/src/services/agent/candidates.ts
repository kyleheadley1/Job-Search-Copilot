import type { JobStatus } from "../../types/job.js";
import type { GmailApplication } from "../gmail/gmailApplications.js";

export const AGENT_KINDS = ["action_reply", "interview_prep", "thank_you", "follow_up", "mark_ghosted"] as const;
export type AgentKind = (typeof AGENT_KINDS)[number];

/** A next step found by free rules; the agent only ranks, explains, and drafts. */
export type AgentCandidate = {
  /** Stable per occurrence (kind + application + the event it hangs on), so dismissals stick. */
  id: string;
  kind: AgentKind;
  appKey: string;
  company: string;
  role: string | null;
  /** Rule-written headline, used as-is when the agent doesn't run. */
  title: string;
  /** Compact facts for the model; never email bodies or job descriptions. */
  facts: string;
  /** Rule priority, 1 (low) to 5 (urgent). */
  priority: number;
  dueAt?: string;
  gmailUrl?: string;
  trackerJobId?: string;
  /** The agent may write a short email draft for this kind. */
  draftable: boolean;
  /** Email whose thread a reply draft should go into (the request, or the interview's last email). */
  replyEmailId?: string;
  /** A tracker change that only happens when you approve it. */
  proposedChange?: { jobId: string; status: JobStatus };
};

const DAY_MS = 86_400_000;
/** Upcoming interviews this close get a prep reminder. */
export const PREP_WINDOW_DAYS = 3;
/** A thank-you is worth sending within this long after an interview. */
export const THANK_YOU_WINDOW_DAYS = 2;
/** Mid-process silence this long earns a polite follow-up. */
export const FOLLOW_UP_AFTER_DAYS = 7;
/** Total silence this long on an open application suggests marking it lapsed. */
export const GHOSTED_AFTER_DAYS = 30;

const OPEN_TRACKER: JobStatus[] = ["applied", "assessment", "interviewing"];

const roleText = (app: GmailApplication) => (app.role ? `${app.role} at ${app.company}` : app.company);
const daysAgo = (iso: string, now: number) => Math.floor((now - Date.parse(iso)) / DAY_MS);
const day = (iso: string) => iso.slice(0, 10);

const upcomingRound = (app: GmailApplication, now: number) =>
  app.interviewRounds.find((r) => !r.cancelled && r.scheduledAt && Date.parse(r.scheduledAt) > now);

/** Open tracker row, no upcoming interview or pending request, and no email for 30+ days. */
export const shouldAutoLapse = (app: GmailApplication, now = Date.now()): boolean => {
  if (app.status === "rejected" || app.status === "offer") return false;
  if (!app.trackerJobId || !app.trackerStatus || !OPEN_TRACKER.includes(app.trackerStatus)) return false;
  if (app.actionNeeded || upcomingRound(app, now)) return false;
  return daysAgo(app.lastUpdateAt, now) >= GHOSTED_AFTER_DAYS;
};

export const autoLapseNote = (silentDays: number): string =>
  `auto-lapse: no email for ${silentDays}d (${GHOSTED_AFTER_DAYS}+ day silence threshold)`;

export const gatherCandidates = (apps: GmailApplication[], now = Date.now()): AgentCandidate[] => {
  const out: AgentCandidate[] = [];
  for (const app of apps) {
    if (app.status === "rejected") continue;
    const hasOffer = app.status === "offer";
    const base = { appKey: app.key, company: app.company, role: app.role, trackerJobId: app.trackerJobId };
    const silentDays = daysAgo(app.lastUpdateAt, now);
    const rounds = app.interviewRounds.filter((r) => !r.cancelled);
    const upcoming = upcomingRound(app, now);

    if (app.actionNeeded) {
      const a = app.actionNeeded;
      const dueSoon = a.deadline && Date.parse(a.deadline) - now < 2 * DAY_MS;
      out.push({
        ...base,
        id: `action_reply:${app.key}:${a.emailId}`,
        kind: "action_reply",
        title: `${a.summary ?? "Reply to the recruiter"} (${roleText(app)})`,
        facts: `${a.type} request received ${daysAgo(a.receivedAt, now)}d ago${a.deadline ? `, deadline ${a.deadline}` : ""}; request: ${a.summary ?? "unspecified"}`,
        priority: dueSoon ? 5 : 4,
        ...(a.deadline ? { dueAt: a.deadline } : {}),
        gmailUrl: a.gmailUrl,
        draftable: a.type === "reply" || a.type === "schedule",
        replyEmailId: a.emailId,
      });
    }

    if (upcoming && Date.parse(upcoming.scheduledAt!) - now <= PREP_WINDOW_DAYS * DAY_MS) {
      const hoursOut = Math.round((Date.parse(upcoming.scheduledAt!) - now) / 3_600_000);
      out.push({
        ...base,
        id: `interview_prep:${app.key}:${upcoming.number}`,
        kind: "interview_prep",
        title: `Prep for ${upcoming.label} (${roleText(app)})`,
        facts: `${upcoming.label} in ${hoursOut}h${upcoming.focus ? `, focus: ${upcoming.focus}` : ""}${upcoming.interviewers ? `, with ${upcoming.interviewers}` : ""}`,
        priority: hoursOut <= 24 ? 5 : 4,
        dueAt: upcoming.scheduledAt!,
        draftable: false,
      });
    }

    const justHeld = [...rounds]
      .reverse()
      .find(
        (r) =>
          r.scheduledAt &&
          Date.parse(r.scheduledAt) <= now &&
          now - Date.parse(r.scheduledAt) <= THANK_YOU_WINDOW_DAYS * DAY_MS,
      );
    if (justHeld && !hasOffer) {
      out.push({
        ...base,
        id: `thank_you:${app.key}:${justHeld.number}`,
        kind: "thank_you",
        title: `Send a thank-you for ${justHeld.label} (${roleText(app)})`,
        facts: `${justHeld.label} held ${daysAgo(justHeld.scheduledAt!, now)}d ago${justHeld.interviewers ? ` with ${justHeld.interviewers}` : ""}${justHeld.focus ? `, focus: ${justHeld.focus}` : ""}`,
        priority: 3,
        draftable: true,
        ...(justHeld.emailIds.length ? { replyEmailId: justHeld.emailIds[justHeld.emailIds.length - 1] } : {}),
      });
    }

    const midProcess = app.furthestStage !== "applied" && !hasOffer;
    if (
      midProcess &&
      !upcoming &&
      !app.actionNeeded &&
      !justHeld &&
      silentDays >= FOLLOW_UP_AFTER_DAYS &&
      silentDays < GHOSTED_AFTER_DAYS
    ) {
      out.push({
        ...base,
        id: `follow_up:${app.key}:${day(app.lastUpdateAt)}`,
        kind: "follow_up",
        title: `Follow up on ${roleText(app)}`,
        facts: `reached ${app.interviewRounds.at(-1)?.label ?? app.furthestStage}; no email for ${silentDays}d`,
        priority: 3,
        draftable: true,
      });
    }

  }
  return out.sort((a, b) => b.priority - a.priority || (a.dueAt ?? "9999").localeCompare(b.dueAt ?? "9999"));
};
