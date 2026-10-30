import { effectiveScoreProvenance, presentFitForDisplay } from "../lib/authoritativeScore.js";
import type { ApprovedRevisionOverlay } from "../services/scoring/scoreRevision.types.js";
import { roleFromEvaluation } from "../services/gmail/jdRecovery/summary.js";
import type { ApplicationEvaluation, FitBreakdown } from "../services/gmail/jdRecovery/evaluations.repository.js";
import type { ApplicationEmail, GmailApplication, PendingAction } from "../services/gmail/gmailApplications.js";
import type { InsightsRun } from "../services/insights/insights.repository.js";
import type { CoverageCounts, ScreeningCell, ScreeningCross } from "../services/insights/analyze.js";
import type { Interval } from "../services/insights/stats.js";

export const MAX_DETAIL_EMAILS = 8;

const intervalView = (rate: Interval | undefined) => {
  if (rate == null) return undefined;
  return {
    rate: rate.rate,
    lo: rate.lo,
    hi: rate.hi,
  };
};

const screeningCellView = (cell: ScreeningCell) => ({
  bucket: cell.bucket,
  k: cell.k,
  n: cell.n,
  rate: intervalView(cell.rate),
});

const screeningCrossView = (cell: ScreeningCross) => ({
  seniority: cell.seniority,
  degree: cell.degree,
  k: cell.k,
  n: cell.n,
  rate: intervalView(cell.rate),
});

const coverageView = (counts: CoverageCounts) => ({
  applications: counts.applications,
  positive: counts.positive,
  negative: counts.negative,
  tooEarly: counts.tooEarly,
  decided: counts.decided,
  withFit: counts.withFit,
  withoutFit: counts.withoutFit,
  scoredCallbacks: counts.scoredCallbacks,
  unscoredCallbacks: counts.unscoredCallbacks,
  confirmedApplied: counts.confirmedApplied,
  inferredApplied: counts.inferredApplied,
  unscoredReasons: counts.unscoredReasons,
});

const fitBreakdownView = (breakdown: FitBreakdown) => ({
  categories: breakdown.categories,
  capability: breakdown.capability,
  survivability: breakdown.survivability,
  gapDock: breakdown.gapDock,
  hardGates: breakdown.hardGates,
  topMatch: breakdown.topMatch,
  mainRisk: breakdown.mainRisk,
});

const emailView = (email: ApplicationEmail) => ({
  date: email.date,
  eventType: email.eventType,
  subject: email.subject,
});

const roundView = (round: GmailApplication["interviewRounds"][number]) => ({
  number: round.number,
  label: round.label,
  kind: round.kind,
  focus: round.focus,
  scheduledAt: round.scheduledAt,
  cancelled: round.cancelled,
});

const actionView = (action: PendingAction) => ({
  type: action.type,
  summary: action.summary,
  deadline: action.deadline,
});

const presentedFit = (evaluation?: ApplicationEvaluation, revision?: ApprovedRevisionOverlay | null) =>
  evaluation?.fit ? presentFitForDisplay(evaluation.fit, { revision, evaluation }) : undefined;

const evaluationView = (evaluation: ApplicationEvaluation, revision?: ApprovedRevisionOverlay | null) => {
  const fit = presentedFit(evaluation, revision);
  return {
    status: evaluation.recovery.status,
    fitTotal: fit?.total,
    recommendation: fit?.recommendation,
    recommendedResume: evaluation.fit?.recommendedResume,
    matchLevel: evaluation.recovery.match?.level,
    // Provenance only: stage label and short fixed-vocabulary signal codes. Never attempts, candidates, notes, or URLs.
    foundVia: evaluation.recovery.foundVia,
    matchSignals: evaluation.recovery.match?.signals ? [...evaluation.recovery.match.signals] : undefined,
    postingKind: evaluation.postingKind ?? "unknown",
    jdTitle: roleFromEvaluation(evaluation) ?? undefined,
    fitBreakdown: evaluation.fit?.breakdown ? fitBreakdownView(evaluation.fit.breakdown) : undefined,
    ...(fit ? effectiveScoreProvenance(fit) : {}),
  };
};

export const toListRow = (
  app: GmailApplication,
  evaluation?: ApplicationEvaluation,
  revision?: ApprovedRevisionOverlay | null,
) => {
  const fit = presentedFit(evaluation, revision);
  return {
    key: app.key,
    company: app.company,
    role: app.role ?? (evaluation ? roleFromEvaluation(evaluation) : null),
    status: app.status,
    furthestStage: app.furthestStage,
    appliedAt: app.appliedAt,
    lastUpdateAt: app.lastUpdateAt,
    activelyInterviewing: app.activelyInterviewing,
    fitTotal: fit?.total,
    postingKind: evaluation?.postingKind ?? "unknown",
    ...(fit ? effectiveScoreProvenance(fit) : {}),
  };
};

export const toDetailsView = (
  app: GmailApplication,
  evaluation?: ApplicationEvaluation,
  revision?: ApprovedRevisionOverlay | null,
) => ({
  key: app.key,
  company: app.company,
  role: app.role ?? (evaluation ? roleFromEvaluation(evaluation) : null),
  status: app.status,
  furthestStage: app.furthestStage,
  appliedAt: app.appliedAt,
  appliedAtKnown: app.appliedAtKnown,
  appliedAtSource: app.appliedAtSource,
  lastUpdateAt: app.lastUpdateAt,
  activelyInterviewing: app.activelyInterviewing,
  trackerStatus: app.trackerStatus,
  trackerTitle: app.trackerTitle,
  interviewRounds: app.interviewRounds.map(roundView),
  emails: app.emails.slice(-MAX_DETAIL_EMAILS).map(emailView),
  actionNeeded: app.actionNeeded ? actionView(app.actionNeeded) : undefined,
  evaluation: evaluation ? evaluationView(evaluation, revision) : undefined,
});

export const toInsightsView = (run: InsightsRun | null) => {
  if (!run) {
    return { run: null as const, message: "No insights run stored yet." };
  }
  return {
    run: {
      generatedAt: run.generatedAt,
      trigger: run.trigger,
      headline: run.headline,
      // Stored verdict only — never inferred from scorePredicts or other metrics.
      conclusion: run.conclusion,
      summary: run.summary,
      counts: coverageView(run.counts),
      baseRate: {
        k: run.baseRate.k,
        n: run.baseRate.n,
        rate: run.baseRate.rate,
        lo: run.baseRate.lo,
        hi: run.baseRate.hi,
      },
      scorePredicts: {
        auc: run.scorePredicts.auc,
        p: run.scorePredicts.p,
        k: run.scorePredicts.k,
        n: run.scorePredicts.n,
        verdict: run.scorePredicts.verdict,
        note: run.scorePredicts.note,
        rate: intervalView(run.scorePredicts.rate),
      },
      scoreBands: run.scoreBands.map((band) => ({
        band: band.band,
        k: band.k,
        n: band.n,
        rate: intervalView(band.rate),
      })),
      screening: run.screening
        ? {
            seniority: run.screening.seniority.map(screeningCellView),
            seniorityUnknown: run.screening.seniorityUnknown,
            degree: run.screening.degree.map(screeningCellView),
            degreeUnknown: run.screening.degreeUnknown,
            specialized: {
              k: run.screening.specialized.k,
              n: run.screening.specialized.n,
              restK: run.screening.specialized.restK,
              restN: run.screening.specialized.restN,
              rate: intervalView(run.screening.specialized.rate),
            },
            specializedUnknown: run.screening.specializedUnknown,
            bySeniorityAndDegree: run.screening.bySeniorityAndDegree.map(screeningCrossView),
          }
        : undefined,
      goodFit: {
        k: run.goodFit.k,
        n: run.goodFit.n,
        rate: intervalView(run.goodFit.rate),
      },
    },
  };
};
