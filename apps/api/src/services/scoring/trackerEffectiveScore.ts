import { effectiveScoreProvenance, presentFitForDisplay } from "../../lib/authoritativeScore.js";
import type { JobRecord } from "../../types/job.js";
import type { Recommendation } from "../../types/scoring.js";
import { evaluationsRepository, type ApplicationEvaluation } from "../gmail/jdRecovery/evaluations.repository.js";
import type { ApprovedRevisionOverlay } from "./scoreRevision.types.js";
import { loadApprovedOverlays } from "./scoreRevisions.service.js";

/** Presentation-only overlay. Never written back onto `jobs.score`. */
export type JobEffectiveScore = {
  total: number;
  recommendation: Recommendation | string;
  storedTrackerTotal: number;
  applicationKey: string;
  scoreRevised?: boolean;
  fingerprintStale?: boolean;
  revisionId?: string;
  staleRevisionTotal?: number;
  originalAuthoritativeTotal?: number;
  authoritativeSource?: string;
};

const overlayOne = (
  job: JobRecord,
  evaluation: ApplicationEvaluation | undefined,
  revisions: Map<string, ApprovedRevisionOverlay>,
): JobRecord => {
  if (!evaluation?.fit) {
    // Unlinked: original score only. Drop any stale overlay that may have been persisted.
    if (!job.effectiveScore) return job;
    const { effectiveScore: _stale, ...unlinked } = job;
    return unlinked;
  }
  const presented = presentFitForDisplay(evaluation.fit, {
    revision: revisions.get(evaluation.key),
    evaluation,
  });
  const effectiveScore: JobEffectiveScore = {
    total: presented.total,
    recommendation: presented.recommendation,
    storedTrackerTotal: job.score.total,
    applicationKey: evaluation.key,
    ...effectiveScoreProvenance(presented),
    ...(presented.fingerprintStale
      ? { fingerprintStale: true, revisionId: presented.revisionId, staleRevisionTotal: presented.staleRevisionTotal }
      : {}),
  };
  return { ...job, effectiveScore };
};

/**
 * Resolve Gmail effective scores onto tracker jobs at read time.
 * Falls back to `jobs.score.total` when no linked evaluation exists.
 */
export const overlayJobsWithEffectiveScores = async (jobs: JobRecord[]): Promise<JobRecord[]> => {
  if (jobs.length === 0) return jobs;
  const byTrackerId = await evaluationsRepository.findByTrackerJobIds(jobs.map((job) => job.id));
  const gmailKeys = jobs.map((job) => job.tracker?.gmailKey).filter((key): key is string => Boolean(key));
  const byGmailKey = await evaluationsRepository.findByKeys(gmailKeys);
  const evaluations = new Map<string, ApplicationEvaluation>();
  for (const job of jobs) {
    const linked = byTrackerId.get(job.id) ?? (job.tracker?.gmailKey ? byGmailKey.get(job.tracker.gmailKey) : undefined);
    if (linked) evaluations.set(job.id, linked);
  }
  const revisions = await loadApprovedOverlays([...evaluations.values()].map((evaluation) => evaluation.key));
  return jobs.map((job) => overlayOne(job, evaluations.get(job.id), revisions));
};

export const overlayJobWithEffectiveScore = async (job: JobRecord | null): Promise<JobRecord | null> => {
  if (!job) return null;
  const [presented] = await overlayJobsWithEffectiveScores([job]);
  return presented ?? job;
};
