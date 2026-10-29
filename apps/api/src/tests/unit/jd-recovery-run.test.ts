import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GmailApplication } from "../../services/gmail/gmailApplications.js";
import type { ParsedEmail } from "../../services/gmail/gmailClient.js";
import type { ApplicationEvaluation } from "../../services/gmail/jdRecovery/evaluations.repository.js";
import type { FetchedPosting } from "../../services/gmail/jdRecovery/fetchPosting.js";

const LONG = "Build TypeScript services and React interfaces for our healthcare platform. ".repeat(12);

const state = vi.hoisted(() => ({
  apps: [] as GmailApplication[],
  inbox: new Map<string, ParsedEmail>(),
  postings: new Map<string, FetchedPosting>(),
  serperResults: new Map<string, Array<{ title: string; link: string }>>(),
  evaluations: new Map<string, ApplicationEvaluation>(),
  usage: { jobKeys: [] as string[], queries: 0 },
  cap: 10,
  boards: new Map<string, unknown>(),
  discovered: [] as unknown[],
  prospects: [] as import("../../services/gmail/jdRecovery/jobProspects.repository.js").JobProspect[],
}));

vi.mock("../../services/gmail/jdRecovery/atsBoards.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../services/gmail/jdRecovery/atsBoards.js")>()),
  listBoard: vi.fn(async (ref: { ats: string; slug: string }) => state.boards.get(`${ref.ats}:${ref.slug}`) ?? null),
  discoverBoards: vi.fn(async () => state.discovered),
  atsBoardsRepository: { get: vi.fn(async () => null), put: vi.fn(async () => undefined) },
}));

vi.mock("../../services/gmail/trackerAutoAdd.js", () => ({
  addMissingApplicationsQuietly: vi.fn(async () => 0),
}));

vi.mock("../../services/gmail/gmailApplications.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../services/gmail/gmailApplications.js")>()),
  getGmailApplications: vi.fn(async () => state.apps),
}));

vi.mock("../../services/gmail/gmailClient.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../services/gmail/gmailClient.js")>()),
  gmailClient: {
    listMessageIds: vi.fn(),
    getMessage: vi.fn(async (id: string) => {
      const email = state.inbox.get(id);
      if (!email) throw new Error(`no email ${id}`);
      return email;
    }),
  },
}));

vi.mock("../../services/gmail/jdRecovery/fetchPosting.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../services/gmail/jdRecovery/fetchPosting.js")>();
  return {
    ...actual,
    fetchPosting: vi.fn(async (url: string) => {
      const p = state.postings.get(url);
      if (!p) throw new actual.PostingFetchError("not_found", `404 ${url}`);
      return p;
    }),
  };
});

vi.mock("../../services/gmail/jdRecovery/serperClient.js", () => ({
  serperClient: {
    isConfigured: vi.fn(() => true),
    search: vi.fn(async (q: string) => state.serperResults.get(q) ?? []),
  },
  serperUsageRepository: {
    get: vi.fn(async () => ({ jobKeys: [...state.usage.jobKeys], queries: state.usage.queries, cap: state.cap })),
    record: vi.fn(async (key: string, queries: number) => {
      if (!state.usage.jobKeys.includes(key)) state.usage.jobKeys.push(key);
      state.usage.queries += queries;
    }),
  },
}));

vi.mock("../../services/gmail/jdRecovery/evaluations.repository.js", () => ({
  evaluationsRepository: {
    findByKey: vi.fn(async (key: string) => {
      const e = state.evaluations.get(key);
      return e ? structuredClone(e) : null;
    }),
    findByKeys: vi.fn(async (keys: string[]) => {
      const out = new Map<string, ApplicationEvaluation>();
      for (const k of keys) {
        const e = state.evaluations.get(k);
        if (e) out.set(k, structuredClone(e));
      }
      return out;
    }),
    upsert: vi.fn(async (e: ApplicationEvaluation) => {
      state.evaluations.set(e.key, structuredClone(e));
    }),
    upsertIfUnscored: vi.fn(async (e: ApplicationEvaluation) => {
      const cur = state.evaluations.get(e.key);
      if (cur?.recovery.status === "scored") return structuredClone(cur);
      state.evaluations.set(e.key, structuredClone(e));
      return structuredClone(e);
    }),
    setDiagnostic: vi.fn(async (key: string, diagnostic: ApplicationEvaluation["diagnostic"]) => {
      const e = state.evaluations.get(key);
      if (e) e.diagnostic = diagnostic;
    }),
    findByCompanyKeys: vi.fn(async (companyKeys: string[]) =>
      [...state.evaluations.values()]
        .filter((e) => companyKeys.some((c) => e.key.startsWith(`${c}::`)))
        .map((e) => structuredClone(e)),
    ),
    rekey: vi.fn(async (oldKey: string, e: ApplicationEvaluation) => {
      state.evaluations.delete(oldKey);
      state.evaluations.set(e.key, structuredClone(e));
    }),
    updateOutcome: vi.fn(async (key: string, outcome: ApplicationEvaluation["outcome"]) => {
      const e = state.evaluations.get(key);
      if (e) e.outcome = outcome;
    }),
    listSince: vi.fn(async () => [...state.evaluations.values()]),
  },
}));

vi.mock("../../services/gmail/jdRecovery/jobProspects.repository.js", () => ({
  jobProspectsRepository: {
    findOpen: vi.fn(async () => state.prospects.filter((p) => p.status === "open").map((p) => structuredClone(p))),
    findOpenByCompanyKey: vi.fn(async (companyKey: string) =>
      state.prospects.filter((p) => p.status === "open" && p.companyKey === companyKey).map((p) => structuredClone(p)),
    ),
    markAttached: vi.fn(async (id: string, key: string) => {
      const prospect = state.prospects.find((p) => p.id === id);
      if (!prospect) return null;
      if (prospect.status === "attached" && prospect.attachedKey !== key) return null;
      prospect.status = "attached";
      prospect.attachedKey = key;
      prospect.updatedAt = new Date().toISOString();
      return structuredClone(prospect);
    }),
  },
}));

vi.mock("../../agents/jobAgent/orchestrator.js", () => ({
  triageJob: vi.fn(async () => ({
    score: { total: 78 },
    recommendation: "stretch",
    recommendedResume: "BASE",
    rules: { notes: [], seniorityOverreach: true },
    extracted: { title: "Software Engineer", rawText: "full JD text" },
  })),
}));

import { triageJob } from "../../agents/jobAgent/orchestrator.js";
import { addMissingApplicationsQuietly } from "../../services/gmail/trackerAutoAdd.js";
import { gmailClient } from "../../services/gmail/gmailClient.js";
import { discoverBoards, listBoard, type BoardListing } from "../../services/gmail/jdRecovery/atsBoards.js";
import { serperClient, serperUsageRepository } from "../../services/gmail/jdRecovery/serperClient.js";
import { computeJdTextHash } from "../../lib/jdTextHash.js";
import { normalizeCompany } from "../../services/gmail/gmailApplications.js";
import { evaluationsRepository } from "../../services/gmail/jdRecovery/evaluations.repository.js";
import type { JobProspect } from "../../services/gmail/jdRecovery/jobProspects.repository.js";
import {
  AlreadyScoredError,
  ATS_SITE_FILTER,
  buildSerperQueries,
  confirmCandidate,
  EvaluationNotFoundError,
  IncompleteJdError,
  InvalidTitleError,
  scorePastedJd,
  updateApplicationTitle,
  updateApplicationTitleFromJdText,
  RECOVERY_VERSION,
  rankSerperResults,
  recoverApplication,
  resetRecoveryRunStateForTests,
  runRecovery,
  runScoringDiagnostic,
  startRecoveryRun,
  getRecoveryRunState,
} from "../../services/gmail/jdRecovery/runRecovery.js";
import { buildRubricSummary, withEvaluations } from "../../services/gmail/jdRecovery/summary.js";

const day = (n: number) => new Date(Date.UTC(2026, 8, n)).toISOString();

const addApp = (opts: {
  key: string;
  company: string;
  role: string | null;
  appliedDay: number;
  status?: GmailApplication["status"];
  subject?: string;
  body?: string;
  links?: string[];
  from?: string;
}): GmailApplication => {
  const emailId = `e-${opts.key}`;
  state.inbox.set(emailId, {
    id: emailId,
    threadId: `t-${opts.key}`,
    date: day(opts.appliedDay),
    from: opts.from ?? `jobs@${opts.company.toLowerCase().replace(/\W/g, "")}.com`,
    subject: opts.subject ?? `Thanks for applying to ${opts.company}`,
    snippet: "",
    body: opts.body ?? "We received your application.",
    links: opts.links ?? [],
  });
  const app: GmailApplication = {
    key: opts.key,
    company: opts.company,
    role: opts.role,
    appliedAt: day(opts.appliedDay),
    appliedAtKnown: opts.status !== "rejected",
    appliedAtSource: opts.status !== "rejected" ? "email" : "estimated",
    status: opts.status ?? "applied",
    furthestStage: "applied",
    interviewRounds: [],
    activelyInterviewing: false,
    lastUpdateAt: day(opts.appliedDay),
    emails: [
      {
        id: emailId,
        subject: opts.subject ?? "",
        from: "",
        date: day(opts.appliedDay),
        eventType: opts.status === "rejected" ? "rejected" : "applied",
        gmailUrl: "",
      },
    ],
  };
  state.apps.push(app);
  return app;
};

const addPosting = (url: string, over: Partial<FetchedPosting> = {}) =>
  state.postings.set(url, { url, source: "greenhouse", text: LONG, ...over });

const addProspect = (over: Partial<JobProspect> & Pick<JobProspect, "company" | "title">): JobProspect => {
  const now = "2026-10-01T00:00:00.000Z";
  const cleanedText = over.cleanedText ?? LONG;
  const prospect: JobProspect = {
    id: over.id ?? `p-${state.prospects.length + 1}`,
    companyKey: over.companyKey ?? normalizeCompany(over.company),
    rawText: over.rawText ?? cleanedText,
    cleanedText,
    cleanedTextHash: over.cleanedTextHash ?? computeJdTextHash(cleanedText),
    status: over.status ?? "open",
    createdAt: over.createdAt ?? now,
    updatedAt: over.updatedAt ?? now,
    ...over,
  };
  state.prospects.push(prospect);
  return prospect;
};

const usage = () => ({ jobKeys: [...state.usage.jobKeys], queries: state.usage.queries, cap: state.cap });

beforeEach(() => {
  state.apps = [];
  state.inbox.clear();
  state.postings.clear();
  state.serperResults.clear();
  state.evaluations.clear();
  state.usage = { jobKeys: [], queries: 0 };
  state.cap = 10;
  state.boards.clear();
  state.discovered = [];
  state.prospects = [];
  resetRecoveryRunStateForTests();
  vi.mocked(listBoard).mockClear();
  vi.mocked(discoverBoards).mockClear();
  vi.mocked(triageJob).mockClear();
  vi.mocked(serperClient.search).mockClear();
  vi.mocked(gmailClient.getMessage).mockImplementation(async (id: string) => {
    const email = state.inbox.get(id);
    if (!email) throw new Error(`no email ${id}`);
    return email;
  });
  vi.mocked(serperClient.isConfigured).mockReturnValue(true);
  vi.mocked(serperUsageRepository.record).mockClear();
  vi.mocked(evaluationsRepository.updateOutcome).mockClear();
});

describe("JD recovery runner", () => {
  it("scores from a verified email link without calling Serper, blind to email and outcome", async () => {
    const url = "https://boards.greenhouse.io/acme/jobs/4567890";
    addApp({ key: "acme::se", company: "Acme", role: "Software Engineer", appliedDay: 20, status: "rejected", links: [url] });
    addPosting(url, { company: "Acme", title: "Software Engineer" });

    await runRecovery(30, 5);

    expect(serperClient.search).not.toHaveBeenCalled();
    expect(triageJob).toHaveBeenCalledTimes(1);
    const input = vi.mocked(triageJob).mock.calls[0]![0];
    expect(Object.keys(input).sort()).toEqual(["companyHint", "fullPrep", "rawText"]);
    expect(input.rawText).toBe(LONG);
    expect(JSON.stringify(input)).not.toMatch(/rejected|Thanks for applying|received your application/i);

    const e = state.evaluations.get("acme::se")!;
    expect(e.recovery).toMatchObject({ status: "scored", source: "email_link", url, match: { level: "high" } });
    expect(e.fit).toMatchObject({ total: 78, recommendedResume: "BASE" });
    expect(e.fit?.detail?.rules).toMatchObject({ seniorityOverreach: true });
    expect(e.fit?.detail?.extracted).toEqual({ title: "Software Engineer" });
    expect(e.outcomeAtScoring).toBe("rejected");
    expect(e.jd?.textHash).toBeTruthy();
  });

  it("runs a scoring diagnostic on the stored JD without touching the original score", async () => {
    addApp({ key: "acme::se", company: "Acme", role: "Software Engineer", appliedDay: 20 });
    state.evaluations.set("acme::se", {
      key: "acme::se",
      company: "Acme",
      role: "Software Engineer",
      appliedAt: day(20),
      recovery: { status: "scored", attempts: [], serperQueries: 0 },
      jd: { text: LONG, textHash: "h" },
      fit: { total: 25, recommendation: "weak", recommendedResume: "BASE", scoredAt: day(19), promptVersion: "v1" },
      outcome: { status: "applied", updatedAt: day(20), history: [] },
      createdAt: day(19),
      updatedAt: day(19),
    });

    const result = await runScoringDiagnostic("acme::se");

    expect(vi.mocked(triageJob).mock.calls[0]![0]).toEqual({ rawText: LONG, companyHint: "Acme", fullPrep: false });
    expect(result.fit?.total).toBe(25);
    expect(result.diagnostic).toMatchObject({ total: 78, detail: { rules: { seniorityOverreach: true } } });
    expect(state.evaluations.get("acme::se")!.fit?.total).toBe(25);
  });

  it("falls back to Serper with the req ID and scores only an exact match", async () => {
    addApp({
      key: "uhg::ase",
      company: "UnitedHealth Group",
      role: "Associate Software Engineer",
      appliedDay: 21,
      subject: "Associate Software Engineer (2389186)",
    });
    const hit = "https://uhg.wd1.myworkdayjobs.com/External/job/MN/Associate-Software-Engineer_2389186";
    state.serperResults.set('"2389186" UnitedHealth Group', [
      { title: "Indeed", link: "https://www.indeed.com/viewjob?jk=1" },
      { title: "UHG", link: hit },
    ]);
    addPosting(hit, { source: "workday", company: "UnitedHealth Group", title: "Associate Software Engineer", requisitionId: "2389186" });

    await runRecovery(30, 5);

    expect(serperClient.search).toHaveBeenCalledTimes(1);
    const e = state.evaluations.get("uhg::ase")!;
    expect(e.requisitionId).toBe("2389186");
    expect(e.recovery).toMatchObject({ status: "scored", source: "serper", match: { level: "exact" } });
    expect(state.usage.jobKeys).toEqual(["uhg::ase"]);
  });

  it("stores a low-confidence Serper result as unverified with no fit", async () => {
    addApp({ key: "acme::be", company: "Acme", role: "Backend Engineer", appliedDay: 22 });
    const hit = "https://jobs.lever.co/acme/xyz-1";
    state.serperResults.set(`"Acme" "Backend Engineer" ${ATS_SITE_FILTER}`, [{ title: "Acme", link: hit }]);
    addPosting(hit, { source: "lever", company: "Acme", title: "Backend Engineer" });

    await runRecovery(30, 5);

    const e = state.evaluations.get("acme::be")!;
    expect(e.recovery.status).toBe("unverified");
    expect(e.recovery.url).toBe(hit);
    expect(e.fit).toBeUndefined();
    expect(triageJob).not.toHaveBeenCalled();
    expect(vi.mocked(serperClient.search).mock.calls.length).toBeLessThanOrEqual(2);
  });

  it("spends the Serper query budget on the most recent jobs first, across runs", async () => {
    for (let i = 1; i <= 12; i += 1) {
      addApp({ key: `co${i}::se`, company: `Company${i}`, role: "Software Engineer", appliedDay: i });
    }

    await runRecovery(30, 50);

    const capped = [...state.evaluations.values()].filter((e) => e.recovery.reason === "serper_cap_reached");
    expect(capped.map((e) => e.key).sort()).toEqual(["co1::se", "co2::se"]);
    expect(state.usage.queries).toBe(10);
    expect(state.usage.jobKeys).not.toContain("co1::se");

    const again = await recoverApplication(state.apps.find((a) => a.key === "co12::se")!, await serperUsageRepository.get());
    expect(again.evaluation.recovery).toMatchObject({ reason: "serper_cap_reached", serperQueries: 0 });
    expect(state.usage.queries).toBe(10);
  });

  it("records not_found without Serper when no key is configured", async () => {
    vi.mocked(serperClient.isConfigured).mockReturnValue(false);
    addApp({ key: "acme::se", company: "Acme", role: "Software Engineer", appliedDay: 10 });
    await runRecovery(30, 5);
    const r = state.evaluations.get("acme::se")!.recovery;
    expect(r.status).toBe("not_found");
    expect(r.notes).toEqual(expect.arrayContaining(["no_board_found", "serper_not_configured"]));
    expect(serperClient.search).not.toHaveBeenCalled();
  });

  it("refreshes the outcome without re-scoring", async () => {
    const url = "https://boards.greenhouse.io/acme/jobs/1";
    const app = addApp({ key: "acme::se", company: "Acme", role: "Software Engineer", appliedDay: 10, links: [url] });
    addPosting(url, { company: "Acme", title: "Software Engineer" });
    await runRecovery(30, 5);
    expect(triageJob).toHaveBeenCalledTimes(1);

    app.status = "rejected";
    app.lastUpdateAt = day(15);
    app.emails.unshift({ id: "r", subject: "", from: "", date: day(15), eventType: "rejected", gmailUrl: "" });
    await runRecovery(30, 5);

    expect(triageJob).toHaveBeenCalledTimes(1);
    expect(evaluationsRepository.updateOutcome).toHaveBeenCalledTimes(1);
    const e = state.evaluations.get("acme::se")!;
    expect(e.outcome.status).toBe("rejected");
    expect(e.outcome.history.map((h) => h.status)).toEqual(["applied", "rejected"]);
    expect(e.outcomeAtScoring).toBe("applied");
    expect(e.fit?.total).toBe(78);
  });

  it("processes newest applications first and respects the per-run triage cap", async () => {
    for (const d of [5, 25, 15]) {
      const url = `https://boards.greenhouse.io/co${d}/jobs/${d}000`;
      addApp({ key: `co${d}::se`, company: `Company${d}`, role: "Software Engineer", appliedDay: d, links: [url] });
      addPosting(url, { company: `Company${d}`, title: "Software Engineer" });
    }

    const r = await runRecovery(30, 2);

    expect(r).toEqual({ processed: 2, scored: 2 });
    expect([...state.evaluations.keys()].sort()).toEqual(["co15::se", "co25::se"]);
  });

  const listing = (
    ats: BoardListing["ref"]["ats"],
    slug: string,
    jobs: Array<{ id: string; title: string; requisitionId?: string; location?: string; text?: string }>,
    companyName?: string,
  ): BoardListing => ({
    ref: { ats, slug },
    companyName,
    jobs: jobs.map((j) => ({
      ...j,
      url: `https://boards.greenhouse.io/${slug}/jobs/${j.id}`,
      text: j.text ?? `${j.title}\n${LONG}`,
    })),
  });

  const VARIED = Array.from(
    { length: 120 },
    (_, i) => `Responsibility ${i}: ship feature area ${i} with the team and measure outcome ${i * 7}.`,
  ).join(" ");
  const OTHER = "Own the data warehouse, dbt models, and Airflow pipelines for analytics teams. ".repeat(12);

  it("scores a unique title on a guessed company board before trying Serper", async () => {
    addApp({ key: "ell::se", company: "Ellipsis Labs", role: "Software Engineer - 2027 New Grads", appliedDay: 28 });
    state.discovered = [
      listing("greenhouse", "ellipsislabs", [
        { id: "1", title: "Software Engineer, 2027 New Grads" },
        { id: "2", title: "Account Executive" },
      ]),
    ];

    await runRecovery(30, 5);

    expect(serperClient.search).not.toHaveBeenCalled();
    const e = state.evaluations.get("ell::se")!;
    expect(e.recovery).toMatchObject({ status: "scored", source: "ats_board", match: { level: "high" } });
    expect(e.recoveryVersion).toBe(RECOVERY_VERSION);
    expect(triageJob).toHaveBeenCalledTimes(1);
  });

  it("leaves it unverified when several open jobs share the title", async () => {
    vi.mocked(serperClient.isConfigured).mockReturnValue(false);
    addApp({ key: "pal::se", company: "Palantir", role: "Software Engineer", appliedDay: 28 });
    state.discovered = [
      listing("lever", "palantir", [
        { id: "1", title: "Software Engineer", text: `Software Engineer\n${LONG}` },
        { id: "2", title: "Software Engineer", text: `Software Engineer\n${OTHER}` },
      ]),
    ];

    await runRecovery(30, 5);

    const e = state.evaluations.get("pal::se")!;
    expect(e.recovery.status).toBe("unverified");
    expect(e.recovery.reason).toBe("multiple_title_matches");
    expect(e.recovery.candidates?.map((c) => c.url)).toHaveLength(2);
    expect(e.fit).toBeUndefined();
    expect(triageJob).not.toHaveBeenCalled();
    expect(serperClient.search).not.toHaveBeenCalled();
    expect(e.recovery.notes).toContain("board_found_no_search");
    expect(e.recovery.foundVia).toBe("guessed_board");
  });

  it("treats the same JD posted once per city as one posting", async () => {
    addApp({ key: "safe::fs", company: "SafeLease", role: "Full Stack Software Engineer", appliedDay: 28 });
    state.discovered = [
      listing("ashby", "safelease", [
        { id: "1", title: "Full Stack Software Engineer", location: "Austin, TX", text: `Austin, TX\n${VARIED}` },
        { id: "2", title: "Software Engineer, Full Stack", location: "New York, NY", text: `New York, NY\n${VARIED}` },
      ]),
    ];

    await runRecovery(30, 5);

    const e = state.evaluations.get("safe::fs")!;
    expect(e.recovery).toMatchObject({ status: "scored", match: { level: "high" } });
    expect(e.recovery.match?.signals).toContain("duplicate_postings:2");
  });

  it("does not let a broader title match a generic role (strict title similarity)", async () => {
    vi.mocked(serperClient.isConfigured).mockReturnValue(false);
    addApp({ key: "jamf::se1", company: "Jamf", role: "Software Engineer I", appliedDay: 28 });
    state.discovered = [
      listing("greenhouse", "jamf", [
        { id: "1", title: "Software Engineer I" },
        { id: "2", title: "Software Engineer II", text: `Software Engineer II\n${OTHER}` },
        { id: "3", title: "Senior Software Engineer, Platform", text: `Senior\n${OTHER}` },
      ]),
    ];

    await runRecovery(30, 5);

    const e = state.evaluations.get("jamf::se1")!;
    expect(e.recovery).toMatchObject({ status: "scored", url: "https://boards.greenhouse.io/jamf/jobs/1" });
  });

  it("breaks a title tie using the location named in the email", async () => {
    addApp({
      key: "ramp::fe",
      company: "Ramp",
      role: "Software Engineer, Frontend",
      appliedDay: 28,
      body: "Thanks for applying to Software Engineer, Frontend in New York, NY.",
    });
    state.discovered = [
      listing("ashby", "ramp", [
        { id: "1", title: "Software Engineer, Frontend", location: "San Francisco, CA", text: `SF\n${OTHER}` },
        { id: "2", title: "Software Engineer, Frontend", location: "New York, NY" },
      ]),
    ];

    await runRecovery(30, 5);

    const e = state.evaluations.get("ramp::fe")!;
    expect(e.recovery).toMatchObject({ status: "scored", url: "https://boards.greenhouse.io/ramp/jobs/2" });
    expect(e.recovery.match?.signals).toContain("email_location_match");
  });

  it("recovers a missing role from a board title that appears in the email", async () => {
    addApp({
      key: "bevel::",
      company: "Bevel",
      role: null,
      appliedDay: 28,
      subject: "Thanks for applying to Bevel",
      body: "We received your application for the Founding Full Stack Engineer role.",
    });
    state.discovered = [
      listing("ashby", "bevel", [
        { id: "1", title: "Founding Full Stack Engineer" },
        { id: "2", title: "Product Designer", text: `Designer\n${OTHER}` },
      ]),
    ];

    await runRecovery(30, 5);

    const e = state.evaluations.get("bevel::")!;
    expect(e.recovery.recoveredRole).toBe("Founding Full Stack Engineer");
    expect(e.recovery).toMatchObject({ status: "scored", match: { level: "high" } });
    expect(e.recovery.match?.signals).toContain("role_from_email");
  });

  it("uses a Workday board named by a login link in the email and searches by req ID", async () => {
    addApp({
      key: "uhg::ase",
      company: "UnitedHealth Group",
      role: "Associate Software Engineer",
      appliedDay: 29,
      subject: "Associate Software Engineer (2389186)",
      links: ["https://uhg.wd1.myworkdayjobs.com/en-US/External/login"],
    });
    state.boards.set("workday:uhg/External", {
      ref: { ats: "workday", slug: "uhg/External" },
      jobs: [
        {
          id: "/job/MN/Associate-Software-Engineer_2389186",
          title: "Associate Software Engineer",
          url: "https://uhg.wd1.myworkdayjobs.com/External/job/MN/Associate-Software-Engineer_2389186",
          requisitionId: "2389186",
          text: `Associate Software Engineer\nRequisition 2389186\n${LONG}`,
        },
      ],
    });

    await runRecovery(30, 5);

    expect(vi.mocked(listBoard).mock.calls[0]).toEqual([
      expect.objectContaining({ ats: "workday", slug: "uhg/External" }),
      "2389186",
    ]);
    expect(discoverBoards).not.toHaveBeenCalled();
    expect(serperClient.search).not.toHaveBeenCalled();
    expect(state.evaluations.get("uhg::ase")!.recovery).toMatchObject({ status: "scored", match: { level: "exact" } });
  });

  it("feeds a Serper hit into the board search, guarded by the board's company name", async () => {
    addApp({ key: "tele::se", company: "Teleskope", role: "Software Engineer", appliedDay: 27 });
    const hit = "https://job-boards.greenhouse.io/teleskope/jobs/77";
    state.serperResults.set(`"Teleskope" "Software Engineer" ${ATS_SITE_FILTER}`, [{ title: "", link: hit }]);
    state.boards.set("greenhouse:teleskope", listing("greenhouse", "teleskope", [{ id: "77", title: "Software Engineer" }], "Teleskope"));

    await runRecovery(30, 5);

    expect(discoverBoards).toHaveBeenCalled();
    expect(state.evaluations.get("tele::se")!.recovery).toMatchObject({
      status: "scored",
      source: "ats_board",
      match: { level: "high" },
    });
  });

  it("ignores a Serper-found board whose company name doesn't match", async () => {
    addApp({ key: "her::se", company: "Herald", role: "Software Engineer", appliedDay: 27 });
    const hit = "https://job-boards.greenhouse.io/heraldnews/jobs/5";
    state.serperResults.set(`"Herald" "Software Engineer" ${ATS_SITE_FILTER}`, [{ title: "", link: hit }]);
    state.boards.set("greenhouse:heraldnews", listing("greenhouse", "heraldnews", [{ id: "5", title: "Software Engineer" }], "Herald News Corp"));

    await runRecovery(30, 5);

    expect(state.evaluations.get("her::se")!.recovery.status).not.toBe("scored");
    expect(triageJob).not.toHaveBeenCalled();
  });

  it("records email_links_failed when the email's posting links don't load", async () => {
    vi.mocked(serperClient.isConfigured).mockReturnValue(false);
    addApp({
      key: "kgs::jse",
      company: "KGS Technology Group",
      role: "Junior Software Engineer",
      appliedDay: 26,
      links: ["https://www.linkedin.com/jobs/view/3912345678"],
    });

    await runRecovery(30, 5);

    const r = state.evaluations.get("kgs::jse")!.recovery;
    expect(r).toMatchObject({ status: "fetch_failed", reason: "email_links_failed" });
    expect(r.attempts[0]).toMatchObject({ url: "https://www.linkedin.com/jobs/view/3912345678", ok: false });
  });

  it("retries unscored rows from an older pipeline version but never re-scores scored ones", async () => {
    vi.mocked(serperClient.isConfigured).mockReturnValue(false);
    const old = (key: string, status: "not_found" | "scored") =>
      ({
        key,
        company: key,
        role: "Software Engineer",
        appliedAt: day(10),
        recovery: { status, reason: "serper_not_configured", attempts: [], serperQueries: 0 },
        outcome: { status: "applied", updatedAt: day(10), history: [] },
        createdAt: day(10),
        updatedAt: new Date().toISOString(),
      }) as ApplicationEvaluation;
    addApp({ key: "a::se", company: "Alpha", role: "Software Engineer", appliedDay: 10 });
    addApp({ key: "b::se", company: "Beta", role: "Software Engineer", appliedDay: 10 });
    state.evaluations.set("a::se", old("a::se", "not_found"));
    state.evaluations.set("b::se", old("b::se", "scored"));

    const r = await runRecovery(30, 5);

    expect(r.processed).toBe(1);
    expect(state.evaluations.get("a::se")!.recoveryVersion).toBe(RECOVERY_VERSION);
    expect(state.evaluations.get("b::se")!.recoveryVersion).toBeUndefined();
  });

  it("scores a candidate the user picks, blind, and marks it user-verified", async () => {
    vi.mocked(serperClient.isConfigured).mockReturnValue(false);
    addApp({ key: "pal::se", company: "Palantir", role: "Software Engineer", appliedDay: 28, status: "rejected" });
    state.discovered = [
      listing("lever", "palantir", [
        { id: "1", title: "Software Engineer", text: `Software Engineer\n${LONG}` },
        { id: "2", title: "Software Engineer", text: `Software Engineer\n${OTHER}` },
      ]),
    ];
    await runRecovery(30, 5);
    const url = state.evaluations.get("pal::se")!.recovery.candidates![1]!.url;
    vi.mocked(addMissingApplicationsQuietly).mockClear();

    const e = await confirmCandidate("pal::se", url);

    expect(e.recovery).toMatchObject({ status: "scored", verifiedBy: "user", source: "manual", url });
    expect(e.recovery.candidates).toBeUndefined();
    expect(e.fit?.total).toBe(78);
    const input = vi.mocked(triageJob).mock.calls.at(-1)![0];
    expect(Object.keys(input).sort()).toEqual(["companyHint", "fullPrep", "rawText"]);
    expect(JSON.stringify(input)).not.toMatch(/rejected/i);
    expect(addMissingApplicationsQuietly).toHaveBeenCalledTimes(1);
    vi.mocked(addMissingApplicationsQuietly).mockClear();
    await expect(confirmCandidate("pal::se", url)).rejects.toBeInstanceOf(EvaluationNotFoundError);
    expect(addMissingApplicationsQuietly).not.toHaveBeenCalled();
    expect(state.evaluations.get("pal::se")!.fit?.total).toBe(78);
    await expect(confirmCandidate("pal::se", "https://nope.example/1")).rejects.toBeInstanceOf(EvaluationNotFoundError);
  });

  it("scores a pasted JD and never lets a later run overwrite it", async () => {
    vi.mocked(serperClient.isConfigured).mockReturnValue(false);
    addApp({ key: "fig::osd", company: "Figma", role: "Open Source Developer", appliedDay: 28 });
    await runRecovery(30, 5);
    expect(state.evaluations.get("fig::osd")!.recovery.status).not.toBe("scored");

    const e = await scorePastedJd("fig::osd", LONG, "https://figma.com/careers/1");
    expect(e.recovery).toMatchObject({ status: "scored", verifiedBy: "user", match: { signals: ["user_pasted_jd"] } });
    expect(e.role).toBe("Open Source Developer");
    expect(e.jd?.title).toBe("Software Engineer");

    vi.mocked(triageJob).mockClear();
    await runRecovery(30, 5);
    expect(triageJob).not.toHaveBeenCalled();
    expect(state.evaluations.get("fig::osd")!.recovery.verifiedBy).toBe("user");

    await expect(scorePastedJd("fig::osd", LONG)).rejects.toBeInstanceOf(AlreadyScoredError);
    expect(triageJob).not.toHaveBeenCalled();
  });

  it("carries a score over when the application key changes, without re-scoring", async () => {
    vi.mocked(serperClient.isConfigured).mockReturnValue(false);
    addApp({ key: "fig::", company: "Figma", role: null, appliedDay: 28 });
    await runRecovery(30, 5);
    await scorePastedJd("fig::", LONG);
    const scoredFit = state.evaluations.get("fig::")!.fit!.total;

    state.apps.length = 0;
    addApp({ key: "fig::open source developer", company: "Figma", role: "Open Source Developer", appliedDay: 28, status: "rejected" });
    vi.mocked(triageJob).mockClear();
    await runRecovery(30, 5);

    expect(triageJob).not.toHaveBeenCalled();
    expect(state.evaluations.has("fig::")).toBe(false);
    const moved = state.evaluations.get("fig::open source developer")!;
    expect(moved.fit!.total).toBe(scoredFit);
    expect(moved.outcome.status).toBe("rejected");
  });

  it("takes the extracted title from a pasted JD when the email never named the role", async () => {
    vi.mocked(serperClient.isConfigured).mockReturnValue(false);
    addApp({ key: "lum::", company: "Lumos", role: null, appliedDay: 28 });
    await runRecovery(30, 5);
    const e = await scorePastedJd("lum::", LONG);
    expect(e.role).toBe("Software Engineer");
    expect(e.jd?.title).toBe("Software Engineer");
    const [row] = withEvaluations(state.apps, new Map([[e.key, e]]));
    expect(row!.role).toBe("Software Engineer");
    expect(row!.evaluation?.jdTitle).toBe("Software Engineer");
  });

  it("fills a missing role from a stored extraction when the email still has none", () => {
    const app = {
      key: "asm::",
      company: "Assembled",
      role: null,
      appliedAt: day(28),
      appliedAtKnown: true,
      appliedAtSource: "email",
      status: "applied",
      furthestStage: "applied",
      interviewRounds: [],
      activelyInterviewing: false,
      lastUpdateAt: day(28),
      emails: [],
    } as GmailApplication;
    const evaluation = {
      key: "asm::",
      company: "Assembled",
      role: null,
      appliedAt: day(28),
      recovery: { status: "scored", attempts: [], serperQueries: 0, verifiedBy: "user" },
      jd: { text: LONG, textHash: "x" },
      fit: { total: 72, detail: { extracted: { title: "Customer Engineer" } } },
      outcome: { status: "applied", updatedAt: "", history: [] },
    } as unknown as ApplicationEvaluation;
    const [row] = withEvaluations([app], new Map([["asm::", evaluation]]));
    expect(row!.role).toBe("Customer Engineer");
  });

  it("does not treat an About-the-company heading as the role", () => {
    const app = {
      key: "asm::",
      company: "Assembled",
      role: null,
      appliedAt: day(28),
      appliedAtKnown: true,
      appliedAtSource: "email",
      status: "applied",
      furthestStage: "applied",
      interviewRounds: [],
      activelyInterviewing: false,
      lastUpdateAt: day(28),
      emails: [],
    } as GmailApplication;
    const evaluation = {
      key: "asm::",
      role: "About Assembled",
      jd: { text: LONG, textHash: "x", title: "About Assembled" },
      fit: { total: 72, detail: { extracted: { title: "About Assembled" } } },
      recovery: { status: "scored", attempts: [], serperQueries: 0 },
    } as unknown as ApplicationEvaluation;
    const [row] = withEvaluations([app], new Map([["asm::", evaluation]]));
    expect(row!.role).toBeNull();
  });

  it("updates a scored application's title without changing the fit", async () => {
    vi.mocked(serperClient.isConfigured).mockReturnValue(false);
    addApp({ key: "asm::", company: "Assembled", role: null, appliedDay: 28 });
    await runRecovery(30, 5);
    await scorePastedJd("asm::", LONG);
    const before = state.evaluations.get("asm::")!.fit!.total;
    const e = await updateApplicationTitle("asm::", "Forward Deployed Engineer");
    expect(e.role).toBe("Forward Deployed Engineer");
    expect(e.jd?.title).toBe("Forward Deployed Engineer");
    expect(e.fit?.total).toBe(before);
    expect(e.fit?.detail?.extracted.title).toBe("Forward Deployed Engineer");
  });

  it("extracts a title from a pasted JD without re-scoring", async () => {
    vi.mocked(serperClient.isConfigured).mockReturnValue(false);
    addApp({ key: "asm2::", company: "Assembled", role: null, appliedDay: 28 });
    await runRecovery(30, 5);
    await scorePastedJd("asm2::", LONG);
    vi.mocked(triageJob).mockClear();
    const jd = `Software Engineer, Platform\nAssembled\nSan Francisco, CA\nAbout Assembled\nWe build customer support software.\n${LONG}`;
    const e = await updateApplicationTitleFromJdText("asm2::", jd);
    expect(e.role).toBe("Software Engineer, Platform");
    expect(e.fit?.total).toBe(78);
    expect(triageJob).not.toHaveBeenCalled();
    await expect(updateApplicationTitleFromJdText("asm2::", "About Assembled\nWe build things. ".repeat(20))).rejects.toBeInstanceOf(
      InvalidTitleError,
    );
  });

  it("does not adopt a sibling evaluation for a different role at the same company", async () => {
    vi.mocked(serperClient.isConfigured).mockReturnValue(false);
    addApp({ key: "fig::designer", company: "Figma", role: "Product Designer", appliedDay: 27 });
    await runRecovery(30, 5);
    await scorePastedJd("fig::designer", LONG);

    state.apps.length = 0;
    addApp({ key: "fig::backend engineer", company: "Figma", role: "Backend Engineer", appliedDay: 28 });
    await runRecovery(30, 5);
    expect(state.evaluations.has("fig::designer")).toBe(true);
    expect(state.evaluations.get("fig::backend engineer")!.recovery.status).not.toBe("scored");
  });

  it("summarizes mean fit by outcome from scored rows only", () => {
    const base = { recovery: { attempts: [], serperQueries: 0 } } as unknown as ApplicationEvaluation;
    const mk = (status: "scored" | "unverified", outcome: "rejected" | "interviewing", total?: number) =>
      ({
        ...base,
        recovery: { ...base.recovery, status },
        fit: total === undefined ? undefined : { total },
        outcome: { status: outcome, updatedAt: "", history: [] },
      }) as unknown as ApplicationEvaluation;
    const s = buildRubricSummary([mk("scored", "rejected", 60), mk("scored", "rejected", 70), mk("scored", "interviewing", 85), mk("unverified", "rejected")]);
    expect(s.rows.find((r) => r.outcome === "rejected")).toEqual({ outcome: "rejected", count: 2, meanFit: 65 });
    expect(s.rows.find((r) => r.outcome === "interviewing")?.meanFit).toBe(85);
    expect(s.byRecoveryStatus).toMatchObject({ scored: 3, unverified: 1 });
    expect(s.points.rejected?.map((p) => p.fit)).toEqual([70, 60]);
    expect(s.userVerified).toBe(0);
  });
});

describe("Prospect matching in recovery", () => {
  it("auto-attaches a unique specific company/role with no URL or requisition ID", async () => {
    vi.mocked(serperClient.isConfigured).mockReturnValue(false);
    addApp({ key: "stripe::billing", company: "Stripe", role: "Staff Software Engineer, Billing Platform", appliedDay: 28 });
    addProspect({ company: "Stripe", title: "Staff Software Engineer, Billing Platform" });

    await runRecovery(30, 5);

    const evaluation = state.evaluations.get("stripe::billing")!;
    expect(evaluation.recovery.status).toBe("scored");
    expect(evaluation.recovery.url).toBeUndefined();
    expect(evaluation.recovery.match?.signals).toContain("prospect_auto_attached");
    expect(evaluation.jd?.text).toBe(LONG);
    expect(state.prospects[0]?.status).toBe("attached");
    expect(state.prospects[0]?.attachedKey).toBe("stripe::billing");
    expect(triageJob).toHaveBeenCalledOnce();
  });

  it("puts generic titles and role-less Gmail applications in review, without fabricating URLs", async () => {
    vi.mocked(serperClient.isConfigured).mockReturnValue(false);
    addApp({ key: "acme::se", company: "Acme", role: "Software Engineer", appliedDay: 28 });
    addApp({ key: "acme::", company: "Acme", role: null, appliedDay: 27 });
    addProspect({ id: "generic", company: "Acme", title: "Software Engineer" });
    addProspect({ id: "platform", company: "Acme", title: "Staff Software Engineer, Platform Runtime" });

    await runRecovery(30, 5);

    const generic = state.evaluations.get("acme::se")!;
    expect(generic.recovery.status).not.toBe("scored");
    expect(generic.recovery.candidates?.some((c) => c.prospectId === "generic" && !c.url)).toBe(true);
    const unroled = state.evaluations.get("acme::")!;
    expect(unroled.recovery.status).not.toBe("scored");
    expect(unroled.recovery.candidates?.every((c) => c.prospectId && !c.url?.startsWith("https://prospect"))).toBe(true);
  });

  it("requires review when seniority differs or two prospects compete", async () => {
    vi.mocked(serperClient.isConfigured).mockReturnValue(false);
    addApp({ key: "fig::ios", company: "Figma", role: "Junior iOS Engineer", appliedDay: 28 });
    addProspect({ id: "senior", company: "Figma", title: "Senior iOS Engineer" });
    addApp({ key: "fig::pay", company: "Figma", role: "Staff Software Engineer, Payments", appliedDay: 27 });
    addProspect({ id: "pay-a", company: "Figma", title: "Staff Software Engineer, Payments" });
    addProspect({ id: "pay-b", company: "Figma", title: "Staff Software Engineer, Payments Platform" });

    await runRecovery(30, 5);

    expect(state.evaluations.get("fig::ios")!.recovery.status).not.toBe("scored");
    expect(state.evaluations.get("fig::ios")!.recovery.candidates?.map((c) => c.prospectId)).toContain("senior");
    expect(state.evaluations.get("fig::pay")!.recovery.status).not.toBe("scored");
    expect(state.evaluations.get("fig::pay")!.recovery.candidates?.map((c) => c.prospectId).sort()).toEqual(["pay-a", "pay-b"]);
  });

  it("attaches a prospect saved after an unscored Gmail application, then confirms without a URL", async () => {
    vi.mocked(serperClient.isConfigured).mockReturnValue(false);
    addApp({ key: "linear::infra", company: "Linear", role: "Staff Software Engineer, Infrastructure", appliedDay: 28 });
    await runRecovery(30, 5);
    expect(state.evaluations.get("linear::infra")!.recovery.status).not.toBe("scored");
    vi.mocked(triageJob).mockClear();

    addProspect({ id: "linear-infra", company: "Linear", title: "Staff Software Engineer, Infrastructure" });
    await runRecovery(30, 5);

    const auto = state.evaluations.get("linear::infra")!;
    expect(auto.recovery.status).toBe("scored");
    expect(auto.recovery.url).toBeUndefined();
    expect(state.prospects[0]?.attachedKey).toBe("linear::infra");

    state.evaluations.set("linear::infra", {
      ...auto,
      recovery: {
        ...auto.recovery,
        status: "unverified",
        candidates: [
          {
            prospectId: "linear-infra",
            source: "prospect",
            stage: "prospect",
            matchLevel: "high",
            title: "Staff Software Engineer, Infrastructure",
            company: "Linear",
            text: LONG,
          },
        ],
      },
      fit: undefined,
    });
    state.prospects[0]!.status = "open";
    state.prospects[0]!.attachedKey = undefined;
    vi.mocked(triageJob).mockClear();

    const confirmed = await confirmCandidate("linear::infra", "linear-infra");
    expect(confirmed.recovery.status).toBe("scored");
    expect(confirmed.recovery.url).toBeUndefined();
    expect(state.prospects[0]?.status).toBe("attached");
  });

  it("leaves the prospect open when scoring fails and never overwrites a later score", async () => {
    vi.mocked(serperClient.isConfigured).mockReturnValue(false);
    addApp({ key: "notion::data", company: "Notion", role: "Staff Data Engineer, Platform", appliedDay: 28 });
    addProspect({ id: "notion-data", company: "Notion", title: "Staff Data Engineer, Platform" });
    vi.mocked(triageJob).mockRejectedValueOnce(new Error("openai down"));

    await runRecovery(30, 5);
    expect(state.evaluations.get("notion::data")!.recovery.status).toBe("fetch_failed");
    expect(state.evaluations.get("notion::data")!.recovery.reason).toMatch(/openai down/);
    expect(state.prospects[0]?.status).toBe("open");

    await runRecovery(30, 5);
    const scored = state.evaluations.get("notion::data")!;
    expect(scored.recovery.status).toBe("scored");
    expect(scored.fit?.total).toBe(78);
    expect(state.prospects[0]?.status).toBe("attached");

    vi.mocked(triageJob).mockClear();
    const again = await recoverApplication(state.apps[0]!, usage());
    expect(again.evaluation.fit?.total).toBe(78);
    expect(triageJob).not.toHaveBeenCalled();
  });
});

describe("Company-scoped recovery", () => {
  it("processes only the scoped company and leaves other pending apps untouched", async () => {
    vi.mocked(serperClient.isConfigured).mockReturnValue(false);
    addApp({ key: "stripe::billing", company: "Stripe", role: "Staff Software Engineer, Billing Platform", appliedDay: 28 });
    addProspect({ company: "Stripe", title: "Staff Software Engineer, Billing Platform" });
    addApp({ key: "acme::runtime", company: "Acme", role: "Staff Software Engineer, Platform Runtime", appliedDay: 27 });
    addProspect({ company: "Acme", title: "Staff Software Engineer, Platform Runtime" });

    const scoped = await runRecovery(30, 5, { companyKey: normalizeCompany("Stripe") });
    expect(scoped.processed).toBe(1);
    expect(state.evaluations.get("stripe::billing")!.recovery.status).toBe("scored");
    expect(state.evaluations.has("acme::runtime")).toBe(false);
    expect(state.prospects.find((p) => p.company === "Acme")?.status).toBe("open");
  });

  it("still processes every pending company when unscoped", async () => {
    vi.mocked(serperClient.isConfigured).mockReturnValue(false);
    addApp({ key: "stripe::billing", company: "Stripe", role: "Staff Software Engineer, Billing Platform", appliedDay: 28 });
    addProspect({ company: "Stripe", title: "Staff Software Engineer, Billing Platform" });
    addApp({ key: "acme::runtime", company: "Acme", role: "Staff Software Engineer, Platform Runtime", appliedDay: 27 });
    addProspect({ company: "Acme", title: "Staff Software Engineer, Platform Runtime" });

    const unscoped = await runRecovery(30, 5);
    expect(unscoped.processed).toBe(2);
    expect(state.evaluations.get("stripe::billing")!.recovery.status).toBe("scored");
    expect(state.evaluations.get("acme::runtime")!.recovery.status).toBe("scored");
  });

  it("runs a company-scoped request after an in-flight recovery finishes", async () => {
    vi.mocked(serperClient.isConfigured).mockReturnValue(false);
    addApp({ key: "stripe::runtime", company: "Stripe", role: "Staff Software Engineer, Platform Runtime", appliedDay: 28 });

    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.mocked(gmailClient.getMessage).mockImplementation(async (id: string) => {
      await held;
      const email = state.inbox.get(id);
      if (!email) throw new Error(`no email ${id}`);
      return email;
    });

    const first = await startRecoveryRun(30);
    expect(first.started).toBe(true);
    await vi.waitFor(() => expect(vi.mocked(gmailClient.getMessage).mock.calls.length).toBeGreaterThan(0));

    addApp({ key: "acme::billing", company: "Acme", role: "Staff Software Engineer, Billing Platform", appliedDay: 27 });
    addProspect({ company: "Acme", title: "Staff Software Engineer, Billing Platform" });
    const second = await startRecoveryRun(30, { companyKey: normalizeCompany("Acme") });
    expect(second.started).toBe(false);
    expect(getRecoveryRunState()).toMatchObject({ running: true, deferred: 1 });

    release();
    await vi.waitFor(() => {
      expect(getRecoveryRunState().running).toBe(false);
      expect(getRecoveryRunState().deferred).toBe(0);
    });

    expect(state.evaluations.get("stripe::runtime")!.recovery.status).not.toBe("scored");
    expect(state.evaluations.get("acme::billing")!.recovery.status).toBe("scored");
    expect(state.prospects[0]?.attachedKey).toBe("acme::billing");
  });
});

describe("Serper helpers", () => {
  it("builds at most two queries, req ID first", () => {
    expect(buildSerperQueries("UnitedHealth Group", "Associate Software Engineer", "2389186")).toEqual([
      '"2389186" UnitedHealth Group',
      `"UnitedHealth Group" "Associate Software Engineer" ${ATS_SITE_FILTER}`,
    ]);
    expect(buildSerperQueries("Acme", null)).toEqual([]);
  });

  it("ranks ATS links first and drops aggregators", () => {
    expect(
      rankSerperResults([
        { title: "", link: "https://www.glassdoor.com/job/123" },
        { title: "", link: "https://acme.com/about" },
        { title: "", link: "https://jobs.lever.co/acme/1" },
      ]),
    ).toEqual(["https://jobs.lever.co/acme/1", "https://acme.com/about"]);
  });
});

describe("MCP submitted candidates", () => {
  const mcpCandidate = (over: Partial<NonNullable<ApplicationEvaluation["recovery"]["candidates"]>[number]>) => ({
    url: "https://www.builtinnyc.com/job/fluxcap/1",
    source: "mcp" as const,
    stage: "mcp" as const,
    matchLevel: "low" as const,
    title: "Forward Deployed Software Engineer",
    company: "Fluxcap",
    text: LONG,
    rawText: LONG,
    completeness: "full" as const,
    sourceType: "aggregator" as const,
    retrievedAt: "2026-10-28T12:00:00.000Z",
    matchEvidence: ["exact company and title"],
    ...over,
  });

  it("refuses to score a partial JD and scores a confirmed full candidate", async () => {
    vi.mocked(serperClient.isConfigured).mockReturnValue(false);
    addApp({ key: "intelligems::fse", company: "Intelligems", role: "Full Stack Engineer", appliedDay: 28 });
    const partialEval: ApplicationEvaluation = {
      key: "intelligems::fse",
      company: "Intelligems",
      role: "Full Stack Engineer",
      appliedAt: day(28),
      recovery: {
        status: "unverified",
        attempts: [],
        serperQueries: 0,
        candidates: [
          mcpCandidate({
            url: "https://www.linkedin.com/jobs/view/1",
            title: "Full Stack Engineer",
            company: "Intelligems",
            completeness: "partial",
            text: "Short aggregator blurb",
          }),
        ],
      },
      outcome: { status: "applied", updatedAt: day(28), history: [] },
      createdAt: day(28),
      updatedAt: day(28),
    };
    state.evaluations.set(partialEval.key, partialEval);

    await expect(confirmCandidate("intelligems::fse", "https://www.linkedin.com/jobs/view/1")).rejects.toBeInstanceOf(
      IncompleteJdError,
    );
    expect(state.evaluations.get("intelligems::fse")!.recovery.status).toBe("unverified");
    expect(triageJob).not.toHaveBeenCalled();

    addApp({ key: "fluxcap::fdse", company: "Fluxcap", role: "Forward Deployed Software Engineer", appliedDay: 28 });
    state.evaluations.set("fluxcap::fdse", {
      ...partialEval,
      key: "fluxcap::fdse",
      company: "Fluxcap",
      role: "Forward Deployed Software Engineer",
      recovery: {
        status: "unverified",
        attempts: [],
        serperQueries: 0,
        candidates: [mcpCandidate({})],
      },
    });
    const scored = await confirmCandidate("fluxcap::fdse", "https://www.builtinnyc.com/job/fluxcap/1");
    expect(scored.recovery.status).toBe("scored");
    expect(scored.fit?.total).toBe(78);
    expect(scored.recovery.foundVia).toBe("mcp");
    expect(scored.recovery.verifiedBy).toBe("user");
    expect(scored.jd?.text).toBe(LONG);

    vi.mocked(triageJob).mockClear();
    state.evaluations.set("fluxcap::fdse", {
      ...scored,
      recovery: { ...scored.recovery, candidates: [mcpCandidate({})] },
    });
    await expect(confirmCandidate("fluxcap::fdse", "https://www.builtinnyc.com/job/fluxcap/1")).rejects.toBeInstanceOf(
      AlreadyScoredError,
    );
    expect(state.evaluations.get("fluxcap::fdse")!.fit?.total).toBe(78);
    expect(triageJob).not.toHaveBeenCalled();
  });

  it("keeps MCP candidates when a later recovery rebuild finds nothing", async () => {
    vi.mocked(serperClient.isConfigured).mockReturnValue(false);
    const app = addApp({
      key: "samsara::software engineer",
      company: "Samsara",
      role: "Software Engineer II",
      appliedDay: 28,
    });
    state.evaluations.set(app.key, {
      key: app.key,
      company: app.company,
      role: app.role,
      appliedAt: app.appliedAt,
      recovery: {
        status: "unverified",
        reason: "board_found_no_search",
        attempts: [],
        serperQueries: 0,
        candidates: [
          mcpCandidate({
            url: "https://www.samsara.com/careers/jobs/backend",
            title: "Software Engineer II, Backend",
            company: "Samsara",
          }),
          mcpCandidate({
            url: "https://www.samsara.com/careers/jobs/frontend",
            title: "Software Engineer II, Frontend",
            company: "Samsara",
          }),
        ],
      },
      outcome: { status: "applied", updatedAt: app.appliedAt, history: [] },
      createdAt: app.appliedAt,
      updatedAt: app.appliedAt,
    });

    const result = await recoverApplication(app, usage());
    expect(result.evaluation.recovery.status).toBe("unverified");
    expect(result.evaluation.recovery.candidates?.map((c) => c.url)).toEqual([
      "https://www.samsara.com/careers/jobs/backend",
      "https://www.samsara.com/careers/jobs/frontend",
    ]);
    expect(result.evaluation.fit).toBeUndefined();
  });
});
