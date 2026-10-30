import { useCallback, useEffect, useState } from "react";
import { api } from "../api/client";
import type { JdRemovalReason, JdReviewQueueItem, JdShadowReport } from "../types/gmail";

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

const REMOVAL_REASONS: Array<{ id: JdRemovalReason; label: string }> = [
  { id: "listing_unavailable", label: "Listing no longer available" },
  { id: "no_usable_jd", label: "No usable JD at URL" },
  { id: "wrong_posting", label: "Wrong posting" },
  { id: "wrong_location", label: "Wrong location" },
  { id: "other", label: "Other" },
];

const SignalLine = ({ label, signal }: { label: string; signal?: { verdict: string; provenance: string; note?: string } }) => {
  if (!signal) return null;
  return (
    <div className="smallText">
      <strong>{label}:</strong> {signal.verdict} · {signal.provenance}
      {signal.note ? ` — ${signal.note}` : ""}
    </div>
  );
};

const CandidateCard = ({
  item,
  busy,
  excluded,
  onRun,
}: {
  item: JdReviewQueueItem;
  busy: string | null;
  excluded?: boolean;
  onRun: (id: string, action: () => Promise<unknown>) => void;
}) => {
  const id = `${item.applicationKey}::${item.candidateId}`;
  const partial = item.completeness === "partial";
  const signals = item.evidence.signals;
  const identifier = item.sourceUrl;
  const [reason, setReason] = useState<JdRemovalReason | "">("");
  const savedFull = item.availability === "full_jd_saved";
  const canConfirm = Boolean(identifier) && !partial && item.reviewStatus !== "removed";
  return (
    <article className="card stack">
      <div className="rowBetween">
        <div>
          <strong>
            {item.company} · {item.role ?? "Untitled role"}
          </strong>
          <div className="muted smallText">
            Applied {item.appliedAt.slice(0, 10)} · {item.sourceType ?? "unknown source"} ·{" "}
            {item.availabilityLabel ?? item.completeness ?? "unknown completeness"}
            {item.candidateLocation ? ` · ${item.candidateLocation}` : ""}
          </div>
        </div>
        <span className="muted smallText">shadow: {item.shadow.recommendation.replaceAll("_", " ")}</span>
      </div>
      {item.sourceUrl && (
        <a href={item.sourceUrl} target="_blank" rel="noreferrer">
          {item.sourceUrl}
        </a>
      )}
      <div className="smallText">
        <strong>Geo:</strong> {item.geo?.status ?? "unknown"}
        {item.geo?.reason ? ` — ${item.geo.reason}` : ""}
      </div>
      {item.exclusionReason && <p className="smallText">{item.exclusionReason}</p>}
      {savedFull && item.reviewStatus === "removed" && (
        <p className="smallText muted">Stored JD text is preserved even though the listing URL is no longer in active review.</p>
      )}
      <div className="stack" style={{ gap: "0.2rem" }}>
        <SignalLine label="Company" signal={signals.company} />
        <SignalLine label="Title" signal={signals.title} />
        <SignalLine label="Requisition" signal={signals.requisitionId} />
        <SignalLine label="Location" signal={signals.location} />
        <SignalLine label="Posted date" signal={signals.postingDate} />
        <SignalLine label="Completeness" signal={signals.completeness} />
        <SignalLine label="Competing postings" signal={signals.competingPostings} />
      </div>
      {item.matchEvidence && item.matchEvidence.length > 0 && (
        <p className="smallText muted">Claude explanation: {item.matchEvidence.join(" · ")}</p>
      )}
      {item.shadow.blockers.length > 0 && (
        <p className="smallText">Blockers: {item.shadow.blockers.join(", ")}</p>
      )}
      <div className="row" style={{ flexWrap: "wrap", gap: "0.4rem" }}>
        {partial && identifier && item.reviewStatus !== "removed" && (
          <button
            className="btn-secondary"
            disabled={busy !== null}
            onClick={() => void onRun(`recheck-${id}`, () => api.gmailRevalidateCandidateCompleteness(item.applicationKey, identifier))}
          >
            {busy === `recheck-${id}` ? "Rechecking…" : "Recheck completeness"}
          </button>
        )}
        {excluded ? (
          <button
            className="btn-secondary"
            disabled={busy !== null || !identifier || item.reviewStatus === "rejected"}
            onClick={() => void onRun(`restore-${id}`, () => api.gmailRestoreCandidate(item.applicationKey, { url: identifier }))}
          >
            {busy === `restore-${id}` ? "Restoring…" : "Restore"}
          </button>
        ) : (
          <>
            <button
              disabled={busy !== null || !canConfirm}
              onClick={() => void onRun(`confirm-${id}`, () => api.gmailConfirmCandidate(item.applicationKey, { url: identifier }))}
            >
              {busy === `confirm-${id}` ? "Scoring…" : "This is the one"}
            </button>
            <button
              className="btn-secondary"
              disabled={busy !== null || !identifier}
              onClick={() => void onRun(`reject-${id}`, () => api.gmailRejectCandidate(item.applicationKey, { url: identifier }))}
            >
              {busy === `reject-${id}` ? "Rejecting…" : "Not this one"}
            </button>
            <select
              aria-label="Removal reason"
              value={reason}
              onChange={(e) => setReason(e.target.value as JdRemovalReason | "")}
              disabled={busy !== null}
            >
              <option value="">Remove reason…</option>
              {REMOVAL_REASONS.map((row) => (
                <option key={row.id} value={row.id}>
                  {row.label}
                </option>
              ))}
            </select>
            <button
              className="btn-secondary"
              disabled={busy !== null || !identifier || !reason}
              onClick={() =>
                void onRun(`remove-${id}`, () =>
                  api.gmailRemoveCandidate(item.applicationKey, { url: identifier, reason: reason as JdRemovalReason }),
                )
              }
            >
              {busy === `remove-${id}` ? "Removing…" : "Remove from review"}
            </button>
          </>
        )}
        {excluded && item.reviewStatus !== "removed" && item.reviewStatus !== "rejected" && (
          <button
            disabled={busy !== null || partial || !identifier}
            onClick={() => void onRun(`confirm-${id}`, () => api.gmailConfirmCandidate(item.applicationKey, { url: identifier }))}
          >
            {busy === `confirm-${id}` ? "Scoring…" : "This is the one"}
          </button>
        )}
      </div>
      <p className="muted smallText">
        Not this one = wrong JD for this application. Remove from review = hide a dead or unusable candidate without
        deciding identity.
      </p>
    </article>
  );
};

export const JdReviewPage = () => {
  const [items, setItems] = useState<JdReviewQueueItem[]>([]);
  const [excluded, setExcluded] = useState<JdReviewQueueItem[]>([]);
  const [report, setReport] = useState<JdShadowReport | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showExcluded, setShowExcluded] = useState(false);

  const load = useCallback(async () => {
    const [queue, shadow] = await Promise.all([api.gmailJdReviews(), api.gmailJdShadowReport()]);
    setItems(queue.reviews);
    setExcluded(queue.excluded ?? []);
    setReport(shadow);
  }, []);

  useEffect(() => {
    void load().catch((e) => setError(errorText(e)));
  }, [load]);

  const run = async (id: string, action: () => Promise<unknown>) => {
    setBusy(id);
    setError(null);
    try {
      await action();
      await load();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="stack">
      <div>
        <h2 style={{ margin: 0 }}>Pending JD review</h2>
        <p className="muted smallText">
          All-time queue, newest applications first — not limited by the dashboard lookback. Shadow
          recommendations never confirm or score. Match and score here or on the Applications dashboard;
          the tracker does not duplicate JD matching.
        </p>
      </div>

      {report && (
        <div className="card stack">
          <strong>Shadow auto-confirmation (read-only)</strong>
          <p className="smallText">
            Reviewed {report.reviewed} · shadow-eligible {report.shadowEligible} · eligible confirmed {report.eligibleConfirmed} ·
            eligible rejected/corrected {report.eligibleRejectedOrCorrected} (false positives {report.falsePositives}) ·
            false negatives {report.falseNegatives}
          </p>
          {report.disagreementReasons.length > 0 && (
            <p className="smallText muted">
              Disagreements: {report.disagreementReasons.map((row) => `${row.reason} (${row.count})`).join("; ")}
            </p>
          )}
          <p className="muted smallText">{report.limitation}</p>
        </div>
      )}

      {error && <p className="error">{error}</p>}

      {items.length === 0 && !error && <p className="muted">No pending JD candidates.</p>}

      {items.map((item) => (
        <CandidateCard key={`${item.applicationKey}::${item.candidateId}`} item={item} busy={busy} onRun={run} />
      ))}

      {excluded.length > 0 && (
        <div className="card stack">
          <button className="btn-secondary" onClick={() => setShowExcluded((open) => !open)}>
            {showExcluded ? "Hide" : "Show"} removed / excluded candidates ({excluded.length})
          </button>
          {showExcluded &&
            excluded.map((item) => (
              <CandidateCard
                key={`ex-${item.applicationKey}::${item.candidateId}`}
                item={item}
                busy={busy}
                excluded
                onRun={run}
              />
            ))}
        </div>
      )}
    </section>
  );
};
