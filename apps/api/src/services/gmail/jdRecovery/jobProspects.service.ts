import { randomUUID } from "node:crypto";
import { computeJdTextHash } from "../../../lib/jdTextHash.js";
import { logger } from "../../../lib/logger.js";
import { normalizeSourceUrl } from "../../../lib/normalizeSourceUrl.js";
import { getGmailApplications, normalizeCompany, type GmailApplication } from "../gmailApplications.js";
import { cleanProspectJd } from "./cleanProspectJd.js";
import { evaluationsRepository, type ApplicationEvaluation } from "./evaluations.repository.js";
import {
  jobProspectsRepository,
  prospectFields,
  type JobProspect,
} from "./jobProspects.repository.js";
import {
  isDuplicateOf,
  isSpecificJobUrl,
  matchProspectsToApplication,
  PROSPECT_MATCH_LOOKBACK_DAYS,
} from "./prospectMatch.js";
import { startRecoveryRun } from "./runRecovery.js";

export type SaveJobProspectInput = {
  rawText: string;
  company: string;
  title: string;
  location?: string;
  seniority?: string;
  requisitionId?: string;
  sourceUrl?: string;
  salary?: string;
};

export const PROSPECT_MATCH_STATUSES = [
  "awaiting_gmail_application",
  "queued_for_scoring",
  "pending_review",
  "scored",
  "unmatched",
] as const;

export type ProspectMatchStatus = (typeof PROSPECT_MATCH_STATUSES)[number];

export type ProspectLinkage = {
  matchStatus: ProspectMatchStatus;
  matchReason: string;
  applicationKey?: string;
  evaluationStatus?: ApplicationEvaluation["recovery"]["status"] | "none";
  fitTotal?: number;
};

export type SaveJobProspectResult = {
  id: string;
  company: string;
  title: string;
  location?: string;
  seniority?: string;
  requisitionId?: string;
  sourceUrl?: string;
  duplicate: boolean;
  status: JobProspect["status"];
  attachedKey?: string;
  recoveryQueued: boolean;
  recoveryStarted?: boolean;
  recoveryRunning?: boolean;
  matchStatus: ProspectMatchStatus;
  matchReason: string;
  applicationKey?: string;
  evaluationStatus?: ApplicationEvaluation["recovery"]["status"] | "none";
  fitTotal?: number;
  note: string;
  rawChars: number;
  cleanedChars: number;
};

const blankToUndefined = (value: string | undefined): string | undefined => {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
};

export const persistJobProspect = async (input: SaveJobProspectInput): Promise<{ prospect: JobProspect; duplicate: boolean }> => {
  const company = input.company.trim();
  const title = input.title.trim();
  const companyKey = normalizeCompany(company);
  if (!companyKey) {
    throw new Error("Company is empty after normalization");
  }
  const rawText = input.rawText.replace(/\r\n/g, "\n").trim();
  const cleanedText = cleanProspectJd(rawText) || rawText;
  const cleanedTextHash = computeJdTextHash(cleanedText);
  const requisitionId = blankToUndefined(input.requisitionId);
  const sourceUrl = blankToUndefined(input.sourceUrl);
  const normalizedSourceUrl = sourceUrl && isSpecificJobUrl(sourceUrl) ? normalizeSourceUrl(sourceUrl) : undefined;
  const incoming = { title, cleanedTextHash, requisitionId, normalizedSourceUrl, sourceUrl };

  const existing = (await jobProspectsRepository.findByCompanyKey(companyKey)).find((row) => isDuplicateOf(incoming, row));
  if (existing) {
    return { prospect: existing, duplicate: true };
  }

  const now = new Date().toISOString();
  const prospect: JobProspect = {
    id: randomUUID(),
    company,
    companyKey,
    title,
    ...prospectFields({
      location: blankToUndefined(input.location),
      seniority: blankToUndefined(input.seniority),
      requisitionId,
      sourceUrl,
      normalizedSourceUrl,
      salary: blankToUndefined(input.salary),
    }),
    rawText,
    cleanedText,
    cleanedTextHash,
    status: "open",
    createdAt: now,
    updatedAt: now,
  };
  await jobProspectsRepository.insert(prospect);
  return { prospect, duplicate: false };
};

const linkageNote = (input: {
  duplicate: boolean;
  matchStatus: ProspectMatchStatus;
  matchReason: string;
  applicationKey?: string;
  fitTotal?: number;
}): string => {
  const prefix = input.duplicate ? "Already saved. " : "Saved. ";
  if (input.matchStatus === "awaiting_gmail_application") {
    return `${prefix}No Gmail application for this company is in the local lookback window yet. It will match after the confirmation email is synced.`;
  }
  if (input.matchStatus === "scored") {
    const fit = input.fitTotal != null ? ` Fit ${Math.round(input.fitTotal)}.` : "";
    return `${prefix}Matched to ${input.applicationKey} and already scored.${fit} The dashboard shows the stored evaluation.`;
  }
  if (input.matchStatus === "queued_for_scoring") {
    return `${prefix}Uniquely matched to ${input.applicationKey}. Scoring runs in the background; refresh or wait for the dashboard to show the fit. Not scored yet.`;
  }
  if (input.matchStatus === "pending_review") {
    return `${prefix}Not auto-matched (${input.matchReason}). Confirm the JD in the dashboard Review panel. Not scored.`;
  }
  return `${prefix}A Gmail application exists at this company but the title was not a confident unique match (${input.matchReason}). Confirm in the dashboard.`;
};

/** Read-only: where this prospect stands against current Gmail applications and evaluations. */
export const describeProspectLinkage = (
  prospect: JobProspect,
  companyApps: GmailApplication[],
  evaluations: Map<string, ApplicationEvaluation>,
): ProspectLinkage => {
  if (prospect.attachedKey) {
    const evaluation = evaluations.get(prospect.attachedKey);
    if (evaluation?.recovery.status === "scored") {
      return {
        matchStatus: "scored",
        matchReason: "already_attached",
        applicationKey: prospect.attachedKey,
        evaluationStatus: "scored",
        fitTotal: evaluation.fit?.total,
      };
    }
    if (evaluation && (evaluation.recovery.candidates?.length ?? 0) > 0 && evaluation.recovery.status !== "scored") {
      return {
        matchStatus: "pending_review",
        matchReason: "candidate_pending_review",
        applicationKey: prospect.attachedKey,
        evaluationStatus: evaluation.recovery.status,
      };
    }
  }
  if (companyApps.length === 0) {
    return { matchStatus: "awaiting_gmail_application", matchReason: "no_gmail_application", evaluationStatus: "none" };
  }

  const ranked = companyApps.map((app) => ({
    app,
    match: matchProspectsToApplication({
      app,
      prospects: [{ ...prospect, status: "open" }],
      companyApps,
    }),
  }));
  const autos = ranked.filter((row) => row.match.decision === "auto");
  const reviews = ranked.filter((row) => row.match.decision === "review");

  if (autos.length === 1) {
    const app = autos[0]!.app;
    const evaluation = evaluations.get(app.key);
    if (evaluation?.recovery.status === "scored") {
      return {
        matchStatus: "scored",
        matchReason: autos[0]!.match.reason,
        applicationKey: app.key,
        evaluationStatus: "scored",
        fitTotal: evaluation.fit?.total,
      };
    }
    if (evaluation && (evaluation.recovery.candidates?.length ?? 0) > 0) {
      return {
        matchStatus: "pending_review",
        matchReason: "candidate_pending_review",
        applicationKey: app.key,
        evaluationStatus: evaluation.recovery.status,
      };
    }
    return {
      matchStatus: "queued_for_scoring",
      matchReason: autos[0]!.match.reason,
      applicationKey: app.key,
      evaluationStatus: evaluation?.recovery.status ?? "none",
    };
  }
  if (autos.length > 1) {
    return { matchStatus: "pending_review", matchReason: "multiple_applications", evaluationStatus: "none" };
  }
  if (reviews.length > 0) {
    return {
      matchStatus: "pending_review",
      matchReason: reviews[0]!.match.reason,
      applicationKey: reviews.length === 1 ? reviews[0]!.app.key : undefined,
      evaluationStatus: "none",
    };
  }
  return {
    matchStatus: "unmatched",
    matchReason: ranked[0]?.match.reason ?? "role_mismatch",
    evaluationStatus: "none",
  };
};

const loadCompanyLinkage = async (prospect: JobProspect): Promise<ProspectLinkage> => {
  try {
    const apps = (await getGmailApplications(PROSPECT_MATCH_LOOKBACK_DAYS)).filter(
      (app) => normalizeCompany(app.company) === prospect.companyKey,
    );
    const evaluations = await evaluationsRepository.findByKeys(apps.map((app) => app.key));
    return describeProspectLinkage(prospect, apps, evaluations);
  } catch (error) {
    logger.warn("Prospect linkage lookup failed", {
      prospectId: prospect.id,
      message: error instanceof Error ? error.message : String(error),
    });
    return { matchStatus: "awaiting_gmail_application", matchReason: "linkage_lookup_failed", evaluationStatus: "none" };
  }
};

/** Persist only. Does not score, write the tracker, or create an application. */
export const saveJobProspect = async (input: SaveJobProspectInput): Promise<SaveJobProspectResult> => {
  const persisted = await persistJobProspect(input);
  let prospect = persisted.prospect;
  const duplicate = persisted.duplicate;
  let linkage = await loadCompanyLinkage(prospect);

  if (linkage.matchStatus === "scored" && linkage.applicationKey && prospect.status === "open") {
    const attached = await jobProspectsRepository.markAttached(prospect.id, linkage.applicationKey);
    if (attached) prospect = attached;
  }

  let recoveryQueued = false;
  let recoveryStarted = false;
  let recoveryRunning = false;
  if (prospect.status === "open") {
    try {
      const started = await startRecoveryRun(PROSPECT_MATCH_LOOKBACK_DAYS, { companyKey: prospect.companyKey });
      recoveryQueued = started.started || started.running;
      recoveryStarted = started.started;
      recoveryRunning = started.running;
    } catch (error) {
      logger.warn("Prospect saved but recovery enqueue failed", {
        prospectId: prospect.id,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
  if (prospect.status === "attached" && prospect.attachedKey) {
    linkage = { ...linkage, applicationKey: prospect.attachedKey };
  }
  logger.info("Job prospect saved", {
    prospectId: prospect.id,
    duplicate,
    companyKey: prospect.companyKey,
    matchStatus: linkage.matchStatus,
    applicationKey: linkage.applicationKey,
    recoveryQueued,
  });
  return {
    id: prospect.id,
    company: prospect.company,
    title: prospect.title,
    location: prospect.location,
    seniority: prospect.seniority,
    requisitionId: prospect.requisitionId,
    sourceUrl: prospect.sourceUrl,
    duplicate,
    status: prospect.status,
    attachedKey: prospect.attachedKey,
    recoveryQueued,
    recoveryStarted,
    recoveryRunning,
    matchStatus: linkage.matchStatus,
    matchReason: linkage.matchReason,
    applicationKey: linkage.applicationKey,
    evaluationStatus: linkage.evaluationStatus,
    fitTotal: linkage.fitTotal,
    note: linkageNote({
      duplicate,
      matchStatus: linkage.matchStatus,
      matchReason: linkage.matchReason,
      applicationKey: linkage.applicationKey,
      fitTotal: linkage.fitTotal,
    }),
    rawChars: prospect.rawText.length,
    cleanedChars: prospect.cleanedText.length,
  };
};
