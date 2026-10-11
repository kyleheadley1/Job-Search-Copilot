import { randomUUID } from "node:crypto";
import { computeSalaryAsk } from "../../agents/jobAgent/salaryAsk.js";
import { triageJob } from "../../agents/jobAgent/orchestrator.js";
import { applyCompanyPresentation } from "../../tools/companyExtraction.js";
import { env } from "../../config/env.js";
import { logger } from "../../lib/logger.js";
import { shortlistTrackerFields } from "../../lib/shortlist.js";
import type { DiscoveredListing, TopJobRecord, TopJobsSyncStats } from "../../types/topJob.js";
import { gmailAuth } from "../gmail/gmailAuth.js";
import { normalizeCompany, roleSimilarity } from "../gmail/gmailApplications.js";
import { evaluationsRepository } from "../gmail/jdRecovery/evaluations.repository.js";
import { withLlmContext } from "../llm/llmUsage.js";
import { fetchPosting, PostingFetchError, type FetchedPosting } from "../gmail/jdRecovery/fetchPosting.js";
import { preFilterListing, preFilterTitle } from "./preFilter.js";
import { topJobsRepository } from "./topJobs.repository.js";
import { jobsRepository } from "../jobs/jobs.repository.js";
import { jobsService } from "../jobs/jobs.service.js";
import type { JobRecord } from "../../types/job.js";
import { buildTrackerSpreadsheetFromJob } from "../../tracker/canonicalSpreadsheet.js";
import { ingestAlertEmails } from "./alertEmails.js";
import { classifyLocation, locationFits } from "./locationFit.js";
import { loadTopJobsBudget } from "./topJobsBudget.js";
import { prescreenListings, type PrescreenDeps, type PrescreenVerdict } from "./prescreen.js";
import { resolveAlertJd, type AlertJd } from "./alertJd.js";
import { alertListingsRepository, type AlertListingDoc, type AlertListingStatus } from "./alertListings.repository.js";

export class TopJobsSyncCooldownError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TopJobsSyncCooldownError";
  }
}

export class TopJobsGmailRequiredError extends Error {
  constructor() {
    super("Connect Gmail on the Dashboard so Top Jobs can read your job-alert emails.");
    this.name = "TopJobsGmailRequiredError";
  }
}

export const emptySyncStats = (): TopJobsSyncStats => ({
  alertEmails: 0,
  listingsParsed: 0,
  fetched: 0,
  preFiltered: 0,
  triaged: 0,
  stored: 0,
  skippedExisting: 0,
  belowMinScore: 0,
  jdUnavailable: 0,
  locationFiltered: 0,
  closed: 0,
  retired: 0,
  serperQueries: 0,
  bySource: {},
});

/** Same employer and close enough title to be the role already seen or applied to. */
const KNOWN_ROLE_SIMILARITY = 0.8;

export type KnownRole = { company: string; title: string };

export const isKnownRole = (company: string, title: string, known: KnownRole[]): boolean => {
  const c = normalizeCompany(company);
  if (!c) return false;
  return known.some((k) => normalizeCompany(k.company) === c && roleSimilarity(title, k.title) >= KNOWN_ROLE_SIMILARITY);
};

const listingToTopJob = (listing: DiscoveredListing, job: JobRecord, now: string): TopJobRecord => ({
  id: randomUUID(),
  source: listing.source,
  externalId: listing.externalId,
  applyUrl: listing.applyUrl,
  sourcePostedAt: listing.sourcePostedAt,
  sourceUpdatedAt: listing.sourceUpdatedAt,
  lastSyncedAt: now,
  extracted: {
    ...job.extracted,
    url: listing.applyUrl,
    rawText: listing.description,
  },
  rules: job.rules,
  score: job.score,
  recommendation: job.recommendation,
  topMatch: job.topMatch,
  mainRisk: job.mainRisk,
  rationale: job.rationale,
  recommendedResume: job.recommendedResume,
  resumeRationale: job.resumeRationale,
  ...(listing.location ? { location: listing.location } : {}),
  liveCheckedAt: now,
});

export const toDiscoveredListing = (
  listing: AlertListingDoc,
  jd: Extract<AlertJd, { ok: true }>,
): DiscoveredListing => {
  const alertLink = listing.links.find((l) => l.url === jd.alertUrl);
  return {
    source: `${jd.platform}_alert`,
    externalId: alertLink?.externalId ?? listing._id,
    company: listing.company,
    title: listing.title,
    description: jd.posting.text,
    applyUrl: jd.viaSearch || !jd.alertUrl ? jd.posting.url : jd.alertUrl,
    location: listing.location ?? jd.posting.location ?? undefined,
    remote: /\bremote\b/i.test(`${listing.location ?? ""} ${jd.posting.location ?? ""}`),
    sourcePostedAt: listing.firstSeenAt,
    sourceUpdatedAt: listing.lastSeenAt,
  };
};

export type ProcessDeps = {
  known: KnownRole[];
  maxTriages: number;
  minScore: number;
  resolveJd: (listing: AlertListingDoc) => Promise<AlertJd>;
  triage: (listing: DiscoveredListing) => Promise<JobRecord>;
  store: (listing: DiscoveredListing, job: JobRecord) => Promise<string>;
  setOutcome: (
    key: string,
    outcome: { status: Exclude<AlertListingStatus, "pending">; reason?: string; topJobId?: string },
  ) => Promise<void>;
};

/**
 * Cheapest checks first: title filter and de-duplication cost nothing, the JD fetch may cost a
 * search credit, and scoring is the only paid step. Roles left once the cap is hit stay pending.
 */
export const processAlertListings = async (
  pending: AlertListingDoc[],
  deps: ProcessDeps,
  stats: TopJobsSyncStats,
): Promise<void> => {
  for (const listing of pending) {
    if (stats.triaged >= deps.maxTriages) break;
    stats.fetched += 1;

    const titleCheck = preFilterTitle(listing.title);
    if (!titleCheck.pass) {
      await deps.setOutcome(listing._id, { status: "filtered", reason: titleCheck.reason });
      continue;
    }
    const alertLocation = classifyLocation(listing.location);
    if (alertLocation === "mismatch") {
      stats.locationFiltered += 1;
      await deps.setOutcome(listing._id, { status: "filtered", reason: "location_mismatch" });
      continue;
    }
    if (isKnownRole(listing.company, listing.title, deps.known)) {
      stats.skippedExisting += 1;
      await deps.setOutcome(listing._id, { status: "duplicate" });
      continue;
    }

    const jd = await deps.resolveJd(listing);
    stats.serperQueries += jd.serperQueries;
    if (!jd.ok) {
      if (jd.closed) stats.closed += 1;
      else stats.jdUnavailable += 1;
      await deps.setOutcome(listing._id, jd.closed ? { status: "filtered", reason: "closed" } : { status: "jd_unavailable", reason: jd.reason });
      continue;
    }
    if (jd.posting.closed) {
      stats.closed += 1;
      await deps.setOutcome(listing._id, { status: "filtered", reason: "closed" });
      continue;
    }
    if (alertLocation !== "fit" && classifyLocation(jd.posting.location) === "mismatch") {
      stats.locationFiltered += 1;
      await deps.setOutcome(listing._id, { status: "filtered", reason: "location_mismatch" });
      continue;
    }

    const discovered = toDiscoveredListing(listing, jd);
    const full = preFilterListing(discovered);
    if (!full.pass) {
      await deps.setOutcome(listing._id, { status: "filtered", reason: full.reason });
      continue;
    }
    stats.preFiltered += 1;

    const job = await deps.triage(discovered);
    stats.triaged += 1;
    deps.known.push({ company: listing.company, title: listing.title });
    if (
      !locationFits({ alertLocation: listing.location, postingLocation: jd.posting.location, extracted: job.extracted })
    ) {
      stats.locationFiltered += 1;
      await deps.setOutcome(listing._id, { status: "filtered", reason: "location_mismatch" });
      continue;
    }
    if (job.score.total < deps.minScore) {
      stats.belowMinScore += 1;
      await deps.setOutcome(listing._id, { status: "below_min", reason: String(job.score.total) });
      continue;
    }
    const topJobId = await deps.store(discovered, job);
    stats.stored += 1;
    stats.bySource[jd.platform] = (stats.bySource[jd.platform] ?? 0) + 1;
    await deps.setOutcome(listing._id, { status: "stored", topJobId });
  }
};

const triageListing = async (listing: DiscoveredListing): Promise<JobRecord> => {
  const rawJob = await withLlmContext({ feature: "top_jobs", key: listing.externalId }, () =>
    triageJob({ rawText: listing.description, companyHint: listing.company, fullPrep: false }),
  );
  rawJob.extracted.url = listing.applyUrl;
  rawJob.extracted.rawText = listing.description;
  if (!rawJob.extracted.title?.trim() || rawJob.extracted.title === "Unknown Title") {
    rawJob.extracted.title = listing.title;
  }
  if (!rawJob.extracted.company?.trim() || rawJob.extracted.company === "Unknown Company") {
    rawJob.extracted.company = listing.company;
  }
  rawJob.extracted = applyCompanyPresentation(
    { ...rawJob.extracted, company: rawJob.extracted.company, rawText: listing.description },
    listing.company,
  );
  return rawJob;
};

const storeTopJob = async (listing: DiscoveredListing, job: JobRecord): Promise<string> => {
  const existing =
    (await topJobsRepository.findBySourceKey(listing.source, listing.externalId)) ??
    (await topJobsRepository.findByApplyUrl(listing.applyUrl));
  const record = listingToTopJob(listing, job, new Date().toISOString());
  record.id = existing?.id ?? topJobsRepository.createId();
  await topJobsRepository.upsert(record);
  return record.id;
};

const loadKnownRoles = async (): Promise<KnownRole[]> => {
  const [topJobs, tracker, evaluations] = await Promise.all([
    topJobsRepository.listAll(),
    jobsRepository.list(),
    evaluationsRepository.listSince(new Date(0).toISOString()),
  ]);
  return [
    ...topJobs.map((j) => ({ company: j.extracted.company ?? "", title: j.extracted.title ?? "" })),
    ...tracker.items.map((j) => ({ company: j.extracted.company ?? "", title: j.extracted.title ?? "" })),
    ...evaluations.map((e) => ({ company: e.company, title: e.role ?? e.recovery.recoveredRole ?? "" })),
  ].filter((k) => k.company && k.title);
};

/** Listed roles are re-checked for closing at most this often. */
const LIVE_RECHECK_MS = 20 * 60 * 60 * 1000;
const BOT_BLOCKED_HOST_RE = /(^|\.)(indeed|indeedemail|ziprecruiter)\.com$/i;

export type RecheckDeps = {
  list: () => Promise<TopJobRecord[]>;
  fetch: (url: string) => Promise<FetchedPosting>;
  hide: (id: string, reason: NonNullable<TopJobRecord["hiddenReason"]>) => Promise<void>;
  markChecked: (id: string) => Promise<void>;
};

const defaultRecheckDeps: RecheckDeps = {
  list: () => topJobsRepository.list(0),
  fetch: fetchPosting,
  hide: (id, reason) => topJobsRepository.hide(id, reason),
  markChecked: (id) => topJobsRepository.markLiveChecked(id),
};

/** Hide listed roles whose location doesn't fit or whose posting has since closed; tracker rows are untouched. */
export const recheckListedTopJobs = async (deps: RecheckDeps = defaultRecheckDeps, now = Date.now()): Promise<number> => {
  let retired = 0;
  for (const job of await deps.list()) {
    if (job.promotedToJobId) continue;
    if (!locationFits({ alertLocation: job.location, extracted: job.extracted })) {
      await deps.hide(job.id, "location");
      retired += 1;
      continue;
    }
    if (job.liveCheckedAt && now - Date.parse(job.liveCheckedAt) < LIVE_RECHECK_MS) continue;
    let host = "";
    try {
      host = new URL(job.applyUrl).hostname;
    } catch {
      continue;
    }
    if (BOT_BLOCKED_HOST_RE.test(host)) continue;
    try {
      const posting = await deps.fetch(job.applyUrl);
      if (posting.closed) {
        await deps.hide(job.id, "closed");
        retired += 1;
        continue;
      }
      if (!locationFits({ alertLocation: job.location, postingLocation: posting.location, extracted: job.extracted })) {
        await deps.hide(job.id, "location");
        retired += 1;
        continue;
      }
      await deps.markChecked(job.id);
    } catch (error) {
      if (error instanceof PostingFetchError && (error.reason === "closed" || error.reason === "not_found")) {
        await deps.hide(job.id, "closed");
        retired += 1;
      }
    }
  }
  return retired;
};

const PRESCREEN_RANK: Record<PrescreenVerdict | "none", number> = { score: 0, maybe: 1, none: 2, skip: 3 };

/**
 * With only a few scorings a day, spend them first on roles the pre-screen rated "score",
 * then on roles the alert already says are remote/NYC, newest first.
 */
export const prioritizePending = (pending: AlertListingDoc[]): AlertListingDoc[] =>
  pending
    .map((listing, i) => ({
      listing,
      i,
      verdict: PRESCREEN_RANK[listing.prescreen?.verdict ?? "none"],
      fit: classifyLocation(listing.location) === "fit" ? 0 : 1,
    }))
    .sort((a, b) => a.verdict - b.verdict || a.fit - b.fit || a.i - b.i)
    .map((x) => x.listing);

/** Label unscreened roles, then retire the ones rated "skip" so they never use a scoring. */
export const applyPrescreen = async (
  pending: AlertListingDoc[],
  stats: TopJobsSyncStats,
  deps: Partial<Pick<PrescreenDeps, "run">> & {
    save: PrescreenDeps["save"];
    setOutcome: ProcessDeps["setOutcome"];
  },
): Promise<AlertListingDoc[]> => {
  const before = pending.filter((l) => !l.prescreen).length;
  await prescreenListings(pending, { run: deps.run, save: deps.save });
  stats.prescreened = before - pending.filter((l) => !l.prescreen).length;
  const kept: AlertListingDoc[] = [];
  for (const listing of pending) {
    if (listing.prescreen?.verdict === "skip") {
      stats.prescreenSkipped = (stats.prescreenSkipped ?? 0) + 1;
      await deps.setOutcome(listing._id, { status: "filtered", reason: "prescreen" });
    } else {
      kept.push(listing);
    }
  }
  return prioritizePending(kept);
};

export const listingWindowStart = (now = Date.now()): string =>
  new Date(now - env.topJobsListingMaxAgeDays * 86_400_000).toISOString();

let syncInProgress = false;

export const runTopJobsSync = async (options?: {
  manual?: boolean;
  skipConcurrencyGuard?: boolean;
}): Promise<TopJobsSyncStats> => {
  const manual = options?.manual ?? false;

  if (!options?.skipConcurrencyGuard && syncInProgress) {
    logger.info("Top jobs sync skipped — already in progress");
    const meta = await topJobsRepository.getSyncMeta();
    return meta.lastSyncStats ?? emptySyncStats();
  }

  if (!options?.skipConcurrencyGuard) syncInProgress = true;
  try {
    return await runTopJobsSyncInner(manual);
  } finally {
    if (!options?.skipConcurrencyGuard) syncInProgress = false;
  }
};

const runTopJobsSyncInner = async (manual: boolean): Promise<TopJobsSyncStats> => {
  if (manual) {
    const status = await topJobsRepository.getSyncStatus();
    if (!status.canManualRefresh) {
      throw new TopJobsSyncCooldownError(
        `Manual refresh available at ${status.manualRefreshAvailableAt ?? "later"}`,
      );
    }
  }

  const gmail = await gmailAuth.getStatus();
  if (!gmail.configured || !gmail.connected) throw new TopJobsGmailRequiredError();

  const stats = emptySyncStats();
  try {
    stats.retired = await recheckListedTopJobs();
    if ((await loadTopJobsBudget()).exhausted) {
      stats.budgetLimited = true;
      await topJobsRepository.recordSyncResult({ stats, manual, error: null });
      logger.info("Top jobs sync skipped alert parsing — monthly budget reached", stats);
      return stats;
    }
    const ingest = await ingestAlertEmails();
    stats.alertEmails = ingest.alertEmails;
    stats.listingsParsed = ingest.listingsParsed;

    const budget = await loadTopJobsBudget();
    const pending = await applyPrescreen(await alertListingsRepository.listPending(listingWindowStart()), stats, {
      save: (key, prescreen) => alertListingsRepository.setPrescreen(key, prescreen),
      setOutcome: (key, outcome) => alertListingsRepository.setOutcome(key, outcome),
    });
    await processAlertListings(
      pending,
      {
        known: await loadKnownRoles(),
        maxTriages: budget.allowedTriages,
        minScore: env.topJobsMinScore,
        resolveJd: (l) => resolveAlertJd(l),
        triage: triageListing,
        store: storeTopJob,
        setOutcome: (key, outcome) => alertListingsRepository.setOutcome(key, outcome),
      },
      stats,
    );
    if (
      budget.allowedTriages < env.topJobsMaxTriagesPerSync &&
      stats.triaged >= budget.allowedTriages &&
      stats.fetched < pending.length
    ) {
      stats.budgetLimited = true;
    }

    await topJobsRepository.recordSyncResult({ stats, manual, error: null });
    logger.info("Top jobs sync completed", stats);
    return stats;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await topJobsRepository.recordSyncResult({ stats, manual, error: message });
    throw error;
  }
};

export class ListingNotScorableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ListingNotScorableError";
  }
}

export type ListingOutcome = { status: Exclude<AlertListingStatus, "pending">; reason?: string; topJobId?: string };

/**
 * Scores one queued (or prescreen-skipped) alert listing on request, through the same filters as a
 * sync. The cost lands on Top Jobs spend.
 */
export const scoreListingNow = async (key: string): Promise<ListingOutcome> => {
  const listing = await alertListingsRepository.get(key);
  if (!listing) throw new ListingNotScorableError("Listing not found");
  const prescreenSkipped = listing.status === "filtered" && listing.reason === "prescreen";
  if (listing.status !== "pending" && !prescreenSkipped) {
    throw new ListingNotScorableError(`Listing was already processed (${listing.status})`);
  }
  let outcome: ListingOutcome = { status: "jd_unavailable", reason: "not processed" };
  await processAlertListings(
    [listing],
    {
      known: await loadKnownRoles(),
      maxTriages: 1,
      minScore: env.topJobsMinScore,
      resolveJd: (l) => resolveAlertJd(l),
      triage: triageListing,
      store: storeTopJob,
      setOutcome: async (k, o) => {
        outcome = o;
        await alertListingsRepository.setOutcome(k, o);
      },
    },
    emptySyncStats(),
  );
  return outcome;
};

export const promoteTopJobToTracker = async (topJobId: string): Promise<JobRecord> => {
  const topJob = await topJobsRepository.getById(topJobId);
  if (!topJob) throw new Error("Top job not found");

  if (topJob.promotedToJobId) {
    const existing = await jobsRepository.getById(topJob.promotedToJobId);
    if (existing) return existing;
  }

  const now = new Date().toISOString();
  const job: JobRecord = {
    id: randomUUID(),
    extracted: topJob.extracted,
    rules: topJob.rules,
    score: topJob.score,
    recommendation: topJob.recommendation,
    salaryAsk: computeSalaryAsk({
      extracted: topJob.extracted,
      score: topJob.score,
      recommendation: topJob.recommendation,
      rules: topJob.rules,
    }),
    recommendedResume: topJob.recommendedResume ?? "BASE",
    resumeRationale: topJob.resumeRationale ?? [],
    topMatch: topJob.topMatch,
    mainRisk: topJob.mainRisk,
    rationale: topJob.rationale,
    risks: [],
    generated: {},
    tracker: {
      priority: topJob.score.total >= env.topJobsMinScore ? "high" : "medium",
      recommendedAction: "Review from Top Jobs",
      statusOutcome: topJob.recommendation,
      color: "green",
    },
    status: "to_review",
    createdAt: now,
    updatedAt: now,
    scoreHistory: [
      {
        scoredAt: now,
        score: topJob.score,
        recommendation: topJob.recommendation,
      },
    ],
  };
  job.tracker = {
    ...job.tracker,
    ...shortlistTrackerFields(job),
  };
  job.trackerSpreadsheet = buildTrackerSpreadsheetFromJob(job);
  await jobsRepository.saveTriage(job);
  await topJobsRepository.markPromoted(topJobId, job.id);
  return job;
};

/** You applied: save the role to the tracker as applied (today) and take it off Top Jobs. */
export const markTopJobApplied = async (topJobId: string): Promise<JobRecord> => {
  const promoted = await promoteTopJobToTracker(topJobId);
  const applied = await jobsService.confirmApplied(promoted.id);
  await topJobsRepository.hide(topJobId, "applied");
  return applied;
};
