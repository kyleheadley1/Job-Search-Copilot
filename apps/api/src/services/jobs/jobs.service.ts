import { randomUUID } from "node:crypto";
import type { JobListFilters, JobRecord, JobStatus, RefreshShortlistResult } from "../../types/job.js";
import type { JobExportRow } from "../../tracker/canonicalSpreadsheet.js";
import { triageJob } from "../../agents/jobAgent/orchestrator.js";
import {
  AssetGenerationSkippedError,
  generateJobAssets,
} from "../../agents/jobAgent/assetGeneration.js";
import { userProfile } from "../../config/userProfile.js";
import { getTrackerColor } from "../../config/scoringPolicy.js";
import { compareShortlistJobs, evaluateShortlist, liveShortlistEligible } from "../../lib/shortlist.js";
import {
  autoArchiveNote,
  shouldAutoArchiveAppliedJob,
} from "../../lib/trackerAutoArchive.js";
import { buildJobExportRow, buildTrackerSpreadsheetFromJob } from "../../tracker/canonicalSpreadsheet.js";
import { jobsRepository } from "./jobs.repository.js";
import { capturesRepository } from "../captures/captures.repository.js";
import { resumeContextService } from "../resume/resumeContext.js";
import { toActiveResumeType } from "../../types/resume.js";
import { companyHintFromExtracted, preserveCompanyOnRetriage } from "../../lib/preserveCompanyOnRetriage.js";

export class JobNotFoundError extends Error {
  readonly code = "JOB_NOT_FOUND" as const;
  constructor() {
    super("Job not found");
    this.name = "JobNotFoundError";
  }
}

export class JobConfirmNotAllowedError extends Error {
  readonly code = "JOB_CONFIRM_NOT_ALLOWED" as const;
  constructor() {
    super("This scored role is not eligible for confirm-applied.");
    this.name = "JobConfirmNotAllowedError";
  }
}

export class JobNoJdSourceError extends Error {
  readonly code = "JOB_NO_JD_SOURCE" as const;
  constructor() {
    super("This role has no stored JD text or URL to re-triage.");
    this.name = "JobNoJdSourceError";
  }
}

/** Today's calendar date in the server's (your) timezone, as YYYY-MM-DD. */
const localDateKey = (d: Date): string =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

export function canConfirmApplied(job: Pick<JobRecord, "recommendation" | "score">): boolean {
  return true;
}

export class JobsService {
  /** Ephemeral scored jobs until user confirms they actually applied. */
  private readonly draftJobs = new Map<string, JobRecord>();
  /** Draft id -> capture id, for drafts that originated from an extension capture. */
  private readonly captureIdByDraftId = new Map<string, string>();

  /** In-memory draft, falling back to a persisted extension-capture result. */
  private async findDraft(id: string): Promise<JobRecord | null> {
    const draft = this.draftJobs.get(id);
    if (draft) return draft;
    const capture = await capturesRepository.findByJobId(id);
    if (!capture?.result) return null;
    this.draftJobs.set(id, capture.result);
    this.captureIdByDraftId.set(id, capture.id);
    return capture.result;
  }

  /** Keep capture-backed drafts in Mongo in sync so they survive API restarts. */
  private async saveDraft(job: JobRecord): Promise<void> {
    this.draftJobs.set(job.id, job);
    const captureId = this.captureIdByDraftId.get(job.id);
    if (captureId) await capturesRepository.update(captureId, { result: job });
  }

  async runTriage(input: {
    url?: string;
    rawText?: string;
    companyHint?: string;
    fullPrep?: boolean;
  }): Promise<JobRecord> {
    const result = await triageJob(input);
    this.draftJobs.set(result.id, result);
    return result;
  }

  /** Re-run extraction, rules, and scoring for an existing draft or tracked role. */
  async runRetriage(id: string): Promise<{ job: JobRecord; tracked: boolean }> {
    const { job: prev, tracked } = await this.getByIdIncludingDraft(id);
    if (!prev) throw new JobNotFoundError();

    const rawText = prev.extracted.rawText?.trim();
    const url = prev.extracted.url?.trim();
    if (!rawText && !url) throw new JobNoJdSourceError();

    const companyHint = companyHintFromExtracted(prev.extracted);

    const fresh = await triageJob({
      url: url || undefined,
      rawText: rawText || undefined,
      companyHint,
      fullPrep: false,
      retriageFrom: prev,
    });

    const extracted = preserveCompanyOnRetriage(prev.extracted, fresh.extracted);

    const now = new Date().toISOString();
    const historyEntry = {
      scoredAt: now,
      score: fresh.score,
      recommendation: fresh.recommendation,
    };
    const ts = prev.trackerSpreadsheet ?? {};
    const prevOriginal =
      typeof ts.originalAltScore === "string" && ts.originalAltScore.trim()
        ? ts.originalAltScore.trim()
        : "";

    const merged: JobRecord = {
      ...prev,
      extracted,
      rules: fresh.rules,
      score: fresh.score,
      recommendation: fresh.recommendation,
      salaryAsk: fresh.salaryAsk,
      recommendedResume: fresh.recommendedResume,
      resumeRationale: fresh.resumeRationale,
      topMatch: fresh.topMatch,
      mainRisk: fresh.mainRisk,
      rationale: fresh.rationale,
      risks: fresh.risks,
      debugExtraction: fresh.debugExtraction,
      scoringJdTextHash: fresh.scoringJdTextHash,
      generated: {},
      updatedAt: now,
      scoreHistory: [...(prev.scoreHistory ?? []), historyEntry],
      tracker: {
        ...prev.tracker,
        priority: fresh.tracker.priority,
        recommendedAction: fresh.tracker.recommendedAction,
        notes: prev.tracker.notes,
        statusOutcome: tracked ? (prev.tracker.statusOutcome ?? prev.status) : fresh.tracker.statusOutcome,
        ...(() => {
          const mergedForShortlist: JobRecord = {
            ...prev,
            score: fresh.score,
            status: prev.status,
            referralPathwayAvailable: fresh.referralPathwayAvailable ?? prev.referralPathwayAvailable,
          };
          const shortlist = evaluateShortlist(mergedForShortlist);
          return {
            shortlist: shortlist.onShortlist,
            shortlistTag: shortlist.tag,
            freshnessTier: shortlist.freshnessLabel,
            color: getTrackerColor(prev.status, fresh.score.total),
          };
        })(),
      },
    };
    merged.trackerSpreadsheet = buildTrackerSpreadsheetFromJob(merged);
    if (tracked) {
      merged.trackerSpreadsheet = {
        ...merged.trackerSpreadsheet,
        originalAltScore: prevOriginal || String(prev.score.total),
        latestScore: String(fresh.score.total),
      };
    }

    if (tracked) {
      const saved = await jobsRepository.upsertJob(merged);
      return { job: saved, tracked: true };
    }
    await this.saveDraft(merged);
    return { job: merged, tracked: false };
  }

  async getByIdIncludingDraft(id: string): Promise<{ job: JobRecord | null; tracked: boolean }> {
    const tracked = await jobsRepository.getById(id);
    if (tracked) return { job: tracked, tracked: true };
    const draft = await this.findDraft(id);
    return { job: draft, tracked: false };
  }

  async getById(id: string): Promise<JobRecord | null> {
    return jobsRepository.getById(id);
  }

  async list(
    filters: JobListFilters,
  ): Promise<{ items: JobRecord[]; total: number; totalAll: number; shortlistTotal: number }> {
    await this.runAutoArchive();
    const repoFilters = { ...filters };
    const shortlistRequested = repoFilters.shortlist === true;
    if (shortlistRequested) delete repoFilters.shortlist;

    const result = await jobsRepository.list(repoFilters);
    const shortlistTotal = result.items.filter((job) => liveShortlistEligible(job)).length;

    let items = result.items;
    if (shortlistRequested) {
      items = items
        .filter((job) => liveShortlistEligible(job))
        .map((job) => {
          const shortlist = evaluateShortlist(job);
          return {
            ...job,
            tracker: {
              ...job.tracker,
              shortlist: shortlist.onShortlist,
              shortlistTag: shortlist.tag,
              freshnessTier: shortlist.freshnessLabel,
            },
          };
        })
        .sort(compareShortlistJobs);
    }

    return { ...result, items, total: items.length, shortlistTotal };
  }

  /** Recompute scores + sync shortlist flags for every tracked job. */
  async refreshShortlist(): Promise<RefreshShortlistResult> {
    await this.runAutoArchive();
    const resumeContexts = await resumeContextService.getAvailableContexts();
    const jobs = await jobsRepository.findAll();
    return jobsRepository.refreshAllShortlists({ jobs, resumeContexts });
  }

  /** Idempotent sweep: applied + silence threshold + no progress → lapsed. */
  async runAutoArchive(now: Date = new Date()): Promise<{ archivedIds: string[] }> {
    const { items } = await jobsRepository.list({});
    const archivedIds: string[] = [];
    for (const job of items) {
      const candidate = shouldAutoArchiveAppliedJob(job, now);
      if (!candidate) continue;
      await jobsRepository.updateStatus(
        candidate.jobId,
        "lapsed",
        autoArchiveNote(candidate.daysSinceApplied),
      );
      archivedIds.push(candidate.jobId);
    }
    return { archivedIds };
  }

  async exportRows(filters: JobListFilters): Promise<{ rows: JobExportRow[]; total: number }> {
    const { items } = await this.list(filters);
    const rows: JobExportRow[] = items.map((job) => buildJobExportRow(job));
    return { rows, total: rows.length };
  }

  async generateAssetsForJobId(jobId: string, input?: { force?: boolean }): Promise<JobRecord> {
    const tracked = await jobsRepository.getById(jobId);
    const draft = tracked ? null : await this.findDraft(jobId);
    const job = tracked ?? draft;
    if (!job) throw new JobNotFoundError();
    const selectedResumeContext = (await resumeContextService.getContext(toActiveResumeType(job.recommendedResume))) ?? undefined;
    const result = await generateJobAssets({ job, userProfile, selectedResumeContext, force: input?.force });
    if (result.skipped) {
      throw new AssetGenerationSkippedError(result.skipReason ?? "Asset generation skipped.");
    }
    if (tracked) {
      const updated = await jobsRepository.mergeGeneratedAssets(
        jobId,
        result.generated,
        result.debugAssetGeneration,
      );
      if (!updated) throw new JobNotFoundError();
      return updated;
    }
    const merged: JobRecord = {
      ...job,
      generated: result.generated,
      ...(result.debugAssetGeneration !== undefined
        ? { debugAssetGeneration: result.debugAssetGeneration }
        : {}),
      updatedAt: new Date().toISOString(),
    };
    await this.saveDraft(merged);
    return merged;
  }

  async generateAssetsFromJobBody(body: {
    job: JobRecord;
    persist?: boolean;
    force?: boolean;
  }): Promise<JobRecord> {
    const { job, persist, force } = body;
    const selectedResumeContext = (await resumeContextService.getContext(toActiveResumeType(job.recommendedResume))) ?? undefined;
    const result = await generateJobAssets({ job, userProfile, selectedResumeContext, force });
    if (result.skipped) {
      throw new AssetGenerationSkippedError(result.skipReason ?? "Asset generation skipped.");
    }
    const merged: JobRecord = {
      ...job,
      generated: result.generated,
      ...(result.debugAssetGeneration !== undefined
        ? { debugAssetGeneration: result.debugAssetGeneration }
        : {}),
      updatedAt: new Date().toISOString(),
    };
    if (persist) {
      return jobsRepository.upsertJob(merged);
    }
    return merged;
  }

  async updateStatus(id: string, status: JobStatus, note?: string): Promise<JobRecord> {
    const updated = await jobsRepository.updateStatus(id, status, note);
    if (!updated) throw new JobNotFoundError();
    return updated;
  }

  async updateNotes(id: string, notes: string): Promise<JobRecord> {
    const updated = await jobsRepository.updateNotes(id, notes);
    if (!updated) throw new JobNotFoundError();
    return updated;
  }

  async updateAppliedAt(id: string, appliedAt: string): Promise<JobRecord> {
    const updated = await jobsRepository.updateAppliedAt(id, appliedAt);
    if (!updated) throw new JobNotFoundError();
    return updated;
  }

  async setReachedHuman(id: string, reachedHuman: boolean | null): Promise<JobRecord> {
    const updated = await jobsRepository.setReachedHuman(id, reachedHuman);
    if (!updated) throw new JobNotFoundError();
    return updated;
  }

  async removeFromTracker(id: string): Promise<void> {
    const deletedTracked = await jobsRepository.deleteById(id);
    const deletedDraft = this.draftJobs.delete(id);
    this.captureIdByDraftId.delete(id);
    const deletedCapture = await capturesRepository.deleteByJobId(id);
    if (!deletedTracked && !deletedDraft && !deletedCapture) throw new JobNotFoundError();
  }

  async confirmApplied(id: string): Promise<JobRecord> {
    const existing = await jobsRepository.getById(id);
    if (existing) {
      if (existing.status !== "to_review") return existing;
      return (await jobsRepository.updateAppliedAt(id, localDateKey(new Date()))) ?? existing;
    }
    const draft = await this.findDraft(id);
    if (!draft) throw new JobNotFoundError();
    if (!canConfirmApplied(draft)) {
      throw new JobConfirmNotAllowedError();
    }

    const now = new Date().toISOString();
    const toPersist: JobRecord = {
      ...draft,
      status: "applied",
      updatedAt: now,
      tracker: {
        ...draft.tracker,
        statusOutcome: "applied",
        appliedAt: now,
        shortlist: false,
        shortlistTag: undefined,
        freshnessTier: undefined,
        color: getTrackerColor("applied", draft.score.total),
      },
      statusHistory: [
        ...(draft.statusHistory ?? []),
        {
          id: randomUUID(),
          jobId: draft.id,
          fromStatus: draft.status,
          toStatus: "applied",
          note: "Confirmed I applied",
          createdAt: now,
        },
      ],
    };

    const saved = await jobsRepository.upsertJob(toPersist);
    this.draftJobs.delete(id);
    this.captureIdByDraftId.delete(id);
    return saved;
  }
}

export const jobsService = new JobsService();
