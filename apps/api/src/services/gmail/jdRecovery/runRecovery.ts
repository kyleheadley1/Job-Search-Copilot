import { triageJob } from "../../../agents/jobAgent/orchestrator.js";
import { env } from "../../../config/env.js";
import { computeJdTextHash } from "../../../lib/jdTextHash.js";
import { extractJobPostingMetadata, isWeakJobTitle } from "../../../tools/jobPostingMetadataExtract.js";
import { logger } from "../../../lib/logger.js";
import { withLlmContext } from "../../llm/llmUsage.js";
import type { JobRecord } from "../../../types/job.js";
import type { ResumeContextSet } from "../../../types/resumeContext.js";
import { recomputeStoredJobScore } from "../../../lib/recomputeStoredJobScore.js";
import {
  getGmailApplications,
  normalizeCompany,
  roleSimilarity,
  type ApplicationStatus,
  type GmailApplication,
} from "../gmailApplications.js";
import type { EmailEventType } from "../gmailClassifier.js";
import { gmailClient, type ParsedEmail } from "../gmailClient.js";
import {
  assessJdMatch,
  HIGH_ROLE_SIMILARITY,
  isScoreable,
  type EvidenceSource,
  type JdMatch,
  type MatchLevel,
} from "./assessJdMatch.js";
import {
  atsBoardsRepository,
  boardConfirmsCompany,
  discoverBoards,
  fetchBoardJob,
  listBoard,
  type BoardJob,
  type BoardListing,
} from "./atsBoards.js";
import { boardFromUrl, detectAtsHints, type BoardRef } from "./atsHints.js";
import {
  locationInText,
  normalizeForMatch,
  normalizeTitle,
  strictTitleSimilarity,
  textSimilarity,
  titleInText,
} from "./titleMatch.js";
import {
  classifyJobLink,
  cleanRoleTitle,
  collectEmailEvidence,
  extractRequisitionId,
  unwrapLink,
} from "./emailEvidence.js";
import {
  evaluationsRepository,
  type ApplicationEvaluation,
  type BoardCheck,
  type RecoveryAttempt,
  type RecoveryCandidate,
  type RecoveryStage,
  type ScoringDetail,
  type ScoringDiagnostic,
} from "./evaluations.repository.js";
import { fetchPosting, PostingFetchError, type FetchedPosting } from "./fetchPosting.js";
import { jobProspectsRepository, type JobProspect } from "./jobProspects.repository.js";
import { matchProspectsToApplication, PROSPECT_MATCH_LOOKBACK_DAYS } from "./prospectMatch.js";
import { inferCandidateStage } from "./recoveryMetrics.js";
import { serperClient, serperUsageRepository, type SerperResult, type SerperUsage } from "./serperClient.js";
import { addMissingApplicationsQuietly } from "../trackerAutoAdd.js";

export const SCORER_VERSION = "jd-recovery-v1:base-ai";
/** Bump to retry every unscored row with an improved recovery pipeline. */
export const RECOVERY_VERSION = 4;
const MAX_DUPLICATE_CHECK = 4;
const DUPLICATE_JD_SIMILARITY = 0.85;
const MAX_STORED_CANDIDATES = 5;
const MAX_CANDIDATE_TEXT = 20_000;
const MAX_BOARD_CANDIDATES = 3;
const RECOVERY_BODY_CHARS = 20_000;
const MAX_EMAIL_LINKS = 5;
const MAX_SERPER_QUERIES_PER_JOB = 2;
const MAX_SERPER_CANDIDATES = 3;
const FETCH_FAILED_RETRY_MS = 24 * 60 * 60 * 1000;
/** Bounds total work per run; cheap no-evidence rows don't count against the triage cap. */
const MAX_PROCESSED_PER_RUN_FACTOR = 4;

const AGGREGATOR_HOST_RE =
  /(^|\.)(indeed|glassdoor|ziprecruiter|simplyhired|monster|careerbuilder|builtin|talent|jooble|adzuna|dice|wellfound|levels\.fyi|salary|payscale|comparably)\./i;

type Candidate = { posting: FetchedPosting; source: EvidenceSource; match: JdMatch; stage: RecoveryStage };

const EVENT_TO_OUTCOME: Partial<Record<EmailEventType, ApplicationStatus>> = {
  applied: "applied",
  assessment: "assessment",
  interview: "interviewing",
  rejected: "rejected",
  offer: "offer",
};

export const buildOutcome = (app: GmailApplication): ApplicationEvaluation["outcome"] => {
  const lastRound = app.interviewRounds?.at(-1);
  return {
    status: app.status,
    furthestStage: app.furthestStage,
    ...(lastRound ? { furthestRound: { number: lastRound.number, label: lastRound.label } } : {}),
    updatedAt: app.lastUpdateAt,
    history: [...app.emails]
      .reverse()
      .flatMap((e) => {
        const status = EVENT_TO_OUTCOME[e.eventType];
        return status ? [{ status, at: e.date }] : [];
      }),
  };
};

const CATEGORY_KEYS = [
  "stackFit",
  "levelFit",
  "domainFit",
  "resumeStoryClarity",
  "functionalOverlap",
  "recruiterFriendliness",
  "careerValue",
] as const;

export const fitFromJob = (job: JobRecord): NonNullable<ApplicationEvaluation["fit"]> => {
  const s = job.score;
  return {
    total: s.total,
    recommendation: job.recommendation,
    recommendedResume: job.recommendedResume,
    scoredAt: new Date().toISOString(),
    promptVersion: SCORER_VERSION,
    breakdown: {
      categories: Object.fromEntries(CATEGORY_KEYS.map((k) => [k, s[k]])),
      capability: s.capability,
      survivability: s.survivability,
      gapDock: s.scoreDisplay?.gapDock,
      hardGates: s.scoreDisplay?.hardGates?.length ? s.scoreDisplay.hardGates : undefined,
      topMatch: job.topMatch,
      mainRisk: job.mainRisk,
      risks: job.risks?.slice(0, 4),
    },
    detail: scoringDetailFromJob(job),
  };
};

export const scoringDetailFromJob = (job: JobRecord): ScoringDetail => {
  const { rawText: _rawText, ...extracted } = job.extracted;
  return {
    recommendation: job.recommendation,
    recommendedResume: job.recommendedResume,
    topMatch: job.topMatch,
    mainRisk: job.mainRisk,
    rationale: job.rationale ?? [],
    risks: job.risks ?? [],
    resumeRationale: job.resumeRationale ?? [],
    score: job.score,
    rules: job.rules,
    extracted,
  };
};

export class NoStoredJdError extends Error {
  constructor(key: string) {
    super(`No stored job description for ${key}; recover or paste one first.`);
  }
}

/** Score the stored JD again for auditing. The result is kept beside `fit`, which stays final. */
export const runScoringDiagnostic = async (key: string): Promise<ApplicationEvaluation> => {
  const evaluation = await evaluationsRepository.findByKey(key);
  if (!evaluation) throw new EvaluationNotFoundError(`No evaluation for ${key}`);
  if (!evaluation.jd?.text) throw new NoStoredJdError(key);
  const job = await scoreBlind(evaluation.jd, evaluation.company, key);
  const diagnostic: ScoringDiagnostic = {
    runAt: new Date().toISOString(),
    promptVersion: SCORER_VERSION,
    total: job.score.total,
    detail: scoringDetailFromJob(job),
  };
  await evaluationsRepository.setDiagnostic(key, diagnostic);
  return { ...evaluation, diagnostic };
};

/**
 * Re-run deterministic rules + composite on a stored score's extraction and LLM categories.
 * No LLM calls, so rule fixes apply without run-to-run noise. Only for deliberate manual
 * rescores — normal syncs and recovery runs never touch `fit`.
 */
export const replayStoredScore = async (
  evaluation: ApplicationEvaluation,
  resumeContexts?: ResumeContextSet,
): Promise<NonNullable<ApplicationEvaluation["fit"]>> => {
  const detail = evaluation.fit?.detail;
  if (!detail || !evaluation.jd?.text) throw new NoStoredJdError(evaluation.key);
  const stored = {
    extracted: { ...detail.extracted, rawText: evaluation.jd.text },
    score: detail.score,
    recommendedResume: detail.recommendedResume,
  } as JobRecord;
  const out = recomputeStoredJobScore({ job: stored, resumeContexts });
  return fitFromJob({
    ...stored,
    rules: out.rules,
    score: out.score,
    recommendation: out.recommendation,
    topMatch: detail.topMatch,
    mainRisk: detail.mainRisk,
    rationale: detail.rationale,
    risks: detail.risks,
    resumeRationale: detail.resumeRationale,
  } as JobRecord);
};

export type ScoringReport = {
  key: string;
  company: string;
  role: string | null;
  fit: ApplicationEvaluation["fit"] | null;
  diagnostic: ScoringDiagnostic | null;
  jd: { text: string; title?: string; url?: string } | null;
};

export const toScoringReport = (e: ApplicationEvaluation): ScoringReport => ({
  key: e.key,
  company: e.company,
  role: e.role,
  fit: e.fit ?? null,
  diagnostic: e.diagnostic ?? null,
  jd: e.jd ? { text: e.jd.text, title: e.jd.title, url: e.recovery.url } : null,
});

/** The scorer sees only the recovered JD and a company hint — never email content or outcome. */
export const scoreBlind = (
  posting: Pick<FetchedPosting, "text">,
  companyHint: string,
  key?: string,
): Promise<JobRecord> =>
  withLlmContext({ feature: "jd_recovery", key }, () =>
    triageJob({ rawText: posting.text, companyHint, fullPrep: false }),
  );

export const ATS_SITE_FILTER =
  "(site:greenhouse.io OR site:lever.co OR site:ashbyhq.com OR site:myworkdayjobs.com OR site:smartrecruiters.com OR site:workable.com)";

export const buildSerperQueries = (company: string, role: string | null, reqId?: string): string[] => {
  const queries: string[] = [];
  if (reqId) queries.push(`"${reqId}" ${company}`);
  if (role) queries.push(`"${company}" "${role}" ${ATS_SITE_FILTER}`);
  return queries.slice(0, MAX_SERPER_QUERIES_PER_JOB);
};

/** ATS and company pages first; aggregator listings dropped. */
export const rankSerperResults = (results: SerperResult[]): string[] => {
  const scored: Array<{ url: string; rank: number }> = [];
  for (const r of results) {
    const url = unwrapLink(r.link);
    if (!url) continue;
    let host: string;
    try {
      host = new URL(url).hostname;
    } catch {
      continue;
    }
    if (AGGREGATOR_HOST_RE.test(host)) continue;
    if (/linkedin\.com$/.test(host) && !/\/jobs\/view\//.test(url)) continue;
    const kind = classifyJobLink(url);
    const onBoard = boardFromUrl(url)?.slug;
    scored.push({ url, rank: onBoard || (kind && kind !== "careers" && kind !== "linkedin") ? 0 : kind ? 1 : 2 });
  }
  return [...new Map(scored.sort((a, b) => a.rank - b.rank).map((s) => [s.url, s])).keys()];
};

const describeError = (error: unknown): string =>
  error instanceof PostingFetchError ? error.reason : error instanceof Error ? error.message.slice(0, 120) : "error";

const MATCH_ORDER = { exact: 3, high: 2, low: 1, none: 0 } as const;

const better = (a: Candidate | undefined, b: Candidate): Candidate =>
  !a || MATCH_ORDER[b.match.level] > MATCH_ORDER[a.match.level] ? b : a;

/** Keep MCP submissions across a later recovery rebuild; never let Serper/email wipe them. */
const mergeStoredCandidates = (
  found: Map<string, RecoveryCandidate>,
  existing: ApplicationEvaluation | null,
): RecoveryCandidate[] => {
  for (const candidate of existing?.recovery.candidates ?? []) {
    if (candidate.source !== "mcp") continue;
    const key = candidate.url ?? `mcp:${computeJdTextHash(candidate.text)}`;
    if (!found.has(key)) found.set(key, candidate);
  }
  const submitted = [...found.values()].filter((c) => c.source === "mcp");
  const rest = [...found.values()]
    .filter((c) => c.source !== "mcp")
    .sort((x, y) => MATCH_ORDER[y.matchLevel] - MATCH_ORDER[x.matchLevel]);
  return [...submitted, ...rest].slice(0, MAX_STORED_CANDIDATES);
};

export const needsRecovery = (
  existing: ApplicationEvaluation | undefined,
  now = Date.now(),
  serperBudgetLeft = true,
): boolean => {
  if (!existing) return true;
  const { status, notes, reason } = existing.recovery;
  if (status === "scored") return false;
  if ((existing.recoveryVersion ?? 1) < RECOVERY_VERSION) return true;
  if (status === "fetch_failed") return now - Date.parse(existing.updatedAt) > FETCH_FAILED_RETRY_MS;
  const has = (note: string) => reason === note || Boolean(notes?.includes(note));
  if (!serperClient.isConfigured()) return false;
  return has("serper_not_configured") || (has("serper_cap_reached") && serperBudgetLeft);
};

const fetchEmails = async (app: GmailApplication): Promise<ParsedEmail[]> => {
  const results = await Promise.allSettled(app.emails.map((e) => gmailClient.getMessage(e.id, RECOVERY_BODY_CHARS)));
  return results.flatMap((r) => (r.status === "fulfilled" ? [r.value] : []));
};

/** Most actionable first; `reason` is the first note present. */
const NOTE_PRIORITY = [
  "serper_cap_reached",
  "email_links_failed",
  "multiple_title_matches",
  "board_found_no_search",
  "not_on_board",
  "no_board_found",
  "role_unknown",
  "serper_not_configured",
  "serper_no_results",
  "no_search_terms",
];

const sortNotes = (notes: Set<string>): string[] =>
  [...notes].sort((a, b) => {
    const ia = NOTE_PRIORITY.indexOf(a);
    const ib = NOTE_PRIORITY.indexOf(b);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
  });

const boardKey = (ref: BoardRef) => `${ref.ats}:${ref.slug.toLowerCase()}`;

export const summarizeBoard = (listing: BoardListing, role: string | null): BoardCheck => {
  const check: BoardCheck = { board: boardKey(listing.ref), jobs: listing.jobs.length };
  if (!role) return check;
  for (const job of listing.jobs) {
    const similarity = strictTitleSimilarity(role, job.title);
    if (similarity > 0 && similarity > (check.similarity ?? 0)) {
      check.closestTitle = job.title;
      check.similarity = Math.round(similarity * 100) / 100;
    }
  }
  return check;
};

const prospectCandidate = (prospect: JobProspect): RecoveryCandidate => ({
  prospectId: prospect.id,
  url: prospect.sourceUrl,
  source: "prospect",
  stage: "prospect",
  matchLevel: "high",
  title: prospect.title,
  company: prospect.company,
  location: prospect.location,
  text: prospect.cleanedText.slice(0, MAX_CANDIDATE_TEXT),
});

const attachProspectAndScore = async (
  app: GmailApplication,
  existing: ApplicationEvaluation | undefined,
  prospect: JobProspect,
): Promise<{ evaluation: ApplicationEvaluation; triaged: boolean }> => {
  const now = new Date().toISOString();
  const base: ApplicationEvaluation =
    existing ??
    {
      key: app.key,
      company: app.company,
      role: app.role,
      appliedAt: app.appliedAt,
      recoveryVersion: RECOVERY_VERSION,
      recovery: { status: "unverified", attempts: [], serperQueries: 0, notes: ["prospect_attached"] },
      outcome: buildOutcome(app),
      createdAt: now,
      updatedAt: now,
    };
  try {
    const scored = await scoreUserPosting(
      base,
      {
        text: prospect.cleanedText,
        url: prospect.sourceUrl,
        title: prospect.title,
        company: prospect.company,
        matchLevel: "high",
        stage: "prospect",
      },
      "prospect_auto_attached",
    );
    await jobProspectsRepository.markAttached(prospect.id, app.key);
    return { evaluation: scored, triaged: true };
  } catch (error) {
    if (error instanceof AlreadyScoredError) {
      const scored = await evaluationsRepository.findByKey(app.key);
      if (scored) return { evaluation: scored, triaged: false };
    }
    const failed: ApplicationEvaluation = {
      ...base,
      recovery: {
        ...base.recovery,
        status: "fetch_failed",
        reason: `triage_failed: ${describeError(error)}`,
        source: "prospect",
        foundVia: "prospect",
      },
      updatedAt: new Date().toISOString(),
    };
    return { evaluation: failed, triaged: true };
  }
};

/** Recover, verify, and (only when verified) blind-score one application. */
export const recoverApplication = async (
  app: GmailApplication,
  usage: SerperUsage,
): Promise<{ evaluation: ApplicationEvaluation; triaged: boolean }> => {
  const existing = await evaluationsRepository.findByKey(app.key);
  if (existing?.recovery.status === "scored") {
    return { evaluation: existing, triaged: false };
  }

  const companyKey = normalizeCompany(app.company);
  const openProspects = companyKey ? await jobProspectsRepository.findOpenByCompanyKey(companyKey) : [];
  let reviewProspects: JobProspect[] = [];
  if (openProspects.length > 0) {
    const companyApps = (await getGmailApplications(PROSPECT_MATCH_LOOKBACK_DAYS)).filter(
      (row) => normalizeCompany(row.company) === companyKey,
    );
    const prospectMatch = matchProspectsToApplication({
      app,
      prospects: openProspects,
      companyApps,
      requisitionId: app.role ? extractRequisitionId(app.role, "") : undefined,
    });
    if (prospectMatch.decision === "auto" && prospectMatch.prospects[0]) {
      return attachProspectAndScore(app, existing ?? undefined, prospectMatch.prospects[0]);
    }
    if (prospectMatch.decision === "review") reviewProspects = prospectMatch.prospects;
  }

  const emails = await fetchEmails(app);
  const evidence = collectEmailEvidence(emails);
  const hints = detectAtsHints(emails);
  const reqId = evidence.requisitionId ?? (app.role ? extractRequisitionId(app.role, "") : undefined);
  const attempts: RecoveryAttempt[] = [];
  const notes = new Set<string>();
  const triedBoards = new Set<string>();
  let best: Candidate | undefined;
  let fetchErrors = 0;
  let emailLinkErrors = 0;
  let emailLinkOk = 0;
  let boardsFound = 0;
  let confirmedBoards = 0;
  let serperQueries = 0;
  let role = app.role ? cleanRoleTitle(app.role) || app.role : app.role;
  let recoveredRole: string | undefined;
  const candidates = new Map<string, RecoveryCandidate>();
  const boardChecks: BoardCheck[] = [];
  const emailText = normalizeForMatch(emails.map((e) => `${e.subject}\n${e.body}`).join("\n"));
  let stage: RecoveryStage = "email";
  for (const prospect of reviewProspects) {
    candidates.set(`prospect:${prospect.id}`, prospectCandidate(prospect));
  }

  const verified = () => Boolean(best && isScoreable(best.match.level));

  const consider = (
    posting: FetchedPosting,
    source: EvidenceSource,
    board?: { confirmed: boolean; titleMatches: number; signals?: string[]; location?: string },
  ) => {
    const match = assessJdMatch({
      company: app.company,
      role,
      requisitionId: reqId,
      source,
      posting,
      boardConfirmed: board?.confirmed,
      boardTitleMatches: board?.titleMatches,
    });
    if (board?.signals?.length) match.signals.push(...board.signals);
    if (recoveredRole) match.signals.push("role_from_email");
    attempts.push({ url: posting.url, source, ok: true, matchLevel: match.level });
    if (posting.url && match.level !== "none" && !candidates.has(posting.url)) {
      candidates.set(posting.url, {
        url: posting.url,
        source,
        stage,
        matchLevel: match.level,
        title: posting.title,
        company: posting.company,
        location: board?.location,
        text: posting.text.slice(0, MAX_CANDIDATE_TEXT),
      });
    }
    best = better(best, { posting, source, match, stage });
  };

  const tryUrl = async (url: string, source: EvidenceSource) => {
    if (attempts.some((a) => a.url === url)) return;
    try {
      consider(await fetchPosting(url), source);
      if (source === "email_link") emailLinkOk += 1;
    } catch (error) {
      fetchErrors += 1;
      if (source === "email_link") emailLinkErrors += 1;
      attempts.push({ url, source, ok: false, reason: describeError(error) });
    }
  };

  const reqOnJob = (job: BoardJob) =>
    Boolean(
      reqId &&
        [job.requisitionId ?? "", job.url, job.text ?? ""].some((h) => h.toUpperCase().includes(reqId.toUpperCase())),
    );

  /** Single job whose distinct title or location appears in the application email. */
  const tieBreakFromEmail = (jobs: BoardJob[]): { job: BoardJob; signal: string } | undefined => {
    const titles = new Set(jobs.map((j) => normalizeTitle(j.title)));
    if (titles.size > 1) {
      const byTitle = jobs.filter((j) => titleInText(j.title, emailText));
      if (new Set(byTitle.map((j) => normalizeTitle(j.title))).size === 1 && byTitle.length === 1) {
        return { job: byTitle[0]!, signal: "email_title_match" };
      }
    }
    const byLocation = jobs.filter((j) => j.location && locationInText(j.location, emailText));
    return byLocation.length === 1 ? { job: byLocation[0]!, signal: "email_location_match" } : undefined;
  };

  const fetchJob = async (listing: BoardListing, job: BoardJob): Promise<FetchedPosting | undefined> => {
    try {
      return await fetchBoardJob(listing, job);
    } catch (error) {
      attempts.push({ url: job.url, source: "ats_board", ok: false, reason: describeError(error) });
      return undefined;
    }
  };

  /** Pick req-ID and near-identical-title jobs from a board and verify them. */
  const searchBoard = async (listing: BoardListing, confirmed: boolean) => {
    triedBoards.add(boardKey(listing.ref));
    boardsFound += 1;
    if (confirmed) confirmedBoards += 1;
    if (confirmed) boardChecks.push(summarizeBoard(listing, role));

    if (!role && confirmed) {
      const inEmail = listing.jobs.filter((j) => titleInText(j.title, emailText));
      if (inEmail.length > 0 && new Set(inEmail.map((j) => normalizeTitle(j.title))).size === 1) {
        role = inEmail[0]!.title;
        recoveredRole = role;
      }
    }

    const byReq = listing.jobs.filter(reqOnJob);
    for (const job of byReq.slice(0, MAX_BOARD_CANDIDATES)) {
      if (verified()) return;
      const posting = await fetchJob(listing, job);
      if (posting) consider(posting, "ats_board", { confirmed, titleMatches: 1, location: job.location });
    }
    if (verified()) return;

    const titleMatches = role
      ? listing.jobs.filter((j) => strictTitleSimilarity(role!, j.title) >= HIGH_ROLE_SIMILARITY)
      : [];
    if (titleMatches.length === 0) {
      if (byReq.length === 0) notes.add(role || reqId ? "not_on_board" : "role_unknown");
      return;
    }
    if (titleMatches.length === 1) {
      const job = titleMatches[0]!;
      const posting = await fetchJob(listing, job);
      if (posting) consider(posting, "ats_board", { confirmed, titleMatches: 1, location: job.location });
      return;
    }

    const pick = tieBreakFromEmail(titleMatches);
    if (pick) {
      const posting = await fetchJob(listing, pick.job);
      if (posting) {
        consider(posting, "ats_board", { confirmed, titleMatches: 1, signals: [pick.signal], location: pick.job.location });
        if (verified()) return;
      }
    }

    const fetched: Array<{ job: BoardJob; posting: FetchedPosting }> = [];
    for (const job of titleMatches.slice(0, MAX_DUPLICATE_CHECK)) {
      const posting = await fetchJob(listing, job);
      if (posting) fetched.push({ job, posting });
    }
    const allSame =
      titleMatches.length <= MAX_DUPLICATE_CHECK &&
      fetched.length === titleMatches.length &&
      fetched.every((f) => textSimilarity(f.posting.text, fetched[0]!.posting.text) >= DUPLICATE_JD_SIMILARITY);
    if (allSame && fetched[0]) {
      consider(fetched[0].posting, "ats_board", {
        confirmed,
        titleMatches: 1,
        signals: [`duplicate_postings:${fetched.length}`],
        location: fetched[0].job.location,
      });
      return;
    }
    notes.add("multiple_title_matches");
    for (const f of fetched) {
      consider(f.posting, "ats_board", { confirmed, titleMatches: titleMatches.length, location: f.job.location });
    }
  };

  const boardQuery = (ref: BoardRef) => (ref.ats === "workday" ? (reqId ?? role ?? undefined) : (role ?? undefined));

  const listAndSearch = async (ref: BoardRef, confirm: (l: BoardListing) => boolean) => {
    if (triedBoards.has(boardKey(ref))) return;
    triedBoards.add(boardKey(ref));
    try {
      let listing = await listBoard(ref, boardQuery(ref));
      if (ref.ats === "workday" && reqId && role && listing && listing.jobs.length === 0) {
        listing = await listBoard(ref, role);
      }
      if (!listing) return;
      const confirmed = confirm(listing);
      if (confirmed) await atsBoardsRepository.put(normalizeCompany(app.company), [ref]).catch(() => undefined);
      await searchBoard(listing, confirmed);
    } catch (error) {
      attempts.push({ url: `board:${boardKey(ref)}`, source: "ats_board", ok: false, reason: describeError(error) });
    }
  };

  // 1. The email itself: inline JD, then posting links (LinkedIn via the guest endpoint).
  if (evidence.inlineJd) {
    consider({ url: "", source: "generic", text: evidence.inlineJd.text }, "email_body");
  }
  for (const link of evidence.jobLinks.slice(0, MAX_EMAIL_LINKS)) {
    if (verified()) break;
    await tryUrl(link.url, "email_link");
  }
  if (emailLinkErrors > 0 && emailLinkOk === 0) notes.add("email_links_failed");

  // 2. Boards named by the application's own emails.
  stage = "email_board";
  for (const ref of hints.boards) {
    if (verified()) break;
    await listAndSearch(ref, () => true);
  }

  // 3. Guessed slugs on the free ATS APIs (cached per company).
  if (!verified() && boardsFound === 0) {
    stage = "guessed_board";
    {
      const listings = await discoverBoards({
        company: app.company,
        query: role ?? reqId,
        senderRoots: hints.senderRoots,
        preferAts: hints.atsOnly,
      }).catch(() => [] as BoardListing[]);
      for (const listing of listings) {
        if (verified()) break;
        if (triedBoards.has(boardKey(listing.ref))) continue;
        await searchBoard(listing, true);
      }
    }
    if (boardsFound === 0) notes.add("no_board_found");
  }

  // 4. Serper, only when no company board was found (unknown ATS); hits feed the board search.
  if (!verified() && confirmedBoards > 0) notes.add("board_found_no_search");
  if (!verified() && confirmedBoards === 0) {
    const queries = buildSerperQueries(app.company, role, reqId);
    if (!serperClient.isConfigured()) notes.add("serper_not_configured");
    else if (queries.length === 0) notes.add("no_search_terms");
    else if (usage.queries + queries.length > usage.cap) notes.add("serper_cap_reached");
    else {
      if (!usage.jobKeys.includes(app.key)) usage.jobKeys.push(app.key);
      let anyResults = false;
      for (const query of queries) {
        if (verified()) break;
        serperQueries += 1;
        let results: SerperResult[] = [];
        try {
          results = await serperClient.search(query);
        } catch (error) {
          attempts.push({ url: `serper:${query}`, source: "serper", ok: false, reason: describeError(error) });
          continue;
        }
        const urls = rankSerperResults(results).slice(0, MAX_SERPER_CANDIDATES);
        if (urls.length) anyResults = true;
        for (const url of urls) {
          if (verified()) break;
          const hint = boardFromUrl(url);
          if (hint?.slug) {
            stage = "serper_board";
            await listAndSearch(hint as BoardRef, (l) =>
              boardConfirmsCompany(l, app.company, { senderRoots: hints.senderRoots }),
            );
          }
          stage = "serper";
          if (!verified()) await tryUrl(url, "serper");
        }
      }
      usage.queries += serperQueries;
      await serperUsageRepository.record(app.key, serperQueries);
      if (!anyResults) notes.add("serper_no_results");
    }
  }

  const sortedNotes = sortNotes(notes);
  const now = new Date().toISOString();
  const base: ApplicationEvaluation = {
    key: app.key,
    company: app.company,
    role: app.role,
    appliedAt: app.appliedAt,
    requisitionId: reqId,
    recoveryVersion: RECOVERY_VERSION,
    recovery: {
      status: "not_found",
      attempts,
      serperQueries,
      notes: sortedNotes,
      verifiedBy: "auto",
      recoveredRole,
      candidates: mergeStoredCandidates(candidates, existing),
      boardChecks: boardChecks.length ? boardChecks : undefined,
    },
    outcome: buildOutcome(app),
    createdAt: now,
    updatedAt: now,
  };

  const chosen = best as Candidate | undefined;
  if (!chosen) {
    const failedOnly = fetchErrors > 0 && !notes.has("serper_cap_reached");
    const hasMcp = (base.recovery.candidates ?? []).some((c) => c.source === "mcp");
    base.recovery.status = hasMcp ? "unverified" : failedOnly ? "fetch_failed" : "not_found";
    base.recovery.reason =
      sortedNotes[0] ?? (evidence.jobLinks.length || evidence.inlineJd ? "no_usable_posting" : "no_email_evidence");
    return { evaluation: base, triaged: false };
  }

  base.recovery.source = chosen.source;
  base.recovery.foundVia = chosen.stage;
  base.recovery.url = chosen.posting.url || undefined;
  base.recovery.match = { level: chosen.match.level, signals: chosen.match.signals };
  base.jd = {
    text: chosen.posting.text,
    textHash: computeJdTextHash(chosen.posting.text),
    title: chosen.posting.title,
    company: chosen.posting.company,
    datePosted: chosen.posting.datePosted,
  };

  if (!isScoreable(chosen.match.level)) {
    base.recovery.status = "unverified";
    base.recovery.reason = sortedNotes[0];
    return { evaluation: base, triaged: false };
  }
  base.recovery.notes = [];
  base.recovery.candidates = undefined;
  base.recovery.boardChecks = undefined;

  try {
    const job = await scoreBlind(chosen.posting, app.company, app.key);
    base.recovery.status = "scored";
    base.fit = fitFromJob(job);
    base.outcomeAtScoring = app.status;
  } catch (error) {
    base.recovery.status = "fetch_failed";
    base.recovery.reason = `triage_failed: ${describeError(error)}`;
  }
  return { evaluation: base, triaged: true };
};

export class EvaluationNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EvaluationNotFoundError";
  }
}

export class AlreadyScoredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AlreadyScoredError";
  }
}

export class IncompleteJdError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IncompleteJdError";
  }
}

export const MIN_PASTED_JD_CHARS = 300;

/** Score a posting the user picked or pasted. Still blind: only the JD text and company go to the scorer. */
const scoreUserPosting = async (
  evaluation: ApplicationEvaluation,
  posting: {
    text: string;
    url?: string;
    title?: string;
    company?: string;
    matchLevel: MatchLevel;
    stage: RecoveryStage;
  },
  signal: "user_picked_candidate" | "user_pasted_jd" | "prospect_auto_attached",
): Promise<ApplicationEvaluation> => {
  if (evaluation.recovery.status === "scored") {
    throw new AlreadyScoredError(`${evaluation.key} is already scored; scores are final`);
  }
  const job = await scoreBlind(posting, evaluation.company, evaluation.key);
  const now = new Date().toISOString();
  const title =
    [posting.title, job.extracted?.title]
      .map((t) => t?.trim())
      .find((t) => t && !isWeakJobTitle(t)) ?? undefined;
  const updated: ApplicationEvaluation = {
    ...evaluation,
    role: evaluation.role ?? title ?? null,
    recovery: {
      ...evaluation.recovery,
      status: "scored",
      reason: undefined,
      notes: [],
      source: "manual",
      foundVia: posting.stage,
      url: posting.url,
      verifiedBy: "user",
      match: { level: posting.matchLevel, signals: [signal] },
      candidates: undefined,
    },
    jd: {
      text: posting.text,
      textHash: computeJdTextHash(posting.text),
      title,
      company: posting.company ?? job.extracted?.company,
    },
    fit: fitFromJob(job),
    outcomeAtScoring: evaluation.outcome.status,
    updatedAt: now,
  };
  const written = await evaluationsRepository.upsertIfUnscored(updated);
  if (written.recovery.status === "scored" && written.fit?.scoredAt !== updated.fit?.scoredAt) {
    return written;
  }
  await addMissingApplicationsQuietly();
  return written;
};

export const confirmCandidate = async (key: string, identifier: string): Promise<ApplicationEvaluation> => {
  const evaluation = await evaluationsRepository.findByKey(key);
  if (!evaluation) throw new EvaluationNotFoundError(`No evaluation for ${key}`);
  const candidate = evaluation.recovery.candidates?.find(
    (c) => c.url === identifier || c.prospectId === identifier,
  );
  if (!candidate) throw new EvaluationNotFoundError(`No candidate ${identifier} for ${key}`);
  if (candidate.completeness === "partial") {
    throw new IncompleteJdError(`Candidate ${identifier} is a partial JD and is not eligible to score`);
  }
  const scored = await scoreUserPosting(
    evaluation,
    {
      text: candidate.text,
      url: candidate.url,
      title: candidate.title,
      company: candidate.company,
      matchLevel: "high",
      stage: candidate.stage ?? inferCandidateStage(evaluation, candidate),
    },
    "user_picked_candidate",
  );
  if (candidate.prospectId) await jobProspectsRepository.markAttached(candidate.prospectId, key);
  return scored;
};

export const scorePastedJd = async (key: string, text: string, url?: string): Promise<ApplicationEvaluation> => {
  const evaluation = await evaluationsRepository.findByKey(key);
  if (!evaluation) throw new EvaluationNotFoundError(`No evaluation for ${key}`);
  return scoreUserPosting(
    evaluation,
    { text: text.trim(), url, matchLevel: "high", stage: "manual" },
    "user_pasted_jd",
  );
};

export class InvalidTitleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidTitleError";
  }
}

/** Change the displayed role title without touching the frozen score. */
export const updateApplicationTitle = async (key: string, title: string): Promise<ApplicationEvaluation> => {
  const evaluation = await evaluationsRepository.findByKey(key);
  if (!evaluation) throw new EvaluationNotFoundError(`No evaluation for ${key}`);
  const next = title.trim();
  if (next.length < 2) throw new InvalidTitleError("Title is too short");
  const now = new Date().toISOString();
  const fit = evaluation.fit;
  const updated: ApplicationEvaluation = {
    ...evaluation,
    role: next,
    jd: evaluation.jd ? { ...evaluation.jd, title: next } : evaluation.jd,
    fit:
      fit?.detail
        ? { ...fit, detail: { ...fit.detail, extracted: { ...fit.detail.extracted, title: next } } }
        : fit,
    updatedAt: now,
  };
  await evaluationsRepository.upsert(updated);
  return updated;
};

/** Pull a title from pasted JD text. Does not re-score or replace the stored JD. */
export const updateApplicationTitleFromJdText = async (key: string, text: string): Promise<ApplicationEvaluation> => {
  const title = extractJobPostingMetadata(text).jobTitle?.trim();
  if (!title || isWeakJobTitle(title)) {
    throw new InvalidTitleError("Couldn't find a job title in that paste. Type the title instead.");
  }
  return updateApplicationTitle(key, title);
};

/** Keep stored outcomes in step with Gmail; never re-scores. */
export const refreshOutcomes = async (
  apps: GmailApplication[],
  existing: Map<string, ApplicationEvaluation>,
): Promise<number> => {
  let updated = 0;
  for (const app of apps) {
    const evaluation = existing.get(app.key);
    if (!evaluation) continue;
    const outcome = buildOutcome(app);
    if (
      evaluation.outcome.status === outcome.status &&
      evaluation.outcome.updatedAt === outcome.updatedAt &&
      evaluation.outcome.furthestStage === outcome.furthestStage &&
      evaluation.outcome.furthestRound?.label === outcome.furthestRound?.label
    ) {
      continue;
    }
    await evaluationsRepository.updateOutcome(app.key, outcome);
    evaluation.outcome = outcome;
    updated += 1;
  }
  return updated;
};

const companyKeyOf = (key: string) => key.split("::")[0] ?? key;

const ROLE_CARRY_OVER_SIMILARITY = 0.6;

const sameApplication = (app: GmailApplication, e: ApplicationEvaluation): boolean =>
  !app.role ||
  !e.role ||
  e.appliedAt === app.appliedAt ||
  roleSimilarity(app.role, e.role) >= ROLE_CARRY_OVER_SIMILARITY;

/**
 * Application keys are company + role words, so they shift when a later email adds or rewords the
 * role. Move the old evaluation to the new key instead of recovering (and re-scoring) from scratch.
 */
export const adoptRekeyedEvaluations = async (
  apps: GmailApplication[],
  existing: Map<string, ApplicationEvaluation>,
): Promise<number> => {
  const missing = apps.filter((a) => !existing.has(a.key));
  if (missing.length === 0) return 0;
  const liveKeys = new Set(apps.map((a) => a.key));
  const orphans = (
    await evaluationsRepository.findByCompanyKeys([...new Set(missing.map((a) => companyKeyOf(a.key)))])
  ).filter((e) => !liveKeys.has(e.key));
  const rank = (e: ApplicationEvaluation) => (e.recovery.status === "scored" ? 0 : 1);
  orphans.sort((a, b) => rank(a) - rank(b));

  let moved = 0;
  for (const app of missing) {
    const idx = orphans.findIndex((e) => companyKeyOf(e.key) === companyKeyOf(app.key) && sameApplication(app, e));
    if (idx < 0) continue;
    const [orphan] = orphans.splice(idx, 1);
    const adopted: ApplicationEvaluation = {
      ...orphan!,
      key: app.key,
      role: app.role,
      appliedAt: app.appliedAt,
      outcome: buildOutcome(app),
      updatedAt: new Date().toISOString(),
    };
    await evaluationsRepository.rekey(orphan!.key, adopted);
    existing.set(app.key, adopted);
    moved += 1;
  }
  if (moved) logger.info("Carried evaluations over to re-keyed applications", { moved });
  return moved;
};

/** Stored evaluations for these applications, with re-keyed rows adopted and outcomes refreshed. */
export const loadEvaluations = async (apps: GmailApplication[]): Promise<Map<string, ApplicationEvaluation>> => {
  const existing = await evaluationsRepository.findByKeys(apps.map((a) => a.key));
  await adoptRekeyedEvaluations(apps, existing);
  await refreshOutcomes(apps, existing);
  return existing;
};

export type RecoveryRunState = {
  running: boolean;
  startedAt?: string;
  finishedAt?: string;
  processed: number;
  scored: number;
  error?: string;
  /** Company-scoped or unscoped runs requested while `running` was true, not yet started. */
  deferred: number;
};

/** Optional filter. Gmail/API full recovery omits this; prospect saves pass the company key. */
export type RecoveryRunOptions = { companyKey?: string };

const state: RecoveryRunState = { running: false, processed: 0, scored: 0, deferred: 0 };

const deferredByCompany = new Map<string, number>();
let deferredUnscopedDays: number | null = null;

const normalizeScopeKey = (companyKey?: string): string | undefined => {
  const key = companyKey?.trim();
  return key || undefined;
};

const applicationsInScope = (apps: GmailApplication[], companyKey?: string): GmailApplication[] => {
  const key = normalizeScopeKey(companyKey);
  return key ? apps.filter((app) => normalizeCompany(app.company) === key) : apps;
};

const prospectsInScope = (prospects: JobProspect[], companyKey?: string): JobProspect[] => {
  const key = normalizeScopeKey(companyKey);
  return key ? prospects.filter((prospect) => prospect.companyKey === key) : prospects;
};

const deferredCount = (): number => (deferredUnscopedDays != null ? 1 : 0) + deferredByCompany.size;

const rememberDeferred = (days: number, companyKey?: string): void => {
  const key = normalizeScopeKey(companyKey);
  if (!key) {
    deferredUnscopedDays = Math.max(deferredUnscopedDays ?? 0, days);
    deferredByCompany.clear();
    return;
  }
  if (deferredUnscopedDays != null && deferredUnscopedDays >= days) return;
  deferredByCompany.set(key, Math.max(deferredByCompany.get(key) ?? 0, days));
};

const takeDeferred = (): { days: number; companyKey?: string } | undefined => {
  if (deferredUnscopedDays != null) {
    const days = deferredUnscopedDays;
    deferredUnscopedDays = null;
    deferredByCompany.clear();
    return { days };
  }
  const next = deferredByCompany.entries().next();
  if (next.done) return undefined;
  deferredByCompany.delete(next.value[0]);
  return { days: next.value[1], companyKey: next.value[0] };
};

const syncDeferredCount = (): void => {
  state.deferred = deferredCount();
};

export const getRecoveryRunState = (): RecoveryRunState => ({ ...state, deferred: deferredCount() });

/** Test-only: drop in-flight flags so unit tests do not leak a run into the next case. */
export const resetRecoveryRunStateForTests = (): void => {
  Object.assign(state, {
    running: false,
    startedAt: undefined,
    finishedAt: undefined,
    processed: 0,
    scored: 0,
    error: undefined,
    deferred: 0,
  });
  deferredByCompany.clear();
  deferredUnscopedDays = null;
};

const newestFirst = (apps: GmailApplication[]) => [...apps].sort((a, b) => b.appliedAt.localeCompare(a.appliedAt));

export const pendingApplications = (
  apps: GmailApplication[],
  existing: Map<string, ApplicationEvaluation>,
  serperBudgetLeft = true,
  openProspects: JobProspect[] = [],
): GmailApplication[] => {
  const now = Date.now();
  const prospectsByCompany = new Map<string, JobProspect[]>();
  for (const prospect of openProspects) {
    const list = prospectsByCompany.get(prospect.companyKey) ?? [];
    list.push(prospect);
    prospectsByCompany.set(prospect.companyKey, list);
  }
  const appsByCompany = new Map<string, GmailApplication[]>();
  for (const app of apps) {
    const key = normalizeCompany(app.company);
    const list = appsByCompany.get(key) ?? [];
    list.push(app);
    appsByCompany.set(key, list);
  }
  return newestFirst(apps).filter((a) => {
    const evaluation = existing.get(a.key);
    if (evaluation?.recovery.status === "scored") return false;
    const companyKey = normalizeCompany(a.company);
    const companyProspects = prospectsByCompany.get(companyKey) ?? [];
    if (companyProspects.length > 0) {
      const match = matchProspectsToApplication({
        app: a,
        prospects: companyProspects,
        companyApps: appsByCompany.get(companyKey),
        requisitionId: a.role ? extractRequisitionId(a.role, "") : undefined,
      });
      if (match.decision !== "none") return true;
    }
    return needsRecovery(evaluation, now, serperBudgetLeft);
  });
};

/** Room for at least one more job's worth of Serper queries. */
const hasSerperBudget = (usage: SerperUsage) => usage.queries + MAX_SERPER_QUERIES_PER_JOB <= usage.cap;

/** One pass over the window, newest applications first. `companyKey` limits the worker, not just the count. */
export const runRecovery = async (
  days: number,
  maxPerRun = env.jdRecoveryMaxPerRun,
  opts?: RecoveryRunOptions,
): Promise<{ processed: number; scored: number }> => {
  const companyKey = normalizeScopeKey(opts?.companyKey);
  const apps = applicationsInScope(await getGmailApplications(days), companyKey);
  const existing = await loadEvaluations(apps);
  const usage = await serperUsageRepository.get();
  const openProspects = prospectsInScope(await jobProspectsRepository.findOpen(), companyKey);
  const todo = pendingApplications(apps, existing, hasSerperBudget(usage), openProspects).slice(
    0,
    maxPerRun * MAX_PROCESSED_PER_RUN_FACTOR,
  );

  let processed = 0;
  let triaged = 0;
  let scored = 0;
  for (const app of todo) {
    if (triaged >= maxPerRun) break;
    const result = await recoverApplication(app, usage);
    await evaluationsRepository.upsertIfUnscored(result.evaluation);
    processed += 1;
    if (result.triaged) triaged += 1;
    if (result.evaluation.recovery.status === "scored") scored += 1;
    state.processed = processed;
    state.scored = scored;
  }
  if (scored > 0) await addMissingApplicationsQuietly();
  return { processed, scored };
};

const drainDeferred = (): void => {
  if (state.running) return;
  const next = takeDeferred();
  syncDeferredCount();
  if (!next) return;
  void startRecoveryRun(next.days, next.companyKey ? { companyKey: next.companyKey } : undefined).then((result) => {
    if (!result.started) drainDeferred();
  });
};

/** Start a background run unless one is active. A busy process remembers the request and runs it next. */
export const startRecoveryRun = async (
  days: number,
  opts?: RecoveryRunOptions,
): Promise<{ queued: number; running: boolean; started: boolean }> => {
  const companyKey = normalizeScopeKey(opts?.companyKey);
  const apps = applicationsInScope(await getGmailApplications(days), companyKey);
  const existing = await loadEvaluations(apps);
  const usage = await serperUsageRepository.get();
  const openProspects = prospectsInScope(await jobProspectsRepository.findOpen(), companyKey);
  const queued = pendingApplications(apps, existing, hasSerperBudget(usage), openProspects).length;
  if (state.running) {
    rememberDeferred(days, companyKey);
    syncDeferredCount();
    return { queued, running: true, started: false };
  }
  if (queued === 0) return { queued, running: false, started: false };

  Object.assign(state, {
    running: true,
    startedAt: new Date().toISOString(),
    finishedAt: undefined,
    processed: 0,
    scored: 0,
    error: undefined,
    deferred: deferredCount(),
  });
  void runRecovery(days, env.jdRecoveryMaxPerRun, companyKey ? { companyKey } : undefined)
    .then((r) => logger.info("JD recovery run complete", { days, companyKey, ...r }))
    .catch((error) => {
      state.error = error instanceof Error ? error.message : String(error);
      logger.error("JD recovery run failed", { message: state.error, companyKey });
    })
    .finally(() => {
      state.running = false;
      state.finishedAt = new Date().toISOString();
      drainDeferred();
    });
  return { queued, running: true, started: true };
};
