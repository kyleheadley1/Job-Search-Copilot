import { describe, expect, it } from "vitest";
import { gatherCandidates, shouldAutoLapse } from "../../services/agent/candidates.js";
import type { GmailApplication } from "../../services/gmail/gmailApplications.js";
import type { InterviewRound } from "../../services/gmail/interviewRounds.js";

const NOW = Date.parse("2026-10-04T12:00:00.000Z");
const daysAgo = (d: number) => new Date(NOW - d * 86_400_000).toISOString();
const hoursFromNow = (h: number) => new Date(NOW + h * 3_600_000).toISOString();

const round = (over: Partial<InterviewRound> = {}): InterviewRound => ({
  number: 1,
  kind: "technical",
  focus: null,
  interviewers: null,
  startedAt: daysAgo(10),
  lastEmailAt: daysAgo(10),
  emailIds: ["e1"],
  scheduledAt: null,
  durationMinutes: 60,
  cancelled: false,
  label: "Technical",
  ...over,
});

const app = (over: Partial<GmailApplication> = {}): GmailApplication => ({
  key: "acme::software engineer",
  company: "Acme",
  role: "Software Engineer",
  appliedAt: daysAgo(40),
  appliedAtKnown: true,
  appliedAtSource: "email",
  status: "applied",
  furthestStage: "applied",
  interviewRounds: [],
  activelyInterviewing: false,
  lastUpdateAt: daysAgo(2),
  emails: [],
  ...over,
});

const kinds = (apps: GmailApplication[]) => gatherCandidates(apps, NOW).map((c) => c.kind);

describe("gatherCandidates", () => {
  it("turns an open request into a respond step, urgent when the deadline is close", () => {
    const [c] = gatherCandidates(
      [
        app({
          actionNeeded: {
            emailId: "m1",
            threadId: "t1",
            type: "schedule",
            summary: "Pick a time for the onsite",
            deadline: hoursFromNow(20),
            receivedAt: daysAgo(1),
            gmailUrl: "https://mail.google.com/x",
          },
        }),
      ],
      NOW,
    );
    expect(c).toMatchObject({ kind: "action_reply", priority: 5, draftable: true, id: "action_reply:acme::software engineer:m1" });
    expect(c!.gmailUrl).toBe("https://mail.google.com/x");
  });

  it("reminds to prep for an interview within 3 days and to thank after one just held", () => {
    expect(
      kinds([app({ status: "interviewing", furthestStage: "interviewing", interviewRounds: [round({ scheduledAt: hoursFromNow(30) })] })]),
    ).toEqual(["interview_prep"]);
    expect(
      kinds([app({ status: "interviewing", furthestStage: "interviewing", interviewRounds: [round({ scheduledAt: hoursFromNow(24 * 5) })] })]),
    ).toEqual([]);
    expect(
      kinds([app({ status: "interviewing", furthestStage: "interviewing", interviewRounds: [round({ scheduledAt: daysAgo(1) })] })]),
    ).toEqual(["thank_you"]);
  });

  it("suggests a follow-up only mid-process after a week of silence", () => {
    const mid = { status: "interviewing" as const, furthestStage: "interviewing" as const, interviewRounds: [round({ scheduledAt: daysAgo(12) })] };
    expect(kinds([app({ ...mid, lastUpdateAt: daysAgo(9) })])).toEqual(["follow_up"]);
    expect(kinds([app({ ...mid, lastUpdateAt: daysAgo(3) })])).toEqual([]);
    expect(kinds([app({ lastUpdateAt: daysAgo(9) })])).toEqual([]);
  });

  it("flags a silent tracked application for auto-lapse, not a Next steps card", () => {
    expect(shouldAutoLapse(app({ lastUpdateAt: daysAgo(35), trackerJobId: "job-1", trackerStatus: "applied" }), NOW)).toBe(
      true,
    );
    expect(shouldAutoLapse(app({ lastUpdateAt: daysAgo(35) }), NOW)).toBe(false);
    expect(shouldAutoLapse(app({ lastUpdateAt: daysAgo(35), trackerJobId: "job-1", trackerStatus: "lapsed" }), NOW)).toBe(
      false,
    );
    expect(
      shouldAutoLapse(
        app({
          lastUpdateAt: daysAgo(35),
          trackerJobId: "job-1",
          trackerStatus: "applied",
          interviewRounds: [round({ scheduledAt: hoursFromNow(5) })],
        }),
        NOW,
      ),
    ).toBe(false);
  });

  it("does not put silent tracker rows on Next steps — those auto-lapse", () => {
    expect(kinds([app({ lastUpdateAt: daysAgo(35), trackerJobId: "job-1", trackerStatus: "applied" })])).toEqual([]);
    expect(kinds([app({ lastUpdateAt: daysAgo(35) })])).toEqual([]);
    expect(kinds([app({ lastUpdateAt: daysAgo(35), trackerJobId: "job-1", trackerStatus: "lapsed" })])).toEqual([]);
  });

  it("ignores rejected applications and sorts urgent steps first", () => {
    expect(kinds([app({ status: "rejected", lastUpdateAt: daysAgo(40), trackerJobId: "j", trackerStatus: "applied" })])).toEqual([]);
    const ordered = kinds([
      app({ key: "a", lastUpdateAt: daysAgo(35), trackerJobId: "j", trackerStatus: "applied" }),
      app({ key: "b", status: "interviewing", furthestStage: "interviewing", interviewRounds: [round({ scheduledAt: hoursFromNow(5) })] }),
    ]);
    expect(ordered).toEqual(["interview_prep"]);
  });
});
