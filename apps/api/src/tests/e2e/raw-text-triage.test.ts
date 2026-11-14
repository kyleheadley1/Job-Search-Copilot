import { describe, expect, it } from "vitest";
import { triageJob } from "../../agents/jobAgent/orchestrator.js";

const BAD_BANK_NEW_GRAD = `
Heritage Bank — Associate Software Engineer (New Graduate Program)
Location: Onsite, Dallas, TX (not commutable from NYC)

Requirements:
Bachelor's degree in Computer Science or related field required.
This is a new graduate rotational program targeting traditional campus hires.
5+ years of enterprise Java experience preferred.
US citizenship required.
No visa sponsorship.
`.trim();

const STRONG_STARTUP = `
Nimbus Labs — Software Engineer — Product (Seed-stage startup)
Remote (US). NYC-friendly hybrid optional.

Build customer-facing features with TypeScript, Node.js, React, and REST APIs.
Ship internal tools and AI-enabled workflows for operations teams.
2+ years experience; we care about product sense and ambiguity.

Salary: 130000 USD - 160000 USD
`.trim();

const SIE_ROLE = `
DeployCo — Solutions Engineer (Forward Deployed)
Hybrid NYC.

You will own customer-facing implementation, integrations with enterprise APIs, and technical onboarding workshops.

Requirements:
- Strong communication and stakeholder collaboration
- Experience with integrations and delivery timelines

Salary: $140k–$200k
`.trim();

const EARLY_CAREER_ROLE = `
CampusTech — Software Engineer I (Early Career)
Remote.

We are hiring for our early career rotational program for recent graduates.
Build features in JavaScript and React with mentorship.

Requirements:
- Entry level friendly; 0-2 years experience
`.trim();

describe("triage from raw pasted text (no structured hand-build)", () => {
  it("A. bad-fit bank new grad: strong negative signals, low score, not shortlisted", async () => {
    const job = await triageJob({ rawText: BAD_BANK_NEW_GRAD, companyHint: "Heritage Bank", fullPrep: false });

    expect(job.rules.explicitDegreeRisk).toBe(true);
    expect(job.rules.financePenalty || job.rules.traditionalCompanyPenalty).toBe(true);
    expect(job.rules.strictNewGradPipeline).toBe(true);
    expect(job.rules.newGradPenalty).toBe(true);
    expect(job.extracted.citizenshipRequirement).toMatch(/citizenship/i);
    expect(job.rules.citizenshipMismatch).toBe(false);
    expect(job.rules.locationMismatch).toBe(true);

    expect(job.recommendation).toBe("weak");
    expect(job.score.total).toBeLessThan(70);
    expect(job.tracker.shortlist).toBe(false);

    expect(job.debugExtraction?.extraction).toBeDefined();
    expect(job.debugExtraction?.scoring).toBeDefined();
    expect(job.debugExtraction?.extractedFromRawText.length).toBeGreaterThan(0);
    expect(job.extracted.salary).toBeUndefined();
  });

  it("B. strong product startup: materially higher total than bank, salary parsed, BASE resume", async () => {
    const bad = await triageJob({ rawText: BAD_BANK_NEW_GRAD, companyHint: "Heritage Bank", fullPrep: false });
    const good = await triageJob({ rawText: STRONG_STARTUP, companyHint: "Nimbus Labs", fullPrep: false });

    expect(good.score.stackFit).toBeGreaterThan(bad.score.stackFit);
    expect(Object.keys(good.rules.penaltyVector ?? {}).length).toBeLessThan(
      Object.keys(bad.rules.penaltyVector ?? {}).length,
    );

    expect(good.recommendedResume).toBe("BASE");
    expect(good.extracted.salary?.min).toBe(130000);
    expect(good.extracted.salary?.max).toBe(160000);
    expect(good.salaryAsk.number).toBeGreaterThanOrEqual(130000);
    expect(good.score.total - bad.score.total).toBeGreaterThanOrEqual(10);
    expect((good.score.capability ?? 0) - (bad.score.capability ?? 0)).toBeGreaterThanOrEqual(15);
    expect(good.score.total).toBeGreaterThan(bad.score.total);
    expect(["strong_apply", "apply", "stretch"]).toContain(
      good.recommendation,
    );
  });

  it("C. forward-deployed / integration role: FDE resume, score well above bank", async () => {
    const bank = await triageJob({ rawText: BAD_BANK_NEW_GRAD, companyHint: "Heritage Bank", fullPrep: false });
    const job = await triageJob({ rawText: SIE_ROLE, companyHint: "DeployCo", fullPrep: false });
    expect(job.recommendedResume).toBe("FDE");
    expect(job.extracted.salary?.min).toBe(140000);
    expect(job.extracted.salary?.max).toBe(200000);
    expect(job.score.total - bank.score.total).toBeGreaterThanOrEqual(10);
    expect((job.score.capability ?? 0) - (bank.score.capability ?? 0)).toBeGreaterThanOrEqual(7);
  });

  it("D. explicit early-career role: BASE resume, soft pipeline only", async () => {
    const job = await triageJob({ rawText: EARLY_CAREER_ROLE, companyHint: "CampusTech", fullPrep: false });
    expect(job.recommendedResume).toBe("BASE");
    expect(job.rules.strictNewGradPipeline).toBe(false);
    expect(job.rules.earlyCareerFriendlyRole).toBe(true);
    expect(job.rules.newGradPenalty).toBe(false);
    expect(job.rules.penaltyVector?.earlyCareerSoft).toBe(4);
  });
});

describe("raw-text score separation regressions", () => {
  it("startup stays materially above bad bank; bank stays no / not shortlisted; resume types stable", async () => {
    const bank = await triageJob({ rawText: BAD_BANK_NEW_GRAD, companyHint: "Heritage Bank", fullPrep: false });
    const startup = await triageJob({ rawText: STRONG_STARTUP, companyHint: "Nimbus Labs", fullPrep: false });
    const sie = await triageJob({ rawText: SIE_ROLE, companyHint: "DeployCo", fullPrep: false });
    const early = await triageJob({ rawText: EARLY_CAREER_ROLE, companyHint: "CampusTech", fullPrep: false });

    expect(startup.score.total - bank.score.total).toBeGreaterThanOrEqual(10);
    expect(sie.score.total - bank.score.total).toBeGreaterThanOrEqual(10);
    expect((startup.score.capability ?? 0) - (bank.score.capability ?? 0)).toBeGreaterThanOrEqual(15);
    expect(early.score.total).toBeGreaterThan(bank.score.total);

    expect(bank.recommendation).toBe("weak");
    expect(bank.tracker.shortlist).toBe(false);

    expect(startup.recommendedResume).toBe("BASE");
    expect(sie.recommendedResume).toBe("FDE");
    expect(early.recommendedResume).toBe("BASE");
  });
});
