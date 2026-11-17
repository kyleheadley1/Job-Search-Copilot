import type { JobStatus } from "./job";

export type AgentKind = "action_reply" | "interview_prep" | "thank_you" | "follow_up" | "mark_ghosted";

export type AgentSuggestion = {
  id: string;
  kind: AgentKind;
  appKey: string;
  company: string;
  role: string | null;
  title: string;
  reason: string;
  priority: number;
  dueAt?: string;
  /** Interview / conversation time; used to freshen "today"/"yesterday" when opening a draft. */
  eventAt?: string;
  gmailUrl?: string;
  trackerJobId?: string;
  draftable: boolean;
  draft?: string;
  proposedChange?: { jobId: string; status: JobStatus };
  writtenBy: "agent" | "rules";
  status: "open" | "approved" | "done" | "dismissed" | "expired";
  createdAt: string;
  updatedAt: string;
};

export type AgentRunSummary = {
  at: string;
  candidates: number;
  written: number;
  budgetLimited: boolean;
};

export type ReplyTarget = {
  emailId: string;
  threadId: string;
  /** reply = continue a person thread; compose = brand-new email (never a calendar invite). */
  mode?: "reply" | "compose";
  /** Empty when the thread only has automated senders. */
  to: string;
  subject: string;
};

export type DraftCreated = { draftId: string; threadId: string; to: string; draftsUrl: string };

export type AgentPanel = {
  enabled: boolean;
  canCreateDrafts?: boolean;
  suggestions: AgentSuggestion[];
  lastRun: AgentRunSummary | null;
  budget: { monthlyUsd: number; spentThisMonthUsd: number };
};
