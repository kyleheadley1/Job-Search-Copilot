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
  }>;
  verifiedBy?: "auto" | "user";
  jdTitle?: string;
  recoveredRole?: string;
  boardChecks?: BoardCheck[];
  fitBreakdown?: FitBreakdown;
  fitTotal?: number;
  recommendation?: string;
  recommendedResume?: StoredResumeType;
  matchLevel?: MatchLevel;
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

export const toEvaluationSummary = (e: ApplicationEvaluation): EvaluationSummary => ({
  status: e.recovery.status,
  reason: e.recovery.reason,
  notes: e.recovery.notes,
  attempts: e.recovery.attempts.slice(0, 10),
  candidates: e.recovery.candidates?.map(({ text: _text, company: _company, ...c }) => c),
  verifiedBy: e.recovery.verifiedBy,
  jdTitle: roleFromEvaluation(e) ?? undefined,
  recoveredRole: e.recovery.recoveredRole,
  boardChecks: e.recovery.boardChecks,
  fitBreakdown: e.fit?.breakdown,
  fitTotal: e.fit?.total,
  recommendation: e.fit?.recommendation,
  recommendedResume: e.fit?.recommendedResume,
  matchLevel: e.recovery.match?.level,
  url: e.recovery.url,
});

export const withEvaluations = (
  apps: GmailApplication[],
  evaluations: Map<string, ApplicationEvaluation>,
): Array<GmailApplication & { evaluation?: EvaluationSummary }> =>
  apps.map((app) => {
    const e = evaluations.get(app.key);
    if (!e) return app;
    return { ...app, role: app.role ?? roleFromEvaluation(e), evaluation: toEvaluationSummary(e) };
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
export const buildRubricSummary = (evaluations: ApplicationEvaluation[]): RubricSummary => {
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
    (points[e.outcome.status] ??= []).push({
      company: e.company,
      role: e.role,
      fit: e.fit.total,
      verifiedBy,
      furthestStage,
      ...(e.outcome.furthestRound ? { furthestRound: e.outcome.furthestRound } : {}),
    });
    if (furthestStage === "interviewing" || furthestStage === "offer") {
      interviewed.sum += e.fit.total;
      interviewed.count += 1;
    }
    const t = totals.get(e.outcome.status) ?? { sum: 0, count: 0 };
    t.sum += e.fit.total;
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
