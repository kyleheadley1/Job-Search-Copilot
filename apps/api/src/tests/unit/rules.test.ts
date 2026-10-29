import { describe, expect, it } from "vitest";
import { evaluateRules } from "../../agents/jobAgent/rules.js";
import { userProfile } from "../../config/userProfile.js";
import type { ExtractedJobData } from "../../types/job.js";

const makeJob = (overrides: Partial<ExtractedJobData>): ExtractedJobData => ({
  company: "TestCo",
  title: "Software Engineer",
  stack: ["TypeScript", "Node.js"],
  requiredSkills: ["API development"],
  preferredSkills: [],
  domainTags: [],
  responsibilities: [],
  requirements: [],
  remoteType: "remote",
  ...overrides,
});

describe("location preference vs requirement", () => {
  const onsiteSf = {
    remoteType: "onsite" as const,
    locationIsCommutable: false,
    location: "San Francisco",
    rawText: "Software Engineer\nWork from our San Francisco office.",
  };

  it("hard-gates a required non-commutable onsite location", () => {
    expect(evaluateRules(makeJob(onsiteSf), userProfile).locationMismatch).toBe(true);
  });

  it("does not gate a location marked preferred", () => {
    expect(
      evaluateRules(makeJob({ ...onsiteSf, location: "San Francisco (preferred)" }), userProfile).locationMismatch,
    ).toBe(false);
    expect(
      evaluateRules(makeJob({ ...onsiteSf, rawText: "Software Engineer\nBased in San Francisco (preferred)" }), userProfile)
        .locationMismatch,
    ).toBe(false);
  });
});

describe("rule engine", () => {
  it("flags explicit degree risks", () => {
    const rules = evaluateRules(
      makeJob({
        degreeRequirement: { level: "required", raw: "Bachelor's degree required" },
      }),
      userProfile,
    );
    expect(rules.explicitDegreeRisk).toBe(true);
  });

  it("flags senior title skepticism", () => {
    const rules = evaluateRules(makeJob({ title: "Senior Software Engineer", yearsExperience: { min: 5 } }), userProfile);
    expect(rules.seniorityOverreach).toBe(true);
  });

  it("does not flag seniority overreach when rawText describes team seniors on an early-career role", () => {
    const rules = evaluateRules(
      makeJob({
        company: "Ro",
        title: "AI Engineer",
        seniority: "Junior, Mid",
        yearsExperience: { min: 1, max: 4, raw: "1-4 years" },
        rawText:
          "Work alongside Senior AI Lead, senior engineers, and an Engineering Manager. Learn from technical leaders.",
      }),
      userProfile,
    );
    expect(rules.seniorityOverreach).toBe(false);
  });

  it("does not flag seniority overreach for 4y mid-level without senior/staff/5y-hard signals", () => {
    const rules = evaluateRules(
      makeJob({
        title: "Software Engineer",
        yearsExperience: { min: 4, max: 6, raw: "4+ years" },
        responsibilities: ["Own features end-to-end", "Contribute to technical decisions"],
        rawText: "Python and/or TypeScript. Remote US. Healthcare product engineering.",
      }),
      userProfile,
    );
    expect(rules.seniorityOverreach).toBe(false);
    expect(rules.pythonStackFlexibleWithJsTs).toBe(true);
  });

  it("does not flag visa mismatch when candidate does not require sponsorship", () => {
    const rules = evaluateRules(
      makeJob({
        visaRequirement: "No visa sponsorship",
        rawText: "Must be authorized to work in the US. No H1B sponsorship.",
      }),
      userProfile,
    );
    expect(rules.visaMismatch).toBe(false);
    expect(rules.penaltyVector?.visa).toBeUndefined();
  });

  it("flags visa mismatch when candidate requires sponsorship and JD restricts it", () => {
    const rules = evaluateRules(
      makeJob({
        visaRequirement: "No visa sponsorship",
        rawText: "Unable to sponsor visas.",
      }),
      { ...userProfile, requiresSponsorship: true },
    );
    expect(rules.visaMismatch).toBe(true);
    expect(rules.penaltyVector?.visa).toBeGreaterThan(0);
  });

  it("flags finance/traditional strictness", () => {
    const rules = evaluateRules(
      makeJob({ company: "Heritage Bank", domainTags: ["finance"], requirements: ["banking systems experience"] }),
      userProfile,
    );
    expect(rules.financePenalty).toBe(true);
    expect(rules.traditionalCompanyPenalty).toBe(true);
  });

  it("does not infer finance/traditional/location penalties for enterprise applied-AI + NYC hybrid", () => {
    const rules = evaluateRules(
      makeJob({
        company: "Distyl AI",
        title: "AI Engineer",
        remoteType: "hybrid",
        location: "Hybrid — New York, NY",
        locationIsCommutable: false,
        rawText: `
Distyl builds customer AI systems for enterprises including Fortune 500 customers and insurance operations teams.
Stack: Python, LLMs, RAG, vector search, REST APIs, evaluations. Hybrid in New York, NY. 25-50% travel.
Series B startup. Not a bank.
        `.trim(),
      }),
      userProfile,
    );
    expect(rules.financePenalty).toBe(false);
    expect(rules.traditionalCompanyPenalty).toBe(false);
    expect(rules.locationMismatch).toBe(false);
  });

  it("does not treat benefits/401k + sells-to-finance copy as a financial institution", () => {
    const rules = evaluateRules(
      makeJob({
        company: "Acme Analytics",
        title: "Full Stack Engineer",
        remoteType: "remote",
        location: "Remote",
        domainTags: ["saas", "b2b"],
        degreeRequirement: { level: "required", raw: "Bachelor's degree required" },
        rawText: `
Acme Analytics is a Series A B2B SaaS company. Our product helps finance and insurance operations teams.
Customers are banks — we sell software to them.
Benefits: 401(k) matching, retirement planning, financial wellness stipend, health insurance.
Bachelor's degree required.
        `.trim(),
      }),
      userProfile,
    );
    expect(rules.financePenalty).toBe(false);
  });

  it("does not treat Rippling HR/IT/Finance product boilerplate as a finance employer", () => {
    const rules = evaluateRules(
      makeJob({
        company: "Rippling",
        title: "Software Engineer, Backend, IT Product",
        domainTags: ["saas"],
        rawText: `
Rippling builds a unified system for HR, IT, and Finance.
Experience using a backend language (e.g., Python/Go).
Benefits: 401(k) matching, financial wellness stipend, health insurance.
        `.trim(),
      }),
      userProfile,
    );
    expect(rules.financePenalty).toBe(false);
  });

  it("does not treat preferred healthcare-as-a-plus as a healthcare product requirement", () => {
    const rules = evaluateRules(
      makeJob({
        company: "Arbital Health",
        title: "Full Stack Engineer",
        domainTags: ["healthcare"],
        requirements: ["Strong fundamentals in TypeScript, Python, and React."],
        rawText: `
Full Stack Engineer at Arbital Health.
Strong fundamentals in TypeScript, Python, and React.
Nice-to-haves:
Prior healthcare experience is a plus.
        `.trim(),
      }),
      userProfile,
    );
    expect(rules.domainMismatch).toBe(false);
    expect(rules.healthcareProductEngineering).toBe(false);
  });

  it("does not hard-mismatch actuarial company boilerplate when the role does not require it", () => {
    const rules = evaluateRules(
      makeJob({
        company: "Arbital Health",
        title: "Full Stack Engineer",
        requirements: ["Strong fundamentals in TypeScript, Python, and React."],
        rawText: `
Arbital Health is a rapidly growing healthcare technology and actuarial leader.
Full Stack Engineer.
Requirements:
Strong fundamentals in TypeScript, Python, and React.
Nice-to-haves:
Prior healthcare experience is a plus.
        `.trim(),
      }),
      userProfile,
    );
    expect(rules.domainMismatch).toBe(false);
  });

  it("still hard-mismatches a true actuarial credential role", () => {
    const rules = evaluateRules(
      makeJob({
        company: "LifeCo",
        title: "Actuarial Analyst",
        requirements: ["ASA actuarial exam progress", "actuarial credential required"],
        rawText: "Actuarial Analyst. Actuarial exam progress required.",
      }),
      userProfile,
    );
    expect(rules.domainMismatch).toBe(true);
  });

  it("classifies research-heavy applied AI researcher roles", () => {
    const rules = evaluateRules(
      makeJob({
        company: "Distyl AI",
        title: "Applied AI Researcher, System Self-Construction",
        stack: ["Python"],
        rawText:
          "Looking for proven research track record and publications. Focus on self-constructing systems, meta-learning loops, program synthesis, evolutionary computation, model experiments, and frontier research results.",
        requirements: ["Proven research track record", "Publication-quality results"],
      }),
      userProfile,
    );
    expect(rules.researchHeavyAiRole).toBe(true);
    expect(rules.notes.some((n) => /research-heavy/i.test(n))).toBe(true);
    expect(rules.notes.some((n) => /recruiter-screen gap/i.test(n))).toBe(true);
  });

  it("classifies fintech go-primary backend roles as viable stretch", () => {
    const rules = evaluateRules(
      makeJob({
        company: "Imprint",
        title: "Software Engineer",
        stack: ["Go", "MySQL", "DynamoDB"],
        rawText:
          "Fintech payments platform. Go is our primary backend language. Microservices, on-call, production troubleshooting, and partner integrations.",
        requirements: ["Build backend microservices for payments"],
      }),
      userProfile,
    );
    expect(rules.fintechGoPrimaryStretch).toBe(true);
    expect(rules.notes.some((n) => /fintech|payments/i.test(n))).toBe(true);
    expect(rules.notes.some((n) => /go-primary backend expectations/i.test(n))).toBe(true);
  });

  it("flags onsite non-commutable mismatch", () => {
    const rules = evaluateRules(
      makeJob({ remoteType: "onsite", location: "Dallas, TX", locationIsCommutable: false }),
      userProfile,
    );
    expect(rules.locationMismatch).toBe(true);
  });

  it("classifies Plaid-like backend API role as backendProductApiRole (not infraCoreRole)", () => {
    const rules = evaluateRules(
      makeJob({
        company: "Plaid",
        title: "Backend Engineer",
        stack: ["Go", "Kubernetes", "Docker", "AWS", "Postgres"],
        responsibilities: [
          "Build backend systems and APIs for product features.",
          "Collaborate with PM and design on customer problems.",
          "Test and debug reliable production systems.",
        ],
        rawText: "Ownership and execution across product engineering squads.",
      }),
      userProfile,
    );
    expect(rules.backendProductApiRole).toBe(true);
    expect(rules.infraCoreRole).toBe(false);
    expect(rules.stackMismatch).toBe(false);
  });

  it("applies strong new-grad pipeline penalty only with harsh employer or degree gate", () => {
    const soft = evaluateRules(makeJob({ requirements: ["This is a new grad rotational program"] }), userProfile);
    expect(soft.strictNewGradPipeline).toBe(false);
    expect(soft.earlyCareerFriendlyRole).toBe(true);
    expect(soft.newGradPenalty).toBe(false);

    const strict = evaluateRules(
      makeJob({
        company: "Heritage Bank",
        requirements: ["This is a new graduate rotational program"],
        degreeRequirement: { level: "required", raw: "Bachelor's required" },
      }),
      userProfile,
    );
    expect(strict.strictNewGradPipeline).toBe(true);
    expect(strict.newGradPenalty).toBe(true);
    expect(strict.earlyCareerFriendlyRole).toBe(false);
  });

  it("flags startup founding mismatch", () => {
    const rules = evaluateRules(makeJob({ title: "Founding Engineer", requirements: ["first engineer at startup"] }), userProfile);
    expect(rules.startupFounderMismatch).toBe(true);
  });

  it("flags vagueEarlyStageAiCalibration for thin entry-level AI startup JD", () => {
    const rules = evaluateRules(
      makeJob({
        company: "StealthCo",
        title: "AI Engineer Intern",
        yearsExperience: { min: 0, max: 2 },
        stack: ["Python"],
        responsibilities: ["Support AI initiatives.", "Ship small features."],
        requirements: [],
        rawText:
          "Remote (US). Seed startup. Generative AI product for SMBs. Great culture. Fast learners welcome.",
        location: "Remote (US)",
      }),
      userProfile,
    );
    expect(rules.vagueEarlyStageAiCalibration).toBe(true);
    expect(rules.notes.some((n) => /generic-posting inflation/i.test(n))).toBe(true);
  });

  it("sets fdeBuilderSoftwarePrimary for forward deployed title without external customer implementation core", () => {
    const rules = evaluateRules(
      makeJob({
        company: "Maple AI",
        title: "Forward Deployed Engineer",
        responsibilities: [
          "Ship internal sales tooling and AI workflows with TypeScript.",
          "Partner with sales and ops; hybrid NYC.",
        ],
        rawText: "Founding team. LLM and RAG valued.",
      }),
      userProfile,
    );
    expect(rules.fdeBuilderSoftwarePrimary).toBe(true);
    expect(rules.notes.some((n) => /forward-deployed/i.test(n))).toBe(true);
  });

  it("flags explicit core Java requirement at Spotify vs TypeScript-first profile", () => {
    const rules = evaluateRules(
      makeJob({
        company: "Spotify",
        title: "Backend Engineer, Artist-First AI Music Lab",
        stack: ["Java"],
        responsibilities: [
          "You have experience developing backend systems using Java.",
          "Ship LLM-powered features for creators.",
        ],
        rawText:
          "You have experience developing backend systems using Java. Applied AI and RAG for music discovery.",
      }),
      userProfile,
    );
    expect(rules.matureStructuredEmployer).toBe(true);
    expect(rules.explicitCoreLanguageMismatch).toBe(true);
    expect(rules.explicitCoreLanguage).toBe("java");
    expect(rules.hardRuleNotes?.some((n) => /explicit java/i.test(n))).toBe(true);
  });

  it("does not set seniority overreach for associate/entry roles with familiarity wording", () => {
    const rules = evaluateRules(
      makeJob({
        company: "New York Times",
        title: "Core Software Engineer Associate",
        yearsExperience: { min: 0, max: 2, raw: "0-2 years" },
        stack: ["TypeScript", "Node.js"],
        preferredSkills: ["Go", "GraphQL", "Docker", "Kubernetes"],
        requirements: [
          "Familiarity with relational databases",
          "Familiarity building backend systems",
          "Familiarity with software development process",
        ],
        rawText:
          "Associate Software Engineer. Preferred qualifications include Go, GraphQL, cloud deployments, Docker/Kubernetes.",
      }),
      userProfile,
    );
    expect(rules.seniorityOverreach).toBe(false);
    expect(rules.notes.some((n) => /preferred go\/graphql\/platform stack/i.test(n))).toBe(true);
  });

  it("classifies fintech go-primary backend roles as viable stretch", () => {
    const rules = evaluateRules(
      makeJob({
        company: "Imprint",
        title: "Software Engineer",
        stack: ["Go", "MySQL", "DynamoDB"],
        rawText:
          "Fintech payments platform. Go is our primary backend language. Microservices, on-call, production troubleshooting, and partner integrations.",
        requirements: ["Build backend microservices for payments"],
      }),
      userProfile,
    );
    expect(rules.fintechGoPrimaryStretch).toBe(true);
    expect(rules.notes.some((n) => /fintech|payments/i.test(n))).toBe(true);
    expect(rules.notes.some((n) => /go-primary backend expectations/i.test(n))).toBe(true);
  });

  it("classifies founding startup roles without traditional-employer penalty", () => {
    const rules = evaluateRules(
      makeJob({
        company: "Sailor Health",
        title: "Founding Full-Stack Engineer",
        stack: ["TypeScript", "React", "Node.js", "PostgreSQL"],
        rawText:
          "Series A startup, 11-50 employees. 4th engineer. Shape engineering culture, own major technical decisions, and build from scratch for healthcare operations.",
        requirements: ["Founding team role with high autonomy"],
      }),
      userProfile,
    );
    expect(rules.foundingEngineerStretch).toBe(true);
    expect(rules.traditionalCompanyPenalty).toBe(false);
    expect(rules.notes.some((n) => /independent production ownership/i.test(n))).toBe(true);
    expect(rules.notes.some((n) => /limited mentorship or structure/i.test(n))).toBe(true);
  });

  it("flags credentialed fintech/accounting-systems JDs when CS degree is hard-required and profile lacks it", () => {
    const rules = evaluateRules(
      makeJob({
        company: "Tabs",
        title: "Software Engineer",
        degreeRequirement: { level: "required", raw: "Bachelor's degree in Computer Science required" },
        rawText: `
Must have a Bachelor's degree in Computer Science.
Must have 2+ years professional B2B SaaS software experience.
Must have experience building software applications for financial workflows.
Requires Java/C++ style object-oriented programming.
Requires knowledge of U.S. GAAP and ASC 606.
Requires demonstrated algorithm expertise through academic or industry publications in big data algorithms, distributed systems, or high-performance computing.
Salary $150,000 - $200,000.
        `.trim(),
      }),
      userProfile,
    );
    expect(rules.credentialHeavyFintechAlgorithm).toBe(true);
    expect(rules.notes.some((n) => /Explicit CS degree requirement is a major screen risk/i.test(n))).toBe(true);
    expect(rules.notes.some((n) => /GAAP and ASC 606/i.test(n))).toBe(true);
    expect(rules.hardRuleNotes?.some((n) => /Credentialed fintech/i.test(n))).toBe(true);
  });

  it("does not set explicitDegreeRisk when JD allows equivalent experience escape", () => {
    const rules = evaluateRules(
      makeJob({
        title: "Software Engineer",
        rawText: `
Bachelor's degree or equivalent practical experience required.
Build APIs with TypeScript and Node.js.
        `.trim(),
        degreeRequirement: { level: "required", raw: "Bachelor's or equivalent" },
      }),
      userProfile,
    );
    expect(rules.explicitDegreeRisk).toBe(false);
    expect(rules.notes.some((n) => /soft screen note/i.test(n))).toBe(true);
  });

  it("sets degreeHasEquivalencyClause for or related experience wording", () => {
    const rules = evaluateRules(
      makeJob({
        title: "Software Engineer II",
        rawText: `
Bachelor's or master's degree in Computer Science or related field, or related experience required.
        `.trim(),
        degreeRequirement: {
          level: "required",
          raw: "Bachelor's or master's or related experience required",
        },
      }),
      userProfile,
    );
    expect(rules.degreeHasEquivalencyClause).toBe(true);
    expect(rules.explicitDegreeRisk).toBe(false);
  });

  it("does not flag credential-heavy when JD allows equivalent experience for the degree", () => {
    const rules = evaluateRules(
      makeJob({
        company: "Tabs",
        title: "Software Engineer",
        degreeRequirement: { level: "equivalent_allowed", raw: "BS Computer Science or equivalent experience" },
        rawText: `
Bachelor's degree in Computer Science or equivalent experience required.
Requires knowledge of U.S. GAAP and ASC 606.
Requires demonstrated algorithm expertise through academic or industry publications in big data algorithms.
Requires Java object-oriented programming.
Must have 2+ years professional B2B SaaS software experience.
        `.trim(),
      }),
      userProfile,
    );
    expect(rules.credentialHeavyFintechAlgorithm).toBe(false);
  });

  it("flags production bar + competitive pool for LivePerson-style JDs", () => {
    const rules = evaluateRules(
      makeJob({
        company: "LivePerson",
        title: "Software Engineer",
        yearsExperience: { min: 2, max: 5, raw: "2+ years" },
        rawText: `
Series C company. 2+ years of professional software engineering experience required.
Own features end-to-end in production. Production ownership and on-call rotation.
Competitive applicant pool; we hire top engineers. Stack includes NestJS, Vue, Couchbase, and Python.
        `.trim(),
      }),
      userProfile,
    );
    expect(rules.productionBarCompetitivePool).toBe(true);
  });

  it("classifies StackAdapt-style Go + streaming + warehouse data infrastructure roles", () => {
    const rules = evaluateRules(
      makeJob({
        company: "StackAdapt",
        title: "Stats & Analytics Engineer",
        yearsExperience: { min: 2, max: 6, raw: "2+ years" },
        rawText: `
Go is our primary backend language. 2+ years professional backend experience required.
Build real-time distributed microservices processing large datasets. Kafka and Kinesis for streaming.
Redshift and ClickHouse for analytics. Performance and memory optimization. Microservices architecture.
        `.trim(),
      }),
      userProfile,
    );
    expect(rules.goDistributedDataInfraRole).toBe(true);
    expect(rules.goDistributedDataInfraCandidateGap).toBe(true);
    expect(rules.notes.some((n) => /Go-first distributed data infrastructure/i.test(n))).toBe(true);
  });

  it("does not set Go/data-infra gap when profile shows Go and streaming production evidence", () => {
    const profile = {
      ...userProfile,
      strengths: [...userProfile.strengths, "Go", "Kafka", "production backend services"],
      flagshipProjects: userProfile.flagshipProjects.map((p) =>
        p.name === "Backend-leaning full-stack product features"
          ? { ...p, summary: `${p.summary} Shipped Kafka consumers in production at scale.` }
          : p,
      ),
    };
    const rules = evaluateRules(
      makeJob({
        company: "StackAdapt",
        title: "Data Infrastructure Engineer",
        rawText:
          "Primary backend in Go. Kafka streaming pipelines. Snowflake warehouse. Distributed microservices.",
      }),
      profile,
    );
    expect(rules.goDistributedDataInfraRole).toBe(true);
    expect(rules.goDistributedDataInfraCandidateGap).toBe(false);
  });
});
