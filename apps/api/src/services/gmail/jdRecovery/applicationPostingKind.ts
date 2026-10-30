import type { GmailApplication } from "../gmailApplications.js";
import {
  AlreadyScoredError,
  EvaluationNotFoundError,
} from "./runRecovery.js";
import type { ApplicationEvaluation } from "./evaluations.repository.js";
import { POSTING_KINDS, type PostingKind } from "./postingKind.js";

export class InvalidPostingKindError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidPostingKindError";
  }
}

export class NotAJobPostingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotAJobPostingError";
  }
}

export const isTalentPoolOrEvent = (evaluation?: ApplicationEvaluation): boolean =>
  evaluation?.postingKind === "talent_pool_or_event";

export type ClassifyPostingKindInput = {
  applicationKey: string;
  postingKind: PostingKind;
  reason: string;
  evidence?: string[];
};

export type ClassifyPostingKindResult = {
  applicationKey: string;
  postingKind: PostingKind;
  previousPostingKind: PostingKind;
  restored: boolean;
  scored: false;
  reason: string;
  note: string;
};

const capReason = (reason: string): string => reason.trim().slice(0, 400);

export const classifyPostingKind = async (
  input: ClassifyPostingKindInput,
  deps: {
    getApplications: (days: number) => Promise<GmailApplication[]>;
    findByKey: (key: string) => Promise<ApplicationEvaluation | null>;
    upsertIfUnscored: (evaluation: ApplicationEvaluation) => Promise<ApplicationEvaluation>;
    identityLookbackDays: number;
    now?: () => Date;
  },
): Promise<{ evaluation: ApplicationEvaluation; result: ClassifyPostingKindResult }> => {
  if (!POSTING_KINDS.includes(input.postingKind)) {
    throw new InvalidPostingKindError(`Unknown postingKind ${input.postingKind}`);
  }
  const reason = capReason(input.reason);
  if (reason.length < 3) {
    throw new InvalidPostingKindError("reason is required");
  }
  const apps = await deps.getApplications(deps.identityLookbackDays);
  const app = apps.find((row) => row.key === input.applicationKey);
  const existing = await deps.findByKey(input.applicationKey);
  if (!app && !existing) {
    throw new EvaluationNotFoundError(`No application with key ${input.applicationKey}`);
  }
  if (existing?.recovery.status === "scored") {
    throw new AlreadyScoredError(`${input.applicationKey} is already scored; scores are final`);
  }
  const nowIso = (deps.now?.() ?? new Date()).toISOString();
  const previous = existing?.postingKind ?? "unknown";
  const base: ApplicationEvaluation = existing ?? {
    key: app!.key,
    company: app!.company,
    role: app!.role,
    appliedAt: app!.appliedAt,
    recovery: { status: "unverified", attempts: [], serperQueries: 0 },
    outcome: {
      status: app!.status,
      updatedAt: nowIso,
      history: [{ status: app!.status, at: nowIso }],
      furthestStage: app!.furthestStage,
    },
    createdAt: nowIso,
    updatedAt: nowIso,
  };
  const updated: ApplicationEvaluation = {
    ...base,
    postingKind: input.postingKind,
    postingKindReason: reason,
    postingKindUpdatedAt: nowIso,
    postingKindSource: "explicit",
    updatedAt: nowIso,
  };
  const written = await deps.upsertIfUnscored(updated);
  if (written.recovery.status === "scored") {
    throw new AlreadyScoredError(`${input.applicationKey} is already scored; scores are final`);
  }
  const restored = previous === "talent_pool_or_event" && input.postingKind !== "talent_pool_or_event";
  return {
    evaluation: written,
    result: {
      applicationKey: written.key,
      postingKind: input.postingKind,
      previousPostingKind: previous,
      restored,
      scored: false,
      reason,
      note:
        input.postingKind === "talent_pool_or_event"
          ? "Classified as a talent-pool or event registration. Excluded from JD recovery and scoring. Distinct from a failed JD search. Reversible."
          : restored
            ? "Restored to a job application. Eligible for JD recovery again. Not scored."
            : "Posting kind updated. Not scored.",
    },
  };
};
