import { effectiveScoreProvenance, presentFitForDisplay } from "../../../lib/authoritativeScore.js";
import type { ApprovedRevisionOverlay } from "../../scoring/scoreRevision.types.js";
import { isWeakJobTitle } from "../../../tools/jobPostingMetadataExtract.js";
import type { StoredResumeType } from "../../../types/resume.js";
import type { ApplicationStatus, GmailApplication } from "../gmailApplications.js";
import type { MatchLevel } from "./assessJdMatch.js";
import type { ApplicationEvaluation, BoardCheck, FitBreakdown, RecoveryStatus } from "./evaluations.repository.js";

export type EvaluationSummary = {
  status: RecoveryStatus;
  reason?: string;
  notes?: string[];
  attempts?: Array<{ url: string; source: string; ok: boolean; reason?: string; matchLevel?: MatchLevel }>;
  candidates?: Array<{
    url?: string;
    prospectId?: string;
    title?: string;
    location?: string;
    matchLevel: MatchLevel;
    source: string;
    completeness?: "full" | "partial";
    sourceType?: "company_site" | "ats" | "aggregator" | "other";
    retrievedAt?: string;
    matchEvidence?: string[];
  }>;
  verifiedBy?: "auto" | "user";
  jdTitle?: string;
  recoveredRole?: string;
  boardChecks?: BoardCheck[];
  fitBreakdown?: FitBreakdown;
  fitTotal?: number;
  recommendation?: string;
  storedFitTotal?: number;
  scoreConflict?: boolean;
  authoritativeSource?: string;
  revisionId?: string;
  scoreRevised?: boolean;
  originalAuthoritativeTotal?: number;
  fingerprintStale?: boolean;
  staleRevisionTotal?: number;
  recommendedResume?: StoredResumeType;
  matchLevel?: MatchLevel;
  foundVia?: string;
  matchSignals?: string[];
  url?: string;
};

/** Title from the stored/pasted JD when the email never named the role. */
export const roleFromEvaluation = (e: ApplicationEvaluation): string | null => {
  for (const raw of [e.jd?.title, e.fit?.detail?.extracted?.title, e.recovery.recoveredRole]) {
    const title = raw?.trim();
    if (title && !isWeakJobTitle(title)) return title;
  }
  return null;
};

export const toEvaluationSummary = (
  e: ApplicationEvaluation,
  revision?: ApprovedRevisionOverlay | null,
): EvaluationSummary => {
  const fit = e.fit ? presentFitForDisplay(e.fit, { revision, evaluation: e }) : undefined;
  return {
    status: e.recovery.status,
    reason: e.recovery.reason,
    notes: e.recovery.notes,
    attempts: e.recovery.attempts.slice(0, 10),
    candidates: e.recovery.candidates?.map(({ text: _text, rawText: _rawText, company: _company, evidenceSnapshot, ...c }) => ({
      ...c,
      evidenceSnapshot,
    })),
    verifiedBy: e.recovery.verifiedBy,
    jdTitle: roleFromEvaluation(e) ?? undefined,
    recoveredRole: e.recovery.recoveredRole,
    boardChecks: e.recovery.boardChecks,
    fitBreakdown: e.fit?.breakdown,
    fitTotal: fit?.total,
    recommendation: fit?.recommendation,
    recommendedResume: e.fit?.recommendedResume,
    matchLevel: e.recovery.match?.level,
    foundVia: e.recovery.foundVia,
    matchSignals: e.recovery.match?.signals ? [...e.recovery.match.signals] : undefined,
    url: e.recovery.url,
    ...(fit ? effectiveScoreProvenance(fit) : {}),
  };
};

export const withEvaluations = (
  apps: GmailApplication[],
  evaluations: Map<string, ApplicationEvaluation>,
  revisions?: Map<string, ApprovedRevisionOverlay>,
): Array<GmailApplication & { evaluation?: EvaluationSummary }> =>
  apps.map((app) => {
    const e = evaluations.get(app.key);
    if (!e) return app;
    return {
      ...app,
      role: app.role ?? roleFromEvaluation(e),
      evaluation: toEvaluationSummary(e, revisions?.get(app.key)),
    };
  });

const OUTCOMES: ApplicationStatus[] = ["applied", "assessment", "interviewing", "rejected", "offer"];

export type RubricRow = { outcome: ApplicationStatus; count: number; meanFit: number | null };

export type RubricPoint = {
  company: string;
  role: string | null;
  fit: number;
  verifiedBy: "auto" | "user";
  furthestStage?: Exclude<ApplicationStatus, "rejected">;
  furthestRound?: { number: number; label: string };
};

export type RubricSummary = {
  rows: RubricRow[];
  /** Scored applications that got at least an interview, whatever happened after. */
  reachedInterview: { count: number; meanFit: number | null };
  scored: number;
  userVerified: number;
  points: Partial<Record<ApplicationStatus, RubricPoint[]>>;
  byRecoveryStatus: Record<RecoveryStatus, number>;
};

/** Mean fit per current outcome, scored rows only. */
export const buildRubricSummary = (
  evaluations: ApplicationEvaluation[],
  revisions?: Map<string, ApprovedRevisionOverlay>,
): RubricSummary => {
  const byRecoveryStatus: Record<RecoveryStatus, number> = {
    scored: 0,
    unverified: 0,
    not_found: 0,
    fetch_failed: 0,
  };
  const totals = new Map<ApplicationStatus, { sum: number; count: number }>();
  const points: RubricSummary["points"] = {};
  let userVerified = 0;
  const interviewed = { sum: 0, count: 0 };
  for (const e of evaluations) {
    byRecoveryStatus[e.recovery.status] += 1;
    if (e.recovery.status !== "scored" || !e.fit) continue;
    const verifiedBy = e.recovery.verifiedBy ?? "auto";
    if (verifiedBy === "user") userVerified += 1;
    const furthestStage = e.outcome.furthestStage;
    const fitTotal = presentFitForDisplay(e.fit, { revision: revisions?.get(e.key), evaluation: e }).total;
    (points[e.outcome.status] ??= []).push({
      company: e.company,
      role: e.role,
      fit: fitTotal,
      verifiedBy,
      furthestStage,
      ...(e.outcome.furthestRound ? { furthestRound: e.outcome.furthestRound } : {}),
    });
    if (furthestStage === "interviewing" || furthestStage === "offer") {
      interviewed.sum += fitTotal;
      interviewed.count += 1;
    }
    const t = totals.get(e.outcome.status) ?? { sum: 0, count: 0 };
    t.sum += fitTotal;
    t.count += 1;
    totals.set(e.outcome.status, t);
  }
  const rows = OUTCOMES.map((outcome) => {
    const t = totals.get(outcome);
    return {
      outcome,
      count: t?.count ?? 0,
      meanFit: t && t.count > 0 ? Math.round((t.sum / t.count) * 10) / 10 : null,
    };
  });
  for (const list of Object.values(points)) list?.sort((a, b) => b.fit - a.fit);
  const reachedInterview = {
    count: interviewed.count,
    meanFit: interviewed.count > 0 ? Math.round((interviewed.sum / interviewed.count) * 10) / 10 : null,
  };
  return { rows, reachedInterview, scored: byRecoveryStatus.scored, userVerified, points, byRecoveryStatus };
};
