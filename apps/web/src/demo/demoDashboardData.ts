import type { AgentPanel } from "../types/agent";
import type {
  ActionItem,
  CostSummary,
  EvaluationsResponse,
  GmailApplication,
  GmailStatus,
  InterviewBriefResponse,
  LlmFeature,
  UpcomingInterview,
} from "../types/gmail";
import type { InsightsPanel } from "../types/insights";

const iso = (daysFromNow: number, hour = 14, minute = 0) => {
  const d = new Date();
  d.setDate(d.getDate() + daysFromNow);
  d.setHours(hour, minute, 0, 0);
  return d.toISOString();
};

const DEMO_MAIL = "https://mail.example.com/demo";

const featureSpend = (
  calls: number,
  costUsd: number,
): Record<LlmFeature, { costUsd: number; calls: number }> => ({
  gmail_classify: { calls, costUsd },
  jd_recovery: { calls: 18, costUsd: 2.41 },
  top_jobs: { calls: 9, costUsd: 0.62 },
  agent: { calls: 6, costUsd: 0.28 },
  assistant: { calls: 4, costUsd: 0.19 },
  insights: { calls: 2, costUsd: 0.11 },
  other: { calls: 3, costUsd: 0.08 },
});

const scored = (
  fit: number,
  extras: Partial<NonNullable<GmailApplication["evaluation"]>> = {},
): NonNullable<GmailApplication["evaluation"]> => ({
  status: "scored",
  verifiedBy: "user",
  foundVia: "prospect",
  matchLevel: "high",
  url: "https://jobs.example.com/posting",
  fitTotal: fit,
  storedFitTotal: fit,
  recommendation: fit >= 80 ? "strong_apply" : fit >= 65 ? "apply" : fit >= 50 ? "stretch" : "weak",
  recommendedResume: fit >= 75 ? "AI" : "BASE",
  fitBreakdown: {
    capability: Math.min(92, fit + 4),
    survivability: 0.52,
    gapDock: fit < 60 ? 4 : 0,
    categories: {
      stackFit: fit >= 80 ? 17 : 13,
      levelFit: fit >= 70 ? 16 : 12,
      domainFit: 6,
      resumeStoryClarity: 8,
      functionalOverlap: 12,
      recruiterFriendliness: 10,
      careerValue: 7,
    },
    topMatch: "TypeScript product engineering with customer-facing delivery.",
    mainRisk: "Hiring bar may favor more years in this exact domain.",
  },
  ...extras,
});

export const DEMO_CANDIDATE = {
  name: "Alex Rivera",
  headline: "Software engineer · TypeScript / product",
  email: "alex.rivera@example.com",
  location: "Brooklyn, NY (demo)",
};

export const DEMO_STATUS: GmailStatus = {
  configured: true,
  connected: true,
  email: DEMO_CANDIDATE.email,
  lastSyncAt: iso(0, 9, 12),
  canCreateDrafts: true,
  autoSyncMinutes: 60,
};

const harborline: GmailApplication = {
  key: "demo::harborline-product-engineer",
  company: "Harborline",
  role: "Product Engineer",
  appliedAt: iso(-18),
  appliedAtKnown: true,
  appliedAtSource: "email",
  status: "interviewing",
  furthestStage: "interviewing",
  activelyInterviewing: true,
  lastUpdateAt: iso(-1, 16, 20),
  trackerJobId: "demo-tracker-harborline",
  trackerStatus: "interviewing",
  interviewRounds: [
    {
      number: 1,
      kind: "recruiter_screen",
      focus: "introductory call",
      interviewers: "Jordan Lee",
      startedAt: iso(-6, 11, 0),
      scheduledAt: iso(-6, 11, 0),
      durationMinutes: 30,
      cancelled: false,
      label: "Recruiter screen with Jordan Lee",
    },
    {
      number: 2,
      kind: "technical",
      focus: "system design",
      interviewers: "Sam Okonkwo",
      startedAt: iso(1, 14, 0),
      scheduledAt: iso(1, 14, 0),
      durationMinutes: 60,
      cancelled: false,
      label: "2nd round · technical with Sam Okonkwo",
    },
  ],
  emails: [
    {
      id: "e-hl-3",
      subject: "Harborline — technical round confirmed",
      from: "jordan@harborline.example",
      date: iso(-1, 16, 20),
      eventType: "interview",
      gmailUrl: DEMO_MAIL,
      round: 2,
    },
    {
      id: "e-hl-2",
      subject: "Harborline — recruiter screen",
      from: "jordan@harborline.example",
      date: iso(-6, 11, 5),
      eventType: "interview",
      gmailUrl: DEMO_MAIL,
      round: 1,
    },
    {
      id: "e-hl-1",
      subject: "Thanks for applying to Harborline",
      from: "jobs@harborline.example",
      date: iso(-18, 10, 0),
      eventType: "applied",
      gmailUrl: DEMO_MAIL,
    },
  ],
  evaluation: scored(84, {
    jdTitle: "Product Engineer",
    matchSignals: ["user_pasted_jd"],
  }),
};

const kestrel: GmailApplication = {
  key: "demo::kestrel-health-full-stack",
  company: "Kestrel Health",
  role: "Full-Stack Engineer",
  appliedAt: iso(-11),
  appliedAtKnown: true,
  appliedAtSource: "email",
  status: "assessment",
  furthestStage: "assessment",
  activelyInterviewing: false,
  lastUpdateAt: iso(-2, 9, 40),
  trackerJobId: "demo-tracker-kestrel",
  trackerStatus: "assessment",
  emails: [
    {
      id: "e-kh-2",
      subject: "Kestrel Health take-home (due Friday)",
      from: "talent@kestrelhealth.example",
      date: iso(-2, 9, 40),
      eventType: "assessment",
      gmailUrl: DEMO_MAIL,
    },
    {
      id: "e-kh-1",
      subject: "We received your application",
      from: "talent@kestrelhealth.example",
      date: iso(-11, 13, 12),
      eventType: "applied",
      gmailUrl: DEMO_MAIL,
    },
  ],
  evaluation: scored(76, { jdTitle: "Full-Stack Engineer", recommendedResume: "SWE" }),
};

const northwind: GmailApplication = {
  key: "demo::northwind-labs-fde",
  company: "Northwind Labs",
  role: "Forward Deployed Engineer",
  appliedAt: iso(-9),
  appliedAtKnown: true,
  appliedAtSource: "email",
  status: "interviewing",
  furthestStage: "interviewing",
  activelyInterviewing: true,
  lastUpdateAt: iso(0, 8, 15),
  trackerJobId: "demo-tracker-northwind",
  trackerStatus: "interviewing",
  interviewRounds: [
    {
      number: 1,
      kind: "recruiter_screen",
      focus: "introductory call",
      interviewers: "Priya Shah",
      startedAt: iso(-3, 15, 30),
      scheduledAt: iso(-3, 15, 30),
      durationMinutes: 30,
      cancelled: false,
      label: "Recruiter screen with Priya Shah",
    },
  ],
  emails: [
    {
      id: "e-nw-2",
      subject: "Northwind Labs — pick a time for the hiring-manager screen",
      from: "priya@northwindlabs.example",
      date: iso(0, 8, 15),
      eventType: "interview",
      gmailUrl: DEMO_MAIL,
    },
    {
      id: "e-nw-1",
      subject: "Application received — Forward Deployed Engineer",
      from: "careers@northwindlabs.example",
      date: iso(-9, 12, 0),
      eventType: "applied",
      gmailUrl: DEMO_MAIL,
    },
  ],
  evaluation: scored(81, { jdTitle: "Forward Deployed Engineer", recommendedResume: "AI" }),
};

const brightcanvas: GmailApplication = {
  key: "demo::brightcanvas-frontend",
  company: "Brightcanvas",
  role: "Frontend Engineer",
  appliedAt: iso(-22),
  appliedAtKnown: true,
  appliedAtSource: "email",
  status: "rejected",
  furthestStage: "interviewing",
  activelyInterviewing: false,
  lastUpdateAt: iso(-4, 17, 2),
  trackerJobId: "demo-tracker-brightcanvas",
  trackerStatus: "rejected",
  interviewRounds: [
    {
      number: 1,
      kind: "recruiter_screen",
      focus: "introductory call",
      interviewers: "Chris Ng",
      startedAt: iso(-12, 10, 0),
      scheduledAt: iso(-12, 10, 0),
      durationMinutes: 30,
      cancelled: false,
      label: "Recruiter screen with Chris Ng",
    },
  ],
  emails: [
    {
      id: "e-bc-3",
      subject: "Brightcanvas application update",
      from: "talent@brightcanvas.example",
      date: iso(-4, 17, 2),
      eventType: "rejected",
      gmailUrl: DEMO_MAIL,
    },
    {
      id: "e-bc-2",
      subject: "Brightcanvas recruiter screen",
      from: "chris@brightcanvas.example",
      date: iso(-12, 10, 0),
      eventType: "interview",
      gmailUrl: DEMO_MAIL,
      round: 1,
    },
    {
      id: "e-bc-1",
      subject: "Thanks for applying to Brightcanvas",
      from: "jobs@brightcanvas.example",
      date: iso(-22, 9, 30),
      eventType: "applied",
      gmailUrl: DEMO_MAIL,
    },
  ],
  evaluation: scored(71, { jdTitle: "Frontend Engineer", recommendedResume: "SWE" }),
};

const lumenfold: GmailApplication = {
  key: "demo::lumenfold-backend",
  company: "Lumenfold",
  role: "Backend Engineer",
  appliedAt: iso(-5),
  appliedAtKnown: true,
  appliedAtSource: "email",
  status: "applied",
  furthestStage: "applied",
  activelyInterviewing: false,
  lastUpdateAt: iso(-5, 11, 44),
  trackerJobId: "demo-tracker-lumenfold",
  trackerStatus: "applied",
  emails: [
    {
      id: "e-lf-1",
      subject: "We received your Lumenfold application",
      from: "hello@lumenfold.example",
      date: iso(-5, 11, 44),
      eventType: "applied",
      gmailUrl: DEMO_MAIL,
    },
  ],
  evaluation: scored(88, { jdTitle: "Backend Engineer", verifiedBy: "auto", foundVia: "mcp", matchLevel: "exact" }),
};

const oakCircuit: GmailApplication = {
  key: "demo::oak-circuit-swe",
  company: "Oak & Circuit",
  role: "Software Engineer II",
  appliedAt: iso(-7),
  appliedAtKnown: true,
  appliedAtSource: "email",
  status: "applied",
  furthestStage: "applied",
  activelyInterviewing: false,
  lastUpdateAt: iso(-3, 19, 10),
  emails: [
    {
      id: "e-oc-1",
      subject: "Thanks for applying to Oak & Circuit",
      from: "recruiting@oakcircuit.example",
      date: iso(-7, 15, 0),
      eventType: "applied",
      gmailUrl: DEMO_MAIL,
    },
  ],
  evaluation: {
    status: "unverified",
    jdTitle: "Software Engineer II",
    candidates: [
      {
        url: "https://jobs.example.com/oak-circuit/swe-ii-nyc",
        title: "Software Engineer II — NYC hybrid",
        location: "New York, NY (hybrid)",
        matchLevel: "high",
        source: "mcp",
        completeness: "full",
        sourceType: "company_site",
      },
      {
        url: "https://jobs.example.com/oak-circuit/swe-ii-remote",
        title: "Software Engineer II — Remote US",
        location: "Remote (US)",
        matchLevel: "high",
        source: "mcp",
        completeness: "full",
        sourceType: "company_site",
      },
    ],
  },
};

const vesper: GmailApplication = {
  key: "demo::vesper-analytics-data",
  company: "Vesper Analytics",
  role: "Software Engineer, Data Platform",
  appliedAt: iso(-14),
  appliedAtKnown: true,
  appliedAtSource: "tracker",
  status: "applied",
  furthestStage: "applied",
  activelyInterviewing: false,
  lastUpdateAt: iso(-14, 8, 0),
  emails: [
    {
      id: "e-va-1",
      subject: "Vesper Analytics application follow-up",
      from: "noreply@vesperanalytics.example",
      date: iso(-14, 8, 0),
      eventType: "other",
      gmailUrl: DEMO_MAIL,
    },
  ],
  evaluation: {
    status: "not_found",
    reason: "not_on_board",
    notes: ["not_on_board", "board_found_no_search"],
    boardChecks: [{ board: "greenhouse", jobs: 12, closestTitle: "Analytics Engineer", similarity: 0.42 }],
  },
};

const pinnacle: GmailApplication = {
  key: "demo::pinnacle-rail-offer",
  company: "Pinnacle Rail",
  role: "Software Engineer",
  appliedAt: iso(-40),
  appliedAtKnown: true,
  appliedAtSource: "email",
  status: "offer",
  furthestStage: "offer",
  activelyInterviewing: false,
  lastUpdateAt: iso(-1, 11, 0),
  trackerJobId: "demo-tracker-pinnacle",
  trackerStatus: "offer",
  interviewRounds: [
    {
      number: 1,
      kind: "recruiter_screen",
      focus: "introductory call",
      interviewers: "Morgan Ellis",
      startedAt: iso(-28, 13, 0),
      scheduledAt: iso(-28, 13, 0),
      durationMinutes: 30,
      cancelled: false,
      label: "Recruiter screen with Morgan Ellis",
    },
    {
      number: 2,
      kind: "onsite",
      focus: "loop",
      interviewers: "eng panel",
      startedAt: iso(-8, 10, 0),
      scheduledAt: iso(-8, 10, 0),
      durationMinutes: 180,
      cancelled: false,
      label: "2nd round · onsite loop",
    },
  ],
  emails: [
    {
      id: "e-pr-4",
      subject: "Pinnacle Rail — offer details",
      from: "morgan@pinnaclerail.example",
      date: iso(-1, 11, 0),
      eventType: "offer",
      gmailUrl: DEMO_MAIL,
    },
    {
      id: "e-pr-1",
      subject: "Thanks for applying to Pinnacle Rail",
      from: "jobs@pinnaclerail.example",
      date: iso(-40, 9, 0),
      eventType: "applied",
      gmailUrl: DEMO_MAIL,
    },
  ],
  evaluation: scored(79, { jdTitle: "Software Engineer" }),
};

export const DEMO_APPLICATIONS: GmailApplication[] = [
  northwind,
  harborline,
  kestrel,
  pinnacle,
  lumenfold,
  oakCircuit,
  brightcanvas,
  vesper,
];

export const DEMO_UPCOMING: UpcomingInterview[] = [
  {
    key: harborline.key,
    company: harborline.company,
    role: harborline.role,
    roundNumber: 2,
    label: "2nd round · technical with Sam Okonkwo",
    scheduledAt: iso(1, 14, 0),
    durationMinutes: 60,
    gmailUrl: DEMO_MAIL,
  },
];

export const DEMO_ACTIONS: ActionItem[] = [
  {
    key: northwind.key,
    company: northwind.company,
    role: northwind.role,
    emailId: "e-nw-2",
    threadId: "t-nw-2",
    type: "schedule",
    summary: "Pick a time for the hiring-manager screen",
    deadline: iso(2, 17, 0),
    receivedAt: iso(0, 8, 15),
    gmailUrl: DEMO_MAIL,
  },
  {
    key: kestrel.key,
    company: kestrel.company,
    role: kestrel.role,
    emailId: "e-kh-2",
    threadId: "t-kh-2",
    type: "assessment",
    summary: "Finish the take-home (TypeScript service + writeup)",
    deadline: iso(2, 23, 0),
    receivedAt: iso(-2, 9, 40),
    gmailUrl: DEMO_MAIL,
  },
];

export const DEMO_BRIEFS: Record<string, InterviewBriefResponse> = {
  [harborline.key]: {
    key: harborline.key,
    company: "Harborline",
    role: "Product Engineer",
    round: "2nd round · technical with Sam Okonkwo",
    prepPrompt: "Demo prep prompt for Harborline technical round. Not a real interview.",
    brief: {
      companyBio:
        "Harborline is a fictional logistics platform that sells workflow software to mid-market shippers. This brief is sample content only.",
      teamNeed:
        "The product team wants an engineer who can ship TypeScript services and a React console, then sit with operators when a workflow breaks.",
      strengths: [
        {
          point: "End-to-end product delivery",
          evidence: "Sample resume: owned a customer-facing TypeScript service and the UI that operators used daily.",
        },
        {
          point: "Comfortable in the room with users",
          evidence: "Sample story: turned a messy intake process into a checked-in workflow after two on-site visits.",
        },
      ],
      weakPoints: [
        {
          gap: "Domain depth in freight ops",
          probe: "How would you learn our exception types in the first month?",
          answer:
            "I would sit with one operator lane, write down the five exception types they actually hit, and ship a tiny dashboard for those before proposing a broader model.",
        },
      ],
      askThem: [
        "Who owns the operator console today, and how often does engineering sit with that team?",
        "What does a successful first quarter look like for this seat?",
      ],
      generatedAt: iso(-1, 12, 0),
      promptVersion: "demo",
    },
  },
  [northwind.key]: {
    key: northwind.key,
    company: "Northwind Labs",
    role: "Forward Deployed Engineer",
    round: "Hiring-manager screen (unscheduled)",
    prepPrompt: "Demo prep prompt for Northwind Labs. Not a real interview.",
    brief: {
      companyBio:
        "Northwind Labs is a fictional applied-AI company that embeds engineers with design partners. Sample copy only.",
      teamNeed: "They want someone who can debug a brittle integration on-site and still write the production service.",
      strengths: [
        {
          point: "Customer-facing engineering",
          evidence: "Sample project: shipped an integration under a partner deadline, then wrote the runbook.",
        },
      ],
      weakPoints: [
        {
          gap: "Fewer years than the posted range",
          probe: "This listing asks for more industry time than you have. How do you ramp?",
          answer:
            "I treat the first two weeks as a written map: who the users are, which failures are expensive, and which service I can make boring first.",
        },
      ],
      askThem: ["How much of this role is on-site with the design partner versus in the core repo?"],
      generatedAt: iso(0, 8, 30),
      promptVersion: "demo",
    },
  },
};

const interval = (rate: number, lo: number, hi: number) => ({ rate, lo, hi });

export const DEMO_EVALUATIONS: EvaluationsResponse = {
  days: 30,
  run: { running: false, processed: 8, scored: 6, finishedAt: iso(-1, 18, 0) },
  serper: { used: 140, cap: 2500, configured: true },
  rubricSummary: {
    scored: 6,
    userVerified: 4,
    byRecoveryStatus: { scored: 6, unverified: 1, not_found: 1, fetch_failed: 0 },
    reachedInterview: { count: 4, meanFit: 79 },
    rows: [
      { outcome: "applied", count: 2, meanFit: 88 },
      { outcome: "assessment", count: 1, meanFit: 76 },
      { outcome: "interviewing", count: 2, meanFit: 83 },
      { outcome: "rejected", count: 1, meanFit: 71 },
      { outcome: "offer", count: 1, meanFit: 79 },
    ],
    points: {
      applied: [{ company: "Lumenfold", role: "Backend Engineer", fit: 88, verifiedBy: "auto" }],
      assessment: [{ company: "Kestrel Health", role: "Full-Stack Engineer", fit: 76, verifiedBy: "user" }],
      interviewing: [
        { company: "Harborline", role: "Product Engineer", fit: 84, verifiedBy: "user", furthestRound: { number: 2, label: "technical" } },
        { company: "Northwind Labs", role: "Forward Deployed Engineer", fit: 81, verifiedBy: "user" },
      ],
      rejected: [
        {
          company: "Brightcanvas",
          role: "Frontend Engineer",
          fit: 71,
          verifiedBy: "user",
          furthestStage: "interviewing",
          furthestRound: { number: 1, label: "recruiter screen" },
        },
      ],
      offer: [{ company: "Pinnacle Rail", role: "Software Engineer", fit: 79, verifiedBy: "user", furthestStage: "offer" }],
    },
  },
  metrics: {
    applications: 8,
    withUsefulData: 7,
    verifiedAuto: 2,
    userPicked: 3,
    userPasted: 1,
    needsPick: 1,
    notFound: 1,
    byBucket: {
      email: { verified: 1, candidatesOnly: 0 },
      company_board: { verified: 2, candidatesOnly: 1 },
      serper: { verified: 1, candidatesOnly: 0 },
      manual: { verified: 2, candidatesOnly: 0 },
    },
    serper: {
      jobsSearched: 12,
      jobsWithResults: 9,
      verified: 1,
      candidatesOnly: 0,
      queriesUsed: 140,
      budget: 2500,
      freeGrant: 2500,
    },
  },
  costs: {
    model: "gpt-5-mini",
    trackingSince: iso(-40, 9, 0),
    today: 0.14,
    last7Days: 1.88,
    windowDays: 30,
    windowTotal: 4.12,
    byFeature: featureSpend(42, 0.43),
    byDay: [],
    perScoredRole: 0.68,
    perEmailClassified: 0.02,
    thisMonth: {
      total: 3.55,
      byFeature: {
        gmail_classify: 0.43,
        jd_recovery: 2.41,
        top_jobs: 0.62,
        agent: 0.28,
        assistant: 0.19,
        insights: 0.11,
        other: 0.08,
      },
      budgets: { agent: 5, insights: 3 },
    },
  } satisfies CostSummary,
};

export const DEMO_INSIGHTS: InsightsPanel = {
  running: false,
  budget: { monthlyUsd: 3, spentThisMonthUsd: 0.11 },
  adjustments: [
    {
      id: "demo-adj-1",
      feature: "specialized",
      featureLabel: "Role type",
      bucket: "AI / FDE",
      points: 3,
      evidence: { k: 8, n: 18, rate: 0.44, restRate: 0.21, diffPp: 0.23, q: 0.04 },
      status: "proposed",
      createdAt: iso(-3),
      updatedAt: iso(-3),
    },
  ],
  run: {
    id: "demo-insights",
    trigger: "weekly",
    generatedAt: iso(-2, 7, 30),
    headline: "Higher fit scores are getting more callbacks in this sample. Specialized AI / FDE roles are the clearest cluster.",
    summary:
      "This is sample analysis for a fictional search. Among 42 decided demo applications, scored roles at 80+ heard back more often than weaker scores. Nothing here is a hiring rule.",
    counts: {
      applications: 48,
      positive: 11,
      negative: 31,
      tooEarly: 6,
      decided: 42,
      withFit: 36,
      withoutFit: 6,
      scoredCallbacks: 9,
      unscoredCallbacks: 2,
      confirmedApplied: 33,
      inferredApplied: 9,
      unscoredReasons: { not_found: 4, unverified: 2 },
    },
    baseRate: { k: 11, n: 42, ...interval(0.26, 0.15, 0.41) },
    scorePredicts: {
      auc: 0.71,
      p: 0.03,
      n: 36,
      k: 9,
      rate: interval(0.25, 0.13, 0.42),
      verdict: "suggestive",
      note: "In this demo sample, higher scores line up with more callbacks (AUC 0.71). Treat it as a sketch, not a rule.",
    },
    scoreBands: [
      { band: "Weak <50", k: 1, n: 6, rate: interval(0.17, 0.03, 0.56) },
      { band: "Stretch 50–64", k: 2, n: 9, rate: interval(0.22, 0.06, 0.55) },
      { band: "Apply 65–79", k: 3, n: 12, rate: interval(0.25, 0.09, 0.53) },
      { band: "Strong 80+", k: 3, n: 9, rate: interval(0.33, 0.12, 0.65) },
    ],
    screening: {
      seniority: [
        { bucket: "Junior / early career", k: 4, n: 16, rate: interval(0.25, 0.1, 0.49) },
        { bucket: "Mid", k: 6, n: 18, rate: interval(0.33, 0.16, 0.56) },
        { bucket: "Senior+", k: 1, n: 6, rate: interval(0.17, 0.03, 0.56) },
      ],
      seniorityUnknown: 2,
      degree: [
        { bucket: "Degree required", k: 5, n: 20, rate: interval(0.25, 0.11, 0.47) },
        { bucket: "Equivalency / none", k: 6, n: 18, rate: interval(0.33, 0.16, 0.56) },
      ],
      degreeUnknown: 4,
      specialized: { k: 5, n: 11, rate: interval(0.45, 0.21, 0.72), restK: 6, restN: 29 },
      specializedUnknown: 2,
      bySeniorityAndDegree: [
        { seniority: "Junior / early career", degree: "Equivalency / none", k: 3, n: 9, rate: interval(0.33, 0.12, 0.65) },
        { seniority: "Mid", degree: "Degree required", k: 4, n: 10, rate: interval(0.4, 0.17, 0.69) },
      ],
    },
    patterns: [
      {
        feature: "specialized",
        featureLabel: "Role type",
        bucket: "AI / FDE",
        scorable: true,
        k: 5,
        n: 11,
        rate: interval(0.45, 0.21, 0.72),
        restK: 6,
        restN: 29,
        restRate: 0.21,
        diffPp: 0.24,
        p: 0.04,
        q: 0.08,
        verdict: "suggestive",
      },
      {
        feature: "remote",
        featureLabel: "Workplace",
        bucket: "Hybrid",
        scorable: true,
        k: 7,
        n: 22,
        rate: interval(0.32, 0.16, 0.53),
        restK: 4,
        restN: 20,
        restRate: 0.2,
        diffPp: 0.12,
        p: 0.22,
        q: 0.4,
        verdict: "no_signal",
      },
    ],
    goodFit: {
      k: 6,
      n: 21,
      rate: interval(0.29, 0.14, 0.5),
      patterns: [],
    },
    proposals: [],
    conclusion: "suggestive",
    quietGoodFits: [
      { id: "demo-quiet-1", company: "Lumenfold", role: "Backend Engineer", fit: 88, appliedAt: iso(-5) },
      { id: "demo-quiet-2", company: "Kestrel Health", role: "Full-Stack Engineer", fit: 76, appliedAt: iso(-11) },
    ],
  },
};

export const DEMO_NEXT_STEPS: AgentPanel = {
  enabled: true,
  canCreateDrafts: false,
  lastRun: { at: iso(0, 9, 5), candidates: 6, written: 4, budgetLimited: false },
  budget: { monthlyUsd: 5, spentThisMonthUsd: 0.28 },
  suggestions: [
    {
      id: "demo-step-1",
      kind: "action_reply",
      appKey: northwind.key,
      company: "Northwind Labs",
      role: "Forward Deployed Engineer",
      title: "Reply to Northwind Labs with interview times",
      reason: "Priya asked for availability for a hiring-manager screen. Demo draft only.",
      priority: 6,
      dueAt: iso(1, 17, 0),
      gmailUrl: DEMO_MAIL,
      draftable: true,
      draft:
        "Hi Priya,\n\nThanks for the note — I'd be glad to talk with the hiring manager.\nI'm available Thursday 1–3pm ET or Friday 10am–12pm ET.\n\nBest,\nAlex Rivera",
      writtenBy: "agent",
      status: "open",
      createdAt: iso(0, 9, 5),
      updatedAt: iso(0, 9, 5),
    },
    {
      id: "demo-step-2",
      kind: "interview_prep",
      appKey: harborline.key,
      company: "Harborline",
      role: "Product Engineer",
      title: "Prep Harborline technical round (tomorrow)",
      reason: "60-minute system-design conversation with Sam Okonkwo.",
      priority: 5,
      dueAt: iso(1, 13, 0),
      gmailUrl: DEMO_MAIL,
      draftable: false,
      writtenBy: "rules",
      status: "open",
      createdAt: iso(0, 9, 5),
      updatedAt: iso(0, 9, 5),
    },
    {
      id: "demo-step-3",
      kind: "follow_up",
      appKey: lumenfold.key,
      company: "Lumenfold",
      role: "Backend Engineer",
      title: "Follow up with Lumenfold if still quiet Friday",
      reason: "Confirmation is five days old and there has been no recruiter reply.",
      priority: 3,
      dueAt: iso(2, 10, 0),
      draftable: true,
      draft:
        "Hi Lumenfold recruiting,\n\nI applied for Backend Engineer last week and wanted to confirm the application is in review.\nHappy to share anything else you need.\n\nThanks,\nAlex Rivera",
      writtenBy: "agent",
      status: "open",
      createdAt: iso(0, 9, 5),
      updatedAt: iso(0, 9, 5),
    },
    {
      id: "demo-step-4",
      kind: "thank_you",
      appKey: harborline.key,
      company: "Harborline",
      role: "Product Engineer",
      title: "Send Harborline thank-you after tomorrow's round",
      reason: "Draft a short note to Sam once the technical round ends.",
      priority: 2,
      dueAt: iso(1, 16, 0),
      draftable: true,
      draft:
        "Hi Sam,\n\nThanks for the system-design conversation today. I especially liked walking through how Harborline handles exception lanes.\nI'll send the short writeup we discussed.\n\nBest,\nAlex Rivera",
      writtenBy: "agent",
      status: "open",
      createdAt: iso(0, 9, 5),
      updatedAt: iso(0, 9, 5),
    },
  ],
};

export const DEMO_PENDING_RECOVERY = 1;
