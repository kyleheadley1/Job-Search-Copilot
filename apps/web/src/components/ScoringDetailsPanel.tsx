import { useEffect, useState } from "react";
import { api } from "../api/client";
import type { ScoreRevisionView, ScoringDetail, ScoringReport } from "../types/gmail";
import { JsonPanel } from "./JsonPanel";

const CATEGORY_MAX: Record<string, number> = {
  stackFit: 20,
  levelFit: 20,
  functionalOverlap: 15,
  recruiterFriendliness: 15,
  domainFit: 10,
  resumeStoryClarity: 10,
  careerValue: 10,
};

/** Rule flags that help the candidate or only describe context; everything else limits the score. */
const FAVORABLE_FLAGS = new Set([
  "earlyCareerFriendlyRole",
  "pythonStackFlexibleWithJsTs",
  "healthcareProductEngineering",
  "backendProductApiRole",
  "degreeHasEquivalencyClause",
  "degreeEquivalencySatisfied",
  "jdDegreePositive",
  "disjunctiveLanguageRequirementSatisfied",
  "matureStructuredEmployer",
]);

/** Shown in their own sections below. */
const SECTIONED_RULE_KEYS = new Set(["notes", "hardRuleNotes", "hardRuleFlags", "penaltyVector"]);

const humanize = (key: string) =>
  key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/^./, (c) => c.toUpperCase());

const fmt = (n: number | undefined, digits = 0) => (typeof n === "number" ? n.toFixed(digits) : "—");

type FiredRule = { key: string; value: string; favorable: boolean };

/** Every rule output that is set: true flags, non-empty lists, objects, and strings. */
const firedRules = (rules: Record<string, unknown>): FiredRule[] => {
  const out: FiredRule[] = [];
  for (const [key, value] of Object.entries(rules)) {
    if (SECTIONED_RULE_KEYS.has(key) || key === "newGradPenalty") continue;
    const favorable = FAVORABLE_FLAGS.has(key);
    if (value === true) out.push({ key, value: "yes", favorable });
    else if (Array.isArray(value) && value.length > 0) out.push({ key, value: value.join(", "), favorable });
    else if (typeof value === "string" && value) out.push({ key, value, favorable });
    else if (typeof value === "number" && value) out.push({ key, value: String(value), favorable });
    else if (value && typeof value === "object" && !Array.isArray(value)) {
      const { reason, evidence, dock } = value as { reason?: unknown; evidence?: unknown; dock?: unknown };
      const text = typeof reason === "string" ? reason : typeof evidence === "string" ? evidence : null;
      out.push({
        key,
        value: text ? `${typeof dock === "number" ? `−${dock}: ` : ""}${text}` : JSON.stringify(value),
        favorable,
      });
    }
  }
  return out.sort((a, b) => Number(a.favorable) - Number(b.favorable));
};

function DetailView({ detail }: { detail: ScoringDetail }) {
  const { score, rules, extracted } = detail;
  const display = score.scoreDisplay;
  const fired = firedRules(rules);
  const penalties = Object.entries((rules.penaltyVector as Record<string, number> | undefined) ?? {}).filter(
    ([, v]) => v,
  );
  const scoreNotes = [
    display?.roleFunctionCapNote ?? score.roleFunctionCapNote,
    display?.differentiatorCoverageNote ?? score.differentiatorCoverageNote,
    display?.poolFriendlinessNote,
    display?.credentialBoostNote,
    display?.degreePositiveNote ?? score.degreePositiveNote,
    display?.contractCaveat ?? score.contractCaveat,
    display?.genAiRestrictionWarning,
  ].filter((n): n is string => typeof n === "string" && n.length > 0);

  return (
    <div className="stack" style={{ gap: "0.9rem" }}>
      <div className="row" style={{ gap: "1.5rem", flexWrap: "wrap" }}>
        <div>
          <div className="muted smallText">Final</div>
          <div style={{ fontSize: "1.6rem", fontWeight: 700 }}>{fmt(score.total)}</div>
        </div>
        <div>
          <div className="muted smallText">Capability</div>
          <div style={{ fontSize: "1.2rem" }}>{fmt(score.capability)}</div>
        </div>
        <div>
          <div className="muted smallText">Survivability</div>
          <div style={{ fontSize: "1.2rem" }}>{fmt(score.survivability, 3)}</div>
        </div>
        <div>
          <div className="muted smallText">Survivability adj.</div>
          <div style={{ fontSize: "1.2rem" }}>{fmt(display?.survAdjustment, 1)}</div>
        </div>
        <div>
          <div className="muted smallText">Gap dock</div>
          <div style={{ fontSize: "1.2rem" }}>{fmt(display?.gapDock, 1)}</div>
        </div>
        <div>
          <div className="muted smallText">Recommendation</div>
          <div style={{ fontSize: "1.2rem" }}>{display?.bandHeadline ?? detail.recommendation ?? "—"}</div>
        </div>
      </div>

      {display?.scoreDerivation && (
        <div>
          <strong className="smallText">How the final was computed</strong>
          <pre className="jsonPanel" style={{ whiteSpace: "pre-wrap" }}>{display.scoreDerivation}</pre>
        </div>
      )}

      {(score.historyAdjustments?.length ?? 0) > 0 && (
        <div>
          <strong className="smallText">Your history</strong>
          <ul className="smallText">
            {score.historyAdjustments!.map((a) => (
              <li key={a.id}>
                {a.label}: {a.points > 0 ? "+" : ""}
                {a.points}
              </li>
            ))}
          </ul>
          <span className="muted smallText">
            From scoring adjustments you approved in Application insights (capped at ±8 total, included in the final).
          </span>
        </div>
      )}

      {(display?.hardGates?.length ?? 0) > 0 && (
        <div>
          <strong className="smallText">Hard gates</strong>
          <ul>{display!.hardGates.map((g) => <li key={g}>{g}</li>)}</ul>
        </div>
      )}

      <div className="grid" style={{ gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: "1rem" }}>
        <div>
          <strong className="smallText">LLM category scores</strong>
          <table className="table">
            <tbody>
              {Object.keys(CATEGORY_MAX).map((k) => (
                <tr key={k}>
                  <td>{humanize(k)}</td>
                  <td>
                    {fmt(score[k as keyof typeof score] as number | undefined)} / {CATEGORY_MAX[k]}
                  </td>
                  <td className="muted smallText">
                    {score.capabilityBreakdown && k in score.capabilityBreakdown
                      ? `capability input ${fmt(score.capabilityBreakdown[k as keyof typeof score.capabilityBreakdown])}`
                      : ""}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div>
          <strong className="smallText">Survivability rows</strong>
          {display?.survivabilityRows?.length ? (
            <table className="table">
              <thead>
                <tr>
                  <th>Factor</th>
                  <th>Score</th>
                  <th>Weight</th>
                  <th>Contrib.</th>
                </tr>
              </thead>
              <tbody>
                {display.survivabilityRows.map((r) => (
                  <tr key={r.key} title={`${r.penaltyName} · ${r.bindingness} · lever: ${r.leverLabel}`}>
                    <td>{r.label}</td>
                    <td>{fmt(r.score, 2)}</td>
                    <td>{fmt(r.weight, 2)}</td>
                    <td>{fmt(r.contribution, 3)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <JsonPanel value={score.survivabilityBreakdown ?? {}} />
          )}
        </div>
      </div>

      <div>
        <strong className="smallText">Rules that fired ({fired.length})</strong>
        {fired.length === 0 ? (
          <p className="muted smallText">No rule flags set.</p>
        ) : (
          <table className="table">
            <tbody>
              {fired.map((r) => (
                <tr key={r.key}>
                  <td style={{ whiteSpace: "nowrap" }}>
                    <span className={`pill ${r.favorable ? "good" : "warn"}`}>{r.favorable ? "context" : "limits"}</span>
                  </td>
                  <td>
                    <code>{r.key}</code>
                    <div className="muted smallText">{humanize(r.key)}</div>
                  </td>
                  <td className="smallText" style={{ wordBreak: "break-word" }}>{r.value}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {penalties.length > 0 && (
        <div>
          <strong className="smallText">Penalty vector</strong>
          <ul className="smallText">
            {penalties.map(([k, v]) => (
              <li key={k}>
                <code>{k}</code>: {v}
              </li>
            ))}
          </ul>
        </div>
      )}

      {((rules.hardRuleFlags?.length ?? 0) > 0 || (rules.hardRuleNotes?.length ?? 0) > 0) && (
        <div>
          <strong className="smallText">Hard-rule flags and notes</strong>
          <ul className="smallText">
            {rules.hardRuleFlags?.map((f) => (
              <li key={f.id}>
                <code>{f.id}</code>: {f.message}
              </li>
            ))}
            {rules.hardRuleNotes?.map((n) => <li key={n}>{n}</li>)}
          </ul>
        </div>
      )}

      {(display?.survivabilityPenalties?.length ?? 0) > 0 && (
        <div>
          <strong className="smallText">Survivability penalties</strong>
          <ul className="smallText">
            {display!.survivabilityPenalties.map((p) => (
              <li key={p.message}>
                {p.message} <span className="muted">({p.leverLabel})</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {(rules.notes.length > 0 || scoreNotes.length > 0) && (
        <div>
          <strong className="smallText">Rule and score notes</strong>
          <ul className="smallText">
            {[...rules.notes, ...scoreNotes].map((n, i) => <li key={`${i}-${n}`}>{n}</li>)}
          </ul>
        </div>
      )}

      <div className="grid" style={{ gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: "1rem" }}>
        <div>
          <strong className="smallText">Rationale</strong>
          <ul className="smallText">
            <li>
              <strong>Top match:</strong> {detail.topMatch}
            </li>
            <li>
              <strong>Main risk:</strong> {detail.mainRisk}
            </li>
            {detail.rationale.map((r) => <li key={r}>{r}</li>)}
          </ul>
        </div>
        <div>
          <strong className="smallText">Risks</strong>
          <ul className="smallText">{detail.risks.map((r) => <li key={r}>{r}</li>)}</ul>
          <strong className="smallText">Resume pick: {detail.recommendedResume}</strong>
          <ul className="smallText">{detail.resumeRationale.map((r) => <li key={r}>{r}</li>)}</ul>
        </div>
      </div>

      <details>
        <summary className="smallText">What the extractor read from the JD</summary>
        <div className="smallText stack" style={{ gap: "0.3rem" }}>
          <div>
            <strong>{extracted.title}</strong> · {extracted.seniority ?? "seniority ?"} · {extracted.location ?? "location ?"} ·{" "}
            {extracted.remoteType ?? "?"}
          </div>
          <div>
            <strong>Required:</strong> {extracted.requiredSkills.join(", ") || "—"}
          </div>
          <div>
            <strong>Preferred:</strong> {extracted.preferredSkills.join(", ") || "—"}
          </div>
          <div>
            <strong>Stack:</strong> {extracted.stack.join(", ") || "—"}
          </div>
          <div>
            <strong>Domain:</strong> {extracted.domainTags.join(", ") || "—"}
          </div>
          {extracted.requirements.length > 0 && (
            <div>
              <strong>Requirements:</strong>
              <ul>{extracted.requirements.map((r) => <li key={r}>{r}</li>)}</ul>
            </div>
          )}
          <JsonPanel value={extracted} />
        </div>
      </details>

      <details>
        <summary className="smallText">Raw scorer output (score + rules)</summary>
        <JsonPanel value={{ score, rules }} />
      </details>
    </div>
  );
}

type Source = "original" | "diagnostic";

function RevisionPanel({
  report,
  busy,
  allowLaneChange,
  onAllowLaneChange,
  onPropose,
  onApprove,
  onRollback,
}: {
  report: ScoringReport;
  busy: boolean;
  allowLaneChange: boolean;
  onAllowLaneChange: (value: boolean) => void;
  onPropose: () => void;
  onApprove: (revisionId: string) => void;
  onRollback: (revisionId: string) => void;
}) {
  const history = report.scoreRevisions ?? [];
  const approved = history.find((r) => r.status === "approved") ?? report.scoreRevision ?? null;
  const proposedList = history.filter((r) => r.status === "proposed");
  const latest = approved ?? proposedList[0] ?? null;
  const originalTotal = report.fit?.originalAuthoritativeTotal ?? latest?.original.total ?? report.fit?.storedFitTotal;
  const effectiveTotal = report.fit?.total;

  return (
    <div className="stack" style={{ gap: "0.45rem", padding: "0.65rem", border: "1px solid var(--border, #ddd)", borderRadius: 8 }}>
      <div className="smallText">
        <strong>Historical score revision</strong>
        <span className="muted">
          {" "}
          · the stored evaluation is never overwritten. Approval re-runs the scoring engine; Claude cannot activate a
          proposal by submitting it.
        </span>
      </div>
      {report.fit?.fingerprintStale && (
        <p className="error smallText" style={{ margin: 0 }}>
          Approved revision {report.fit.staleRevisionTotal ?? approved?.corrected.total ?? "—"} is no longer
          displayed because the stored evaluation changed. Showing {Math.round(effectiveTotal ?? report.fit.total)}{" "}
          instead. Roll back to clear the inactive revision, or propose a new one against the current evaluation.
        </p>
      )}
      {report.fit?.scoreRevised && approved ? (
        <div className="smallText">
          Effective <strong>{Math.round(approved.corrected.total)}</strong> {approved.corrected.recommendation}
          {originalTotal != null && (
            <span className="muted">
              {" "}
              · original {Math.round(originalTotal)} {approved.original.recommendation}
            </span>
          )}
        </div>
      ) : (
        report.fit && (
          <div className="smallText muted">
            Effective displayed score {Math.round(effectiveTotal ?? report.fit.total)} {report.fit.recommendation}
            {report.fit.scoreConflict && report.fit.storedFitTotal != null
              ? ` · stored fit.total ${Math.round(report.fit.storedFitTotal)}`
              : ""}
          </div>
        )
      )}
      {approved && <RevisionDiff revision={approved} />}
      {proposedList.map((revision) => (
        <RevisionDiff key={revision.revisionId} revision={revision} />
      ))}
      <label className="smallText" style={{ display: "flex", gap: "0.4rem", alignItems: "center" }}>
        <input
          type="checkbox"
          checked={allowLaneChange}
          onChange={(e) => onAllowLaneChange(e.target.checked)}
          disabled={busy}
        />
        I reviewed a role-lane change (required for TELCOR-style proposals)
      </label>
      <div className="row" style={{ gap: "0.5rem", flexWrap: "wrap" }}>
        <button
          className="btn-secondary"
          disabled={busy || Boolean(approved) || proposedList.length > 0}
          onClick={() => onPropose()}
          title="Replays stored LLM categories with current years/seniority/stack rules. Does not call the paid scorer."
        >
          {busy ? "Working…" : "Propose deterministic correction"}
        </button>
        {proposedList.map((revision) =>
          revision.method === "human_correction" ? null : (
            <button
              key={revision.revisionId}
              className="btn-secondary"
              disabled={busy}
              onClick={() => onApprove(revision.revisionId)}
              title={
                revision.method === "claude_audit_proposal"
                  ? "Re-runs deterministic replay before activating. Does not trust Claude's numbers."
                  : "Activate this proposed correction as the displayed score."
              }
            >
              Approve {Math.round(revision.corrected.total)} {revision.corrected.recommendation}
              {revision.method === "claude_audit_proposal" ? " (Claude proposal)" : ""}
            </button>
          ),
        )}
        {approved && (
          <button className="btn-secondary" disabled={busy} onClick={() => onRollback(approved.revisionId)}>
            Roll back to original display
          </button>
        )}
      </div>
    </div>
  );
}

const methodLabel = (method: ScoreRevisionView["method"]) => {
  if (method === "claude_audit_proposal") return "Claude audit proposal";
  if (method === "human_correction") return "Human correction";
  return "Deterministic replay";
};

function RevisionDiff({ revision }: { revision: ScoreRevisionView }) {
  const laneChange = revision.inputsChanged.includes("roleLane") || revision.correctionType === "role_lane";
  return (
    <div
      className="smallText"
      style={
        revision.method === "claude_audit_proposal"
          ? { padding: "0.45rem", borderLeft: "3px solid var(--accent, #4b6bfb)" }
          : undefined
      }
    >
      <div>
        <strong>{methodLabel(revision.method)}</strong>
        {revision.correctionType ? ` · ${revision.correctionType.replace(/_/g, " ")}` : ""}
        {revision.confidence ? ` · ${revision.confidence} confidence` : ""}
        {` · ${revision.status}`}: {Math.round(revision.original.total)} {revision.original.recommendation} →{" "}
        {Math.round(revision.corrected.total)} {revision.corrected.recommendation}
        {revision.recommendationTierChanged ? " · recommendation tier changes" : ""}
      </div>
      {laneChange && (
        <p className="error smallText" style={{ margin: "0.25rem 0 0" }}>
          Role-lane change. Approve only after explicit lane review.
        </p>
      )}
      {revision.inputChanges.length > 0 && (
        <ul>
          {revision.inputChanges.map((change) => (
            <li key={change.id}>
              {change.id}: {JSON.stringify(change.from)} → {JSON.stringify(change.to)}
            </li>
          ))}
        </ul>
      )}
      {revision.evidence.length > 0 && (
        <ul>
          {revision.evidence.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      )}
      <div>{revision.explanation}</div>
      {revision.uncertainty && <div className="muted">Uncertainty: {revision.uncertainty}</div>}
      {revision.createdBy?.via === "mcp" && (
        <div className="muted">Submitted via MCP. Inactive until you approve it here.</div>
      )}
    </div>
  );
}

export function ScoringDetailsPanel({
  appKey,
  onEffectiveScoreChange,
}: {
  appKey: string;
  onEffectiveScoreChange?: () => void;
}) {
  const [report, setReport] = useState<ScoringReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [revising, setRevising] = useState(false);
  const [allowLaneChange, setAllowLaneChange] = useState(false);
  const [source, setSource] = useState<Source>("original");

  useEffect(() => {
    let cancelled = false;
    api
      .gmailScoringReport(appKey)
      .then((r) => {
        if (cancelled) return;
        setReport(r);
        setSource(r.fit?.detail ? "original" : "diagnostic");
      })
      .catch((e: unknown) => !cancelled && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      cancelled = true;
    };
  }, [appKey]);

  const runDiagnostic = async () => {
    setRunning(true);
    setError(null);
    try {
      const r = await api.gmailRunDiagnostic(appKey);
      setReport(r);
      setSource("diagnostic");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRunning(false);
    }
  };

  const reloadReport = async (changedEffective: boolean) => {
    const next = await api.gmailScoringReport(appKey);
    setReport(next);
    if (changedEffective) onEffectiveScoreChange?.();
  };

  const runRevision = async (action: () => Promise<unknown>, changedEffective: boolean) => {
    setRevising(true);
    setError(null);
    try {
      await action();
      await reloadReport(changedEffective);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRevising(false);
    }
  };

  if (error && !report) return <p className="error">{error}</p>;
  if (!report) return <p className="muted">Loading scoring details…</p>;

  const detail = source === "original" ? report.fit?.detail : report.diagnostic?.detail;

  return (
    <div className="stack" style={{ gap: "0.75rem" }}>
      <div className="rowBetween" style={{ flexWrap: "wrap", gap: "0.5rem" }}>
        <div className="smallText">
          <strong>
            {report.company}
            {report.role ? ` — ${report.role}` : ""}
          </strong>
          {report.fit && (
            <span className="muted">
              {" "}
              · scored {Math.round(report.fit.total)} {report.fit.recommendation}
              {report.fit.scoreRevised && report.fit.originalAuthoritativeTotal != null
                ? ` (revised from ${Math.round(report.fit.originalAuthoritativeTotal)})`
                : ""}{" "}
              on {new Date(report.fit.scoredAt).toLocaleDateString()} ({report.fit.promptVersion})
            </span>
          )}
          {report.diagnostic && (
            <span className="muted">
              {" "}
              · diagnostic re-run {Math.round(report.diagnostic.total)} on{" "}
              {new Date(report.diagnostic.runAt).toLocaleString()}
            </span>
          )}
        </div>
        <div className="row" style={{ gap: "0.5rem" }}>
          {report.fit?.detail && report.diagnostic && (
            <>
              <button
                className={`chip${source === "original" ? " active" : ""}`}
                onClick={() => setSource("original")}
              >
                Original
              </button>
              <button
                className={`chip${source === "diagnostic" ? " active" : ""}`}
                onClick={() => setSource("diagnostic")}
              >
                Diagnostic
              </button>
            </>
          )}
          {report.jd && (
            <button
              className="btn-secondary"
              onClick={() => void runDiagnostic()}
              disabled={running}
              title="Scores the stored JD again (about 1¢). The fit score shown on the dashboard does not change."
            >
              {running ? "Re-scoring…" : report.diagnostic ? "Re-run diagnostic" : "Run diagnostic re-score"}
            </button>
          )}
        </div>
      </div>

      {error && <p className="error">{error}</p>}

      {report.fit && (
        <RevisionPanel
          report={report}
          busy={revising}
          allowLaneChange={allowLaneChange}
          onAllowLaneChange={setAllowLaneChange}
          onPropose={() =>
            void runRevision(
              () =>
                api.gmailProposeScoreRevision(appKey, {
                  allowRoleLaneChange: allowLaneChange,
                  reason: "Dashboard deterministic replay",
                }),
              false,
            )
          }
          onApprove={(revisionId) => void runRevision(() => api.gmailApproveScoreRevision(appKey, revisionId), true)}
          onRollback={(revisionId) => void runRevision(() => api.gmailRollbackScoreRevision(appKey, revisionId), true)}
        />
      )}

      {detail ? (
        <DetailView detail={detail} />
      ) : (
        <p className="muted smallText">
          This role was scored before full scoring details were saved, so only the summary exists. Run a diagnostic
          re-score to see every category, rule, and penalty for the stored JD. The re-run can differ by a few points
          because the LLM categories aren&apos;t deterministic, but the rules that fire should be the same.
        </p>
      )}

      {report.jd && (
        <details>
          <summary className="smallText">
            Stored JD ({report.jd.text.length.toLocaleString()} chars)
            {report.jd.url && (
              <>
                {" · "}
                <a href={report.jd.url} target="_blank" rel="noreferrer">
                  posting
                </a>
              </>
            )}
          </summary>
          <pre className="jsonPanel" style={{ whiteSpace: "pre-wrap", maxHeight: "24rem", overflow: "auto" }}>
            {report.jd.text}
          </pre>
        </details>
      )}
    </div>
  );
}
