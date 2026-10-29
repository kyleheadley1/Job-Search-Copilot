import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import type { MouseEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api } from "../api/client";
import type { JobRecord, JobStatus } from "../types/job";
import { ScoreBadge } from "../components/ScoreBadge";
import { StatusBadge } from "../components/StatusBadge";
import { FilterBar } from "../components/FilterBar";
import { etDateKey, etRangeKeys, isDateKeyInRange } from "../lib/dateEt";
import {
  appliedAtIso,
  appliedDateIso,
  appliedAtToDateInputValue,
  companyDisplayLabel,
  displayedJobScore,
  hasJdSource,
  isAppliedPipelineStatus,
  jobScoreTitle,
  salaryAskCompact,
  salaryAskLabel,
  trackerDisplayDate,
  tsOnly,
} from "../lib/jobDisplay";
import { resolveDisplayTitle } from "../lib/roleTitleDisplay";

const LS_SHOW_EXTRAS = "trackerShowSheetCols";
const LS_SORT_KEY = "trackerSortKey";
const LS_SORT_DIR = "trackerSortDir";

const PRIMARY_COLUMNS = [
  "company",
  "role",
  "score",
  "recommendedAction",
  "status",
  "resume",
  "topMatch",
  "mainRisk",
  "salary",
  "notes",
  "applied",
] as const;

const EXTRA_COLUMNS = ["rank", "discussed", "originalAlt", "priority"] as const;

type PrimaryColumn = (typeof PRIMARY_COLUMNS)[number];
type ExtraColumn = (typeof EXTRA_COLUMNS)[number];

/** Columns that support sort (pipeline order for status — not alphabetical). */
const SORTABLE_KEYS = [
  "company",
  "role",
  "score",
  "status",
  "resume",
  "salary",
  "applied",
  "rank",
  "priority",
] as const;

type TrackerSortKey = (typeof SORTABLE_KEYS)[number];

type SortDir = "asc" | "desc";

function readLs(key: string, fallback: string): string {
  if (typeof localStorage === "undefined") return fallback;
  return localStorage.getItem(key) ?? fallback;
}

function isSortableKey(key: string): key is TrackerSortKey {
  return (SORTABLE_KEYS as readonly string[]).includes(key);
}

function companyCell(job: JobRecord): string {
  return (
    companyDisplayLabel(job.extracted) ||
    tsOnly(job, "company")
  );
}

function roleCell(job: JobRecord): string {
  const fromExtracted = resolveDisplayTitle(job.extracted);
  if (fromExtracted) return fromExtracted;
  return tsOnly(job, "role");
}

function companyKey(job: JobRecord): string {
  return companyCell(job).trim().toLowerCase();
}

function statusText(job: JobRecord): string {
  return (job.tracker.statusOutcome ?? job.status).trim() || job.status;
}

function normalizeStatusText(s: string): string {
  return s.trim().toLowerCase().replace(/[_\s-]+/g, " ");
}

function statusSecondaryText(job: JobRecord): string {
  const outcome = (job.tracker.statusOutcome ?? "").trim();
  if (!outcome) return "";
  return normalizeStatusText(outcome) === normalizeStatusText(job.status) ? "" : outcome;
}

function trackerDateMs(job: JobRecord): number {
  const t = new Date(trackerDisplayDate(job).sortIso).getTime();
  return Number.isFinite(t) ? t : 0;
}

function trackerDateKey(job: JobRecord): string {
  const ms = trackerDateMs(job);
  if (!ms) return "";
  return etDateKey(new Date(ms));
}

function rowDotTone(job: JobRecord): "green" | "yellow" | "red" | "blue" {
  if (job.tracker.color) return job.tracker.color;
  if (job.status === "offer") return "green";
  if (job.status === "skip" || job.status === "rejected" || job.status === "closed" || job.status === "lapsed") {
    return "red";
  }
  if (job.status === "interviewing" || job.status === "assessment") return "blue";
  return "yellow";
}

function salarySortValue(job: JobRecord): number {
  const s = job.salaryAsk;
  if (typeof s.number === "number") return s.number;
  if (typeof s.rangeMin === "number") return s.rangeMin;
  if (typeof s.rangeMax === "number") return s.rangeMax;
  return Number.NaN;
}

function rankSortValue(job: JobRecord): number {
  const r = tsOnly(job, "rank").trim();
  if (!r) return Number.NaN;
  const n = Number(r.replace(/[^\d.-]/g, ""));
  return Number.isFinite(n) ? n : Number.NaN;
}

/** Workflow / pipeline order (best progress first). */
const STATUS_ORDER: JobStatus[] = [
  "offer",
  "interviewing",
  "assessment",
  "applied",
  "to_review",
  "skip",
  "lapsed",
  "rejected",
  "closed",
];

function statusRank(s: JobStatus): number {
  const i = STATUS_ORDER.indexOf(s);
  return i === -1 ? 99 : i;
}

function compareJobs(a: JobRecord, b: JobRecord, key: TrackerSortKey, dir: SortDir): number {
  const m = dir === "asc" ? 1 : -1;
  let cmp = 0;
  switch (key) {
    case "company":
      cmp = companyCell(a).localeCompare(companyCell(b), undefined, { sensitivity: "base" });
      break;
    case "role":
      cmp = roleCell(a).localeCompare(roleCell(b), undefined, { sensitivity: "base" });
      break;
    case "score":
      cmp = displayedJobScore(a) - displayedJobScore(b);
      break;
    case "status":
      cmp = statusRank(a.status) - statusRank(b.status);
      if (cmp === 0) cmp = statusText(a).localeCompare(statusText(b), undefined, { sensitivity: "base" });
      break;
    case "resume":
      cmp = a.recommendedResume.localeCompare(b.recommendedResume);
      break;
    case "salary": {
      const va = salarySortValue(a);
      const vb = salarySortValue(b);
      const na = Number.isFinite(va) ? va : -1;
      const nb = Number.isFinite(vb) ? vb : -1;
      cmp = na - nb;
      break;
    }
    case "applied": {
      const appliedA = Boolean(appliedDateIso(a));
      const appliedB = Boolean(appliedDateIso(b));
      if (appliedA !== appliedB) return appliedA ? -1 : 1;
      cmp = trackerDateMs(a) - trackerDateMs(b);
      break;
    }
    case "rank": {
      const ra = rankSortValue(a);
      const rb = rankSortValue(b);
      cmp = (Number.isFinite(ra) ? ra : 1e9) - (Number.isFinite(rb) ? rb : 1e9);
      break;
    }
    case "priority":
      cmp = (a.tracker.priority ?? tsOnly(a, "priority")).localeCompare(
        b.tracker.priority ?? tsOnly(b, "priority"),
        undefined,
        { sensitivity: "base" },
      );
      break;
    default:
      cmp = 0;
  }
  return cmp * m;
}

function defaultDirForKey(key: TrackerSortKey): SortDir {
  if (key === "applied" || key === "score" || key === "rank") return "desc";
  return "asc";
}

const queryString = (params: Record<string, string | boolean | undefined>): string => {
  const q = new URLSearchParams();
  Object.entries(params).forEach(([k, value]) => {
    if (value === undefined || value === "") return;
    q.set(k, String(value));
  });
  const out = q.toString();
  return out ? `?${out}` : "";
};

export const TrackerPage = () => {
  const navigate = useNavigate();
  const [jobs, setJobs] = useState<JobRecord[]>([]);
  const [totalAll, setTotalAll] = useState(0);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [status, setStatus] = useState("");
  const [company, setCompany] = useState("");
  const [resume, setResume] = useState("");
  const [recommendation, setRecommendation] = useState("");
  const [minScore, setMinScore] = useState("");
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");
  const [shortlistOnly, setShortlistOnly] = useState(false);
  const [shortlistTotal, setShortlistTotal] = useState(0);
  const [refreshShortlistBusy, setRefreshShortlistBusy] = useState(false);
  const [refreshShortlistMessage, setRefreshShortlistMessage] = useState<string | null>(null);
  const [nowTick, setNowTick] = useState(() => Date.now());
  const [busyJobId, setBusyJobId] = useState<string>("");
  const [editingAppliedAtId, setEditingAppliedAtId] = useState<string>("");
  const [editingAppliedAtValue, setEditingAppliedAtValue] = useState<string>("");
  const [showExtras, setShowExtras] = useState(
    () => typeof localStorage !== "undefined" && localStorage.getItem(LS_SHOW_EXTRAS) === "1",
  );

  const [sortKey, setSortKey] = useState<TrackerSortKey>(() => {
    const k = readLs(LS_SORT_KEY, "applied");
    return isSortableKey(k) ? k : "applied";
  });
  const [sortDir, setSortDir] = useState<SortDir>(() => {
    const d = readLs(LS_SORT_DIR, "desc");
    return d === "asc" || d === "desc" ? d : "desc";
  });

  useEffect(() => {
    localStorage.setItem(LS_SHOW_EXTRAS, showExtras ? "1" : "0");
  }, [showExtras]);

  useEffect(() => {
    localStorage.setItem(LS_SORT_KEY, sortKey);
    localStorage.setItem(LS_SORT_DIR, sortDir);
  }, [sortKey, sortDir]);

  useEffect(() => {
    const id = window.setInterval(() => setNowTick(Date.now()), 60_000);
    return () => window.clearInterval(id);
  }, []);

  const query = useMemo(
    () =>
      queryString({
        status,
        company,
        resume,
        recommendation,
        minScore,
        shortlist: shortlistOnly ? true : undefined,
      }),
    [status, company, resume, recommendation, minScore, shortlistOnly],
  );

  const loadJobs = useCallback(async () => {
    try {
      setLoadError(null);
      const res = await api.listJobs(query);
      setJobs(res.items);
      setTotalAll(typeof res.totalAll === "number" ? res.totalAll : res.total);
      setShortlistTotal(typeof res.shortlistTotal === "number" ? res.shortlistTotal : 0);
    } catch (err) {
      setJobs([]);
      setTotalAll(0);
      setLoadError(err instanceof Error ? err.message : "Failed to load tracker jobs.");
    }
  }, [query]);

  useEffect(() => {
    void loadJobs();
  }, [loadJobs]);

  const refreshShortlist = async () => {
    if (refreshShortlistBusy) return;
    setRefreshShortlistBusy(true);
    setRefreshShortlistMessage(null);
    try {
      const result = await api.refreshShortlist();
      setRefreshShortlistMessage(
        `Shortlist synced: ${result.removed} removed, ${result.added} added, ${result.updated} updated (${result.total} checked).`,
      );
      await loadJobs();
    } catch (err) {
      setRefreshShortlistMessage(
        err instanceof Error ? err.message : "Could not refresh shortlist.",
      );
    } finally {
      setRefreshShortlistBusy(false);
    }
  };

  const markRejectedFromRow = async (jobId: string) => {
    if (busyJobId) return;
    setBusyJobId(jobId);
    try {
      await api.updateStatus(jobId, "rejected", "Manually marked rejected from tracker");
      await loadJobs();
    } finally {
      setBusyJobId("");
    }
  };

  const removeFromTrackerRow = async (jobId: string) => {
    if (busyJobId) return;
    const ok = window.confirm("Remove this job from tracker? This cannot be undone.");
    if (!ok) return;
    setBusyJobId(jobId);
    try {
      await api.deleteJob(jobId);
      await loadJobs();
    } finally {
      setBusyJobId("");
    }
  };

  const beginEditAppliedAt = (job: JobRecord) => {
    setEditingAppliedAtId(job.id);
    setEditingAppliedAtValue(
      appliedAtToDateInputValue(job.tracker.appliedAt || appliedAtIso(job) || new Date().toISOString()),
    );
  };

  const cancelEditAppliedAt = () => {
    setEditingAppliedAtId("");
    setEditingAppliedAtValue("");
  };

  const saveAppliedAtFromRow = async (jobId: string) => {
    if (busyJobId || !editingAppliedAtValue.trim()) return;
    setBusyJobId(jobId);
    try {
      await api.updateAppliedAt(jobId, editingAppliedAtValue);
      cancelEditAppliedAt();
      await loadJobs();
    } finally {
      setBusyJobId("");
    }
  };

  const toggleReachedHuman = async (job: JobRecord) => {
    if (busyJobId) return;
    setBusyJobId(job.id);
    try {
      const mark = job.tracker.reachedHuman;
      const updated = await api.setReachedHuman(job.id, mark === undefined ? true : mark ? false : null);
      setJobs((list) => list.map((j) => (j.id === job.id ? updated : j)));
    } finally {
      setBusyJobId("");
    }
  };

  const dateFilteredJobs = useMemo(() => {
    if (!fromDate && !toDate) return jobs;
    return jobs.filter((j) => isDateKeyInRange(trackerDateKey(j), fromDate || undefined, toDate || undefined));
  }, [jobs, fromDate, toDate]);

  const sortedJobs = useMemo(() => {
    const copy = [...dateFilteredJobs];
    copy.sort((a, b) => compareJobs(a, b, sortKey, sortDir));
    return copy;
  }, [dateFilteredJobs, sortKey, sortDir]);

  /** Employers with 2+ visible rows — always show role under company so siblings are distinguishable. */
  const multiPostingEmployers = useMemo(() => {
    const counts = new Map<string, number>();
    for (const j of sortedJobs) {
      const k = companyKey(j);
      if (!k) continue;
      counts.set(k, (counts.get(k) ?? 0) + 1);
    }
    const multi = new Set<string>();
    for (const [k, n] of counts) {
      if (n >= 2) multi.add(k);
    }
    return multi;
  }, [sortedJobs]);

  const shortlistInView = useMemo(() => {
    if (shortlistOnly) return sortedJobs.length;
    return shortlistTotal;
  }, [shortlistOnly, sortedJobs.length, shortlistTotal]);

  const appliedCounters = useMemo(() => {
    const { todayKey, weekStartKey, monthStartKey } = etRangeKeys(new Date(nowTick));
    let today = 0;
    let week = 0;
    let month = 0;
    for (const j of sortedJobs) {
      if (!isAppliedPipelineStatus(j.status)) continue;
      const appliedIso = appliedAtIso(j);
      if (!appliedIso) continue;
      const k = etDateKey(new Date(appliedIso));
      if (!k) continue;
      if (k === todayKey) today++;
      if (k >= weekStartKey && k <= todayKey) week++;
      if (k >= monthStartKey && k <= todayKey) month++;
    }
    return { today, week, month };
  }, [sortedJobs, nowTick]);

  const exportFilename = (ext: string) => {
    const d = new Date().toISOString().slice(0, 10);
    return `tracker-export-${d}.${ext}`;
  };

  const onHeaderSort = (col: TrackerSortKey) => {
    if (col === sortKey) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(col);
      setSortDir(defaultDirForKey(col));
    }
  };

  const sortIndicator = (col: TrackerSortKey) => {
    if (sortKey !== col) return "";
    return sortDir === "asc" ? " ↑" : " ↓";
  };

  const renderSortableTh = (col: TrackerSortKey, label: string, className: string) => (
    <th scope="col" className={className}>
      <button type="button" className="tracker-sort-btn" onClick={() => onHeaderSort(col)}>
        {label}
        <span className="tracker-sort-ind">{sortIndicator(col)}</span>
      </button>
    </th>
  );

  const renderPlainTh = (label: string, className: string) => (
    <th scope="col" className={className}>
      {label}
    </th>
  );

  const rowNavigate = (e: MouseEvent<HTMLTableRowElement>) => {
    const t = e.target as HTMLElement;
    if (t.closest("a,button,input,textarea,select,label")) return;
    const sel =
      typeof window !== "undefined" ? window.getSelection()?.toString().trim() ?? "" : "";
    if (sel.length > 0) return;
    const id = e.currentTarget.dataset.jobId;
    if (id) navigate(`/jobs/${id}/detail`);
  };

  const renderPrimaryCell = (job: JobRecord, col: PrimaryColumn) => {
    switch (col) {
      case "company":
        {
          const role = roleCell(job);
          const showRoleUnderCompany =
            Boolean(role) && multiPostingEmployers.has(companyKey(job));
          return (
          <div className="tracker-company-cell">
            <div className="tracker-company-primary">
              <Link
                to={`/jobs/${job.id}/detail`}
                className="tracker-link"
                onClick={(e) => e.stopPropagation()}
              >
                {companyCell(job)}
              </Link>
              {showRoleUnderCompany ? (
                <span className="tracker-role-subtitle" title={role}>
                  {role}
                </span>
              ) : null}
            </div>
            <span
              className={`tracker-row-dot tracker-row-dot-${rowDotTone(job)}`}
              title={`Tracker color: ${rowDotTone(job)}`}
              aria-hidden="true"
            />
            {hasJdSource(job) ? (
              <span className="tracker-jd-dot" title="JD on role detail">
                ●
              </span>
            ) : null}
            <Link
              to={`/jobs/${job.id}`}
              className="tracker-assets-inline"
              title="Scoring & generated assets"
              onClick={(e) => e.stopPropagation()}
            >
              Assets
            </Link>
            <button
              type="button"
              className="tracker-inline-action"
              title="Marks this role as rejected"
              disabled={busyJobId === job.id || job.status === "rejected"}
              onClick={(e) => {
                e.stopPropagation();
                void markRejectedFromRow(job.id);
              }}
            >
              Reject
            </button>
            <button
              type="button"
              className="tracker-inline-action tracker-inline-action-danger"
              title="Permanently removes this role from tracker"
              disabled={busyJobId === job.id}
              onClick={(e) => {
                e.stopPropagation();
                void removeFromTrackerRow(job.id);
              }}
            >
              Remove
            </button>
          </div>
          );
        }
      case "role":
        return (
          <span className="cell-lines-2" title={roleCell(job)}>
            {roleCell(job) || "—"}
          </span>
        );
      case "score":
        return (
          <span title={jobScoreTitle(job)} className="stack" style={{ gap: "0.1rem" }}>
            <ScoreBadge score={displayedJobScore(job)} compact />
            {job.effectiveScore?.scoreRevised && <span className="muted smallText">Revised</span>}
            {job.effectiveScore?.fingerprintStale && <span className="muted smallText">Revision inactive</span>}
          </span>
        );
      case "recommendedAction":
        return (
          <span className="cell-lines-1 cell-lines-action" title={job.tracker.recommendedAction ?? ""}>
            {job.tracker.recommendedAction?.trim() || "—"}
            {job.tracker.shortlistTag ? (
              <span className="tracker-shortlist-tag" title={job.tracker.shortlistTag}>
                {" "}
                · {job.tracker.shortlistTag}
              </span>
            ) : null}
            {job.tracker.freshnessTier && job.tracker.freshnessTier !== "fresh" ? (
              <span className="tracker-freshness-tag" title={job.tracker.freshnessTier}>
                {" "}
                · {job.tracker.freshnessTier}
              </span>
            ) : null}
          </span>
        );
      case "status":
        {
          const secondary = statusSecondaryText(job);
        return (
          <div className="tracker-status-cell">
            <StatusBadge status={job.status} />
            {secondary ? (
              <span className="cell-lines-1 muted tracker-status-text" title={secondary}>
                {secondary}
              </span>
            ) : null}
            {isAppliedPipelineStatus(job.status) || job.tracker.reachedHuman !== undefined ? (
              <button
                type="button"
                className={`tracker-inline-action tracker-heard-back${
                  job.tracker.reachedHuman === true ? " active" : job.tracker.reachedHuman === false ? " declined" : ""
                }`}
                disabled={busyJobId === job.id}
                title={
                  job.tracker.reachedHuman === true
                    ? "You marked that a call or interview happened. Click to mark that none did."
                    : job.tracker.reachedHuman === false
                      ? "You marked that no call or interview happened, whatever Gmail shows. Click to clear."
                      : "Mark whether a call or interview was offered (e.g. a phone screen with no email trail). Used by Application insights."
                }
                onClick={(e) => {
                  e.stopPropagation();
                  void toggleReachedHuman(job);
                }}
              >
                {job.tracker.reachedHuman === true
                  ? "Heard back ✓"
                  : job.tracker.reachedHuman === false
                    ? "No call ✕"
                    : "Heard back?"}
              </button>
            ) : null}
          </div>
        );
        }
      case "resume":
        return <span className="tracker-resume">{job.recommendedResume}</span>;
      case "topMatch":
        return (
          <span className="cell-lines-1" title={job.topMatch}>
            {job.topMatch?.trim() || "—"}
          </span>
        );
      case "mainRisk":
        return (
          <span className="cell-lines-main-risk" title={job.mainRisk}>
            {job.mainRisk?.trim() || "—"}
          </span>
        );
      case "salary": {
        const full = salaryAskLabel(job);
        const short = salaryAskCompact(job);
        return (
          <span className="tracker-salary-cell" title={full || "—"}>
            {short || "—"}
          </span>
        );
      }
      case "notes":
        return (
          <span className="cell-lines-1 tracker-notes-preview" title={job.tracker.notes ?? ""}>
            {(job.tracker.notes ?? "").trim() || "—"}
          </span>
        );
      case "applied":
        {
          const main = trackerDisplayDate(job);
          const mainMs = new Date(main.sortIso).getTime();
          const updatedMs = new Date(job.updatedAt).getTime();
          const mainIso = Number.isFinite(mainMs) ? new Date(mainMs).toISOString() : "—";
          const updatedIso = Number.isFinite(updatedMs) ? new Date(updatedMs).toISOString() : "—";
          const source =
            main.source === "applied"
              ? "Applied"
              : main.source === "discussed"
                ? "Discussed (spreadsheet)"
                : "Added / triaged";
          const title = `${source}: ${main.sourceValue} · Workflow ISO: ${mainIso} · Last updated: ${updatedIso} · Click to edit date applied`;
          if (editingAppliedAtId === job.id) {
            return (
              <div
                className="tracker-date-edit"
                onClick={(e) => e.stopPropagation()}
                onKeyDown={(e) => e.stopPropagation()}
              >
                <input
                  type="date"
                  className="tracker-date-input"
                  value={editingAppliedAtValue}
                  autoFocus
                  disabled={busyJobId === job.id}
                  onChange={(e) => setEditingAppliedAtValue(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      void saveAppliedAtFromRow(job.id);
                    }
                    if (e.key === "Escape") {
                      e.preventDefault();
                      cancelEditAppliedAt();
                    }
                  }}
                />
                <button
                  type="button"
                  className="tracker-inline-action"
                  disabled={busyJobId === job.id || !editingAppliedAtValue.trim()}
                  onClick={() => void saveAppliedAtFromRow(job.id)}
                >
                  Save
                </button>
                <button
                  type="button"
                  className="tracker-inline-action"
                  disabled={busyJobId === job.id}
                  onClick={cancelEditAppliedAt}
                >
                  Cancel
                </button>
              </div>
            );
          }
          return (
            <button
              type="button"
              className="muted tracker-updated tracker-date-button"
              title={title}
              onClick={(e) => {
                e.stopPropagation();
                beginEditAppliedAt(job);
              }}
            >
              {main.displayText}
            </button>
          );
        }
      default:
        return null;
    }
  };

  const renderExtraCell = (job: JobRecord, col: ExtraColumn) => {
    switch (col) {
      case "rank":
        return tsOnly(job, "rank") || "—";
      case "discussed":
        return (
          <span className="cell-lines-1" title={tsOnly(job, "discussed")}>
            {tsOnly(job, "discussed") || "—"}
          </span>
        );
      case "originalAlt":
        return (
          <span className="cell-lines-1" title={tsOnly(job, "originalAltScore")}>
            {tsOnly(job, "originalAltScore") || "—"}
          </span>
        );
      case "priority":
        return (job.tracker.priority ?? tsOnly(job, "priority")).trim() || "—";
      default:
        return "—";
    }
  };

  const headerLabel = (col: PrimaryColumn | ExtraColumn): string => {
    const map: Record<string, string> = {
      company: "Company",
      role: "Role",
      score: "Score",
      recommendedAction: "Recommended action",
      status: "Status / outcome",
      resume: "Resume",
      topMatch: "Top match",
      mainRisk: "Main risk",
      salary: "Salary ask",
      notes: "Notes",
      applied: "Applied",
      rank: "Rank",
      discussed: "Discussed",
      originalAlt: "Orig / alt",
      priority: "Priority",
    };
    return map[col] ?? col;
  };

  const metaLine = () => {
    const n = sortedJobs.length;
    return `${n} shown · ${shortlistInView} shortlisted · ${totalAll} total`;
  };

  return (
    <section className="tracker-page stack">
      <header className="tracker-page-header">
        <div>
          <h2 className="tracker-title">Tracker</h2>
          <p className="muted tracker-app-hint">
            Workflow view — exports still use the full canonical spreadsheet columns (order & labels).
          </p>
        </div>
        <div className="tracker-toolbar">
          <button
            type="button"
            className="btn-secondary"
            onClick={async () => {
              const out = await api.exportJobs(query);
              const blob = new Blob([JSON.stringify(out.rows, null, 2)], { type: "application/json" });
              const href = URL.createObjectURL(blob);
              const a = document.createElement("a");
              a.href = href;
              a.download = exportFilename("json");
              a.click();
              URL.revokeObjectURL(href);
            }}
          >
            Export JSON
          </button>
          <button
            type="button"
            className="btn-secondary"
            onClick={async () => {
              const csv = await api.exportJobsCsv(query);
              const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
              const href = URL.createObjectURL(blob);
              const a = document.createElement("a");
              a.href = href;
              a.download = exportFilename("csv");
              a.click();
              URL.revokeObjectURL(href);
            }}
          >
            Export CSV
          </button>
        </div>
      </header>

      <div className="card tracker-filters-card">
        <h3 className="tracker-filters-heading">Filters</h3>
        <FilterBar
          status={status}
          onStatusChange={setStatus}
          company={company}
          onCompanyChange={setCompany}
          resume={resume}
          onResumeChange={setResume}
          recommendation={recommendation}
          onRecommendationChange={setRecommendation}
          minScore={minScore}
          onMinScoreChange={setMinScore}
          fromDate={fromDate}
          onFromDateChange={setFromDate}
          toDate={toDate}
          onToDateChange={setToDate}
          shortlistOnly={shortlistOnly}
          onShortlistChange={setShortlistOnly}
          onRefreshShortlist={() => void refreshShortlist()}
          refreshShortlistBusy={refreshShortlistBusy}
        />
        {refreshShortlistMessage ? (
          <p className="muted tracker-refresh-shortlist-msg">{refreshShortlistMessage}</p>
        ) : null}
        <div className="tracker-filter-footer">
          <label className="checkboxRow muted tracker-extras-toggle">
            <input
              type="checkbox"
              checked={showExtras}
              onChange={(e) => setShowExtras(e.target.checked)}
            />
            Show sheet columns (Rank, Discussed, Orig/alt, Priority)
          </label>
        </div>
      </div>

      <div className="tracker-table-section card">
        <div className="tracker-applied-counters">
          <span>Applied today: {appliedCounters.today}</span>
          <span>Applied this week: {appliedCounters.week}</span>
          <span>Applied this month: {appliedCounters.month}</span>
        </div>
        <p className="tracker-meta-summary muted">{metaLine()}</p>
        {loadError ? (
          <div className="tracker-empty">
            <p className="tracker-empty-title">Could not load tracker jobs.</p>
            <p className="muted">{loadError}</p>
          </div>
        ) : sortedJobs.length === 0 ? (
          <div className="tracker-empty">
            <p className="tracker-empty-title">No roles match these filters.</p>
            <p className="muted">Try clearing filters or widening your search.</p>
          </div>
        ) : (
          <div className="tracker-table-scroll">
            <table className="table tracker-app-table">
              <thead>
                <tr>
                  {PRIMARY_COLUMNS.map((c, idx) => {
                    const sticky = idx === 0 ? " tracker-sticky-left" : "";
                    const cls = `tracker-col-${c}${sticky}`;
                    const label = headerLabel(c);
                    return isSortableKey(c) ? (
                      <Fragment key={c}>{renderSortableTh(c, label, cls)}</Fragment>
                    ) : (
                      <Fragment key={c}>{renderPlainTh(label, cls)}</Fragment>
                    );
                  })}
                  {showExtras
                    ? EXTRA_COLUMNS.map((c) => {
                        const cls = `tracker-col-${c}`;
                        const label = headerLabel(c);
                        return isSortableKey(c) ? (
                          <Fragment key={c}>{renderSortableTh(c, label, cls)}</Fragment>
                        ) : (
                          <Fragment key={c}>{renderPlainTh(label, cls)}</Fragment>
                        );
                      })
                    : null}
                </tr>
              </thead>
              <tbody>
                {sortedJobs.map((job) => (
                  <tr
                    key={job.id}
                    className="tracker-row"
                    data-job-id={job.id}
                    onClick={rowNavigate}
                  >
                    {PRIMARY_COLUMNS.map((c, idx) => (
                      <td
                        key={c}
                        className={`tracker-col-${c}${idx === 0 ? " tracker-sticky-left" : ""}`}
                      >
                        {renderPrimaryCell(job, c)}
                      </td>
                    ))}
                    {showExtras
                      ? EXTRA_COLUMNS.map((c) => (
                          <td key={c} className={`tracker-col-${c}`}>
                            {renderExtraCell(job, c)}
                          </td>
                        ))
                      : null}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </section>
  );
};
