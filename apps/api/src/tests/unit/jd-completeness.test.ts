import { describe, expect, it } from "vitest";
import { classifySubmittedCompleteness } from "../../services/gmail/jdRecovery/jdCandidates.service.js";
import { assessJdCompleteness, jdTextLooksComplete } from "../../services/gmail/jdRecovery/jdCompleteness.js";

const FLUXCAP_STYLE = [
  "Forward Deployed Software Engineer",
  "FluxCap | New York City | Hybrid | Full-time",
  "About FluxCap",
  "FluxCap helps lawyers connect the law, evidence, and strategy of a case.",
  "The role",
  "You’ll work directly with lawyers using FluxCap to understand where they get stuck and build software that helps them move forward.",
  "You’ll follow projects from the first conversation through production.",
  "What you’ll do",
  "Work with lawyers and legal engineers to understand a problem and choose a useful first step.",
  "Build frontend and backend features, data integrations, and AI workflows.",
  "Write tested, dependable software and handle sensitive case information with care.",
  "What you’ll bring",
  "Experience building working software through a job, internship, or substantial project.",
  "Strong programming fundamentals and familiarity with TypeScript or JavaScript and a frontend framework such as React.",
  "Clear communication and a willingness to ask questions when something is unclear.",
].join("\n");

const CONVENTIONAL = [
  "Software Engineer",
  "Acme",
  "Responsibilities",
  "- Build backend services used by customer teams",
  "- Review code and improve production reliability",
  "- Partner with product on scoping and delivery",
  "Requirements",
  "- 3+ years of software engineering experience",
  "- Familiarity with TypeScript and relational databases",
  "- Clear written communication",
  "Compensation",
  "Salary range $140,000–$180,000.",
].join("\n");

const INTELLIGEMS_PARTIAL =
  "Full Stack Engineer at Intelligems. Remote or New York. One aggregator lists $140k-$180k, another lists $160k-$200k. Apply on LinkedIn.";

const TRUNCATED = [
  "Forward Deployed Software Engineer",
  "What you'll do",
  "Work with lawyers and legal engineers to understand a problem and choose a useful first step.",
  "Build frontend and backend features, data integrations, and AI workflows.",
  "What you'll bring",
  "Experience building working software through a job, internship, or substantial project and familiarity with TypeScript and",
].join("\n");

const HEADINGS_ONLY = [
  "Software Engineer",
  "Responsibilities",
  "Requirements",
  "Apply on the company site for more detail.",
].join("\n");

/** Representative excerpt of the stored Scalis/Intelligems ATS posting. */
const INTELLIGEMS_ATS = [
  "Full Stack Engineer",
  "Intelligems",
  "Remote",
  "About Intelligems",
  "Intelligems builds the AI agents that turn your traffic into profit. We have excellent traction working with over 3,000 brands and have raised more than $11M to date.",
  "About the job",
  "The Role",
  "From day one, we'll ask you to contribute to any and every aspect of our stack. It could be adding new functionality to the core experimentation capabilities of the platform, designing and implementing a new integration, or reworking a complicated user flow.",
  "Our team is lean — less than 10 engineers. This means you'll work closely with everyone, including sales, support, and success.",
  "From there you'll tackle increasingly complex and ambiguous problems, from schema and API design to UI polish.",
  "Tech Stack",
  "Knowledge in all of these is not required, but you should be excited to work within and help us improve the stack.",
  "- TypeScript monorepo",
  "- Frontend - React web app hosted on AWS",
  "- Backend - Serverless NodeJS hosted on AWS Lambda",
  "You're a Great Fit If",
  "- You have experience owning product and feature development from ideation to delivery",
  "- You're able to hold a lot of context in your head — there are a lot of moving pieces here",
  "- You have deep expertise in areas that will level us up",
  "- You empathize with our customers, and care deeply about making them successful",
  "Benefits for full-time employees:",
  "- Competitive salary and equity packages",
  "- Medical, dental, and vision insurance",
  "- Flexible PTO policy",
].join("\n");

const COMPANY_AND_BENEFITS_ONLY = [
  "About Meridian Labs",
  "Meridian Labs builds the AI agents that turn your traffic into profit. Every day, brands make thousands of decisions and most of them happen by default. We build the data and the agents that make those decisions for you, automatically, so your site gets smarter with every visitor instead of sitting static.",
  "We have excellent traction: we're working with over 3,000 brands and have access to more than $10B of transaction data. We're backed by well-known funds and have raised more than $11M to date. Our people are our strongest asset, and we hold a very high bar.",
  "Benefits for full-time employees:",
  "- Competitive salary and equity packages with a wide published range",
  "- Medical, dental, and vision insurance that varies by country",
  "- 401k with an employer match for US employees",
  "- Flexible PTO policy and parental leave",
  "- WFH setup stipend and a laptop provided",
  "Meridian Labs is a remote-first company with offices in NYC, Denver, Boston, and Chicago.",
].join("\n");

const ROLE_WITHOUT_QUALIFICATIONS = [
  "The Role",
  "From day one, we'll ask you to contribute to any and every aspect of our stack, adding new functionality and designing integrations.",
  "You'll work closely with product and design, then tackle increasingly complex problems from schema design to UI polish.",
  "Benefits",
  "- Competitive salary",
  "- Medical insurance",
].join("\n");

describe("jdTextLooksComplete", () => {
  it("accepts Fluxcap-style equivalent headings with real duty and qualification content", () => {
    const assessment = assessJdCompleteness(FLUXCAP_STYLE);
    expect(assessment.truncated).toBe(false);
    expect(assessment.dutyChars).toBeGreaterThan(80);
    expect(assessment.qualChars).toBeGreaterThan(80);
    expect(jdTextLooksComplete(FLUXCAP_STYLE)).toBe(true);
  });

  it("accepts conventional Responsibilities and Requirements headings", () => {
    expect(jdTextLooksComplete(CONVENTIONAL)).toBe(true);
  });

  it("rejects Intelligems-style aggregator fragments", () => {
    expect(jdTextLooksComplete(INTELLIGEMS_PARTIAL)).toBe(false);
  });

  it("rejects truncated qualification copy even when headings look right", () => {
    expect(assessJdCompleteness(TRUNCATED).truncated).toBe(true);
    expect(jdTextLooksComplete(TRUNCATED)).toBe(false);
  });

  it("rejects headings that have no meaningful section content", () => {
    expect(jdTextLooksComplete(HEADINGS_ONLY)).toBe(false);
  });

  it("accepts an ATS posting whose qualifications are a Great Fit paragraph/list, not Requirements", () => {
    const assessment = assessJdCompleteness(INTELLIGEMS_ATS);
    expect(assessment.truncated).toBe(false);
    expect(assessment.dutyOk).toBe(true);
    expect(assessment.qualOk).toBe(true);
    expect(jdTextLooksComplete(INTELLIGEMS_ATS)).toBe(true);
  });

  it("rejects a long company-and-benefits page that never states the job's work or requirements", () => {
    const assessment = assessJdCompleteness(COMPANY_AND_BENEFITS_ONLY);
    expect(COMPANY_AND_BENEFITS_ONLY.length).toBeGreaterThan(300);
    expect(assessment.dutyOk).toBe(false);
    expect(assessment.qualOk).toBe(false);
    expect(jdTextLooksComplete(COMPANY_AND_BENEFITS_ONLY)).toBe(false);
  });

  it("rejects a role description that has duties but no candidate qualifications", () => {
    const assessment = assessJdCompleteness(ROLE_WITHOUT_QUALIFICATIONS);
    expect(assessment.dutyOk).toBe(true);
    expect(assessment.qualOk).toBe(false);
    expect(jdTextLooksComplete(ROLE_WITHOUT_QUALIFICATIONS)).toBe(false);
  });

  it("accepts paragraph-only duties and qualifications with no list markers or standard headings", () => {
    const text = [
      "From day one, we'll ask you to contribute to any and every aspect of our stack. You'll work closely with product, then tackle increasingly complex problems from schema design to UI polish.",
      "You have experience owning product and feature development from ideation to delivery. You're able to hold a lot of context, and you have deep expertise in areas that will level the team up.",
    ].join("\n");
    const assessment = assessJdCompleteness(text);
    expect(assessment.truncated).toBe(false);
    expect(assessment.dutyOk).toBe(true);
    expect(assessment.qualOk).toBe(true);
    expect(jdTextLooksComplete(text)).toBe(true);
  });
});

describe("classifySubmittedCompleteness", () => {
  it("never upgrades a claimed partial, even when the text would otherwise be full", () => {
    expect(classifySubmittedCompleteness(FLUXCAP_STYLE, "partial")).toBe("partial");
    expect(classifySubmittedCompleteness(CONVENTIONAL, "partial")).toBe("partial");
  });

  it("can downgrade a claimed full when the posting is incomplete", () => {
    expect(classifySubmittedCompleteness(INTELLIGEMS_PARTIAL, "full")).toBe("partial");
    expect(classifySubmittedCompleteness(TRUNCATED, "full")).toBe("partial");
    expect(classifySubmittedCompleteness(HEADINGS_ONLY, "full")).toBe("partial");
  });

  it("keeps a claimed full when the server agrees the posting is complete", () => {
    expect(classifySubmittedCompleteness(FLUXCAP_STYLE, "full")).toBe("full");
    expect(classifySubmittedCompleteness(CONVENTIONAL, "full")).toBe("full");
    expect(classifySubmittedCompleteness(INTELLIGEMS_ATS, "full")).toBe("full");
  });

  it("still downgrades a claimed full company-overview posting", () => {
    expect(classifySubmittedCompleteness(COMPANY_AND_BENEFITS_ONLY, "full")).toBe("partial");
    expect(classifySubmittedCompleteness(INTELLIGEMS_ATS, "partial")).toBe("partial");
  });
});
