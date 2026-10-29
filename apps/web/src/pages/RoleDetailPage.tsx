import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useNavigate } from "react-router-dom";
import { api } from "../api/client";
import { RECOMMENDATION_LABELS, type JobRecord, type JobStatus } from "../types/job";
import { JsonPanel } from "../components/JsonPanel";
import {
  agencyDisclosureNote,
  appliedAtIso,
  appliedAtToDateInputValue,
  displayedJobRecommendation,
  displayedJobScore,
  jdSourceText,
  jobHeaderLabel,
  jobScoreTitle,
} from "../lib/jobDisplay";

const statuses: JobStatus[] = [
  "to_review",
  "applied",
  "skip",
  "rejected",
  "interviewing",
  "assessment",
  "closed",
  "offer",
  "lapsed",
];

export const RoleDetailPage = () => {
  const { id = "" } = useParams();
  const navigate = useNavigate();
  const [job, setJob] = useState<(JobRecord & { statusHistory?: unknown[] }) | null>(null);
  const [status, setStatus] = useState<JobStatus>("to_review");
  const [note, setNote] = useState("");
  const [notes, setNotes] = useState("");
  const [appliedAt, setAppliedAt] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.getJob(id).then((data) => {
      setJob(data);
      setStatus(data.status);
      setNotes(data.tracker.notes ?? "");
      setAppliedAt(appliedAtToDateInputValue(data.tracker.appliedAt || appliedAtIso(data)));
    });
  }, [id]);

  if (!job) return <p>Loading...</p>;

  const saveStatus = async () => {
    setBusy(true);
    const updated = await api.updateStatus(job.id, status, note);
    setJob({ ...job, ...updated });
    setNotes(updated.tracker.notes ?? notes);
    setAppliedAt(appliedAtToDateInputValue(updated.tracker.appliedAt || appliedAtIso(updated)));
    setNote("");
    setBusy(false);
  };

  const saveNotes = async () => {
    setBusy(true);
    const updated = await api.updateNotes(job.id, notes);
    setJob({ ...job, ...updated });
    setBusy(false);
  };

  const saveAppliedAt = async () => {
    if (!appliedAt.trim()) return;
    setBusy(true);
    try {
      const updated = await api.updateAppliedAt(job.id, appliedAt);
      setJob({ ...job, ...updated });
      setStatus(updated.status);
      setAppliedAt(appliedAtToDateInputValue(updated.tracker.appliedAt || appliedAtIso(updated)));
    } finally {
      setBusy(false);
    }
  };

  const markRejected = async () => {
    setBusy(true);
    const updated = await api.updateStatus(job.id, "rejected", "Manually marked rejected");
    setJob({ ...job, ...updated });
    setStatus("rejected");
    setBusy(false);
  };

  const removeFromTracker = async () => {
    const ok = window.confirm(
      "Remove this job from the tracker? This cannot be undone and will update applied counts.",
    );
    if (!ok) return;
    setBusy(true);
    await api.deleteJob(job.id);
    setBusy(false);
    navigate("/tracker");
  };

  const jdText = jdSourceText(job);

  const agencyNote = agencyDisclosureNote(job.extracted);
  return (
    <section className="stack">
      <h2>Role Detail</h2>
      <p className="row">
        <Link to={`/jobs/${job.id}`}>← Scoring & generated assets</Link>
      </p>
      <div className="card">
        <h3>{jobHeaderLabel(job.extracted)}</h3>
        {agencyNote ? <p className="muted agency-note">{agencyNote}</p> : null}
        <p>
          Score:{" "}
          <strong title={jobScoreTitle(job)}>
            {displayedJobScore(job)}
            {job.effectiveScore?.scoreRevised ? " (revised)" : ""}
            {job.effectiveScore?.fingerprintStale ? " (revision inactive)" : ""}
          </strong>{" "}
          | Recommendation:{" "}
          <strong>
            {RECOMMENDATION_LABELS[displayedJobRecommendation(job) as keyof typeof RECOMMENDATION_LABELS] ??
              displayedJobRecommendation(job)}
          </strong>{" "}
          | Resume:{" "}
          <strong>{job.recommendedResume}</strong>
        </p>
        <p>
          Top match: {job.topMatch}
          <br />
          Main risk: {job.mainRisk}
        </p>
        <div className="row">
          <select value={status} onChange={(e) => setStatus(e.target.value as JobStatus)}>
            {statuses.map((item) => (
              <option key={item} value={item}>
                {item}
              </option>
            ))}
          </select>
          <input placeholder="Status note" value={note} onChange={(e) => setNote(e.target.value)} />
          <button onClick={saveStatus} disabled={busy}>Update status</button>
          <button onClick={markRejected} disabled={busy}>Mark rejected</button>
          <button onClick={removeFromTracker} disabled={busy}>Remove from tracker</button>
        </div>
        <div className="row" style={{ marginTop: "0.75rem", alignItems: "center", gap: "0.5rem" }}>
          <label htmlFor="applied-at">Date applied</label>
          <input
            id="applied-at"
            type="date"
            value={appliedAt}
            onChange={(e) => setAppliedAt(e.target.value)}
          />
          <button onClick={saveAppliedAt} disabled={busy || !appliedAt.trim()}>
            Save date applied
          </button>
          <span className="muted" style={{ fontSize: "0.85rem" }}>
            Updates the tracker Date column and applied counters.
          </span>
        </div>
        <div className="stack">
          <label htmlFor="notes">Tracker notes</label>
          <textarea id="notes" rows={5} value={notes} onChange={(e) => setNotes(e.target.value)} />
          <div>
            <button onClick={saveNotes} disabled={busy}>Save notes</button>
          </div>
        </div>
        {jdText ? (
          <details className="jd-source-block">
            <summary>JD source / input</summary>
            <pre className="jd-source-pre">{jdText}</pre>
          </details>
        ) : (
          <p className="muted">No JD text stored (add via triage or spreadsheet import).</p>
        )}
        {(job.rationale?.length ?? 0) > 0 || (job.risks?.length ?? 0) > 0 ? (
          <div className="stack rationale-block">
            {job.rationale && job.rationale.length > 0 ? (
              <div>
                <h4 className="rationale-heading">Rationale</h4>
                <ul className="rationale-list">
                  {job.rationale.map((line, i) => (
                    <li key={`r-${i}`}>{line}</li>
                  ))}
                </ul>
              </div>
            ) : null}
            {job.risks && job.risks.length > 0 ? (
              <div>
                <h4 className="rationale-heading">Risks</h4>
                <ul className="rationale-list">
                  {job.risks.map((line, i) => (
                    <li key={`k-${i}`}>{line}</li>
                  ))}
                </ul>
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
      <div className="grid cols2">
        <article className="card">
          <h4>Extracted Job Data</h4>
          <JsonPanel value={job.extracted} />
        </article>
        <article className="card">
          <h4>Rules + Score</h4>
          <JsonPanel value={{ rules: job.rules, score: job.score, recommendation: job.recommendation }} />
        </article>
      </div>
      <article className="card">
        <h4>Generated Assets</h4>
        <JsonPanel value={job.generated} />
      </article>
      <article className="card">
        <h4>Score History</h4>
        <JsonPanel value={job.scoreHistory ?? []} />
      </article>
      <article className="card">
        <h4>Status History</h4>
        <JsonPanel value={job.statusHistory ?? []} />
      </article>
    </section>
  );
};
