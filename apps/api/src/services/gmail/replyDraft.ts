import { getDb } from "../../config/mongo.js";
import { isAtsSender } from "./gmailClassifier.js";
import { gmailClient, type ReplyHeaders } from "./gmailClient.js";
import { normalizeCompany, type ApplicationEmail, type GmailApplication } from "./gmailApplications.js";
import { gmailMessagesRepository, type StoredGmailMessage } from "./gmailMessages.repository.js";

const NO_REPLY_RE = /\bno[-_.]?reply\b|\bdo[-_.]?not[-_.]?reply\b|\bnotifications?@|\bmailer-daemon\b/i;
const ADDRESS_RE = /<([^>]+)>|([^\s<>,;]+@[^\s<>,;]+)/;

/** Calendar / invite subjects should not be thank-you or follow-up reply threads. */
export const isCalendarInviteSubject = (subject: string): boolean =>
  /^(?:(?:updated|cancelled|canceled|accepted|declined|tentative)\s+)?invitation\b/i.test(subject.trim());

export const emailAddress = (header: string): string | null => {
  const m = header.match(ADDRESS_RE);
  return (m?.[1] ?? m?.[2] ?? "").trim().toLowerCase() || null;
};

/** ATS systems and no-reply senders can't receive a reply, so you have to enter a person's address. */
export const isUnreplyable = (header: string): boolean => NO_REPLY_RE.test(header) || isAtsSender(header);

export type ReplyTarget = {
  /** Empty when composing a new email with no source message. */
  emailId: string;
  /** Empty when composing a new email (not threaded). */
  threadId: string;
  /** reply = continue a person email thread; compose = brand-new email (never a calendar invite). */
  mode: "reply" | "compose";
  /** Empty when the thread only has automated senders; you fill it in before creating the draft. */
  to: string;
  subject: string;
  inReplyTo: string;
  references: string;
};

const isGoodReplyEmail = (email: Pick<ApplicationEmail, "from" | "subject">): boolean =>
  !isUnreplyable(email.from) && !isCalendarInviteSubject(email.subject);

/** Prefer confirmation / scheduling emails from a person over invites and ATS mail. */
const scorePersonMessage = (subject: string): number => {
  const s = subject.toLowerCase();
  if (isCalendarInviteSubject(subject)) return -1;
  if (/\b(interview confirmation|confirmed|confirmation|looking forward|great news|next steps|let'?s talk)\b/i.test(s)) {
    return 3;
  }
  if (/\b(interview|screen|call|chat|meeting)\b/i.test(s)) return 2;
  return 1;
};

const pickBestScoredEmail = <T extends { id: string; from: string; subject: string; date?: string }>(
  emails: T[],
): T | undefined => {
  const ranked = emails
    .filter((e) => isGoodReplyEmail(e))
    .map((e) => ({ e, score: scorePersonMessage(e.subject) }))
    .filter((row) => row.score > 0)
    .sort(
      (a, b) =>
        b.score - a.score ||
        (b.e.date ?? "").localeCompare(a.e.date ?? "") ||
        a.e.id.localeCompare(b.e.id),
    );
  return ranked[0]?.e;
};

/**
 * Prefer a real person email that is not a calendar invite.
 * A preferred id is used only when it is itself a good reply target (never a calendar invite).
 * Ranking favors confirmation / interview threads over older ATS or assessment mail.
 */
export const pickReplyEmail = (app: GmailApplication, preferEmailId?: string): string | undefined => {
  if (preferEmailId) {
    const preferred = app.emails.find((e) => e.id === preferEmailId);
    if (preferred && isGoodReplyEmail(preferred) && scorePersonMessage(preferred.subject) > 0) {
      return preferred.id;
    }
  }
  return pickBestScoredEmail(app.emails)?.id;
};

/** Human address from any app email (calendar invites included) for compose-new fallbacks. */
export const pickHumanRecipient = (app: GmailApplication): string => {
  for (const email of app.emails) {
    if (isUnreplyable(email.from)) continue;
    const address = emailAddress(email.from);
    if (address) return address;
  }
  return "";
};

export const toReplyTarget = (emailId: string, h: ReplyHeaders): ReplyTarget => {
  const replyTo = h.replyTo && !isUnreplyable(h.replyTo) ? h.replyTo : "";
  const from = h.from && !isUnreplyable(h.from) ? h.from : "";
  const subject = h.subject.trim();
  return {
    emailId,
    threadId: h.threadId,
    mode: "reply",
    to: emailAddress(replyTo || from) ?? "",
    subject: /^re:/i.test(subject) ? subject : `Re: ${subject || "Following up"}`,
    inReplyTo: h.messageId,
    references: [h.references, h.messageId].filter(Boolean).join(" ").trim(),
  };
};

const toComposeTarget = (input: { to: string; subject: string; emailId?: string }): ReplyTarget => ({
  emailId: input.emailId ?? "",
  threadId: "",
  mode: "compose",
  to: input.to,
  subject: input.subject.trim() || "Following up",
  inReplyTo: "",
  references: "",
});

const defaultComposeSubject = (app: GmailApplication, kind?: string): string => {
  const role = app.role?.trim();
  if (kind === "thank_you") {
    return role ? `Thank you — ${role}` : `Thank you — ${app.company}`;
  }
  return role ? `${role} — ${app.company}` : `Following up — ${app.company}`;
};

const pickStoredPersonMessage = (messages: StoredGmailMessage[]): StoredGmailMessage | undefined => {
  const ranked = messages
    .filter((m) => m.from && !isUnreplyable(m.from) && !isCalendarInviteSubject(m.subject))
    .map((m) => ({ m, score: scorePersonMessage(m.subject) }))
    .filter((row) => row.score > 0)
    .sort(
      (a, b) =>
        b.score - a.score || b.m.date.localeCompare(a.m.date) || a.m.id.localeCompare(b.m.id),
    );
  return ranked[0]?.m;
};

export type ResolveReplyOptions = {
  /** When no suitable reply thread exists, open a new email instead of threading a calendar invite. */
  allowCompose?: boolean;
  /** Suggestion kind — shapes the compose subject for thank-yous. */
  kind?: string;
};

export const resolveReplyTarget = async (
  app: GmailApplication,
  preferEmailId?: string,
  opts: ResolveReplyOptions = {},
): Promise<ReplyTarget> => {
  const preferred =
    preferEmailId &&
    app.emails.find((e) => e.id === preferEmailId && isGoodReplyEmail(e) && scorePersonMessage(e.subject) > 0);

  const stored = pickStoredPersonMessage(
    await gmailMessagesRepository.listPersonMessagesForCompany(normalizeCompany(app.company)),
  );

  type Candidate = { id: string; score: number; date: string };
  const candidates: Candidate[] = [];
  if (preferred) {
    candidates.push({
      id: preferred.id,
      score: scorePersonMessage(preferred.subject),
      date: preferred.date ?? "",
    });
  }
  for (const email of app.emails) {
    if (!isGoodReplyEmail(email)) continue;
    const score = scorePersonMessage(email.subject);
    if (score <= 0) continue;
    candidates.push({ id: email.id, score, date: email.date ?? "" });
  }
  if (stored) {
    candidates.push({
      id: stored.id,
      score: scorePersonMessage(stored.subject),
      date: stored.date ?? "",
    });
  }

  const best = [...candidates].sort(
    (a, b) => b.score - a.score || b.date.localeCompare(a.date) || a.id.localeCompare(b.id),
  )[0];

  // Thank-yous should land on a confirmation / interview person thread, never an old
  // assessment or receipt email. If we only have weak threads, open a new email instead.
  const minScore = opts.kind === "thank_you" ? 2 : 1;
  if (best && best.score >= minScore) {
    return toReplyTarget(best.id, await gmailClient.getReplyHeaders(best.id));
  }

  if (opts.allowCompose !== false) {
    return toComposeTarget({
      to: pickHumanRecipient(app),
      subject: defaultComposeSubject(app, opts.kind),
    });
  }

  if (best) return toReplyTarget(best.id, await gmailClient.getReplyHeaders(best.id));
  throw new Error(`No suitable reply thread for ${app.company}`);
};

const encodeHeader = (value: string): string =>
  /^[\x20-\x7e]*$/.test(value) ? value : `=?UTF-8?B?${Buffer.from(value, "utf8").toString("base64")}?=`;

/** RFC 2822 plain-text message, base64url-encoded for the Gmail API. */
export const buildReplyRaw = (input: {
  to: string;
  subject: string;
  inReplyTo?: string;
  references?: string;
  body: string;
}) => {
  const headers = [
    `To: ${input.to}`,
    `Subject: ${encodeHeader(input.subject)}`,
    ...(input.inReplyTo ? [`In-Reply-To: ${input.inReplyTo}`] : []),
    ...(input.references ? [`References: ${input.references}`] : []),
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: 8bit",
  ];
  return Buffer.from(`${headers.join("\r\n")}\r\n\r\n${input.body.replace(/\r?\n/g, "\r\n")}`, "utf8").toString(
    "base64url",
  );
};

const VALID_TO_RE = /^[^\s@<>,;]+@[^\s@<>,;]+\.[^\s@<>,;]+$/;

export class InvalidRecipientError extends Error {}

export type OutboxEntry = {
  at: string;
  source: "next_steps" | "assistant";
  sourceId: string;
  kind: string;
  appKey: string;
  to: string;
  threadId: string;
  draftId: string;
};

/** Creates a Gmail draft with exactly the text you approved; never sends. */
export const createReplyDraft = async (input: {
  target: ReplyTarget;
  to: string;
  body: string;
  /** When set, overrides the resolved thread/compose subject with what you confirmed in the editor. */
  subject?: string;
  log: Omit<OutboxEntry, "at" | "to" | "threadId" | "draftId">;
}): Promise<OutboxEntry> => {
  const to = input.to.trim().toLowerCase();
  if (!VALID_TO_RE.test(to)) throw new InvalidRecipientError("Enter one valid email address to reply to.");
  if (isUnreplyable(to)) throw new InvalidRecipientError("That address doesn't accept replies; use a person's email.");
  if (!input.body.trim()) throw new InvalidRecipientError("The draft is empty.");
  const subject = (input.subject ?? input.target.subject).trim();
  if (!subject) throw new InvalidRecipientError("Enter a subject line.");
  const compose = input.target.mode === "compose";
  const raw = buildReplyRaw({
    to,
    subject,
    ...(compose
      ? {}
      : {
          inReplyTo: input.target.inReplyTo,
          references: input.target.references,
        }),
    body: input.body.trim(),
  });
  const { draftId, threadId } = await gmailClient.createDraft(raw, compose ? undefined : input.target.threadId || undefined);
  const entry: OutboxEntry = { ...input.log, at: new Date().toISOString(), to, threadId, draftId };
  const db = await getDb();
  await db.collection<OutboxEntry>("gmail_outbox").insertOne({ ...entry });
  return entry;
};

export const GMAIL_DRAFTS_URL = "https://mail.google.com/mail/u/0/#drafts";
