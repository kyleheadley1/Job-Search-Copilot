import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { api } from "../api/client";
import {
  AtmosBrief,
  BriefStylePicker,
  MinimalBrief,
  RehearseBrief,
  TabsBrief,
  useBriefStyle,
} from "../components/InterviewBriefViews";
import { InsightsCard } from "../components/InsightsCard";
import { NextStepsCard } from "../components/NextStepsCard";
import { ScoringDetailsPanel } from "../components/ScoringDetailsPanel";
import type {
  ActionItem,
  ActionType,
  ApplicationStatus,
  CostSummary,
  EvaluationSummary,
  LlmFeature,
  RecoveryMetrics,
  StageBucket,
  EvaluationsResponse,
  GmailApplication,
  GmailStatus,
  InterviewBriefResponse,
  RecoveryStart,
  RubricPoint,
  RubricSummary,
  UpcomingInterview,
} from "../types/gmail";
import type { JobStatus } from "../types/job";

const WINDOW_OPTIONS = [7, 30] as const;
type WindowDays = (typeof WINDOW_OPTIONS)[number];
const WINDOW_STORAGE_KEY = "dashboard.windowDays";
const AUTO_SYNC_AFTER_MS = 15 * 60 * 1000;
const RECOVERY_POLL_MS = 5000;
/** How often an open dashboard checks whether a background sync has landed. */
const STATUS_POLL_MS = 5 * 60 * 1000;
const SMALL_SAMPLE = 5;
const MIN_PASTED_JD_CHARS = 300;
const SERPER_LOW_BUDGET_SHARE = 0.2;

const STATUS_ORDER: ApplicationStatus[] = ["applied", "assessment", "interviewing", "rejected", "offer"];

const STATUS_LABEL: Record<ApplicationStatus, string> = {
  applied: "Applied",
  assessment: "Assessment",
  interviewing: "Interview",
  rejected: "Rejected",
  offer: "Offer",
};

const STATUS_PILL: Record<ApplicationStatus, string> = {
  applied: "info",
  assessment: "warn",
  interviewing: "good",
  rejected: "bad",
  offer: "good",
};

const JOB_STATUS_LABEL: Partial<Record<JobStatus, string>> = {
  to_review: "To review",
  applied: "Applied",
  skip: "Skip",
  rejected: "Rejected",
  interviewing: "Interviewing",
  assessment: "Assessment",
  closed: "Closed",
  offer: "Offer",
  lapsed: "Lapsed",
};

const formatDate = (iso: string) =>
  new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });

const formatDateTime = (iso: string) =>
  new Date(iso).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });

const REASON_LABEL: Record<string, string> = {
  serper_cap_reached: "search limit reached",
  serper_not_configured: "search not configured",
  serper_no_results: "search found nothing",
  no_search_terms: "no title or req ID to search",
  no_email_evidence: "no link or JD in email",
  no_usable_posting: "links didn't load",
  email_links_failed: "email's job link didn't load",
  multiple_title_matches: "several open jobs share this title",
  board_found_no_search: "company board checked",
  not_on_board: "not on the company's job board (may be closed)",
  no_board_found: "company job board not found",
  role_unknown: "role not stated",
};

const reasonLabel = (note: string) => REASON_LABEL[note] ?? note.replace(/_/g, " ");

type BoardCheck = NonNullable<EvaluationSummary["boardChecks"]>[number];

const boardCheckLabel = (check: BoardCheck): string => {
  const jobs = `${check.jobs} open job${check.jobs === 1 ? "" : "s"}`;
  if (check.jobs === 0) return `board has no open jobs (posting likely closed)`;
  return check.closestTitle
    ? `${jobs}; closest: "${check.closestTitle}" (${Math.round((check.similarity ?? 0) * 100)}% title match)`
    : `${jobs}; none with a similar title (likely closed)`;
};

const detailsTooltip = (evaluation: EvaluationSummary): string | undefined => {
  const notes = evaluation.notes?.length ? evaluation.notes : evaluation.reason ? [evaluation.reason] : [];
  const lines = [
    ...notes.map((n) => `• ${reasonLabel(n)}`),
    ...(evaluation.boardChecks ?? []).map((c) => `• ${c.board}: ${boardCheckLabel(c)}`),
    ...(evaluation.attempts ?? []).map(
      (a) => `${a.ok ? `ok (${a.matchLevel ?? "?"})` : `failed (${a.reason ?? "error"})`} [${a.source}] ${a.url}`,
    ),
  ];
  return lines.length ? lines.join("\n") : undefined;
};

type RecoveryFilter = "all" | "scored" | "review" | "missing" | "pending";

const filterOf = (app: GmailApplication): Exclude<RecoveryFilter, "all"> => {
  const status = app.evaluation?.status;
  if (!status) return "pending";
  if (status === "scored") return "scored";
  if (status === "unverified") return "review";
  return "missing";
};

const FILTER_LABEL: Record<RecoveryFilter, string> = {
  all: "All",
  scored: "Scored",
  review: "Needs your pick",
  missing: "Not found",
  pending: "Not checked yet",
};

/** Colors follow the recommendation tiers: strong apply / apply / stretch / weak. */
const fitClass = (fit: number) => (fit >= 80 ? "good" : fit >= 65 ? "info" : fit >= 50 ? "warn" : "bad");

const CATEGORY_LABEL: Record<string, string> = {
  stackFit: "Stack",
  levelFit: "Level",
  domainFit: "Domain",
  resumeStoryClarity: "Resume story",
  functionalOverlap: "Functional overlap",
  recruiterFriendliness: "Recruiter friendliness",
  careerValue: "Career value",
};

const fitTooltip = (evaluation: EvaluationSummary): string => {
  const revisionLine = evaluation.fingerprintStale
    ? `Approved revision ${evaluation.staleRevisionTotal ?? "—"} is inactive because the stored evaluation changed. Showing ${evaluation.fitTotal}.`
    : evaluation.scoreRevised
      ? `Approved revision ${evaluation.fitTotal} (was ${evaluation.originalAuthoritativeTotal ?? evaluation.storedFitTotal ?? "original"})`
      : evaluation.scoreConflict
        ? `Display ${evaluation.fitTotal} (stored ${evaluation.storedFitTotal ?? "—"})`
        : null;
  const b = evaluation.fitBreakdown;
  if (!b) {
    return [revisionLine, "Scored before breakdowns were stored. Scores are final and are not re-run."]
      .filter(Boolean)
      .join("\n");
  }
  return [
    revisionLine,
    `Capability ${b.capability ?? "?"} · survivability ${b.survivability ?? "?"}${b.gapDock ? ` · gap dock −${b.gapDock}` : ""}`,
    ...Object.entries(b.categories).map(([k, v]) => `${CATEGORY_LABEL[k] ?? k}: ${v}`),
    ...(b.hardGates ?? []).map((g) => `Hard gate: ${g}`),
    b.topMatch ? `Top match: ${b.topMatch}` : "",
    b.mainRisk ? `Main risk: ${b.mainRisk}` : "",
  ]
    .filter(Boolean)
    .join("\n");
};

/** Got at least one interview, whatever happened after. */
const reachedInterview = (app: GmailApplication) =>
  (app.interviewRounds?.length ?? 0) > 0 || app.furthestStage === "interviewing" || app.furthestStage === "offer";

const STATUS_CARD_HINT: Record<ApplicationStatus, string> = {
  applied: "Applied, no response beyond the confirmation yet",
  assessment: "Latest step is an assessment",
  interviewing: "Reached at least one interview, whatever happened after (includes later rejections)",
  rejected: "Rejected at any stage",
  offer: "Received an offer",
};

/** "Interviewing" only while the process is active; a stalled one reads "Interviewed". */
const statusPillLabel = (app: GmailApplication): string => {
  if (app.status !== "interviewing") return STATUS_LABEL[app.status];
  return app.activelyInterviewing === false ? "Interviewed" : "Interviewing";
};

const lowerFirst = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);

/** Current interview round under the status pill, or the round a rejection came after. */
function StageNote({ app }: { app: GmailApplication }) {
  const rounds = app.interviewRounds ?? [];
  const last = rounds[rounds.length - 1];
  const title = rounds.length > 1 ? rounds.map((r) => r.label).join("\n") : undefined;
  if (last && (app.status === "interviewing" || app.status === "rejected" || app.status === "offer")) {
    const text = app.status === "interviewing" ? last.label : `after ${lowerFirst(last.label)}`;
    return (
      <div className="muted smallText" title={title}>
        {text}
      </div>
    );
  }
  if (app.status === "rejected" && app.furthestStage && app.furthestStage !== "applied") {
    return <div className="muted smallText">after {STATUS_LABEL[app.furthestStage].toLowerCase()}</div>;
  }
  return null;
}

const DAY_MS = 24 * 60 * 60 * 1000;

const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();

/** "Today", "Tomorrow", "In 3 days", or "Now" while the interview is under way. */
const relativeDay = (at: Date, now: Date): string => {
  if (at.getTime() <= now.getTime()) return "Now";
  const days = Math.round((startOfDay(at) - startOfDay(now)) / DAY_MS);
  if (days === 0) return "Today";
  if (days === 1) return "Tomorrow";
  return `In ${days} days`;
};

const interviewWhen = (iv: UpcomingInterview): string => {
  const start = new Date(iv.scheduledAt);
  const date = start.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
  const time = (d: Date) => d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  const end = iv.durationMinutes ? new Date(start.getTime() + iv.durationMinutes * 60_000) : null;
  const zone = start.toLocaleTimeString(undefined, { timeZoneName: "short" }).split(" ").pop();
  return `${date} · ${time(start)}${end ? `–${time(end)}` : ""} ${zone ?? ""}`.trim();
};

type BriefState = { loading: boolean; data?: InterviewBriefResponse; error?: string; copied?: boolean };

function InterviewBriefPanel({
  state,
  onRegenerate,
  onCopy,
  onOpenJd,
}: {
  state: BriefState | undefined;
  onRegenerate: () => void;
  onCopy: () => void;
  onOpenJd: () => void;
}) {
  const [style, setStyle] = useBriefStyle();
  if (!state || (state.loading && !state.data)) return <span className="muted smallText">Building brief…</span>;
  if (state.error && !state.data) return <span className="smallText errorText">{state.error}</span>;
  const { data } = state;
  if (!data) return null;
  const b = data.brief;
  return (
    <div className="interviewBrief">
      <div className="rowBetween" style={{ gap: "0.5rem", flexWrap: "wrap" }}>
        {data.round && (style === "sections" || !b) ? (
          <div className="briefRound">
            <span className="briefHeading">This round</span> {data.round}
          </div>
        ) : (
          <span />
        )}
        {b && <BriefStylePicker value={style} onChange={setStyle} />}
      </div>
      {b && style === "minimal" ? (
        <MinimalBrief data={data} b={b} />
      ) : b && style === "tabs" ? (
        <TabsBrief data={data} b={b} />
      ) : b && style === "rehearse" ? (
        <RehearseBrief data={data} b={b} />
      ) : b && style === "atmos" ? (
        <AtmosBrief data={data} b={b} />
      ) : b ? (
        <>
          <section className="briefSection">
            <div className="briefHeading">About {data.company}</div>
            <p className="briefText">{b.companyBio}</p>
            <p className="briefText">
              <span className="briefLabel">Team need</span> {b.teamNeed}
            </p>
          </section>
          <div className="briefColumns">
            <section className="briefSection briefMatches">
              <div className="briefHeading">Why you fit</div>
              {b.strengths.map((s) => (
                <div key={s.point} className="briefItem">
                  <div className="briefItemTitle">{s.point}</div>
                  <div className="briefText muted">{s.evidence}</div>
                </div>
              ))}
            </section>
            <section className="briefSection briefWeak">
              <div className="briefHeading">Weak spots to prepare</div>
              {b.weakPoints.map((w) => (
                <div key={w.gap} className="briefItem">
                  <div className="briefItemTitle">{w.gap}</div>
                  <div className="briefText">
                    <span className="briefLabel">They may ask</span> <em>{w.probe}</em>
                  </div>
                  <div className="briefSay">
                    <span className="briefLabel">You can say</span> {w.answer}
                  </div>
                </div>
              ))}
            </section>
          </div>
          {b.askThem.length > 0 && (
            <section className="briefSection briefAsk">
              <div className="briefHeading">Questions to ask them</div>
              <ol>
                {b.askThem.map((q) => (
                  <li key={q} className="briefText">
                    {q}
                  </li>
                ))}
              </ol>
            </section>
          )}
        </>
      ) : data.reason === "no_jd" ? (
        <span className="muted smallText">
          No job description recovered yet, so there's no brief.{" "}
          <button type="button" className="linkButton" onClick={onOpenJd}>
            Paste the JD
          </button>{" "}
          to get one. The prep prompt below still has the company, role, and round.
        </span>
      ) : (
        <span className="smallText errorText">Couldn't generate the brief. Try Regenerate.</span>
      )}
      <div className="row">
        <button type="button" className="btn-secondary smallText" onClick={onCopy}>
          {state.copied ? "Copied" : "Copy prep prompt"}
        </button>
        {data.reason !== "no_jd" && (
          <button type="button" className="btn-secondary smallText" onClick={onRegenerate} disabled={state.loading}>
            {state.loading ? "Regenerating…" : "Regenerate"}
          </button>
        )}
      </div>
    </div>
  );
}

/** Confirmed interviews that haven't ended yet, soonest first, each with a collapsible prep brief. */
const ACTION_LABEL: Record<ActionType, { label: string; pill: string }> = {
  schedule: { label: "Schedule", pill: "info" },
  reply: { label: "Reply", pill: "neutral" },
  assessment: { label: "Assessment", pill: "warn" },
  offer: { label: "Offer", pill: "good" },
};

const ACTION_FALLBACK_SUMMARY: Record<ActionType, string> = {
  schedule: "Pick a time for the next interview",
  reply: "Reply to the recruiter",
  assessment: "Complete the assessment",
  offer: "Respond to the offer",
};

const deadlinePill = (deadline: string, now: Date): { text: string; cls: string } => {
  const at = new Date(deadline);
  const hoursLeft = (at.getTime() - now.getTime()) / 3_600_000;
  const date = at.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  if (hoursLeft < 0) return { text: `Overdue · ${date}`, cls: "bad" };
  return { text: `Due ${date}`, cls: hoursLeft < 48 ? "warn" : "neutral" };
};

const waitingFor = (receivedAt: string, now: Date): string => {
  const days = Math.floor((now.getTime() - new Date(receivedAt).getTime()) / DAY_MS);
  return days <= 0 ? "today" : days === 1 ? "1 day" : `${days} days`;
};

function UpcomingInterviewsCard({
  interviews,
  active,
  actions,
  onOpenJd,
  onDismissAction,
}: {
  interviews: UpcomingInterview[];
  active: GmailApplication[];
  actions: ActionItem[];
  onOpenJd: (key: string) => void;
  onDismissAction: (emailId: string) => void;
}) {
  const now = new Date();
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [briefs, setBriefs] = useState<Record<string, BriefState>>({});

  const load = async (key: string, regenerate = false) => {
    setBriefs((s) => ({ ...s, [key]: { ...s[key], loading: true, error: undefined } }));
    try {
      const data = await api.gmailInterviewBrief(key, regenerate);
      setBriefs((s) => ({ ...s, [key]: { loading: false, data } }));
    } catch (error) {
      setBriefs((s) => ({ ...s, [key]: { ...s[key], loading: false, error: errorText(error) } }));
    }
  };

  const toggle = (key: string) => {
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
    if (!briefs[key]?.data && !briefs[key]?.loading) void load(key);
  };

  const copy = async (key: string) => {
    const prompt = briefs[key]?.data?.prepPrompt;
    if (!prompt) return;
    await navigator.clipboard.writeText(prompt);
    setBriefs((s) => ({ ...s, [key]: { ...s[key]!, copied: true } }));
    window.setTimeout(() => setBriefs((s) => ({ ...s, [key]: { ...s[key]!, copied: false } })), 2000);
  };

  const panel = (key: string) => (
    <InterviewBriefPanel
      state={briefs[key]}
      onRegenerate={() => void load(key, true)}
      onCopy={() => void copy(key)}
      onOpenJd={() => onOpenJd(key)}
    />
  );

  const scheduledKeys = new Set(interviews.map((iv) => iv.key));
  const actionKeys = new Set(actions.map((a) => a.key));
  const unscheduled = active.filter((a) => !scheduledKeys.has(a.key) && !actionKeys.has(a.key));
  const firstRowByKey = new Map<string, string>();
  for (const iv of interviews) if (!firstRowByKey.has(iv.key)) firstRowByKey.set(iv.key, `${iv.key}-${iv.roundNumber}`);

  return (
    <div className="card stack" style={{ gap: "0.5rem" }}>
      <div className="rowBetween">
        <strong>Upcoming interviews</strong>
        <span className="muted smallText" title="Open applications with an upcoming interview or interview activity in the last 3 weeks">
          Interviewing now: {active.length === 0 ? "none" : active.map((a) => a.company).join(", ")}
        </span>
      </div>
      {actions.length > 0 && (
        <div className="stack" style={{ gap: "0.35rem" }}>
          <span className="briefHeading">Waiting on you</span>
          <table className="table">
            <tbody>
              {actions.map((a) => {
                const kind = ACTION_LABEL[a.type];
                const due = a.deadline ? deadlinePill(a.deadline, now) : null;
                const canPrep = !scheduledKeys.has(a.key);
                return (
                  <Fragment key={a.emailId}>
                    <tr>
                      <td style={{ whiteSpace: "nowrap" }}>
                        <span className={`pill ${kind.pill}`}>{kind.label}</span>
                      </td>
                      <td>
                        <strong>{a.company}</strong>
                        {a.role && <div className="muted smallText">{a.role}</div>}
                      </td>
                      <td>
                        {a.summary ?? ACTION_FALLBACK_SUMMARY[a.type]}
                        <div className="muted smallText">
                          Waiting {waitingFor(a.receivedAt, now)}
                          {due && (
                            <>
                              {" · "}
                              <span className={`pill ${due.cls}`}>{due.text}</span>
                            </>
                          )}
                        </div>
                      </td>
                      <td style={{ whiteSpace: "nowrap" }}>
                        <a href={a.gmailUrl} target="_blank" rel="noreferrer" className="smallText">
                          Open email
                        </a>
                        {canPrep && (
                          <>
                            {" · "}
                            <button
                              type="button"
                              className="linkButton smallText"
                              onClick={() => toggle(a.key)}
                              aria-expanded={open.has(a.key)}
                            >
                              Prep {open.has(a.key) ? "▾" : "▸"}
                            </button>
                          </>
                        )}
                        {" · "}
                        <button
                          type="button"
                          className="linkButton smallText"
                          title="Mark handled; it also clears on its own once you reply in that thread"
                          onClick={() => onDismissAction(a.emailId)}
                        >
                          Done
                        </button>
                      </td>
                    </tr>
                    {canPrep && open.has(a.key) && (
                      <tr>
                        <td colSpan={4}>{panel(a.key)}</td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {interviews.length === 0 ? (
        <span className="muted smallText">No confirmed interview times found in the last 60 days of email.</span>
      ) : (
        <table className="table">
          <tbody>
            {interviews.map((iv) => {
              const soon = new Date(iv.scheduledAt).getTime() - now.getTime() < DAY_MS;
              const rowId = `${iv.key}-${iv.roundNumber}`;
              const showBrief = open.has(iv.key) && firstRowByKey.get(iv.key) === rowId;
              return (
                <Fragment key={rowId}>
                  <tr>
                    <td style={{ whiteSpace: "nowrap" }}>
                      <span className={`pill ${soon ? "warn" : "good"}`}>{relativeDay(new Date(iv.scheduledAt), now)}</span>
                    </td>
                    <td style={{ whiteSpace: "nowrap" }}>{interviewWhen(iv)}</td>
                    <td>
                      <strong>{iv.company}</strong>
                      {iv.role && <div className="muted smallText">{iv.role}</div>}
                    </td>
                    <td>{iv.label}</td>
                    <td style={{ whiteSpace: "nowrap" }}>
                      <button
                        type="button"
                        className="linkButton smallText"
                        onClick={() => toggle(iv.key)}
                        aria-expanded={open.has(iv.key)}
                      >
                        Prep {open.has(iv.key) ? "▾" : "▸"}
                      </button>
                      {iv.gmailUrl && (
                        <>
                          {" · "}
                          <a href={iv.gmailUrl} target="_blank" rel="noreferrer" className="smallText">
                            Open email
                          </a>
                        </>
                      )}
                    </td>
                  </tr>
                  {showBrief && (
                    <tr>
                      <td colSpan={5}>{panel(iv.key)}</td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      )}
      {unscheduled.length > 0 && (
        <div className="stack" style={{ gap: "0.35rem" }}>
          <span className="muted smallText">Interviewing, no time on the calendar:</span>
          {unscheduled.map((a) => (
            <div key={a.key} className="stack" style={{ gap: "0.25rem" }}>
              <button
                type="button"
                className="linkButton smallText"
                style={{ alignSelf: "flex-start" }}
                onClick={() => toggle(a.key)}
                aria-expanded={open.has(a.key)}
              >
                {a.company}
                {a.role ? ` · ${a.role}` : ""} — Prep {open.has(a.key) ? "▾" : "▸"}
              </button>
              {open.has(a.key) && panel(a.key)}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function FitCell({
  evaluation,
  open,
  onToggle,
}: {
  evaluation?: EvaluationSummary;
  open: boolean;
  onToggle: () => void;
}) {
  if (evaluation?.fitTotal === undefined) return <span className="muted">—</span>;
  return (
    <div className="stack" style={{ gap: "0.2rem" }} title={`${fitTooltip(evaluation)}\n\nClick for full scoring details`}>
      <button
        type="button"
        className={`pill fitScore ${fitClass(evaluation.fitTotal)}`}
        onClick={onToggle}
        aria-expanded={open}
        style={{ cursor: "pointer", border: "none", font: "inherit" }}
      >
        {Math.round(evaluation.fitTotal)} {open ? "▾" : "▸"}
      </button>
      {evaluation.recommendedResume && (
        <span className="muted smallText">{evaluation.recommendedResume} resume</span>
      )}
      {evaluation.scoreRevised && <span className="muted smallText">Revised</span>}
      {evaluation.fingerprintStale && (
        <span
          className="muted smallText"
          title={`Approved revision ${evaluation.staleRevisionTotal ?? "—"} is not displayed because the stored evaluation changed.`}
        >
          Revision inactive
        </span>
      )}
      {(evaluation.fitBreakdown?.hardGates?.length ?? 0) > 0 && (
        <span className="muted smallText" title={evaluation.fitBreakdown!.hardGates!.join("\n")}>
          Hard gate
        </span>
      )}
    </div>
  );
}

const usd = (n: number | null | undefined) =>
  n == null ? "—" : n === 0 ? "$0" : n < 0.01 ? `${(n * 100).toFixed(2)}¢` : `$${n.toFixed(2)}`;

const FEATURE_LABEL: Record<LlmFeature, string> = {
  gmail_classify: "Email classification",
  jd_recovery: "JD scoring",
  top_jobs: "Top Jobs (alert parsing + scoring)",
  agent: "Next-steps agent",
  assistant: "Chat assistant",
  insights: "Application insights",
  other: "Other (tracker, assets)",
};

const FIT_TIERS = [
  { label: "Strong apply", min: 80 },
  { label: "Apply", min: 65 },
  { label: "Stretch", min: 50 },
  { label: "Weak", min: 0 },
] as const;

/** Short "after round 2" note for chips; the full round label goes in the tooltip. */
const reachedNote = (outcome: ApplicationStatus, p: RubricPoint): string | null => {
  if (outcome !== "rejected") return null;
  if (p.furthestRound) return `after round ${p.furthestRound.number}`;
  if (p.furthestStage && p.furthestStage !== "applied") return `after ${STATUS_LABEL[p.furthestStage].toLowerCase()}`;
  return null;
};

/** Hard-gated roles bottom out around 25, so the strip starts at 20 to use its width. */
const STRIP_MIN = 20;
const stripPct = (fit: number) => `${(Math.min(100, Math.max(STRIP_MIN, fit)) - STRIP_MIN) / (100 - STRIP_MIN) * 100}%`;

function FitStrip({ points, mean }: { points: RubricPoint[]; mean: number | null }) {
  const seen = new Map<number, number>();
  return (
    <div className="fitStrip" aria-hidden>
      <div className="fitStripTrack" />
      {[50, 65, 80].map((t) => (
        <div key={t} className="fitStripTick" style={{ left: stripPct(t) }}>
          <span>{t}</span>
        </div>
      ))}
      {points.map((p, i) => {
        const x = Math.round(p.fit);
        const stack = seen.get(x) ?? 0;
        seen.set(x, stack + 1);
        return (
          <span
            key={`${p.company}-${i}`}
            className={`fitStripDot ${fitClass(p.fit)}`}
            style={{ left: stripPct(x), top: `${14 - stack * 5}px` }}
            title={`${p.company} ${x}`}
          />
        );
      })}
      {mean !== null && <div className="fitStripMean" style={{ left: stripPct(mean) }} title={`Mean ${mean}`} />}
    </div>
  );
}

function FitOutcomeDetail({ rubric }: { rubric: RubricSummary }) {
  const rows = rubric.rows.filter((r) => r.count > 0);
  const reached = rubric.reachedInterview;
  return (
    <div className="stack" style={{ marginTop: "0.5rem" }}>
      <div className="stack" style={{ gap: "0.25rem" }}>
        <strong>Fit score vs outcome</strong>
        <span className="muted smallText">
          Each JD was scored blind to the outcome.
          {rubric.userVerified > 0 && ` ${rubric.userVerified} of ${rubric.scored} were picked or pasted by you (*).`}
          {rubric.scored < SMALL_SAMPLE * 2 && ` Only ${rubric.scored} scored so far, so read these as anecdotes.`}
          {reached && reached.count > 0 && (
            <>
              {" "}
              Reached an interview (any outcome after): {reached.count}, mean fit <strong>{reached.meanFit}</strong>.
            </>
          )}
        </span>
      </div>

      {rows.map((r) => {
        const points = rubric.points[r.outcome] ?? [];
        return (
          <section key={r.outcome} className="fitOutcome">
            <div className="fitOutcomeHead">
              <div className="fitOutcomeTitle">
                <strong>{STATUS_LABEL[r.outcome]}</strong>
                <span>
                  <span className="fitOutcomeMean">{r.meanFit ?? "—"}</span>
                  <span className="muted smallText"> avg</span>
                </span>
                <span className="muted smallText">
                  {r.count} scored{r.count < SMALL_SAMPLE ? " · small sample" : ""}
                </span>
              </div>
              <FitStrip points={points} mean={r.meanFit} />
            </div>
            <div className="fitTiers">
              {FIT_TIERS.map((tier, ti) => {
                const max = ti === 0 ? Infinity : FIT_TIERS[ti - 1]!.min;
                const inTier = points.filter((p) => p.fit >= tier.min && p.fit < max);
                if (inTier.length === 0) return null;
                return (
                  <div key={tier.label} className="fitTier">
                    <span className="fitTierLabel muted smallText">
                      {tier.label} <span className="fitTierCount">{inTier.length}</span>
                    </span>
                    <div className="fitTierChips">
                      {inTier.map((p, i) => {
                        const note = reachedNote(r.outcome, p);
                        return (
                          <span
                            key={`${p.company}-${i}`}
                            className="fitChip"
                            title={`${p.company}${p.role ? ` — ${p.role}` : ""}${p.furthestRound ? ` · reached ${p.furthestRound.label}` : ""}${p.verifiedBy === "user" ? " · picked by you" : ""}`}
                          >
                            <span className={`fitChipScore ${fitClass(p.fit)}`}>{Math.round(p.fit)}</span>
                            <span className="fitChipName">
                              {p.company}
                              {p.verifiedBy === "user" && <span className="muted"> *</span>}
                            </span>
                            {note && <span className="muted fitChipNote">{note}</span>}
                          </span>
                        );
                      })}
                    </div>
                  </div>
                );
              })}
            </div>
          </section>
        );
      })}
    </div>
  );
}

function CostCard({ costs }: { costs: CostSummary }) {
  const month = costs.thisMonth;
  const features = (Object.keys(costs.byFeature) as LlmFeature[]).filter(
    (f) => costs.byFeature[f].calls > 0 || (month?.byFeature[f] ?? 0) > 0 || month?.budgets[f] != null,
  );
  return (
    <div className="card stack">
      <strong>OpenAI cost</strong>
      {!costs.trackingSince ? (
        <p className="muted smallText">No calls recorded yet. Costs are tracked from now on ({costs.model}).</p>
      ) : (
        <>
          <div className="chipRow">
            <span className="pointChip">
              Today <strong>{usd(costs.today)}</strong>
            </span>
            <span className="pointChip">
              Last 7 days <strong>{usd(costs.last7Days)}</strong>
            </span>
            {month && (
              <span className="pointChip" title="All OpenAI spend since the 1st of this month">
                This month <strong>{usd(month.total)}</strong>
              </span>
            )}
            <span className="pointChip">
              Per scored role <strong>{usd(costs.perScoredRole)}</strong>
            </span>
            <span className="pointChip">
              Per email <strong>{usd(costs.perEmailClassified)}</strong>
            </span>
          </div>
          <table className="table">
            <thead>
              <tr>
                <th>Feature</th>
                <th>Last {costs.windowDays} days</th>
                <th>Cost</th>
                {month && <th>This month</th>}
              </tr>
            </thead>
            <tbody>
              {features.map((f) => {
                const cap = month?.budgets[f];
                return (
                  <tr key={f}>
                    <td>{FEATURE_LABEL[f]}</td>
                    <td>{costs.byFeature[f].calls} calls</td>
                    <td>{usd(costs.byFeature[f].costUsd)}</td>
                    {month && (
                      <td>
                        {usd(month.byFeature[f])}
                        {cap != null && <span className="muted"> of {usd(cap)} cap</span>}
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
          <span className="muted smallText">
            Estimated from OpenAI-reported tokens at {costs.model} list prices. Tracking since{" "}
            {formatDateTime(costs.trackingSince)}.
          </span>
        </>
      )}
    </div>
  );
}

const BUCKET_LABEL: Record<StageBucket, string> = {
  email: "Email (JD or posting link)",
  company_board: "Company job board (free APIs)",
  serper: "Serper web search",
  manual: "Pasted by you",
};

function MetricsCard({ metrics }: { metrics: RecoveryMetrics }) {
  const s = metrics.serper;
  const pct = (n: number, d: number) => (d ? `${Math.round((n / d) * 100)}%` : "—");
  return (
    <div className="card stack">
      <strong>Where the JDs came from</strong>
      <p className="smallText">
        Useful data for <strong>{metrics.withUsefulData}</strong> of {metrics.applications} applications (
        {pct(metrics.withUsefulData, metrics.applications)}): {metrics.verifiedAuto} verified automatically,{" "}
        {metrics.userPicked + metrics.userPasted} by you, {metrics.needsPick} waiting for your pick. {metrics.notFound}{" "}
        not found.
      </p>
      <table className="table">
        <thead>
          <tr>
            <th>Source</th>
            <th>Verified</th>
            <th>Candidates only</th>
          </tr>
        </thead>
        <tbody>
          {(Object.keys(metrics.byBucket) as StageBucket[]).map((b) => (
            <tr key={b}>
              <td>{BUCKET_LABEL[b]}</td>
              <td>{metrics.byBucket[b].verified}</td>
              <td>{metrics.byBucket[b].candidatesOnly}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <span className="smallText">
        Serper: searched {s.jobsSearched} jobs, results for {s.jobsWithResults}, useful for{" "}
        <strong>{s.verified + s.candidatesOnly}</strong> ({s.verified} verified, {s.candidatesOnly} candidates only).
      </span>
      <span className="muted smallText">
        {s.queriesUsed} of {s.budget} query budget used ({s.freeGrant.toLocaleString()} free one-time Serper credits).
      </span>
    </div>
  );
}

function JdMatchCell({
  evaluation,
  role,
  open,
  onToggle,
}: {
  evaluation?: EvaluationSummary;
  role?: string | null;
  open: boolean;
  onToggle: () => void;
}) {
  if (!evaluation) return <span className="muted">Not checked yet</span>;
  const { status, matchLevel, url, verifiedBy } = evaluation;
  const [label, pill] =
    status === "scored"
      ? verifiedBy === "user"
        ? ["You picked", "good"]
        : matchLevel === "exact"
          ? ["Exact (req ID)", "good"]
          : ["High match", "good"]
      : status === "unverified"
        ? ["Needs your pick", "warn"]
        : status === "fetch_failed"
          ? ["Fetch failed", "bad"]
          : ["Not found", "bad"];
  const badge = <span className={`pill ${pill}`}>{label}</span>;
  const firstNote = evaluation.notes?.[0] ?? evaluation.reason;
  return (
    <div className="stack" style={{ gap: "0.2rem" }} title={detailsTooltip(evaluation)}>
      {url ? (
        <a href={url} target="_blank" rel="noreferrer">
          {badge}
        </a>
      ) : (
        badge
      )}
      {status === "scored" &&
        evaluation.jdTitle &&
        evaluation.jdTitle.trim().toLowerCase() !== (role ?? "").trim().toLowerCase() && (
          <span className="muted smallText">{evaluation.jdTitle}</span>
        )}
      {status !== "scored" && firstNote && <span className="muted smallText">{reasonLabel(firstNote)}</span>}
      {status !== "scored" && evaluation.boardChecks?.[0] && (
        <span className="muted smallText">{boardCheckLabel(evaluation.boardChecks[0])}</span>
      )}
      {evaluation.recoveredRole && (
        <span className="muted smallText">role from email: {evaluation.recoveredRole}</span>
      )}
      {status !== "scored" && (
        <button className="btn-secondary smallText" onClick={onToggle}>
          {open ? "Close" : evaluation.candidates?.length ? `Review (${evaluation.candidates.length})` : "Paste JD"}
        </button>
      )}
      {status === "scored" && (
        <button type="button" className="btn-secondary smallText" onClick={onToggle}>
          {open ? "Close" : "Update title"}
        </button>
      )}
    </div>
  );
}

function ReviewPanel({
  app,
  onScored,
}: {
  app: GmailApplication;
  onScored: (evaluation: EvaluationSummary) => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [url, setUrl] = useState("");
  const candidates = app.evaluation?.candidates ?? [];

  const run = async (id: string, action: () => Promise<{ evaluation: EvaluationSummary }>) => {
    setBusy(id);
    setError(null);
    try {
      onScored((await action()).evaluation);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="reviewPanel stack">
      <span className="muted smallText">
        The scorer only sees the JD text, never the email or outcome. Scoring takes about a minute.
      </span>
      {candidates.length > 0 && (
        <div className="stack" style={{ gap: "0.4rem" }}>
          <strong>Is it one of these?</strong>
          {candidates.map((c) => {
            const id = c.prospectId ?? c.url ?? c.title ?? "candidate";
            const label = c.title ?? c.url ?? "Saved prospect";
            const partial = c.completeness === "partial";
            return (
              <div key={id} className="rowBetween">
                <span>
                  {c.url ? (
                    <a href={c.url} target="_blank" rel="noreferrer">
                      {label}
                    </a>
                  ) : (
                    label
                  )}
                  {c.location && <span className="muted"> · {c.location}</span>}
                  {c.sourceType && <span className="muted smallText"> · {c.sourceType}</span>}
                  <span className="muted smallText"> · {c.matchLevel} match</span>
                  {partial && <span className="muted smallText"> · partial JD, not eligible to score</span>}
                </span>
                <button
                  disabled={busy !== null || partial}
                  onClick={() => void run(id, () => api.gmailConfirmCandidate(app.key, { url: c.url, prospectId: c.prospectId }))}
                >
                  {busy === id ? "Scoring…" : "This is the one"}
                </button>
              </div>
            );
          })}
        </div>
      )}
      <div className="stack" style={{ gap: "0.4rem" }}>
        <strong>{candidates.length ? "Or paste the JD" : "Paste the JD"}</strong>
        <textarea value={text} onChange={(e) => setText(e.target.value)} placeholder="Paste the full job description" />
        <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="Posting URL (optional)" />
        <div>
          <button
            disabled={busy !== null || text.trim().length < MIN_PASTED_JD_CHARS}
            onClick={() => void run("paste", () => api.gmailPasteJd(app.key, text, url))}
          >
            {busy === "paste" ? "Scoring…" : "Score pasted JD"}
          </button>
          {text.trim().length > 0 && text.trim().length < MIN_PASTED_JD_CHARS && (
            <span className="muted smallText"> At least {MIN_PASTED_JD_CHARS} characters.</span>
          )}
        </div>
      </div>
      {error && <p className="error">{error}</p>}
    </div>
  );
}

function TitlePanel({
  app,
  onUpdated,
}: {
  app: GmailApplication;
  onUpdated: (evaluation: EvaluationSummary) => void;
}) {
  const [title, setTitle] = useState(app.role ?? app.evaluation?.jdTitle ?? "");
  const [text, setText] = useState("");
  const [pasteOpen, setPasteOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = async (id: string, body: { title?: string; text?: string }) => {
    setBusy(id);
    setError(null);
    try {
      const { evaluation } = await api.gmailUpdateTitle(app.key, body);
      if (evaluation.jdTitle) setTitle(evaluation.jdTitle);
      onUpdated(evaluation);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="reviewPanel stack">
      <span className="muted smallText">
        Fixes the role label only. The fit score stays as scored.
      </span>
      <label className="stack" style={{ gap: "0.25rem" }}>
        <strong>Title</strong>
        <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Forward Deployed Engineer" />
      </label>
      <div>
        <button disabled={busy !== null || title.trim().length < 2} onClick={() => void run("save", { title })}>
          {busy === "save" ? "Saving…" : "Save title"}
        </button>
      </div>
      <button type="button" className="btn-secondary smallText" onClick={() => setPasteOpen((o) => !o)}>
        {pasteOpen ? "Hide paste" : "Or paste the JD to extract the title"}
      </button>
      {pasteOpen && (
        <div className="stack" style={{ gap: "0.4rem" }}>
          <textarea value={text} onChange={(e) => setText(e.target.value)} placeholder="Paste the full job description" />
          <div>
            <button
              disabled={busy !== null || text.trim().length < MIN_PASTED_JD_CHARS}
              onClick={() => void run("paste", { text })}
            >
              {busy === "paste" ? "Reading…" : "Use title from paste"}
            </button>
            {text.trim().length > 0 && text.trim().length < MIN_PASTED_JD_CHARS && (
              <span className="muted smallText"> At least {MIN_PASTED_JD_CHARS} characters.</span>
            )}
          </div>
        </div>
      )}
      {error && <p className="error">{error}</p>}
    </div>
  );
}

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

const readWindow = (): WindowDays => {
  const stored = Number(window.localStorage.getItem(WINDOW_STORAGE_KEY));
  return (WINDOW_OPTIONS as readonly number[]).includes(stored) ? (stored as WindowDays) : 7;
};

export function DashboardPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [status, setStatus] = useState<GmailStatus | null>(null);
  const [applications, setApplications] = useState<GmailApplication[]>([]);
  const [syncing, setSyncing] = useState(false);
  const [notice, setNotice] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [updatingKey, setUpdatingKey] = useState<string | null>(null);
  const [pendingRecovery, setPendingRecovery] = useState(0);
  const [upcoming, setUpcoming] = useState<UpcomingInterview[]>([]);
  const [actions, setActions] = useState<ActionItem[]>([]);
  const [evaluations, setEvaluations] = useState<EvaluationsResponse | null>(null);
  const [windowDays, setWindowDays] = useState<WindowDays>(readWindow);
  const [filter, setFilter] = useState<RecoveryFilter>("all");
  const [reviewKey, setReviewKey] = useState<string | null>(null);
  const [scoringKey, setScoringKey] = useState<string | null>(null);
  const autoSynced = useRef(false);

  const loadEvaluations = useCallback(async () => {
    const result = await api.gmailEvaluations(windowDays);
    setEvaluations(result);
    return result;
  }, [windowDays]);

  const loadApplications = useCallback(async () => {
    const { applications: items, pendingRecovery: pending, upcomingInterviews, actionItems } =
      await api.gmailApplications(windowDays);
    setApplications(items);
    setPendingRecovery(pending);
    setUpcoming(upcomingInterviews ?? []);
    setActions(actionItems ?? []);
    await loadEvaluations().catch(() => null);
  }, [windowDays, loadEvaluations]);

  const afterRecoveryStart = useCallback(
    async (start?: RecoveryStart) => {
      if (start?.started || start?.running) await loadEvaluations().catch(() => null);
    },
    [loadEvaluations],
  );

  const runSync = useCallback(async () => {
    setSyncing(true);
    setNotice(null);
    try {
      const result = await api.gmailSync(windowDays);
      setApplications(result.applications);
      setPendingRecovery(result.pendingRecovery);
      setUpcoming(result.upcomingInterviews ?? []);
      setActions(result.actionItems ?? []);
      setStatus(await api.gmailStatus());
      await afterRecoveryStart(result.recovery);
      if (result.rateLimited) {
        setNotice({
          kind: "error",
          text: `Gmail's per-minute limit was hit; ${result.deferred ?? 0} email(s) will be picked up on the next sync. Wait a minute and sync again to finish now.`,
        });
      } else if (result.llmFailures > 0) {
        setNotice({
          kind: "error",
          text: `${result.llmFailures} email(s) couldn't be classified; they'll be retried on the next sync.`,
        });
      } else if (result.trackerAdded) {
        setNotice({
          kind: "ok",
          text: `Added ${result.trackerAdded} scored application${result.trackerAdded === 1 ? "" : "s"} to the tracker.`,
        });
      }
    } catch (error) {
      setNotice({ kind: "error", text: errorText(error) });
      setStatus(await api.gmailStatus().catch(() => null));
    } finally {
      setSyncing(false);
    }
  }, [windowDays, afterRecoveryStart]);

  useEffect(() => {
    const flag = searchParams.get("gmail");
    if (flag) {
      setNotice(
        flag === "connected"
          ? { kind: "ok", text: "Gmail connected." }
          : { kind: "error", text: "Gmail connection failed or was cancelled. Try again." },
      );
      searchParams.delete("gmail");
      setSearchParams(searchParams, { replace: true });
    }
    // Only read the OAuth redirect flag once on mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    window.localStorage.setItem(WINDOW_STORAGE_KEY, String(windowDays));
  }, [windowDays]);

  useEffect(() => {
    void (async () => {
      try {
        const s = await api.gmailStatus();
        setStatus(s);
        if (!s.connected) return;
        await loadApplications();
        const stale = !s.lastSyncAt || Date.now() - new Date(s.lastSyncAt).getTime() > AUTO_SYNC_AFTER_MS;
        if (stale && !autoSynced.current) {
          autoSynced.current = true;
          await runSync();
        }
      } catch (error) {
        setNotice({ kind: "error", text: errorText(error) });
      }
    })();
  }, [loadApplications, runSync]);

  const lastSyncAt = status?.lastSyncAt;
  const autoSyncOn = Boolean(status?.connected && status.autoSyncMinutes);

  useEffect(() => {
    if (!autoSyncOn) return;
    const timer = window.setInterval(() => {
      void (async () => {
        try {
          const s = await api.gmailStatus();
          if (s.lastSyncAt === lastSyncAt) return;
          setStatus(s);
          if (!syncing) await loadApplications();
        } catch {
          // Background check only; the next poll or a manual sync will surface errors.
        }
      })();
    }, STATUS_POLL_MS);
    return () => window.clearInterval(timer);
  }, [autoSyncOn, lastSyncAt, syncing, loadApplications]);

  const recoveryRunning = evaluations?.run.running ?? false;

  useEffect(() => {
    if (!recoveryRunning) return;
    const timer = window.setInterval(() => {
      void (async () => {
        try {
          const result = await loadEvaluations();
          if (!result.run.running) {
            await loadApplications();
            if (result.run.error) setNotice({ kind: "error", text: `JD recovery failed: ${result.run.error}` });
          }
        } catch (error) {
          setNotice({ kind: "error", text: errorText(error) });
        }
      })();
    }, RECOVERY_POLL_MS);
    return () => window.clearInterval(timer);
  }, [recoveryRunning, loadEvaluations, loadApplications]);

  const onRecover = async () => {
    setNotice(null);
    try {
      const result = await api.gmailRunRecovery(windowDays);
      if (!result.started && !result.running) {
        setNotice({ kind: "ok", text: "Nothing to recover." });
        return;
      }
      await afterRecoveryStart(result);
    } catch (error) {
      setNotice({ kind: "error", text: errorText(error) });
    }
  };

  const onDisconnect = async () => {
    if (!window.confirm("Disconnect Gmail? Cached results stay until you reconnect.")) return;
    try {
      await api.gmailDisconnect();
      setStatus(await api.gmailStatus());
      setApplications([]);
    } catch (error) {
      setNotice({ kind: "error", text: errorText(error) });
    }
  };

  const onUpdateTracker = async (app: GmailApplication) => {
    if (!app.trackerJobId || !app.suggestedStatus) return;
    setUpdatingKey(app.key);
    try {
      await api.updateStatus(
        app.trackerJobId,
        app.suggestedStatus,
        `From Gmail: ${app.emails[0]?.subject ?? STATUS_LABEL[app.status]}`,
      );
      await loadApplications();
    } catch (error) {
      setNotice({ kind: "error", text: errorText(error) });
    } finally {
      setUpdatingKey(null);
    }
  };

  const onScored = (key: string, evaluation: EvaluationSummary, replaceTitle = false) => {
    setApplications((apps) =>
      apps.map((a) =>
        a.key === key
          ? {
              ...a,
              role: replaceTitle ? (evaluation.jdTitle ?? a.role) : (a.role ?? evaluation.jdTitle ?? a.role),
              evaluation,
            }
          : a,
      ),
    );
    setReviewKey(null);
    // Reload applications so a newly auto-added tracker row is linked (same as recovery poll).
    void loadApplications().catch(() => null);
  };

  const counts = STATUS_ORDER.map((s) => ({
    status: s,
    count: applications.filter((a) => (s === "interviewing" ? reachedInterview(a) : a.status === s)).length,
  }));
  const activeInterviews = applications.filter((a) => a.activelyInterviewing);

  const openJdReview = (key: string) => {
    setFilter("all");
    setReviewKey(key);
    window.setTimeout(() => document.getElementById(`app-row-${key}`)?.scrollIntoView({ behavior: "smooth", block: "center" }), 0);
  };

  const filterCounts = (Object.keys(FILTER_LABEL) as RecoveryFilter[]).map((f) => ({
    filter: f,
    count: f === "all" ? applications.length : applications.filter((a) => filterOf(a) === f).length,
  }));
  const visible = filter === "all" ? applications : applications.filter((a) => filterOf(a) === filter);
  const rubric = evaluations?.rubricSummary;

  return (
    <section className="stack">
      <div className="rowBetween">
        <div className="row" style={{ alignItems: "center", gap: "0.75rem" }}>
          <h2 style={{ margin: 0 }}>Applications</h2>
          <select value={windowDays} onChange={(e) => setWindowDays(Number(e.target.value) as WindowDays)}>
            {WINDOW_OPTIONS.map((d) => (
              <option key={d} value={d}>
                Last {d} days
              </option>
            ))}
          </select>
        </div>
        <Link to="/addjob">+ Add a job</Link>
      </div>

      {notice && <p className={notice.kind === "error" ? "error" : "muted"}>{notice.text}</p>}

      {!status && <p className="muted">Loading…</p>}

      {status && !status.configured && (
        <div className="card stack">
          <strong>Gmail isn't set up yet</strong>
          <p className="muted">
            Create a Google Cloud OAuth client (type "Web application", Gmail API enabled) with redirect URI{" "}
            <code>http://localhost:4000/api/gmail/oauth/callback</code>, then set <code>GOOGLE_CLIENT_ID</code> and{" "}
            <code>GOOGLE_CLIENT_SECRET</code> in the root <code>.env</code> and restart the API.
          </p>
        </div>
      )}

      {status?.configured && !status.connected && (
        <div className="card stack">
          <strong>{status.needsReconnect ? "Gmail access expired" : "Connect Gmail"}</strong>
          <p className="muted">
            {status.needsReconnect
              ? "Google expired or revoked access (Testing-mode apps expire after 7 days). Reconnect to keep syncing."
              : "Read access to find applications and status updates, plus permission to create drafts (never send) for emails you approve."}
          </p>
          <div>
            <a href={api.gmailConnectUrl}>
              <button>{status.needsReconnect ? "Reconnect Gmail" : "Connect Gmail"}</button>
            </a>
          </div>
        </div>
      )}

      {status?.connected && status.extraScopes && status.extraScopes.length > 0 && (
        <p className="card error-text smallText">
          Gmail granted more access than this app asks for ({status.extraScopes.join(", ")}). Remove the app in your
          Google account&apos;s third-party access settings, then reconnect.
        </p>
      )}
      {status?.connected && !status.canCreateDrafts && (
        <p className="card smallText">
          Reconnect Gmail to let approved emails become Gmail drafts (create-only; the app can never send).{" "}
          <a href={api.gmailConnectUrl}>Reconnect Gmail</a>
        </p>
      )}

      {status?.connected && (
        <>
          <div className="rowBetween">
            <span className="muted">
              {status.email ?? "Gmail"} · {status.lastSyncAt ? `last synced ${formatDateTime(status.lastSyncAt)}` : "not synced yet"}
              {status.autoSyncMinutes
                ? ` · auto-syncs every ${status.autoSyncMinutes === 60 ? "hour" : `${status.autoSyncMinutes} min`}`
                : ""}
            </span>
            <div className="row">
              <button
                className="btn-secondary"
                onClick={() => void onRecover()}
                disabled={syncing || recoveryRunning || pendingRecovery === 0}
                title="Find each application's job description and score it (newest first). Also runs after every sync."
              >
                {recoveryRunning
                  ? `Recovering JDs… (${evaluations?.run.processed ?? 0} done)`
                  : `Recover JDs (${pendingRecovery} pending)`}
              </button>
              <button onClick={() => void runSync()} disabled={syncing}>
                {syncing ? "Syncing…" : "Sync now"}
              </button>
              <button className="btn-secondary" onClick={() => void onDisconnect()} disabled={syncing}>
                Disconnect
              </button>
            </div>
          </div>

          <NextStepsCard onTrackerChanged={() => void loadApplications()} />

          <UpcomingInterviewsCard
            interviews={upcoming}
            active={activeInterviews}
            actions={actions}
            onOpenJd={openJdReview}
            onDismissAction={(emailId) => {
              setActions((list) => list.filter((a) => a.emailId !== emailId));
              void api.gmailDismissAction(emailId).catch((error) => {
                setNotice({ kind: "error", text: errorText(error) });
                void loadApplications();
              });
            }}
          />

          <div className="grid" style={{ gridTemplateColumns: "repeat(5, minmax(0, 1fr))" }}>
            {counts.map(({ status: s, count }) => (
              <div key={s} className="card" title={STATUS_CARD_HINT[s]}>
                <div className="muted">{STATUS_LABEL[s]}</div>
                <div className="statNumber">{count}</div>
              </div>
            ))}
          </div>

          {evaluations && !evaluations.serper.configured && (
            <p className="muted smallText">
              Web search fallback is off (add <code>SERPER_API_KEY</code> to enable it). Free job-board lookups still run.
            </p>
          )}
          {evaluations?.serper.configured && evaluations.serper.used >= evaluations.serper.cap && (
            <p className="muted smallText">
              Web search budget used up ({evaluations.serper.used}/{evaluations.serper.cap} queries). Free job-board
              lookups still run.
            </p>
          )}
          {evaluations?.serper.configured &&
            evaluations.serper.used < evaluations.serper.cap &&
            evaluations.serper.cap - evaluations.serper.used <= evaluations.serper.cap * SERPER_LOW_BUDGET_SHARE && (
              <p className="card smallText">
                <strong>Serper budget running low:</strong> {evaluations.serper.cap - evaluations.serper.used} of{" "}
                {evaluations.serper.cap} queries left. Serper's free credits are one-time, so plan to raise{" "}
                <code>SERPER_MAX_QUERIES_TOTAL</code> (up to the 2,500 free grant), switch to a provider with a recurring
                free tier, or remove <code>SERPER_API_KEY</code> and pick from board candidates yourself.
              </p>
            )}

          {(evaluations?.costs || evaluations?.metrics) && (
            <div className="grid" style={{ gridTemplateColumns: "repeat(2, minmax(0, 1fr))" }}>
              {evaluations.costs && <CostCard costs={evaluations.costs} />}
              {evaluations.metrics && <MetricsCard metrics={evaluations.metrics} />}
            </div>
          )}

          <InsightsCard>{rubric && rubric.scored > 0 && <FitOutcomeDetail rubric={rubric} />}</InsightsCard>

          <div className="card stack">
            {applications.length > 0 && (
              <div className="chipRow">
                {filterCounts.map(({ filter: f, count }) => (
                  <button key={f} className={`chip${filter === f ? " active" : ""}`} onClick={() => setFilter(f)}>
                    {FILTER_LABEL[f]}
                    <strong>{count}</strong>
                  </button>
                ))}
              </div>
            )}
            {applications.length === 0 ? (
              <p className="muted">
                {syncing ? "Scanning your inbox…" : `No application emails found in the last ${windowDays} days.`}
              </p>
            ) : (
              <table className="table">
                <thead>
                  <tr>
                    <th>Company</th>
                    <th>Role</th>
                    <th>Applied</th>
                    <th>Status</th>
                    <th>Fit</th>
                    <th>JD match</th>
                    <th>Tracker</th>
                  </tr>
                </thead>
                <tbody>
                  {visible.map((app) => (
                    <Fragment key={app.key}>
                      <tr id={`app-row-${app.key}`}>
                        <td>{app.company}</td>
                        <td>
                          {app.role ?? app.evaluation?.jdTitle ?? <span className="muted">Role not stated</span>}
                          <details>
                            <summary className="muted smallText">
                              {app.emails.length} email{app.emails.length === 1 ? "" : "s"} · updated{" "}
                              {formatDate(app.lastUpdateAt)}
                            </summary>
                            <ul>
                              {app.emails.map((email) => (
                                <li key={email.id}>
                                  <a href={email.gmailUrl} target="_blank" rel="noreferrer">
                                    {email.subject || "(no subject)"}
                                  </a>{" "}
                                  <span className="muted">
                                    · {formatDate(email.date)} · {email.eventType}
                                    {email.round ? ` (round ${email.round})` : ""}
                                  </span>
                                </li>
                              ))}
                            </ul>
                          </details>
                        </td>
                        <td>
                          {app.appliedAtKnown === false ? (
                            <>
                              <span className="muted">Before {formatDate(app.appliedAt)}</span>
                              <div
                                className="muted smallText"
                                title="No application confirmation email or tracker applied date was found; you applied on or before the earliest email."
                              >
                                date unknown
                              </div>
                            </>
                          ) : (
                            <>
                              {formatDate(app.appliedAt)}
                              {app.appliedAtSource === "tracker" && (
                                <div className="muted smallText" title="No confirmation email in this window; date applied comes from the tracker.">
                                  from tracker
                                </div>
                              )}
                            </>
                          )}
                        </td>
                        <td>
                          <span className={`pill ${STATUS_PILL[app.status]}`}>{statusPillLabel(app)}</span>
                          <StageNote app={app} />
                        </td>
                        <td>
                          <FitCell
                            evaluation={app.evaluation}
                            open={scoringKey === app.key}
                            onToggle={() => setScoringKey(scoringKey === app.key ? null : app.key)}
                          />
                        </td>
                        <td>
                          <JdMatchCell
                            evaluation={app.evaluation}
                            role={app.role ?? app.evaluation?.jdTitle}
                            open={reviewKey === app.key}
                            onToggle={() => setReviewKey(reviewKey === app.key ? null : app.key)}
                          />
                        </td>
                        <td>
                          {app.trackerJobId ? (
                            <div className="stack" style={{ gap: "0.35rem" }}>
                              <Link to={`/jobs/${app.trackerJobId}/detail`}>
                                In tracker: {JOB_STATUS_LABEL[app.trackerStatus!] ?? app.trackerStatus}
                              </Link>
                              {app.suggestedStatus && (
                                <button
                                  className="btn-secondary"
                                  disabled={updatingKey === app.key}
                                  onClick={() => void onUpdateTracker(app)}
                                >
                                  {updatingKey === app.key
                                    ? "Updating…"
                                    : `Update to ${JOB_STATUS_LABEL[app.suggestedStatus] ?? app.suggestedStatus}`}
                                </button>
                              )}
                            </div>
                          ) : app.evaluation?.fitTotal === undefined ? (
                            <span className="muted" title="Scored applications are added to the tracker automatically">
                              Not in tracker · adds once scored
                            </span>
                          ) : (
                            <span className="muted">Not in tracker</span>
                          )}
                        </td>
                      </tr>
                      {scoringKey === app.key && app.evaluation?.fitTotal !== undefined && (
                        <tr>
                          <td colSpan={7}>
                            <ScoringDetailsPanel
                              appKey={app.key}
                              onEffectiveScoreChange={() => void loadApplications().catch(() => null)}
                            />
                          </td>
                        </tr>
                      )}
                      {reviewKey === app.key && app.evaluation && (
                        <tr>
                          <td colSpan={7}>
                            {app.evaluation.status === "scored" ? (
                              <TitlePanel app={app} onUpdated={(e) => onScored(app.key, e, true)} />
                            ) : (
                              <ReviewPanel app={app} onScored={(e) => onScored(app.key, e)} />
                            )}
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </>
      )}
    </section>
  );
}
