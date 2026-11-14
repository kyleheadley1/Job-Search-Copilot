import {
  APPLICATION_IDENTITY_LOOKBACK_DAYS,
  getGmailApplications,
  normalizeCompany,
  roleTokens,
  type ApplicationEmail,
} from "../gmailApplications.js";
import { gmailMessagesRepository } from "../gmailMessages.repository.js";
import { normalizeTitle } from "./titleMatch.js";
import {
  evaluationsRepository,
  type ApplicationEvaluation,
  type RecoveryCandidate,
} from "./evaluations.repository.js";
import { AlreadyScoredError, EvaluationNotFoundError } from "./runRecovery.js";

export class CannotSplitRoleLessError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CannotSplitRoleLessError";
  }
}

const SECURITY_CODE_RE = /\bsecurity code\b/i;

const isActiveCandidate = (candidate: RecoveryCandidate): boolean =>
  Boolean(candidate.title?.trim()) &&
  candidate.reviewStatus !== "rejected" &&
  candidate.reviewStatus !== "removed";

const distinctCandidates = (candidates: RecoveryCandidate[]): RecoveryCandidate[] => {
  const seen = new Set<string>();
  const out: RecoveryCandidate[] = [];
  for (const candidate of candidates) {
    if (!isActiveCandidate(candidate)) continue;
    const key = normalizeTitle(candidate.title!);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(candidate);
  }
  return out;
};

export const assignableAppliedEmails = (emails: ApplicationEmail[]): ApplicationEmail[] =>
  [...emails]
    .filter((email) => email.eventType === "applied" && !SECURITY_CODE_RE.test(email.subject))
    .sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));

const applicationKeyFor = (company: string, title: string): string =>
  `${normalizeCompany(company)}::${roleTokens(title).join(" ")}`;

const outcomeForEmail = (
  email: ApplicationEmail,
): ApplicationEvaluation["outcome"] => ({
  status: "applied",
  furthestStage: "applied",
  updatedAt: email.date,
  history: [{ status: "applied", at: email.date }],
});

/**
 * Greenhouse-style confirmations often omit the role. Two applies then collapse into `company::`
 * with several JD candidates. Assign each distinct candidate title to one applied email so Gmail
 * grouping produces one application per role, and move each candidate onto its own evaluation.
 */
export const splitRoleLessByCandidates = async (
  key: string,
): Promise<{ keys: string[]; evaluations: ApplicationEvaluation[] }> => {
  const evaluation = await evaluationsRepository.findByKey(key);
  if (!evaluation) throw new EvaluationNotFoundError(`No evaluation for ${key}`);
  if (evaluation.recovery.status === "scored") {
    throw new AlreadyScoredError(`${key} is already scored; split before confirming a JD`);
  }
  if (evaluation.role?.trim()) {
    throw new CannotSplitRoleLessError(`${key} already has a role; only role-less rows can be split`);
  }

  const candidates = distinctCandidates(evaluation.recovery.candidates ?? []);
  if (candidates.length < 2) {
    throw new CannotSplitRoleLessError("Need at least two distinct JD candidates to split into separate applications");
  }

  const apps = await getGmailApplications(APPLICATION_IDENTITY_LOOKBACK_DAYS);
  const app = apps.find((row) => row.key === key);
  if (!app) throw new EvaluationNotFoundError(`No Gmail application for ${key}`);

  const emails = assignableAppliedEmails(app.emails);
  if (emails.length < 2) {
    throw new CannotSplitRoleLessError(
      "Need at least two applied confirmation emails (security-code mail does not count) to split",
    );
  }

  const pairs = Math.min(candidates.length, emails.length);
  const now = new Date().toISOString();
  const created: ApplicationEvaluation[] = [];
  const keys: string[] = [];

  for (let i = 0; i < pairs; i += 1) {
    const candidate = candidates[i]!;
    const email = emails[i]!;
    const title = candidate.title!.trim();
    const nextKey = applicationKeyFor(evaluation.company, title);
    if (keys.includes(nextKey)) {
      throw new CannotSplitRoleLessError(`Candidate titles collapsed to the same application key (${nextKey})`);
    }
    const existing = await evaluationsRepository.findByKey(nextKey);
    if (existing?.recovery.status === "scored") {
      throw new CannotSplitRoleLessError(`Cannot split onto ${nextKey}; that application is already scored`);
    }
    await gmailMessagesRepository.setClassificationRole(email.id, title);
    const sibling: ApplicationEvaluation = {
      ...evaluation,
      key: nextKey,
      role: title,
      appliedAt: email.date,
      outcome: outcomeForEmail(email),
      recovery: {
        ...evaluation.recovery,
        status: "unverified",
        reason: undefined,
        notes: ["split_from_role_less"],
        candidates: [candidate],
      },
      fit: undefined,
      jd: undefined,
      outcomeAtScoring: undefined,
      diagnostic: undefined,
      interviewBrief: undefined,
      updatedAt: now,
    };
    await evaluationsRepository.upsert(sibling);
    created.push(sibling);
    keys.push(nextKey);
  }

  for (const email of app.emails) {
    if (SECURITY_CODE_RE.test(email.subject)) {
      await gmailMessagesRepository.setNotApplicationEmail(email.id, "security_code");
    }
  }

  const leftover = candidates.slice(pairs);
  if (leftover.length > 0) {
    await evaluationsRepository.upsert({
      ...evaluation,
      recovery: {
        ...evaluation.recovery,
        notes: [...new Set([...(evaluation.recovery.notes ?? []), "split_partial_remainder"])],
        candidates: leftover,
      },
      updatedAt: now,
    });
  } else {
    await evaluationsRepository.remove(key);
  }

  return { keys, evaluations: created };
};
