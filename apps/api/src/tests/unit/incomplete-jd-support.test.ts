import { describe, expect, it } from "vitest";
import {
  assessExtractedJdSupport,
  sanitizeExtractedTags,
} from "../../lib/jdTagProvenance.js";
import { loadCalibrationFixture } from "../fixtures/calibrationAnchors.js";

const TRABA_JOB = loadCalibrationFixture("trabaAppliedAi").extracted;

describe("incomplete JD extraction support", () => {
  it("flags Traba raw text as too incomplete and does not trust ungrounded chips", () => {
    const support = assessExtractedJdSupport(TRABA_JOB);
    expect(support.incomplete).toBe(true);
    expect(support.rawTextChars).toBeLessThan(600);
    expect(support.ungroundedRequirementTags).toEqual(
      expect.arrayContaining(["Python", "TypeScript"]),
    );
    expect(support.note).toMatch(/too incomplete/i);

    const sanitized = sanitizeExtractedTags(TRABA_JOB);
    expect(sanitized.stack).not.toContain("Python");
    expect(sanitized.stack).not.toContain("TypeScript");
    expect(sanitized.requiredSkills).not.toContain("Python");
    expect(sanitized.requiredSkills).not.toContain("TypeScript");
  });

  it("does not invent missing JD text", () => {
    const empty = assessExtractedJdSupport({
      rawText: "",
      stack: ["Python"],
      requiredSkills: ["Python"],
      preferredSkills: [],
    });
    expect(empty.incomplete).toBe(true);
    expect(empty.ungroundedRequirementTags).toContain("Python");
    expect(empty.note).toMatch(/empty/i);
  });
});
