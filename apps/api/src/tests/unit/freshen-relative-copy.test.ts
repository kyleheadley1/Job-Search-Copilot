import { describe, expect, it } from "vitest";
import {
  calendarDaysSinceEvent,
  freshenRelativeCopy,
  relativeDayPhrase,
} from "../../services/agent/freshenRelativeCopy.js";

describe("freshenRelativeCopy", () => {
  const now = new Date("2026-11-17T16:00:00.000Z");

  it("maps interview day to today / yesterday / weekday", () => {
    expect(relativeDayPhrase("2026-11-17T21:00:00.000Z", now)).toEqual({
      bare: "today",
      possessive: "today's",
    });
    expect(relativeDayPhrase("2026-11-16T21:00:00.000Z", now).bare).toBe("yesterday");
    expect(calendarDaysSinceEvent("2026-11-16T21:00:00.000Z", now)).toBe(1);
  });

  it("rewrites today to yesterday when the conversation was yesterday", () => {
    const draft =
      "Hi Yasten,\n\nThank you for speaking with me today about the Claude Corps Fellowship. I enjoyed learning more about the role.\n\nBest,";
    expect(freshenRelativeCopy(draft, "2026-11-16T21:00:00.000Z", now)).toContain(
      "speaking with me yesterday about the Claude Corps Fellowship",
    );
    expect(freshenRelativeCopy(draft, "2026-11-16T21:00:00.000Z", now)).not.toContain("speaking with me today");
  });

  it("rewrites reason lines that say today's screen", () => {
    expect(
      freshenRelativeCopy(
        "Timely follow-up keeps momentum after today's recruiter screen; send a concise thank-you.",
        "2026-11-16T21:00:00.000Z",
        now,
      ),
    ).toContain("yesterday's recruiter screen");
  });

  it("leaves text alone without an event time", () => {
    expect(freshenRelativeCopy("Thanks for speaking with me today.", undefined, now)).toBe(
      "Thanks for speaking with me today.",
    );
  });
});
