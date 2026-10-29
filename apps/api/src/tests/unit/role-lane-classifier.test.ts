import { describe, expect, it } from "vitest";
import { classifyRoleLane } from "../../lib/roleFunctionClassifier.js";
import { loadCalibrationFixture } from "../fixtures/calibrationAnchors.js";

describe("classifyRoleLane (Item G)", () => {
  it("maps Precisely to product_frontend", () => {
    const job = loadCalibrationFixture("preciselyAssociateSweFrontend").extracted;
    expect(classifyRoleLane(job).label).toBe("product_frontend");
  });

  it("maps StubHub Core Compute to platform_infra", () => {
    const job = loadCalibrationFixture("stubHubCoreCompute").extracted;
    expect(classifyRoleLane(job).label).toBe("platform_infra");
  });

  it("maps Cherry Hill to a product SWE lane (fullstack or backend)", () => {
    const job = loadCalibrationFixture("cherryHill").extracted;
    const lane = classifyRoleLane(job);
    expect(["product_fullstack", "product_backend"]).toContain(lane.label);
  });

  it("maps Pathpoint-shaped analyst to adjacent_non_engineering", () => {
    const lane = classifyRoleLane({
      company: "Pathpoint",
      title: "Technical Implementation Analyst",
      stack: ["REST API"],
      requiredSkills: ["requirements documentation"],
      preferredSkills: [],
      domainTags: [],
      responsibilities: [
        "Gather business requirements and author functional requirements documentation",
        "Create QA test plans and coordinate UAT",
      ],
      requirements: ["Experience writing requirements documentation"],
      rawText: "Technical Implementation Analyst. Requirements docs, QA test plans, UAT.",
    });
    expect(lane.label).toBe("adjacent_non_engineering");
    expect(lane.adjacentKind).toBe("implementation_analyst");
  });

  it("maps a React + LLM 'AI Platform Engineer' (TELCOR) to product, not platform_infra", () => {
    const lane = classifyRoleLane({
      company: "TELCOR",
      title: "AI Platform Engineer",
      stack: ["TypeScript", "React", "Redis", "Postgres"],
      requiredSkills: ["TypeScript", "ReactJS", "LLMs", "Redis", "Postgres"],
      preferredSkills: ["open source"],
      domainTags: [],
      rawText: [
        "AI Platform Engineer. Ideal for a product-minded engineer who enjoys shipping fast, owning features end-to-end, and building high-quality user experiences.",
        "Help build AI-powered products and experiences. Develop frontend applications with ReactJS and TypeScript. Integrate LLMs into product experiences and workflows.",
        "Requirements: 2+ years of experience with TypeScript. 2+ years of experience with ReactJS. Experience working with LLMs. Evidence of personal projects. Open source contributions preferred.",
      ].join("\n"),
    });
    expect(["product_fullstack", "product_backend"]).toContain(lane.label);
  });

  it("still treats a Platform Engineer title with real infrastructure work as platform_infra", () => {
    const lane = classifyRoleLane({
      company: "Acme",
      title: "Platform Engineer",
      stack: ["Kubernetes", "Terraform"],
      requiredSkills: ["Kubernetes", "Terraform"],
      preferredSkills: [],
      domainTags: [],
      rawText: "Platform Engineer. Run our Kubernetes clusters and CI/CD deployment pipelines. 3+ years with Terraform.",
    });
    expect(lane.label).toBe("platform_infra");
  });

  it("keeps Vercel-style IAM/Kubernetes platform work in platform_infra", () => {
    const lane = classifyRoleLane({
      company: "Vercel",
      title: "Platform Engineer, IAM",
      stack: ["Kubernetes", "Terraform", "IAM"],
      requiredSkills: ["Kubernetes", "IAM", "SAML"],
      preferredSkills: [],
      domainTags: ["identity", "IAM"],
      responsibilities: [
        "Build enterprise IAM integrations: SAML, OAuth, OIDC",
        "Run Kubernetes clusters and identity infrastructure",
      ],
      requirements: ["Experience operating Kubernetes and IAM systems"],
      rawText:
        "Platform Engineer, IAM. Build enterprise IAM integrations: SAML, OAuth, OIDC, LDAP. Kubernetes and Terraform for identity infrastructure.",
    });
    expect(lane.label).toBe("platform_infra");
  });

  it("classifies a Front-End Engineer JD as product_frontend even if APIs are mentioned", () => {
    const lane = classifyRoleLane({
      company: "Tavily",
      title: "Software Engineer",
      stack: ["TypeScript", "React", "Next.js"],
      requiredSkills: ["TypeScript", "React", "Next.js"],
      preferredSkills: [],
      domainTags: [],
      responsibilities: [
        "Own the frontend product experience in TypeScript, React, and Next.js",
        "Integrate with backend APIs",
      ],
      requirements: ["TypeScript", "React", "Next.js"],
      rawText: [
        "Tavily",
        "Front-End Engineer",
        "Own frontend product surfaces in TypeScript, React, and Next.js.",
        "Work with backend APIs and GraphQL while the core job is UI ownership.",
      ].join("\n"),
    });
    expect(lane.label).toBe("product_frontend");
  });

  it("keeps a genuine backend/API product role in product_backend", () => {
    const lane = classifyRoleLane({
      company: "Acme",
      title: "Backend Engineer",
      stack: ["Node.js", "PostgreSQL"],
      requiredSkills: ["Node.js"],
      preferredSkills: [],
      domainTags: [],
      responsibilities: ["Design and implement REST APIs and backend services"],
      requirements: ["Experience building backend APIs"],
      rawText: "Backend Engineer. Design and implement REST APIs and backend services.",
    });
    expect(lane.label).toBe("product_backend");
  });
});
