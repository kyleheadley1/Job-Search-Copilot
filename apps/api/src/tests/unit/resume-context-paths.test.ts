import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { resolveResumeCandidatePaths } from "../../config/resumeContext.js";
import { ResumeContextService } from "../../services/resume/resumeContext.js";
import { RESUME_TYPES, toActiveResumeType } from "../../types/resume.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const API_SRC = path.resolve(__dirname, "../..");

describe("resume context path lookup", () => {
  it("prefers txt then pdf for BASE", () => {
    const paths = resolveResumeCandidatePaths("BASE");
    expect(paths[0].endsWith("base_resume.txt")).toBe(true);
    expect(paths[1].endsWith("base_resume.pdf")).toBe(true);
  });

  it("prefers txt then pdf for AI", () => {
    const paths = resolveResumeCandidatePaths("AI");
    expect(paths[0].endsWith("ai_resume.txt")).toBe(true);
    expect(paths[1].endsWith("ai_resume.pdf")).toBe(true);
  });

  it("BASE, AI, and FDE are the active resume types", () => {
    expect([...RESUME_TYPES]).toEqual(["BASE", "AI", "FDE"]);
  });

  it("maps legacy stored resume types to BASE for scoring", () => {
    expect(toActiveResumeType("SWE")).toBe("BASE");
    expect(toActiveResumeType("SIE")).toBe("BASE");
    expect(toActiveResumeType("EARLY_CAREER")).toBe("BASE");
    expect(toActiveResumeType("AI")).toBe("AI");
    expect(toActiveResumeType(undefined)).toBe("BASE");
  });
});

const installed = RESUME_TYPES.every((t) => fs.existsSync(resolveResumeCandidatePaths(t)[0]!));

describe.runIf(installed)("installed resumes", () => {
  it("loads non-empty BASE, AI, and FDE contexts from the new files", async () => {
    const contexts = await new ResumeContextService().getAvailableContexts();
    expect(Object.keys(contexts).sort()).toEqual(["AI", "BASE", "FDE"]);
    expect(path.basename(contexts.BASE!.sourcePath)).toBe("base_resume.txt");
    expect(path.basename(contexts.AI!.sourcePath)).toBe("ai_resume.txt");
    expect(contexts.BASE!.rawText.length).toBeGreaterThan(1500);
    expect(contexts.AI!.rawText.length).toBeGreaterThan(1500);
    expect(contexts.AI!.rawText).toMatch(/LangGraph/);
    expect(path.basename(contexts.FDE!.sourcePath)).toBe("fde_resume.txt");
    expect(contexts.FDE!.rawText.length).toBeGreaterThan(1500);
    expect(contexts.FDE!.rawText).toMatch(/Integrations/);
  });
});

describe("retired resume files", () => {
  const walk = (dir: string): string[] =>
    fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) return e.name === "tests" ? [] : walk(full);
      return /\.(ts|mts)$/.test(e.name) ? [full] : [];
    });

  it("no source outside tests references the old resume files", () => {
    const offenders = walk(API_SRC).filter((f) =>
      /\b(swe|sie|early_career)_resume\b/.test(fs.readFileSync(f, "utf8")),
    );
    expect(offenders.map((f) => path.relative(API_SRC, f))).toEqual([]);
  });
});
