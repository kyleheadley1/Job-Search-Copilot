import { logger } from "../../lib/logger.js";
import { autoLapseNote, shouldAutoLapse } from "../agent/candidates.js";
import { suggestionsRepository } from "../agent/suggestions.repository.js";
import { jobsRepository } from "../jobs/jobs.repository.js";
import { getGmailApplications, type GmailApplication } from "./gmailApplications.js";

/** Long enough to cover 30-day silence plus the emails behind it. */
export const AUTO_LAPSE_LOOKBACK_DAYS = 120;

const DAY_MS = 86_400_000;
const silentDays = (iso: string, now: number) => Math.floor((now - Date.parse(iso)) / DAY_MS);

export type TrackerAutoLapseDeps = {
  loadApplications: () => Promise<GmailApplication[]>;
  updateStatus: (jobId: string, status: "lapsed" | NonNullable<GmailApplication["suggestedStatus"]>, note: string) => Promise<unknown>;
  expireGhostedCards: (nowIso: string) => Promise<number>;
};

const defaultDeps: TrackerAutoLapseDeps = {
  loadApplications: () => getGmailApplications(AUTO_LAPSE_LOOKBACK_DAYS),
  updateStatus: (jobId, status, note) => jobsRepository.updateStatus(jobId, status, note),
  expireGhostedCards: (nowIso) => suggestionsRepository.expireOpenKind("mark_ghosted", nowIso),
};

const gmailNote = (app: GmailApplication): string =>
  `From Gmail: ${app.emails[0]?.subject ?? app.status}`;

/**
 * Lapse silent open tracker rows (no Next steps card) and revive a lapsed row when
 * a later email moves the process forward (interview, assessment, offer, rejection).
 */
export const applyAutomaticTrackerUpdates = async (
  apps: GmailApplication[],
  deps: Pick<TrackerAutoLapseDeps, "updateStatus"> = defaultDeps,
  now = Date.now(),
): Promise<{ lapsed: number; revived: number }> => {
  let lapsed = 0;
  let revived = 0;
  const seen = new Set<string>();
  for (const app of apps) {
    if (!app.trackerJobId || seen.has(app.trackerJobId)) continue;
    if (app.trackerStatus === "lapsed" && app.suggestedStatus) {
      seen.add(app.trackerJobId);
      await deps.updateStatus(app.trackerJobId, app.suggestedStatus, gmailNote(app));
      revived += 1;
      continue;
    }
    if (shouldAutoLapse(app, now)) {
      seen.add(app.trackerJobId);
      await deps.updateStatus(app.trackerJobId, "lapsed", autoLapseNote(silentDays(app.lastUpdateAt, now)));
      lapsed += 1;
    }
  }
  return { lapsed, revived };
};

export const syncTrackerFromGmail = async (
  deps: TrackerAutoLapseDeps = defaultDeps,
  now = new Date(),
): Promise<{ lapsed: number; revived: number; expiredCards: number }> => {
  const result = await applyAutomaticTrackerUpdates(await deps.loadApplications(), deps, now.getTime());
  const expiredCards = await deps.expireGhostedCards(now.toISOString());
  if (result.lapsed || result.revived || expiredCards) {
    logger.info("Auto-updated tracker from Gmail silence/progress", { ...result, expiredCards });
  }
  return { ...result, expiredCards };
};

export const syncTrackerFromGmailQuietly = async (): Promise<{ lapsed: number; revived: number }> => {
  try {
    return await syncTrackerFromGmail();
  } catch (error) {
    logger.warn("Tracker auto-lapse failed", {
      message: error instanceof Error ? error.message : String(error),
    });
    return { lapsed: 0, revived: 0 };
  }
};
