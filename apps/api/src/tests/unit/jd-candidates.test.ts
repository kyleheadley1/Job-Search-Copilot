import { describe, expect, it } from "vitest";
import type { GmailApplication } from "../../services/gmail/gmailApplications.js";
import type { ApplicationEvaluation } from "../../services/gmail/jdRecovery/evaluations.repository.js";
import {
  ApplicationUnresolvedError,
  CandidatesFullError,
  CompanyMismatchError,
  classifySubmittedCompleteness,
  listMissingJobDescriptions,
  MAX_SUBMITTED_CANDIDATES,
  needsJobDescription,
  revalidateSubmittedCandidateCompleteness,
  submitJdCandidate,
  type JdCandidateStore,
} from "../../services/gmail/jdRecovery/jdCandidates.service.js";
import { AlreadyScoredError } from "../../services/gmail/jdRecovery/runRecovery.js";

const FULL_JD = [
  "Forward Deployed Software Engineer",
  "Fluxcap",
  "",
  "Responsibilities",
  "- Work with design partners on production deployments",
  "- Write TypeScript services and debug customer issues",
  "",
  "Requirements",
  "- 4+ years of software engineering experience",
  "- Comfortable in customer-facing environments",
  "Build TypeScript services and React interfaces for our healthcare platform. ".repeat(8),
].join("\n");

const PARTIAL_JD =
  "Full Stack Engineer at Intelligems. Remote or New York. One aggregator lists $140k-$180k, another lists $160k-$200k. Apply on LinkedIn.";

const app = (over: Partial<GmailApplication> & Pick<GmailApplication, "key" | "company">): GmailApplication =>
  ({
    role: "Engineer",
    appliedAt: "2026-10-20T00:00:00.000Z",
    appliedAtKnown: true,
    appliedAtSource: "email",
    status: "applied",
    furthestStage: "applied",
    interviewRounds: [],
    activelyInterviewing: false,
    lastUpdateAt: "2026-10-21T00:00:00.000Z",
    emails: [
      {
        id: "m1",
        subject: "Thanks for applying",
        from: "recruiter@example.com",
        date: "2026-10-20T00:00:00.000Z",
        eventType: "applied",
        gmailUrl: "https://mail.google.com/mail/u/0/#inbox/m1",
      },
    ],
    ...over,
  }) as GmailApplication;

const fluxcap = app({
  key: "fluxcap::forward deployed software engineer",
  company: "Fluxcap",
  role: "Forward Deployed Software Engineer",
});
const intelligems = app({
  key: "intelligems::full stack engineer",
  company: "Intelligems",
  role: "Full Stack Engineer",
});
const samsara = app({
  key: "samsara::software engineer",
  company: "Samsara",
  role: "Software Engineer II",
});
const scoredApp = app({ key: "acme::engineer", company: "Acme", role: "Engineer" });

const scoredEval = {
  key: scoredApp.key,
  company: "Acme",
  role: "Engineer",
  appliedAt: scoredApp.appliedAt,
  recovery: { status: "scored", attempts: [], serperQueries: 0 },
  fit: { total: 70, recommendation: "apply", recommendedResume: "BASE", scoredAt: "2026-10-22T00:00:00.000Z", promptVersion: "v1" },
  outcome: { status: "applied", updatedAt: scoredApp.appliedAt, history: [] },
  createdAt: scoredApp.appliedAt,
  updatedAt: scoredApp.appliedAt,
} as unknown as ApplicationEvaluation;

const notFound = (row: GmailApplication): ApplicationEvaluation =>
  ({
    key: row.key,
    company: row.company,
    role: row.role,
    appliedAt: row.appliedAt,
    recovery: { status: "not_found", reason: "no_board_found", attempts: [], serperQueries: 0 },
    outcome: { status: row.status, updatedAt: row.appliedAt, history: [] },
    createdAt: row.appliedAt,
    updatedAt: row.appliedAt,
  }) as ApplicationEvaluation;

const storeOf = (
  apps: GmailApplication[],
  seed: ApplicationEvaluation[] = [],
): { store: JdCandidateStore; evaluations: Map<string, ApplicationEvaluation> } => {
  const evaluations = new Map(seed.map((row) => [row.key, structuredClone(row)]));
  return {
    evaluations,
    store: {
      getApplications: async () => apps,
      findByKey: async (key) => {
        const row = evaluations.get(key);
        return row ? structuredClone(row) : null;
      },
      upsertIfUnscored: async (evaluation) => {
        const current = evaluations.get(evaluation.key);
        if (current?.recovery.status === "scored") return structuredClone(current);
        evaluations.set(evaluation.key, structuredClone(evaluation));
        return structuredClone(evaluation);
      },
    },
  };
};

describe("needsJobDescription", () => {
  it("treats scored evaluations as complete and everything else as missing", () => {
    expect(needsJobDescription(undefined)).toBe(true);
    expect(needsJobDescription(notFound(fluxcap))).toBe(true);
    expect(needsJobDescription(scoredEval)).toBe(false);
  });
});

describe("classifySubmittedCompleteness", () => {
  it("never upgrades a claimed partial, and can downgrade a thin full claim", () => {
    expect(classifySubmittedCompleteness(FULL_JD, "partial")).toBe("partial");
    expect(classifySubmittedCompleteness(FULL_JD, "full")).toBe("full");
    expect(classifySubmittedCompleteness(PARTIAL_JD, "full")).toBe("partial");
  });
});

describe("listMissingJobDescriptions", () => {
  it("paginates allowlisted rows and omits scored applications and email bodies", () => {
    const apps = [fluxcap, intelligems, samsara, scoredApp];
    const evaluations = new Map<string, ApplicationEvaluation>([
      [fluxcap.key, notFound(fluxcap)],
      [scoredApp.key, scoredEval],
    ]);
    const page = listMissingJobDescriptions(apps, evaluations, { offset: 1, limit: 1 });
    expect(page.totalMatched).toBe(3);
    expect(page.applications).toHaveLength(1);
    expect(page.applications[0]?.applicationKey).toBe(intelligems.key);
    const dated = listMissingJobDescriptions(
      [
        app({ key: "old::eng", company: "OldCo", appliedAt: "2026-01-01T00:00:00.000Z" }),
        app({ key: "new::eng", company: "NewCo", appliedAt: "2026-10-01T00:00:00.000Z" }),
      ],
      new Map(),
      { offset: 0, limit: 10 },
    );
    expect(dated.applications.map((row) => row.applicationKey)).toEqual(["new::eng", "old::eng"]);
    const row = listMissingJobDescriptions(apps, evaluations, { offset: 0, limit: 10, query: "flux" }).applications[0];
    expect(row).toMatchObject({
      applicationKey: fluxcap.key,
      company: "Fluxcap",
      title: "Forward Deployed Software Engineer",
      appliedAtKnown: true,
      recoveryStatus: "not_found",
      recoveryReason: "no_board_found",
      candidateCount: 0,
      latestSubject: "Thanks for applying",
      emailCount: 1,
    });
    expect(JSON.stringify(row)).not.toContain("recruiter@example.com");
    expect(JSON.stringify(row)).not.toContain("mail.google.com");
    expect(row).not.toHaveProperty("from");
    expect(row).not.toHaveProperty("emails");
  });
});

describe("submitJdCandidate", () => {
  it("stores a Fluxcap-style third-party posting for review without scoring", async () => {
    const { store, evaluations } = storeOf([fluxcap], [notFound(fluxcap)]);
    const result = await submitJdCandidate(
      {
        applicationKey: fluxcap.key,
        company: "Fluxcap",
        title: "Forward Deployed Software Engineer",
        originalText: FULL_JD,
        sourceUrl: "https://www.builtinnyc.com/job/forward-deployed-software-engineer/12345?utm_source=web",
        sourceType: "aggregator",
        retrievedAt: "2026-10-28T12:00:00.000Z",
        matchEvidence: ["Exact company and title on Built In NYC"],
        completeness: "full",
      },
      store,
      120,
    );
    expect(result).toMatchObject({
      applicationKey: fluxcap.key,
      status: "submitted",
      duplicate: false,
      reviewRequired: true,
      scoringEligible: true,
      completeness: "full",
      sourceType: "aggregator",
    });
    expect(result.sourceUrl).toBe("https://www.builtinnyc.com/job/forward-deployed-software-engineer/12345");
    const saved = evaluations.get(fluxcap.key)!;
    expect(saved.recovery.status).toBe("unverified");
    expect(saved.fit).toBeUndefined();
    expect(saved.recovery.candidates).toHaveLength(1);
    expect(saved.recovery.candidates![0]).toMatchObject({
      source: "mcp",
      matchLevel: "low",
      completeness: "full",
    });
    expect(saved.recovery.candidates![0]!.rawText).toContain("Forward Deployed Software Engineer");
    expect(saved.recovery.candidates![0]!.rawText).toContain("Responsibilities");
    expect(saved.recovery.candidates![0]!.text.length).toBeGreaterThan(40);
    expect(saved.recovery.candidates![0]!.evidenceSnapshot?.capturedAt).toBeTruthy();
    expect(result.shadow?.autoConfirmEnabled).toBe(false);
  });

  it("marks an Intelligems-style partial aggregator copy ineligible for scoring", async () => {
    const { store, evaluations } = storeOf([intelligems], [notFound(intelligems)]);
    const result = await submitJdCandidate(
      {
        applicationKey: intelligems.key,
        company: "Intelligems",
        originalText: PARTIAL_JD,
        sourceUrl: "https://www.linkedin.com/jobs/view/987654",
        sourceType: "aggregator",
        matchEvidence: ["Title and company match; location and salary conflict across aggregators"],
        completeness: "partial",
      },
      store,
      120,
    );
    expect(result.scoringEligible).toBe(false);
    expect(result.completeness).toBe("partial");
    expect(evaluations.get(intelligems.key)!.recovery.candidates![0]!.completeness).toBe("partial");
    expect(evaluations.get(intelligems.key)!.recovery.status).not.toBe("scored");
  });

  it("keeps competing Samsara candidates without choosing one", async () => {
    const { store, evaluations } = storeOf([samsara], [notFound(samsara)]);
    await submitJdCandidate(
      {
        applicationKey: samsara.key,
        company: "Samsara",
        originalText: FULL_JD.replace("Fluxcap", "Samsara").replace("Forward Deployed Software Engineer", "Software Engineer II, Backend"),
        sourceUrl: "https://www.samsara.com/careers/jobs/backend",
        sourceType: "company_site",
        matchEvidence: ["Same title; backend team is one of several SWE II openings"],
        completeness: "full",
      },
      store,
      120,
    );
    await submitJdCandidate(
      {
        applicationKey: samsara.key,
        company: "Samsara",
        originalText: FULL_JD.replace("Fluxcap", "Samsara").replace("Forward Deployed Software Engineer", "Software Engineer II, Frontend"),
        sourceUrl: "https://www.samsara.com/careers/jobs/frontend",
        sourceType: "company_site",
        matchEvidence: ["Same title; frontend team is another plausible opening"],
        completeness: "full",
      },
      store,
      120,
    );
    const candidates = evaluations.get(samsara.key)!.recovery.candidates!;
    expect(candidates).toHaveLength(2);
    expect(candidates.map((c) => c.url)).toEqual([
      "https://www.samsara.com/careers/jobs/backend",
      "https://www.samsara.com/careers/jobs/frontend",
    ]);
    expect(candidates.every((c) => c.matchLevel === "low")).toBe(true);
    expect(evaluations.get(samsara.key)!.recovery.status).toBe("unverified");
  });

  it("rejects invalid keys, mismatched companies, duplicates, and scored evaluations", async () => {
    const { store, evaluations } = storeOf(
      [fluxcap, scoredApp],
      [notFound(fluxcap), scoredEval],
    );
    await expect(
      submitJdCandidate(
        {
          applicationKey: "missing::role",
          company: "Fluxcap",
          originalText: FULL_JD,
          sourceUrl: "https://www.builtinnyc.com/job/1",
          sourceType: "aggregator",
          matchEvidence: ["n/a"],
          completeness: "full",
        },
        store,
        120,
      ),
    ).rejects.toBeInstanceOf(ApplicationUnresolvedError);

    await expect(
      submitJdCandidate(
        {
          applicationKey: fluxcap.key,
          company: "Not Fluxcap",
          originalText: FULL_JD,
          sourceUrl: "https://www.builtinnyc.com/job/1",
          sourceType: "aggregator",
          matchEvidence: ["company looks similar"],
          completeness: "full",
        },
        store,
        120,
      ),
    ).rejects.toBeInstanceOf(CompanyMismatchError);

    await submitJdCandidate(
      {
        applicationKey: fluxcap.key,
        company: "Fluxcap",
        originalText: FULL_JD,
        sourceUrl: "https://www.builtinnyc.com/job/1?utm_source=x",
        sourceType: "aggregator",
        matchEvidence: ["exact title"],
        completeness: "full",
      },
      store,
      120,
    );
    const again = await submitJdCandidate(
      {
        applicationKey: fluxcap.key,
        company: "Fluxcap",
        originalText: FULL_JD,
        sourceUrl: "https://www.builtinnyc.com/job/1",
        sourceType: "aggregator",
        matchEvidence: ["exact title again"],
        completeness: "full",
      },
      store,
      120,
    );
    const frozen = evaluations.get(fluxcap.key)!.recovery.candidates![0]!.evidenceSnapshot;
    expect(frozen).toBeDefined();
    expect(frozen?.claude.explanation).toEqual(["exact title"]);
    expect(again).toMatchObject({ status: "already_submitted", duplicate: true, candidateCount: 1 });
    expect(evaluations.get(fluxcap.key)!.recovery.candidates).toHaveLength(1);
    expect(evaluations.get(fluxcap.key)!.recovery.candidates![0]!.evidenceSnapshot).toEqual(frozen);
    expect(evaluations.get(fluxcap.key)!.recovery.candidates![0]!.matchEvidence).toEqual(["exact title"]);

    await expect(
      submitJdCandidate(
        {
          applicationKey: scoredApp.key,
          company: "Acme",
          originalText: FULL_JD,
          sourceUrl: "https://acme.example/jobs/1",
          sourceType: "company_site",
          matchEvidence: ["same company"],
          completeness: "full",
        },
        store,
        120,
      ),
    ).rejects.toBeInstanceOf(AlreadyScoredError);
    expect(evaluations.get(scoredApp.key)!.fit?.total).toBe(70);
  });

  it("does not treat self-reported confidence as an input and caps stored candidates", async () => {
    const { store, evaluations } = storeOf([samsara], [notFound(samsara)]);
    for (let i = 0; i < MAX_SUBMITTED_CANDIDATES; i += 1) {
      await submitJdCandidate(
        {
          applicationKey: samsara.key,
          company: "Samsara",
          originalText: FULL_JD,
          sourceUrl: `https://www.samsara.com/careers/jobs/${i}`,
          sourceType: "company_site",
          matchEvidence: [`candidate ${i}`],
          completeness: "full",
        },
        store,
        120,
      );
    }
    await expect(
      submitJdCandidate(
        {
          applicationKey: samsara.key,
          company: "Samsara",
          originalText: FULL_JD,
          sourceUrl: "https://www.samsara.com/careers/jobs/extra",
          sourceType: "company_site",
          matchEvidence: ["one more"],
          completeness: "full",
        },
        store,
        120,
      ),
    ).rejects.toBeInstanceOf(CandidatesFullError);
    expect(evaluations.get(samsara.key)!.recovery.candidates).toHaveLength(MAX_SUBMITTED_CANDIDATES);
  });
});

const FLUXCAP_EQUIVALENT_HEADINGS = [
  "Forward Deployed Software Engineer",
  "The role",
  "You’ll work directly with lawyers using FluxCap to understand where they get stuck and build software that helps them move forward.",
  "You’ll follow projects from the first conversation through production and see how your work performs on real cases.",
  "What you’ll do",
  "Work with lawyers and legal engineers to understand a problem and choose a useful first step.",
  "Build frontend and backend features, data integrations, and AI workflows.",
  "Write tested, dependable software and handle sensitive case information with care.",
  "What you’ll bring",
  "Experience building working software through a job, internship, or substantial project.",
  "Strong programming fundamentals and familiarity with TypeScript or JavaScript and React.",
  "Clear communication and a willingness to ask questions when something is unclear.",
].join("\n");

describe("revalidateSubmittedCandidateCompleteness", () => {
  it("upgrades a server-downgraded Fluxcap-style candidate without scoring or duplicating", async () => {
    const seeded = notFound(fluxcap);
    seeded.recovery = {
      ...seeded.recovery,
      status: "unverified",
      candidates: [
        {
          url: "https://www.builtinnyc.com/job/forward-deployed-software-engineer/11912990",
          source: "mcp",
          stage: "mcp",
          matchLevel: "low",
          title: "Forward Deployed Software Engineer",
          company: "Fluxcap",
          text: FLUXCAP_EQUIVALENT_HEADINGS,
          rawText: FLUXCAP_EQUIVALENT_HEADINGS,
          completeness: "partial",
          claimedCompleteness: "full",
          sourceType: "aggregator",
        },
      ],
    };
    const { store, evaluations } = storeOf([fluxcap], [seeded]);
    const result = await revalidateSubmittedCandidateCompleteness(
      fluxcap.key,
      "https://www.builtinnyc.com/job/forward-deployed-software-engineer/11912990?utm_source=x",
      store,
    );
    expect(result).toMatchObject({
      updated: true,
      completeness: "full",
      scoringEligible: true,
      reviewRequired: true,
      recoveryStatus: "unverified",
    });
    const candidate = evaluations.get(fluxcap.key)!.recovery.candidates![0]!;
    expect(candidate.completeness).toBe("full");
    expect(candidate.text).toBe(FLUXCAP_EQUIVALENT_HEADINGS);
    expect(candidate.rawText).toBe(FLUXCAP_EQUIVALENT_HEADINGS);
    expect(candidate.matchLevel).toBe("low");
    expect(evaluations.get(fluxcap.key)!.fit).toBeUndefined();
    expect(evaluations.get(fluxcap.key)!.recovery.candidates).toHaveLength(1);
  });

  it("does not upgrade a claimed-partial candidate even if the text would now pass", async () => {
    const seeded = notFound(fluxcap);
    seeded.recovery = {
      ...seeded.recovery,
      status: "unverified",
      candidates: [
        {
          url: "https://www.builtinnyc.com/job/forward-deployed-software-engineer/11912990",
          source: "mcp",
          stage: "mcp",
          matchLevel: "low",
          text: FLUXCAP_EQUIVALENT_HEADINGS,
          completeness: "partial",
          claimedCompleteness: "partial",
          sourceType: "aggregator",
        },
      ],
    };
    const { store, evaluations } = storeOf([fluxcap], [seeded]);
    const result = await revalidateSubmittedCandidateCompleteness(
      fluxcap.key,
      "https://www.builtinnyc.com/job/forward-deployed-software-engineer/11912990",
      store,
    );
    expect(result.updated).toBe(false);
    expect(result.completeness).toBe("partial");
    expect(evaluations.get(fluxcap.key)!.recovery.candidates![0]!.completeness).toBe("partial");
  });

  it("upgrades a claimed-full Experience We're Looking For candidate after the heading heuristic is fixed", async () => {
    const ooma = app({ key: "ooma::software engineer", company: "Ooma", role: "Software Engineer" });
    const oomaText = [
      "Software Engineer",
      "Ooma",
      "About the Role",
      "You will own backend services used by the communications platform and ship production features with the team each week.",
      "What You'll Do",
      "- Design and implement backend services for the communications platform",
      "- Collaborate with product and support on customer-facing issues",
      "Experience We're Looking For",
      "- Comfortable shipping production software in a collaborative environment",
      "- Strong communication with product, support, and other engineers",
      "- Ability to debug systems and take ownership of customer-facing issues",
      "What We Offer",
      "$94,000—$120,000 USD",
    ].join("\n");
    const seeded = notFound(ooma);
    seeded.recovery = {
      ...seeded.recovery,
      status: "unverified",
      candidates: [
        {
          url: "https://www.builtinboston.com/job/software-engineer/9834227",
          source: "mcp",
          stage: "mcp",
          matchLevel: "high",
          title: "Software Engineer",
          company: "Ooma",
          text: oomaText,
          rawText: oomaText,
          completeness: "partial",
          claimedCompleteness: "full",
          sourceType: "aggregator",
        },
      ],
    };
    const { store, evaluations } = storeOf([ooma], [seeded]);
    const result = await revalidateSubmittedCandidateCompleteness(
      ooma.key,
      "https://www.builtinboston.com/job/software-engineer/9834227",
      store,
    );
    expect(result).toMatchObject({
      updated: true,
      completeness: "full",
      scoringEligible: true,
      reviewRequired: true,
      recoveryStatus: "unverified",
    });
    expect(evaluations.get(ooma.key)!.fit).toBeUndefined();
    expect(evaluations.get(ooma.key)!.recovery.candidates![0]!.completeness).toBe("full");
    expect(evaluations.get(ooma.key)!.recovery.status).toBe("unverified");
    const beforeSnapshot = evaluations.get(ooma.key)!.recovery.candidates![0]!.evidenceSnapshot;
    expect(beforeSnapshot).toBeUndefined();
  });
});
