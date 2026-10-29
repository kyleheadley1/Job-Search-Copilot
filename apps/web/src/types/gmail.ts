import type { ExtractedJobData, JobStatus, ResumeType, RuleEvaluation, ScoreBreakdown } from "./job";

export type GmailStatus = {
  configured: boolean;
  connected: boolean;
  email?: string;
  lastSyncAt?: string;
  needsReconnect?: boolean;
  /** The connection includes gmail.drafts.create (never send). */
  canCreateDrafts?: boolean;
  /** Granted scopes beyond read-only + drafts.create; should never appear. */
  extraScopes?: string[];
  /** Minutes between background syncs on the API; 0 when disabled. */
  autoSyncMinutes?: number;
};

export type EmailEventType = "applied" | "rejected" | "interview" | "assessment" | "offer" | "other";

export type ApplicationStatus = "applied" | "assessment" | "interviewing" | "rejected" | "offer";

export type ApplicationEmail = {
  id: string;
  subject: string;
  from: string;
  date: string;
  eventType: EmailEventType;
  gmailUrl: string;
  round?: number;
};

export type InterviewRound = {
  number: number;
  kind: string | null;
  focus: string | null;
  interviewers: string | null;
  startedAt: string;
  scheduledAt?: string | null;
  durationMinutes?: number | null;
  cancelled?: boolean;
  label: string;
};

export type GmailApplication = {
  key: string;
  company: string;
  role: string | null;
  appliedAt: string;
  appliedAtKnown?: boolean;
  appliedAtSource?: "email" | "tracker" | "estimated";
  status: ApplicationStatus;
  furthestStage?: Exclude<ApplicationStatus, "rejected">;
  interviewRounds?: InterviewRound[];
  activelyInterviewing?: boolean;
  lastUpdateAt: string;
  emails: ApplicationEmail[];
  trackerJobId?: string;
  trackerStatus?: JobStatus;
  trackerTitle?: string;
  suggestedStatus?: JobStatus;
  evaluation?: EvaluationSummary;
};

export type RecoveryStatus = "scored" | "unverified" | "not_found" | "fetch_failed";
export type MatchLevel = "exact" | "high" | "low" | "none";

export type RecoveryAttempt = {
  url: string;
  source: string;
  ok: boolean;
  reason?: string;
  matchLevel?: MatchLevel;
};

export type EvaluationSummary = {
  status: RecoveryStatus;
  reason?: string;
  notes?: string[];
  attempts?: RecoveryAttempt[];
  candidates?: Array<{
    url?: string;
    prospectId?: string;
    title?: string;
    location?: string;
    matchLevel: MatchLevel;
    source: string;
  }>;
  verifiedBy?: "auto" | "user";
  jdTitle?: string;
  recoveredRole?: string;
  boardChecks?: Array<{ board: string; jobs: number; closestTitle?: string; similarity?: number }>;
  fitBreakdown?: {
    categories: Record<string, number>;
    capability?: number;
    survivability?: number;
    gapDock?: number;
    hardGates?: string[];
    topMatch?: string;
    mainRisk?: string;
    risks?: string[];
  };
  fitTotal?: number;
  recommendation?: string;
  recommendedResume?: ResumeType;
  matchLevel?: MatchLevel;
  url?: string;
};

export type RubricPoint = {
  company: string;
  role: string | null;
  fit: number;
  verifiedBy: "auto" | "user";
  furthestStage?: Exclude<ApplicationStatus, "rejected">;
  furthestRound?: { number: number; label: string };
};

export type RubricSummary = {
  rows: Array<{ outcome: ApplicationStatus; count: number; meanFit: number | null }>;
  reachedInterview?: { count: number; meanFit: number | null };
  scored: number;
  userVerified: number;
  points: Partial<Record<ApplicationStatus, RubricPoint[]>>;
  byRecoveryStatus: Record<RecoveryStatus, number>;
};

export type RecoveryRunState = {
  running: boolean;
  startedAt?: string;
  finishedAt?: string;
  processed: number;
  scored: number;
  error?: string;
};

export type EvaluationsResponse = {
  days: number;
  run: RecoveryRunState;
  /** `used` and `cap` are Serper queries. */
  serper: { used: number; cap: number; configured: boolean };
  rubricSummary: RubricSummary;
  metrics?: RecoveryMetrics;
  costs?: CostSummary;
};

export type StageBucket = "email" | "company_board" | "serper" | "manual";

export type RecoveryMetrics = {
  applications: number;
  withUsefulData: number;
  verifiedAuto: number;
  userPicked: number;
  userPasted: number;
  needsPick: number;
  notFound: number;
  byBucket: Record<StageBucket, { verified: number; candidatesOnly: number }>;
  serper: {
    jobsSearched: number;
    jobsWithResults: number;
    verified: number;
    candidatesOnly: number;
    queriesUsed: number;
    budget: number;
    freeGrant: number;
  };
};

export type LlmFeature = "gmail_classify" | "jd_recovery" | "top_jobs" | "agent" | "assistant" | "insights" | "other";

export type MonthSpend = {
  total: number;
  byFeature: Record<LlmFeature, number>;
  /** Hard monthly caps for features that have one. */
  budgets: Partial<Record<LlmFeature, number>>;
};

export type CostSummary = {
  model: string;
  trackingSince: string | null;
  today: number;
  last7Days: number;
  windowDays: number;
  windowTotal: number;
  byFeature: Record<LlmFeature, { costUsd: number; calls: number }>;
  byDay: Array<{ day: string; costUsd: number }>;
  perScoredRole: number | null;
  perEmailClassified: number | null;
  thisMonth?: MonthSpend;
};

export type ScoringDetail = {
  recommendation: string;
  recommendedResume: string;
  topMatch: string;
  mainRisk: string;
  rationale: string[];
  risks: string[];
  resumeRationale: string[];
  score: ScoreBreakdown & Record<string, unknown>;
  rules: RuleEvaluation & Record<string, unknown>;
  extracted: Omit<ExtractedJobData, "rawText">;
};

export type ScoringReport = {
  key: string;
  company: string;
  role: string | null;
  fit: {
    total: number;
    recommendation: string;
    scoredAt: string;
    promptVersion: string;
    detail?: ScoringDetail;
  } | null;
  diagnostic: { runAt: string; promptVersion: string; total: number; detail: ScoringDetail } | null;
  jd: { text: string; title?: string; url?: string } | null;
};

export type UpcomingInterview = {
  key: string;
  company: string;
  role: string | null;
  roundNumber: number;
  label: string;
  scheduledAt: string;
  durationMinutes: number | null;
  gmailUrl?: string;
};

export type ActionType = "schedule" | "reply" | "assessment" | "offer";

export type ActionItem = {
  key: string;
  company: string;
  role: string | null;
  emailId: string;
  threadId: string;
  type: ActionType;
  summary: string | null;
  deadline: string | null;
  receivedAt: string;
  gmailUrl: string;
};

export type InterviewBrief = {
  companyBio: string;
  teamNeed: string;
  strengths: Array<{ point: string; evidence: string }>;
  weakPoints: Array<{ gap: string; probe: string; answer: string }>;
  askThem: string[];
  generatedAt: string;
  promptVersion: string;
};

export type InterviewBriefResponse = {
  key: string;
  company: string;
  role: string | null;
  round: string | null;
  brief: InterviewBrief | null;
  reason?: "no_jd" | "llm_failed";
  prepPrompt: string;
};

export type GmailApplicationsResponse = {
  days: number;
  applications: GmailApplication[];
  pendingRecovery: number;
  upcomingInterviews?: UpcomingInterview[];
  actionItems?: ActionItem[];
};

export type RecoveryStart = { queued: number; running: boolean; started: boolean };

export type GmailSyncResult = {
  days: number;
  scanned: number;
  alreadyProcessed: number;
  prefiltered: number;
  classified: number;
  applicationEmails: number;
  llmFailures: number;
  interviewDetails?: number;
  deferred?: number;
  rateLimited?: boolean;
  trackerAdded?: number;
  applications: GmailApplication[];
  pendingRecovery: number;
  upcomingInterviews?: UpcomingInterview[];
  actionItems?: ActionItem[];
  recovery?: RecoveryStart;
};
