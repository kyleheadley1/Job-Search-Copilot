import { describe, expect, it } from "vitest";
import { userProfile } from "../../config/userProfile.js";
import { recomputeStoredJobScore } from "../../lib/recomputeStoredJobScore.js";
import type { JobRecord } from "../../types/job.js";
import type { ResumeContextSet } from "../../types/resumeContext.js";
import { fixtureToJobRecord, loadCalibrationFixture } from "../fixtures/calibrationAnchors.js";

/**
 * Arbital Health — Full Stack Engineer.
 * Historical authoritative: 48 / weak  = 55 capability + (-7) survivability, gapDock 0.
 * Current replay:           36 / weak  = 55 capability + (-6) survivability − 13 Python-backend dock.
 *
 * The 12-point drop is two current-rule differences, not a replay defect:
 *  - "Strong fundamentals in TypeScript, Python, and React" is now read as a genuine (conjunctive)
 *    requirement, so the pre-existing backend-stack specialization dock fires (central, 12 + 1 signal).
 *  - "Prior healthcare experience is a plus" no longer sets domainMismatch; the real healthcare-data
 *    responsibilities set healthcareProductEngineering instead (+1 via survivability domain match).
 */

// Synthetic Node/TypeScript-primary resume with no Python claim (mirrors the BASE variant's shape).
const NODE_PRIMARY_RESUME = [
  "Full-Stack Software Engineer",
  "Full-stack software engineer building deployed web applications with React, TypeScript, Node.js, and MongoDB.",
  "Languages: JavaScript (ES6+), TypeScript",
  "Frontend: React, HTML/CSS, Tailwind",
  "Backend: Node.js, Express, REST APIs, BullMQ, Redis",
  "Databases: MongoDB, PostgreSQL",
  "Cloud and DevOps: AWS (EC2, Lambda, S3), Docker, GitHub Actions",
  "Full-Stack Engineer — OSLabs 2025 – Present",
  "● Led backend implementation in Node.js and Express, defining API contracts and data models",
  "● Built React UI for search and results display",
  "Software Engineer (Contract) — Nooxit 2024 – 2025",
  "● Developed RESTful APIs in Node.js and Express used by 10+ internal users",
].join("\n");

const resumeContexts: ResumeContextSet = {
  BASE: { rawText: NODE_PRIMARY_RESUME, type: "BASE" } as ResumeContextSet["BASE"],
};

const arbitalJob = (mutateRawText?: (text: string) => string): JobRecord => {
  const fixture = loadCalibrationFixture("arbitalHealthFullStack");
  const job = fixtureToJobRecord(fixture);
  const rawText = mutateRawText ? mutateRawText(fixture.extracted.rawText ?? "") : fixture.extracted.rawText;
  const requirements = (fixture.extracted.requirements ?? []).map((line) => (mutateRawText ? mutateRawText(line) : line));
  return {
    ...job,
    extracted: { ...job.extracted, rawText, requirements },
    // Replay always starts from the stored pre-clamp LLM categories.
    score: { ...job.score, llmCategories: { ...fixture.storedCategoryScores } },
  };
};

const replay = (job: JobRecord) => recomputeStoredJobScore({ job, profile: userProfile, resumeContexts });

describe("Arbital Health replay bridge (historical 48 → current 36)", () => {
  it("keeps Python as a genuine requirement and applies the central Python-backend dock", () => {
    const { rules } = replay(arbitalJob());
    expect(rules.stackMismatch).toBe(true);
    expect(rules.coreLanguageGap).toContain("Python");
    expect(rules.specializationGap).toMatchObject({
      kind: "backend_stack",
      jdSide: "Python",
      severity: "central",
      dock: 13,
    });
  });

  it("does not treat preferred healthcare as a mandatory domain penalty, but keeps the healthcare-data role signal", () => {
    const { rules } = replay(arbitalJob());
    expect(rules.domainMismatch).toBe(false);
    expect(rules.healthcareProductEngineering).toBe(true);
  });

  it("final total is exactly capability + survivability adjustment − gap dock, with no hidden caps or gates", () => {
    const { score, recommendation } = replay(arbitalJob());
    const display = score.scoreDisplay!;
    expect(display.hardGates).toEqual([]);
    expect(display.gapDock).toBe(13);
    expect(display.contractDock ?? 0).toBe(0);
    expect(score.total).toBe(display.capability + display.survAdjustment - display.gapDock);
    expect(recommendation).toBe("weak");
  });

  it("the dock is tied to the genuine requirement: a Python-as-a-plus variant gets no backend dock", () => {
    const softened = arbitalJob((text) =>
      text.replace(
        "Strong fundamentals in TypeScript, Python, and React",
        "Strong fundamentals in TypeScript and React. Python is a plus",
      ),
    );
    const { rules } = replay(softened);
    expect(rules.specializationGap?.kind).not.toBe("backend_stack");
  });
});
