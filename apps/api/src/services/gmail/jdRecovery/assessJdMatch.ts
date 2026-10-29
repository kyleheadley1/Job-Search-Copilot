import { normalizeCompany, roleSimilarity } from "../gmailApplications.js";
import type { FetchedPosting } from "./fetchPosting.js";
import { strictTitleSimilarity } from "./titleMatch.js";

export type MatchLevel = "exact" | "high" | "low" | "none";
export type EvidenceSource = "email_link" | "email_body" | "ats_board" | "serper" | "manual" | "prospect" | "mcp";

export type JdMatch = { level: MatchLevel; signals: string[]; roleSimilarity: number };

export const HIGH_ROLE_SIMILARITY = 0.8;
const NONE_ROLE_SIMILARITY = 0.5;
const COMPANY_SCAN_CHARS = 4000;

const compact = (s: string) => normalizeCompany(s).replace(/\s+/g, "");
const normId = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, "");

const companyMatches = (company: string, posting: Pick<FetchedPosting, "company" | "url" | "text">): boolean => {
  const want = compact(company);
  if (!want) return false;
  if (posting.company && compact(posting.company) === want) return true;
  if (want.length < 5) {
    const words = normalizeCompany(company);
    const re = new RegExp(`(^|[^a-z0-9])${escapeRe(words).replace(/ /g, "[^a-z0-9]*")}([^a-z0-9]|$)`, "i");
    return [posting.company ?? "", posting.url, posting.text.slice(0, COMPANY_SCAN_CHARS)].some((h) => re.test(h));
  }
  const haystacks = [posting.company ?? "", posting.url, posting.text.slice(0, COMPANY_SCAN_CHARS)];
  return haystacks.some((h) => h.toLowerCase().replace(/[^a-z0-9]+/g, "").includes(want));
};

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const reqIdFound = (reqId: string, posting: Pick<FetchedPosting, "requisitionId" | "url" | "text">): boolean => {
  if (posting.requisitionId && normId(posting.requisitionId).endsWith(normId(reqId))) return true;
  const re = new RegExp(`(^|[^A-Za-z0-9])${escapeRe(reqId)}([^A-Za-z0-9]|$)`, "i");
  return re.test(posting.url) || re.test(posting.text);
};

const postingTitle = (posting: Pick<FetchedPosting, "title" | "text">): string =>
  posting.title ?? posting.text.split("\n").find((l) => l.trim())?.trim() ?? "";

/**
 * How sure we are that the recovered posting is the one applied to. Independent of fit:
 * only "exact" and "high" are trusted enough to score.
 */
export const assessJdMatch = (input: {
  company: string;
  role: string | null;
  requisitionId?: string;
  source: EvidenceSource;
  posting: Pick<FetchedPosting, "company" | "title" | "requisitionId" | "url" | "text">;
  /** ats_board only: the board was confirmed as this company's own. */
  boardConfirmed?: boolean;
  /** ats_board only: open jobs on the board whose title is near-identical to the role. */
  boardTitleMatches?: number;
}): JdMatch => {
  const { posting } = input;
  const signals: string[] = [];
  const onOwnBoard = input.source === "ats_board" && input.boardConfirmed === true;
  const sameCompany = onOwnBoard || companyMatches(input.company, posting);
  signals.push(sameCompany ? "company_match" : "company_mismatch");
  const similarity = input.role ? roleSimilarity(input.role, postingTitle(posting)) : 0;
  if (input.role) signals.push(`role_similarity:${similarity.toFixed(2)}`);
  else signals.push("role_unknown");

  if (!sameCompany) return { level: "none", signals, roleSimilarity: similarity };

  if (input.requisitionId) {
    if (reqIdFound(input.requisitionId, posting)) {
      signals.push("req_id_match");
      return { level: "exact", signals, roleSimilarity: similarity };
    }
    if (posting.requisitionId) {
      signals.push("req_id_mismatch");
      return { level: "none", signals, roleSimilarity: similarity };
    }
    signals.push("req_id_absent_from_posting");
  }

  if (input.role && similarity < NONE_ROLE_SIMILARITY) {
    signals.push("role_mismatch");
    return { level: "none", signals, roleSimilarity: similarity };
  }

  const fromEmail = input.source === "email_link" || input.source === "email_body";
  if (fromEmail) signals.push(input.source);
  if (fromEmail && input.role && similarity >= HIGH_ROLE_SIMILARITY) {
    return { level: "high", signals, roleSimilarity: similarity };
  }
  if (onOwnBoard) {
    signals.push("company_board", `board_title_matches:${input.boardTitleMatches ?? 0}`);
    const strict = input.role ? strictTitleSimilarity(input.role, postingTitle(posting)) : 0;
    signals.push(`strict_title_similarity:${strict.toFixed(2)}`);
    if (strict >= HIGH_ROLE_SIMILARITY && input.boardTitleMatches === 1) {
      return { level: "high", signals, roleSimilarity: similarity };
    }
  }
  return { level: "low", signals, roleSimilarity: similarity };
};

export const isScoreable = (level: MatchLevel): boolean => level === "exact" || level === "high";
