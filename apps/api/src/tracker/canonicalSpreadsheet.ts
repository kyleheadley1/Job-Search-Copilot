import type { JobRecord, JobStatus } from '../types/job.js';
import type { TrackerSpreadsheetFields } from '../types/trackerSpreadsheet.js';
import type { StoredResumeType } from '../types/resume.js';
import type { Recommendation, ScoreBreakdown } from '../types/scoring.js';
import { SCORE_CATEGORY_MAXES } from '../config/scoringPolicy.js';
import { mapRecommendationFromScore } from '../lib/scoringCaps.js';

/** Exact spreadsheet column labels and export order (canonical tracker). */
export const TRACKER_EXPORT_HEADERS = [
  'Rank',
  'Discussed',
  'Company',
  'Role',
  'Latest Score',
  'Original / Alt Score',
  'Priority',
  'Recommended Action',
  'Status / Outcome',
  'Salary Ask',
  'JD Input',
  'Top Match',
  'Main Risk',
  'Notes',
  'Resume',
] as const;

export type TrackerExportHeader = (typeof TRACKER_EXPORT_HEADERS)[number];

/** One export row: all string cells, same keys/order as the spreadsheet. */
export type JobExportRow = Record<TrackerExportHeader, string>;

export const emptyJobExportRow = (): JobExportRow =>
  Object.fromEntries(
    TRACKER_EXPORT_HEADERS.map((h) => [h, '']),
  ) as JobExportRow;

function formatSalaryAskDisplay(job: JobRecord): string {
  const s = job.salaryAsk;
  const point = typeof s.number === 'number' ? String(s.number) : '';
  const hasRange =
    typeof s.rangeMin === 'number' &&
    typeof s.rangeMax === 'number' &&
    s.rangeMin !== s.rangeMax;
  if (point && hasRange) {
    return `${point} (${s.rangeMin} - ${s.rangeMax})`;
  }
  if (point) return point;
  if (hasRange) return `${s.rangeMin} - ${s.rangeMax}`;
  if (typeof s.rangeMin === 'number' || typeof s.rangeMax === 'number') {
    const min = typeof s.rangeMin === 'number' ? String(s.rangeMin) : '';
    const max = typeof s.rangeMax === 'number' ? String(s.rangeMax) : '';
    return [min, max].filter(Boolean).join(' - ');
  }
  return '';
}

/**
 * Export-only merge: prefer persisted spreadsheet cells when present so JSON/CSV
 * match the workbook. App logic (filters, PATCH, scoring) must use `JobRecord` fields, not this.
 */
function pickCellForExport(
  ts: Partial<TrackerSpreadsheetFields> | undefined,
  key: keyof TrackerSpreadsheetFields,
  fallback: string,
): string {
  if (ts && ts[key] !== undefined) return String(ts[key]);
  return fallback;
}

/** Populate `trackerSpreadsheet` from current internal fields (e.g. after triage). */
export function buildTrackerSpreadsheetFromJob(job: JobRecord): TrackerSpreadsheetFields {
  const jd =
    job.extracted.rawText?.trim() ||
    (job.extracted.url ? `URL: ${job.extracted.url}` : '') ||
    '';
  const statusOutcome = job.tracker.statusOutcome ?? job.status;
  const companyDisplay =
    job.extracted.companyDisplayName?.trim() ||
    job.extracted.listingCompanyName?.trim() ||
    job.extracted.company;
  const notesJoined = (job.extracted.companyExtractionNotes ?? []).join('; ');
  return {
    rank: '',
    discussed: '',
    company: companyDisplay,
    role: job.extracted.title,
    latestScore: String(job.score.total),
    originalAltScore: '',
    priority: job.tracker.priority ?? '',
    recommendedAction: job.tracker.recommendedAction ?? '',
    statusOutcome,
    salaryAsk: formatSalaryAskDisplay(job),
    jdInput: jd,
    topMatch: job.topMatch,
    mainRisk: job.mainRisk,
    notes: job.tracker.notes ?? '',
    resume: job.recommendedResume,
    agencyCompanyName: job.extracted.agencyCompanyName ?? undefined,
    employerCompanyName: job.extracted.employerCompanyName ?? undefined,
    companyConfidence: job.extracted.companyConfidence,
    companyExtractionNotes: notesJoined || undefined,
  };
}

/** JSON/CSV export: canonical labels/order; spreadsheet cells win for parity (seed-only path). */
export function buildJobExportRow(job: JobRecord): JobExportRow {
  const base = buildTrackerSpreadsheetFromJob(job);
  const ts = job.trackerSpreadsheet;
  return {
    Rank: pickCellForExport(ts, 'rank', base.rank),
    Discussed: pickCellForExport(ts, 'discussed', base.discussed),
    Company: pickCellForExport(ts, 'company', base.company),
    Role: pickCellForExport(ts, 'role', base.role),
    'Latest Score': pickCellForExport(ts, 'latestScore', base.latestScore),
    'Original / Alt Score': pickCellForExport(ts, 'originalAltScore', base.originalAltScore),
    Priority: pickCellForExport(ts, 'priority', base.priority),
    'Recommended Action': pickCellForExport(ts, 'recommendedAction', base.recommendedAction),
    'Status / Outcome': pickCellForExport(ts, 'statusOutcome', base.statusOutcome),
    'Salary Ask': pickCellForExport(ts, 'salaryAsk', base.salaryAsk),
    'JD Input': pickCellForExport(ts, 'jdInput', base.jdInput),
    'Top Match': pickCellForExport(ts, 'topMatch', base.topMatch),
    'Main Risk': pickCellForExport(ts, 'mainRisk', base.mainRisk),
    Notes: pickCellForExport(ts, 'notes', base.notes),
    Resume: pickCellForExport(ts, 'resume', base.resume),
  };
}

export function exportRowToObjectInHeaderOrder(row: JobExportRow): Record<string, string> {
  const out: Record<string, string> = {};
  for (const h of TRACKER_EXPORT_HEADERS) {
    out[h] = row[h] ?? '';
  }
  return out;
}

const normHeader = (s: string): string =>
  s
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase();

/** Normalized header → camelCase trackerSpreadsheet key. */
export const sheetHeaderToField: Record<string, keyof TrackerSpreadsheetFields> = {
  rank: 'rank',
  discussed: 'discussed',
  company: 'company',
  role: 'role',
  'latest score': 'latestScore',
  'original / alt score': 'originalAltScore',
  'original/alt score': 'originalAltScore',
  priority: 'priority',
  'recommended action': 'recommendedAction',
  'status / outcome': 'statusOutcome',
  'status/outcome': 'statusOutcome',
  'salary ask': 'salaryAsk',
  'jd input': 'jdInput',
  'top match': 'topMatch',
  'main risk': 'mainRisk',
  notes: 'notes',
  resume: 'resume',
};

export function parseHeaderRow(row: unknown[]): Map<number, keyof TrackerSpreadsheetFields> {
  const map = new Map<number, keyof TrackerSpreadsheetFields>();
  row.forEach((cell, idx) => {
    const field = sheetHeaderToField[normHeader(String(cell ?? ''))];
    if (field) map.set(idx, field);
  });
  return map;
}

export function cellToSpreadsheetString(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
  return String(value);
}

const STATUS_KEYWORDS: Array<{ re: RegExp; status: JobStatus }> = [
  { re: /\bto[_\s]?review\b|pending|\bnew\b/i, status: 'to_review' },
  { re: /\bapplied\b|submitted\b/i, status: 'applied' },
  { re: /\bskip\b|pass(ed)?\b|declined\b|withdrew\b/i, status: 'skip' },
  { re: /\breject/i, status: 'rejected' },
  { re: /\binterview|\bpanel\b|\bscreen(ed|ing)?\b|\bon-?site\b|hiring manager|final round/i, status: 'interviewing' },
  { re: /\bassessment\b|oa\b|take[-\s]?home/i, status: 'assessment' },
  { re: /\bclosed\b|filled\b|cancelled\b|canceled\b/i, status: 'closed' },
  { re: /\blapsed\b|ghosted\b|no response\b/i, status: 'lapsed' },
  { re: /\boffer\b/i, status: 'offer' },
];

export function mapSpreadsheetStatusToJobStatus(text: string): JobStatus {
  const t = text.trim();
  if (!t) return 'to_review';
  const direct = [
    'to_review',
    'applied',
    'skip',
    'rejected',
    'interviewing',
    'assessment',
    'closed',
    'offer',
    'lapsed',
  ] as const;
  if ((direct as readonly string[]).includes(t)) return t as JobStatus;
  for (const { re, status } of STATUS_KEYWORDS) {
    if (re.test(t)) return status;
  }
  return 'to_review';
}

/** Spreadsheet rows predate BASE/AI, so unlabeled rows keep their historical SWE label. */
export function parseResumeColumn(text: string): StoredResumeType {
  const t = text.trim().toUpperCase();
  if (/\bFDE\b/.test(t)) return 'FDE';
  if (/\bAI\b/.test(t)) return 'AI';
  if (t.includes('BASE')) return 'BASE';
  if (t.includes('SIE')) return 'SIE';
  if (t.includes('EARLY') || t.includes('NEW GRAD')) return 'EARLY_CAREER';
  return 'SWE';
}

export function parseLatestScore(text: string): number {
  const t = text.trim().replace(/[^\d.-]/g, '');
  if (!t) return 0;
  const n = Number(t);
  return Number.isFinite(n) ? Math.round(Math.max(0, Math.min(100, n))) : 0;
}

const SCORE_KEYS = [
  'stackFit',
  'levelFit',
  'domainFit',
  'resumeStoryClarity',
  'functionalOverlap',
  'recruiterFriendliness',
  'careerValue',
] as const;

const SCORE_CAPS: Record<(typeof SCORE_KEYS)[number], number> = {
  ...SCORE_CATEGORY_MAXES,
};

/** Deterministic breakdown summing exactly to `total` (0–100), within category caps. */
export function scoreBreakdownFromTotal(totalIn: number): ScoreBreakdown {
  const total = Math.round(Math.max(0, Math.min(100, totalIn)));
  const weights = SCORE_KEYS.map((k) => SCORE_CAPS[k]);
  const sumW = weights.reduce((a, b) => a + b, 0);
  const floors = weights.map((w) => Math.floor((total * w) / sumW));
  const parts = [...floors];
  let sum = parts.reduce((a, b) => a + b, 0);
  let diff = total - sum;
  let guard = 0;
  while (diff !== 0 && guard < 500) {
    guard++;
    if (diff > 0) {
      let bestI = -1;
      let bestRoom = -1;
      for (let i = 0; i < SCORE_KEYS.length; i++) {
        const key = SCORE_KEYS[i];
        const cap = SCORE_CAPS[key];
        const room = cap - parts[i];
        if (room > bestRoom) {
          bestRoom = room;
          bestI = i;
        }
      }
      if (bestI < 0 || bestRoom <= 0) break;
      parts[bestI]++;
      diff--;
    } else {
      let bestI = -1;
      let bestGive = -1;
      for (let i = 0; i < SCORE_KEYS.length; i++) {
        const give = parts[i];
        if (give > bestGive) {
          bestGive = give;
          bestI = i;
        }
      }
      if (bestI < 0 || bestGive <= 0) break;
      parts[bestI]--;
      diff++;
    }
  }
  return {
    stackFit: parts[0],
    levelFit: parts[1],
    domainFit: parts[2],
    resumeStoryClarity: parts[3],
    functionalOverlap: parts[4],
    recruiterFriendliness: parts[5],
    careerValue: parts[6],
    total,
  };
}

export function recommendationFromScoreTotal(total: number): Recommendation {
  return mapRecommendationFromScore(total);
}

/** Best-effort parse of salary text into `salaryAsk` number fields. */
export function parseSalaryAskFromText(text: string): {
  number?: number;
  rangeMin?: number;
  rangeMax?: number;
} {
  const raw = text.trim();
  if (!raw) return {};
  const nums = raw.match(/\d[\d,]*/g);
  if (!nums?.length) return {};
  const parsed = nums.map((n) => Number(n.replace(/,/g, ''))).filter((n) => Number.isFinite(n));
  if (parsed.length === 0) return {};
  if (parsed.length === 1) return { number: parsed[0] };
  const sorted = [...parsed].sort((a, b) => a - b);
  return { rangeMin: sorted[0], rangeMax: sorted[sorted.length - 1] };
}
