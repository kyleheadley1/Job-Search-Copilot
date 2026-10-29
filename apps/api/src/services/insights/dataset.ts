import type { ExtractedJobData, JobRecord, JobStatus } from "../../types/job.js";
import type { StoredResumeType } from "../../types/resume.js";
import type { RuleEvaluation, ScoreBreakdown } from "../../types/scoring.js";
import { isAtsSender } from "../gmail/gmailClassifier.js";
import { normalizeCompany, sameCompany, type AppliedAtSource, type GmailApplication } from "../gmail/gmailApplications.js";
import type { ApplicationEvaluation } from "../gmail/jdRecovery/evaluations.repository.js";
import { presentFitForDisplay } from "../../lib/authoritativeScore.js";
import type { ApprovedRevisionOverlay } from "../scoring/scoreRevision.types.js";

/** Applied this recently with no human contact yet: too early to call. */
export const DECISION_DAYS = 30;

export type Outcome = "positive" | "negative" | "too_early";

export type ApplyEvidence = "confirmed" | "inferred";

export type UnscoredReason =
  | "not_found"
  | "fetch_failed"
  | "unverified"
  | "triage_failed"
  | "tracker_never_scored"
  | "no_jd";

export type InsightRow = {
  id: string;
  company: string;
  role: string | null;
  appliedAt: string | null;
  outcome: Outcome;
  outcomeReason: string;
  source: "tracker+gmail" | "tracker" | "gmail";
  fit: number | null;
  extracted?: Omit<ExtractedJobData, "rawText">;
  rules?: RuleEvaluation;
  score?: ScoreBreakdown;
  recommendedResume?: StoredResumeType;
  postingUrl?: string;
  addedFromGmail: boolean;
  /** Tracker applied date or a Gmail "applied" confirmation, vs a first-email guess. */
  applyEvidence: ApplyEvidence;
  /** Why this decided row has no fit score; absent when scored. */
  unscoredReason?: UnscoredReason;
};

const HUMAN_STAGES = new Set<JobStatus>(["interviewing", "offer"]);

export type OutcomeInput = {
  gmail?: Pick<GmailApplication, "company" | "furthestStage" | "status" | "interviewRounds" | "emails">;
  trackerStatus?: JobStatus;
  trackerHistory?: JobStatus[];
  /** Set by you on the tracker row: true covers calls that never left an email trail, false overrides Gmail. */
  reachedHuman?: boolean;
  appliedAt: string | null;
};

const STAFFING_RE =
  /\b(staff(ing)?|recruit(ing|ers?|ment)?|search|talent|headhunt\w*|placement|jobot|insight global|robert half|teksystems|kforce|randstad|adecco|aerotek|hays|cybercoders)\b|staff\.|recruit/i;

/** Agencies and recruiting firms, by name or sender domain ("Morgan Pinnacle Group" mails from mpgstaff.com). */
export const isStaffingAgency = (company: string, senders: string[] = []): boolean =>
  STAFFING_RE.test(company) ||
  senders.some((from) => !isAtsSender(from) && STAFFING_RE.test(from.match(/@([^>\s]+)/)?.[1] ?? ""));

const AUTOMATED_SENDER_RE = /no-?reply|do-?not-?reply|alerts?@|notifications?@|jobs@|careers@/i;
const CALENDAR_INVITE_RE = /^(updated )?invitation\b/i;

/** Rounds that mean the employer itself is interviewing, not an agency recruiter screening. */
const EMPLOYER_ROUND_KINDS = new Set(["hiring_manager", "technical", "system_design", "behavioral", "team", "onsite", "final"]);

/**
 * Did Gmail show a real call or interview? For an employer, a confirmed time, a calendar invite, or an
 * interview email from a person counts. An agency's own screening call doesn't: it only counts once
 * a booked round is with the employer (hiring manager, technical, team, onsite, final) or an offer.
 */
export const gmailHumanContact = (g: NonNullable<OutcomeInput["gmail"]>): string | null => {
  const emails = g.emails.filter((e) => e.eventType === "interview" || e.eventType === "offer");
  if (emails.length === 0 && g.interviewRounds.length === 0) return null;
  if (isStaffingAgency(g.company, g.emails.map((e) => e.from))) {
    if (g.furthestStage === "offer") return "Gmail: reached an offer through an agency";
    const employerRound = g.interviewRounds.some(
      (r) => r.scheduledAt && !r.cancelled && r.kind && EMPLOYER_ROUND_KINDS.has(r.kind),
    );
    return employerRound ? "Gmail: agency booked an interview with the employer" : null;
  }
  const booked =
    g.interviewRounds.some((r) => r.scheduledAt && !r.cancelled) || emails.some((e) => CALENDAR_INVITE_RE.test(e.subject));
  if (booked) return g.furthestStage === "offer" ? "Gmail: reached an offer" : "Gmail: a call or interview was booked";
  const fromPerson = emails.some((e) => !isAtsSender(e.from) && !AUTOMATED_SENDER_RE.test(e.from));
  if (!fromPerson) return null;
  return g.furthestStage === "offer" ? "Gmail: reached an offer" : "Gmail: interview email from the employer";
};

/**
 * Positive = reached a human: recruiter screen or later interview, or an offer. Negative = rejected
 * without one, or no human contact 30+ days after applying (assessments alone don't count).
 */
export const classifyOutcome = (input: OutcomeInput, now: number): { outcome: Outcome; reason: string } => {
  const g = input.gmail;
  if (input.reachedHuman === true) return { outcome: "positive", reason: "Marked by you: reached a person" };
  if (input.reachedHuman === false) return { outcome: "negative", reason: "Marked by you: no call or interview" };
  const contact = g ? gmailHumanContact(g) : null;
  if (contact) return { outcome: "positive", reason: contact };
  const tracker = [input.trackerStatus, ...(input.trackerHistory ?? [])].filter(Boolean) as JobStatus[];
  const reached = tracker.find((s) => HUMAN_STAGES.has(s));
  if (reached) return { outcome: "positive", reason: `Tracker: reached ${reached}` };
  if (g?.status === "rejected" || tracker.includes("rejected")) {
    return { outcome: "negative", reason: "Rejected without an interview" };
  }
  if (input.trackerStatus === "lapsed") return { outcome: "negative", reason: "Lapsed (no response)" };
  const applied = input.appliedAt ? Date.parse(input.appliedAt) : NaN;
  if (Number.isFinite(applied) && now - applied >= DECISION_DAYS * 86_400_000) {
    return { outcome: "negative", reason: `No human contact ${DECISION_DAYS}+ days after applying` };
  }
  return { outcome: "too_early", reason: Number.isFinite(applied) ? "Applied under 30 days ago" : "No applied date" };
};

const APPLIED_STATUSES = new Set<JobStatus>(["applied", "assessment", "interviewing", "offer", "rejected", "lapsed", "closed"]);

const isoDay = (text: string | undefined): string | null => {
  const m = text?.match(/\b(\d{4}-\d{2}-\d{2})\b/);
  return m && Number.isFinite(Date.parse(m[1]!)) ? `${m[1]}T12:00:00.000Z` : null;
};

/**
 * When the user applied, or null if never applied: a manual date first, then the date recorded in the
 * imported spreadsheet (its history entries carry the import time), then the first move to "applied".
 */
export const trackerAppliedAt = (job: JobRecord): string | null => {
  if (job.tracker?.appliedAt) return job.tracker.appliedAt;
  const imported =
    isoDay(job.tracker?.notes?.match(/applied on (\d{4}-\d{2}-\d{2})/i)?.[0]) ?? isoDay(job.trackerSpreadsheet?.discussed);
  if (imported) return imported;
  const first = (job.statusHistory ?? [])
    .filter((h) => h.toStatus === "applied")
    .map((h) => h.createdAt)
    .sort()[0];
  if (first) return first;
  return APPLIED_STATUSES.has(job.status) ? job.createdAt : null;
};

/** A stored applied date (manual, spreadsheet, or first move to applied), not a createdAt fallback. */
export const trackerHasConfirmedAppliedAt = (job: JobRecord): boolean => {
  if (job.tracker?.appliedAt) return true;
  if (isoDay(job.tracker?.notes?.match(/applied on (\d{4}-\d{2}-\d{2})/i)?.[0]) ?? isoDay(job.trackerSpreadsheet?.discussed)) {
    return true;
  }
  return (job.statusHistory ?? []).some((h) => h.toStatus === "applied");
};

export const applyEvidenceOf = (opts: {
  trackerConfirmed?: boolean;
  gmailSource?: AppliedAtSource;
}): ApplyEvidence => {
  if (opts.trackerConfirmed) return "confirmed";
  if (opts.gmailSource === "email" || opts.gmailSource === "tracker") return "confirmed";
  return "inferred";
};

export const unscoredReasonOf = (opts: {
  fit: number | null;
  hasExtracted: boolean;
  source: InsightRow["source"];
  recovery?: { status?: string; reason?: string };
}): UnscoredReason | undefined => {
  if (opts.fit != null) return undefined;
  const recoveryReason = opts.recovery?.reason ?? "";
  if (/^triage_failed/i.test(recoveryReason)) return "triage_failed";
  const status = opts.recovery?.status;
  if (status === "not_found" || status === "fetch_failed" || status === "unverified") return status;
  if (opts.source === "gmail") return "no_jd";
  return opts.hasExtracted ? "tracker_never_scored" : "no_jd";
};

const fromJob = (job: JobRecord) => {
  const { rawText: _rawText, ...extracted } = job.extracted;
  return {
    extracted,
    rules: job.rules,
    score: job.score,
    recommendedResume: job.recommendedResume,
    fit: Number.isFinite(job.score?.total) ? job.score.total : null,
  };
};

const fromEvaluation = (
  e: ApplicationEvaluation | undefined,
  revision?: ApprovedRevisionOverlay | null,
): Partial<Pick<InsightRow, "fit" | "extracted" | "rules" | "score" | "recommendedResume">> => {
  const d = e?.fit?.detail;
  if (!e?.fit) return {};
  return {
    fit: presentFitForDisplay(e.fit, { revision, evaluation: e }).total,
    ...(d ? { extracted: d.extracted, rules: d.rules, score: d.score, recommendedResume: d.recommendedResume } : {}),
  };
};

/**
 * One row per application across the tracker and Gmail. A Gmail application linked to a tracker row
 * is counted once; tracker rows never applied to are left out.
 */
export const buildInsightRows = (
  input: {
    jobs: JobRecord[];
    apps: GmailApplication[];
    evaluations: Map<string, ApplicationEvaluation>;
    revisions?: Map<string, ApprovedRevisionOverlay>;
  },
  now = Date.now(),
): InsightRow[] => {
  const jobsById = new Map(input.jobs.map((j) => [j.id, j]));
  const used = new Set<string>();
  const rows: InsightRow[] = [];

  const attributedCompanies = [
    ...input.apps.filter((a) => a.role || a.trackerJobId).map((a) => normalizeCompany(a.company)),
    ...input.jobs
      .filter((j) => trackerAppliedAt(j))
      .map((j) => normalizeCompany(j.extracted.companyDisplayName || j.extracted.company || "")),
  ];

  for (const app of input.apps) {
    const job = app.trackerJobId ? jobsById.get(app.trackerJobId) : undefined;
    if (job && used.has(job.id)) continue;
    // Role-less leftover mail (calendar invites) from a company with known applications belongs to one
    // of those, not to an extra application.
    if (!job && !app.role && attributedCompanies.some((c) => sameCompany(c, normalizeCompany(app.company)))) continue;
    if (job) used.add(job.id);
    const evaluation = input.evaluations.get(app.key);
    const revision = input.revisions?.get(app.key);
    const appliedAt = (job && trackerAppliedAt(job)) ?? app.appliedAt ?? null;
    const { outcome, reason } = classifyOutcome(
      {
        gmail: app,
        trackerStatus: job?.status,
        trackerHistory: job?.statusHistory?.map((h) => h.toStatus),
        reachedHuman: job?.tracker?.reachedHuman,
        appliedAt,
      },
      now,
    );
    const evalFit = fromEvaluation(evaluation, revision);
    const data = job ? fromJob(job) : evalFit;
    const source = job ? "tracker+gmail" : "gmail";
    const fit = evalFit.fit ?? data.fit ?? null;
    rows.push({
      id: job?.id ?? app.key,
      company: app.company,
      role: app.role,
      appliedAt,
      outcome,
      outcomeReason: reason,
      source,
      ...data,
      fit,
      postingUrl: job?.extracted.url ?? evaluation?.recovery.url,
      addedFromGmail: job?.tracker?.source === "gmail",
      applyEvidence: applyEvidenceOf({
        trackerConfirmed: job ? trackerHasConfirmedAppliedAt(job) : false,
        gmailSource: app.appliedAtSource,
      }),
      unscoredReason: unscoredReasonOf({
        fit,
        hasExtracted: Boolean(data.extracted),
        source,
        recovery: evaluation?.recovery,
      }),
    });
  }

  for (const job of input.jobs) {
    if (used.has(job.id)) continue;
    const appliedAt = trackerAppliedAt(job);
    if (!appliedAt) continue;
    const { outcome, reason } = classifyOutcome(
      {
        trackerStatus: job.status,
        trackerHistory: job.statusHistory?.map((h) => h.toStatus),
        reachedHuman: job.tracker?.reachedHuman,
        appliedAt,
      },
      now,
    );
    const data = fromJob(job);
    rows.push({
      id: job.id,
      company: job.extracted.companyDisplayName || job.extracted.company,
      role: job.extracted.title ?? null,
      appliedAt,
      outcome,
      outcomeReason: reason,
      source: "tracker",
      ...data,
      postingUrl: job.extracted.url,
      addedFromGmail: job.tracker?.source === "gmail",
      applyEvidence: applyEvidenceOf({ trackerConfirmed: trackerHasConfirmedAppliedAt(job) }),
      unscoredReason: unscoredReasonOf({
        fit: data.fit,
        hasExtracted: Boolean(job.extracted),
        source: "tracker",
      }),
    });
  }
  return rows;
};
