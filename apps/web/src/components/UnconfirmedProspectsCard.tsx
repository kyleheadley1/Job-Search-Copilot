import { useCallback, useEffect, useState } from "react";

/**
 * Saved job descriptions with no matching confirmation email. Some applications never send one,
 * so this asks "did you apply?" instead of leaving them as silent prospects.
 */

type UnconfirmedProspect = {
  prospectId: string;
  company: string;
  title: string;
  savedAt: string;
  ageDays: number;
  state: "needs_answer" | "applied_no_email";
  appliedAt?: string;
  trackerJobId?: string;
  trackerSyncError?: string;
  possibleApplicationKey?: string;
  salary?: string;
  sourceUrl?: string;
  duplicateIds?: string[];
};

type UnconfirmedResponse = {
  total: number;
  needsAnswer: number;
  appliedNoEmail: number;
  prospects: UnconfirmedProspect[];
};

const API_BASE = import.meta.env.VITE_API_BASE_URL ?? "http://localhost:4000/api";

const call = async <T,>(path: string, init?: RequestInit): Promise<T> => {
  const response = await fetch(`${API_BASE}${path}`, { headers: { "Content-Type": "application/json" }, ...init });
  const text = await response.text();
  if (!response.ok) {
    let message = text.slice(0, 300);
    try {
      message = (JSON.parse(text) as { message?: string }).message ?? message;
    } catch {
      /* keep raw text */
    }
    throw new Error(`API error: ${response.status}${message ? `: ${message}` : ""}`);
  }
  return JSON.parse(text) as T;
};

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

export function UnconfirmedProspectsCard({ disabled, onChanged }: { disabled?: boolean; onChanged?: () => void }) {
  const [data, setData] = useState<UnconfirmedResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [showApplied, setShowApplied] = useState(false);

  const load = useCallback(async () => {
    if (disabled) return;
    try {
      setData(await call<UnconfirmedResponse>("/gmail/prospects/unconfirmed"));
      setError(null);
    } catch (e) {
      setError(errorText(e));
    }
  }, [disabled]);

  useEffect(() => {
    void load();
  }, [load]);

  const answer = async (p: UnconfirmedProspect, applied: boolean) => {
    setBusyId(p.prospectId);
    try {
      await call(`/gmail/prospects/${encodeURIComponent(p.prospectId)}/applied`, {
        method: "POST",
        body: JSON.stringify({ applied }),
      });
      await load();
      onChanged?.();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusyId(null);
    }
  };

  if (disabled || !data || (data.total === 0 && !error)) return null;
  const needs = data.prospects.filter((p) => p.state === "needs_answer");
  const applied = data.prospects.filter((p) => p.state === "applied_no_email");

  return (
    <div className="card stack" style={{ gap: "0.5rem" }}>
      <div className="rowBetween">
        <strong>Unconfirmed applications</strong>
        <span className="row smallText muted" style={{ gap: "0.5rem" }}>
          {applied.length > 0 && (
            <button type="button" className="btn-secondary" onClick={() => setShowApplied((v) => !v)}>
              {showApplied ? "Hide" : "Show"} {applied.length} applied, no email
            </button>
          )}
          <button type="button" className="btn-secondary" onClick={() => void load()}>
            Refresh
          </button>
        </span>
      </div>
      {error && <p className="error-text smallText">{error}</p>}
      {needs.length > 0 ? (
        <p className="muted smallText">Saved job descriptions with no confirmation email after a few days. Did you apply?</p>
      ) : (
        <p className="muted smallText">Nothing needs an answer.</p>
      )}
      <table className="table">
        <tbody>
          {needs.map((p) => (
            <tr key={p.prospectId}>
              <td>
                <strong>{p.company}</strong> — {p.title}
                <div className="smallText muted">
                  saved {p.ageDays}d ago{p.salary ? ` · ${p.salary}` : ""}
                  {p.possibleApplicationKey ? " · a Gmail application may match; check JD review" : ""}
                  {p.sourceUrl && (
                    <>
                      {" · "}
                      <a href={p.sourceUrl} target="_blank" rel="noreferrer">
                        posting
                      </a>
                    </>
                  )}
                </div>
              </td>
              <td style={{ whiteSpace: "nowrap", textAlign: "right" }}>
                <button type="button" onClick={() => void answer(p, true)} disabled={busyId === p.prospectId}>
                  I applied
                </button>{" "}
                <button
                  type="button"
                  className="btn-secondary"
                  onClick={() => void answer(p, false)}
                  disabled={busyId === p.prospectId}
                >
                  Didn&apos;t apply
                </button>
              </td>
            </tr>
          ))}
          {showApplied &&
            applied.map((p) => (
              <tr key={p.prospectId}>
                <td>
                  <strong>{p.company}</strong> — {p.title}
                  <div className="smallText muted">
                    applied {p.appliedAt} · no confirmation email yet
                    {p.trackerJobId ? " · in tracker" : p.trackerSyncError ? ` · tracker failed: ${p.trackerSyncError}` : " · adding to tracker…"}
                  </div>
                </td>
                <td style={{ whiteSpace: "nowrap", textAlign: "right" }}>
                  <button
                    type="button"
                    className="btn-secondary"
                    onClick={() => void answer(p, false)}
                    disabled={busyId === p.prospectId}
                  >
                    Didn&apos;t apply
                  </button>
                </td>
              </tr>
            ))}
        </tbody>
      </table>
    </div>
  );
}
