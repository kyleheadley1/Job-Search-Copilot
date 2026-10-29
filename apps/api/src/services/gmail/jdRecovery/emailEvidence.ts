import { normalizeSourceUrl } from "../../../lib/normalizeSourceUrl.js";
import type { ParsedEmail } from "../gmailClient.js";

export type JobLinkKind =
  | "greenhouse"
  | "lever"
  | "ashby"
  | "workday"
  | "linkedin"
  | "icims"
  | "smartrecruiters"
  | "careers";

export type JobLink = { url: string; kind: JobLinkKind };

export type InlineJd = { text: string; emailId: string };

export type EmailEvidence = {
  jobLinks: JobLink[];
  requisitionId?: string;
  inlineJd?: InlineJd;
};

const REDIRECT_PARAMS = ["url", "u", "target", "redirect", "redirect_url", "redirectUrl", "dest", "destination", "q", "link"];
const MAX_UNWRAP_DEPTH = 4;

const BLOCKED_URL_RE =
  /unsubscribe|opt-?out|privacy|preferences|email[-_]?settings|manage[-_]?(subscriptions|alerts)|\/login\b|\/signin\b|sign-?in|\/password|\/account\b|\/terms\b|\/help\b|\/support\b|\/legal\b|cookie/i;

const ID_SEGMENT_RE = /^(\d{4,}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[A-Za-z]*[-_]?\d{4,}[A-Za-z0-9_-]*)$/i;

/** Follow `?url=` style redirect and tracking wrappers until a plain URL remains. */
export const unwrapLink = (raw: string): string | undefined => {
  let current = raw.trim();
  for (let depth = 0; depth < MAX_UNWRAP_DEPTH; depth += 1) {
    let url: URL;
    try {
      url = new URL(current);
    } catch {
      return undefined;
    }
    const inner = REDIRECT_PARAMS.map((key) => url.searchParams.get(key)).find(
      (value): value is string => Boolean(value && /^https?:\/\//i.test(value)),
    );
    if (!inner) break;
    current = inner;
  }
  return normalizeSourceUrl(current);
};

export const classifyJobLink = (url: string): JobLinkKind | undefined => {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  if (BLOCKED_URL_RE.test(parsed.pathname + parsed.search)) return undefined;
  const host = parsed.hostname.replace(/^www\./, "");
  const path = parsed.pathname;
  const segments = path.split("/").filter(Boolean);

  if (/^(job-boards|boards)(\.eu)?\.greenhouse\.io$/.test(host) && /\/jobs\/\d+/.test(path)) return "greenhouse";
  if (host === "jobs.lever.co" && segments.length >= 2) return "lever";
  if (host === "jobs.ashbyhq.com" && segments.length >= 2) return "ashby";
  if (/\.myworkdayjobs\.com$/.test(host) && /\/job\//.test(path)) return "workday";
  if (/(^|\.)linkedin\.com$/.test(host) && /\/jobs\/view\/(?:[^/]*-)?\d{6,}/.test(path)) return "linkedin";
  if (/\.icims\.com$/.test(host) && /\/jobs\/\d+/.test(path)) return "icims";
  if (/^(jobs|careers)\.smartrecruiters\.com$/.test(host) && segments.length >= 2) return "smartrecruiters";
  if (
    /\/(jobs?|careers?|positions?|openings?|requisitions?)(\/|$)/i.test(path) &&
    (segments.some((s) => ID_SEGMENT_RE.test(s)) || parsed.searchParams.has("gh_jid") || parsed.searchParams.has("jobId"))
  ) {
    return "careers";
  }
  return undefined;
};

/** Keep only links that point at a specific job posting, unwrapped and de-duplicated. */
export const extractJobLinks = (links: string[]): JobLink[] => {
  const seen = new Set<string>();
  const out: JobLink[] = [];
  for (const raw of links) {
    const url = unwrapLink(raw);
    if (!url || seen.has(url)) continue;
    const kind = classifyJobLink(url);
    if (!kind) continue;
    seen.add(url);
    out.push({ url, kind });
  }
  return out;
};

const REQ_LABELED_RE =
  /\b(?:req(?:uisition)?|job|position|posting)\s*(?:id|#|no\.?|number|code)\s*[:#.-]?\s*([A-Z]{0,4}[-_]?\d{3,}[A-Z0-9-]*)/i;
const REQ_PREFIXED_RE = /\b(JR[-_]?\d{4,}|REQ[-_]?\d{4,}|R[-_]?\d{5,})\b/;
/** "Req. 2000087", "Req 2000087", "Requisition: 2000087" (no id/#/no label). */
const REQ_SHORT_RE = /\breq(?:uisition)?\b\.?\s*[:#-]?\s*([A-Z]{0,4}[-_]?\d{5,}[A-Z0-9-]*)/i;
const REQ_PARENS_RE = /\((\d{6,8})\)/;
/** Bare trailing number in a subject like "Software Engineer, 2389186". */
const REQ_SUBJECT_TRAILING_RE = /,\s*(\d{6,8})\s*$/;

export const extractRequisitionId = (subject: string, body: string): string | undefined => {
  for (const text of [subject, body]) {
    const labeled = text.match(REQ_LABELED_RE)?.[1] ?? text.match(REQ_SHORT_RE)?.[1];
    if (labeled) return labeled.toUpperCase();
    const prefixed = text.match(REQ_PREFIXED_RE)?.[1];
    if (prefixed) return prefixed.toUpperCase();
  }
  return (
    subject.match(REQ_PARENS_RE)?.[1] ??
    body.match(REQ_PARENS_RE)?.[1] ??
    subject.match(REQ_SUBJECT_TRAILING_RE)?.[1]
  );
};

/** Drop "(Req. 2000087)" / "(2389186)" / "- JR12345" noise so title matching sees only the title. */
export const cleanRoleTitle = (role: string): string =>
  role
    .replace(/\s*[([]\s*(?:req(?:uisition)?\b\.?\s*(?:id|#|no\.?)?\s*[:#-]?\s*)?[A-Z]{0,4}[-_]?\d{5,}[A-Z0-9-]*\s*[)\]]/gi, "")
    .replace(/\s*[,\-–|]\s*(?:req(?:uisition)?\b\.?\s*(?:id|#)?\s*[:#-]?\s*)?(?:JR|REQ|R)?[-_]?\d{5,}\s*$/i, "")
    .trim();

export const INLINE_JD_MIN_CHARS = 1200;
const JD_HEADINGS: RegExp[] = [
  /responsibilities/i,
  /qualifications/i,
  /requirements/i,
  /what you('|’)ll do/i,
  /what we('|’)re looking for/i,
  /about the (role|position|job)/i,
  /(nice|good) to have/i,
];

export const extractInlineJd = (body: string): string | undefined => {
  const text = body.trim();
  if (text.length < INLINE_JD_MIN_CHARS) return undefined;
  const headings = JD_HEADINGS.filter((re) => re.test(text)).length;
  return headings >= 2 ? text : undefined;
};

/** Combine evidence across every email in one application, newest email first. */
export const collectEmailEvidence = (emails: ParsedEmail[]): EmailEvidence => {
  const ordered = [...emails].sort((a, b) => b.date.localeCompare(a.date));
  const jobLinks = extractJobLinks(ordered.flatMap((e) => e.links));
  let requisitionId: string | undefined;
  let inlineJd: InlineJd | undefined;
  for (const email of ordered) {
    requisitionId ??= extractRequisitionId(email.subject, email.body);
    if (!inlineJd) {
      const text = extractInlineJd(email.body);
      if (text) inlineJd = { text, emailId: email.id };
    }
  }
  return { jobLinks, requisitionId, inlineJd };
};
