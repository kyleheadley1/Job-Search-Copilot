import { describe, expect, it } from "vitest";
import type { ActionType } from "../../services/gmail/actionRequest.js";
import {
  actionItems,
  buildApplications,
  companyKeyFromApplicationKey,
  filterApplicationsByLookback,
  isStageNameRole,
  matchTrackerJob,
  normalizeCompany,
  relatedApplicationsForKey,
  roleSimilarity,
  suggestTrackerStatus,
} from "../../services/gmail/gmailApplications.js";
import type { EmailEventType } from "../../services/gmail/gmailClassifier.js";
import type { StoredGmailMessage } from "../../services/gmail/gmailMessages.repository.js";
import type { JobRecord, JobStatus } from "../../types/job.js";

let seq = 0;
const msg = (
  company: string | null,
  role: string | null,
  eventType: EmailEventType,
  date: string,
  isApplicationEmail = true,
): StoredGmailMessage => {
  seq += 1;
  return {
    id: `m${seq}`,
    threadId: `t${seq}`,
    date,
    from: "jobs@example.com",
    subject: `${eventType} ${company ?? ""} ${role ?? ""}`.trim(),
    prefilterPassed: true,
    prefilterReason: "application_phrase",
    classification: { isApplicationEmail, company, role, eventType, confidence: 0.9 },
    llmSucceeded: true,
    processedAt: date,
  };
};

const job = (id: string, company: string, title: string, status: JobStatus, updatedAt = "2026-09-01T00:00:00.000Z") =>
  ({
    id,
    status,
    updatedAt,
    extracted: { company, companyDisplayName: company, title },
  }) as unknown as JobRecord;

describe("normalizeCompany / roleSimilarity", () => {
  it("strips legal suffixes and punctuation", () => {
    expect(normalizeCompany("Acme, Inc.")).toBe("acme");
    expect(normalizeCompany("Cherry Technologies")).toBe("cherry");
    expect(normalizeCompany("AT&T")).toBe(normalizeCompany("AT and T"));
  });

  it("treats abbreviations as equivalent roles", () => {
    expect(roleSimilarity("Sr. Software Engineer", "Senior Software Engineer")).toBeGreaterThanOrEqual(0.6);
    expect(roleSimilarity("Software Engineer", "Product Designer")).toBeLessThan(0.6);
  });

  it("keeps different specialties at one company apart", () => {
    expect(
      roleSimilarity("Software Engineer, Content Data Products", "Software Engineer - AI Platforms and Products (Frontend)"),
    ).toBe(0);
    expect(roleSimilarity("Front End Engineer", "Frontend Engineer")).toBeGreaterThanOrEqual(0.6);
    expect(roleSimilarity("Software Engineer", "Software Engineer, Publishing Technology")).toBeGreaterThanOrEqual(0.6);
  });
});

describe("generic and specific titles at one company", () => {
  it("files a bare 'Software Engineer' email under the company when several openings match", () => {
    const apps = buildApplications(
      [
        msg("NYT", "Software Engineer", "interview", "2026-03-25T10:00:00.000Z"),
        msg("NYT", "Software Engineer, Content Data Products", "applied", "2026-03-20T10:00:00.000Z"),
        msg("NYT", "Software Engineer - AI Platforms and Products (Frontend)", "interview", "2026-04-30T10:00:00.000Z"),
      ],
      [],
    );
    expect(apps.map((a) => `${a.role ?? "-"}:${a.emails.length}`).sort()).toEqual([
      "-:1",
      "Software Engineer - AI Platforms and Products (Frontend):1",
      "Software Engineer, Content Data Products:1",
    ]);
  });

  it("keeps the key from the first email when a generic title joins the only matching opening", () => {
    const apps = buildApplications(
      [
        msg("Brellium", "Software Engineer", "applied", "2026-03-20T10:00:00.000Z"),
        msg("Brellium", "Software Engineer, AI", "rejected", "2026-03-25T10:00:00.000Z"),
      ],
      [],
    );
    expect(apps).toHaveLength(1);
    expect(apps[0]!.key).toBe("brellium::software engineer");
  });

  it("does not mint a role-less key when the full mailbox includes the role-bearing emails", () => {
    const roleMail = msg("Axle", "Product Engineer", "interview", "2026-10-07T22:46:27.000Z");
    const calendar = msg("Axle", null, "interview", "2026-10-12T18:34:52.000Z");
    const truncated = buildApplications([calendar], []);
    const full = buildApplications([roleMail, calendar], []);
    expect(truncated.map((a) => a.key)).toEqual(["axle::"]);
    expect(full.map((a) => a.key)).toEqual(["axle::product engineer"]);
    expect(full).toHaveLength(1);
  });

  it("filters eligibility without changing grouped keys", () => {
    const apps = buildApplications(
      [
        msg("Axle", "Product Engineer", "interview", "2026-10-07T22:46:27.000Z"),
        msg("Axle", null, "interview", "2026-10-12T18:34:52.000Z"),
        msg("InHouse", "Full Stack Engineer", "applied", "2026-10-25T12:00:00.000Z"),
      ],
      [],
    );
    const now = new Date("2026-10-30T12:00:00.000Z");
    const recent = filterApplicationsByLookback(apps, 11, now);
    expect(recent.map((a) => a.key)).toEqual(["inhouse::full stack engineer"]);
    expect(relatedApplicationsForKey("axle::", apps).map((row) => row.key)).toEqual(["axle::product engineer"]);
    expect(companyKeyFromApplicationKey("axle::product engineer")).toBe("axle");
  });

  it("treats a meeting name reported as the role as role-less", () => {
    expect(isStageNameRole("Initial Screen Call")).toBe(true);
    expect(isStageNameRole("Phone Interview")).toBe(true);
    expect(isStageNameRole("Hiring Manager Interview")).toBe(true);
    expect(isStageNameRole("Junior Software Engineer")).toBe(false);
    expect(isStageNameRole("Call Center Engineer")).toBe(false);

    const apps = buildApplications(
      [
        msg("Clark", "Junior Software Engineer", "interview", "2026-10-09T21:55:00.000Z"),
        msg("Clark", "Initial Screen Call", "interview", "2026-10-10T07:19:00.000Z"),
      ],
      [],
    );
    expect(apps).toHaveLength(1);
    expect(apps[0]!.role).toBe("Junior Software Engineer");
    expect(apps[0]!.emails).toHaveLength(2);
  });

  it("still links a loosely titled email to a company's only tracker row", () => {
    const match = matchTrackerJob({ company: "Mirage", role: "Software Engineer, Backend" }, [
      job("m", "Mirage", "Software Engineer, Mirage", "applied"),
    ]);
    expect(match?.id).toBe("m");
  });
});

describe("buildApplications", () => {
  it("groups by company + role and uses the latest event for status", () => {
    const apps = buildApplications(
      [
        msg("Acme Inc", "Software Engineer", "applied", "2026-09-24T10:00:00.000Z"),
        msg("Acme", "Software Engineer II", "interview", "2026-09-27T10:00:00.000Z"),
        msg("Acme", "Product Designer", "applied", "2026-09-25T10:00:00.000Z"),
      ],
      [],
    );
    expect(apps).toHaveLength(2);
    const swe = apps.find((a) => a.role?.startsWith("Software"))!;
    expect(swe.status).toBe("interviewing");
    expect(swe.appliedAt).toBe("2026-09-24T10:00:00.000Z");
    expect(swe.lastUpdateAt).toBe("2026-09-27T10:00:00.000Z");
    expect(swe.emails.map((e) => e.eventType)).toEqual(["interview", "applied"]);
    expect(swe.emails[0]!.gmailUrl).toContain("mail.google.com");
  });

  it("falls back to the earliest email date when no applied event exists", () => {
    const [app] = buildApplications(
      [
        msg("Bubble", "Engineer", "rejected", "2026-09-29T10:00:00.000Z"),
        msg("Bubble", "Engineer", "other", "2026-09-26T10:00:00.000Z"),
      ],
      [],
    );
    expect(app!.appliedAt).toBe("2026-09-26T10:00:00.000Z");
    expect(app!.status).toBe("rejected");
  });

  it("ignores 'other' events when picking status", () => {
    const [app] = buildApplications(
      [
        msg("Fleetio", "Engineer", "assessment", "2026-09-25T10:00:00.000Z"),
        msg("Fleetio", "Engineer", "other", "2026-09-28T10:00:00.000Z"),
      ],
      [],
    );
    expect(app!.status).toBe("assessment");
    expect(app!.lastUpdateAt).toBe("2026-09-28T10:00:00.000Z");
  });

  it("breaks same-timestamp ties toward the more final event", () => {
    const at = "2026-09-28T10:00:00.000Z";
    const [app] = buildApplications(
      [msg("Wex", "SDE I", "rejected", at), msg("Wex", "SDE I", "applied", at)],
      [],
    );
    expect(app!.status).toBe("rejected");
  });

  it("attaches role-less emails to the company's only role", () => {
    const apps = buildApplications(
      [
        msg("WorldQuant", "Full Stack Developer", "applied", "2026-09-24T10:00:00.000Z"),
        msg("WorldQuant", null, "rejected", "2026-09-29T10:00:00.000Z"),
      ],
      [],
    );
    expect(apps).toHaveLength(1);
    expect(apps[0]!.status).toBe("rejected");
  });

  it("remembers an interview that ended in rejection and flags an estimated applied date", () => {
    const apps = buildApplications(
      [
        msg("Seso Labor", null, "interview", "2026-09-25T22:00:00.000Z"),
        msg("Seso", "Software Engineer, AI/Agents", "rejected", "2026-09-29T17:00:00.000Z"),
      ],
      [],
    );
    expect(apps).toHaveLength(1);
    expect(apps[0]).toMatchObject({
      status: "rejected",
      furthestStage: "interviewing",
      appliedAtKnown: false,
      appliedAt: "2026-09-25T22:00:00.000Z",
    });
  });

  it("reports a known applied date and 'applied' as the furthest stage for a plain rejection", () => {
    const [app] = buildApplications(
      [
        msg("Teleskope", "Software Engineer", "applied", "2026-09-26T10:00:00.000Z"),
        msg("Teleskope", "Software Engineer", "rejected", "2026-10-01T15:30:00.000Z"),
      ],
      [],
    );
    expect(app).toMatchObject({ furthestStage: "applied", appliedAtKnown: true });
  });

  it("skips non-application and company-less messages", () => {
    expect(
      buildApplications(
        [
          msg("Acme", "Engineer", "applied", "2026-09-24T10:00:00.000Z", false),
          msg(null, "Engineer", "applied", "2026-09-24T10:00:00.000Z"),
        ],
        [],
      ),
    ).toEqual([]);
  });

  it("keeps the tracker's applied date when the only email is a rejection", () => {
    const tracked = {
      ...job("cg", "Capgemini", "Software Engineer", "lapsed"),
      statusHistory: [{ fromStatus: "to_review", toStatus: "applied", createdAt: "2026-08-20T15:00:00.000Z" }],
    } as unknown as JobRecord;
    const [app] = buildApplications(
      [msg("Capgemini Group", "Software Engineer", "rejected", "2026-10-02T12:00:00.000Z")],
      [tracked],
    );
    expect(app).toMatchObject({
      status: "rejected",
      appliedAt: "2026-08-20T15:00:00.000Z",
      appliedAtKnown: true,
      appliedAtSource: "tracker",
      lastUpdateAt: "2026-10-02T12:00:00.000Z",
      suggestedStatus: "rejected",
    });
  });

  it("prefers the manual tracker applied date and never lets the tracker override a confirmation email", () => {
    const tracked = {
      ...job("cg", "Capgemini", "Software Engineer", "applied"),
      tracker: { appliedAt: "2026-08-18T00:00:00.000Z" },
      statusHistory: [{ fromStatus: "to_review", toStatus: "applied", createdAt: "2026-08-20T15:00:00.000Z" }],
    } as unknown as JobRecord;
    const [rejectionOnly] = buildApplications(
      [msg("Capgemini", "Software Engineer", "rejected", "2026-10-02T12:00:00.000Z")],
      [tracked],
    );
    expect(rejectionOnly!.appliedAt).toBe("2026-08-18T00:00:00.000Z");

    const [confirmed] = buildApplications(
      [
        msg("Capgemini", "Software Engineer", "applied", "2026-09-30T12:00:00.000Z"),
        msg("Capgemini", "Software Engineer", "rejected", "2026-10-02T12:00:00.000Z"),
      ],
      [tracked],
    );
    expect(confirmed).toMatchObject({ appliedAt: "2026-09-30T12:00:00.000Z", appliedAtSource: "email" });
  });

  it("leaves the date estimated when the tracker has no applied date", () => {
    const [app] = buildApplications(
      [msg("Capgemini", "Software Engineer", "rejected", "2026-10-02T12:00:00.000Z")],
      [job("cg", "Capgemini", "Software Engineer", "to_review")],
    );
    expect(app).toMatchObject({ appliedAtKnown: false, appliedAtSource: "estimated" });
  });

  it("matches tracker jobs and suggests a status update", () => {
    const [app] = buildApplications(
      [
        msg("Acme", "Senior Software Engineer", "applied", "2026-09-24T10:00:00.000Z"),
        msg("Acme", "Sr Software Engineer", "interview", "2026-09-27T10:00:00.000Z"),
      ],
      [job("j1", "Acme Inc.", "Senior Software Engineer", "applied"), job("j2", "Other", "Engineer", "applied")],
    );
    expect(app).toMatchObject({
      trackerJobId: "j1",
      trackerStatus: "applied",
      suggestedStatus: "interviewing",
    });
  });
});

describe("pendingAction / actionItems", () => {
  const now = Date.parse("2026-10-04T12:00:00.000Z");
  const asking = (company: string, date: string, type: ActionType = "schedule", deadline: string | null = null) => {
    const m = msg(company, "Software Engineer", "interview", date);
    m.classification!.action = { needed: true, type, summary: "Pick a time", deadline, version: 1 };
    return m;
  };

  it("lists the latest open request with its email link", () => {
    const [app] = buildApplications([asking("Axle", "2026-10-03T10:00:00.000Z")], [], now);
    expect(app!.actionNeeded).toMatchObject({ type: "schedule", summary: "Pick a time", receivedAt: "2026-10-03T10:00:00.000Z" });
    expect(app!.actionNeeded!.gmailUrl).toContain("mail.google.com");
  });

  it("clears when you replied, marked it done, or a later email moved things along", () => {
    const replied = asking("Axle", "2026-10-03T10:00:00.000Z");
    replied.actionRepliedAt = "2026-10-03T12:00:00.000Z";
    const dismissed = asking("Bolt", "2026-10-03T10:00:00.000Z");
    dismissed.actionDismissedAt = "2026-10-03T12:00:00.000Z";
    const apps = buildApplications(
      [
        replied,
        dismissed,
        asking("Cove", "2026-10-02T10:00:00.000Z"),
        msg("Cove", "Software Engineer", "interview", "2026-10-03T09:00:00.000Z"),
      ],
      [],
      now,
    );
    expect(apps.every((a) => !a.actionNeeded)).toBe(true);
  });

  it("drops requests after 14 quiet days and on rejection", () => {
    const apps = buildApplications(
      [
        asking("Old", "2026-09-15T10:00:00.000Z"),
        asking("Done", "2026-10-01T10:00:00.000Z"),
        msg("Done", "Software Engineer", "rejected", "2026-10-01T10:00:00.000Z"),
      ],
      [],
      now,
    );
    expect(apps.every((a) => !a.actionNeeded)).toBe(true);
  });

  it("a follow-up that asks again replaces the earlier request", () => {
    const [app] = buildApplications(
      [asking("Axle", "2026-10-01T10:00:00.000Z", "reply"), asking("Axle", "2026-10-03T10:00:00.000Z", "assessment")],
      [],
      now,
    );
    expect(app!.actionNeeded!.type).toBe("assessment");
  });

  it("orders by deadline, then by how long it has waited", () => {
    const apps = buildApplications(
      [
        asking("Late", "2026-10-01T10:00:00.000Z"),
        asking("Soon", "2026-10-03T10:00:00.000Z", "assessment", "2026-10-05T23:00:00.000Z"),
        asking("Newer", "2026-10-03T11:00:00.000Z"),
      ],
      [],
      now,
    );
    expect(actionItems(apps).map((a) => a.company)).toEqual(["Soon", "Late", "Newer"]);
  });
});

describe("matchTrackerJob", () => {
  const jobs = [
    job("a", "Acme", "Software Engineer", "applied", "2026-09-01T00:00:00.000Z"),
    job("b", "Acme", "Software Engineer", "to_review", "2026-09-10T00:00:00.000Z"),
    job("c", "Acme", "Data Analyst", "applied"),
  ];

  it("prefers the most recently updated among equal role matches", () => {
    expect(matchTrackerJob({ company: "Acme", role: "Software Engineer" }, jobs)?.id).toBe("b");
  });

  it("returns undefined for an ambiguous role-less match", () => {
    expect(matchTrackerJob({ company: "Acme", role: null }, jobs)).toBeUndefined();
  });

  it("returns the single company job when role is missing", () => {
    expect(matchTrackerJob({ company: "Solo", role: null }, [job("s", "Solo LLC", "Engineer", "applied")])?.id).toBe("s");
  });

  it("does not match unrelated roles", () => {
    expect(matchTrackerJob({ company: "Acme", role: "Product Designer" }, jobs)).toBeUndefined();
  });

  it("matches when one company name leads the other word for word", () => {
    const pave = [job("p", "Pave", "Software Engineer 1", "applied")];
    expect(matchTrackerJob({ company: "Pave Finance", role: "Software Engineer" }, pave)?.id).toBe("p");
  });

  it("does not match a company that only shares a word prefix", () => {
    const block = [job("x", "Blockchain Capital", "Software Engineer", "applied")];
    expect(matchTrackerJob({ company: "Block", role: "Software Engineer" }, block)).toBeUndefined();
  });
});

describe("suggestTrackerStatus", () => {
  it("only moves forward in the pipeline", () => {
    expect(suggestTrackerStatus("to_review", "applied")).toBe("applied");
    expect(suggestTrackerStatus("applied", "interviewing")).toBe("interviewing");
    expect(suggestTrackerStatus("interviewing", "assessment")).toBeUndefined();
    expect(suggestTrackerStatus("applied", "applied")).toBeUndefined();
  });

  it("always suggests rejected/offer unless already terminal", () => {
    expect(suggestTrackerStatus("interviewing", "rejected")).toBe("rejected");
    expect(suggestTrackerStatus("assessment", "offer")).toBe("offer");
    expect(suggestTrackerStatus("closed", "rejected")).toBeUndefined();
    expect(suggestTrackerStatus("rejected", "interviewing")).toBeUndefined();
  });

  it("moves a lapsed row forward when email shows later progress", () => {
    expect(suggestTrackerStatus("lapsed", "interviewing")).toBe("interviewing");
    expect(suggestTrackerStatus("lapsed", "assessment")).toBe("assessment");
    expect(suggestTrackerStatus("lapsed", "rejected")).toBe("rejected");
    expect(suggestTrackerStatus("lapsed", "applied")).toBeUndefined();
  });
});
