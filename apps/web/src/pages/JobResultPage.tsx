import { useEffect, useState } from "react";
import { useLocation, useParams } from "react-router-dom";
import { api } from "../api/client";
import { RECOMMENDATION_LABELS, type JobRecord } from "../types/job";
import { ScoreBadge } from "../components/ScoreBadge";
import { StatusBadge } from "../components/StatusBadge";
import { JsonPanel } from "../components/JsonPanel";
import { hasJdSource, agencyDisclosureNote, jobHeaderLabel, salaryAskDisplay } from "../lib/jobDisplay";
import { extractBoardMatchPercent } from "../lib/jobBoardMatch";
import {
  CAPABILITY_MAX_LABELS,
  formatLeverTag,
  getScoreDisplay,
  leverClassName,
} from "../lib/scoreDisplay";
import { buildKeyRisks, decisionSummaryLine, selectTopFits } from "../lib/resultSummary";
import {
  formatDuration,
  formatRelativeScoredAt,
  firstScoredAtIso,
  isPlausibleTriageDuration,
  progressForPhase,
  readStoredTriageTiming,
  writeStoredTriageTiming,
  type TriageProgressPhase,
  type TriageTimingPayload,
} from "../lib/triageTiming";

type AssetTab = "cover" | "why" | "points" | "bullets" | "raw";

function tabHasContent(job: JobRecord, tab: AssetTab): boolean {
  if (tab === "raw") return true;
  if (tab === "cover") return Boolean(job.generated.coverLetter?.trim());
  if (tab === "why") return Boolean(job.generated.whyCompany?.trim());
  if (tab === "points") return (job.generated.talkingPoints?.length ?? 0) > 0;
  if (tab === "bullets") return (job.generated.tailoredBulletCandidates?.length ?? 0) > 0;
  return false;
}

function renderTextParagraphs(text: string, fallback = "Not generated") {
  const parts = text
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean);
  if (!parts.length) return <p>{fallback}</p>;
  return parts.map((p) => <p key={p}>{p}</p>);
}

export const JobResultPage = () => {
  const { id = "" } = useParams();
  const location = useLocation();
  const navTiming = (location.state as { triageTiming?: TriageTimingPayload; triageResult?: JobRecord } | undefined)?.triageTiming;
  const navTriageResult = (location.state as { triageResult?: JobRecord } | undefined)?.triageResult;
  const [job, setJob] = useState<JobRecord | null>(null);
  const [error, setError] = useState("");
  const [tab, setTab] = useState<AssetTab>("cover");
  const [tracked, setTracked] = useState(false);
  const [canConfirmApplied, setCanConfirmApplied] = useState(false);
  const [busyConfirm, setBusyConfirm] = useState(false);
  const [confirmMsg, setConfirmMsg] = useState("");
  const [assetBusy, setAssetBusy] = useState(false);
  const [assetMsg, setAssetMsg] = useState("");
  const [retriageBusy, setRetriageBusy] = useState(false);
  const [retriageMsg, setRetriageMsg] = useState("");
  const [startedAt, setStartedAt] = useState<number | null>(navTiming?.startedAt ?? null);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [finishedMs, setFinishedMs] = useState<number | null>(null);
  const [progressPhase, setProgressPhase] = useState<TriageProgressPhase>("idle");

  useEffect(() => {
    if (!id) return;
    if (navTriageResult?.id === id) {
      const fresh = navTriageResult as JobRecord & { tracked?: boolean; canConfirmApplied?: boolean };
      setJob(fresh);
      setTracked(Boolean(fresh.tracked));
      setCanConfirmApplied(Boolean(fresh.canConfirmApplied));
      setProgressPhase("result_ready");
      if (startedAt && finishedMs === null) {
        const done = Date.now() - startedAt;
        setFinishedMs(done);
        setElapsedMs(done);
        writeStoredTriageTiming(id, { startedAt, finishedMs: done });
      }
      return;
    }
    const stored = readStoredTriageTiming(id);
    if (stored) {
      setStartedAt(stored.startedAt);
      setFinishedMs(stored.finishedMs);
      setProgressPhase("result_ready");
    } else if (navTiming?.startedAt) {
      setStartedAt(navTiming.startedAt);
      setFinishedMs(null);
      setProgressPhase("result_fetch_in_flight");
    }
  }, [id, navTiming?.startedAt, navTriageResult, startedAt, finishedMs]);

  useEffect(() => {
    if (!startedAt || finishedMs !== null || !!job) return;
    const update = () => setElapsedMs(Date.now() - startedAt);
    update();
    const timer = window.setInterval(update, 200);
    return () => window.clearInterval(timer);
  }, [startedAt, finishedMs, job]);

  useEffect(() => {
    if (!id || navTriageResult?.id === id) return;
    setProgressPhase("result_fetch_in_flight");
    api
      .getJob(id)
      .then((data) => {
        setJob(data);
        setTracked(Boolean(data.tracked));
        setCanConfirmApplied(Boolean(data.canConfirmApplied));
        setProgressPhase("result_ready");
        if (startedAt && finishedMs === null) {
          const done = Date.now() - startedAt;
          setFinishedMs(done);
          setElapsedMs(done);
          writeStoredTriageTiming(data.id, { startedAt, finishedMs: done });
        }
      })
      .catch((err) => setError(err.message));
  }, [id, startedAt, finishedMs, navTriageResult?.id]);

  const ensureAssets = async (nextTab: AssetTab) => {
    if (!job || nextTab === "raw" || tabHasContent(job, nextTab) || assetBusy) return;
    const genAiBlocked =
      Boolean(job.scoreDisplay?.genAiRestrictionWarning || job.rules?.jdProhibitsGenAI) &&
      (nextTab === "cover" || nextTab === "points");
    if (genAiBlocked) {
      setAssetMsg(
        job.scoreDisplay?.genAiRestrictionWarning ??
          "This employer restricts GenAI-generated content in applications — drafts not auto-generated.",
      );
      return;
    }
    setAssetBusy(true);
    setAssetMsg("Generating assets...");
    try {
      const updated = await api.regenerateAssets(job.id, false);
      setJob(updated);
      setAssetMsg("Assets generated.");
    } catch (err) {
      setAssetMsg(err instanceof Error ? err.message : "Asset generation failed.");
    } finally {
      setAssetBusy(false);
    }
  };

  const openTab = async (nextTab: AssetTab) => {
    setTab(nextTab);
    await ensureAssets(nextTab);
  };

  const confirmApplied = async () => {
    if (!job) return;
    setBusyConfirm(true);
    setConfirmMsg("");
    try {
      const saved = await api.confirmApplied(job.id);
      setJob(saved);
      setTracked(true);
      setCanConfirmApplied(false);
      setConfirmMsg("Confirmed and added to tracker.");
    } catch (err) {
      setConfirmMsg(err instanceof Error ? err.message : "Could not confirm applied.");
    } finally {
      setBusyConfirm(false);
    }
  };

  const rerunTriage = async () => {
    if (!job || retriageBusy) return;
    setRetriageBusy(true);
    setRetriageMsg("");
    setError("");
    const start = Date.now();
    setStartedAt(start);
    setFinishedMs(null);
    setElapsedMs(0);
    setProgressPhase("triage_request_in_flight");
    try {
      const updated = await api.retriage(job.id);
      setJob(updated);
      setTracked(Boolean(updated.tracked));
      setCanConfirmApplied(Boolean(updated.canConfirmApplied));
      const done = Date.now() - start;
      setFinishedMs(done);
      setElapsedMs(done);
      writeStoredTriageTiming(job.id, { startedAt: start, finishedMs: done });
      setProgressPhase("result_ready");
      setRetriageMsg("Re-scored with current rules.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Re-triage failed.");
      setProgressPhase("idle");
    } finally {
      setRetriageBusy(false);
    }
  };

  if (error) return <p className="error">{error}</p>;
  if (!job) {
    return (
      <section className="stack">
        {startedAt ? (
          <article className="card triageTiming">
            <p className="muted">Thinking...</p>
            <div className="triageProgressTrack" aria-hidden>
              <div className="triageProgressFill" style={{ width: `${progressForPhase(progressPhase)}%` }} />
            </div>
            <p className="muted">Elapsed: {formatDuration(elapsedMs)}</p>
          </article>
        ) : (
          <p>Loading...</p>
        )}
      </section>
    );
  }
  const topFits = selectTopFits(job, 2);
  const topRisks = buildKeyRisks(job, 5);
  const scoreDisplay = getScoreDisplay(job.score);
  const summaryLine = decisionSummaryLine(job);
  const agencyNote = agencyDisclosureNote(job.extracted);
  const boardMatchPct = extractBoardMatchPercent(job.extracted.rawText);
  const salaryDisplay = salaryAskDisplay(job);
  return (
    <section className="stack">
      <header className="rowBetween">
        <div>
          <h2>{jobHeaderLabel(job.extracted)}</h2>
          {agencyNote ? <p className="muted agency-note">{agencyNote}</p> : null}
          <p className="muted">{summaryLine}</p>
        </div>
        <div className="row">
          {boardMatchPct != null ? (
            <span className="pill neutral" title="Untrusted third-party match % from pasted job-board UI — not used in app score">
              Board match {boardMatchPct}% (untrusted)
            </span>
          ) : null}
          <ScoreBadge score={job.score.total} />
          <StatusBadge status={job.status} />
        </div>
      </header>

      <div className="grid cols2">
        <article className="card">
          <h3>Decision</h3>
          <p className="decisionRecommendation">
            {scoreDisplay?.bandHeadline ?? RECOMMENDATION_LABELS[job.recommendation] ?? "—"}
          </p>
          {scoreDisplay?.actionLine ? (
            <p className="actionLine">{scoreDisplay.actionLine}</p>
          ) : null}
          {scoreDisplay?.applyNowUrgencyNote ? (
            <p className="applyNowUrgency">
              Apply now: {scoreDisplay.applyNowUrgencyNote}
            </p>
          ) : null}
          {scoreDisplay?.eligibilityAdvisories?.length
            ? scoreDisplay.eligibilityAdvisories.map((advisory) => (
                <p key={advisory.reason} className="eligibilityAdvisory">
                  ⚠ Verify eligibility — {advisory.reason}
                </p>
              ))
            : scoreDisplay?.eligibilityAdvisory ? (
                <p className="eligibilityAdvisory">
                  ⚠ Verify eligibility — {scoreDisplay.eligibilityAdvisory.reason}
                </p>
              ) : null}
          {hasJdSource(job) ? (
            <button onClick={() => void rerunTriage()} disabled={retriageBusy || busyConfirm}>
              {retriageBusy ? "Re-scoring..." : "Re-run triage"}
            </button>
          ) : null}
          {retriageMsg ? <p className="muted">{retriageMsg}</p> : null}
          {!tracked ? (
            <p className="muted">Not added to tracker yet. It is saved only after you confirm you applied.</p>
          ) : (
            <p className="muted">{job.status === "to_review" ? "In tracker, not marked applied yet." : "In tracker."}</p>
          )}
          {canConfirmApplied ? (
            <button onClick={confirmApplied} disabled={busyConfirm}>
              {busyConfirm ? "Confirming..." : "Confirm I applied"}
            </button>
          ) : null}
          {confirmMsg ? <p className="muted">{confirmMsg}</p> : null}
          <p>Salary ask: {salaryDisplay.point ?? "N/A"}</p>
          {salaryDisplay.rangeIfNeeded ? (
            <p className="muted">Range if needed: {salaryDisplay.rangeIfNeeded}</p>
          ) : null}
          {finishedMs !== null && isPlausibleTriageDuration(finishedMs) ? (
            <p className="muted">Scored in {formatDuration(finishedMs)}</p>
          ) : job ? (
            <p className="muted">Last scored {formatRelativeScoredAt(firstScoredAtIso(job))}</p>
          ) : null}
          <p>Recommended resume: {job.recommendedResume}</p>
          <h4>Why consider</h4>
          <ul>{topFits.map((item) => <li key={item}>{item}</li>)}</ul>
          <h4>Key risks</h4>
          <ul>{topRisks.map((item) => <li key={item}>{item}</li>)}</ul>
        </article>
        <article className="card">
          <h3>Score Breakdown</h3>
          {scoreDisplay ? (
            <>
              <div className="scoreSection">
                <h4>Capability: {scoreDisplay.capability}/100</h4>
                <ul className="scoreDecomp">
                  <li>
                    Stack fit{" "}
                    <span className="scoreValue">
                      {scoreDisplay.capabilityBreakdown.stackFit}/{CAPABILITY_MAX_LABELS.stackFit}
                    </span>
                  </li>
                  <li>
                    Level fit{" "}
                    <span className="scoreValue">
                      {scoreDisplay.capabilityBreakdown.levelFit}/{CAPABILITY_MAX_LABELS.levelFit}
                    </span>
                  </li>
                  <li>
                    Functional overlap{" "}
                    <span className="scoreValue">
                      {scoreDisplay.capabilityBreakdown.functionalOverlap}/
                      {CAPABILITY_MAX_LABELS.functionalOverlap}
                    </span>
                  </li>
                </ul>
                {scoreDisplay.differentiatorCoverageNote ? (
                  <p className="muted">{scoreDisplay.differentiatorCoverageNote}</p>
                ) : null}
              </div>

              <div className="scoreSection">
                <h4>
                  Survivability: {scoreDisplay.survivability.toFixed(2)}{" "}
                  <span className="muted">(adjustment input, not a multiplier)</span>
                </h4>
                <ul className="scoreDecomp">
                  {scoreDisplay.survivabilityRows.map((row) => (
                    <li key={row.key}>
                      <span className="scoreFactor">{row.label}</span>{" "}
                      <span className="scoreValue">{row.score.toFixed(2)}</span>{" "}
                      <span className={leverClassName(row.lever, row.bindingness)}>
                        {formatLeverTag(row.lever, row.leverLabel)}
                      </span>
                    </li>
                  ))}
                </ul>
                {scoreDisplay.poolFriendlinessNote ? (
                  <p className="muted">{scoreDisplay.poolFriendlinessNote}</p>
                ) : null}
                {scoreDisplay.credentialBoostNote ? (
                  <p className="muted">{scoreDisplay.credentialBoostNote}</p>
                ) : null}
                {scoreDisplay.degreePositiveNote ? (
                  <p className="muted">{scoreDisplay.degreePositiveNote}</p>
                ) : null}
                {scoreDisplay.contractCaveat ? (
                  <p className="muted">{scoreDisplay.contractCaveat}</p>
                ) : null}
              </div>

              <p className="scoreFinal">
                Final: {scoreDisplay.final}/100{" "}
                <span className="muted">({scoreDisplay.scoreDerivation})</span>
              </p>

              <div className="scoreSection">
                <h4>Hard gates (auto-disqualify)</h4>
                {scoreDisplay.hardGates.length ? (
                  <ul>{scoreDisplay.hardGates.map((gate) => <li key={gate}>{gate}</li>)}</ul>
                ) : (
                  <p className="muted">None — no auto-disqualifiers.</p>
                )}
              </div>

              <div className="scoreSection">
                <h4>Survivability penalties</h4>
                {scoreDisplay.survivabilityPenalties.length ? (
                  <ul className="scoreDecomp">
                    {scoreDisplay.survivabilityPenalties.map((penalty) => (
                      <li key={penalty.message}>
                        {penalty.message}{" "}
                        <span className={leverClassName(penalty.lever)}>
                          {formatLeverTag(penalty.lever, penalty.leverLabel)}
                        </span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="muted">None identified.</p>
                )}
              </div>
            </>
          ) : (
            <p className="muted">
              Full breakdown unavailable for this score. Re-run triage to refresh with the capability +
              survivability composite model.
            </p>
          )}
        </article>
      </div>

      <div className="tabs">
        <button onClick={() => void openTab("cover")}>Cover Letter</button>
        <button onClick={() => void openTab("why")}>Why Company</button>
        <button onClick={() => void openTab("points")}>Talking Points</button>
        <button onClick={() => void openTab("bullets")}>Bullet Candidates</button>
        <button onClick={() => void openTab("raw")}>Raw Extraction</button>
      </div>
      {assetMsg ? <p className="muted">{assetMsg}</p> : null}
      {(tab === "cover" || tab === "points") && scoreDisplay?.genAiRestrictionWarning ? (
        <article className="card" role="alert">
          <p>
            <strong>GenAI restriction:</strong> {scoreDisplay.genAiRestrictionWarning}
          </p>
        </article>
      ) : null}
      <article className="card">
        {tab === "cover" ? (
          scoreDisplay?.genAiRestrictionWarning && !job.generated.coverLetter?.trim() ? (
            <p className="muted">Auto-generation suppressed for this employer — draft offline from an outline only.</p>
          ) : (
            renderTextParagraphs(job.generated.coverLetter ?? "", "Not generated")
          )
        ) : null}
        {tab === "why" ? renderTextParagraphs(job.generated.whyCompany ?? "", "Not generated") : null}
        {tab === "points" ? (
          scoreDisplay?.genAiRestrictionWarning && !(job.generated.talkingPoints?.length ?? 0) ? (
            <p className="muted">Auto-generation suppressed for this employer — draft talking points offline.</p>
          ) : (
            <ul>{(job.generated.talkingPoints ?? []).map((item) => <li key={item}>{item}</li>)}</ul>
          )
        ) : null}
        {tab === "bullets" ? (
          <ul>{(job.generated.tailoredBulletCandidates ?? []).map((item) => <li key={item}>{item}</li>)}</ul>
        ) : null}
        {tab === "raw" ? <JsonPanel value={job.extracted} /> : null}
      </article>
    </section>
  );
};
