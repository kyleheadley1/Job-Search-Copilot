import { describe, expect, it } from "vitest";
import {
  extractCompanyFromSelfDescription,
  extractDuplicateCompanyBeforeEmployeeCount,
  extractHeaderCompanyBeforeActivity,
  isActivityTimestampLine,
  isHardRejectedCompanyCandidate,
  isValidCompanyCandidate,
  looksLikeBrandCompanyName,
  resolveCompanyFromText,
} from "../../tools/companyCandidateRules.js";

describe("companyCandidateRules", () => {
  it("detects repost/posted activity lines", () => {
    expect(isActivityTimestampLine("· Reposted 48 minutes ago")).toBe(true);
    expect(isActivityTimestampLine("· 2 days ago")).toBe(true);
    expect(isActivityTimestampLine("· Posted 3 hours ago")).toBe(true);
  });

  it("rejects prose and punctuation-heavy candidates", () => {
    expect(isHardRejectedCompanyCandidate("stakeholders including mathematicians")).toBe(true);
    expect(isHardRejectedCompanyCandidate("Acme, Inc.")).toBe(false);
    expect(isHardRejectedCompanyCandidate("Entry Level")).toBe(true);
    expect(isHardRejectedCompanyCandidate("a very long company name that reads like a sentence")).toBe(true);
  });

  it("accepts stylized dotted brand names like e.Republic", () => {
    expect(isValidCompanyCandidate("e.Republic")).toBe(true);
    expect(isHardRejectedCompanyCandidate("e.Republic")).toBe(false);
  });

  it("accepts short brand-like names", () => {
    expect(looksLikeBrandCompanyName("Battelle")).toBe(true);
    expect(looksLikeBrandCompanyName("Acme AI")).toBe(true);
    expect(looksLikeBrandCompanyName("Bank of America")).toBe(true);
    expect(looksLikeBrandCompanyName("e.Republic")).toBe(true);
  });

  it("extracts header company before activity timestamp", () => {
    const lines = ["Battelle", "· Reposted 48 minutes ago", "Software Engineer (Early Career)"];
    expect(extractHeaderCompanyBeforeActivity(lines)).toBe("Battelle");
  });

  it("extracts self-description leading proper noun", () => {
    const text = "Battelle is a research and development organization committed to science.";
    expect(extractCompanyFromSelfDescription(text)).toBe("Battelle");
  });

  it("extracts reinventing hiring-entity intros", () => {
    const text = "Picnic is reinventing lunch at work.";
    expect(extractCompanyFromSelfDescription(text)).toBe("Picnic");
  });

  it("accepts Simplify parenthetical brand aliases like Tria Federal (Tria)", () => {
    expect(isValidCompanyCandidate("Tria Federal (Tria)")).toBe(true);
    expect(looksLikeBrandCompanyName("Tria Federal (Tria)")).toBe(true);
    expect(isValidCompanyCandidate("Tria Federal")).toBe(true);
  });

  it("extracts company when middot chrome sits between name and timestamp", () => {
    const lines = ["Tria Federal (Tria)", "·", "3 hours ago", "Software Engineer"];
    expect(extractHeaderCompanyBeforeActivity(lines)).toBe("Tria Federal (Tria)");
  });

  it("extracts self-description with delivers verb", () => {
    const text =
      "Tria Federal delivers digital services and technology solutions that support veterans.";
    expect(extractCompanyFromSelfDescription(text)).toBe("Tria Federal");
  });

  it("rejects Simplify+ job-board chrome as a company", () => {
    expect(isValidCompanyCandidate("Simplify+")).toBe(false);
    expect(isValidCompanyCandidate("Simplify")).toBe(false);
  });

  it("extracts duplicate company before Compensation Overview", () => {
    const lines = ["Junior AI", "Junior AI", "Compensation Overview", "$150k - $190k/yr"];
    expect(extractDuplicateCompanyBeforeEmployeeCount(lines)).toBe("Junior AI");
  });

  it("expands About Junior to Junior AI when full brand is in the card", () => {
    const text = `
Junior AI
Junior AI
Compensation Overview
👶 About Junior
Junior is building the AI operating system for investment research.
`.trim();
    expect(extractCompanyFromSelfDescription(text)).toBe("Junior AI");
    expect(resolveCompanyFromText(text)).toBe("Junior AI");
  });

  it("rejects About This Role as a company and keeps Rollout", () => {
    expect(isValidCompanyCandidate("This Role")).toBe(false);
    expect(isValidCompanyCandidate("The Role")).toBe(false);
    expect(isValidCompanyCandidate("Rollout")).toBe(true);
    const text = `
Rollout
Rollout
1-10 employees
About This Role
In person, NYC.
`.trim();
    expect(resolveCompanyFromText(text)).toBe("Rollout");
  });

  it("rejects job-board UI section headers", () => {
    expect(isValidCompanyCandidate("Why This Job")).toBe(false);
    expect(isValidCompanyCandidate("Why This")).toBe(false);
    expect(isValidCompanyCandidate("What We Build")).toBe(false);
    expect(isValidCompanyCandidate("Offers Equity")).toBe(false);
    expect(isValidCompanyCandidate("Creator Home")).toBe(false);
    expect(isValidCompanyCandidate("Product")).toBe(false);
    expect(isValidCompanyCandidate("Overview")).toBe(false);
    expect(isValidCompanyCandidate("Plaid")).toBe(true);
    expect(isValidCompanyCandidate("Patreon")).toBe(true);
    expect(isValidCompanyCandidate("Rippling")).toBe(true);
    expect(isValidCompanyCandidate("Afresh")).toBe(true);
    expect(isValidCompanyCandidate("Petfolk")).toBe(true);
  });

  it("rejects self-description sentence starters", () => {
    expect(extractCompanyFromSelfDescription("This is a key role on our platform team.")).toBeNull();
    expect(isValidCompanyCandidate("This")).toBe(false);
  });
});
