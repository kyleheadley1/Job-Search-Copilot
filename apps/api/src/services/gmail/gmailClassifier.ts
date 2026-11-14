import { z } from "zod";
import { env } from "../../config/env.js";
import { withLlmContext } from "../llm/llmUsage.js";
import { responsesClient } from "../llm/responsesClient.js";
import type { ParsedEmail } from "./gmailClient.js";
import type { ActionRequest } from "./actionRequest.js";
import type { InterviewDetail } from "./interviewRounds.js";

export const EMAIL_EVENT_TYPES = [
  "applied",
  "rejected",
  "interview",
  "assessment",
  "offer",
  "other",
] as const;
export type EmailEventType = (typeof EMAIL_EVENT_TYPES)[number];

export type EmailClassification = {
  isApplicationEmail: boolean;
  company: string | null;
  role: string | null;
  eventType: EmailEventType;
  confidence: number;
  /** Interview emails only; missing until round details have been extracted. */
  interview?: InterviewDetail;
  /** What the email asks the candidate to do; missing until checked. */
  action?: ActionRequest;
};

const SEARCH_KEYWORDS = [
  "application",
  "applied",
  "applying",
  "interview",
  "assessment",
  '"next steps"',
  "offer",
  "candidacy",
  '"thank you for your interest"',
  "position",
  "role",
];

export const buildSearchQuery = (days: number): string =>
  `newer_than:${days}d -category:promotions -category:social (${SEARCH_KEYWORDS.join(" OR ")})`;

const PLATFORM_SENDERS = ["linkedin.com", "indeed.com", "indeedemail.com"];
const PLATFORM_PHRASES = ['"application was sent"', '"applied to"', '"application submitted"'];

/** Gmail files job-platform confirmations under Social, which the main query skips. */
export const buildPlatformSearchQuery = (days: number): string =>
  `newer_than:${days}d from:(${PLATFORM_SENDERS.join(" OR ")}) (${PLATFORM_PHRASES.join(" OR ")})`;

/** Applicant-tracking systems and job platforms that send application lifecycle email. */
const ATS_SENDER_RE =
  /@(?:[\w-]+\.)*(greenhouse(?:-mail)?\.io|greenhouse\.com|lever\.co|hire\.lever\.co|ashbyhq\.com|myworkday(?:jobs)?\.com|workday\.com|smartrecruiters\.com|icims\.com|jobvite\.com|linkedin\.com|indeed\.com|indeedemail\.com|simplify\.jobs|workablemail\.com|workable\.com|bamboohr\.com|rippling\.com|breezy\.hr|recruitee\.com|teamtailor\.com|jazzhr\.com|applytojob\.com|successfactors\.com|taleo\.net|oraclecloud\.com|hackerrank\.com|codesignal\.com)\b/i;

const APPLICATION_PHRASE_RE =
  /\b(thank(?:s| you) for (?:your )?(?:applying|application|interest)|we(?:'ve| have) received your application|application (?:received|submitted|confirmation|update|status)|your application (?:to|for|with)|your application (?:was|has been) (?:sent|submitted)|application (?:was )?sent to|applied (?:on|via) (?:linkedin|indeed)|you applied (?:to|for)|move forward with (?:other|your)|not (?:to )?(?:move|moving) forward|decided to (?:pursue|proceed with) other|unfortunately,? (?:we|after)|(?:pause(?:d)?\s+(?:the\s+)?(?:hiring|recruiting|recruitment)|(?:hiring|recruiting|recruitment)\b[\s\S]{0,80}\b(?:paused|on hold|frozen|cancelled|canceled))|(?:role|position|requisition|search)s? (?:is |are |has been |have been )?(?:paused|on hold|frozen|cancelled|canceled|closed)|put[\s\S]{0,40}on hold|reach out .+ if (?:the |these )?(?:position|role)s? reopen|schedule (?:an?|your) (?:interview|call|chat)|invite you to (?:an? )?(?:interview|chat|call|complete)|phone screen|technical (?:interview|screen|assessment)|coding (?:challenge|assessment|exercise)|take[- ]home|online assessment|hackerrank|codesignal|offer letter|pleased to (?:offer|extend)|next steps? in (?:the|our) (?:hiring|interview|recruiting) process|candidacy|(?:your )?interview with [^.\n]{1,40} (?:has been |is )?(?:confirmed|scheduled)|recruiter screen|initial screen)\b/i;

/** Alerts, digests, and marketing that mention jobs but are not about an application. */
const NOT_APPLICATION_RE =
  /\b(jobs? (?:you may be|you might be) interested in|new jobs? (?:for you|matching|near)|job alert|jobs? recommended for you|recommended jobs|top job picks|is hiring\b|are hiring\b|similar jobs|job matches|weekly digest|daily digest|newsletter|webinar|unsubscribe from (?:job )?alerts|people (?:also )?viewed|who viewed your profile|connection request|endorse)\b/i;

/** Bump when the prefilter keeps more mail, so previously dropped messages are re-checked. */
export const PREFILTER_VERSION = 7;

/**
 * Google/Outlook calendar invites ("Invitation: Alex and Jane @ Mon …") carry no application phrases.
 * Gmail rewrites invites from new senders to "Invitation from an unknown sender: …".
 */
const CALENDAR_INVITE_RE = /^(?:updated\s+)?invitation\b[^:]{0,40}:/i;
const FREEMAIL_SENDER_RE =
  /@(?:gmail|googlemail|yahoo|outlook|hotmail|live|icloud|me|aol|proton(?:mail)?)\.(?:com|me|net)\b/i;

export const isAtsSender = (from: string): boolean => ATS_SENDER_RE.test(from);
export const isFreemailSender = (from: string): boolean => FREEMAIL_SENDER_RE.test(from);

export type PrefilterResult = { keep: boolean; reason: string };

/** Deterministic, free filter run before any LLM call. */
export const prefilterEmail = (email: Pick<ParsedEmail, "from" | "subject" | "snippet" | "body">): PrefilterResult => {
  const headline = `${email.subject}\n${email.snippet}`;
  const text = `${headline}\n${email.body.slice(0, 1500)}`;
  const phrase = APPLICATION_PHRASE_RE.test(text);
  if (NOT_APPLICATION_RE.test(headline) && !APPLICATION_PHRASE_RE.test(headline)) {
    return { keep: false, reason: "job_alert_or_newsletter" };
  }
  if (ATS_SENDER_RE.test(email.from)) {
    if (NOT_APPLICATION_RE.test(text) && !phrase) {
      return { keep: false, reason: "ats_marketing" };
    }
    return { keep: true, reason: "ats_sender" };
  }
  if (phrase) return { keep: true, reason: "application_phrase" };
  if (CALENDAR_INVITE_RE.test(email.subject) && !FREEMAIL_SENDER_RE.test(email.from)) {
    return { keep: true, reason: "calendar_invite" };
  }
  return { keep: false, reason: "no_application_signal" };
};

const ClassificationSchema = z.object({
  isApplicationEmail: z.boolean(),
  company: z.string().trim().min(1).nullable().optional(),
  role: z.string().trim().min(1).nullable().optional(),
  eventType: z.enum(EMAIL_EVENT_TYPES),
  confidence: z.number().min(0).max(1).optional(),
});

const SYSTEM_PROMPT = `You classify emails from a job seeker's inbox.
Decide whether the email is about a specific job application the user submitted (confirmation, rejection, interview invite, assessment, offer, or other status update).
Job alerts, recommendations, newsletters, recruiter cold outreach about roles the user did not apply to, and marketing are NOT application emails.

Return JSON only:
{
  "isApplicationEmail": boolean,
  "company": string | null,   // hiring company, not the ATS vendor (e.g. "Acme", not "Greenhouse")
  "role": string | null,      // job title exactly as written, null if not stated; a meeting or stage name ("Initial Screen Call", "Phone Interview") is not a job title
  "eventType": "applied" | "rejected" | "interview" | "assessment" | "offer" | "other",
  "confidence": number        // 0..1
}

eventType rules:
- applied: application received / submitted confirmation
- rejected: process ended without an offer — not moving forward, position filled, decided on other candidates, hiring paused / put on hold / frozen, role cancelled or closed, or "we'll reach out if it reopens". This includes polite pauses after a good interview; it is not limited to personal rejection
- interview: invitation to schedule or confirmation of an interview / phone screen / recruiter call
- assessment: coding challenge, take-home, online assessment, HackerRank / CodeSignal
- offer: job offer
- other: application-related but none of the above
Calendar invitations: an invite from someone at a company for a call, chat, screen, or interview with the user is an "interview" event even if the word "interview" never appears. The company is the employer named in the invite, or the organization behind the sender's email domain (use its short brand name, e.g. "Acme" for jane@acmelabs.com). Personal or social events are NOT application emails.
Job platforms: "your application was sent to X" (LinkedIn, Indeed) is an "applied" event; the company is X (not LinkedIn or Indeed) and the role is the job title shown in the email body.
Never guess a company or role that is not supported by the email.`;

const NOT_APPLICATION: EmailClassification = {
  isApplicationEmail: false,
  company: null,
  role: null,
  eventType: "other",
  confidence: 0,
};

export const classifyEmailWithLlm = async (email: ParsedEmail): Promise<{
  classification: EmailClassification;
  llmSucceeded: boolean;
}> => {
  const userPrompt = [
    `From: ${email.from}`,
    `Subject: ${email.subject}`,
    `Date: ${email.date}`,
    "",
    email.body || email.snippet,
  ].join("\n");

  const result = await withLlmContext({ feature: "gmail_classify" }, () =>
    responsesClient.runStructured({
      systemPrompt: SYSTEM_PROMPT,
      userPrompt,
      schema: ClassificationSchema,
      fallback: () => ({ ...NOT_APPLICATION }),
      reasoningEffort: env.gmailClassifyReasoningEffort,
    }),
  );
  const data = result.data;
  return {
    llmSucceeded: result.success,
    classification: {
      isApplicationEmail: data.isApplicationEmail && Boolean(data.company),
      company: data.company ?? null,
      role: data.role ?? null,
      eventType: data.eventType,
      confidence: data.confidence ?? (result.success ? 0.7 : 0),
    },
  };
};
