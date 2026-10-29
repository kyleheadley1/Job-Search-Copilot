import type { ExtractedJobData, JobRecord, TrackerSpreadsheetFields } from "../types/job";
import { pickDisplayCompanyName } from "./companyDisplaySanitize";
import { resolveDisplayTitle } from "./roleTitleDisplay";

type CompanyFields = Pick<
  ExtractedJobData,
  "company" | "companyDisplayName" | "listingCompanyName" | "agencyCompanyName" | "companyConfidence"
>;

/** User-facing company label with fallbacks for legacy records. */
export function companyDisplayLabel(
  extracted: Pick<
    ExtractedJobData,
    "companyDisplayName" | "listingCompanyName" | "company" | "rawText"
  >,
): string {
  return pickDisplayCompanyName(
    [extracted.companyDisplayName, extracted.listingCompanyName, extracted.company],
    extracted.rawText,
  );
}

export function agencyDisclosureNote(extracted: CompanyFields): string | null {
  if (extracted.companyConfidence !== "agency_only") return null;
  const agency =
    extracted.agencyCompanyName?.trim() ||
    extracted.listingCompanyName?.trim() ||
    extracted.company?.trim();
  if (!agency) return null;
  return `Actual employer not disclosed; posting is represented by ${agency}.`;
}

/**
 * Page/card header: always include title (and team when present), not company alone.
 * e.g. "The New York Times — Software Engineer — Reflections"
 */
export function jobHeaderLabel(
  extracted: Pick<
    ExtractedJobData,
    "company" | "title" | "employmentType" | "companyDisplayName" | "listingCompanyName" | "rawText"
  >,
): string {
  const company = companyDisplayLabel(extracted);
  const title = resolveDisplayTitle(extracted);
  const employment = extracted.employmentType?.trim();
  const roleLabel =
    company && title
      ? `${company} — ${title}`
      : title
        ? title
        : company
          ? company
          : "Untitled role";
  if (employment) return `${roleLabel} (${employment})`;
  return roleLabel;
}

/** Compact list label when the same employer has multiple saved postings. */
export function companyWithRoleSubtitle(
  extracted: Pick<
    ExtractedJobData,
    "company" | "title" | "companyDisplayName" | "listingCompanyName" | "rawText"
  >,
): { company: string; role: string } {
  return {
    company: companyDisplayLabel(extracted),
    role: resolveDisplayTitle(extracted),
  };
}

/** Relative posted time for Top Jobs (e.g. "2 hours ago", "3 days ago"). */
export function formatPostedAgo(isoDate: string | undefined | null): string {
  if (!isoDate?.trim()) return "Unknown";
  const then = new Date(isoDate).getTime();
  if (Number.isNaN(then)) return isoDate;
  const diffMs = Date.now() - then;
  if (diffMs < 0) return "Just now";
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 1) return "Just now";
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.floor(hours / 24);
  if (days < 14) return `${days} day${days === 1 ? "" : "s"} ago`;
  const weeks = Math.floor(days / 7);
  if (weeks < 8) return `${weeks} week${weeks === 1 ? "" : "s"} ago`;
  return new Date(isoDate).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

/** Countdown until a future ISO time (e.g. manual refresh cooldown). */
export function formatAvailableIn(isoDate: string | undefined | null): string {
  if (!isoDate?.trim()) return "soon";
  const then = new Date(isoDate).getTime();
  if (Number.isNaN(then)) return isoDate;
  const diffMs = then - Date.now();
  if (diffMs <= 0) return "now";
  const minutes = Math.ceil(diffMs / 60_000);
  if (minutes < 60) return `in ${minutes} minute${minutes === 1 ? "" : "s"}`;
  const hours = Math.ceil(minutes / 60);
  if (hours < 24) return `in ${hours} hour${hours === 1 ? "" : "s"}`;
  return new Date(isoDate).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

/** Salary for display (internal structured fields). */
function formatSalaryUsd(n: number): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(n);
}

function salaryAskRange(s: JobRecord["salaryAsk"]): { min?: number; max?: number } | null {
  const hasMin = typeof s.rangeMin === "number";
  const hasMax = typeof s.rangeMax === "number";
  if (!hasMin && !hasMax) return null;
  if (hasMin && hasMax && s.rangeMin === s.rangeMax) return null;
  return { min: s.rangeMin, max: s.rangeMax };
}

export type SalaryAskDisplay = {
  point: string | null;
  rangeIfNeeded: string | null;
  combined: string;
};

export function salaryAskDisplay(job: JobRecord): SalaryAskDisplay {
  const s = job.salaryAsk;
  const point = typeof s.number === "number" ? formatSalaryUsd(s.number) : null;
  const range = salaryAskRange(s);
  let rangeIfNeeded: string | null = null;
  if (range?.min != null && range.max != null) {
    rangeIfNeeded = `${formatSalaryUsd(range.min)} – ${formatSalaryUsd(range.max)}`;
  } else if (range?.min != null) {
    rangeIfNeeded = `${formatSalaryUsd(range.min)}+`;
  } else if (range?.max != null) {
    rangeIfNeeded = `≤${formatSalaryUsd(range.max)}`;
  }

  let combined = "";
  if (point && rangeIfNeeded) combined = `${point} (range if needed: ${rangeIfNeeded})`;
  else if (point) combined = point;
  else if (rangeIfNeeded) combined = rangeIfNeeded;

  return { point, rangeIfNeeded, combined };
}

export function salaryAskLabel(job: JobRecord): string {
  return salaryAskDisplay(job).combined;
}

/** Compact salary for dense table cells (full detail in `title` via `salaryAskLabel`). */
export function salaryAskCompact(job: JobRecord): string {
  const s = job.salaryAsk;
  const k = (n: number) => (Math.abs(n) >= 1000 ? `${Math.round(n / 1000)}k` : String(Math.round(n)));
  const range = salaryAskRange(s);
  const rangeCompact =
    range?.min != null && range.max != null
      ? `$${k(range.min)}–${k(range.max)}`
      : range?.min != null
        ? `$${k(range.min)}+`
        : range?.max != null
          ? `≤$${k(range.max)}`
          : "";

  if (typeof s.number === "number") {
    const point = s.number >= 1000 ? `$${k(s.number)}` : `$${s.number}`;
    return rangeCompact ? `${point} (${rangeCompact})` : point;
  }
  return rangeCompact;
}

/** Full JD / pasted input for detail views (internal first, then seeded sheet cell). */
export function jdSourceText(job: JobRecord): string {
  const ts = job.trackerSpreadsheet ?? {};
  const fromExtracted =
    job.extracted.rawText?.trim() ||
    (job.extracted.url ? `URL: ${job.extracted.url}` : "") ||
    "";
  if (fromExtracted) return fromExtracted;
  const fromSheet = ts.jdInput !== undefined ? String(ts.jdInput) : "";
  return fromSheet.trim();
}

export function hasJdSource(job: JobRecord): boolean {
  return jdSourceText(job).length > 0;
}

export function tsOnly(job: JobRecord, key: keyof TrackerSpreadsheetFields): string {
  const ts = job.trackerSpreadsheet ?? {};
  return ts[key] !== undefined ? String(ts[key]) : "";
}

/** Compact timestamp for tracker list cells (full ISO in `title`). */
export function formatUpdatedAtCompact(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  const now = new Date();
  const opts: Intl.DateTimeFormatOptions = {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  };
  if (d.getFullYear() !== now.getFullYear()) opts.year = "2-digit";
  return new Intl.DateTimeFormat(undefined, opts).format(d);
}

const APPLICATION_STATUSES = new Set<JobRecord["status"]>([
  "applied",
  "interviewing",
  "assessment",
  "offer",
  "rejected",
]);

export function isAppliedPipelineStatus(status: JobRecord["status"]): boolean {
  return APPLICATION_STATUSES.has(status);
}

function earliestValidIso(values: Array<string | undefined>): string {
  const times = values
    .map((iso) => {
      if (!iso) return Number.NaN;
      const t = new Date(iso).getTime();
      return Number.isFinite(t) ? t : Number.NaN;
    })
    .filter((t) => Number.isFinite(t));
  if (!times.length) return "";
  return new Date(Math.min(...times)).toISOString();
}

export function appliedAtIso(job: JobRecord): string {
  if (!isAppliedPipelineStatus(job.status)) return "";
  return appliedDateIso(job);
}

/** When the user applied, whatever the status is now (a lapsed or rejected job keeps its applied date). */
export function appliedDateIso(job: JobRecord): string {
  // Manual override (tracker Date edit) wins over derived status-history timestamp.
  const override = job.tracker?.appliedAt?.trim();
  if (override) {
    const t = new Date(override).getTime();
    if (Number.isFinite(t)) return new Date(t).toISOString();
  }
  // Applied counters should only key off an explicit "applied" transition,
  // not later status transitions like "rejected" made on a different date.
  return earliestValidIso(
    (job.statusHistory ?? [])
      .filter((h) => h.toStatus === "applied")
      .map((h) => h.createdAt),
  );
}

/** YYYY-MM-DD for `<input type="date">` from a stored appliedAt ISO. */
export function appliedAtToDateInputValue(iso?: string | null): string {
  if (!iso?.trim()) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function parseDiscussedDate(raw: string): Date | null {
  const text = raw.trim();
  if (!text) return null;

  const weekOf = text.match(/^week of\s+([A-Za-z]+)\s+(\d{1,2})(?:,?\s+(\d{2}|\d{4}))?$/i);
  if (weekOf) {
    const now = new Date();
    const year =
      weekOf[3] === undefined ? now.getFullYear() : weekOf[3].length === 2 ? 2000 + Number(weekOf[3]) : Number(weekOf[3]);
    const t = new Date(`${weekOf[1]} ${weekOf[2]}, ${year}`);
    if (!Number.isNaN(t.getTime())) return t;
  }

  // Excel serial dates are commonly imported as numeric strings.
  const asNum = Number(text);
  if (Number.isFinite(asNum) && asNum > 20000 && asNum < 90000) {
    const excelEpochMs = Date.UTC(1899, 11, 30);
    return new Date(excelEpochMs + Math.round(asNum) * 24 * 60 * 60 * 1000);
  }

  const mdY = text.match(/^(\d{1,2})[/-](\d{1,2})(?:[/-](\d{2}|\d{4}))?$/);
  if (mdY) {
    const month = Number(mdY[1]);
    const day = Number(mdY[2]);
    const yearRaw = mdY[3];
    const year =
      yearRaw === undefined ? new Date().getFullYear() : yearRaw.length === 2 ? 2000 + Number(yearRaw) : Number(yearRaw);
    const d = new Date(Date.UTC(year, month - 1, day));
    if (!Number.isNaN(d.getTime())) return d;
  }

  const t = new Date(text);
  if (!Number.isNaN(t.getTime())) return t;
  return null;
}

export function formatTrackerDateCompact(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  const now = new Date();
  const opts: Intl.DateTimeFormatOptions = { month: "numeric", day: "numeric" };
  if (d.getFullYear() !== now.getFullYear()) opts.year = "2-digit";
  return new Intl.DateTimeFormat(undefined, opts).format(d);
}

export type TrackerDisplayDate = {
  displayText: string;
  sortIso: string;
  source: "applied" | "discussed" | "added";
  sourceValue: string;
};

/**
 * Tracker-facing workflow date precedence:
 * 1) appliedAt (status history) when job has truly progressed to applied pipeline stage
 * 2) imported spreadsheet Discussed date (parsed when possible; raw text preserved)
 * 3) added/triaged timestamp (createdAt)
 */
export function trackerDisplayDate(job: JobRecord): TrackerDisplayDate {
  const applied = appliedDateIso(job);
  if (applied) {
    return {
      displayText: formatTrackerDateCompact(applied),
      sortIso: applied,
      source: "applied",
      sourceValue: applied,
    };
  }

  const discussedRaw = tsOnly(job, "discussed").trim();
  if (discussedRaw) {
    const parsed = parseDiscussedDate(discussedRaw);
    if (parsed) {
      const iso = parsed.toISOString();
      return {
        displayText: formatTrackerDateCompact(iso),
        sortIso: iso,
        source: "discussed",
        sourceValue: discussedRaw,
      };
    }
    return {
      displayText: discussedRaw,
      sortIso: job.createdAt,
      source: "discussed",
      sourceValue: discussedRaw,
    };
  }

  return {
    displayText: formatTrackerDateCompact(job.createdAt),
    sortIso: job.createdAt,
    source: "added",
    sourceValue: job.createdAt,
  };
}

export function displayedJobScore(job: Pick<JobRecord, "score" | "effectiveScore">): number {
  return job.effectiveScore?.total ?? job.score.total;
}

export function displayedJobRecommendation(
  job: Pick<JobRecord, "recommendation" | "effectiveScore">,
): string {
  return job.effectiveScore?.recommendation ?? job.recommendation;
}

export function jobScoreTitle(job: Pick<JobRecord, "score" | "effectiveScore">): string {
  const overlay = job.effectiveScore;
  if (!overlay) return `Score ${job.score.total}`;
  if (overlay.fingerprintStale) {
    return `Approved revision ${overlay.staleRevisionTotal ?? "—"} is inactive because the stored evaluation changed. Showing ${overlay.total}. Tracker capture remains ${overlay.storedTrackerTotal}.`;
  }
  if (overlay.scoreRevised) {
    return `Approved revision ${overlay.total} (Gmail). Tracker capture remains ${overlay.storedTrackerTotal}.`;
  }
  if (overlay.total !== overlay.storedTrackerTotal) {
    return `Gmail effective score ${overlay.total}. Tracker capture ${overlay.storedTrackerTotal}.`;
  }
  return `Score ${overlay.total}`;
}
