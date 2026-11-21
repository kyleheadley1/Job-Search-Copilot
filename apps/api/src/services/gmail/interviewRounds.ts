import { z } from "zod";
import { env } from "../../config/env.js";
import { withLlmContext } from "../llm/llmUsage.js";
import { responsesClient } from "../llm/responsesClient.js";
import type { ParsedEmail } from "./gmailClient.js";
import type { StoredGmailMessage } from "./gmailMessages.repository.js";

export const INTERVIEW_KINDS = [
  "recruiter_screen",
  "hiring_manager",
  "technical",
  "system_design",
  "behavioral",
  "team",
  "onsite",
  "final",
  "other",
] as const;
export type InterviewKind = (typeof INTERVIEW_KINDS)[number];

/** Round facts read from a single interview email. Stored on the message classification. */
export type InterviewDetail = {
  /** Only when the email states it ("second round" → 2). "Final round" is a kind, not a number. */
  roundNumber: number | null;
  kind: InterviewKind | null;
  /** Short description of what the round covers, e.g. "live coding" or "system design". */
  focus: string | null;
  /** Who the candidate meets, e.g. "Jane Doe (Engineering Manager)". */
  interviewers: string | null;
  /** The email says a previous interview went well and invites the candidate to another one. */
  advancesToNextRound: boolean;
  /** Confirmed interview start (UTC ISO). Null for proposed slots or scheduling links. */
  scheduledAt: string | null;
  durationMinutes: number | null;
  /** The email cancels the interview. */
  cancelled: boolean;
  /** Extraction prompt version; older details are re-extracted on sync. */
  version: number;
};

/** Bump when InterviewDetail gains fields, so stored details are re-extracted. */
export const INTERVIEW_DETAIL_VERSION = 3;

export type InterviewRound = {
  number: number;
  kind: InterviewKind | null;
  focus: string | null;
  interviewers: string | null;
  startedAt: string;
  lastEmailAt: string;
  emailIds: string[];
  /** Latest known start time for this round (a reschedule overrides an earlier time). */
  scheduledAt: string | null;
  durationMinutes: number | null;
  cancelled: boolean;
  /** "Recruiter screen", "2nd round", "3rd round · technical with Jane Doe". */
  label: string;
};

const DetailSchema = z.object({
  roundNumber: z.number().int().min(1).max(10).nullable().optional(),
  kind: z.enum(INTERVIEW_KINDS).nullable().optional(),
  focus: z.string().trim().min(1).max(80).nullable().optional(),
  interviewers: z.string().trim().min(1).max(120).nullable().optional(),
  advancesToNextRound: z.boolean().optional(),
  scheduledAt: z.string().trim().min(1).nullable().optional(),
  durationMinutes: z.number().int().min(5).max(600).nullable().optional(),
  cancelled: z.boolean().optional(),
});

const EMPTY_DETAIL: InterviewDetail = {
  roundNumber: null,
  kind: null,
  focus: null,
  interviewers: null,
  advancesToNextRound: false,
  scheduledAt: null,
  durationMinutes: null,
  cancelled: false,
  version: INTERVIEW_DETAIL_VERSION,
};

const SYSTEM_PROMPT = `You read one interview-related email from a job seeker's inbox and describe the interview round it is about.

Return JSON only:
{
  "roundNumber": number | null,       // only if the email states it ("second round" → 2, "round 3" → 3); otherwise null
  "kind": "recruiter_screen" | "hiring_manager" | "technical" | "system_design" | "behavioral" | "team" | "onsite" | "final" | "other" | null,
  "focus": string | null,             // what the round covers in a few words ("live coding", "past projects deep dive"); null if not stated
  "interviewers": string | null,      // who the candidate meets, with title if given ("Jane Doe (Engineering Manager)"); null if not stated
  "advancesToNextRound": boolean,     // true only when the email says a previous interview went well / the candidate is moving forward and invites them to another interview
  "scheduledAt": string | null,       // confirmed start time as ISO 8601 with UTC offset, e.g. "2026-10-05T15:00:00-04:00"; null if no confirmed time
  "durationMinutes": number | null,   // from an end time or stated length; null if unknown
  "cancelled": boolean                // true when the email cancels the interview
}

Rules:
- recruiter_screen: intro call, phone screen, or chat with a recruiter / talent partner / people team. A meeting with someone whose role is unknown or who is not in recruiting (founder, engineer, manager) is not a recruiter screen: use hiring_manager, technical, team, or other.
- final: explicitly a final round or final interview. onsite: onsite / virtual onsite / superday / interview loop.
- Calendar invites, confirmations, and reschedules are about an already-arranged round: advancesToNextRound is false.
- Do not count the scheduling coordinator as an interviewer unless they run the interview. Give only real job titles in parentheses; omit calendar roles like "organizer". Never list the candidate.
- scheduledAt: only a confirmed, specific date and time (calendar invite, "confirmed for", "see you on"). Proposed slots, availability requests, and scheduling links are null. Resolve relative dates ("tomorrow", "Monday") against the email's Date. If the email gives a time but no date or weekday (e.g. "4:30 PM - 5:00 PM (EDT)" alone), return null: never assume it is the email's own date. Use the timezone the email states; if none is stated, use the candidate's timezone given below.
- US civil-time offsets must match the interview calendar date (not "always daylight"): after the first Sunday in November use standard time (PT=-08:00 / PST, ET=-05:00 / EST, MT=-07:00 / MST, CT=-06:00 / CST). From the second Sunday in March through that November switch use daylight (PT=-07:00 / PDT, ET=-04:00 / EDT, etc.). "1:40 PM PT" on 2026-11-19 is "2026-11-19T13:40:00-08:00", never -07:00. Prefer an explicit numeric offset in the ISO string.
- Never guess facts the email does not support; use null.`;

/** Model output is trusted only when it parses to a real instant. */
const toUtcIso = (value: string | null | undefined): string | null => {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
};

export const extractInterviewDetail = async (
  email: ParsedEmail,
): Promise<{ detail: InterviewDetail; llmSucceeded: boolean }> => {
  const userPrompt = [
    `From: ${email.from}`,
    `Subject: ${email.subject}`,
    `Date: ${email.date}`,
    `Candidate timezone: ${env.userTimezone}`,
    "",
    email.body || email.snippet,
  ].join("\n");
  const result = await withLlmContext({ feature: "gmail_classify" }, () =>
    responsesClient.runStructured({
      systemPrompt: SYSTEM_PROMPT,
      userPrompt,
      schema: DetailSchema,
      fallback: () => ({ ...EMPTY_DETAIL }),
      reasoningEffort: env.gmailClassifyReasoningEffort,
    }),
  );
  const d = result.data;
  return {
    llmSucceeded: result.success,
    detail: {
      roundNumber: d.roundNumber ?? null,
      kind: d.kind ?? null,
      focus: d.focus ?? null,
      interviewers: d.interviewers ?? null,
      advancesToNextRound: d.advancesToNextRound ?? false,
      scheduledAt: toUtcIso(d.scheduledAt),
      durationMinutes: d.durationMinutes ?? null,
      cancelled: d.cancelled ?? false,
      version: INTERVIEW_DETAIL_VERSION,
    },
  };
};

const HOUR_MS = 60 * 60 * 1000;
/** Follow-ups for one round (invite, calendar invite, reschedule) normally land within this window. */
const SAME_ROUND_WINDOW_MS = 10 * 24 * HOUR_MS;
/** A "you're moving forward" email this soon after the round's last email is its own confirmation. */
const ADVANCE_DEBOUNCE_MS = 36 * HOUR_MS;

const KIND_LABEL: Record<InterviewKind, string> = {
  recruiter_screen: "recruiter screen",
  hiring_manager: "hiring manager",
  technical: "technical",
  system_design: "system design",
  behavioral: "behavioral",
  team: "team",
  onsite: "onsite",
  final: "final",
  other: "interview",
};

const knownKind = (kind: InterviewKind | null | undefined): InterviewKind | null =>
  kind && kind !== "other" ? kind : null;

export const ordinal = (n: number): string => {
  const mod100 = n % 100;
  if (mod100 >= 11 && mod100 <= 13) return `${n}th`;
  return `${n}${({ 1: "st", 2: "nd", 3: "rd" } as Record<number, string>)[n % 10] ?? "th"}`;
};

export const roundLabel = (round: Pick<InterviewRound, "number" | "kind" | "focus" | "interviewers">): string => {
  const what = round.focus ?? (knownKind(round.kind) ? KIND_LABEL[round.kind!] : null);
  const who = round.interviewers ? `with ${round.interviewers}` : null;
  if (round.number === 1 && (!knownKind(round.kind) || round.kind === "recruiter_screen")) {
    return ["Recruiter screen", who].filter(Boolean).join(" ");
  }
  const base = `${ordinal(round.number)} round`;
  if (what) return [`${base} · ${what}`, who].filter(Boolean).join(" ");
  return [base, who].filter(Boolean).join(" ");
};

/** The round's interview had already taken place when this email arrived, so a new booking is a later round. */
const roundHeldBefore = (current: InterviewRound, date: string): boolean =>
  Boolean(
    current.scheduledAt &&
      !current.cancelled &&
      Date.parse(current.scheduledAt) + (current.durationMinutes ?? 30) * 60_000 <= Date.parse(date),
  );

const startsNewRound = (current: InterviewRound, detail: InterviewDetail | undefined, date: string): boolean => {
  const gap = Date.parse(date) - Date.parse(current.lastEmailAt);
  if (!detail) return gap > SAME_ROUND_WINDOW_MS;
  if (detail.roundNumber !== null) return detail.roundNumber > current.number;
  if (detail.scheduledAt && roundHeldBefore(current, date) && detail.scheduledAt !== current.scheduledAt) return true;
  const kind = knownKind(detail.kind);
  const kindChanged = Boolean(kind && knownKind(current.kind) && kind !== current.kind);
  if (detail.advancesToNextRound) return kindChanged || gap > ADVANCE_DEBOUNCE_MS;
  if (kindChanged) return true;
  return gap > SAME_ROUND_WINDOW_MS;
};

/** A calendar invite or confirmation for the slot this round already holds. */
const sameScheduledSlot = (current: InterviewRound, detail: InterviewDetail | undefined): boolean =>
  Boolean(detail?.scheduledAt && current.scheduledAt && detail.scheduledAt === current.scheduledAt);

/**
 * True when this email is (or looks like) a real time change — not a candidate "I'll be there"
 * confirmation that restates the same slot and can mis-convert PT/ET around DST.
 */
export const looksLikeRescheduleEmail = (subject: string): boolean =>
  /^(?:(?:updated|cancelled|canceled)\s+)?invitation\b/i.test(subject.trim()) ||
  /\b(reschedul\w*|moved (?:to|your interview)|new time|time change|updated (?:time|interview|invitation))\b/i.test(
    subject,
  );

/** Fold an application's interview emails (oldest first) into numbered rounds. */
export const buildInterviewRounds = (interviewEmails: StoredGmailMessage[]): InterviewRound[] => {
  const rounds: InterviewRound[] = [];
  for (const m of interviewEmails) {
    const detail = m.classification?.interview;
    const current = rounds[rounds.length - 1];
    if (current && (sameScheduledSlot(current, detail) || !startsNewRound(current, detail, m.date))) {
      current.lastEmailAt = m.date;
      current.emailIds.push(m.id);
      current.kind = knownKind(current.kind) ?? detail?.kind ?? current.kind;
      current.focus ??= detail?.focus ?? null;
      current.interviewers ??= detail?.interviewers ?? null;
      if (detail?.scheduledAt) {
        // Keep the first confirmed slot unless this email is a calendar update / explicit reschedule.
        if (!current.scheduledAt || looksLikeRescheduleEmail(m.subject) || detail.scheduledAt === current.scheduledAt) {
          current.scheduledAt = detail.scheduledAt;
          current.durationMinutes = detail.durationMinutes ?? current.durationMinutes;
        }
        current.cancelled = Boolean(detail.cancelled);
      } else if (detail?.cancelled) {
        current.cancelled = true;
      }
      continue;
    }
    rounds.push({
      number: Math.max((current?.number ?? 0) + 1, detail?.roundNumber ?? 0),
      kind: detail?.kind ?? null,
      focus: detail?.focus ?? null,
      interviewers: detail?.interviewers ?? null,
      startedAt: m.date,
      lastEmailAt: m.date,
      emailIds: [m.id],
      scheduledAt: detail?.scheduledAt ?? null,
      durationMinutes: detail?.durationMinutes ?? null,
      cancelled: Boolean(detail?.cancelled),
      label: "",
    });
  }
  for (const round of rounds) round.label = roundLabel(round);
  return rounds;
};
