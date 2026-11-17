/**
 * Company identity for Gmail grouping: known aliases plus hiring-platform account IDs
 * (Workday tenant mailbox, Ashby organizationId, Greenhouse board subdomain).
 */

/**
 * Canonical normalized key → other normalized names that mean the same employer.
 * Keys/aliases use baseNormalizeCompany forms (legal suffixes like LLC/Labs already stripped).
 */
export const COMPANY_ALIASES: Record<string, string[]> = {
  "evolent health": ["evolent"],
  "standard template": ["stlabs"],
  imagine: ["lift enablement"],
};

/** Preferred display label for a canonical key. */
export const COMPANY_DISPLAY: Record<string, string> = {
  "evolent health": "Evolent Health",
  "standard template": "Standard Template Labs",
  imagine: "Imagine LLC",
};

const COMPANY_SUFFIX_RE =
  /\b(inc|incorporated|llc|l\.l\.c|ltd|limited|corp|corporation|co|company|plc|gmbh|technologies|technology|labs|group|holdings|hq)\b\.?/g;

/** Strip legal suffixes and punctuation; does not apply aliases. */
export const baseNormalizeCompany = (name: string): string =>
  name
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/\(.*?\)/g, " ")
    .replace(COMPANY_SUFFIX_RE, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

const ALIAS_TO_CANONICAL = new Map<string, string>();
for (const [canonical, aliases] of Object.entries(COMPANY_ALIASES)) {
  ALIAS_TO_CANONICAL.set(canonical, canonical);
  for (const alias of aliases) ALIAS_TO_CANONICAL.set(alias, canonical);
}

/** Normalized company key with aliases collapsed (Evolent → evolent health). */
export const resolveCompanyKey = (name: string): string => {
  const base = baseNormalizeCompany(name);
  if (!base) return "";
  return ALIAS_TO_CANONICAL.get(base) ?? base;
};

/** Canonical key plus every alias that maps to it — for evaluation re-key lookups. */
export const companyKeyVariants = (nameOrKey: string): string[] => {
  const canonical = resolveCompanyKey(nameOrKey);
  if (!canonical) return [];
  const aliases = COMPANY_ALIASES[canonical] ?? [];
  return [...new Set([canonical, ...aliases])];
};

export const displayCompanyName = (companyKey: string, fallback: string): string =>
  COMPANY_DISPLAY[companyKey] ?? fallback;

const FROM_ADDRESS_RE = /<([^>]+)>|([^\s<>,;]+@[^\s<>,;]+)/;

const emailAddress = (from: string): string | null => {
  const m = from.match(FROM_ADDRESS_RE);
  return (m?.[1] ?? m?.[2] ?? "").trim().toLowerCase() || null;
};

/**
 * Stable hiring-platform account id when the sender/link identifies one employer tenant.
 * Shared inboxes (Ashby no-reply without org id, BambooHR app mail) return null.
 */
export const platformAccountId = (from: string, links: string[] = []): string | null => {
  const addr = emailAddress(from);
  if (addr) {
    const workday = addr.match(/^([a-z0-9][a-z0-9._-]*)@myworkday\.com$/i);
    if (workday) return `workday:${workday[1]!.toLowerCase()}`;

    const workdayJobs = addr.match(/@([a-z0-9-]+)\.myworkdayjobs\.com$/i);
    if (workdayJobs) return `workday:${workdayJobs[1]!.toLowerCase()}`;

    const greenhouse = addr.match(/@([a-z0-9-]+)\.(?:greenhouse\.io|greenhouse-mail\.io)$/i);
    if (greenhouse) {
      const board = greenhouse[1]!.toLowerCase();
      if (board !== "us" && board !== "email" && !board.endsWith("-mail")) return `greenhouse:${board}`;
    }
  }

  for (const link of links) {
    const ashby = link.match(/[?&]organizationId=([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
    if (ashby) return `ashby:${ashby[1]!.toLowerCase()}`;
  }

  return null;
};
