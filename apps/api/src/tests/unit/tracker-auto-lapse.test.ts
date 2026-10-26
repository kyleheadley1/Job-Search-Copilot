import { describe, expect, it, vi } from "vitest";
import type { GmailApplication } from "../../services/gmail/gmailApplications.js";
import { applyAutomaticTrackerUpdates } from "../../services/gmail/trackerAutoLapse.js";

const NOW = Date.parse("2026-10-26T12:00:00.000Z");
const daysAgo = (d: number) => new Date(NOW - d * 86_400_000).toISOString();

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
  lastUpdateAt: daysAgo(35),
  emails: [
    {
      id: "e1",
      subject: "Thanks for applying",
      from: "jobs@acme.com",
      date: daysAgo(35),
      eventType: "applied",
      gmailUrl: "https://mail.google.com/x",
    },
  ],
  trackerJobId: "job-1",
  trackerStatus: "applied",
  ...over,
});

describe("applyAutomaticTrackerUpdates", () => {
  it("lapses a silent open tracker row without creating a Next steps card", async () => {
    const updateStatus = vi.fn(async () => ({}));
    const result = await applyAutomaticTrackerUpdates([app()], { updateStatus }, NOW);
    expect(result).toEqual({ lapsed: 1, revived: 0 });
    expect(updateStatus).toHaveBeenCalledWith("job-1", "lapsed", expect.stringMatching(/auto-lapse: no email for 35d/));
  });

  it("revives a lapsed row when a later email moves the process forward", async () => {
    const updateStatus = vi.fn(async () => ({}));
    const result = await applyAutomaticTrackerUpdates(
      [
        app({
          status: "interviewing",
          furthestStage: "interviewing",
          trackerStatus: "lapsed",
          suggestedStatus: "interviewing",
          lastUpdateAt: daysAgo(1),
          emails: [
            {
              id: "e2",
              subject: "Interview with Acme",
              from: "recruiter@acme.com",
              date: daysAgo(1),
              eventType: "interview",
              gmailUrl: "https://mail.google.com/x",
            },
          ],
        }),
      ],
      { updateStatus },
      NOW,
    );
    expect(result).toEqual({ lapsed: 0, revived: 1 });
    expect(updateStatus).toHaveBeenCalledWith("job-1", "interviewing", "From Gmail: Interview with Acme");
  });

  it("does not re-lapse an already lapsed row with no new progress", async () => {
    const updateStatus = vi.fn(async () => ({}));
    const result = await applyAutomaticTrackerUpdates([app({ trackerStatus: "lapsed" })], { updateStatus }, NOW);
    expect(result).toEqual({ lapsed: 0, revived: 0 });
    expect(updateStatus).not.toHaveBeenCalled();
  });
});
