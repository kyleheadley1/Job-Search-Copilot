import request from "supertest";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { GmailAuthDoc } from "../../services/gmail/gmailAuth.js";
import type { ParsedEmail } from "../../services/gmail/gmailClient.js";
import type { StoredGmailMessage } from "../../services/gmail/gmailMessages.repository.js";
import { INTERVIEW_DETAIL_VERSION, type InterviewDetail } from "../../services/gmail/interviewRounds.js";

let authDoc: GmailAuthDoc | null = null;
const messageStore = new Map<string, StoredGmailMessage>();
const inbox = new Map<string, ParsedEmail>();
const runStructuredMock = vi.fn();
const fetchMock = vi.fn();

vi.mock("../../config/mongo.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../config/mongo.js")>();
  const gmailAuthCollection = {
    findOne: async () => (authDoc ? { ...authDoc } : null),
    replaceOne: async (_filter: unknown, doc: GmailAuthDoc) => {
      authDoc = { ...doc };
    },
    updateOne: async (_filter: unknown, update: { $set: Partial<GmailAuthDoc> }) => {
      if (authDoc) authDoc = { ...authDoc, ...update.$set };
    },
    deleteOne: async () => {
      authDoc = null;
    },
  };
  return {
    ...actual,
    getDb: async () => ({ collection: () => gmailAuthCollection }),
  };
});

vi.mock("../../services/gmail/trackerAutoAdd.js", () => ({
  addMissingApplicationsQuietly: vi.fn(async () => 0),
}));
vi.mock("../../services/gmail/trackerAutoLapse.js", () => ({
  syncTrackerFromGmailQuietly: vi.fn(async () => ({ lapsed: 0, revived: 0 })),
}));

vi.mock("../../services/llm/responsesClient.js", () => ({
  responsesClient: { runStructured: (...args: unknown[]) => runStructuredMock(...args) },
}));

vi.mock("../../services/gmail/gmailClient.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../services/gmail/gmailClient.js")>();
  const { gmailAuth } = await import("../../services/gmail/gmailAuth.js");
  return {
    ...actual,
    gmailClient: {
      listMessageIds: vi.fn(async () => {
        await gmailAuth.getAccessToken();
        return [...inbox.keys()];
      }),
      getMessage: vi.fn(async (id: string) => inbox.get(id)!),
    },
  };
});

vi.mock("../../services/gmail/gmailMessages.repository.js", () => ({
  gmailMessagesRepository: {
    findProcessedIds: vi.fn(
      async (ids: string[]) =>
        new Set(ids.filter((id) => messageStore.has(id) && messageStore.get(id)!.llmSucceeded !== false)),
    ),
    upsert: vi.fn(async (m: StoredGmailMessage) => {
      messageStore.set(m.id, m);
    }),
    listApplicationMessagesSince: vi.fn(async (since: string) =>
      [...messageStore.values()].filter(
        (m) => m.date >= since && m.classification?.isApplicationEmail,
      ),
    ),
    listInterviewIdsMissingDetail: vi.fn(async () =>
      [...messageStore.values()]
        .filter(
          (m) =>
            m.classification?.eventType === "interview" &&
            m.classification.interview?.version !== INTERVIEW_DETAIL_VERSION,
        )
        .map((m) => m.id),
    ),
    listIdsMissingAction: vi.fn(async () => []),
    setAction: vi.fn(async () => undefined),
    listOpenActionMessages: vi.fn(async () => []),
    setActionReplied: vi.fn(async () => undefined),
    setInterviewDetail: vi.fn(async (id: string, detail: InterviewDetail) => {
      const m = messageStore.get(id);
      if (m?.classification) m.classification.interview = detail;
    }),
  },
}));

vi.mock("../../services/jobs/jobs.repository.js", () => ({
  jobsRepository: { findAll: vi.fn(async () => []) },
}));

const startRecoveryRunMock = vi.hoisted(() => vi.fn(async () => ({ queued: 0, running: false, started: false })));
vi.mock("../../services/gmail/jdRecovery/runRecovery.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../services/gmail/jdRecovery/runRecovery.js")>()),
  startRecoveryRun: startRecoveryRunMock,
}));

vi.mock("../../services/gmail/jdRecovery/evaluations.repository.js", () => ({
  evaluationsRepository: {
    findByKeys: vi.fn(async () => new Map()),
    findByCompanyKeys: vi.fn(async () => []),
    rekey: vi.fn(),
    listSince: vi.fn(async () => []),
    upsert: vi.fn(),
    updateOutcome: vi.fn(),
  },
}));

vi.stubGlobal("fetch", fetchMock);

import { app } from "../../app.js";
import { env } from "../../config/env.js";
import { gmailAuth } from "../../services/gmail/gmailAuth.js";
import { gmailClient } from "../../services/gmail/gmailClient.js";
import { gmailMessagesRepository } from "../../services/gmail/gmailMessages.repository.js";

const originalEnv = { id: env.googleClientId, secret: env.googleClientSecret };

const tokenOk = () =>
  new Response(JSON.stringify({ access_token: "access-1", expires_in: 3600 }), { status: 200 });
const tokenInvalidGrant = () =>
  new Response(JSON.stringify({ error: "invalid_grant", error_description: "Token has been expired or revoked." }), {
    status: 400,
  });

const recent = (hoursAgo: number) => new Date(Date.now() - hoursAgo * 3600 * 1000).toISOString();

const addEmail = (e: Partial<ParsedEmail> & { id: string }) =>
  inbox.set(e.id, { threadId: `t-${e.id}`, date: recent(24), from: "", subject: "", snippet: "", body: "", links: [], ...e });

describe("gmail routes", () => {
  beforeEach(() => {
    env.googleClientId = "client-id";
    env.googleClientSecret = "client-secret";
    authDoc = { _id: "default", refreshToken: "refresh-1", email: "me@example.com", connectedAt: recent(48) };
    messageStore.clear();
    inbox.clear();
    runStructuredMock.mockReset();
    fetchMock.mockReset();
    fetchMock.mockImplementation(async () => tokenOk());
    vi.mocked(gmailClient.listMessageIds).mockClear();
    vi.mocked(gmailClient.getMessage).mockClear();
    vi.mocked(gmailMessagesRepository.listApplicationMessagesSince).mockClear();
    (gmailAuth as unknown as { accessToken: unknown }).accessToken = null;
  });

  afterAll(() => {
    env.googleClientId = originalEnv.id;
    env.googleClientSecret = originalEnv.secret;
    vi.unstubAllGlobals();
  });

  describe("GET /api/gmail/status", () => {
    it("reports not configured without Google credentials", async () => {
      env.googleClientId = undefined;
      authDoc = null;
      const res = await request(app).get("/api/gmail/status");
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ configured: false, connected: false });
    });

    it("reports configured but not connected", async () => {
      authDoc = null;
      const res = await request(app).get("/api/gmail/status");
      expect(res.body).toMatchObject({ configured: true, connected: false });
    });

    it("reports connected with the account email", async () => {
      const res = await request(app).get("/api/gmail/status");
      expect(res.body).toMatchObject({ configured: true, connected: true, email: "me@example.com" });
    });

    it("reports needsReconnect as disconnected", async () => {
      authDoc = { ...authDoc!, needsReconnect: true };
      const res = await request(app).get("/api/gmail/status");
      expect(res.body).toMatchObject({ connected: false, needsReconnect: true });
    });
  });

  it("redirects oauth/start to Google with read-only + drafts.create offline consent", async () => {
    const res = await request(app).get("/api/gmail/oauth/start");
    expect(res.status).toBe(302);
    const url = new URL(res.headers.location!);
    expect(url.origin).toBe("https://accounts.google.com");
    expect(url.searchParams.get("scope")).toBe(
      "https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.drafts.create",
    );
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("state")).toBeTruthy();
  });

  it("rejects oauth callbacks with an unknown state", async () => {
    const res = await request(app).get("/api/gmail/oauth/callback?code=abc&state=forged");
    expect(res.status).toBe(302);
    expect(res.headers.location).toMatch(/\?gmail=error$/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("syncs the default 7-day window, prefilters, classifies, and aggregates", async () => {
    addEmail({
      id: "a1",
      from: "Acme <no-reply@greenhouse.io>",
      subject: "Thank you for applying to Acme",
      body: "We've received your application for Software Engineer.",
    });
    addEmail({ id: "n1", from: "friend@gmail.com", subject: "Dinner?", body: "Tacos tonight?" });
    runStructuredMock.mockResolvedValue({
      success: true,
      data: { isApplicationEmail: true, company: "Acme", role: "Software Engineer", eventType: "applied", confidence: 0.95 },
    });

    const res = await request(app).post("/api/gmail/sync").send({});
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      days: 7,
      scanned: 2,
      alreadyProcessed: 0,
      prefiltered: 1,
      classified: 1,
      applicationEmails: 1,
      llmFailures: 0,
    });
    expect(vi.mocked(gmailClient.listMessageIds).mock.calls[0]![0]).toMatch(/^newer_than:7d /);
    expect(runStructuredMock).toHaveBeenCalledTimes(1);
    expect(res.body.applications).toHaveLength(1);
    expect(res.body.applications[0]).toMatchObject({ company: "Acme", role: "Software Engineer", status: "applied" });
    expect(messageStore.get("n1")).toMatchObject({ prefilterPassed: false, prefilterReason: "no_application_signal" });
    expect(authDoc?.lastSyncAt).toBeTruthy();

    const since = vi.mocked(gmailMessagesRepository.listApplicationMessagesSince).mock.calls[0]![0];
    const daysBack = (Date.now() - new Date(since).getTime()) / (24 * 3600 * 1000);
    expect(daysBack).toBeCloseTo(7, 1);
  });

  it("skips already-processed messages on re-sync without calling the LLM", async () => {
    addEmail({ id: "a1", from: "no-reply@lever.co", subject: "Application received" });
    messageStore.set("a1", {
      id: "a1",
      threadId: "t-a1",
      date: recent(24),
      from: "no-reply@lever.co",
      subject: "Application received",
      prefilterPassed: true,
      prefilterReason: "ats_sender",
      classification: { isApplicationEmail: true, company: "Bubble", role: "Engineer", eventType: "applied", confidence: 0.9 },
      llmSucceeded: true,
      processedAt: recent(1),
    });

    const res = await request(app).post("/api/gmail/sync").send({ days: 7 });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ scanned: 1, alreadyProcessed: 1, classified: 0 });
    expect(gmailClient.getMessage).not.toHaveBeenCalled();
    expect(runStructuredMock).not.toHaveBeenCalled();
    expect(res.body.applications[0]).toMatchObject({ company: "Bubble" });
    expect(startRecoveryRunMock).toHaveBeenCalledWith(7);
    expect(res.body.recovery).toEqual({ queued: 0, running: false, started: false });
  });

  it("retries messages whose LLM call failed previously", async () => {
    addEmail({ id: "a1", from: "no-reply@lever.co", subject: "Application received" });
    messageStore.set("a1", {
      id: "a1",
      threadId: "t-a1",
      date: recent(24),
      from: "no-reply@lever.co",
      subject: "Application received",
      prefilterPassed: true,
      prefilterReason: "ats_sender",
      classification: { isApplicationEmail: false, company: null, role: null, eventType: "other", confidence: 0 },
      llmSucceeded: false,
      processedAt: recent(1),
    });
    runStructuredMock.mockResolvedValue({
      success: true,
      data: { isApplicationEmail: true, company: "Bubble", role: "Engineer", eventType: "applied" },
    });

    const res = await request(app).post("/api/gmail/sync").send({});
    expect(res.body).toMatchObject({ alreadyProcessed: 0, classified: 1, applicationEmails: 1 });
  });

  it("backfills interview round details for older interview emails of any age", async () => {
    addEmail({ id: "i1", from: "jane@acme.com", subject: "Next round: technical interview" });
    messageStore.set("i1", {
      id: "i1",
      threadId: "t-i1",
      date: "2026-01-05T10:00:00.000Z",
      from: "jane@acme.com",
      subject: "Next round: technical interview",
      prefilterPassed: true,
      prefilterReason: "application_phrase",
      classification: { isApplicationEmail: true, company: "Acme", role: "Engineer", eventType: "interview", confidence: 0.9 },
      llmSucceeded: true,
      processedAt: recent(1),
    });
    runStructuredMock.mockResolvedValue({
      success: true,
      data: { roundNumber: 2, kind: "technical", interviewers: "Sam Lee", advancesToNextRound: true, scheduledAt: "not a date" },
    });

    const res = await request(app).post("/api/gmail/sync").send({});
    expect(res.body).toMatchObject({ interviewDetails: 1 });
    expect(messageStore.get("i1")!.classification!.interview).toEqual({
      roundNumber: 2,
      kind: "technical",
      focus: null,
      interviewers: "Sam Lee",
      advancesToNextRound: true,
      scheduledAt: null,
      durationMinutes: null,
      cancelled: false,
      version: INTERVIEW_DETAIL_VERSION,
    });
  });

  it("returns 401 and flags needsReconnect when the refresh token is revoked", async () => {
    fetchMock.mockImplementation(async () => tokenInvalidGrant());
    const res = await request(app).post("/api/gmail/sync").send({});
    expect(res.status).toBe(401);
    expect(res.body.error).toBe("GMAIL_RECONNECT_REQUIRED");
    expect(authDoc?.needsReconnect).toBe(true);

    const status = await request(app).get("/api/gmail/status");
    expect(status.body).toMatchObject({ connected: false, needsReconnect: true });
  });

  it("returns 409 when syncing without a connection", async () => {
    authDoc = null;
    const res = await request(app).post("/api/gmail/sync").send({});
    expect(res.status).toBe(409);
  });

  it("returns 503 when Google credentials are missing", async () => {
    env.googleClientSecret = undefined;
    const res = await request(app).post("/api/gmail/sync").send({});
    expect(res.status).toBe(503);
  });

  it("rejects out-of-range windows", async () => {
    const res = await request(app).get("/api/gmail/applications?days=365");
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });

  it("disconnect revokes and clears stored auth", async () => {
    const res = await request(app).post("/api/gmail/disconnect");
    expect(res.status).toBe(204);
    expect(authDoc).toBeNull();
    expect(String(fetchMock.mock.calls[0]![0])).toContain("oauth2.googleapis.com/revoke");
  });
});
