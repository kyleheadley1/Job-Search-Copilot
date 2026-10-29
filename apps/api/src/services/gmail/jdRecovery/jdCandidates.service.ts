import { computeJdTextHash } from "../../../lib/jdTextHash.js";
import { normalizeSourceUrl } from "../../../lib/normalizeSourceUrl.js";
import { normalizeCompany, type GmailApplication } from "../gmailApplications.js";
import { cleanProspectJd } from "./cleanProspectJd.js";
import { jdTextLooksComplete } from "./jdCompleteness.js";
import type {
  ApplicationEvaluation,
  JdCompleteness,
  JdSourceType,
  RecoveryCandidate,
} from "./evaluations.repository.js";
import {
  AlreadyScoredError,
  EvaluationNotFoundError,
  MIN_PASTED_JD_CHARS,
  RECOVERY_VERSION,
  buildOutcome,
} from "./runRecovery.js";

export const MAX_SUBMITTED_CANDIDATES = 5;
const MAX_CANDIDATE_TEXT = 20_000;
const MAX_EVIDENCE_ITEMS = 10;
const MAX_EVIDENCE_CHARS = 400;

export class CompanyMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CompanyMismatchError";
  }
}

export class InvalidJdCandidateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidJdCandidateError";
  }
}

export class CandidatesFullError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CandidatesFullError";
  }
}

export type SubmitJdCandidateInput = {
  applicationKey: string;
  company: string;
  title?: string;
  originalText: string;
  sourceUrl: string;
  sourceType: JdSourceType;
  retrievedAt?: string;
  matchEvidence: string[];
  completeness: JdCompleteness;
};

export type SubmitJdCandidateResult = {
  applicationKey: string;
  status: "submitted" | "already_submitted";
  duplicate: boolean;
  reviewRequired: true;
  scoringEligible: boolean;
  completeness: JdCompleteness;
  claimedCompleteness: JdCompleteness;
  sourceUrl: string;
  sourceType: JdSourceType;
  retrievedAt: string;
  candidateCount: number;
  recoveryStatus: ApplicationEvaluation["recovery"]["status"];
};

export type MissingJobDescriptionRow = {
  applicationKey: string;
  company: string;
  title: string | null;
  appliedAt: string;
  appliedAtKnown: boolean;
  furthestStage: GmailApplication["furthestStage"];
  recoveryStatus: ApplicationEvaluation["recovery"]["status"] | "none";
  recoveryReason?: string;
  requisitionId?: string;
  candidateCount: number;
  latestSubject?: string;
  emailCount: number;
  submittedCandidates: Array<{
    sourceUrl?: string;
    sourceType?: JdSourceType;
    completeness?: JdCompleteness;
    retrievedAt?: string;
    title?: string;
  }>;
};

export type JdCandidateStore = {
  getApplications: (days: number) => Promise<GmailApplication[]>;
  findByKey: (key: string) => Promise<ApplicationEvaluation | null>;
  upsertIfUnscored: (evaluation: ApplicationEvaluation) => Promise<ApplicationEvaluation>;
};

/** Still needs a JD: anything that is not a frozen scored evaluation. */
export const needsJobDescription = (evaluation?: ApplicationEvaluation): boolean =>
  evaluation?.recovery.status !== "scored";

export const classifySubmittedCompleteness = (
  cleanedText: string,
  claimed: JdCompleteness,
): JdCompleteness => {
  if (claimed === "partial") return "partial";
  return jdTextLooksComplete(cleanedText, MIN_PASTED_JD_CHARS) ? "full" : "partial";
};

const capEvidence = (items: string[]): string[] =>
  items
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, MAX_EVIDENCE_ITEMS)
    .map((item) => item.slice(0, MAX_EVIDENCE_CHARS));

const toMissingRow = (app: GmailApplication, evaluation?: ApplicationEvaluation): MissingJobDescriptionRow => {
  const submitted = (evaluation?.recovery.candidates ?? []).filter((c) => c.source === "mcp");
  return {
    applicationKey: app.key,
    company: app.company,
    title: app.role,
    appliedAt: app.appliedAt,
    appliedAtKnown: app.appliedAtKnown !== false,
    furthestStage: app.furthestStage,
    recoveryStatus: evaluation?.recovery.status ?? "none",
    recoveryReason: evaluation?.recovery.reason,
    requisitionId: evaluation?.requisitionId,
    candidateCount: evaluation?.recovery.candidates?.length ?? 0,
    latestSubject: app.emails.at(-1)?.subject,
    emailCount: app.emails.length,
    submittedCandidates: submitted.map((c) => ({
      sourceUrl: c.url,
      sourceType: c.sourceType,
      completeness: c.completeness,
      retrievedAt: c.retrievedAt,
      title: c.title,
    })),
  };
};

export const listMissingJobDescriptions = (
  apps: GmailApplication[],
  evaluations: Map<string, ApplicationEvaluation>,
  opts: { offset: number; limit: number; query?: string },
): { totalMatched: number; applications: MissingJobDescriptionRow[] } => {
  const q = opts.query?.toLowerCase();
  const matched = apps.filter((app) => {
    if (!needsJobDescription(evaluations.get(app.key))) return false;
    if (!q) return true;
    return app.company.toLowerCase().includes(q) || (app.role ?? "").toLowerCase().includes(q);
  });
  const page = matched.slice(opts.offset, opts.offset + opts.limit);
  return {
    totalMatched: matched.length,
    applications: page.map((app) => toMissingRow(app, evaluations.get(app.key))),
  };
};

export const submitJdCandidate = async (
  input: SubmitJdCandidateInput,
  store: JdCandidateStore,
  lookbackDays: number,
): Promise<SubmitJdCandidateResult> => {
  const apps = await store.getApplications(lookbackDays);
  const app = apps.find((row) => row.key === input.applicationKey);
  if (!app) {
    throw new EvaluationNotFoundError(`No application with key ${input.applicationKey}`);
  }
  if (normalizeCompany(input.company) !== normalizeCompany(app.company)) {
    throw new CompanyMismatchError(
      `Company "${input.company}" does not match application ${app.key} (${app.company})`,
    );
  }

  const existing = await store.findByKey(app.key);
  if (existing?.recovery.status === "scored") {
    throw new AlreadyScoredError(`${app.key} is already scored; scores are final`);
  }

  const sourceUrl = normalizeSourceUrl(input.sourceUrl);
  if (!sourceUrl) {
    throw new InvalidJdCandidateError("sourceUrl must be an http(s) URL");
  }

  const originalText = input.originalText.replace(/\r\n/g, "\n").trim();
  if (!originalText) {
    throw new InvalidJdCandidateError("originalText is empty");
  }
  const cleanedText = (cleanProspectJd(originalText) || originalText).slice(0, MAX_CANDIDATE_TEXT);
  const completeness = classifySubmittedCompleteness(cleanedText, input.completeness);
  const retrievedAt = input.retrievedAt && !Number.isNaN(Date.parse(input.retrievedAt))
    ? new Date(input.retrievedAt).toISOString()
    : new Date().toISOString();
  const title = input.title?.trim() || app.role || undefined;
  const matchEvidence = capEvidence(input.matchEvidence);
  if (matchEvidence.length === 0) {
    throw new InvalidJdCandidateError("matchEvidence is required");
  }

  const candidate: RecoveryCandidate = {
    url: sourceUrl,
    source: "mcp",
    stage: "mcp",
    matchLevel: "low",
    title,
    company: app.company,
    text: cleanedText,
    rawText: originalText.slice(0, MAX_CANDIDATE_TEXT),
    completeness,
    claimedCompleteness: input.completeness,
    sourceType: input.sourceType,
    retrievedAt,
    matchEvidence,
  };

  const now = new Date().toISOString();
  const current = existing?.recovery.candidates ?? [];
  const duplicate = current.find((c) => c.source === "mcp" && c.url === sourceUrl);
  if (duplicate) {
    return {
      applicationKey: app.key,
      status: "already_submitted",
      duplicate: true,
      reviewRequired: true,
      scoringEligible: duplicate.completeness === "full",
      completeness: duplicate.completeness ?? completeness,
      claimedCompleteness: input.completeness,
      sourceUrl,
      sourceType: duplicate.sourceType ?? input.sourceType,
      retrievedAt: duplicate.retrievedAt ?? retrievedAt,
      candidateCount: current.length,
      recoveryStatus: existing?.recovery.status ?? "unverified",
    };
  }
  if (current.length >= MAX_SUBMITTED_CANDIDATES) {
    throw new CandidatesFullError(`Already have ${MAX_SUBMITTED_CANDIDATES} candidates for ${app.key}`);
  }

  const evaluation: ApplicationEvaluation = existing
    ? {
        ...existing,
        recovery: {
          ...existing.recovery,
          status: "unverified",
          candidates: [...current, candidate],
        },
        updatedAt: now,
      }
    : {
        key: app.key,
        company: app.company,
        role: app.role,
        appliedAt: app.appliedAt,
        recoveryVersion: RECOVERY_VERSION,
        recovery: {
          status: "unverified",
          reason: "mcp_candidate_pending",
          notes: ["mcp_candidate_pending"],
          attempts: [],
          serperQueries: 0,
          candidates: [candidate],
        },
        outcome: buildOutcome(app),
        createdAt: now,
        updatedAt: now,
      };

  const written = await store.upsertIfUnscored(evaluation);
  if (written.recovery.status === "scored") {
    throw new AlreadyScoredError(`${app.key} is already scored; scores are final`);
  }

  return {
    applicationKey: app.key,
    status: "submitted",
    duplicate: false,
    reviewRequired: true,
    scoringEligible: completeness === "full",
    completeness,
    claimedCompleteness: input.completeness,
    sourceUrl,
    sourceType: input.sourceType,
    retrievedAt,
    candidateCount: written.recovery.candidates?.length ?? 1,
    recoveryStatus: written.recovery.status,
  };
};

export type RevalidateCandidateResult = {
  applicationKey: string;
  updated: boolean;
  completeness: JdCompleteness;
  scoringEligible: boolean;
  reviewRequired: true;
  recoveryStatus: ApplicationEvaluation["recovery"]["status"];
};

/**
 * Re-run the server completeness check on an existing MCP candidate.
 * Never scores, never overwrites JD text/URL/provenance, never upgrades a claimed-partial.
 */
export const revalidateSubmittedCandidateCompleteness = async (
  key: string,
  sourceUrl: string,
  store: JdCandidateStore,
): Promise<RevalidateCandidateResult> => {
  const existing = await store.findByKey(key);
  if (!existing) throw new EvaluationNotFoundError(`No evaluation for ${key}`);
  if (existing.recovery.status === "scored") {
    throw new AlreadyScoredError(`${key} is already scored; scores are final`);
  }
  const normalized = normalizeSourceUrl(sourceUrl);
  if (!normalized) throw new InvalidJdCandidateError("sourceUrl must be an http(s) URL");
  const candidates = existing.recovery.candidates ?? [];
  const index = candidates.findIndex((c) => c.source === "mcp" && c.url === normalized);
  if (index < 0) throw new EvaluationNotFoundError(`No MCP candidate ${normalized} for ${key}`);
  const candidate = candidates[index]!;
  if (candidate.claimedCompleteness === "partial") {
    return {
      applicationKey: key,
      updated: false,
      completeness: candidate.completeness ?? "partial",
      scoringEligible: candidate.completeness === "full",
      reviewRequired: true,
      recoveryStatus: existing.recovery.status,
    };
  }
  const completeness = classifySubmittedCompleteness(candidate.text, "full");
  if (completeness === (candidate.completeness ?? "partial")) {
    return {
      applicationKey: key,
      updated: false,
      completeness,
      scoringEligible: completeness === "full",
      reviewRequired: true,
      recoveryStatus: existing.recovery.status,
    };
  }
  const nextCandidates = candidates.map((row, i) => (i === index ? { ...row, completeness } : row));
  const written = await store.upsertIfUnscored({
    ...existing,
    recovery: { ...existing.recovery, status: "unverified", candidates: nextCandidates },
    updatedAt: new Date().toISOString(),
  });
  if (written.recovery.status === "scored") {
    throw new AlreadyScoredError(`${key} is already scored; scores are final`);
  }
  return {
    applicationKey: key,
    updated: true,
    completeness,
    scoringEligible: completeness === "full",
    reviewRequired: true,
    recoveryStatus: written.recovery.status,
  };
};
