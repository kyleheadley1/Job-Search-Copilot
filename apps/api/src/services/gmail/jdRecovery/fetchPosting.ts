import { htmlToPlainText } from "../gmailClient.js";
import { looksLikeApplicationReceipt } from "./applicationReceipt.js";
import { classifyJobLink, type JobLinkKind } from "./emailEvidence.js";

export type PostingSource = JobLinkKind | "workable" | "generic";

export type FetchedPosting = {
  url: string;
  source: PostingSource;
  company?: string;
  title?: string;
  requisitionId?: string;
  datePosted?: string;
  /** Work location as the site states it ("New York, NY", "Remote"), when it does. */
  location?: string;
  /** The site says applications are closed; still useful as a JD for roles already applied to. */
  closed?: boolean;
  text: string;
};

export class PostingFetchError extends Error {
  constructor(
    readonly reason: "http_error" | "too_short" | "closed" | "not_found" | "unsupported" | "application_receipt",
    message: string,
  ) {
    super(message);
    this.name = "PostingFetchError";
  }
}

export const MIN_POSTING_CHARS = 600;
const FETCH_TIMEOUT_MS = 15_000;
const CLOSED_SCAN_CHARS = 1500;
const BROWSER_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

const CLOSED_RE =
  /no longer (available|accepting applications|open|active)|position has been filled|(job|posting|position|requisition) (is |has been )?(closed|expired|removed)|this job (posting )?(has )?expired|(page|job) (you('|’)re looking for )?(could not be|can('|’)t be|cannot be) found|job not found/i;

const decodeEscapedHtml = (html: string): string =>
  html
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/gi, "&");

export const htmlToText = (html: string): string => htmlToPlainText(decodeEscapedHtml(html));

const getJson = async <T>(url: string): Promise<T> => {
  const res = await fetch(url, {
    headers: { Accept: "application/json", "User-Agent": BROWSER_UA },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (res.status === 404) throw new PostingFetchError("not_found", `404 from ${url}`);
  if (!res.ok) throw new PostingFetchError("http_error", `HTTP ${res.status} from ${url}`);
  return (await res.json()) as T;
};

const getHtml = async (url: string): Promise<string> => {
  const res = await fetch(url, {
    headers: { Accept: "text/html,application/xhtml+xml", "User-Agent": BROWSER_UA },
    redirect: "follow",
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (res.status === 404) throw new PostingFetchError("not_found", `404 from ${url}`);
  if (!res.ok) throw new PostingFetchError("http_error", `HTTP ${res.status} from ${url}`);
  return res.text();
};

const segmentsOf = (url: URL) => url.pathname.split("/").filter(Boolean);

type GreenhouseJob = {
  title?: string;
  content?: string;
  company_name?: string;
  requisition_id?: string;
  internal_job_id?: number;
  updated_at?: string;
  first_published?: string;
  location?: { name?: string };
};

const fetchGreenhouse = async (url: URL): Promise<Omit<FetchedPosting, "url" | "source">> => {
  const segments = segmentsOf(url);
  const jobsIdx = segments.indexOf("jobs");
  const board = segments[jobsIdx - 1];
  const id = segments[jobsIdx + 1];
  if (!board || !id) throw new PostingFetchError("unsupported", `Unrecognized Greenhouse URL ${url}`);
  const job = await getJson<GreenhouseJob>(
    `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(board)}/jobs/${encodeURIComponent(id)}`,
  );
  return {
    title: job.title,
    company: job.company_name,
    requisitionId: job.requisition_id ?? undefined,
    datePosted: job.first_published ?? job.updated_at,
    location: job.location?.name,
    text: [job.title, htmlToText(job.content ?? "")].filter(Boolean).join("\n\n"),
  };
};

type LeverPosting = {
  text?: string;
  descriptionPlain?: string;
  description?: string;
  lists?: Array<{ text?: string; content?: string }>;
  additionalPlain?: string;
  createdAt?: number;
  categories?: { location?: string };
  workplaceType?: string;
};

const fetchLever = async (url: URL): Promise<Omit<FetchedPosting, "url" | "source">> => {
  const [company, id] = segmentsOf(url);
  if (!company || !id) throw new PostingFetchError("unsupported", `Unrecognized Lever URL ${url}`);
  const p = await getJson<LeverPosting>(
    `https://api.lever.co/v0/postings/${encodeURIComponent(company)}/${encodeURIComponent(id)}`,
  );
  const lists = (p.lists ?? []).map((l) => `${l.text ?? ""}\n${htmlToText(l.content ?? "")}`);
  return {
    title: p.text,
    company,
    datePosted: p.createdAt ? new Date(p.createdAt).toISOString() : undefined,
    location: [p.categories?.location, p.workplaceType === "remote" ? "Remote" : undefined].filter(Boolean).join(" · ") || undefined,
    text: [p.text, p.descriptionPlain ?? htmlToText(p.description ?? ""), ...lists, p.additionalPlain]
      .filter(Boolean)
      .join("\n\n"),
  };
};

type AshbyBoard = {
  jobs?: Array<{
    id: string;
    title?: string;
    descriptionPlain?: string;
    descriptionHtml?: string;
    publishedAt?: string;
    jobUrl?: string;
    location?: string;
    isRemote?: boolean;
  }>;
};

const fetchAshby = async (url: URL): Promise<Omit<FetchedPosting, "url" | "source">> => {
  const [org, id] = segmentsOf(url);
  if (!org || !id) throw new PostingFetchError("unsupported", `Unrecognized Ashby URL ${url}`);
  const board = await getJson<AshbyBoard>(
    `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(org)}`,
  );
  const job = board.jobs?.find((j) => j.id === id || j.jobUrl?.includes(id));
  if (!job) throw new PostingFetchError("not_found", `Ashby job ${id} not on ${org} board`);
  return {
    title: job.title,
    company: org,
    datePosted: job.publishedAt,
    location: [job.location, job.isRemote ? "Remote" : undefined].filter(Boolean).join(" · ") || undefined,
    text: [job.title, job.descriptionPlain ?? htmlToText(job.descriptionHtml ?? "")].filter(Boolean).join("\n\n"),
  };
};

type WorkdayJob = {
  jobPostingInfo?: {
    title?: string;
    jobDescription?: string;
    jobReqId?: string;
    startDate?: string;
    location?: string;
  };
  hiringOrganization?: { name?: string };
};

const LOCALE_RE = /^[a-z]{2}-[A-Z]{2}$/;

export const workdayApiUrl = (url: URL): string | undefined => {
  const tenant = url.hostname.split(".")[0];
  const segments = segmentsOf(url);
  const jobIdx = segments.indexOf("job");
  const siteSegments = segments.slice(0, jobIdx).filter((s) => !LOCALE_RE.test(s));
  const site = siteSegments[siteSegments.length - 1];
  if (!tenant || !site || jobIdx < 0 || jobIdx === segments.length - 1) return undefined;
  const rest = segments.slice(jobIdx).join("/");
  return `${url.origin}/wday/cxs/${tenant}/${site}/${rest}`;
};

const fetchWorkday = async (url: URL): Promise<Omit<FetchedPosting, "url" | "source">> => {
  const api = workdayApiUrl(url);
  if (!api) throw new PostingFetchError("unsupported", `Unrecognized Workday URL ${url}`);
  const job = await getJson<WorkdayJob>(api);
  const info = job.jobPostingInfo ?? {};
  return {
    title: info.title,
    company: job.hiringOrganization?.name,
    requisitionId: info.jobReqId,
    datePosted: info.startDate,
    location: info.location,
    text: [info.title, info.location, htmlToText(info.jobDescription ?? "")].filter(Boolean).join("\n\n"),
  };
};

type JsonLdJobPosting = {
  "@type"?: string | string[];
  title?: string;
  description?: string;
  datePosted?: string;
  hiringOrganization?: { name?: string } | string;
  identifier?: { value?: string | number; name?: string } | string | number;
  validThrough?: string;
  jobLocationType?: string;
  jobLocation?: JsonLdPlace | JsonLdPlace[];
};

type JsonLdPlace = { address?: { addressLocality?: string; addressRegion?: string } | string };

const jsonLdLocation = (posting: JsonLdJobPosting): string | undefined => {
  const places = Array.isArray(posting.jobLocation) ? posting.jobLocation : posting.jobLocation ? [posting.jobLocation] : [];
  const names = places
    .map((p) =>
      typeof p.address === "string"
        ? p.address
        : [p.address?.addressLocality, p.address?.addressRegion].filter(Boolean).join(", "),
    )
    .filter(Boolean);
  if (/TELECOMMUTE/i.test(posting.jobLocationType ?? "")) names.unshift("Remote");
  return names.length ? names.join(" · ") : undefined;
};

const isJobPosting = (node: unknown): node is JsonLdJobPosting => {
  if (!node || typeof node !== "object") return false;
  const t = (node as JsonLdJobPosting)["@type"];
  return t === "JobPosting" || (Array.isArray(t) && t.includes("JobPosting"));
};

const findJobPosting = (node: unknown): JsonLdJobPosting | undefined => {
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findJobPosting(child);
      if (found) return found;
    }
    return undefined;
  }
  if (isJobPosting(node)) return node;
  if (node && typeof node === "object" && "@graph" in node) {
    return findJobPosting((node as { "@graph": unknown })["@graph"]);
  }
  return undefined;
};

const LD_JSON_RE = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;

export const parseJsonLdJobPosting = (html: string): Omit<FetchedPosting, "url" | "source"> | undefined => {
  for (const m of html.matchAll(LD_JSON_RE)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(m[1]!.trim());
    } catch {
      continue;
    }
    const posting = findJobPosting(parsed);
    if (!posting) continue;
    const org = posting.hiringOrganization;
    const id = posting.identifier;
    const identifier =
      id && typeof id === "object" ? id.value : id;
    return {
      title: posting.title,
      company: typeof org === "string" ? org : org?.name,
      requisitionId: identifier !== undefined && identifier !== null ? String(identifier) : undefined,
      datePosted: posting.datePosted,
      location: jsonLdLocation(posting),
      ...(posting.validThrough && Date.parse(posting.validThrough) < Date.now() ? { closed: true } : {}),
      text: [posting.title, htmlToText(posting.description ?? "")].filter(Boolean).join("\n\n"),
    };
  }
  return undefined;
};

const fetchGeneric = async (url: URL): Promise<Omit<FetchedPosting, "url" | "source">> => {
  const html = await getHtml(url.toString());
  const ld = parseJsonLdJobPosting(html);
  if (ld && ld.text.length >= MIN_POSTING_CHARS) return ld;
  const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.trim();
  return { ...ld, title: ld?.title ?? title, text: htmlToPlainText(html) };
};

/** Spacing between LinkedIn guest requests; the endpoint rate-limits bursts. */
export const linkedinThrottle = { minGapMs: 1500, lastAt: 0 };

export const linkedinJobId = (url: URL): string | undefined =>
  url.pathname.match(/\/jobs\/view\/(?:[^/]*-)?(\d{6,})/)?.[1] ?? url.searchParams.get("currentJobId") ?? undefined;

const firstMatchText = (html: string, re: RegExp): string | undefined => {
  const raw = html.match(re)?.[1];
  return raw ? htmlToPlainText(raw).trim() || undefined : undefined;
};

const LINKEDIN_CLOSED_RE = /no longer accepting applications|closed-job/i;

export const parseLinkedInGuestHtml = (html: string): Omit<FetchedPosting, "url" | "source"> => {
  const descriptionAt = html.search(/show-more-less-html__markup/i);
  const closed = LINKEDIN_CLOSED_RE.test(descriptionAt > 0 ? html.slice(0, descriptionAt) : html);
  const title = firstMatchText(html, /<h2[^>]*top-card-layout__title[^>]*>([\s\S]*?)<\/h2>/i);
  const company = firstMatchText(html, /<a[^>]*topcard__org-name-link[^>]*>([\s\S]*?)<\/a>/i);
  const location = firstMatchText(html, /<span[^>]*class="topcard__flavor topcard__flavor--bullet"[^>]*>([\s\S]*?)<\/span>/i);
  const description = html.match(/<div[^>]*show-more-less-html__markup[^>]*>([\s\S]*?)<\/div>/i)?.[1];
  return {
    title,
    company,
    location,
    ...(closed ? { closed: true } : {}),
    text: [title, company, description ? htmlToText(description) : htmlToPlainText(html)].filter(Boolean).join("\n\n"),
  };
};

const fetchLinkedIn = async (url: URL): Promise<Omit<FetchedPosting, "url" | "source">> => {
  const id = linkedinJobId(url);
  if (!id) throw new PostingFetchError("unsupported", `No LinkedIn job id in ${url}`);
  const wait = linkedinThrottle.lastAt + linkedinThrottle.minGapMs - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  linkedinThrottle.lastAt = Date.now();
  const html = await getHtml(`https://www.linkedin.com/jobs-guest/jobs/api/jobPosting/${id}`);
  return parseLinkedInGuestHtml(html);
};

const ADAPTERS: Partial<Record<PostingSource, (url: URL) => Promise<Omit<FetchedPosting, "url" | "source">>>> = {
  greenhouse: fetchGreenhouse,
  lever: fetchLever,
  ashby: fetchAshby,
  workday: fetchWorkday,
  linkedin: fetchLinkedIn,
};

/** Shared closed/too-short checks for any recovered posting. */
export const validatePosting = (
  result: Omit<FetchedPosting, "url" | "source">,
  url: string,
  source: PostingSource,
): FetchedPosting => {
  const text = result.text.trim();
  if (CLOSED_RE.test(text.slice(0, CLOSED_SCAN_CHARS))) {
    throw new PostingFetchError("closed", `Posting at ${url} looks closed`);
  }
  if (text.length < MIN_POSTING_CHARS) {
    throw new PostingFetchError("too_short", `Posting at ${url} has only ${text.length} chars`);
  }
  if (looksLikeApplicationReceipt(text, url)) {
    throw new PostingFetchError("application_receipt", `${url} is an application confirmation page, not a posting`);
  }
  return { ...result, text, url, source };
};

/** Fetch one posting through its site adapter; throws PostingFetchError when unusable. */
export const fetchPosting = async (rawUrl: string): Promise<FetchedPosting> => {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new PostingFetchError("unsupported", `Invalid URL ${rawUrl}`);
  }
  const source: PostingSource = classifyJobLink(rawUrl) ?? "generic";
  const adapter = ADAPTERS[source] ?? fetchGeneric;
  return validatePosting(await adapter(url), rawUrl, source);
};
