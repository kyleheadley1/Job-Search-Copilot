import { describe, expect, it } from "vitest";
import { appendFintechGoStretchGuidance } from "../../lib/scoringOutputPolish.js";
import type { ExtractedJobData } from "../../types/job.js";
import type { RuleEvaluation } from "../../types/scoring.js";

const job = (rawText: string) =>
  ({ company: "Breeze", title: "Full Stack Engineer", stack: [], requiredSkills: [], preferredSkills: [], domainTags: [], rawText }) as ExtractedJobData;
const rules = { fintechGoPrimaryStretch: true } as RuleEvaluation;

describe("fintech stretch top match", () => {
  it("does not claim Go when the JD never mentions it", () => {
    const line = appendFintechGoStretchGuidance("x", {
      rules,
      extracted: job("React.js and TypeScript on the frontend, Node.js on the backend, multi-service codebase."),
    });
    expect(line).not.toMatch(/\bGo\b/);
    expect(line).toMatch(/multi-service payments infrastructure/);
  });

  it("keeps the Go wording when Go is in the JD", () => {
    const line = appendFintechGoStretchGuidance("x", {
      rules,
      extracted: job("Golang is our primary backend language for payments services."),
    });
    expect(line).toMatch(/Go-primary/);
  });
});
