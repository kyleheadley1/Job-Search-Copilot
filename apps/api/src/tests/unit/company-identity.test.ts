import { describe, expect, it } from "vitest";
import {
  companyKeyVariants,
  platformAccountId,
  resolveCompanyKey,
} from "../../services/gmail/companyIdentity.js";
import { buildApplications, normalizeCompany, sameCompany } from "../../services/gmail/gmailApplications.js";
import type { EmailEventType } from "../../services/gmail/gmailClassifier.js";
import type { StoredGmailMessage } from "../../services/gmail/gmailMessages.repository.js";

let seq = 0;
const msg = (
  company: string,
  role: string | null,
  eventType: EmailEventType,
  date: string,
  from: string,
  platformAccount?: string,
): StoredGmailMessage => {
  seq += 1;
  return {
    id: `m${seq}`,
    threadId: `t${seq}`,
    date,
    from,
    subject: `${eventType} ${company}`,
    ...(platformAccount ? { platformAccount } : {}),
    prefilterPassed: true,
    prefilterReason: "test",
    classification: { isApplicationEmail: true, company, role, eventType, confidence: 0.9 },
    llmSucceeded: true,
    processedAt: date,
  };
};

describe("company identity", () => {
  it("collapses known aliases onto a canonical key", () => {
    expect(resolveCompanyKey("Evolent")).toBe("evolent health");
    expect(resolveCompanyKey("Evolent Health")).toBe("evolent health");
    expect(resolveCompanyKey("STLabs")).toBe("standard template");
    expect(resolveCompanyKey("Standard Template Labs")).toBe("standard template");
    expect(resolveCompanyKey("Lift Enablement")).toBe("imagine");
    expect(resolveCompanyKey("Imagine LLC")).toBe("imagine");
    expect(normalizeCompany("Evolent")).toBe(normalizeCompany("Evolent Health"));
    expect(sameCompany("Evolent", "Evolent Health")).toBe(true);
    expect(companyKeyVariants("evolent")).toEqual(expect.arrayContaining(["evolent", "evolent health"]));
  });

  it("extracts Workday and Ashby platform accounts", () => {
    expect(platformAccountId("Workday Evolent <evolent@myworkday.com>")).toBe("workday:evolent");
    expect(platformAccountId("Evolent Recruiting Team <evolent@myworkday.com>")).toBe("workday:evolent");
    expect(platformAccountId("Standard Template Labs <no-reply@ashbyhq.com>")).toBeNull();
    expect(
      platformAccountId("Standard Template Labs <no-reply@ashbyhq.com>", [
        "https://www.ashbyhq.com/resources/report-abuse?organizationId=5868cd82-150c-41a5-a1de-11b033d29523&emailId=abc",
      ]),
    ).toBe("ashby:5868cd82-150c-41a5-a1de-11b033d29523");
  });

  it("merges Evolent / Evolent Health mail from the same Workday account into one application", () => {
    const apps = buildApplications(
      [
        msg(
          "Evolent",
          "Software Engineer",
          "applied",
          "2026-10-22T20:22:03.000Z",
          "Workday Evolent <evolent@myworkday.com>",
        ),
        msg(
          "Evolent",
          "Software Engineer",
          "rejected",
          "2026-11-16T21:37:53.000Z",
          "Evolent Recruiting Team <evolent@myworkday.com>",
        ),
        msg(
          "Evolent Health",
          "Software Engineer",
          "rejected",
          "2026-11-16T21:38:19.000Z",
          "Workday Evolent <evolent@myworkday.com>",
        ),
      ],
      [],
    );
    expect(apps).toHaveLength(1);
    expect(apps[0]).toMatchObject({
      key: "evolent health::software engineer",
      company: "Evolent Health",
      role: "Software Engineer",
      status: "rejected",
    });
    expect(apps[0]!.emails).toHaveLength(3);
  });

  it("merges differently named companies that share an Ashby organization id", () => {
    const apps = buildApplications(
      [
        msg(
          "STLabs",
          "Forward Deployed Engineer",
          "applied",
          "2026-11-15T01:24:27.000Z",
          "STLabs <no-reply@ashbyhq.com>",
          "ashby:5868cd82-150c-41a5-a1de-11b033d29523",
        ),
        msg(
          "Standard Template Labs",
          "Software Engineer, Agents",
          "applied",
          "2026-11-15T00:03:24.000Z",
          "Standard Template Labs <no-reply@ashbyhq.com>",
          "ashby:5868cd82-150c-41a5-a1de-11b033d29523",
        ),
      ],
      [],
    );
    expect(new Set(apps.map((a) => a.company))).toEqual(new Set(["Standard Template Labs"]));
    expect(apps.map((a) => a.key).sort()).toEqual([
      "standard template::forward deployed engineer",
      "standard template::software engineer agents",
    ]);
  });

  it("merges unrelated display names that share a Workday tenant mailbox", () => {
    const apps = buildApplications(
      [
        msg(
          "Alpha Systems",
          "Software Engineer",
          "applied",
          "2026-10-01T12:00:00.000Z",
          "Workday <alphasys@myworkday.com>",
        ),
        msg(
          "Beta Industries",
          "Software Engineer",
          "rejected",
          "2026-10-05T12:00:00.000Z",
          "Recruiting <alphasys@myworkday.com>",
        ),
      ],
      [],
    );
    expect(apps).toHaveLength(1);
    expect(apps[0]!.emails).toHaveLength(2);
    expect(apps[0]!.status).toBe("rejected");
  });
});
