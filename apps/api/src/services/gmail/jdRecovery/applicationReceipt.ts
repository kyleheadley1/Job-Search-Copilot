/**
 * Detects application status / confirmation pages (Workable candidate portal, "thanks for applying"
 * pages). These echo the applicant's own resume and form answers, so scoring one grades the candidate
 * against themselves and inflates the fit. They are never job descriptions.
 */

const RECEIPT_URL_PATTERNS: RegExp[] = [
  /workable\.com\/.*\/candidates\//i,
  /\/(application|applications)\/(confirmation|submitted|status)\b/i,
  /\/(confirmation|thank-?you|thanks|application-submitted|submitted)(\/|\?|#|$)/i,
];

/** Any one of these near the top of a page means it is a receipt, not a posting. */
const STRONG_PHRASES: RegExp[] = [
  /your application (was|has been) (received|submitted)/i,
  /withdraw (this|your) application/i,
  /thank(s| you) for (applying|your application|submitting)/i,
  /we('ve| have) received your application/i,
  /application (status|submitted successfully)/i,
];

/**
 * Section labels from an echoed, already-submitted application. Generic form questions (phone, visa,
 * salary) are left out on purpose: real posting pages often embed the apply form below the JD.
 */
const RECEIPT_LABELS: RegExp[] = [
  /^personal information$/im,
  /^headline$/im,
  /^answers$/im,
  /^did you change your mind\??$/im,
  /^resume$/im,
];

const SCAN_CHARS = 1500;

export const isReceiptUrl = (url: string | undefined): boolean =>
  Boolean(url && RECEIPT_URL_PATTERNS.some((re) => re.test(url)));

export const looksLikeApplicationReceipt = (text: string, url?: string): boolean => {
  if (isReceiptUrl(url)) return true;
  const head = text.slice(0, SCAN_CHARS);
  if (STRONG_PHRASES.some((re) => re.test(head))) return true;
  return RECEIPT_LABELS.filter((re) => re.test(text)).length >= 3;
};

export const RECEIPT_REASON = "application_receipt_not_jd";

export type ReceiptScoreRow = {
  key: string;
  company: string;
  role: string | null;
  fitTotal?: number;
  url?: string;
  invalidated: boolean;
};

/**
 * Find scored applications whose stored JD is really an application receipt and, when apply is true,
 * withdraw those scores so recovery or a saved prospect can score the real posting.
 */
export const repairReceiptScores = async (
  input: { apply: boolean; sinceDays?: number },
  deps: {
    listScoredSince: (sinceIso: string) => Promise<
      Array<{
        key: string;
        company: string;
        role: string | null;
        recovery: { status: string; url?: string };
        jd?: { text: string };
        fit?: { total: number };
      }>
    >;
    invalidateScore: (key: string, reason: string) => Promise<unknown>;
    restartRecovery?: () => Promise<unknown>;
  },
): Promise<{ found: number; invalidated: number; rows: ReceiptScoreRow[]; note: string }> => {
  const since = new Date(Date.now() - (input.sinceDays ?? 365) * 86_400_000).toISOString();
  const rows = (await deps.listScoredSince(since)).filter(
    (row) => row.recovery.status === "scored" && row.jd?.text && looksLikeApplicationReceipt(row.jd.text, row.recovery.url),
  );
  const out: ReceiptScoreRow[] = [];
  let invalidated = 0;
  for (const row of rows) {
    let done = false;
    if (input.apply) {
      done = Boolean(await deps.invalidateScore(row.key, RECEIPT_REASON));
      if (done) invalidated += 1;
    }
    out.push({ key: row.key, company: row.company, role: row.role, fitTotal: row.fit?.total, url: row.recovery.url, invalidated: done });
  }
  if (input.apply && invalidated > 0) await deps.restartRecovery?.().catch(() => undefined);
  return {
    found: rows.length,
    invalidated,
    rows: out,
    note: input.apply
      ? `Withdrew ${invalidated} score(s) that came from application confirmation pages. Recovery will look for the real postings; a saved prospect can also be linked to rescore.`
      : `${rows.length} scored application(s) were scored from a confirmation page. Call again with apply: true to withdraw those scores.`,
  };
};
