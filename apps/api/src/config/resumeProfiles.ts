import type { ResumeProfile } from "../types/resume.js";

export const resumeProfiles: ResumeProfile[] = [
  {
    type: "BASE",
    label: "Full-Stack (Base)",
    bestFor: [
      "Product and full-stack software engineering",
      "Backend-leaning full-stack, API, and platform-adjacent applications",
      "Internal tools and workflow systems",
      "Junior / associate / early-career engineering roles",
      "Roles where AI is a minor or optional part of the job",
    ],
    avoidFor: [
      "Roles whose core work is building LLM, RAG, or agent systems (use AI)",
    ],
    summaryStyle: "Full-stack engineer shipping deployed React/TypeScript/Node.js applications with APIs, auth, async pipelines, and AWS.",
    emphasisKeywords: ["TypeScript", "Node.js", "React", "REST APIs", "MongoDB", "AWS", "CI/CD", "internal tools"],
    exampleRationale: [
      "Role is product/full-stack oriented and rewards API + application delivery.",
      "Base resume leads with shipped full-stack work; AI appears as supporting evidence.",
    ],
  },
  {
    type: "AI",
    label: "AI-Heavy",
    bestFor: [
      "AI engineer / applied AI / AI product engineering",
      "LLM application, RAG, retrieval, and search roles",
      "Agentic workflow and tool-using agent roles",
      "LLM evaluation, grounding, and quality roles",
      "Full-stack roles where AI features are central to the product",
    ],
    avoidFor: [
      "General product engineering with no AI component (use BASE)",
      "ML research or model-training roles (no training/fine-tuning experience to claim)",
    ],
    summaryStyle: "Full-stack engineer building AI-enabled applications: RAG, LLM evals, deterministic grounding, and LangGraph agents.",
    emphasisKeywords: ["RAG", "LLM evaluation", "LangGraph", "agents", "embeddings", "vector search", "Qdrant", "TypeScript"],
    exampleRationale: [
      "JD centers on LLM/RAG/agent work; AI resume leads with shipped LLM evals, grounding, and agent work.",
      "Evidence is measurable (eval metrics, benchmarks, before/after results).",
    ],
  },
  {
    type: "FDE",
    label: "Integrations & Applied AI (FDE)",
    bestFor: [
      "Forward-deployed, solutions, implementation, and application engineering",
      "Integration-heavy roles: third-party APIs, data sync, connecting systems",
      "Internal tools and automation built for operations, clinical, or GTM teams",
      "Roles working directly with non-technical stakeholders or customers",
      "Applied AI delivered as practical workflows rather than AI research",
    ],
    avoidFor: [
      "Roles whose core work is LLM evaluation, retrieval, or agent research (use AI)",
      "General product engineering with no integration or stakeholder emphasis (use BASE)",
    ],
    summaryStyle: "Full-stack engineer who turns operational needs into working software: integrations, internal tools, and AI-powered workflows.",
    emphasisKeywords: ["integrations", "REST APIs", "OAuth", "MCP", "internal tools", "automation", "stakeholders", "TypeScript"],
    exampleRationale: [
      "Role centers on integrations, internal tools, or stakeholder-facing delivery; the FDE resume leads with that work.",
      "AI agents and MCP appear as practical tooling with human approval, not research.",
    ],
  },
];
