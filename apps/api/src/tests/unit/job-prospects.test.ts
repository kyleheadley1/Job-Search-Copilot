import { beforeEach, describe, expect, it, vi } from "vitest";
import { ZodError } from "zod";
import { computeJdTextHash } from "../../lib/jdTextHash.js";
import { normalizeCompany } from "../../services/gmail/gmailApplications.js";
import { cleanProspectJd } from "../../services/gmail/jdRecovery/cleanProspectJd.js";
import type { JobProspect } from "../../services/gmail/jdRecovery/jobProspects.repository.js";
import {
  isDuplicateOf,
  isSpecificJobUrl,
  matchProspectsToApplication,
  PROSPECT_MATCH_LOOKBACK_DAYS,
} from "../../services/gmail/jdRecovery/prospectMatch.js";
import type { GmailApplication } from "../../services/gmail/gmailApplications.js";
import type { ApplicationEvaluation } from "../../services/gmail/jdRecovery/evaluations.repository.js";
import {
  MCP_TOOL_NAMES,
  SaveJobProspectInputSchema,
  runMcpTool,
  type McpDeps,
} from "../../mcp/catalog.js";

const store = vi.hoisted(() => ({
  rows: [] as JobProspect[],
  apps: [] as GmailApplication[],
  evaluations: new Map<string, ApplicationEvaluation>(),
  recovery: vi.fn(async () => ({ queued: 1, running: true, started: true })),
}));

vi.mock("../../services/gmail/jdRecovery/jobProspects.repository.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../services/gmail/jdRecovery/jobProspects.repository.js")>();
  return {
    ...actual,
    jobProspectsRepository: {
      insert: vi.fn(async (prospect: JobProspect) => {
        store.rows.push(prospect);
        return prospect;
      }),
      findByCompanyKey: vi.fn(async (companyKey: string) => store.rows.filter((row) => row.companyKey === companyKey)),
      findOpen: vi.fn(async () => store.rows.filter((row) => row.status === "open")),
      findOpenByCompanyKey: vi.fn(async (companyKey: string) =>
        store.rows.filter((row) => row.status === "open" && row.companyKey === companyKey),
      ),
      markAttached: vi.fn(async (id: string, applicationKey: string) => {
        const row = store.rows.find((prospect) => prospect.id === id);
        if (!row) return null;
        row.status = "attached";
        row.attachedKey = applicationKey;
        row.updatedAt = "2026-10-29T12:00:00.000Z";
        return { ...row };
      }),
    },
  };
});

vi.mock("../../services/gmail/gmailApplications.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../services/gmail/gmailApplications.js")>();
  return {
    ...actual,
    getGmailApplications: vi.fn(async () => store.apps),
  };
});

vi.mock("../../services/gmail/jdRecovery/evaluations.repository.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../services/gmail/jdRecovery/evaluations.repository.js")>();
  return {
    ...actual,
    evaluationsRepository: {
      ...actual.evaluationsRepository,
      findByKeys: vi.fn(async (keys: string[]) => {
        const map = new Map<string, ApplicationEvaluation>();
        for (const key of keys) {
          const row = store.evaluations.get(key);
          if (row) map.set(key, row);
        }
        return map;
      }),
    },
  };
});

vi.mock("../../services/gmail/jdRecovery/runRecovery.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../services/gmail/jdRecovery/runRecovery.js")>();
  return { ...actual, startRecoveryRun: (...args: unknown[]) => store.recovery(...args) };
});

import {
  describeProspectLinkage,
  persistJobProspect,
  saveJobProspect,
} from "../../services/gmail/jdRecovery/jobProspects.service.js";
import { withProspectLinks } from "../../services/gmail/jdRecovery/prospectMatch.js";

const CLEAN_JD = `
Stripe
Staff Software Engineer, Billing Platform
San Francisco, CA
Senior
$180,000 - $220,000

About the role
Build and operate billing systems in TypeScript.

Responsibilities
- Own invoice pipelines and ledger correctness
- Partner with finance on tax and payouts

Requirements
- 5+ years TypeScript
- Experience with high-volume financial data
`.trim();

const AGGREGATOR_JD = `
Home
Jobs
Messaging
Skip to main content
LinkedIn
Stripe
Staff Software Engineer, Billing Platform
San Francisco, CA
Senior
Easy Apply
See who you know
Promoted
Actively recruiting
12 connections work here
Fit score: 91
You're a strong match
How you match
Your skills match 9 of 12
Be an early applicant
$180,000 - $220,000
About the role
Build and operate billing systems in TypeScript.
Responsibilities
- Own invoice pipelines and ledger correctness
Requirements
- 5+ years TypeScript
Ask for a referral
Show more
Report this job
Posted 3 days ago
Indeed Apply
`;

const app = (over: Partial<GmailApplication> & Pick<GmailApplication, "key" | "company">): GmailApplication =>
  ({
    role: "Staff Software Engineer, Billing Platform",
    appliedAt: "2026-10-01T00:00:00.000Z",
    appliedAtKnown: true,
    appliedAtSource: "email",
    status: "applied",
    furthestStage: "applied",
    interviewRounds: [],
    activelyInterviewing: false,
    lastUpdateAt: "2026-10-01T00:00:00.000Z",
    emails: [],
    ...over,
  }) as GmailApplication;

const prospect = (over: Partial<JobProspect> & Pick<JobProspect, "company" | "title">): JobProspect => {
  const cleanedText = over.cleanedText ?? CLEAN_JD;
  return {
    id: over.id ?? "p1",
    companyKey: over.companyKey ?? normalizeCompany(over.company),
    rawText: over.rawText ?? cleanedText,
    cleanedText,
    cleanedTextHash: over.cleanedTextHash ?? computeJdTextHash(cleanedText),
    status: over.status ?? "open",
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
    ...over,
  };
};

beforeEach(() => {
  store.rows = [];
  store.apps = [];
  store.evaluations = new Map();
  store.recovery.mockClear();
  store.recovery.mockResolvedValue({ queued: 1, running: true, started: true });
});

describe("cleanProspectJd", () => {
  it("keeps a clean JD intact", () => {
    const cleaned = cleanProspectJd(CLEAN_JD);
    expect(cleaned).toContain("Staff Software Engineer, Billing Platform");
    expect(cleaned).toContain("5+ years TypeScript");
    expect(cleaned).toContain("$180,000 - $220,000");
    expect(cleaned).toContain("Own invoice pipelines");
  });

  it("strips aggregator chrome without changing job requirements", () => {
    const cleaned = cleanProspectJd(AGGREGATOR_JD);
    expect(cleaned).toContain("Staff Software Engineer, Billing Platform");
    expect(cleaned).toContain("5+ years TypeScript");
    expect(cleaned).toContain("$180,000 - $220,000");
    expect(cleaned).toContain("Own invoice pipelines");
    expect(cleaned).not.toMatch(/Easy Apply/i);
    expect(cleaned).not.toMatch(/See who you know/i);
    expect(cleaned).not.toMatch(/Fit score/i);
    expect(cleaned).not.toMatch(/Ask for a referral/i);
    expect(cleaned).not.toMatch(/Skip to main content/i);
    expect(cleaned).not.toMatch(/Indeed Apply/i);
    expect(cleaned.split("\n")).not.toContain("Home");
    expect(cleaned.split("\n")).not.toContain("Messaging");
  });
});

describe("prospect identity and duplicates", () => {
  it("does not treat a generic careers URL as a specific identity", () => {
    expect(isSpecificJobUrl("https://stripe.com/careers")).toBe(false);
    expect(isSpecificJobUrl("https://boards.greenhouse.io/stripe/jobs/1234567")).toBe(true);
  });

  it("merges the same company and role with the same cleaned text, even without a URL", () => {
    const existing = prospect({ company: "Stripe", title: "Staff Software Engineer, Billing Platform" });
    expect(
      isDuplicateOf(
        {
          title: "Staff Software Engineer, Billing Platform",
          cleanedTextHash: existing.cleanedTextHash,
        },
        existing,
      ),
    ).toBe(true);
  });

  it("does not merge identical JD text at a different company", () => {
    const existing = prospect({ company: "Stripe", title: "Staff Software Engineer, Billing Platform" });
    const other = prospect({ id: "p2", company: "Acme", title: "Staff Software Engineer, Billing Platform" });
    expect(existing.cleanedTextHash).toBe(other.cleanedTextHash);
    expect(existing.companyKey).not.toBe(other.companyKey);
  });

  it("does not merge two roles at the same company just because they share a careers URL", () => {
    const existing = prospect({
      company: "Stripe",
      title: "Staff Software Engineer, Billing Platform",
      sourceUrl: "https://stripe.com/careers",
    });
    expect(
      isDuplicateOf(
        {
          title: "Staff Software Engineer, Growth",
          cleanedTextHash: computeJdTextHash("different role text ".repeat(20)),
          sourceUrl: "https://stripe.com/careers",
        },
        existing,
      ),
    ).toBe(false);
  });
});

describe("matchProspectsToApplication", () => {
  it("auto-matches a unique specific company/role without URL or requisition ID", () => {
    const match = matchProspectsToApplication({
      app: app({ key: "stripe::billing", company: "Stripe" }),
      prospects: [prospect({ company: "Stripe", title: "Staff Software Engineer, Billing Platform" })],
    });
    expect(match).toMatchObject({ decision: "auto", reason: "unique_company_role" });
  });

  it("auto-matches a generic title when requisition IDs agree, and reviews when they conflict", () => {
    expect(
      matchProspectsToApplication({
        app: app({ key: "acme::se", company: "Acme", role: "Software Engineer" }),
        prospects: [prospect({ company: "Acme", title: "Software Engineer", requisitionId: "REQ-12345" })],
        requisitionId: "REQ-12345",
      }),
    ).toMatchObject({ decision: "auto", reason: "identity_match" });

    expect(
      matchProspectsToApplication({
        app: app({ key: "acme::se", company: "Acme", role: "Software Engineer" }),
        prospects: [prospect({ company: "Acme", title: "Software Engineer", requisitionId: "REQ-12345" })],
        requisitionId: "REQ-99999",
      }).reason,
    ).toBe("identity_conflict");
  });

  it("requires review for generic titles, missing Gmail roles, seniority conflicts, and competing prospects", () => {
    expect(
      matchProspectsToApplication({
        app: app({ key: "acme::se", company: "Acme", role: "Software Engineer" }),
        prospects: [prospect({ company: "Acme", title: "Software Engineer" })],
      }).decision,
    ).toBe("review");

    expect(
      matchProspectsToApplication({
        app: app({ key: "acme::", company: "Acme", role: null }),
        prospects: [prospect({ company: "Acme", title: "Staff Software Engineer, Platform Runtime" })],
      }).reason,
    ).toBe("role_unknown");

    expect(
      matchProspectsToApplication({
        app: app({ key: "fig::ios", company: "Figma", role: "Junior iOS Engineer" }),
        prospects: [prospect({ company: "Figma", title: "Senior iOS Engineer" })],
      }).reason,
    ).toBe("seniority_conflict");

    expect(
      matchProspectsToApplication({
        app: app({ key: "fig::pay", company: "Figma", role: "Staff Software Engineer, Payments" }),
        prospects: [
          prospect({ id: "a", company: "Figma", title: "Staff Software Engineer, Payments" }),
          prospect({ id: "b", company: "Figma", title: "Staff Software Engineer, Payments Platform" }),
        ],
      }).reason,
    ).toBe("multiple_prospects");
  });
});

describe("saveJobProspect", () => {
  it("stores raw and cleaned text, queues recovery, and does not require a URL", async () => {
    const saved = await saveJobProspect({
      rawText: AGGREGATOR_JD,
      company: "Stripe",
      title: "Staff Software Engineer, Billing Platform",
      location: "San Francisco, CA",
      seniority: "Senior",
    });
    expect(saved.duplicate).toBe(false);
    expect(saved.status).toBe("open");
    expect(saved.sourceUrl).toBeUndefined();
    expect(saved.requisitionId).toBeUndefined();
    expect(saved.recoveryQueued).toBe(true);
    expect(saved.matchStatus).toBe("awaiting_gmail_application");
    expect(saved.note).toMatch(/No Gmail application/);
    expect(store.recovery).toHaveBeenCalledWith(PROSPECT_MATCH_LOOKBACK_DAYS, { companyKey: "stripe" });
    expect(store.rows[0]?.rawText).toContain("Easy Apply");
    expect(store.rows[0]?.cleanedText).not.toMatch(/Easy Apply/i);
    expect(store.rows[0]?.cleanedText).toContain("5+ years TypeScript");
    expect(store.rows[0]?.rawText).not.toBe(store.rows[0]?.cleanedText);
  });

  it("returns the existing prospect for a duplicate capture at the same company and role", async () => {
    const first = await persistJobProspect({
      rawText: CLEAN_JD,
      company: "Stripe Inc",
      title: "Staff Software Engineer, Billing Platform",
    });
    const second = await persistJobProspect({
      rawText: CLEAN_JD,
      company: "Stripe",
      title: "Staff Software Engineer, Billing Platform",
    });
    expect(second.duplicate).toBe(true);
    expect(second.prospect.id).toBe(first.prospect.id);
    expect(store.rows).toHaveLength(1);
  });

  it("keeps identical JD text at two companies as two prospects", async () => {
    await persistJobProspect({ rawText: CLEAN_JD, company: "Stripe", title: "Staff Software Engineer, Billing Platform" });
    await persistJobProspect({ rawText: CLEAN_JD, company: "Acme", title: "Staff Software Engineer, Billing Platform" });
    expect(store.rows).toHaveLength(2);
  });

  it("queues scoring when saved after a unique Gmail application exists", async () => {
    store.apps = [
      app({
        key: "yaxle::full stack software engineer repairs",
        company: "Yaxle",
        role: "Full-stack Software Engineer, Repairs",
      }),
    ];
    const saved = await saveJobProspect({
      rawText: CLEAN_JD.replaceAll("Stripe", "Yaxle").replace(
        "Staff Software Engineer, Billing Platform",
        "Full-stack Software Engineer - Repairs",
      ),
      company: "Yaxle",
      title: "Full-stack Software Engineer - Repairs",
    });
    expect(saved.matchStatus).toBe("queued_for_scoring");
    expect(saved.applicationKey).toBe("yaxle::full stack software engineer repairs");
    expect(saved.note).toMatch(/Not scored yet/);
    expect(saved.status).toBe("open");
  });

  it("attaches to an already scored evaluation without replacing the score", async () => {
    const key = "stripe::staff software engineer billing platform";
    store.apps = [app({ key, company: "Stripe", role: "Staff Software Engineer, Billing Platform" })];
    store.evaluations.set(key, {
      key,
      company: "Stripe",
      role: "Staff Software Engineer, Billing Platform",
      appliedAt: "2026-10-01T00:00:00.000Z",
      recovery: { status: "scored", attempts: [], serperQueries: 0, foundVia: "prospect" },
      fit: {
        total: 71,
        recommendation: "apply",
        recommendedResume: "BASE",
        scoredAt: "2026-10-02T00:00:00.000Z",
        promptVersion: "v1",
      },
      outcome: { status: "applied", updatedAt: "2026-10-01T00:00:00.000Z", history: [] },
      createdAt: "2026-10-01T00:00:00.000Z",
      updatedAt: "2026-10-02T00:00:00.000Z",
    } as ApplicationEvaluation);
    const saved = await saveJobProspect({
      rawText: CLEAN_JD,
      company: "Stripe",
      title: "Staff Software Engineer, Billing Platform",
    });
    expect(saved.matchStatus).toBe("scored");
    expect(saved.fitTotal).toBe(71);
    expect(saved.status).toBe("attached");
    expect(saved.attachedKey).toBe(key);
    expect(store.evaluations.get(key)?.fit?.total).toBe(71);
    expect(store.recovery).not.toHaveBeenCalled();
  });

  it("does not auto-match two roles at the same employer", async () => {
    store.apps = [
      app({ key: "acme::backend", company: "Acme", role: "Backend Engineer" }),
      app({
        key: "acme::backend platform",
        company: "Acme",
        role: "Backend Engineer, Platform",
        appliedAt: "2026-10-02T00:00:00.000Z",
      }),
    ];
    const saved = await saveJobProspect({
      rawText: CLEAN_JD.replaceAll("Stripe", "Acme").replace("Staff Software Engineer, Billing Platform", "Backend Engineer"),
      company: "Acme",
      title: "Backend Engineer",
    });
    expect(saved.matchStatus).toBe("pending_review");
    expect(saved.note).toMatch(/Not scored/);
  });

  it("reports a duplicate save with the current match status", async () => {
    await persistJobProspect({
      rawText: CLEAN_JD,
      company: "Stripe",
      title: "Staff Software Engineer, Billing Platform",
    });
    const again = await saveJobProspect({
      rawText: CLEAN_JD,
      company: "Stripe",
      title: "Staff Software Engineer, Billing Platform",
    });
    expect(again.duplicate).toBe(true);
    expect(again.matchStatus).toBe("awaiting_gmail_application");
    expect(again.note).toMatch(/^Already saved/);
  });
});

describe("describeProspectLinkage and dashboard prospect links", () => {
  it("treats missing Gmail applications as awaiting_gmail_application", () => {
    const row = prospect({ company: "Bask Health", title: "Junior Back-End Software Engineer" });
    expect(describeProspectLinkage(row, [], new Map()).matchStatus).toBe("awaiting_gmail_application");
  });

  it("keeps a pending MCP candidate in pending_review instead of queued scoring", () => {
    const gmail = app({ key: "flux::fde", company: "Fluxcap", role: "FDE" });
    const row = prospect({ company: "Fluxcap", title: "FDE" });
    const evaluation = {
      key: gmail.key,
      company: "Fluxcap",
      role: "FDE",
      appliedAt: gmail.appliedAt,
      recovery: {
        status: "unverified",
        attempts: [],
        serperQueries: 0,
        candidates: [{ url: "https://jobs.example/1", source: "mcp", matchLevel: "low", text: "JD" }],
      },
      outcome: { status: "applied", updatedAt: gmail.appliedAt, history: [] },
      createdAt: gmail.appliedAt,
      updatedAt: gmail.appliedAt,
    } as ApplicationEvaluation;
    const linkage = describeProspectLinkage(row, [gmail], new Map([[gmail.key, evaluation]]));
    expect(linkage.matchStatus).toBe("pending_review");
    expect(linkage.matchReason).toBe("candidate_pending_review");
  });

  it("exposes compact dashboard linkage without JD text", () => {
    const gmail = app({
      key: "yaxle::full stack software engineer repairs",
      company: "Yaxle",
      role: "Full-stack Software Engineer, Repairs",
    });
    const row = prospect({
      id: "p-yaxle",
      company: "Yaxle",
      title: "Full-stack Software Engineer - Repairs",
      cleanedText: "SECRET_JD_BODY",
      rawText: "SECRET_JD_BODY",
    });
    const linked = withProspectLinks([gmail], [row]);
    expect(linked[0]?.prospectMatch).toMatchObject({
      prospectId: "p-yaxle",
      decision: "auto",
      status: "open",
    });
    expect(JSON.stringify(linked)).not.toContain("SECRET_JD_BODY");
  });
});

describe("save_job_prospect MCP tool", () => {
  const deps = (): McpDeps => ({
    getApplications: vi.fn(async () => []),
    getEvaluationsByKeys: vi.fn(async () => new Map()),
    getActiveScoreRevisions: vi.fn(async () => new Map()),
    getLatestInsightsRun: vi.fn(async () => null),
    getUserProfile: vi.fn(() => {
      throw new Error("getUserProfile should not run in prospect tests");
    }),
    getResumeContexts: vi.fn(async () => {
      throw new Error("getResumeContexts should not run in prospect tests");
    }),
    submitJdCandidate: vi.fn(async () => {
      throw new Error("submitJdCandidate should not run in prospect tests");
    }),
    proposeScoringCorrection: vi.fn(async () => {
      throw new Error("proposeScoringCorrection should not run in prospect tests");
    }),
    saveJobProspect: vi.fn(async (input) => ({
      id: "saved-1",
      company: input.company,
      title: input.title,
      duplicate: false,
      status: "open" as const,
      recoveryQueued: true,
      matchStatus: "awaiting_gmail_application" as const,
      matchReason: "no_gmail_application",
      note: "Saved. No Gmail application for this company is in the local lookback window yet.",
      rawChars: input.rawText.length,
      cleanedChars: input.rawText.length,
    })),
  });

  it("is registered next to the read tools and accepts extracted fields without a URL", async () => {
    expect(MCP_TOOL_NAMES).toContain("save_job_prospect");
    const d = deps();
    const result = (await runMcpTool(
      "save_job_prospect",
      { rawText: CLEAN_JD, company: "Stripe", title: "Staff Software Engineer, Billing Platform" },
      d,
    )) as { id: string; recoveryQueued: boolean };
    expect(d.saveJobProspect).toHaveBeenCalledWith({
      rawText: CLEAN_JD,
      company: "Stripe",
      title: "Staff Software Engineer, Billing Platform",
      location: undefined,
      seniority: undefined,
      requisitionId: undefined,
      sourceUrl: undefined,
      salary: undefined,
    });
    expect(result.id).toBe("saved-1");
    expect(d.getApplications).not.toHaveBeenCalled();
  });

  it("rejects extra fields and empty company/title", () => {
    expect(() => SaveJobProspectInputSchema.parse({ rawText: CLEAN_JD, company: "Stripe" })).toThrow(ZodError);
    expect(() =>
      SaveJobProspectInputSchema.parse({
        rawText: CLEAN_JD,
        company: "Stripe",
        title: "Staff Software Engineer, Billing Platform",
        trackerJobId: "nope",
      }),
    ).toThrow(ZodError);
  });
});
