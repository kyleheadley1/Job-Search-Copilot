import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api/client";
import type { AssistantMessage, AssistantProposal, AssistantThread } from "../types/assistant";
import { DraftEditor } from "./DraftEditor";

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));
const usd = (n: number) => `$${n.toFixed(2)}`;

const EXAMPLES = [
  "What should I do today?",
  "Which applications haven't replied in 2+ weeks?",
  "Draft a follow-up for my most recent interview",
  "Any Top Jobs in the queue worth scoring?",
];

function ProposalCard({
  proposal,
  canCreateDrafts,
  onChange,
}: {
  proposal: AssistantProposal;
  canCreateDrafts: boolean;
  onChange: (p: AssistantProposal, draftsUrl?: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [draftsUrl, setDraftsUrl] = useState<string | null>(null);
  const loadTarget = useCallback(() => api.assistantReplyTarget(proposal.id), [proposal.id]);
  const p = proposal.payload;

  const act = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const approve = () =>
    act(async () => {
      const { proposal: updated } = await api.assistantApprove(proposal.id);
      onChange(updated);
    });
  const dismiss = () =>
    act(async () => {
      await api.assistantDismiss(proposal.id);
      onChange({ ...proposal, status: "dismissed" });
    });

  return (
    <div className="assistant-proposal">
      <strong className="smallText">{proposal.title}</strong>
      {p.kind === "tracker_status" && p.note && <div className="muted smallText">{p.note}</div>}
      {p.kind === "email_draft" && !editing && <pre className="assistant-draft">{p.body}</pre>}
      {proposal.status !== "open" ? (
        <div className="muted smallText">
          {proposal.status === "approved" ? `Approved${proposal.result ? `: ${proposal.result}` : ""}` : "Dismissed"}
          {draftsUrl && (
            <>
              {" · "}
              <a href={draftsUrl} target="_blank" rel="noreferrer">
                Review and send it in Gmail
              </a>
            </>
          )}
        </div>
      ) : p.kind === "email_draft" && editing ? (
        <DraftEditor
          initialBody={p.body}
          loadTarget={loadTarget}
          create={async (to, subject, body) => {
            const res = await api.assistantApprove(proposal.id, { to, subject, body });
            setDraftsUrl(res.draftsUrl ?? null);
            onChange(res.proposal, res.draftsUrl);
            return { draftId: "", threadId: "", to, draftsUrl: res.draftsUrl ?? "" };
          }}
          onCreated={() => setEditing(false)}
          onCancel={() => setEditing(false)}
        />
      ) : (
        <div className="row" style={{ gap: "0.5rem", marginTop: "0.35rem" }}>
          {p.kind === "email_draft" ? (
            <button type="button" onClick={() => setEditing(true)} disabled={busy || !canCreateDrafts}>
              Review &amp; create Gmail draft
            </button>
          ) : (
            <button type="button" onClick={() => void approve()} disabled={busy}>
              {busy ? "Working…" : "Approve"}
            </button>
          )}
          <button type="button" className="btn-secondary" onClick={() => void dismiss()} disabled={busy}>
            Dismiss
          </button>
          {p.kind === "email_draft" && !canCreateDrafts && (
            <span className="muted smallText">Reconnect Gmail on the Dashboard to allow drafts.</span>
          )}
        </div>
      )}
      {error && <div className="error smallText">{error}</div>}
    </div>
  );
}

function Message({
  message,
  proposals,
  canCreateDrafts,
  onProposal,
}: {
  message: AssistantMessage;
  proposals: Map<string, AssistantProposal>;
  canCreateDrafts: boolean;
  onProposal: (p: AssistantProposal) => void;
}) {
  return (
    <div className={`assistant-msg assistant-msg-${message.role}`}>
      <div className="assistant-bubble">{message.content}</div>
      {message.tools && message.tools.length > 0 && (
        <div className="muted smallText">Looked at: {message.tools.join(", ").replace(/_/g, " ")}</div>
      )}
      {(message.proposalIds ?? []).map((id) => {
        const p = proposals.get(id);
        return p ? <ProposalCard key={id} proposal={p} canCreateDrafts={canCreateDrafts} onChange={onProposal} /> : null;
      })}
    </div>
  );
}

/** Ask about your search in plain language. It can look things up; changes wait for your Approve. */
export function AssistantPanel() {
  const [open, setOpen] = useState(false);
  const [thread, setThread] = useState<AssistantThread | null>(null);
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const endRef = useRef<HTMLDivElement>(null);

  const load = useCallback(() => {
    api
      .assistantThread()
      .then(setThread)
      .catch((e) => setError(errorText(e)));
  }, []);

  useEffect(() => {
    if (open) load();
  }, [open, load]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [thread?.messages.length, sending]);

  const send = async (value: string) => {
    const content = value.trim();
    if (!content || sending) return;
    setSending(true);
    setError(null);
    setText("");
    try {
      const reply = await api.assistantSend(content);
      setThread((t) =>
        t ? { ...t, messages: [...t.messages, ...reply.messages], proposals: [...t.proposals, ...reply.proposals] } : t,
      );
      load();
    } catch (e) {
      setError(errorText(e));
      setText(content);
    } finally {
      setSending(false);
    }
  };

  const clear = async () => {
    await api.assistantClear().catch(() => undefined);
    load();
  };

  const updateProposal = (p: AssistantProposal) =>
    setThread((t) => (t ? { ...t, proposals: t.proposals.map((x) => (x.id === p.id ? p : x)) } : t));

  const proposals = new Map((thread?.proposals ?? []).map((p) => [p.id, p]));

  return (
    <>
      <button type="button" className="assistant-toggle" onClick={() => setOpen((o) => !o)}>
        {open ? "Close assistant" : "Ask assistant"}
      </button>
      {open && (
        <aside className="assistant-panel card">
          <div className="rowBetween">
            <strong>Assistant</strong>
            <div className="row" style={{ gap: "0.5rem" }}>
              {thread && (
                <span className="muted smallText">
                  {usd(thread.budget.spentThisMonthUsd)} of {usd(thread.budget.monthlyUsd)} this month
                </span>
              )}
              <button type="button" className="btn-secondary" onClick={() => void clear()} disabled={sending}>
                Clear
              </button>
            </div>
          </div>
          <div className="assistant-messages">
            {thread && thread.messages.length === 0 && (
              <div className="stack" style={{ gap: "0.4rem" }}>
                <span className="muted smallText">
                  Ask about your applications, tracker, Top Jobs, or costs. It can look things up and suggest
                  changes, but nothing changes (and nothing is ever sent) until you approve a card.
                </span>
                {EXAMPLES.map((q) => (
                  <button key={q} type="button" className="btn-secondary" onClick={() => void send(q)}>
                    {q}
                  </button>
                ))}
              </div>
            )}
            {thread?.messages.map((m) => (
              <Message
                key={m.id}
                message={m}
                proposals={proposals}
                canCreateDrafts={Boolean(thread.canCreateDrafts)}
                onProposal={updateProposal}
              />
            ))}
            {sending && <div className="muted smallText">Thinking…</div>}
            <div ref={endRef} />
          </div>
          {error && <div className="error smallText">{error}</div>}
          <form
            className="row"
            style={{ gap: "0.5rem" }}
            onSubmit={(e) => {
              e.preventDefault();
              void send(text);
            }}
          >
            <input
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder="Ask about your job search…"
              maxLength={2000}
              style={{ flex: 1 }}
              disabled={sending}
            />
            <button type="submit" disabled={sending || !text.trim()}>
              Send
            </button>
          </form>
        </aside>
      )}
    </>
  );
}
