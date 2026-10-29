import type { JobRecord, JobStatus } from "../types/job";
import type { TopJobRecord, TopJobsSyncStatus } from "../types/topJob";
import type { AgentPanel, AgentRunSummary, AgentSuggestion, DraftCreated, ReplyTarget } from "../types/agent";
import type { InsightsPanel, ScoringAdjustment } from "../types/insights";
import type { AssistantProposal, AssistantReply, AssistantThread } from "../types/assistant";
import type {
  EvaluationSummary,
  EvaluationsResponse,
  GmailApplicationsResponse,
  GmailStatus,
  GmailSyncResult,
  InterviewBriefResponse,
  RecoveryStart,
  ScoringReport,
  ScoreRevisionView,
} from "../types/gmail";

const API_BASE = import.meta.env.VITE_API_BASE_URL ?? "http://localhost:4000/api";

const request = async <T>(path: string, init?: RequestInit): Promise<T> => {
  const response = await fetch(`${API_BASE}${path}`, {
    headers: { "Content-Type": "application/json" },
    ...init,
  });
  const text = await response.text();
  if (!response.ok) {
    let suffix = "";
    try {
      const body = JSON.parse(text) as { message?: string; detail?: string; issues?: unknown };
      if (body.message) suffix = `: ${body.message}`;
      if (body.detail) suffix += ` — ${body.detail}`;
      if (body.issues) suffix += ` ${JSON.stringify(body.issues)}`;
    } catch {
      if (text.trim()) suffix = `: ${text.slice(0, 500)}`;
    }
    throw new Error(`API error: ${response.status}${suffix}`);
  }
  if (!text.trim()) return {} as T;
  return JSON.parse(text) as T;
};

const fetchCsv = async (path: string): Promise<string> => {
  const response = await fetch(`${API_BASE}${path}`);
  if (!response.ok) {
    throw new Error(`API error: ${response.status}`);
  }
  return response.text();
};

export const api = {
  triage: (payload: { url?: string; rawText?: string; companyHint?: string; fullPrep?: boolean }) =>
    request<JobRecord & { tracked?: boolean; canConfirmApplied?: boolean }>("/jobs/triage", {
      method: "POST",
      cache: "no-store",
      body: JSON.stringify(payload),
    }),
  retriage: (id: string) =>
    request<JobRecord & { tracked?: boolean; canConfirmApplied?: boolean }>(`/jobs/${id}/retriage`, {
      method: "POST",
      cache: "no-store",
      body: JSON.stringify({}),
    }),
  listJobs: (query = "") =>
    request<{ items: JobRecord[]; total: number; totalAll?: number; shortlistTotal?: number }>(
      `/jobs${query}`,
    ),
  refreshShortlist: () =>
    request<{ total: number; updated: number; added: number; removed: number; unchanged: number }>(
      "/jobs/refresh-shortlist",
      { method: "POST", cache: "no-store" },
    ),
  getJob: (id: string) =>
    request<JobRecord & { statusHistory?: unknown[]; tracked?: boolean; canConfirmApplied?: boolean }>(
      `/jobs/${id}`,
      { cache: "no-store" },
    ),
  confirmApplied: (id: string) => request<JobRecord>(`/jobs/${id}/confirm-applied`, { method: "POST" }),
  updateStatus: (id: string, status: JobStatus, note?: string) =>
    request<JobRecord>(`/jobs/${id}/status`, { method: "PATCH", body: JSON.stringify({ status, note }) }),
  updateNotes: (id: string, notes: string) =>
    request<JobRecord>(`/jobs/${id}/notes`, { method: "PATCH", body: JSON.stringify({ notes }) }),
  updateAppliedAt: (id: string, appliedAt: string) =>
    request<JobRecord>(`/jobs/${id}/applied-at`, {
      method: "PATCH",
      body: JSON.stringify({ appliedAt }),
    }),
  setReachedHuman: (id: string, reachedHuman: boolean | null) =>
    request<JobRecord>(`/jobs/${id}/reached-human`, {
      method: "PATCH",
      body: JSON.stringify({ reachedHuman }),
    }),
  deleteJob: async (id: string) => {
    const response = await fetch(`${API_BASE}/jobs/${id}`, { method: "DELETE" });
    if (!response.ok) {
      throw new Error(`API error: ${response.status}`);
    }
  },
  exportJobs: (query = "") =>
    request<{
      rows: Array<{
        Company: string;
        Role: string;
        "Latest Score": number;
        "Recommended Action": string;
        "Salary Ask": string;
        "Top Match": string;
        "Main Risk": string;
        Resume: JobRecord["recommendedResume"];
        "Status / Outcome": string;
        Shortlist: boolean;
        Notes: string;
        "Created At": string;
        "Updated At": string;
      }>;
      total: number;
    }>(`/jobs/export${query}`),
  exportJobsCsv: (query = "") => fetchCsv(`/jobs/export${query}${query ? "&" : "?"}format=csv`),
  regenerateAssets: (id: string, force = false) =>
    request<JobRecord>(`/jobs/${id}/generate-assets`, { method: "POST", body: JSON.stringify({ force }) }),
  listTopJobs: () => request<{ items: TopJobRecord[]; total: number }>("/top-jobs"),
  getTopJob: (id: string) => request<TopJobRecord>(`/top-jobs/${id}`),
  getTopJobsSyncStatus: () => request<TopJobsSyncStatus>("/top-jobs/sync/status"),
  syncTopJobs: () =>
    request<{ stats: TopJobsSyncStatus["lastSyncStats"]; status: TopJobsSyncStatus }>("/top-jobs/sync", {
      method: "POST",
    }),
  promoteTopJob: (id: string) => request<JobRecord>(`/top-jobs/${id}/promote`, { method: "POST" }),
  markTopJobApplied: (id: string) => request<JobRecord>(`/top-jobs/${id}/applied`, { method: "POST" }),
  gmailConnectUrl: `${API_BASE}/gmail/oauth/start`,
  gmailStatus: () => request<GmailStatus>("/gmail/status", { cache: "no-store" }),
  gmailSync: (days = 7) =>
    request<GmailSyncResult>("/gmail/sync", {
      method: "POST",
      cache: "no-store",
      body: JSON.stringify({ days }),
    }),
  gmailApplications: (days = 7) =>
    request<GmailApplicationsResponse>(`/gmail/applications?days=${days}`, {
      cache: "no-store",
    }),
  gmailDisconnect: () => request<void>("/gmail/disconnect", { method: "POST" }),
  gmailEvaluations: (days = 7) =>
    request<EvaluationsResponse>(`/gmail/evaluations?days=${days}`, { cache: "no-store" }),
  gmailRunRecovery: (days = 7) =>
    request<RecoveryStart>("/gmail/evaluations/run", {
      method: "POST",
      cache: "no-store",
      body: JSON.stringify({ days }),
    }),
  gmailConfirmCandidate: (key: string, pick: { url?: string; prospectId?: string }) =>
    request<{ evaluation: EvaluationSummary }>(`/gmail/evaluations/${encodeURIComponent(key)}/confirm`, {
      method: "POST",
      body: JSON.stringify(pick),
    }),
  gmailDismissAction: (emailId: string) =>
    request<void>(`/gmail/actions/${encodeURIComponent(emailId)}/dismiss`, { method: "POST" }),
  gmailInterviewBrief: (key: string, regenerate = false) =>
    request<InterviewBriefResponse>(
      `/gmail/evaluations/${encodeURIComponent(key)}/interview-brief${regenerate ? "/regenerate" : ""}`,
      regenerate ? { method: "POST" } : { cache: "no-store" },
    ),
  gmailScoringReport: (key: string) =>
    request<ScoringReport>(`/gmail/evaluations/${encodeURIComponent(key)}/scoring`, { cache: "no-store" }),
  gmailRunDiagnostic: (key: string) =>
    request<ScoringReport>(`/gmail/evaluations/${encodeURIComponent(key)}/diagnose`, { method: "POST" }),
  gmailProposeScoreRevision: (key: string, body?: { allowRoleLaneChange?: boolean; reason?: string }) =>
    request<{ revision: ScoreRevisionView }>(`/gmail/evaluations/${encodeURIComponent(key)}/score-revisions`, {
      method: "POST",
      body: JSON.stringify(body ?? {}),
    }),
  gmailApproveScoreRevision: (key: string, revisionId: string, note?: string) =>
    request<{ revision: ScoreRevisionView }>(
      `/gmail/evaluations/${encodeURIComponent(key)}/score-revisions/${encodeURIComponent(revisionId)}/approve`,
      { method: "POST", body: JSON.stringify({ note }) },
    ),
  gmailRollbackScoreRevision: (key: string, revisionId: string, note?: string) =>
    request<{ revision: ScoreRevisionView }>(
      `/gmail/evaluations/${encodeURIComponent(key)}/score-revisions/${encodeURIComponent(revisionId)}/rollback`,
      { method: "POST", body: JSON.stringify({ note }) },
    ),
  gmailPasteJd: (key: string, text: string, url?: string) =>
    request<{ evaluation: EvaluationSummary }>(`/gmail/evaluations/${encodeURIComponent(key)}/jd`, {
      method: "POST",
      body: JSON.stringify({ text, url: url || undefined }),
    }),
  gmailUpdateTitle: (key: string, body: { title?: string; text?: string }) =>
    request<{ evaluation: EvaluationSummary }>(`/gmail/evaluations/${encodeURIComponent(key)}/title`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  agentPanel: () => request<AgentPanel>("/agent/suggestions", { cache: "no-store" }),
  agentRun: () => request<AgentPanel & { run: AgentRunSummary }>("/agent/run", { method: "POST" }),
  agentApprove: (id: string) =>
    request<{ suggestion: AgentSuggestion }>(`/agent/suggestions/${encodeURIComponent(id)}/approve`, {
      method: "POST",
    }),
  agentReplyTarget: (id: string) =>
    request<ReplyTarget>(`/agent/suggestions/${encodeURIComponent(id)}/reply-target`, { cache: "no-store" }),
  agentCreateDraft: (id: string, to: string, body: string) =>
    request<DraftCreated>(`/agent/suggestions/${encodeURIComponent(id)}/draft`, {
      method: "POST",
      body: JSON.stringify({ to, body }),
    }),
  agentDismiss: (id: string) =>
    request<void>(`/agent/suggestions/${encodeURIComponent(id)}/dismiss`, { method: "POST" }),
  insightsPanel: () => request<InsightsPanel>("/insights", { cache: "no-store" }),
  insightsRun: () => request<InsightsPanel>("/insights/run", { method: "POST" }),
  insightsAdjustment: (id: string, action: "approve" | "dismiss" | "disable") =>
    request<{ adjustment: ScoringAdjustment }>(`/insights/adjustments/${encodeURIComponent(id)}/${action}`, {
      method: "POST",
    }),
  assistantThread: () => request<AssistantThread>("/assistant/thread", { cache: "no-store" }),
  assistantClear: () => request<void>("/assistant/thread", { method: "DELETE" }),
  assistantSend: (text: string) =>
    request<AssistantReply>("/assistant/message", { method: "POST", body: JSON.stringify({ text }) }),
  assistantReplyTarget: (id: string) =>
    request<ReplyTarget>(`/assistant/proposals/${encodeURIComponent(id)}/reply-target`, { cache: "no-store" }),
  assistantApprove: (id: string, email?: { to: string; body: string }) =>
    request<{ proposal: AssistantProposal; draftsUrl?: string }>(
      `/assistant/proposals/${encodeURIComponent(id)}/approve`,
      { method: "POST", body: JSON.stringify(email ? { email } : {}) },
    ),
  assistantDismiss: (id: string) =>
    request<void>(`/assistant/proposals/${encodeURIComponent(id)}/dismiss`, { method: "POST" }),
};
