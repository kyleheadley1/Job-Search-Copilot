import { useCallback, useEffect, useState } from "react";
import { api } from "../api/client";
import type { AgentKind, AgentPanel, AgentSuggestion, DraftCreated } from "../types/agent";
import { DraftEditor } from "./DraftEditor";

const KIND_LABEL: Record<AgentKind, { label: string; pill: string }> = {
  action_reply: { label: "Respond", pill: "warn" },
  interview_prep: { label: "Prep", pill: "info" },
  thank_you: { label: "Thank-you", pill: "good" },
  follow_up: { label: "Follow up", pill: "neutral" },
  mark_ghosted: { label: "Tracker", pill: "neutral" },
};

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

const countdown = (iso: string, now: number): string => {
  const hours = Math.round((Date.parse(iso) - now) / 3_600_000);
  if (!Number.isFinite(hours) || hours < 0) return "";
  if (hours < 1) return "within the hour";
  if (hours < 48) return `in ${hours}h`;
  return `in ${Math.round(hours / 24)} days`;
};

const dueText = (iso: string, now = Date.now()): string => {
  const when = new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  const left = countdown(iso, now);
  return left ? `${when} (${left})` : when;
};

function SuggestionRow({
  s,
  onApprove,
  onDismiss,
  onDrafted,
  canCreateDrafts,
  busy,
}: {
  s: AgentSuggestion;
  onApprove: () => void;
  onDismiss: () => void;
  onDrafted: (draft: DraftCreated) => void;
  canCreateDrafts: boolean;
  busy: boolean;
}) {
  const [showDraft, setShowDraft] = useState(false);
  const [editing, setEditing] = useState(false);
  const [copied, setCopied] = useState(false);
  const kind = KIND_LABEL[s.kind];
  const loadTarget = useCallback(() => api.agentReplyTarget(s.id), [s.id]);
  const create = useCallback((to: string, body: string) => api.agentCreateDraft(s.id, to, body), [s.id]);

  const copy = async () => {
    if (!s.draft) return;
    await navigator.clipboard.writeText(s.draft);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 2000);
  };

  return (
    <tr>
      <td style={{ whiteSpace: "nowrap", verticalAlign: "top" }}>
        <span className={`pill ${s.priority >= 5 ? "bad" : kind.pill}`}>{kind.label}</span>
      </td>
      <td style={{ verticalAlign: "top" }}>
        <strong>{s.title}</strong>
        <div className="muted smallText">
          {s.reason}
          {s.dueAt && <> · {dueText(s.dueAt)}</>}
        </div>
        {showDraft && s.draft && !editing && (
          <pre className="smallText" style={{ whiteSpace: "pre-wrap", margin: "0.4rem 0 0" }}>
            {s.draft}
          </pre>
        )}
        {editing && (
          <DraftEditor
            initialBody={s.draft ?? ""}
            loadTarget={loadTarget}
            create={create}
            onCreated={onDrafted}
            onCancel={() => setEditing(false)}
          />
        )}
      </td>
      <td style={{ whiteSpace: "nowrap", verticalAlign: "top" }} className="smallText">
        {s.draft && (
          <>
            <button type="button" className="linkButton smallText" onClick={() => setShowDraft((v) => !v)}>
              {showDraft ? "Hide draft" : "Draft"}
            </button>
            {showDraft && (
              <>
                {" · "}
                <button type="button" className="linkButton smallText" onClick={() => void copy()}>
                  {copied ? "Copied" : "Copy"}
                </button>
              </>
            )}
            {" · "}
          </>
        )}
        {s.draftable && canCreateDrafts && !editing && (
          <>
            <button
              type="button"
              className="linkButton smallText"
              onClick={() => setEditing(true)}
              title="Review the recipient and text, then create a draft in this thread. Nothing is sent."
            >
              Create Gmail draft
            </button>
            {" · "}
          </>
        )}
        {s.gmailUrl && (
          <>
            <a href={s.gmailUrl} target="_blank" rel="noreferrer">
              Open email
            </a>
            {" · "}
          </>
        )}
        <button
          type="button"
          className="linkButton smallText"
          onClick={onApprove}
          disabled={busy}
          title={s.proposedChange ? `Set the tracker status to ${s.proposedChange.status}` : "Mark this step done"}
        >
          {s.proposedChange ? `Approve: mark ${s.proposedChange.status}` : "Done"}
        </button>
        {" · "}
        <button type="button" className="linkButton smallText" onClick={onDismiss} disabled={busy}>
          Dismiss
        </button>
      </td>
    </tr>
  );
}

/**
 * Daily next steps from free rules over Gmail and the tracker, ranked and drafted by a budgeted agent pass.
 * Drafts are never sent; tracker changes only happen on Approve.
 */
export function NextStepsCard({
  onTrackerChanged,
  demoPanel,
}: {
  onTrackerChanged?: () => void;
  demoPanel?: AgentPanel;
}) {
  const isDemo = Boolean(demoPanel);
  const [panel, setPanel] = useState<AgentPanel | null>(demoPanel ?? null);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [drafted, setDrafted] = useState<{ title: string; draft: DraftCreated } | null>(null);

  const load = useCallback(async () => {
    if (isDemo) return;
    try {
      setPanel(await api.agentPanel());
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

  const refresh = async () => {
    if (isDemo) return;
    setRunning(true);
    try {
      setPanel(await api.agentRun());
      setError(null);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setRunning(false);
    }
  };

  const resolve = async (s: AgentSuggestion, action: "approve" | "dismiss") => {
    setBusyId(s.id);
    try {
      if (!isDemo) {
        if (action === "approve") await api.agentApprove(s.id);
        else await api.agentDismiss(s.id);
      }
      setPanel((p) => p && { ...p, suggestions: p.suggestions.filter((x) => x.id !== s.id) });
      if (!isDemo && action === "approve" && s.proposedChange) onTrackerChanged?.();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusyId(null);
    }
  };

  if (panel && !panel.enabled) return null;
  const last = panel?.lastRun;

  return (
    <div className="card stack" style={{ gap: "0.5rem" }}>
      <div className="rowBetween">
        <strong>Next steps</strong>
        <span className="row smallText muted" style={{ gap: "0.5rem" }}>
          {panel && (
            <span title="Hard monthly cap for the next-steps agent (AGENT_MONTHLY_BUDGET_USD)">
              ${panel.budget.spentThisMonthUsd.toFixed(2)} of ${panel.budget.monthlyUsd.toFixed(2)} this month
            </span>
          )}
          {last && <span>· checked {dueText(last.at)}</span>}
          <button type="button" className="btn-secondary" onClick={() => void refresh()} disabled={running || isDemo}>
            {running ? "Checking…" : "Refresh"}
          </button>
        </span>
      </div>
      {error && <p className="error-text smallText">{error}</p>}
      {drafted && (
        <p className="smallText">
          Draft created for {drafted.title} (to {drafted.draft.to}).{" "}
          <a href={drafted.draft.draftsUrl} target="_blank" rel="noreferrer">
            Review and send it in Gmail
          </a>
        </p>
      )}
      {panel && panel.enabled && !panel.canCreateDrafts && !isDemo && (
        <p className="muted smallText">Reconnect Gmail to turn drafts into real Gmail drafts; until then use Copy.</p>
      )}
      {last?.budgetLimited && (
        <p className="muted smallText">
          Today&apos;s agent budget is used, so new steps show the rule facts without drafts until tomorrow.
        </p>
      )}
      {panel && panel.suggestions.length === 0 ? (
        <p className="muted smallText">
          {last ? "Nothing needs you right now." : "The first check runs after the next morning Gmail sync, or press Refresh."}
        </p>
      ) : (
        <table className="table">
          <tbody>
            {panel?.suggestions.map((s) => (
              <SuggestionRow
                key={s.id}
                s={s}
                busy={busyId === s.id}
                canCreateDrafts={Boolean(panel.canCreateDrafts)}
                onDrafted={(draft) => {
                  setDrafted({ title: s.title, draft });
                  setPanel((p) => p && { ...p, suggestions: p.suggestions.filter((x) => x.id !== s.id) });
                }}
                onApprove={() => void resolve(s, "approve")}
                onDismiss={() => void resolve(s, "dismiss")}
              />
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
