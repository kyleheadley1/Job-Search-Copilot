import { describe, expect, it } from "vitest";
import {
  extractPreScoringMetadata,
  looksLikeTeamOrgQualifier,
  parseCommaTitleCompany,
} from "../../tools/preScoringMetadataExtract.js";

describe("parseCommaTitleCompany — team vs company", () => {
  it("does not treat Reflections / AI Platforms / Interactive News as company", () => {
    expect(parseCommaTitleCompany("Software Engineer, Reflections")).toBeNull();
    expect(parseCommaTitleCompany("Software Engineer, AI Platforms")).toBeNull();
    expect(parseCommaTitleCompany("Software Engineer, Interactive News")).toBeNull();
    expect(looksLikeTeamOrgQualifier("Reflections")).toBe(true);
    expect(looksLikeTeamOrgQualifier("Acme Technologies")).toBe(false);
  });

  it("still splits real Title, Company lines", () => {
    expect(parseCommaTitleCompany("Software Engineer, Google")).toEqual({
      jobTitle: "Software Engineer",
      companyName: "Google",
    });
    expect(parseCommaTitleCompany("Backend Engineer, Acme Technologies")).toEqual({
      jobTitle: "Backend Engineer",
      companyName: "Acme Technologies",
    });
    expect(parseCommaTitleCompany("Full Stack Software Engineer, Plaid")).toEqual({
      jobTitle: "Full Stack Software Engineer",
      companyName: "Plaid",
    });
    expect(parseCommaTitleCompany("Fullstack Engineer, Patreon")).toEqual({
      jobTitle: "Fullstack Engineer",
      companyName: "Patreon",
    });
    expect(looksLikeTeamOrgQualifier("Plaid")).toBe(false);
    expect(looksLikeTeamOrgQualifier("Patreon")).toBe(false);
    expect(looksLikeTeamOrgQualifier("Product")).toBe(true);
    expect(parseCommaTitleCompany("Software Engineer, Product")).toBeNull();
  });

  it("preserves full team-qualified title when it is the first JD line", () => {
    const meta = extractPreScoringMetadata(
      "Software Engineer, Reflections\nThe New York Times\nNew York, NY",
    );
    expect(meta.jobTitle).toBe("Software Engineer, Reflections");
  });

  it("keeps NYT Reflections in the title when the team name uses a Unicode fl ligature", () => {
    const ligature = "Software Engineer, Re\uFB02ections";
    expect(looksLikeTeamOrgQualifier("Re\uFB02ections")).toBe(true);
    expect(parseCommaTitleCompany(ligature)).toBeNull();
    const meta = extractPreScoringMetadata(`${ligature}\nThe New York Times\nNew York, NY`);
    expect(meta.jobTitle).toBe(ligature);
    expect(meta.companyName).toBe("The New York Times");
    expect(meta.companyName).not.toBe("Re\uFB02ections");
  });
});
