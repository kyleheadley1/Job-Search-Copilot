import { useEffect, useState } from "react";
import type { DraftCreated, ReplyTarget } from "../types/agent";

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * Review the recipient, subject, and text, then create a Gmail draft in the right thread.
 * The app can only create drafts; you send from Gmail.
 */
export function DraftEditor({
  initialBody,
  loadTarget,
  create,
  onCreated,
  onCancel,
}: {
  initialBody: string;
  loadTarget: () => Promise<ReplyTarget>;
  create: (to: string, subject: string, body: string) => Promise<DraftCreated>;
  onCreated: (draft: DraftCreated) => void;
  onCancel: () => void;
}) {
  const [target, setTarget] = useState<ReplyTarget | null>(null);
  const [to, setTo] = useState("");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState(initialBody);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let live = true;
    loadTarget()
      .then((t) => {
        if (!live) return;
        setTarget(t);
        setTo(t.to);
        setSubject(t.subject);
      })
      .catch((e) => live && setError(errorText(e)));
    return () => {
      live = false;
    };
  }, [loadTarget]);

  const submit = async () => {
    setSaving(true);
    setError(null);
    try {
      onCreated(await create(to, subject, body));
    } catch (e) {
      setError(errorText(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="stack" style={{ gap: "0.35rem", marginTop: "0.4rem" }}>
      {!target && !error && <span className="muted smallText">Finding the thread…</span>}
      {target && (
        <>
          <span className="muted smallText">
            {target.mode === "compose" ? "New email" : "Reply in thread"}
          </span>
          <label className="smallText">
            To{" "}
            <input
              type="email"
              value={to}
              onChange={(e) => setTo(e.target.value)}
              placeholder="recruiter@company.com"
              style={{ width: "100%" }}
            />
          </label>
          <label className="smallText">
            Subject{" "}
            <input
              type="text"
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              placeholder="Email subject"
              style={{ width: "100%" }}
            />
          </label>
          {target.mode === "compose" ? (
            <span className="muted smallText">
              Opens a new email (not a calendar-invite thread). Confirm the recipient and subject before creating the
              draft.
            </span>
          ) : (
            !target.to && (
              <span className="muted smallText">
                This thread only has automated senders. Enter the recruiter&apos;s or interviewer&apos;s address.
              </span>
            )
          )}
          <textarea value={body} onChange={(e) => setBody(e.target.value)} rows={8} style={{ width: "100%" }} />
          <div className="row" style={{ gap: "0.5rem" }}>
            <button
              type="button"
              onClick={() => void submit()}
              disabled={saving || !to.trim() || !subject.trim() || !body.trim()}
            >
              {saving ? "Creating draft…" : "Create Gmail draft"}
            </button>
            <button type="button" className="btn-secondary" onClick={onCancel} disabled={saving}>
              Cancel
            </button>
            <span className="muted smallText">Nothing is sent. You review and send it from Gmail.</span>
          </div>
        </>
      )}
      {error && <span className="error-text smallText">{error}</span>}
    </div>
  );
}
