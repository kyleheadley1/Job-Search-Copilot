import { Router, type Response } from "express";
import { z } from "zod";
import { env } from "../config/env.js";
import { logger } from "../lib/logger.js";
import { getGmailApplications, getInterviewPanel } from "../services/gmail/gmailApplications.js";
import { gmailMessagesRepository } from "../services/gmail/gmailMessages.repository.js";
import {
  gmailAuth,
  GmailNotConfiguredError,
  GmailNotConnectedError,
  GmailReconnectRequiredError,
} from "../services/gmail/gmailAuth.js";
import { GmailRateLimitError } from "../services/gmail/gmailClient.js";
import { presentFitForDisplay } from "../lib/authoritativeScore.js";
import { NotAJobPostingError } from "../services/gmail/jdRecovery/applicationPostingKind.js";
import { DEFAULT_SYNC_DAYS, MAX_SYNC_DAYS, syncGmail } from "../services/gmail/gmailSync.js";
import { getInterviewBrief } from "../services/gmail/interviewBrief.js";
import { evaluationsRepository } from "../services/gmail/jdRecovery/evaluations.repository.js";
import {
  InvalidJdCandidateError,
  revalidateSubmittedCandidateCompleteness,
} from "../services/gmail/jdRecovery/jdCandidates.service.js";
import {
  AlreadyScoredError,
  EvaluationNotFoundError,
  IncompleteJdError,
  InvalidTitleError,
  NoStoredJdError,
  runScoringDiagnostic,
  toScoringReport,
  getRecoveryRunState,
  loadEvaluations,
  MIN_PASTED_JD_CHARS,
  pendingApplications,
  startRecoveryRun,
  updateApplicationTitle,
  updateApplicationTitleFromJdText,
} from "../services/gmail/jdRecovery/runRecovery.js";
import {
  confirmReviewedCandidate,
  getJdShadowReport,
  InvalidJdReviewActionError,
  JD_REMOVAL_REASONS,
  listPendingJdReviews,
  pasteReviewedJd,
  rejectReviewedCandidate,
  removeReviewedCandidate,
  restoreReviewedCandidate,
} from "../services/gmail/jdRecovery/jdReview.service.js";
import { createLiveJdRecoveryQueueService } from "../services/gmail/jdRecovery/jdRecoveryQueue.service.js";
import {
  buildCostSummary,
  buildMonthSpend,
  buildRecoveryMetrics,
} from "../services/gmail/jdRecovery/recoveryMetrics.js";
import { serperUsageRepository } from "../services/gmail/jdRecovery/serperClient.js";
import { monthStartDay } from "../services/llm/featureBudget.js";
import { llmUsageRepository, localDay } from "../services/llm/llmUsage.js";
import { jobProspectsRepository } from "../services/gmail/jdRecovery/jobProspects.repository.js";
import { withProspectLinks } from "../services/gmail/jdRecovery/prospectMatch.js";
import { buildRubricSummary, toEvaluationSummary, withEvaluations } from "../services/gmail/jdRecovery/summary.js";
import {
  approveScoreRevision,
  listScoreRevisions,
  loadApprovedOverlays,
  proposeDeterministicRevision,
  publicRevisionView,
  rollbackScoreRevision,
  ScoreRevisionError,
} from "../services/scoring/scoreRevisions.service.js";

export const gmailRouter = Router();

const reviewQueue = createLiveJdRecoveryQueueService({
  getApplications: getGmailApplications,
  getEvaluationsByKeys: (keys) => evaluationsRepository.findByKeys(keys),
});

const DAY_MS = 24 * 60 * 60 * 1000;

const DaysSchema = z.coerce.number().int().min(1).max(MAX_SYNC_DAYS).default(DEFAULT_SYNC_DAYS);
const SyncBodySchema = z.object({ days: DaysSchema });
const ApplicationsQuerySchema = z.object({ days: DaysSchema });

/** Applications with their evaluation summary; refreshes stored outcomes on the way. */
const applicationsWithEvaluations = async (days: number) => {
  const [applications, panel] = await Promise.all([getGmailApplications(days), getInterviewPanel()]);
  const evaluations = await loadEvaluations(applications);
  const revisions = await loadApprovedOverlays(applications.map((a) => a.key));
  const openProspects = await jobProspectsRepository.findOpen().catch(() => []);
  return {
    applications: withProspectLinks(withEvaluations(applications, evaluations, revisions), openProspects),
    pendingRecovery: pendingApplications(applications, evaluations, true, openProspects).length,
    upcomingInterviews: panel.upcoming,
    actionItems: panel.actions,
  };
};

gmailRouter.post("/actions/:emailId/dismiss", async (req, res, next) => {
  try {
    const found = await gmailMessagesRepository.dismissAction(req.params.emailId);
    if (!found) {
      res.status(404).json({ error: "NOT_FOUND", message: "No such email" });
      return;
    }
    res.status(204).end();
  } catch (error) {
    next(error);
  }
});

/** Map known Gmail errors to clear statuses; returns false when the error is unknown. */
const sendGmailError = (res: Response, error: unknown): boolean => {
  if (error instanceof GmailNotConfiguredError) {
    res.status(503).json({ error: error.code, message: error.message });
    return true;
  }
  if (error instanceof GmailNotConnectedError) {
    res.status(409).json({ error: error.code, message: error.message });
    return true;
  }
  if (error instanceof GmailRateLimitError) {
    res.status(429).json({ error: error.code, message: error.message });
    return true;
  }
  if (error instanceof GmailReconnectRequiredError) {
    res.status(401).json({ error: error.code, message: error.message });
    return true;
  }
  return false;
};

gmailRouter.get("/status", async (_req, res, next) => {
  try {
    res.setHeader("Cache-Control", "no-store");
    res.json({ ...(await gmailAuth.getStatus()), autoSyncMinutes: env.gmailAutoSyncMinutes });
  } catch (error) {
    next(error);
  }
});

gmailRouter.get("/oauth/start", (_req, res) => {
  try {
    res.redirect(gmailAuth.buildConsentUrl());
  } catch (error) {
    if (!sendGmailError(res, error)) {
      res.redirect(`${env.webAppUrl}/?gmail=error`);
    }
  }
});

gmailRouter.get("/oauth/callback", async (req, res) => {
  const code = typeof req.query.code === "string" ? req.query.code : undefined;
  const state = typeof req.query.state === "string" ? req.query.state : undefined;
  const denied = typeof req.query.error === "string" ? req.query.error : undefined;
  if (denied || !code || !gmailAuth.consumeState(state)) {
    logger.warn("Gmail OAuth callback rejected", { denied, hasCode: Boolean(code) });
    res.redirect(`${env.webAppUrl}/?gmail=error`);
    return;
  }
  try {
    await gmailAuth.handleCallback(code);
    res.redirect(`${env.webAppUrl}/?gmail=connected`);
  } catch (error) {
    logger.error("Gmail OAuth callback failed", {
      message: error instanceof Error ? error.message : String(error),
    });
    res.redirect(`${env.webAppUrl}/?gmail=error`);
  }
});

gmailRouter.post("/disconnect", async (_req, res, next) => {
  try {
    await gmailAuth.disconnect();
    res.status(204).end();
  } catch (error) {
    next(error);
  }
});

gmailRouter.post("/sync", async (req, res, next) => {
  try {
    const { days } = SyncBodySchema.parse(req.body ?? {});
    const result = await syncGmail(days);
    const view = await applicationsWithEvaluations(days);
    const recovery = await startRecoveryRun(days).catch((error) => {
      logger.warn("Auto JD recovery did not start", {
        message: error instanceof Error ? error.message : String(error),
      });
      return { queued: view.pendingRecovery, running: false, started: false };
    });
    res.setHeader("Cache-Control", "no-store");
    res.json({ ...result, ...view, recovery });
  } catch (error) {
    if (sendGmailError(res, error)) return;
    next(error);
  }
});

gmailRouter.get("/applications", async (req, res, next) => {
  try {
    const { days } = ApplicationsQuerySchema.parse(req.query);
    res.setHeader("Cache-Control", "no-store");
    res.json({ days, ...(await applicationsWithEvaluations(days)) });
  } catch (error) {
    next(error);
  }
});

gmailRouter.post("/evaluations/run", async (req, res, next) => {
  try {
    const { days } = SyncBodySchema.parse(req.body ?? {});
    const result = await startRecoveryRun(days);
    res.status(202).json({ queued: result.queued, running: result.running, started: result.started });
  } catch (error) {
    next(error);
  }
});

gmailRouter.get("/evaluations", async (req, res, next) => {
  try {
    const { days } = ApplicationsQuerySchema.parse(req.query);
    const since = new Date(Date.now() - days * DAY_MS).toISOString();
    const sinceDay = localDay(new Date(Date.now() - (days - 1) * DAY_MS));
    const [evaluations, usage, llmRecords, monthRecords] = await Promise.all([
      evaluationsRepository.listSince(since),
      serperUsageRepository.get(),
      llmUsageRepository.listSinceDay(sinceDay).catch(() => []),
      llmUsageRepository.listSinceDay(monthStartDay(new Date())).catch(() => []),
    ]);
    const revisions = await loadApprovedOverlays(evaluations.map((e) => e.key));
    res.setHeader("Cache-Control", "no-store");
    res.json({
      days,
      run: getRecoveryRunState(),
      serper: { used: usage.queries, cap: usage.cap, configured: Boolean(env.serperApiKey) },
      rubricSummary: buildRubricSummary(evaluations, revisions),
      metrics: buildRecoveryMetrics(evaluations, usage),
      costs: {
        ...buildCostSummary(llmRecords, {
          model: env.openAiModel,
          today: localDay(),
          sevenDaysAgo: localDay(new Date(Date.now() - 6 * DAY_MS)),
          windowDays: days,
        }),
        thisMonth: buildMonthSpend(monthRecords, {
          top_jobs: env.topJobsMonthlyBudgetUsd,
          agent: env.agentMonthlyBudgetUsd,
          assistant: env.assistantMonthlyBudgetUsd,
          insights: env.insightsMonthlyBudgetUsd,
        }),
      },
      evaluations: evaluations.map((evaluation) => {
        const { jd, recovery, fit, diagnostic: _diagnostic, ...rest } = evaluation;
        const presented = fit
          ? presentFitForDisplay(fit, { revision: revisions.get(evaluation.key), evaluation })
          : undefined;
        return {
          ...rest,
          fit: presented && { ...presented, detail: undefined },
          recovery: { ...recovery, candidates: recovery.candidates?.map(({ text: _text, rawText: _rawText, ...c }) => c) },
          jd: jd && { title: jd.title, company: jd.company, datePosted: jd.datePosted, chars: jd.text.length },
        };
      }),
    });
  } catch (error) {
    next(error);
  }
});

const ConfirmBodySchema = z
  .object({
    url: z.string().url().optional(),
    prospectId: z.string().trim().min(1).max(80).optional(),
  })
  .refine((body) => Boolean(body.url || body.prospectId), { message: "url or prospectId is required" });
const PasteBodySchema = z.object({
  text: z.string().trim().min(MIN_PASTED_JD_CHARS).max(50_000),
  url: z.string().url().optional(),
});

const sendEvaluationError = (res: Response, error: unknown): boolean => {
  if (error instanceof EvaluationNotFoundError) {
    res.status(404).json({ error: "not_found", message: error.message });
    return true;
  }
  if (error instanceof InvalidJdCandidateError) {
    res.status(400).json({ error: "invalid_candidate", message: error.message });
    return true;
  }
  if (error instanceof AlreadyScoredError) {
    res.status(409).json({ error: "already_scored", message: error.message });
    return true;
  }
  if (error instanceof NoStoredJdError) {
    res.status(409).json({ error: "no_jd", message: error.message });
    return true;
  }
  if (error instanceof InvalidTitleError) {
    res.status(400).json({ error: "invalid_title", message: error.message });
    return true;
  }
  if (error instanceof IncompleteJdError) {
    res.status(409).json({ error: "incomplete_jd", message: error.message });
    return true;
  }
  if (error instanceof NotAJobPostingError) {
    res.status(409).json({ error: "not_a_job_posting", message: error.message });
    return true;
  }
  if (error instanceof InvalidJdReviewActionError) {
    res.status(409).json({ error: "invalid_review_action", message: error.message });
    return true;
  }
  if (error instanceof ScoreRevisionError) {
    const status =
      error.code === "NOT_FOUND" ? 404 : error.code === "METHOD_NOT_EXECUTABLE" ? 403 : 409;
    res.status(status).json({ error: error.code.toLowerCase(), message: error.message });
    return true;
  }
  return false;
};

gmailRouter.get("/evaluations/:key/scoring", async (req, res, next) => {
  try {
    const evaluation = await evaluationsRepository.findByKey(req.params.key);
    if (!evaluation) throw new EvaluationNotFoundError(`No evaluation for ${req.params.key}`);
    const [overlays, history] = await Promise.all([
      loadApprovedOverlays([evaluation.key]),
      listScoreRevisions(evaluation.key),
    ]);
    const approved = history.find((r) => r.status === "approved");
    res.json({
      ...toScoringReport(evaluation, overlays.get(evaluation.key)),
      scoreRevision: approved ? publicRevisionView(approved) : null,
      scoreRevisions: history.map(publicRevisionView),
    });
  } catch (error) {
    if (sendEvaluationError(res, error)) return;
    next(error);
  }
});

const ProposeRevisionBodySchema = z.object({
  allowRoleLaneChange: z.boolean().optional(),
  reason: z.string().trim().max(2000).optional(),
});
const RevisionActionBodySchema = z.object({
  note: z.string().trim().max(2000).optional(),
});

gmailRouter.get("/evaluations/:key/score-revisions", async (req, res, next) => {
  try {
    const evaluation = await evaluationsRepository.findByKey(req.params.key);
    if (!evaluation) throw new EvaluationNotFoundError(`No evaluation for ${req.params.key}`);
    const history = await listScoreRevisions(evaluation.key);
    res.json({ revisions: history.map(publicRevisionView) });
  } catch (error) {
    if (sendEvaluationError(res, error)) return;
    next(error);
  }
});

gmailRouter.post("/evaluations/:key/score-revisions", async (req, res, next) => {
  try {
    const body = ProposeRevisionBodySchema.parse(req.body ?? {});
    const revision = await proposeDeterministicRevision({
      applicationKey: req.params.key,
      allowRoleLaneChange: body.allowRoleLaneChange,
      reason: body.reason,
      via: "dashboard",
    });
    res.status(201).json({ revision: publicRevisionView(revision) });
  } catch (error) {
    if (sendEvaluationError(res, error)) return;
    next(error);
  }
});

gmailRouter.post("/evaluations/:key/score-revisions/:id/approve", async (req, res, next) => {
  try {
    const body = RevisionActionBodySchema.parse(req.body ?? {});
    const revision = await approveScoreRevision({
      applicationKey: req.params.key,
      revisionId: req.params.id,
      via: "dashboard",
      note: body.note,
    });
    res.json({ revision: publicRevisionView(revision) });
  } catch (error) {
    if (sendEvaluationError(res, error)) return;
    next(error);
  }
});

gmailRouter.post("/evaluations/:key/score-revisions/:id/rollback", async (req, res, next) => {
  try {
    const body = RevisionActionBodySchema.parse(req.body ?? {});
    const revision = await rollbackScoreRevision({
      applicationKey: req.params.key,
      revisionId: req.params.id,
      via: "dashboard",
      note: body.note,
    });
    res.json({ revision: publicRevisionView(revision) });
  } catch (error) {
    if (sendEvaluationError(res, error)) return;
    next(error);
  }
});

const sendInterviewBrief = async (res: Response, key: string, regenerate: boolean) => {
  const brief = await getInterviewBrief(key, regenerate);
  if (!brief) {
    res.status(404).json({ error: "NOT_FOUND", message: `No application for ${key}` });
    return;
  }
  res.setHeader("Cache-Control", "no-store");
  res.json(brief);
};

gmailRouter.get("/evaluations/:key/interview-brief", async (req, res, next) => {
  try {
    await sendInterviewBrief(res, req.params.key, false);
  } catch (error) {
    next(error);
  }
});

gmailRouter.post("/evaluations/:key/interview-brief/regenerate", async (req, res, next) => {
  try {
    await sendInterviewBrief(res, req.params.key, true);
  } catch (error) {
    next(error);
  }
});

/** Re-score the stored JD for auditing; the original fit score is not changed. */
gmailRouter.post("/evaluations/:key/diagnose", async (req, res, next) => {
  try {
    const evaluation = await runScoringDiagnostic(req.params.key);
    const [overlays, history] = await Promise.all([
      loadApprovedOverlays([evaluation.key]),
      listScoreRevisions(evaluation.key),
    ]);
    const approved = history.find((r) => r.status === "approved");
    res.json({
      ...toScoringReport(evaluation, overlays.get(evaluation.key)),
      scoreRevision: approved ? publicRevisionView(approved) : null,
      scoreRevisions: history.map(publicRevisionView),
    });
  } catch (error) {
    if (sendEvaluationError(res, error)) return;
    next(error);
  }
});

gmailRouter.get("/jd-reviews", async (_req, res, next) => {
  try {
    res.setHeader("Cache-Control", "no-store");
    res.json(await listPendingJdReviews());
  } catch (error) {
    next(error);
  }
});

gmailRouter.get("/jd-reviews/shadow-report", async (_req, res, next) => {
  try {
    res.setHeader("Cache-Control", "no-store");
    res.json(await getJdShadowReport());
  } catch (error) {
    next(error);
  }
});

gmailRouter.post("/evaluations/:key/candidates/revalidate-completeness", async (req, res, next) => {
  try {
    const { url } = z.object({ url: z.string().url() }).parse(req.body ?? {});
    const result = await revalidateSubmittedCandidateCompleteness(req.params.key, url, {
      getApplications: getGmailApplications,
      findByKey: (key) => evaluationsRepository.findByKey(key),
      upsertIfUnscored: (evaluation) => evaluationsRepository.upsertIfUnscored(evaluation),
    });
    const evaluation = await evaluationsRepository.findByKey(req.params.key);
    res.json({
      ...result,
      evaluation: evaluation ? toEvaluationSummary(evaluation) : undefined,
    });
  } catch (error) {
    if (sendEvaluationError(res, error)) return;
    next(error);
  }
});

gmailRouter.post("/evaluations/:key/confirm", async (req, res, next) => {
  try {
    const { url, prospectId } = ConfirmBodySchema.parse(req.body ?? {});
    const { evaluation } = await confirmReviewedCandidate(req.params.key, url ?? prospectId!);
    res.json({ evaluation: toEvaluationSummary(evaluation) });
  } catch (error) {
    if (sendEvaluationError(res, error)) return;
    next(error);
  }
});

gmailRouter.post("/evaluations/:key/candidates/reject", async (req, res, next) => {
  try {
    const { url, prospectId, note } = z
      .object({
        url: z.string().url().optional(),
        prospectId: z.string().trim().min(1).max(80).optional(),
        note: z.string().trim().min(1).max(400).optional(),
      })
      .refine((body) => Boolean(body.url || body.prospectId), { message: "url or prospectId is required" })
      .parse(req.body ?? {});
    const { evaluation } = await rejectReviewedCandidate(req.params.key, url ?? prospectId!, note);
    await reviewQueue.syncAfterReviewChange(evaluation);
    res.json({ evaluation: toEvaluationSummary(evaluation) });
  } catch (error) {
    if (sendEvaluationError(res, error)) return;
    next(error);
  }
});

gmailRouter.post("/evaluations/:key/candidates/remove", async (req, res, next) => {
  try {
    const { url, prospectId, reason } = z
      .object({
        url: z.string().url().optional(),
        prospectId: z.string().trim().min(1).max(80).optional(),
        reason: z.enum(JD_REMOVAL_REASONS),
      })
      .refine((body) => Boolean(body.url || body.prospectId), { message: "url or prospectId is required" })
      .parse(req.body ?? {});
    const { evaluation } = await removeReviewedCandidate(req.params.key, url ?? prospectId!, reason);
    await reviewQueue.syncAfterReviewChange(evaluation);
    res.json({ evaluation: toEvaluationSummary(evaluation) });
  } catch (error) {
    if (sendEvaluationError(res, error)) return;
    next(error);
  }
});

gmailRouter.post("/evaluations/:key/candidates/restore", async (req, res, next) => {
  try {
    const { url, prospectId } = z
      .object({
        url: z.string().url().optional(),
        prospectId: z.string().trim().min(1).max(80).optional(),
      })
      .refine((body) => Boolean(body.url || body.prospectId), { message: "url or prospectId is required" })
      .parse(req.body ?? {});
    const { evaluation } = await restoreReviewedCandidate(req.params.key, url ?? prospectId!);
    await reviewQueue.syncAfterReviewChange(evaluation);
    res.json({ evaluation: toEvaluationSummary(evaluation) });
  } catch (error) {
    if (sendEvaluationError(res, error)) return;
    next(error);
  }
});

gmailRouter.post("/evaluations/:key/jd", async (req, res, next) => {
  try {
    const { text, url } = PasteBodySchema.parse(req.body ?? {});
    const { evaluation } = await pasteReviewedJd(req.params.key, text, url);
    res.json({ evaluation: toEvaluationSummary(evaluation) });
  } catch (error) {
    if (sendEvaluationError(res, error)) return;
    next(error);
  }
});

const TitleBodySchema = z
  .object({
    title: z.string().trim().min(2).max(200).optional(),
    text: z.string().trim().min(MIN_PASTED_JD_CHARS).max(50_000).optional(),
  })
  .refine((b) => Boolean(b.title || b.text), { message: "Provide a title or paste the JD" });

gmailRouter.post("/evaluations/:key/title", async (req, res, next) => {
  try {
    const { title, text } = TitleBodySchema.parse(req.body ?? {});
    const evaluation = title
      ? await updateApplicationTitle(req.params.key, title)
      : await updateApplicationTitleFromJdText(req.params.key, text!);
    res.json({ evaluation: toEvaluationSummary(evaluation) });
  } catch (error) {
    if (sendEvaluationError(res, error)) return;
    next(error);
  }
});
