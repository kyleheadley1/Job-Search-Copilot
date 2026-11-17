import { logger } from "../../../lib/logger.js";
import type { JobRecord } from "../../../types/job.js";
import {
  getGmailApplications,
  matchTrackerJob,
  normalizeCompany,
  roleSimilarity,
  type GmailApplication,
} from "../gmailApplications.js";
import { describeProspectLinkage } from "./jobProspects.service.js";
import {
  jobProspectsRepository,
  type JobProspect,
  type ProspectApplicationPatch,
} from "./jobProspects.repository.js";
import { PROSPECT_MATCH_LOOKBACK_DAYS } from "./prospectMatch.js";

/**
 * Applications you submit without a confirmation email never become Gmail applications, so the
 * prospect you saved for them would sit "open" forever. These helpers let you (via Claude) say
 * "I applied" or "I didn't", and list the saved prospects that are still unaccounted for.
 */

export const UNCONFIRMED_MIN_AGE_DAYS = 3;
export const UNCONFIRMED_MAX_AGE_DAYS = 45;
const TITLE_MATCH_THRESHOLD = 0.6;
const DAY_MS = 86_400_000;

export type ProspectApplicationDeps = {
  findById: (id: string) => Promise<JobProspect | null>;
  findByCompanyKey: (companyKey: string) => Promise<JobProspect[]>;
  findAll: () => Promise<JobProspect[]>;
  updateApplicationState: (id: string, patch: ProspectApplicationPatch) => Promise<JobProspect | null>;
  getApplications: (days: number) => Promise<GmailApplication[]>;
  getTrackerJobs: () => Promise<JobRecord[]>;
  /** Score the prospect's JD and save it to the tracker as applied on `appliedDate`. Returns the job id. */
  createTrackedApplication: (prospect: JobProspect, appliedDate: string) => Promise<string>;
  /** Remove a tracker row this flow created, when the user says they did not apply. */
  removeTrackedApplication: (jobId: string) => Promise<void>;
  now: () => Date;
};

export class ProspectApplicationError extends Error {
  constructor(
    readonly code: "PROSPECT_NOT_FOUND" | "PROSPECT_AMBIGUOUS" | "INVALID_INPUT",
    message: string,
    readonly options?: Array<{ prospectId: string; company: string; title: string; createdAt: string }>,
  ) {
    super(message);
    this.name = "ProspectApplicationError";
  }
}

export type MarkProspectAppliedInput = {
  prospectId?: string;
  company?: string;
  title?: string;
  /** false = "I did not apply / not going to". Default true. */
  applied?: boolean;
  /** YYYY-MM-DD; defaults to today. */
  appliedAt?: string;
};

export type MarkProspectAppliedResult = {
  prospectIds: string[];
  company: string;
  title: string;
  applied: boolean;
  appliedAt?: string;
  emailConfirmed: boolean;
  applicationKey?: string;
  tracker: "created" | "creating" | "linked_existing" | "already_linked" | "handled_by_email" | "not_applicable" | "failed";
  trackerJobId?: string;
  trackerError?: string;
  note: string;
};

const localDateKey = (d: Date): string =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

const normTitle = (title: string): string => title.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

const describeOptions = (rows: JobProspect[]) =>
  rows.map((p) => ({ prospectId: p.id, company: p.company, title: p.title, createdAt: p.createdAt }));

/** The prospect the user means, plus any saved duplicates of the same posting (same company + title). */
export const resolveProspectGroup = async (
  input: Pick<MarkProspectAppliedInput, "prospectId" | "company" | "title">,
  deps: Pick<ProspectApplicationDeps, "findById" | "findByCompanyKey">,
): Promise<JobProspect[]> => {
  let primary: JobProspect | null = null;
  let companyRows: JobProspect[];
  if (input.prospectId) {
    primary = await deps.findById(input.prospectId);
    if (!primary) throw new ProspectApplicationError("PROSPECT_NOT_FOUND", `No saved prospect with id ${input.prospectId}.`);
    companyRows = await deps.findByCompanyKey(primary.companyKey);
  } else {
    if (!input.company || !input.title) {
      throw new ProspectApplicationError("INVALID_INPUT", "Pass prospectId, or both company and title.");
    }
    const companyKey = normalizeCompany(input.company);
    companyRows = companyKey ? await deps.findByCompanyKey(companyKey) : [];
    if (companyRows.length === 0) {
      throw new ProspectApplicationError(
        "PROSPECT_NOT_FOUND",
        `No saved prospect for company "${input.company}". Save the JD with save_job_prospect (applied: true) instead.`,
      );
    }
    const wanted = normTitle(input.title);
    const exact = companyRows.filter((p) => normTitle(p.title) === wanted);
    if (exact.length > 0) {
      primary = exact[0]!;
    } else {
      const close = companyRows
        .map((p) => ({ p, score: roleSimilarity(input.title!, p.title) }))
        .filter((row) => row.score >= TITLE_MATCH_THRESHOLD)
        .sort((a, b) => b.score - a.score);
      const distinctTitles = new Set(close.map((row) => normTitle(row.p.title)));
      if (distinctTitles.size === 1) primary = close[0]!.p;
      else if (distinctTitles.size > 1) {
        throw new ProspectApplicationError(
          "PROSPECT_AMBIGUOUS",
          `Several saved ${companyRows[0]!.company} prospects match "${input.title}". Retry with prospectId.`,
          describeOptions(close.map((row) => row.p)),
        );
      } else {
        throw new ProspectApplicationError(
          "PROSPECT_NOT_FOUND",
          `No saved ${companyRows[0]!.company} prospect titled like "${input.title}". Retry with prospectId.`,
          describeOptions(companyRows),
        );
      }
    }
  }
  const title = normTitle(primary.title);
  const duplicates = companyRows.filter((p) => p.id !== primary!.id && normTitle(p.title) === title);
  return [primary, ...duplicates];
};

const emailLinkage = (
  prospect: JobProspect,
  apps: GmailApplication[],
): { confirmed: boolean; applicationKey?: string; possibleKey?: string } => {
  if (prospect.status === "attached" && prospect.attachedKey) {
    return { confirmed: true, applicationKey: prospect.attachedKey };
  }
  const companyApps = apps.filter((app) => normalizeCompany(app.company) === prospect.companyKey);
  const linkage = describeProspectLinkage(prospect, companyApps, new Map());
  if (linkage.matchStatus === "queued_for_scoring" || linkage.matchStatus === "scored") {
    return { confirmed: true, applicationKey: linkage.applicationKey };
  }
  if (linkage.matchStatus === "pending_review" && linkage.applicationKey) {
    return { confirmed: false, possibleKey: linkage.applicationKey };
  }
  return { confirmed: false };
};

const syncTracker = async (
  group: JobProspect[],
  appliedDate: string,
  deps: ProspectApplicationDeps,
): Promise<{ jobId?: string; error?: string }> => {
  const primary = group[0]!;
  try {
    const jobId = await deps.createTrackedApplication(primary, appliedDate);
    // The user may have said "not applied" while scoring ran; honor that instead of linking.
    const latest = await deps.findById(primary.id);
    if (latest?.notApplied) {
      await deps.removeTrackedApplication(jobId);
      return { error: "marked not applied before the tracker row finished" };
    }
    for (const p of group) {
      await deps.updateApplicationState(p.id, { trackerJobId: jobId, trackerCreatedByMark: true, trackerSyncError: undefined });
    }
    return { jobId };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn("Could not add user-marked application to tracker", { prospectId: primary.id, message });
    for (const p of group) await deps.updateApplicationState(p.id, { trackerSyncError: message.slice(0, 500) });
    return { error: message };
  }
};

export const markProspectApplied = async (
  input: MarkProspectAppliedInput,
  deps: ProspectApplicationDeps,
  options: { background?: boolean } = {},
): Promise<MarkProspectAppliedResult> => {
  const applied = input.applied ?? true;
  if (input.appliedAt && !/^\d{4}-\d{2}-\d{2}$/.test(input.appliedAt)) {
    throw new ProspectApplicationError("INVALID_INPUT", "appliedAt must be YYYY-MM-DD.");
  }
  const group = await resolveProspectGroup(input, deps);
  const primary = group[0]!;
  const ids = group.map((p) => p.id);
  const base = { prospectIds: ids, company: primary.company, title: primary.title, applied };

  if (!applied) {
    const created = group.find((p) => p.trackerJobId && p.trackerCreatedByMark)?.trackerJobId;
    let removed = false;
    if (created) {
      try {
        await deps.removeTrackedApplication(created);
        removed = true;
      } catch (error) {
        logger.warn("Could not remove tracker row for not-applied prospect", {
          jobId: created,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
    for (const p of group) {
      await deps.updateApplicationState(p.id, {
        notApplied: true,
        appliedAt: undefined,
        ...(removed ? { trackerJobId: undefined, trackerCreatedByMark: undefined } : {}),
      });
    }
    return {
      ...base,
      emailConfirmed: false,
      tracker: "not_applicable",
      note: `Marked ${primary.company} — ${primary.title} as not applied.${
        removed ? " Removed the tracker row that was added for it." : created ? " Could not remove its tracker row; remove it in the tracker." : ""
      }`,
    };
  }

  const appliedDate = input.appliedAt ?? localDateKey(deps.now());
  for (const p of group) await deps.updateApplicationState(p.id, { appliedAt: appliedDate, notApplied: undefined });

  const apps = await deps.getApplications(PROSPECT_MATCH_LOOKBACK_DAYS);
  const email = group.map((p) => emailLinkage(p, apps)).find((row) => row.confirmed) ?? emailLinkage(primary, apps);
  if (email.confirmed) {
    return {
      ...base,
      appliedAt: appliedDate,
      emailConfirmed: true,
      applicationKey: email.applicationKey,
      tracker: "handled_by_email",
      note: `Recorded as applied ${appliedDate}. A confirmation email is already matched (${email.applicationKey}), so the normal Gmail flow tracks it.`,
    };
  }

  const linkedId = group.find((p) => p.trackerJobId)?.trackerJobId;
  if (linkedId) {
    return {
      ...base,
      appliedAt: appliedDate,
      emailConfirmed: false,
      tracker: "already_linked",
      trackerJobId: linkedId,
      note: `Recorded as applied ${appliedDate}. Already in the tracker. A confirmation email that arrives later will link to it.`,
    };
  }

  const existing = matchTrackerJob({ company: primary.company, role: primary.title }, await deps.getTrackerJobs());
  if (existing && existing.status !== "to_review") {
    for (const p of group) await deps.updateApplicationState(p.id, { trackerJobId: existing.id, trackerSyncError: undefined });
    return {
      ...base,
      appliedAt: appliedDate,
      emailConfirmed: false,
      tracker: "linked_existing",
      trackerJobId: existing.id,
      note: `Recorded as applied ${appliedDate} and linked to the existing tracker row (${existing.status}).`,
    };
  }

  const possible = email.possibleKey ? ` A Gmail application (${email.possibleKey}) may be this one; confirm it in the dashboard.` : "";
  if (options.background ?? true) {
    void syncTracker(group, appliedDate, deps);
    return {
      ...base,
      appliedAt: appliedDate,
      emailConfirmed: false,
      tracker: "creating",
      note: `Recorded as applied ${appliedDate}. Scoring the JD and adding it to the tracker in the background (about a minute). A confirmation email that arrives later will link to it.${possible}`,
    };
  }
  const result = await syncTracker(group, appliedDate, deps);
  return {
    ...base,
    appliedAt: appliedDate,
    emailConfirmed: false,
    tracker: result.jobId ? "created" : "failed",
    trackerJobId: result.jobId,
    trackerError: result.error,
    note: result.jobId
      ? `Recorded as applied ${appliedDate} and added to the tracker.${possible}`
      : `Recorded as applied ${appliedDate}, but adding it to the tracker failed: ${result.error}`,
  };
};

export type UnconfirmedProspect = {
  prospectId: string;
  company: string;
  title: string;
  savedAt: string;
  ageDays: number;
  /** needs_answer: never marked; applied_no_email: you said you applied but no email has matched. */
  state: "needs_answer" | "applied_no_email";
  appliedAt?: string;
  trackerJobId?: string;
  trackerSyncError?: string;
  possibleApplicationKey?: string;
  salary?: string;
  sourceUrl?: string;
  duplicateIds?: string[];
};

export type ListUnconfirmedInput = { minAgeDays?: number; maxAgeDays?: number; includeApplied?: boolean };

export const listUnconfirmedProspects = async (
  input: ListUnconfirmedInput,
  deps: Pick<ProspectApplicationDeps, "findAll" | "getApplications" | "now">,
): Promise<{ total: number; needsAnswer: number; appliedNoEmail: number; prospects: UnconfirmedProspect[]; note: string }> => {
  const minAge = input.minAgeDays ?? UNCONFIRMED_MIN_AGE_DAYS;
  const maxAge = input.maxAgeDays ?? UNCONFIRMED_MAX_AGE_DAYS;
  const includeApplied = input.includeApplied ?? true;
  const now = deps.now().getTime();
  const [rows, apps] = await Promise.all([deps.findAll(), deps.getApplications(PROSPECT_MATCH_LOOKBACK_DAYS)]);

  const candidates = rows.filter((p) => {
    if (p.status !== "open" || p.notApplied) return false;
    const age = (now - Date.parse(p.createdAt)) / DAY_MS;
    if (age > maxAge) return false;
    return p.appliedAt ? includeApplied : age >= minAge;
  });

  const byPosting = new Map<string, UnconfirmedProspect>();
  for (const p of candidates) {
    const email = emailLinkage(p, apps);
    if (email.confirmed) continue;
    const groupKey = `${p.companyKey}::${normTitle(p.title)}`;
    const existing = byPosting.get(groupKey);
    if (existing) {
      existing.duplicateIds = [...(existing.duplicateIds ?? []), p.id];
      existing.appliedAt ??= p.appliedAt;
      existing.trackerJobId ??= p.trackerJobId;
      if (existing.appliedAt) existing.state = "applied_no_email";
      continue;
    }
    byPosting.set(groupKey, {
      prospectId: p.id,
      company: p.company,
      title: p.title,
      savedAt: p.createdAt,
      ageDays: Math.floor((now - Date.parse(p.createdAt)) / DAY_MS),
      state: p.appliedAt ? "applied_no_email" : "needs_answer",
      appliedAt: p.appliedAt,
      trackerJobId: p.trackerJobId,
      trackerSyncError: p.trackerSyncError,
      possibleApplicationKey: email.possibleKey,
      salary: p.salary,
      sourceUrl: p.sourceUrl,
    });
  }
  const prospects = [...byPosting.values()].sort((a, b) =>
    a.state === b.state ? b.ageDays - a.ageDays : a.state === "needs_answer" ? -1 : 1,
  );
  const needsAnswer = prospects.filter((p) => p.state === "needs_answer").length;
  const appliedNoEmail = prospects.length - needsAnswer;
  return {
    total: prospects.length,
    needsAnswer,
    appliedNoEmail,
    prospects,
    note:
      needsAnswer > 0
        ? `Ask the user whether they applied to the ${needsAnswer} needs_answer prospect(s), then call mark_prospect_applied (applied: true or false) for each.`
        : "Nothing needs an answer.",
  };
};

/** Production wiring. Imported lazily so tests of the pure logic don't load the job agent. */
export const createLiveProspectApplicationDeps = (): ProspectApplicationDeps => ({
  findById: (id) => jobProspectsRepository.findById(id),
  findByCompanyKey: (key) => jobProspectsRepository.findByCompanyKey(key),
  findAll: () => jobProspectsRepository.findAll(),
  updateApplicationState: (id, patch) => jobProspectsRepository.updateApplicationState(id, patch),
  getApplications: getGmailApplications,
  getTrackerJobs: async () => {
    const { jobsRepository } = await import("../../jobs/jobs.repository.js");
    return jobsRepository.findAll();
  },
  createTrackedApplication: async (prospect, appliedDate) => {
    const { jobsService } = await import("../../jobs/jobs.service.js");
    const draft = await jobsService.runTriage({ rawText: prospect.rawText, companyHint: prospect.company, fullPrep: false });
    const saved = await jobsService.confirmApplied(draft.id);
    await jobsService.updateAppliedAt(saved.id, appliedDate);
    return saved.id;
  },
  removeTrackedApplication: async (jobId) => {
    const { jobsService } = await import("../../jobs/jobs.service.js");
    await jobsService.removeFromTracker(jobId);
  },
  now: () => new Date(),
});
