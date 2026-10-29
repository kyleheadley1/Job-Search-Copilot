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
import {
  MCP_TOOL_NAMES,
  SaveJobProspectInputSchema,
  runMcpTool,
  type McpDeps,
} from "../../mcp/catalog.js";

const store = vi.hoisted(() => ({
  rows: [] as JobProspect[],
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
      markAttached: vi.fn(async () => null),
    },
  };
});

vi.mock("../../services/gmail/jdRecovery/runRecovery.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../services/gmail/jdRecovery/runRecovery.js")>();
  return { ...actual, startRecoveryRun: (...args: unknown[]) => store.recovery(...args) };
});

import { persistJobProspect, saveJobProspect } from "../../services/gmail/jdRecovery/jobProspects.service.js";

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
