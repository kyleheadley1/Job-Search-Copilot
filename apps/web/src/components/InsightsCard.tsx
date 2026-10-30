import { useCallback, useEffect, useState, type ReactNode } from "react";
import { api } from "../api/client";
import type {
  CoverageCounts,
  InsightsPanel,
  PatternRow,
  ScreeningAnalysis,
  ScoringAdjustment,
  UnscoredReason,
  Verdict,
} from "../types/insights";

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

const pct = (x: number) => `${(x * 100).toFixed(x > 0 && x < 0.1 ? 1 : 0)}%`;

const VERDICT: Record<Verdict, { label: string; pill: string }> = {
  conclusive: { label: "Conclusive", pill: "good" },
  suggestive: { label: "Worth watching", pill: "warn" },
  no_signal: { label: "Looks like chance", pill: "neutral" },
};

const shortDate = (iso: string) => new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });

/** Bars share one scale so the widest upper bound fills the track. */
function RateBar({ rate, lo, hi, scale }: { rate: number; lo: number; hi: number; scale: number }) {
  const at = (x: number) => `${Math.min(100, (x / scale) * 100)}%`;
  return (
    <div className="insightBar" aria-hidden>
      <div className="insightBarFill" style={{ width: at(rate) }} />
      <div className="insightBarWhisker" style={{ left: at(lo), width: `calc(${at(hi)} - ${at(lo)})` }} />
    </div>
  );
}

const UNSCORED_LABEL: Record<UnscoredReason, string> = {
  not_found: "posting not found",
  fetch_failed: "could not fetch JD",
  unverified: "ambiguous match",
  triage_failed: "scoring failed",
  tracker_never_scored: "tracker row never scored",
  no_jd: "no JD stored",
};

function CoverageSection({ counts }: { counts: CoverageCounts }) {
  const withoutFit = counts.withoutFit ?? Math.max(0, counts.decided - counts.withFit);
  const reasonParts = Object.entries(counts.unscoredReasons ?? {})
    .filter(([, n]) => (n ?? 0) > 0)
    .map(([reason, n]) => `${UNSCORED_LABEL[reason as UnscoredReason] ?? reason} ${n}`);
  return (
    <section className="stack" style={{ gap: "0.35rem" }}>
      <strong className="smallText">What this analysis covers</strong>
      <table className="table smallText">
        <tbody>
          <tr>
            <td>Decided applications</td>
            <td>{counts.decided}</td>
          </tr>
          <tr>
            <td>With fit score</td>
            <td>{counts.withFit}</td>
          </tr>
          <tr>
            <td>Without fit score</td>
            <td>{withoutFit}</td>
          </tr>
          {counts.scoredCallbacks != null && (
            <tr>
              <td>Callbacks among scored</td>
              <td>{counts.scoredCallbacks}</td>
            </tr>
          )}
          {counts.unscoredCallbacks != null && (
            <tr>
              <td>Callbacks outside scored group</td>
              <td>{counts.unscoredCallbacks}</td>
            </tr>
          )}
          <tr>
            <td>Recent, not yet mature</td>
            <td>{counts.tooEarly}</td>
          </tr>
          {counts.confirmedApplied != null && (
            <tr>
              <td>Confirmed applied date</td>
              <td>{counts.confirmedApplied}</td>
            </tr>
          )}
          {counts.inferredApplied != null && (
            <tr>
              <td>Inferred applied date</td>
              <td>{counts.inferredApplied}</td>
            </tr>
          )}
        </tbody>
      </table>
      {reasonParts.length > 0 && <span className="muted smallText">Why no score: {reasonParts.join(" · ")}</span>}
    </section>
  );
}

function ScreeningSection({ screening }: { screening: ScreeningAnalysis }) {
  const spec = screening.specialized;
  return (
    <section className="stack" style={{ gap: "0.35rem" }}>
      <strong className="smallText">Seniority and screening</strong>
      <span className="muted smallText">
        Descriptive rates only — with few callbacks, cells are not a hiring rule. Campus programs are separate from
        ordinary junior openings. AI / FDE is a cross-cut, not a seniority band.
      </span>
      <table className="table smallText">
        <thead>
          <tr>
            <th>Role classification</th>
            <th>Applied</th>
            <th>Callbacks</th>
            <th>Rate</th>
          </tr>
        </thead>
        <tbody>
          {(screening.seniority ?? []).map((row) => (
            <tr key={row.bucket}>
              <td>{row.bucket}</td>
              <td>{row.n}</td>
              <td>{row.k}</td>
              <td title={`95% range ${pct(row.rate.lo)}-${pct(row.rate.hi)}`}>{row.n ? pct(row.rate.rate) : "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {screening.seniorityUnknown > 0 && (
        <span className="muted smallText">{screening.seniorityUnknown} decided applications have no seniority signal.</span>
      )}
      <table className="table smallText">
        <thead>
          <tr>
            <th>Degree on the posting</th>
            <th>Applied</th>
            <th>Callbacks</th>
            <th>Rate</th>
          </tr>
        </thead>
        <tbody>
          {(screening.degree ?? []).map((row) => (
            <tr key={row.bucket}>
              <td>{row.bucket}</td>
              <td>{row.n}</td>
              <td>{row.k}</td>
              <td title={`95% range ${pct(row.rate.lo)}-${pct(row.rate.hi)}`}>{row.n ? pct(row.rate.rate) : "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {screening.degreeUnknown > 0 && (
        <span className="muted smallText">{screening.degreeUnknown} decided applications have no degree field.</span>
      )}
      {spec && (
        <span className="smallText">
          Specialized AI / FDE: {spec.k}/{spec.n} ({spec.n ? pct(spec.rate.rate) : "—"}) vs {spec.restK}/{spec.restN} other
          classified roles
          {screening.specializedUnknown > 0 ? `; ${screening.specializedUnknown} unclassified` : ""}.
        </span>
      )}
      {(screening.bySeniorityAndDegree ?? []).some((c) => c.n > 0) && (
        <details>
          <summary className="smallText">Seniority × degree</summary>
          <table className="table smallText">
            <thead>
              <tr>
                <th>Seniority</th>
                <th>Degree</th>
                <th>Applied</th>
                <th>Callbacks</th>
              </tr>
            </thead>
            <tbody>
              {(screening.bySeniorityAndDegree ?? [])
                .filter((c) => c.n > 0)
                .map((c) => (
                  <tr key={`${c.seniority}|${c.degree}`}>
                    <td>{c.seniority}</td>
                    <td>{c.degree}</td>
                    <td>{c.n}</td>
                    <td>
                      {c.k} ({pct(c.rate.rate)})
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
        </details>
      )}
    </section>
  );
}

function PatternTable({ rows }: { rows: PatternRow[] }) {
  return (
    <table className="table smallText">
      <thead>
        <tr>
          <th>Pattern</th>
          <th>Heard back: this group</th>
          <th>Everyone else</th>
          <th />
        </tr>
      </thead>
      <tbody>
        {rows.map((p) => (
          <tr key={`${p.feature}=${p.bucket}`}>
            <td>
              <span className="muted">{p.featureLabel}:</span> {p.bucket}
              {(p.unknownN ?? 0) > 0 && <div className="muted smallText">{p.unknownN} unclassified</div>}
            </td>
            <td title={`95% range ${pct(p.rate.lo)}-${pct(p.rate.hi)}`}>
              {p.k}/{p.n} ({pct(p.rate.rate)})
            </td>
            <td>
              {p.restK}/{p.restN} ({pct(p.restRate)})
            </td>
            <td title={`Adjusted for the ${rows.length > 1 ? "many patterns" : "pattern"} tested (q = ${p.q.toFixed(2)})`}>
              <span className={`pill ${VERDICT[p.verdict].pill}`}>{VERDICT[p.verdict].label}</span>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function AdjustmentRow({
  a,
  busy,
  onAction,
}: {
  a: ScoringAdjustment;
  busy: boolean;
  onAction: (action: "approve" | "dismiss" | "disable") => void;
}) {
  const sign = a.points > 0 ? "+" : "";
  return (
    <tr>
      <td>
        <strong>
          {sign}
          {a.points}
        </strong>{" "}
        for {a.featureLabel.toLowerCase()}: {a.bucket}
        <div className="muted smallText">
          {a.evidence.k}/{a.evidence.n} heard back ({pct(a.evidence.rate)}) vs {pct(a.evidence.restRate)} for the rest
        </div>
      </td>
      <td className="smallText muted">{a.status === "approved" ? "Applied to new scores" : a.status}</td>
      <td style={{ whiteSpace: "nowrap" }}>
        {a.status === "proposed" && (
          <>
            <button type="button" onClick={() => onAction("approve")} disabled={busy}>
              Approve
            </button>{" "}
            <button type="button" className="btn-secondary" onClick={() => onAction("dismiss")} disabled={busy}>
              Dismiss
            </button>
          </>
        )}
        {a.status === "approved" && (
          <button type="button" className="btn-secondary" onClick={() => onAction("disable")} disabled={busy}>
            Turn off
          </button>
        )}
        {a.status === "disabled" && (
          <button type="button" className="btn-secondary" onClick={() => onAction("approve")} disabled={busy}>
            Turn back on
          </button>
        )}
      </td>
    </tr>
  );
}

/** Callback patterns across tracker and Gmail; `children` is the older fit-by-outcome detail. */
export function InsightsCard({ children, demoPanel }: { children?: ReactNode; demoPanel?: InsightsPanel }) {
  const isDemo = Boolean(demoPanel);
  const [panel, setPanel] = useState<InsightsPanel | null>(demoPanel ?? null);
  const [running, setRunning] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (isDemo) return;
    try {
      setPanel(await api.insightsPanel());
      setError(null);
    } catch (e) {
      setError(errorText(e));
    }
  }, [isDemo]);

  useEffect(() => {
    if (demoPanel) {
      setPanel(demoPanel);
      return;
    }
    void load();
  }, [load, demoPanel]);

  const rerun = async () => {
    if (isDemo) return;
    setRunning(true);
    try {
      setPanel(await api.insightsRun());
      setError(null);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setRunning(false);
    }
  };

  const act = async (a: ScoringAdjustment, action: "approve" | "dismiss" | "disable") => {
    setBusyId(a.id);
    try {
      if (isDemo) {
        const status = action === "approve" ? "approved" : action === "dismiss" ? "dismissed" : "disabled";
        setPanel(
          (p) =>
            p && {
              ...p,
              adjustments: p.adjustments.map((x) => (x.id === a.id ? { ...x, status, updatedAt: new Date().toISOString() } : x)),
            },
        );
        return;
      }
      const { adjustment } = await api.insightsAdjustment(a.id, action);
      setPanel((p) => p && { ...p, adjustments: p.adjustments.map((x) => (x.id === a.id ? adjustment : x)) });
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusyId(null);
    }
  };

  const run = panel?.run;
  const flagged = run?.patterns.filter((p) => p.verdict !== "no_signal") ?? [];
  const strongest = run?.patterns.slice(0, 5) ?? [];
  const goodFlagged = run?.goodFit.patterns.filter((p) => p.verdict !== "no_signal") ?? [];
  const adjustments = panel?.adjustments.filter((a) => a.status !== "dismissed") ?? [];
  const bandScale = Math.max(0.05, ...(run?.scoreBands.map((b) => b.rate.hi) ?? []));

  return (
    <div className="card stack" style={{ gap: "0.75rem" }}>
      <div className="rowBetween">
        <strong>Application insights</strong>
        <span className="row smallText muted" style={{ gap: "0.5rem" }}>
          {panel && (
            <span title="Monthly cap for the plain-English summary (INSIGHTS_MONTHLY_BUDGET_USD); the statistics are free">
              ${panel.budget.spentThisMonthUsd.toFixed(2)} of ${panel.budget.monthlyUsd.toFixed(2)} this month
            </span>
          )}
          {run && <span>· analyzed {shortDate(run.generatedAt)}</span>}
          <button type="button" className="btn-secondary" onClick={() => void rerun()} disabled={running || panel?.running || isDemo}>
            {running ? "Analyzing…" : "Re-run"}
          </button>
        </span>
      </div>
      {error && <p className="error-text smallText">{error}</p>}

      {!run ? (
        <p className="muted smallText">
          {panel ? "No analysis yet. It runs weekly after a Gmail sync, or press Re-run." : "Loading…"}
        </p>
      ) : (
        <>
          <div className="stack" style={{ gap: "0.35rem" }}>
            <span>{run.headline}</span>
            {run.summary && <p className="smallText" style={{ margin: 0 }}>{run.summary}</p>}
            <span className="muted smallText">
              Heard back means a call or interview was offered: a recruiter screen or later, or an offer. An agency's
              own screening call, assessments alone and silence after 30 days count as no. {run.counts.tooEarly} recent applications are still too early to
              judge and are left out.
            </span>
          </div>

          <CoverageSection counts={run.counts} />
          {run.screening && <ScreeningSection screening={run.screening} />}

          <section className="stack" style={{ gap: "0.35rem" }}>
            <strong className="smallText">Does the fit score predict callbacks?</strong>
            <span className="smallText">{run.scorePredicts.note}</span>
            {run.scorePredicts.k != null && run.scorePredicts.rate && (
              <span className="muted smallText">
                Scored callbacks {run.scorePredicts.k}/{run.scorePredicts.n} ({pct(run.scorePredicts.rate.rate)}; 95%{" "}
                {pct(run.scorePredicts.rate.lo)}–{pct(run.scorePredicts.rate.hi)}). AUC {run.scorePredicts.auc.toFixed(2)}.
                {run.scorePredicts.verdict !== "no_signal" && (
                  <>
                    {" "}
                    Named test:{" "}
                    <span className={`pill ${VERDICT[run.scorePredicts.verdict].pill}`}>{VERDICT[run.scorePredicts.verdict].label}</span>
                  </>
                )}
              </span>
            )}
            <div className="insightBands">
              {run.scoreBands.map((b) => (
                <div key={b.band} className="insightBand smallText" title={`95% range ${pct(b.rate.lo)}-${pct(b.rate.hi)}`}>
                  <span>{b.band}</span>
                  <RateBar rate={b.rate.rate} lo={b.rate.lo} hi={b.rate.hi} scale={bandScale} />
                  <span className="muted">
                    {b.k}/{b.n} ({pct(b.rate.rate)})
                  </span>
                </div>
              ))}
            </div>
            <span className="muted smallText">Bars show the callback rate; the thin line is the range it could plausibly be.</span>
          </section>

          <section className="stack" style={{ gap: "0.35rem" }}>
            <strong className="smallText">What the roles that got back to you have in common</strong>
            {flagged.length > 0 ? (
              <PatternTable rows={flagged} />
            ) : (
              <>
                <span className="smallText">
                  Nothing separates them from the rest beyond what chance would produce. The biggest gaps, for the
                  record:
                </span>
                <PatternTable rows={strongest} />
              </>
            )}
          </section>

          <section className="stack" style={{ gap: "0.35rem" }}>
            <strong className="smallText">Good fits that went quiet</strong>
            <span className="smallText">
              {run.goodFit.k} of {run.goodFit.n} roles scored 65+ got human contact ({pct(run.goodFit.rate.rate)}).
              {goodFlagged.length === 0 && " Among them, no trait marks the ones that heard back."}
            </span>
            {goodFlagged.length > 0 && <PatternTable rows={goodFlagged} />}
            {run.quietGoodFits.length > 0 && (
              <div className="fitTierChips">
                {run.quietGoodFits.map((g) => (
                  <span key={g.id} className="fitChip" title={g.role ?? undefined}>
                    <span className="fitChipScore">{Math.round(g.fit)}</span>
                    <span className="fitChipName">{g.company}</span>
                  </span>
                ))}
              </div>
            )}
          </section>

          <section className="stack" style={{ gap: "0.35rem" }}>
            <strong className="smallText">Scoring adjustments</strong>
            {adjustments.length === 0 ? (
              <span className="muted smallText">
                None proposed. A pattern has to be conclusive, cover at least 15 applications on each side, and be
                something knowable before you apply before it can change scores.
              </span>
            ) : (
              <>
                <span className="muted smallText">
                  Approved adjustments only affect roles scored from now on (each capped at ±4, ±8 total). Existing
                  scores never change.
                </span>
                <table className="table">
                  <tbody>
                    {adjustments.map((a) => (
                      <AdjustmentRow key={a.id} a={a} busy={busyId === a.id} onAction={(action) => void act(a, action)} />
                    ))}
                  </tbody>
                </table>
              </>
            )}
          </section>
        </>
      )}

      {children && (
        <details>
          <summary className="smallText">Fit score by outcome (every scored role)</summary>
          {children}
        </details>
      )}
    </div>
  );
}
