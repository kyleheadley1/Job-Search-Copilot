import { describe, expect, it } from "vitest";
import type { JdMatchEvidenceSnapshot } from "../../services/gmail/jdRecovery/jdMatchEvidence.js";
import { buildMatchEvidenceSnapshot } from "../../services/gmail/jdRecovery/jdMatchEvidence.js";
import { pendingReviewRowsFromEvaluations } from "../../services/gmail/jdRecovery/jdReview.service.js";
import { summarizeShadowDecisions } from "../../services/gmail/jdRecovery/jdReviewDecisions.repository.js";
import type { JdReviewDecision } from "../../services/gmail/jdRecovery/jdReviewDecisions.types.js";
import { assessShadowEligibility } from "../../services/gmail/jdRecovery/jdShadowEligibility.js";
import type { ApplicationEvaluation } from "../../services/gmail/jdRecovery/evaluations.repository.js";

const signal = (
  verdict: "match" | "mismatch" | "unknown",
  provenance: "verified_source" | "deterministic" | "claude_reported" | "unknown" = "deterministic",
  extra: { applicationValue?: string; candidateValue?: string; note?: string } = {},
) => ({ verdict, provenance, ...extra });

const snapshot = (over: Partial<JdMatchEvidenceSnapshot> & { signals?: Partial<JdMatchEvidenceSnapshot["signals"]> }): JdMatchEvidenceSnapshot => ({
  capturedAt: "2026-10-29T12:00:00.000Z",
  applicationKey: "acme::software engineer",
  application: {
    company: "Acme",
    role: "Software Engineer",
    appliedAt: "2026-06-01T00:00:00.000Z",
    appliedAtKnown: true,
    ...over.application,
  },
  candidate: {
    url: "https://jobs.ashbyhq.com/acme/swe",
    sourceType: "ats",
    title: "Software Engineer",
    company: "Acme",
    completeness: "full",
    ...over.candidate,
  },
  signals: {
    company: signal("match", "deterministic", { applicationValue: "Acme", candidateValue: "Acme" }),
    title: signal("match", "deterministic", { applicationValue: "Software Engineer", candidateValue: "Software Engineer", note: "strict_title:1.00" }),
    requisitionId: signal("unknown", "unknown"),
    location: signal("unknown", "unknown"),
    postingDate: signal("match", "deterministic", { applicationValue: "2026-06-01T00:00:00.000Z", candidateValue: "2026-05-20T00:00:00.000Z" }),
    completeness: signal("match", "deterministic", { candidateValue: "full" }),
    competingPostings: { ...signal("match", "unknown"), items: [] },
    ...over.signals,
  },
  claude: { provenance: "claude_reported", explanation: ["Exact title on the ATS"], ...over.claude },
});

describe("assessShadowEligibility", () => {
  it("Red Ventures: exact title and aligned date on a trusted source is shadow-eligible", () => {
    const result = assessShadowEligibility(
      snapshot({
        applicationKey: "red ventures::software engineer",
        application: { company: "Red Ventures", role: "Software Engineer", appliedAt: "2026-05-10T00:00:00.000Z", appliedAtKnown: true },
        candidate: { sourceType: "company_site", title: "Software Engineer", company: "Red Ventures", completeness: "full" },
        signals: {
          company: signal("match", "verified_source", { applicationValue: "Red Ventures", candidateValue: "Red Ventures" }),
          title: signal("match", "deterministic", { note: "strict_title:1.00" }),
          postingDate: signal("match", "deterministic"),
        },
      }),
    );
    expect(result.recommendation).toBe("eligible_for_auto_confirmation");
    expect(result.autoConfirmEnabled).toBe(false);
    expect(result.positives).toEqual(expect.arrayContaining(["company_match", "exact_title", "complete_jd", "date_aligned"]));
  });

  it("Campus: exact title and date with a competing similar posting stays manual review", () => {
    const result = assessShadowEligibility(
      snapshot({
        applicationKey: "campus::software engineer",
        application: { company: "Campus", role: "Software Engineer", appliedAt: "2026-04-01T00:00:00.000Z", appliedAtKnown: true },
        candidate: { sourceType: "ats", title: "Software Engineer", completeness: "full" },
        signals: {
          competingPostings: {
            ...signal("unknown", "deterministic"),
            items: [{ url: "https://jobs.ashbyhq.com/campus/swe-2", title: "Software Engineer, University Grad" }],
          },
        },
      }),
    );
    expect(result.recommendation).toBe("manual_review");
    expect(result.blockers).toContain("multiple_plausible_competing_postings");
  });

  it("blocks shadow auto-confirm for a removed candidate", () => {
    const result = assessShadowEligibility(
      snapshot({
        candidate: { sourceType: "ats", title: "Software Engineer", completeness: "full" },
      }),
      { reviewStatus: "removed" },
    );
    expect(result.recommendation).toBe("manual_review");
    expect(result.autoConfirmEnabled).toBe(false);
    expect(result.blockers).toContain("removed_from_review");
  });

  it("Palantir: same role across distinct cities is a location/requisition conflict", () => {
    const result = assessShadowEligibility(
      snapshot({
        applicationKey: "palantir::software engineer",
        application: { company: "Palantir", role: "Software Engineer", appliedAt: "2026-03-01T00:00:00.000Z", appliedAtKnown: true },
        candidate: { sourceType: "company_site", title: "Software Engineer", location: "Denver, CO", completeness: "full" },
        signals: {
          location: signal("mismatch", "deterministic", { applicationValue: "New York, NY", candidateValue: "Denver, CO" }),
        },
      }),
    );
    expect(result.recommendation).toBe("reject_mismatch");
    expect(result.blockers).toContain("location_identifies_different_requisition");
  });

  it("Cisco: conflicting requisition IDs are a hard reject", () => {
    const result = assessShadowEligibility(
      snapshot({
        applicationKey: "cisco::fy26 software engineer",
        application: { company: "Cisco", role: "Software Engineer", appliedAt: "2026-06-01T00:00:00.000Z", appliedAtKnown: true, requisitionId: "2000087" },
        signals: {
          requisitionId: signal("mismatch", "deterministic", { applicationValue: "2000087", candidateValue: "2000127" }),
        },
      }),
    );
    expect(result.recommendation).toBe("reject_mismatch");
    expect(result.blockers).toContain("conflicting_requisition_ids");
  });

  it("Ooma: incomplete JD is manual review, not an identity reject", () => {
    const result = assessShadowEligibility(
      snapshot({
        applicationKey: "ooma::software engineer",
        application: { company: "Ooma", role: "Software Engineer", appliedAt: "2026-06-22T00:00:00.000Z", appliedAtKnown: true },
        candidate: { sourceType: "aggregator", completeness: "partial", claimedCompleteness: "full" },
        signals: {
          completeness: signal("mismatch", "deterministic", { candidateValue: "partial" }),
          postingDate: signal("unknown", "unknown"),
        },
      }),
    );
    expect(result.recommendation).toBe("manual_review");
    expect(result.blockers).toContain("incomplete_jd");
    expect(result.blockers).not.toContain("conflicting_employer");
  });

  it("does not treat missing dates, missing requisition IDs, or Claude confidence as positive evidence", () => {
    const result = assessShadowEligibility(
      snapshot({
        signals: {
          requisitionId: signal("unknown", "unknown"),
          postingDate: signal("unknown", "unknown"),
        },
        claude: { provenance: "claude_reported", explanation: ["Looks right"], confidence: 97 },
      }),
    );
    expect(result.recommendation).toBe("manual_review");
    expect(result.unknowns).toEqual(expect.arrayContaining(["requisition_id_unknown", "posting_date_unknown"]));
    expect(result.positives).not.toContain("requisition_id_match");
    expect(result.positives).not.toContain("date_aligned");
    expect(result.notes.join(" ")).toMatch(/confidence is recorded and is not used as proof/i);
  });

  it("keeps multiple same-company roles in manual review without a requisition discriminator", () => {
    const result = assessShadowEligibility(
      snapshot({
        candidate: { title: "Software Engineer II", completeness: "full" },
        signals: {
          title: signal("match", "deterministic", { note: "strict_title:0.85" }),
          competingPostings: {
            ...signal("unknown", "deterministic"),
            items: [{ url: "https://jobs.ashbyhq.com/acme/swe-backend", title: "Software Engineer, Backend" }],
          },
        },
      }),
    );
    expect(result.recommendation).toBe("manual_review");
    expect(result.blockers).toContain("multiple_plausible_competing_postings");
  });

  it("rejects a conflicting employer even when the title is exact", () => {
    const result = assessShadowEligibility(
      snapshot({
        signals: {
          company: signal("mismatch", "deterministic", { applicationValue: "Acme", candidateValue: "Otherco" }),
        },
      }),
    );
    expect(result.recommendation).toBe("reject_mismatch");
    expect(result.blockers).toContain("conflicting_employer");
  });
});

describe("buildMatchEvidenceSnapshot provenance", () => {
  it("marks Claude-only fields as claude_reported and extracted IDs as deterministic or verified", () => {
    const built = buildMatchEvidenceSnapshot({
      applicationKey: "cisco::swe",
      company: "Cisco",
      role: "Software Engineer",
      appliedAt: "2026-06-01T00:00:00.000Z",
      appliedAtKnown: true,
      applicationRequisitionId: "2000087",
      candidate: {
        url: "https://jobs.cisco.com/careers/job/2000127",
        sourceType: "company_site",
        title: "Software Engineer",
        company: "Cisco",
        completeness: "full",
        claimedCompleteness: "full",
        text: [
          "Software Engineer",
          "Cisco",
          "Req 2000127",
          "What you'll do",
          "- Build backend services used by customer teams every week",
          "- Review code and improve production reliability",
          "Requirements",
          "- 3+ years of software engineering experience",
          "- Familiarity with TypeScript and relational databases",
        ].join("\n"),
        matchEvidence: ["Same Cisco req family"],
        claudeConfidence: 80,
      },
    });
    expect(built.signals.requisitionId.verdict).toBe("mismatch");
    expect(built.claude.confidence).toBe(80);
    expect(built.claude.provenance).toBe("claude_reported");
  });
});

describe("pendingReviewRowsFromEvaluations", () => {
  const evaluation = (over: Partial<ApplicationEvaluation>): ApplicationEvaluation =>
    ({
      key: "ooma::software engineer",
      company: "Ooma",
      role: "Software Engineer",
      appliedAt: "2026-06-22T02:59:22.483Z",
      recovery: { status: "unverified", attempts: [], serperQueries: 0, candidates: [] },
      outcome: { status: "rejected", updatedAt: "2026-07-15T22:15:59.000Z", history: [] },
      createdAt: "2026-06-22T02:59:22.483Z",
      updatedAt: "2026-10-29T21:30:00.000Z",
      ...over,
    }) as ApplicationEvaluation;

  it("includes old pending applications and excludes scored or rejected candidates", () => {
    const oldPending = evaluation({
      recovery: {
        status: "unverified",
        attempts: [],
        serperQueries: 0,
        candidates: [
          {
            url: "https://www.builtinboston.com/job/software-engineer/9834227",
            source: "mcp",
            matchLevel: "low",
            text: "About the Role\nYou will own backend services.",
            completeness: "partial",
          },
          {
            url: "https://example.com/old",
            source: "mcp",
            matchLevel: "low",
            text: "Rejected posting",
            completeness: "full",
            reviewStatus: "rejected",
          },
        ],
      },
    });
    const scored = evaluation({
      key: "acme::scored",
      recovery: {
        status: "scored",
        attempts: [],
        serperQueries: 0,
        candidates: [{ url: "https://example.com/scored", source: "mcp", matchLevel: "high", text: "JD", completeness: "full" }],
      },
    });
    const rows = pendingReviewRowsFromEvaluations([oldPending, scored]);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.applicationKey).toBe("ooma::software engineer");
    expect(rows[0]?.appliedAt.startsWith("2026-06-22")).toBe(true);
    expect(rows[0]?.completeness).toBe("partial");
  });

  it("orders pending reviews newest application first while keeping older rows", () => {
    const older = evaluation({
      key: "ooma::software engineer",
      appliedAt: "2026-06-22T02:59:22.483Z",
      recovery: {
        status: "unverified",
        attempts: [],
        serperQueries: 0,
        candidates: [{ url: "https://example.com/ooma", source: "mcp", matchLevel: "low", text: "JD text for ooma", completeness: "partial" }],
      },
    });
    const newer = evaluation({
      key: "braze::engineer",
      company: "Braze",
      role: "Engineer",
      appliedAt: "2026-10-19T00:00:00.000Z",
      recovery: {
        status: "unverified",
        attempts: [],
        serperQueries: 0,
        candidates: [{ url: "https://example.com/braze", source: "mcp", matchLevel: "low", text: "JD text for braze", completeness: "full" }],
      },
    });
    const rows = pendingReviewRowsFromEvaluations([older, newer]);
    expect(rows.map((row) => row.applicationKey)).toEqual(["braze::engineer", "ooma::software engineer"]);
  });
});

describe("summarizeShadowDecisions", () => {
  it("counts false positives and false negatives without claiming precision", () => {
    const base = {
      decisionId: "d1",
      applicationKey: "a",
      candidateId: "https://example.com/1",
      decidedAt: "2026-10-29T12:00:00.000Z",
      evidenceSnapshot: snapshot({}),
    };
    const decisions = [
      {
        ...base,
        action: "confirmed",
        shadowAtDecision: assessShadowEligibility(snapshot({})),
      },
      {
        ...base,
        decisionId: "d2",
        action: "rejected",
        shadowAtDecision: assessShadowEligibility(snapshot({})),
      },
      {
        ...base,
        decisionId: "d3",
        action: "confirmed",
        shadowAtDecision: assessShadowEligibility(
          snapshot({ signals: { completeness: signal("mismatch"), postingDate: signal("unknown") }, candidate: { completeness: "partial" } }),
        ),
      },
    ] as JdReviewDecision[];
    const report = summarizeShadowDecisions(decisions);
    expect(report.shadowMode).toBe(true);
    expect(report.autoConfirmEnabled).toBe(false);
    expect(report.reviewed).toBe(3);
    expect(report.shadowEligible).toBe(2);
    expect(report.eligibleConfirmed).toBe(1);
    expect(report.falsePositives).toBe(1);
    expect(report.falseNegatives).toBe(1);
    expect(report.limitation).toMatch(/small sample|descriptive only/i);
  });
});
