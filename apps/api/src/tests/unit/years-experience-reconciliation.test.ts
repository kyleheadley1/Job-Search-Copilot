import { describe, expect, it } from "vitest";
import { evaluateRules } from "../../agents/jobAgent/rules.js";
import { userProfile } from "../../config/userProfile.js";
import { reconcileSeniority } from "../../lib/seniorityReconciliation.js";
import { detectRoleSeniorityOverreach } from "../../lib/seniorityGate.js";
import {
  extractGroundedYearsClauses,
  reconcileYearsExperience,
} from "../../lib/yearsExperienceReconciliation.js";
import type { ExtractedJobData } from "../../types/job.js";

const job = (overrides: Partial<ExtractedJobData>): ExtractedJobData => ({
  company: "TestCo",
  title: "Software Engineer",
  stack: ["TypeScript"],
  requiredSkills: [],
  preferredSkills: [],
  domainTags: [],
  responsibilities: [],
  requirements: [],
  rawText: "",
  ...overrides,
});

const applyReconcile = (input: ExtractedJobData): ExtractedJobData =>
  reconcileSeniority(reconcileYearsExperience(input).job).job;

describe("years experience reconciliation", () => {
  it("Affirm-style Engineer II with 1.5+ years overrides extracted min 5 and senior label", () => {
    const extracted = job({
      company: "Affirm",
      title: "Software Engineer II",
      seniority: "senior",
      yearsExperience: { min: 5, raw: "5+" },
      requirements: ["1.5+ years of experience in software engineering"],
      rawText:
        "Software Engineer II. 1.5+ years of experience in software engineering. Build product features in TypeScript.",
    });
    const clauses = extractGroundedYearsClauses(extracted);
    expect(clauses.some((c) => Math.abs(c.min - 1.5) < 0.05)).toBe(true);

    const reconciled = applyReconcile(extracted);
    expect(reconciled.yearsExperience?.min).toBe(1.5);
    expect(reconciled.seniority).toBeUndefined();
    expect(detectRoleSeniorityOverreach(reconciled)).toBe(false);

    const rules = evaluateRules(extracted, userProfile, { activeResumeType: "BASE" });
    expect(rules.seniorityOverreach).toBe(false);
  });

  it("explicit 5+ year senior positions still hard-gate", () => {
    const extracted = job({
      title: "Senior Software Engineer",
      seniority: "senior",
      yearsExperience: { min: 5, raw: "5+" },
      requirements: ["5+ years of professional software engineering experience"],
      rawText: "Senior Software Engineer. 5+ years of professional software engineering experience.",
    });
    const reconciled = applyReconcile(extracted);
    expect(reconciled.yearsExperience?.min).toBe(5);
    expect(reconciled.seniority).toMatch(/senior/i);
    expect(detectRoleSeniorityOverreach(reconciled)).toBe(true);
    expect(evaluateRules(extracted, userProfile, { activeResumeType: "BASE" }).seniorityOverreach).toBe(
      true,
    );
  });

  it("Principal and Staff roles with explicit high years still gate", () => {
    const principal = job({
      title: "Principal Software Engineer",
      seniority: "principal",
      yearsExperience: { min: 8, raw: "8+" },
      requirements: ["8+ years of professional software engineering experience"],
      rawText: "Principal Software Engineer. 8+ years of professional software engineering experience.",
    });
    const staff = job({
      title: "Staff Software Engineer",
      seniority: "staff",
      yearsExperience: { min: 7, raw: "7+" },
      requirements: ["7+ years of experience building production systems"],
      rawText: "Staff Software Engineer. 7+ years of experience building production systems.",
    });
    expect(detectRoleSeniorityOverreach(applyReconcile(principal))).toBe(true);
    expect(detectRoleSeniorityOverreach(applyReconcile(staff))).toBe(true);
    expect(evaluateRules(principal, userProfile, { activeResumeType: "BASE" }).seniorityOverreach).toBe(
      true,
    );
    expect(evaluateRules(staff, userProfile, { activeResumeType: "BASE" }).seniorityOverreach).toBe(true);
  });

  it("ambiguous or conflicting year floors leave min unset", () => {
    const extracted = job({
      title: "Software Engineer",
      yearsExperience: { min: 5, raw: "5+" },
      requirements: [
        "2+ years of experience with TypeScript",
        "5+ years of professional software engineering experience",
      ],
      rawText:
        "2+ years of experience with TypeScript. 5+ years of professional software engineering experience.",
    });
    const result = reconcileYearsExperience(extracted);
    expect(result.ambiguous).toBe(true);
    expect(result.job.yearsExperience?.min).toBeUndefined();
    expect(evaluateRules(extracted, userProfile, { activeResumeType: "BASE" }).seniorityOverreach).toBe(
      false,
    );
  });

  it("roles with no explicit YOE do not invent a minimum", () => {
    const extracted = job({
      title: "Software Engineer II",
      seniority: "senior",
      yearsExperience: { min: 5, raw: "5+" },
      requirements: ["Build product features with TypeScript and React"],
      rawText: "Software Engineer II. Build product features with TypeScript and React.",
    });
    const result = reconcileYearsExperience(extracted);
    expect(result.job.yearsExperience?.min).toBeUndefined();
    const reconciled = applyReconcile(extracted);
    expect(reconciled.seniority).toBeUndefined();
    expect(detectRoleSeniorityOverreach(reconciled)).toBe(false);
  });

  it("keeps an equivalent-experience floor when the year number is explicit", () => {
    const extracted = job({
      title: "Software Engineer",
      yearsExperience: { min: 3, raw: "3+" },
      requirements: ["3+ years of professional software engineering experience or equivalent"],
      rawText: "3+ years of professional software engineering experience or equivalent.",
    });
    expect(reconcileYearsExperience(extracted).job.yearsExperience?.min).toBe(3);
  });

  it("uses the must-have 2+ floor and ignores a nice-to-have 3–5+ years clause", () => {
    const extracted = job({
      company: "Seso",
      title: "Software Engineer, AI Agents",
      yearsExperience: { min: 3, raw: "3-5+" },
      requirements: ["2+ years of experience building production software"],
      rawText: [
        "Must-haves:",
        "2+ years of experience building production software.",
        "Nice-to-haves:",
        "3–5+ years of experience with AI agents.",
      ].join("\n"),
    });
    const clauses = extractGroundedYearsClauses(extracted);
    expect(clauses.map((c) => c.min)).toEqual([2]);
    expect(reconcileYearsExperience(extracted).job.yearsExperience?.min).toBe(2);
    expect(evaluateRules(extracted, userProfile, { activeResumeType: "BASE" }).seniorityOverreach).toBe(false);
  });

  it("does not promote a preferred-only years clause into a mandatory floor", () => {
    const extracted = job({
      yearsExperience: { min: 5, raw: "5+" },
      requirements: ["Build product features in TypeScript"],
      rawText: "Software Engineer.\nNice-to-haves:\n5+ years of experience with healthcare systems.",
    });
    const result = reconcileYearsExperience(extracted);
    expect(result.job.yearsExperience?.min).toBeUndefined();
  });
});
