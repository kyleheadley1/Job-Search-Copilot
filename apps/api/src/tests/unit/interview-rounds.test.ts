import { describe, expect, it } from "vitest";
import { buildApplications, upcomingInterviews } from "../../services/gmail/gmailApplications.js";
import type { EmailEventType } from "../../services/gmail/gmailClassifier.js";
import type { StoredGmailMessage } from "../../services/gmail/gmailMessages.repository.js";
import {
  buildInterviewRounds,
  INTERVIEW_DETAIL_VERSION,
  ordinal,
  roundLabel,
  type InterviewDetail,
} from "../../services/gmail/interviewRounds.js";

let seq = 0;
const msg = (
  eventType: EmailEventType,
  date: string,
  interview?: Partial<InterviewDetail>,
): StoredGmailMessage => {
  seq += 1;
  return {
    id: `r${seq}`,
    threadId: `t${seq}`,
    date,
    from: "recruiting@acme.com",
    subject: `${eventType} ${seq}`,
    prefilterPassed: true,
    prefilterReason: "application_phrase",
    classification: {
      isApplicationEmail: true,
      company: "Acme",
      role: "Software Engineer",
      eventType,
      confidence: 0.9,
      ...(interview
        ? {
            interview: {
              roundNumber: null,
              kind: null,
              focus: null,
              interviewers: null,
              advancesToNextRound: false,
              scheduledAt: null,
              durationMinutes: null,
              cancelled: false,
              version: INTERVIEW_DETAIL_VERSION,
              ...interview,
            },
          }
        : {}),
    },
    llmSucceeded: true,
    processedAt: date,
  };
};

const atCompany = (company: string, m: StoredGmailMessage): StoredGmailMessage => ({
  ...m,
  classification: { ...m.classification!, company },
});

describe("roundLabel", () => {
  it("calls an unknown or recruiter first round a recruiter screen", () => {
    expect(roundLabel({ number: 1, kind: null, focus: null, interviewers: null })).toBe("Recruiter screen");
    expect(roundLabel({ number: 1, kind: "recruiter_screen", focus: null, interviewers: "Jane Doe" })).toBe(
      "Recruiter screen with Jane Doe",
    );
  });

  it("names later rounds by number, with what/who when known", () => {
    expect(roundLabel({ number: 2, kind: null, focus: null, interviewers: null })).toBe("2nd round");
    expect(roundLabel({ number: 2, kind: "other", focus: null, interviewers: null })).toBe("2nd round");
    expect(roundLabel({ number: 3, kind: "technical", focus: null, interviewers: "Sam Lee (Staff Engineer)" })).toBe(
      "3rd round · technical with Sam Lee (Staff Engineer)",
    );
    expect(roundLabel({ number: 2, kind: "technical", focus: "live coding", interviewers: null })).toBe(
      "2nd round · live coding",
    );
  });

  it("formats ordinals", () => {
    expect([1, 2, 3, 4, 11, 12, 13, 21, 22].map(ordinal)).toEqual([
      "1st", "2nd", "3rd", "4th", "11th", "12th", "13th", "21st", "22nd",
    ]);
  });
});

describe("buildInterviewRounds", () => {
  it("folds an invite, calendar invite, and reschedule into one round", () => {
    const rounds = buildInterviewRounds([
      msg("interview", "2026-09-01T10:00:00.000Z", { kind: "recruiter_screen", advancesToNextRound: true }),
      msg("interview", "2026-09-02T10:00:00.000Z", { interviewers: "Jane Doe" }),
      msg("interview", "2026-09-04T10:00:00.000Z", {}),
    ]);
    expect(rounds).toHaveLength(1);
    expect(rounds[0]!.label).toBe("Recruiter screen with Jane Doe");
    expect(rounds[0]!.emailIds).toHaveLength(3);
  });

  it("starts a new round when the email says the candidate advanced", () => {
    const rounds = buildInterviewRounds([
      msg("interview", "2026-09-01T10:00:00.000Z", { kind: "recruiter_screen" }),
      msg("interview", "2026-09-05T10:00:00.000Z", { advancesToNextRound: true }),
      msg("interview", "2026-09-06T10:00:00.000Z", { interviewers: "Sam Lee" }),
    ]);
    expect(rounds.map((r) => r.label)).toEqual(["Recruiter screen", "2nd round with Sam Lee"]);
  });

  it("starts a new round when the interview kind changes", () => {
    const rounds = buildInterviewRounds([
      msg("interview", "2026-09-01T10:00:00.000Z", { kind: "recruiter_screen" }),
      msg("interview", "2026-09-03T10:00:00.000Z", { kind: "technical" }),
      msg("interview", "2026-09-09T10:00:00.000Z", { kind: "final" }),
    ]);
    expect(rounds.map((r) => r.label)).toEqual(["Recruiter screen", "2nd round · technical", "3rd round · final"]);
  });

  it("honors an explicit round number, even when earlier rounds left no email", () => {
    const rounds = buildInterviewRounds([
      msg("interview", "2026-09-01T10:00:00.000Z", {}),
      msg("interview", "2026-09-03T10:00:00.000Z", { roundNumber: 3 }),
    ]);
    expect(rounds.map((r) => r.number)).toEqual([1, 3]);
  });

  it("falls back to time gaps when an email has no extracted details yet", () => {
    const rounds = buildInterviewRounds([
      msg("interview", "2026-08-01T10:00:00.000Z"),
      msg("interview", "2026-08-03T10:00:00.000Z"),
      msg("interview", "2026-08-25T10:00:00.000Z"),
    ]);
    expect(rounds.map((r) => r.label)).toEqual(["Recruiter screen", "2nd round"]);
  });
});

describe("applications carry interview rounds", () => {
  it("shows the round a rejected application reached and tags each email", () => {
    const [app] = buildApplications(
      [
        msg("applied", "2026-08-20T10:00:00.000Z"),
        msg("interview", "2026-09-01T10:00:00.000Z", { kind: "recruiter_screen" }),
        msg("interview", "2026-09-08T10:00:00.000Z", { advancesToNextRound: true, kind: "hiring_manager" }),
        msg("rejected", "2026-09-15T10:00:00.000Z"),
      ],
      [],
    );
    expect(app!.status).toBe("rejected");
    expect(app!.interviewRounds.map((r) => r.label)).toEqual(["Recruiter screen", "2nd round · hiring manager"]);
    expect(app!.emails.filter((e) => e.round).map((e) => e.round)).toEqual([2, 1]);
  });
});

describe("multi-step process (recruiter screen, then a meeting with someone else)", () => {
  const from = (sender: string, m: StoredGmailMessage): StoredGmailMessage => ({ ...m, from: sender });
  const roleless = (company: string, m: StoredGmailMessage): StoredGmailMessage => ({
    ...m,
    classification: { ...m.classification!, company, role: null },
  });
  const process = () => [
    from("no-reply@us.greenhouse-mail.io", roleless("Seso", msg("applied", "2026-09-18T17:48:01.000Z"))),
    from(
      "Mary Ann <maryann@sesolabor.com>",
      atCompany("Seso", msg("interview", "2026-09-21T14:59:09.000Z", { kind: "recruiter_screen", interviewers: "Mary Ann" })),
    ),
    from(
      "Mary Ann <maryann@sesolabor.com>",
      roleless("SesolaBor", msg("interview", "2026-09-21T15:45:01.000Z", { kind: "recruiter_screen", scheduledAt: "2026-09-23T14:30:00.000Z", durationMinutes: 30 })),
    ),
    from(
      "Rush Moody <rush@sesolabor.com>",
      roleless("Seso", msg("interview", "2026-09-25T22:22:11.000Z", { kind: "recruiter_screen", interviewers: "Rush Moody", scheduledAt: "2026-09-28T19:00:00.000Z", durationMinutes: 30 })),
    ),
  ];

  it("folds a role-less invite named after the sender domain into the company's application", () => {
    const apps = buildApplications(process(), [], Date.parse("2026-09-26T12:00:00.000Z"));
    expect(apps).toHaveLength(1);
    expect(apps[0]!.company).toBe("Seso");
    expect(apps[0]!.role).toBe("Software Engineer");
  });

  it("treats a new booking made after the previous interview took place as the next round", () => {
    const [app] = buildApplications(
      [...process(), from("Rush Moody <rush@sesolabor.com>", atCompany("Seso", msg("rejected", "2026-09-29T17:00:15.000Z")))],
      [],
      Date.parse("2026-10-02T12:00:00.000Z"),
    );
    expect(app!.status).toBe("rejected");
    expect(app!.interviewRounds.map((r) => r.label)).toEqual([
      "Recruiter screen with Mary Ann",
      "2nd round · recruiter screen with Rush Moody",
    ]);
    expect(app!.activelyInterviewing).toBe(false);
  });

  it("is actively interviewing only while open with upcoming or recent interview activity", () => {
    const [upcoming] = buildApplications(process(), [], Date.parse("2026-09-26T12:00:00.000Z"));
    expect(upcoming!.activelyInterviewing).toBe(true);
    const [stale] = buildApplications(process(), [], Date.parse("2026-11-15T12:00:00.000Z"));
    expect(stale!.status).toBe("interviewing");
    expect(stale!.activelyInterviewing).toBe(false);
  });
});

describe("interview scheduling", () => {
  it("keeps the latest time when a round is rescheduled, and merges invites for the same slot", () => {
    const invite = msg("interview", "2026-09-01T10:00:00.000Z", {
      kind: "technical",
      scheduledAt: "2026-09-10T19:00:00.000Z",
    });
    const sameSlot = msg("interview", "2026-09-02T10:00:00.000Z", { scheduledAt: "2026-09-10T19:00:00.000Z" });
    const reschedule = msg("interview", "2026-09-05T10:00:00.000Z", {
      scheduledAt: "2026-09-12T15:00:00.000Z",
      durationMinutes: 45,
    });
    reschedule.subject = "Updated invitation: Interview with Acme @ Fri Sep 12";
    const rounds = buildInterviewRounds([invite, sameSlot, reschedule]);
    expect(rounds).toHaveLength(1);
    expect(rounds[0]).toMatchObject({ scheduledAt: "2026-09-12T15:00:00.000Z", durationMinutes: 45, cancelled: false });
  });

  it("does not let a confirmation reply overwrite the invite time with a DST-skewed conversion", () => {
    const invite = msg("interview", "2026-11-18T00:02:05.000Z", {
      kind: "final",
      scheduledAt: "2026-11-19T21:40:00.000Z",
      durationMinutes: 20,
    });
    invite.subject = "You're invited to your Claude Corps final-round interview!";
    const reply = msg("interview", "2026-11-18T01:45:22.000Z", {
      kind: "final",
      // Wrong: treated 1:40 PM PT as PDT (-07) instead of PST (-08) in November.
      scheduledAt: "2026-11-19T20:40:00.000Z",
      durationMinutes: 20,
    });
    reply.subject = "Re: You're invited to your Claude Corps final-round interview!";
    const rounds = buildInterviewRounds([invite, reply]);
    expect(rounds).toHaveLength(1);
    expect(rounds[0]!.scheduledAt).toBe("2026-11-19T21:40:00.000Z");
  });

  it("marks a round cancelled when a later email cancels it", () => {
    const rounds = buildInterviewRounds([
      msg("interview", "2026-09-01T10:00:00.000Z", { scheduledAt: "2026-09-05T15:00:00.000Z" }),
      msg("interview", "2026-09-02T10:00:00.000Z", { cancelled: true }),
    ]);
    expect(rounds[0]!.cancelled).toBe(true);
  });

  it("lists confirmed future interviews soonest first, skipping past, cancelled, and closed ones", () => {
    seq = 1000;
    const apps = buildApplications(
      [
        atCompany("Beta", msg("interview", "2026-09-28T10:00:00.000Z", { scheduledAt: "2026-10-08T15:00:00.000Z" })),
        msg("interview", "2026-09-20T10:00:00.000Z", { kind: "recruiter_screen", scheduledAt: "2026-09-22T15:00:00.000Z" }),
        msg("interview", "2026-09-29T10:00:00.000Z", { advancesToNextRound: true, kind: "technical", scheduledAt: "2026-10-05T18:00:00.000Z", durationMinutes: 60 }),
      ],
      [],
    );
    const list = upcomingInterviews(apps, Date.parse("2026-10-02T12:00:00.000Z"));
    expect(list.map((i) => [i.company, i.label, i.scheduledAt])).toEqual([
      ["Acme", "2nd round · technical", "2026-10-05T18:00:00.000Z"],
      ["Beta", "Recruiter screen", "2026-10-08T15:00:00.000Z"],
    ]);
    expect(list[0]!.gmailUrl).toContain("mail.google.com");

    const rejected = buildApplications(
      [
        msg("interview", "2026-09-29T10:00:00.000Z", { scheduledAt: "2026-10-05T18:00:00.000Z" }),
        msg("rejected", "2026-09-30T10:00:00.000Z"),
      ],
      [],
    );
    expect(upcomingInterviews(rejected, Date.parse("2026-10-02T12:00:00.000Z"))).toEqual([]);
  });
});
