import { describe, expect, it } from "vitest";
import {
  extractCompanyName,
  extractJobPostingMetadata,
  isWeakJobTitle,
  scoreCompanyCandidates,
  validateExtractedCompany,
} from "../../tools/jobPostingMetadataExtract.js";
import { applyCompanyPresentation } from "../../tools/companyExtraction.js";
import {
  isHardRejectedCompanyCandidate,
  looksLikeBrandCompanyName,
} from "../../tools/companyCandidateRules.js";

const CASE_1 = `
Contract

Open user menu

AI Enablement Engineer
Updated on 5/26/2026

Unlock job analytics with
Simplify+
GreenLite
GreenLite
51-200 employees
Permit management and code compliance services
`.trim();

const CASE_2 = `
Forward Deployed AI Engineer
Updated on 5/26/2026
Unlock job analytics with
Simplify+
CLEAR
CLEAR
1,001-5,000 employees
Subscription-based biometric identity verification lanes
`.trim();

const CASE_3 = `
Full-time
Software Engineer, Backend
Updated on 5/26/2026
Acme AI
51-200 employees
AI infrastructure startup
`.trim();

const BATTELLE_JD = `
Battelle
· Reposted 48 minutes ago
Software Engineer (Early Career)
position
United States
time
Full-time
remote
Hybrid
seniority
Entry Level
money
No salary listed
Responsibilities
stakeholders including mathematicians
Conduct research and development work
Qualification
Required
Bachelor's degree in computer science
Battelle is a research and development organization committed to science and technology.
`.trim();

const TRIA_FEDERAL_JD = `
Tria Federal (Tria)
·
3 hours ago
Software Engineer
position
United States
time
Full-time
remote
Remote
seniority
Entry Level
date
1+ years exp
91%
STRONG MATCH
Experience Level
100%
Skill
75%
Industry Exp.
82%
Tria Federal delivers digital services and technology solutions that support the health and safety of veterans, service members and civilians. They are seeking a Full-Stack Engineer to design and build AI-enabled helpdesks and contact centers to solve real-world problems for federal missions.
Consulting
Information Technology
Insider Connection @Tria Federal (Tria)
Responsibilities
Build intelligent agents that plan, reason, and interact with users
Required
Must be a U.S. citizen due to the security clearance required for this position
1–3 years of hands-on experience building and deploying full-stack applications Node.js
`.trim();

const JUNIOR_AI_JD = `
Full Stack Engineer
Updated on 8/1/2026

Unlock job analytics with
Simplify+
Junior AI
Junior AI
Compensation Overview
$150k - $190k/yr

+ Equity + Private healthcare + 401(k)
Junior, Mid

New York, NY, USA

In Person

Candidates must be based in New York City or committed to relocating and work in the office.

Category

Software Engineering
(1)

Full-Stack Engineering
Required Skills
Skills that you prefer have been highlighted

LLM
React.js
Data Structures & Algorithms
Postgres
TypeScript
Next.js
CRM

History
Summary
Full Job Posting
Why This Job is a Match

About Junior
Junior is building the AI operating system for investment research. Our software helps private equity firms, consultants, and financial institutions complete high-stakes research workflows dramatically faster.

Design and build new modes of working with computers

Talk directly to the clients who use what you build, and let that shape product decisions

If you're excited to drive innovation at Junior, we'd love to hear from you!
`.trim();

const ROLLOUT_JD = `
Founding Software Engineer
Confirmed live in the last 24 hours
Unlock job analytics with
Simplify+
Rollout
Rollout
1-10 employees

Mobile feature flags and rollout management

No salary listed

Entry

New York, NY, USA

Hybrid

Hybrid work in the New York City area, with travel to customer sites including Louisville.

Category

Software Engineering
(1)

AI/ML/GenAI Engineering

History
Summary
Full Job Posting
Why This Job is a Match

About This Role
In person, NYC. We work together in the New York City area, with hybrid flexibility.

Responsibilities
Be our in-house scout on AI-powered software development

Qualifications
Genuine fluency and excitement for modern AI coding tools (Claude Code, Cursor, Copilot, etc.)
Solid CS fundamentals and a track record of shipping working software

What Success Looks Like
Twelve months in:

You're the team's go-to authority on AI-assisted development — everyone ships faster because of workflows you found or built.

Curiosity and initiative — you go find the answer rather than wait to be handed one.

You can take a fuzzy problem and turn it into a shipped solution with minimal hand-holding.
`.trim();

describe("job posting metadata extract (Simplify-style)", () => {
  it("rejects About-the-company headings as job titles", () => {
    expect(isWeakJobTitle("About Assembled")).toBe(true);
    expect(isWeakJobTitle("About the company")).toBe(true);
    expect(isWeakJobTitle("Software Engineer, Platform")).toBe(false);
    expect(extractJobPostingMetadata("About Assembled\nWe build customer support software.\n".repeat(8)).jobTitle).not.toBe(
      "About Assembled",
    );
  });

  it("case 1: GreenLite contract role", () => {
    const meta = extractJobPostingMetadata(CASE_1);
    expect(meta.companyName).toBe("GreenLite");
    expect(meta.jobTitle).toBe("AI Enablement Engineer");
    expect(meta.employmentType).toBe("Contract");
    expect(extractCompanyName(CASE_1)).toBe("GreenLite");
  });

  it("case 2: CLEAR repeated before employee count", () => {
    const meta = extractJobPostingMetadata(CASE_2);
    expect(meta.companyName).toBe("CLEAR");
    expect(meta.jobTitle).toBe("Forward Deployed AI Engineer");
  });

  it("case 3: Acme AI full-time backend role", () => {
    const meta = extractJobPostingMetadata(CASE_3);
    expect(meta.companyName).toBe("Acme AI");
    expect(meta.jobTitle).toBe("Software Engineer, Backend");
    expect(meta.employmentType).toBe("Full-time");
  });

  it("validateExtractedCompany recovers from Unknown when duplicate precedes employee count", () => {
    expect(validateExtractedCompany("Unknown Company", CASE_1)).toBe("GreenLite");
    expect(validateExtractedCompany("Contract", CASE_1)).toBe("GreenLite");
  });

  it("validateExtractedCompany rejects LLM prose company in favor of Battelle header", () => {
    expect(validateExtractedCompany("stakeholders including mathematicians", BATTELLE_JD)).toBe("Battelle");
  });

  it("Battelle: header company before repost timestamp, not body prose", () => {
    expect(isHardRejectedCompanyCandidate("stakeholders including mathematicians")).toBe(true);
    expect(looksLikeBrandCompanyName("stakeholders including mathematicians")).toBe(false);
    expect(looksLikeBrandCompanyName("Battelle")).toBe(true);

    const lines = BATTELLE_JD.split("\n").map((l) => l.trim()).filter(Boolean);
    const candidates = scoreCompanyCandidates(lines);
    expect(candidates.some((c) => c.line === "stakeholders including mathematicians")).toBe(false);
    expect(candidates[0]?.line).toBe("Battelle");

    const meta = extractJobPostingMetadata(BATTELLE_JD);
    expect(meta.companyName).toBe("Battelle");
    expect(meta.jobTitle).toBe("Software Engineer (Early Career)");
    expect(extractCompanyName(BATTELLE_JD)).toBe("Battelle");

    const presented = applyCompanyPresentation({
      company: meta.companyName!,
      title: meta.jobTitle!,
      rawText: BATTELLE_JD,
      listingCompanyName: meta.companyName!,
      companyDisplayName: meta.companyName!,
      stack: [],
      requiredSkills: [],
      preferredSkills: [],
      domainTags: [],
      responsibilities: [],
      requirements: [],
    });
    expect(presented.companyDisplayName).toBe("Battelle");
    expect(presented.listingCompanyName).toBe("Battelle");
    expect(presented.title).toBe("Software Engineer (Early Career)");
    const headerLabel = `${presented.companyDisplayName} - ${presented.title}`;
    expect(headerLabel).toBe("Battelle - Software Engineer (Early Career)");
  });

  it("Tria Federal: parenthetical alias + middot chrome + delivers self-description", () => {
    expect(isHardRejectedCompanyCandidate("Tria Federal (Tria)")).toBe(false);
    expect(looksLikeBrandCompanyName("Tria Federal (Tria)")).toBe(true);

    const meta = extractJobPostingMetadata(TRIA_FEDERAL_JD);
    expect(meta.companyName).toMatch(/Tria Federal/);
    expect(meta.jobTitle).toBe("Software Engineer");
    expect(extractCompanyName(TRIA_FEDERAL_JD)).toMatch(/Tria Federal/);
    expect(validateExtractedCompany("Unknown Company", TRIA_FEDERAL_JD)).toMatch(/Tria Federal/);

    const presented = applyCompanyPresentation({
      company: meta.companyName!,
      title: meta.jobTitle!,
      rawText: TRIA_FEDERAL_JD,
      listingCompanyName: meta.companyName!,
      companyDisplayName: meta.companyName!,
      stack: [],
      requiredSkills: [],
      preferredSkills: [],
      domainTags: [],
      responsibilities: [],
      requirements: [],
    });
    expect(presented.companyDisplayName).toMatch(/Tria Federal/);
    expect(`${presented.companyDisplayName} - ${presented.title}`).toMatch(
      /Tria Federal.*Software Engineer/,
    );
  });

  it("Junior AI: duplicate before Compensation Overview, not Simplify+ client", () => {
    const meta = extractJobPostingMetadata(JUNIOR_AI_JD);
    expect(meta.companyName).toBe("Junior AI");
    expect(meta.jobTitle).toBe("Full Stack Engineer");
    expect(extractCompanyName(JUNIOR_AI_JD)).toBe("Junior AI");
    expect(validateExtractedCompany("Simplify+", JUNIOR_AI_JD)).toBe("Junior AI");

    const presented = applyCompanyPresentation({
      company: meta.companyName!,
      title: meta.jobTitle!,
      rawText: JUNIOR_AI_JD,
      listingCompanyName: meta.companyName!,
      companyDisplayName: meta.companyName!,
      stack: [],
      requiredSkills: [],
      preferredSkills: [],
      domainTags: [],
      responsibilities: [],
      requirements: [],
    });
    expect(presented.companyDisplayName).toBe("Junior AI");
    expect(presented.listingCompanyName).toBe("Junior AI");
    expect(presented.companyConfidence).not.toBe("agency_only");
    expect(presented.companyDisplayName).not.toMatch(/Simplify/);
  });

  it("Rollout: duplicate employee card wins over About This Role", () => {
    expect(isHardRejectedCompanyCandidate("This Role")).toBe(true);
    expect(looksLikeBrandCompanyName("Rollout")).toBe(true);

    const meta = extractJobPostingMetadata(ROLLOUT_JD);
    expect(meta.companyName).toBe("Rollout");
    expect(meta.jobTitle).toBe("Founding Software Engineer");
    expect(extractCompanyName(ROLLOUT_JD)).toBe("Rollout");

    const presented = applyCompanyPresentation({
      company: meta.companyName!,
      title: meta.jobTitle!,
      rawText: ROLLOUT_JD,
      listingCompanyName: meta.companyName!,
      companyDisplayName: meta.companyName!,
      stack: [],
      requiredSkills: [],
      preferredSkills: [],
      domainTags: [],
      responsibilities: [
        "Be our in-house scout on AI-powered software development",
      ],
      requirements: [
        "Curiosity and initiative — you go find the answer rather than wait to be handed one.",
        "You're the team's go-to authority on AI-assisted development",
      ],
    });
    expect(presented.companyDisplayName).toBe("Rollout");
    expect(presented.listingCompanyName).toBe("Rollout");
    expect(presented.companyDisplayName).not.toBe("This Role");
  });
});
