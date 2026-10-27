import { describe, expect, it, vi } from "vitest";
import { analyzeInsights, comparePatterns } from "../../services/insights/analyze.js";
import { applyHistoryPoints, historyPoints, matchAdjustments } from "../../services/insights/applyAdjustments.js";
import {
  applyEvidenceOf,
  buildInsightRows,
  classifyOutcome,
  trackerAppliedAt,
  unscoredReasonOf,
  type InsightRow,
} from "../../services/insights/dataset.js";
import { mapSpreadsheetStatusToJobStatus } from "../../tracker/canonicalSpreadsheet.js";
import type { ApplicationEvaluation } from "../../services/gmail/jdRecovery/evaluations.repository.js";
import { degreeBucketOf, isSpecializedAiFde, screeningSeniority, type Feature } from "../../services/insights/features.js";
import type { ScoringAdjustment } from "../../services/insights/insights.repository.js";
import { buildSummaryPrompt, runInsights, syncAdjustments, type InsightsDeps } from "../../services/insights/insights.js";
import { auc, aucPermutationP, benjaminiHochberg, fisherExact, wilson } from "../../services/insights/stats.js";
import { recomputeStoredJobScore } from "../../lib/recomputeStoredJobScore.js";
import type { GmailApplication } from "../../services/gmail/gmailApplications.js";
import type { ExtractedJobData, JobRecord } from "../../types/job.js";

const NOW = Date.parse("2026-10-01T12:00:00.000Z");
const daysAgo = (d: number) => new Date(NOW - d * 86_400_000).toISOString();

describe("insights stats", () => {
  it("wilson interval matches known values", () => {
    const half = wilson(5, 10);
    expect(half.lo).toBeCloseTo(0.2366, 3);
    expect(half.hi).toBeCloseTo(0.7634, 3);
    const none = wilson(0, 10);
    expect(none.lo).toBe(0);
    expect(none.hi).toBeCloseTo(0.2775, 3);
    expect(wilson(0, 0)).toEqual({ rate: 0, lo: 0, hi: 0 });
  });

  it("fisher exact matches the tea-tasting and perfect-split tables", () => {
    expect(fisherExact(3, 1, 1, 3)).toBeCloseTo(0.4857, 3);
    expect(fisherExact(10, 0, 0, 10)).toBeCloseTo(1.0825e-5, 8);
    expect(fisherExact(0, 0, 0, 0)).toBe(1);
  });

  it("benjamini-hochberg keeps input order and is monotone", () => {
    const q = benjaminiHochberg([0.01, 0.04, 0.03, 0.2]);
    expect(q[0]).toBeCloseTo(0.04, 6);
    expect(q[1]).toBeCloseTo(0.0533, 3);
    expect(q[2]).toBeCloseTo(0.0533, 3);
    expect(q[3]).toBeCloseTo(0.2, 6);
  });

  it("auc and its permutation p-value", () => {
    expect(auc([3, 4, 1, 2], [true, true, false, false])).toBe(1);
    expect(auc([1, 2, 3, 4], [true, true, false, false])).toBe(0);
    expect(auc([5, 5], [true, false])).toBe(0.5);
    const scores = Array.from({ length: 20 }, (_, i) => i);
    const labels = scores.map((s) => s >= 10);
    const p = aucPermutationP(scores, labels, 500);
    expect(p).toBeLessThan(0.01);
    expect(aucPermutationP(scores, labels, 500)).toBe(p);
  });
});

describe("classifyOutcome", () => {
  const gmail = (over: Partial<GmailApplication>) =>
    ({ company: "Acme", furthestStage: "applied", status: "applied", interviewRounds: [], emails: [], ...over }) as GmailApplication;
  const email = (from: string, subject: string, eventType: "interview" | "applied" = "interview") =>
    ({ id: subject, subject, from, date: daysAgo(5), eventType, gmailUrl: "" }) as GmailApplication["emails"][number];
  const booked = [{ number: 1, scheduledAt: daysAgo(4), cancelled: false }] as GmailApplication["interviewRounds"];

  it("counts any human contact as positive", () => {
    expect(
      classifyOutcome(
        { gmail: gmail({ furthestStage: "interviewing", emails: [email("Jane <jane@acme.com>", "Interview availability")] }), appliedAt: daysAgo(5) },
        NOW,
      ).outcome,
    ).toBe("positive");
    expect(
      classifyOutcome({ trackerStatus: "rejected", trackerHistory: ["applied", "interviewing", "rejected"], appliedAt: daysAgo(60) }, NOW)
        .outcome,
    ).toBe("positive");
  });

  it("assessments alone, rejections, lapses and 30+ days of silence are negative", () => {
    expect(classifyOutcome({ trackerStatus: "assessment", appliedAt: daysAgo(40) }, NOW).outcome).toBe("negative");
    expect(classifyOutcome({ gmail: gmail({ status: "rejected" }), appliedAt: daysAgo(3) }, NOW).outcome).toBe("negative");
    expect(classifyOutcome({ trackerStatus: "lapsed", appliedAt: daysAgo(10) }, NOW).outcome).toBe("negative");
    expect(classifyOutcome({ trackerStatus: "applied", appliedAt: daysAgo(31) }, NOW).outcome).toBe("negative");
  });

  it("your 'heard back' marker counts as human contact", () => {
    expect(classifyOutcome({ trackerStatus: "rejected", reachedHuman: true, appliedAt: daysAgo(90) }, NOW).outcome).toBe(
      "positive",
    );
  });

  it("your 'no call' marker overrides Gmail", () => {
    const interviewed = gmail({ furthestStage: "interviewing", interviewRounds: booked });
    expect(classifyOutcome({ gmail: interviewed, reachedHuman: false, appliedAt: daysAgo(90) }, NOW).outcome).toBe("negative");
  });

  it("an automated email labeled as an interview is not human contact", () => {
    const noto = gmail({
      furthestStage: "interviewing",
      emails: [email("Ashby <no-reply@ashbyhq.com>", "Thanks for applying to Noto")],
      interviewRounds: [{ number: 1, scheduledAt: null, cancelled: false }] as GmailApplication["interviewRounds"],
    });
    expect(classifyOutcome({ gmail: noto, appliedAt: daysAgo(60) }, NOW).outcome).toBe("negative");
  });

  it("a staffing agency only counts once it books an interview with the employer", () => {
    const outreach = gmail({
      company: "Morgan Pinnacle Group",
      furthestStage: "interviewing",
      emails: [email("Aldo <aldo.r@mpgstaff.com>", "Next Steps for Your Software Engineer Application")],
    });
    expect(classifyOutcome({ gmail: outreach, appliedAt: daysAgo(60) }, NOW).outcome).toBe("negative");
    const jobot = gmail({ company: "Jobot", furthestStage: "interviewing", emails: [email("Jeni <jeni@connect.jobot.com>", "Quick Call")] });
    expect(classifyOutcome({ gmail: jobot, appliedAt: daysAgo(60) }, NOW).outcome).toBe("negative");
    const screening = gmail({
      company: "MPGStaff",
      furthestStage: "interviewing",
      emails: [email("Aldo <aldo.r@mpgstaff.com>", "Invitation: Initial Screening @ Fri Jul 24, 2026 3:30pm")],
      interviewRounds: [{ ...booked[0]!, kind: "recruiter_screen" }],
    });
    expect(classifyOutcome({ gmail: screening, appliedAt: daysAgo(60) }, NOW).outcome).toBe("negative");
    const withEmployer = gmail({ ...screening, interviewRounds: [{ ...booked[0]!, kind: "hiring_manager" }] });
    expect(classifyOutcome({ gmail: withEmployer, appliedAt: daysAgo(60) }, NOW).outcome).toBe("positive");
  });

  it("recent silence is too early", () => {
    expect(classifyOutcome({ trackerStatus: "applied", appliedAt: daysAgo(10) }, NOW).outcome).toBe("too_early");
  });
});

const job = (id: string, over: Partial<JobRecord> = {}): JobRecord =>
  ({
    id,
    extracted: { company: `Co ${id}`, title: "Software Engineer", remoteType: "remote" },
    rules: {},
    score: { total: 70 },
    status: "applied",
    statusHistory: [{ toStatus: "applied", createdAt: daysAgo(45) }],
    createdAt: daysAgo(50),
    updatedAt: daysAgo(45),
    ...over,
  }) as unknown as JobRecord;

const app = (key: string, over: Partial<GmailApplication> = {}): GmailApplication =>
  ({
    key,
    company: `Co ${key}`,
    role: "Software Engineer",
    appliedAt: daysAgo(40),
    status: "applied",
    furthestStage: "applied",
    interviewRounds: [],
    emails: [],
    ...over,
  }) as GmailApplication;

describe("spreadsheet outcome mapping", () => {
  it("treats panel and screen outcomes as interviewing, and rejection after a screen as rejected", () => {
    expect(mapSpreadsheetStatusToJobStatus("Final panel completed / awaiting decision")).toBe("interviewing");
    expect(mapSpreadsheetStatusToJobStatus("Recruiter screen scheduled")).toBe("interviewing");
    expect(mapSpreadsheetStatusToJobStatus("Rejected after recruiter screen")).toBe("rejected");
    expect(mapSpreadsheetStatusToJobStatus("Applied/Discussed")).toBe("applied");
  });
});

describe("buildInsightRows", () => {
  it("counts a Gmail application linked to a tracker job once, and skips roles never applied to", () => {
    const rows = buildInsightRows(
      {
        jobs: [job("a"), job("b"), job("never", { status: "to_review", statusHistory: [] })],
        apps: [app("x", { trackerJobId: "a" }), app("y", { trackerJobId: "a" }), app("z")],
        evaluations: new Map(),
      },
      NOW,
    );
    expect(rows.map((r) => `${r.id}:${r.source}`).sort()).toEqual(["a:tracker+gmail", "b:tracker", "z:gmail"]);
  });

  it("imported rows use the spreadsheet's applied date, not the import time", () => {
    expect(trackerAppliedAt(job("n", { tracker: { notes: "Applied on 2026-01-07. Screen later." } } as Partial<JobRecord>))).toBe(
      "2026-01-07T12:00:00.000Z",
    );
    expect(
      trackerAppliedAt(job("d", { tracker: {}, trackerSpreadsheet: { discussed: "2026-03-25" } } as Partial<JobRecord>)),
    ).toBe("2026-03-25T12:00:00.000Z");
    expect(trackerAppliedAt(job("h", { tracker: {} } as Partial<JobRecord>))).toBe(daysAgo(45));
  });

  it("skips role-less leftover mail from a company that already has an application", () => {
    const rows = buildInsightRows(
      {
        jobs: [job("pub", { extracted: { company: "The New York Times", title: "Software Engineer, Publishing" } } as Partial<JobRecord>)],
        apps: [
          app("nyt::", { company: "The New York Times", role: null }),
          app("solo::", { company: "CM Search", role: null }),
        ],
        evaluations: new Map(),
      },
      NOW,
    );
    expect(rows.map((r) => r.id).sort()).toEqual(["pub", "solo::"]);
  });

  it("uses the tracker job's score when linked", () => {
    const [row] = buildInsightRows({ jobs: [job("a")], apps: [app("x", { trackerJobId: "a" })], evaluations: new Map() }, NOW);
    expect(row!.fit).toBe(70);
  });
});

const flag: Feature = {
  key: "flag",
  label: "Flag",
  scorable: true,
  values: (s) => [(s as InsightRow & { flag?: boolean }).flag ? "Yes" : "No"],
};

const row = (i: number, positive: boolean, flagged: boolean, fit: number | null = 70): InsightRow =>
  ({
    id: `r${i}`,
    company: `Co ${i}`,
    role: null,
    appliedAt: daysAgo(60),
    outcome: positive ? "positive" : "negative",
    outcomeReason: "",
    source: "tracker",
    fit,
    addedFromGmail: false,
    applyEvidence: "confirmed",
    flag: flagged,
  }) as InsightRow;

const extracted = (over: Partial<ExtractedJobData> = {}): ExtractedJobData => ({
  company: "Acme",
  title: "Software Engineer",
  stack: [],
  requiredSkills: [],
  preferredSkills: [],
  domainTags: [],
  ...over,
});

describe("comparePatterns", () => {
  it("calls a strong, well-sampled difference conclusive", () => {
    const rows = [
      ...Array.from({ length: 30 }, (_, i) => row(i, i < 15, true)),
      ...Array.from({ length: 30 }, (_, i) => row(100 + i, i < 1, false)),
    ];
    const yes = comparePatterns(rows, [flag]).find((p) => p.bucket === "Yes")!;
    expect(yes.verdict).toBe("conclusive");
    expect(yes.diffPp).toBeGreaterThan(40);
  });

  it("finds no signal when rates are equal", () => {
    const rows = [
      ...Array.from({ length: 30 }, (_, i) => row(i, i < 3, true)),
      ...Array.from({ length: 30 }, (_, i) => row(100 + i, i < 3, false)),
    ];
    expect(comparePatterns(rows, [flag]).every((p) => p.verdict === "no_signal")).toBe(true);
  });

  it("needs enough positives before calling a pattern", () => {
    const rows = [
      ...Array.from({ length: 15 }, (_, i) => row(i, i < 3, true)),
      ...Array.from({ length: 200 }, (_, i) => row(100 + i, false, false)),
    ];
    expect(comparePatterns(rows, [flag]).every((p) => p.verdict === "no_signal")).toBe(true);
  });

  it("leads with the score when the score separates callbacks", () => {
    const rows = [
      ...Array.from({ length: 60 }, (_, i) => row(i, i < 12, i % 2 === 0, 85)),
      ...Array.from({ length: 60 }, (_, i) => row(100 + i, false, i % 2 === 0, 40)),
    ];
    const result = analyzeInsights(rows, new Date(NOW));
    expect(result.scorePredicts.verdict).toBe("conclusive");
    expect(result.scorePredicts.k).toBe(12);
    expect(result.scorePredicts.n).toBe(120);
    expect(result.headline).toMatch(/associated with more callbacks/);
    expect(result.headline).toMatch(/small number of outcomes/);
    expect(result.headline).not.toMatch(/^Conclusive/);
    expect(result.scorePredicts.note).toMatch(/12 of 120 scored/);
    expect(result.scorePredicts.note).toMatch(/95% range/);
  });

  it("says it looks like chance when nothing is conclusive", () => {
    const rows = Array.from({ length: 100 }, (_, i) => row(i, i % 50 === 0, i % 2 === 0));
    const result = analyzeInsights(rows, new Date(NOW));
    expect(result.conclusion).toBe("no_signal");
    expect(result.headline).toMatch(/chance/);
    expect(result.proposals).toEqual([]);
  });

  it("splits mid-size from unknown employer and reports unclassified n", () => {
    const mid = Array.from({ length: 20 }, (_, i) => ({
      ...row(i, i < 8, false),
      extracted: extracted({ company: "MidCo", companyEmployeeCount: 800 }),
    }));
    const unknown = Array.from({ length: 20 }, (_, i) => ({
      ...row(100 + i, i < 1, false),
      extracted: extracted({ company: "Mystery Co" }),
    }));
    const blank = Array.from({ length: 6 }, (_, i) => row(200 + i, false, false));
    const patterns = comparePatterns([...mid, ...unknown, ...blank]);
    const employer = patterns.filter((p) => p.feature === "employer");
    expect(employer.map((p) => p.bucket).sort()).toEqual(["Mid-size", "Unknown"]);
    expect(employer.every((p) => p.unknownN === 6)).toBe(true);
  });
});

describe("coverage and apply evidence", () => {
  it("marks tracker applied dates and Gmail applied emails as confirmed", () => {
    expect(applyEvidenceOf({ trackerConfirmed: true })).toBe("confirmed");
    expect(applyEvidenceOf({ gmailSource: "email" })).toBe("confirmed");
    expect(applyEvidenceOf({ gmailSource: "tracker" })).toBe("confirmed");
    expect(applyEvidenceOf({ gmailSource: "estimated" })).toBe("inferred");
    expect(applyEvidenceOf({})).toBe("inferred");
  });

  it("maps stored recovery reasons and does not invent ones", () => {
    expect(unscoredReasonOf({ fit: 70, hasExtracted: true, source: "tracker" })).toBeUndefined();
    expect(unscoredReasonOf({ fit: null, hasExtracted: true, source: "tracker" })).toBe("tracker_never_scored");
    expect(unscoredReasonOf({ fit: null, hasExtracted: false, source: "tracker" })).toBe("no_jd");
    expect(unscoredReasonOf({ fit: null, hasExtracted: false, source: "gmail" })).toBe("no_jd");
    expect(unscoredReasonOf({ fit: null, hasExtracted: false, source: "gmail", recovery: { status: "not_found" } })).toBe(
      "not_found",
    );
    expect(unscoredReasonOf({ fit: null, hasExtracted: false, source: "gmail", recovery: { status: "fetch_failed" } })).toBe(
      "fetch_failed",
    );
    expect(unscoredReasonOf({ fit: null, hasExtracted: false, source: "gmail", recovery: { status: "unverified" } })).toBe(
      "unverified",
    );
    expect(
      unscoredReasonOf({
        fit: null,
        hasExtracted: true,
        source: "gmail",
        recovery: { status: "unverified", reason: "triage_failed: timeout" },
      }),
    ).toBe("triage_failed");
  });

  it("records confirmed vs inferred apply dates and why rows have no score", () => {
    const rows = buildInsightRows(
      {
        jobs: [
          job("dated", { tracker: { appliedAt: daysAgo(40) } }),
          job("guess", { statusHistory: [], score: undefined }),
        ],
        apps: [
          app("mail", { company: "Mail Co", appliedAtSource: "email" }),
          app("est", { company: "Est Co", appliedAtSource: "estimated" }),
        ],
        evaluations: new Map([
          [
            "est",
            {
              key: "est",
              company: "Est Co",
              role: "Software Engineer",
              appliedAt: daysAgo(40),
              recovery: { status: "not_found", attempts: [], serperQueries: 0 },
            } as unknown as ApplicationEvaluation,
          ],
        ]),
      },
      NOW,
    );
    const byId = new Map(rows.map((r) => [r.id, r]));
    expect(byId.get("dated")?.applyEvidence).toBe("confirmed");
    expect(byId.get("guess")?.applyEvidence).toBe("inferred");
    expect(byId.get("guess")?.unscoredReason).toBe("tracker_never_scored");
    expect(byId.get("mail")?.applyEvidence).toBe("confirmed");
    expect(byId.get("est")?.applyEvidence).toBe("inferred");
    expect(byId.get("est")?.unscoredReason).toBe("not_found");
    expect(byId.get("est")?.fit).toBeNull();

    const analysis = analyzeInsights(rows, new Date(NOW));
    expect(analysis.counts.decided).toBe(rows.length);
    expect(analysis.counts.withFit).toBe(1);
    expect(analysis.counts.withoutFit).toBe(3);
    expect(analysis.counts.confirmedApplied).toBe(2);
    expect(analysis.counts.inferredApplied).toBe(2);
    expect(analysis.counts.unscoredReasons).toMatchObject({ tracker_never_scored: 1, not_found: 1, no_jd: 1 });
  });
});

describe("seniority and screening", () => {
  it("buckets campus, junior, mid, and senior from title and years, not a new classifier", () => {
    expect(screeningSeniority({ fit: null, extracted: extracted({ title: "New Grad Software Engineer" }) })).toBe(
      "Campus / new-grad",
    );
    expect(screeningSeniority({ fit: null, rules: { strictNewGradPipeline: true } as InsightRow["rules"] })).toBe(
      "Campus / new-grad",
    );
    expect(screeningSeniority({ fit: null, extracted: extracted({ title: "Software Engineer I" }) })).toBe("Junior / SWE I");
    expect(screeningSeniority({ fit: null, extracted: extracted({ title: "Junior Engineer", yearsExperience: { min: 0 } }) })).toBe(
      "Junior / SWE I",
    );
    expect(screeningSeniority({ fit: null, extracted: extracted({ title: "Software Engineer" }) })).toBe(
      "Mid / SWE II / unlabeled",
    );
    expect(screeningSeniority({ fit: null, extracted: extracted({ title: "Senior Software Engineer" }) })).toBe("Senior / lead");
    expect(screeningSeniority({ fit: null, extracted: extracted({ title: "Staff Engineer", yearsExperience: { min: 6 } }) })).toBe(
      "Senior / lead",
    );
    expect(screeningSeniority({ fit: null })).toBeNull();
  });

  it("treats AI / FDE as a cross-cut and degree as required vs equivalent vs none", () => {
    expect(degreeBucketOf({ fit: null, extracted: extracted({ degreeRequirement: { level: "required" } }) })).toBe("Required");
    expect(degreeBucketOf({ fit: null, extracted: extracted({ degreeRequirement: { level: "equivalent_allowed" } }) })).toBe(
      "Preferred / equivalent",
    );
    expect(degreeBucketOf({ fit: null, extracted: extracted() })).toBe("None stated");
    expect(degreeBucketOf({ fit: null })).toBeNull();
    expect(isSpecializedAiFde({ fit: null, extracted: extracted({ title: "Forward Deployed Engineer", domainTags: ["saas"] }) })).toBe(
      true,
    );
    expect(isSpecializedAiFde({ fit: null, extracted: extracted({ title: "Junior Software Engineer", domainTags: ["ai"] }) })).toBe(
      true,
    );
    expect(isSpecializedAiFde({ fit: null, extracted: extracted({ title: "Software Engineer" }) })).toBe(false);
    expect(isSpecializedAiFde({ fit: null })).toBeNull();
  });

  it("builds a seniority table with degree cross and AI/FDE counts", () => {
    const rows: InsightRow[] = [
      { ...row(0, true, false), extracted: extracted({ title: "New Grad Engineer" }) },
      { ...row(1, false, false), extracted: extracted({ title: "Campus Software Engineer" }) },
      { ...row(2, true, false), extracted: extracted({ title: "Software Engineer I", degreeRequirement: { level: "required" } }) },
      { ...row(3, false, false), extracted: extracted({ title: "Junior Engineer" }) },
      { ...row(4, false, false), extracted: extracted({ title: "Software Engineer" }) },
      { ...row(5, true, false), extracted: extracted({ title: "Senior Engineer", degreeRequirement: { level: "preferred" } }) },
      {
        ...row(6, true, false),
        extracted: extracted({ title: "Junior Forward Deployed Engineer", domainTags: ["ai"] }),
      },
      row(7, false, false),
    ];
    const result = analyzeInsights(rows, new Date(NOW));
    const byBucket = Object.fromEntries(result.screening.seniority.map((c) => [c.bucket, c]));
    expect(byBucket["Campus / new-grad"]).toMatchObject({ n: 2, k: 1 });
    expect(byBucket["Junior / SWE I"]).toMatchObject({ n: 3, k: 2 });
    expect(byBucket["Mid / SWE II / unlabeled"]).toMatchObject({ n: 1, k: 0 });
    expect(byBucket["Senior / lead"]).toMatchObject({ n: 1, k: 1 });
    expect(result.screening.seniorityUnknown).toBe(1);
    expect(result.screening.degree.find((d) => d.bucket === "Required")).toMatchObject({ n: 1, k: 1 });
    expect(result.screening.specialized).toMatchObject({ n: 1, k: 1, restN: 6 });
    expect(result.screening.specializedUnknown).toBe(1);
    expect(result.screening.bySeniorityAndDegree.some((c) => c.seniority === "Junior / SWE I" && c.degree === "Required" && c.n === 1)).toBe(
      true,
    );
  });
});

describe("weekly summary prompt", () => {
  it("feeds coverage, seniority, and unknown n into the existing summary call", () => {
    const rows = [
      { ...row(0, true, false, 80), extracted: extracted({ title: "Senior Engineer" }) },
      { ...row(1, false, false, null), applyEvidence: "inferred" as const, unscoredReason: "no_jd" as const },
      { ...row(2, false, false, 40), extracted: extracted({ title: "Software Engineer I" }) },
    ];
    const prompt = buildSummaryPrompt(analyzeInsights(rows, new Date(NOW)));
    expect(prompt).toMatch(/Coverage: 2 scored, 1 without a score \(no_jd 1\)/);
    expect(prompt).toMatch(/applied evidence 2 confirmed \/ 1 inferred/);
    expect(prompt).toMatch(/Seniority \(applied \/ callbacks\):/);
    expect(prompt).toMatch(/Junior \/ SWE I 0\/1/);
    expect(prompt).toMatch(/Specialized AI\/FDE:/);
    expect(prompt).toMatch(/Do not call the whole analysis conclusive/);
  });
});

const adj = (over: Partial<ScoringAdjustment>): ScoringAdjustment => ({
  id: "location=Remote",
  feature: "location",
  featureLabel: "Location / work model",
  bucket: "Remote",
  points: 3,
  evidence: { k: 10, n: 40, rate: 0.25, restRate: 0.05, diffPp: 20, q: 0.01 },
  status: "approved",
  createdAt: daysAgo(5),
  updatedAt: daysAgo(5),
  ...over,
});

describe("scoring adjustments", () => {
  const remote = { fit: 70, extracted: { remoteType: "remote" } } as Parameters<typeof matchAdjustments>[0];

  it("applies only approved, scorable, matching adjustments, each capped at ±4", () => {
    const matched = matchAdjustments(remote, [
      adj({ points: 9 }),
      adj({ id: "location=NYC onsite", bucket: "NYC onsite" }),
      adj({ id: "p", status: "proposed" }),
      adj({ id: "weekday=Friday", feature: "weekday", bucket: "Friday" }),
    ]);
    expect(matched).toEqual([{ id: "location=Remote", label: "Location / work model: Remote", points: 4 }]);
  });

  it("caps the total at ±8 and keeps the score within 0-100", () => {
    const many = [1, 2, 3].map((i) => ({ id: `${i}`, label: "", points: 4 }));
    expect(historyPoints(many)).toBe(8);
    expect(historyPoints(many.map((a) => ({ ...a, points: -4 })))).toBe(-8);
    expect(applyHistoryPoints(97, many)).toBe(100);
    expect(applyHistoryPoints(70, [])).toBe(70);
  });

  it("sync keeps your decisions: dismissed stays dismissed, approved keeps its points, unsupported proposals withdraw", () => {
    const now = daysAgo(0);
    const existing = [
      adj({ id: "a", status: "dismissed" }),
      adj({ id: "b", status: "approved", points: 2 }),
      adj({ id: "c", status: "proposed" }),
    ];
    const proposals = [
      { ...adj({ id: "a" }), points: 4 },
      { ...adj({ id: "b" }), points: 4 },
      { ...adj({ id: "d" }), points: -2 },
    ].map(({ status: _s, createdAt: _c, updatedAt: _u, ...p }) => p);
    const out = new Map(syncAdjustments(existing, proposals, now).map((a) => [a.id, a]));
    expect(out.get("a")!.status).toBe("dismissed");
    expect(out.get("b")).toMatchObject({ status: "approved", points: 2 });
    expect(out.get("c")!.status).toBe("withdrawn");
    expect(out.get("d")).toMatchObject({ status: "proposed", points: -2 });
  });

  it("recomputing a stored job re-applies its own frozen adjustments, never new ones", () => {
    const extracted: ExtractedJobData = {
      company: "Acme",
      title: "Software Engineer",
      location: "Remote",
      remoteType: "remote",
      stack: ["TypeScript", "Node.js"],
      requiredSkills: ["TypeScript"],
      preferredSkills: [],
      domainTags: ["saas"],
      rawText: "Acme — Software Engineer\nRemote\n2+ years of TypeScript.",
    };
    const base = job("s", {
      extracted,
      rules: { notes: [], hardRuleNotes: [] } as unknown as JobRecord["rules"],
      score: {
        stackFit: 16,
        levelFit: 14,
        domainFit: 7,
        resumeStoryClarity: 8,
        functionalOverlap: 12,
        recruiterFriendliness: 10,
        careerValue: 6,
        total: 70,
      },
      recommendedResume: "BASE",
    });
    const plain = recomputeStoredJobScore({ job: base });
    const frozen = [{ id: "location=Remote", label: "Location / work model: Remote", points: 3 }];
    const withFrozen = recomputeStoredJobScore({ job: { ...base, score: { ...base.score, historyAdjustments: frozen } } });
    expect(plain.score.scoreDisplay?.hardGates ?? []).toEqual([]);
    expect(withFrozen.score.total).toBeCloseTo(Math.min(100, plain.score.total + 3), 5);
    expect(withFrozen.score.historyAdjustments).toEqual(frozen);
    expect(plain.score.historyAdjustments).toBeUndefined();
  });
});

describe("runInsights", () => {
  const deps = (allowedUnits: number): InsightsDeps & { saved: ScoringAdjustment[] } => {
    const saved: ScoringAdjustment[] = [];
    return {
      saved,
      compute: async () => ({ ...analyzeInsights([], new Date(NOW)), quietGoodFits: [] }),
      loadBudget: async () => ({
        monthlyUsd: 0.3,
        spentThisMonthUsd: 0,
        todayAllowanceUsd: allowedUnits * 0.01,
        allowedUnits,
        exhausted: false,
      }),
      summarize: vi.fn(async () => "Plain summary"),
      latestRun: async () => null,
      saveRun: vi.fn(async () => {}),
      listAdjustments: async () => [],
      saveAdjustment: async (a) => {
        saved.push(a);
      },
    };
  };

  it("skips the paid summary when the budget is spent", async () => {
    const d = deps(0);
    const run = await runInsights("manual", d, new Date(NOW));
    expect(d.summarize).not.toHaveBeenCalled();
    expect(run.summary).toBeUndefined();
    expect(d.saveRun).toHaveBeenCalledOnce();
  });

  it("adds the summary when the budget allows", async () => {
    const run = await runInsights("weekly", deps(1), new Date(NOW));
    expect(run.summary).toBe("Plain summary");
    expect(run.trigger).toBe("weekly");
  });
});
