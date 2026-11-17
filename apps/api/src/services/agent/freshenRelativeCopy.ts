const DAY_MS = 86_400_000;

const startOfLocalDay = (date: Date): number =>
  new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();

/** Calendar days from the event's local day to now's local day (0 = same day). */
export const calendarDaysSinceEvent = (eventAt: string, now = new Date()): number => {
  const eventMs = Date.parse(eventAt);
  if (!Number.isFinite(eventMs)) return 0;
  return Math.round((startOfLocalDay(now) - startOfLocalDay(new Date(eventMs))) / DAY_MS);
};

export type RelativeDayPhrase = { bare: string; possessive: string };

/** How to refer to the conversation/interview day from "now". */
export const relativeDayPhrase = (eventAt: string, now = new Date()): RelativeDayPhrase => {
  const days = calendarDaysSinceEvent(eventAt, now);
  if (days <= 0) return { bare: "today", possessive: "today's" };
  if (days === 1) return { bare: "yesterday", possessive: "yesterday's" };
  const event = new Date(eventAt);
  if (days < 7) {
    const weekday = event.toLocaleDateString(undefined, { weekday: "long" });
    return { bare: `on ${weekday}`, possessive: `${weekday}'s` };
  }
  const short = event.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  return { bare: `on ${short}`, possessive: `${short}` };
};

/**
 * Rewrite stale relative day wording (today / yesterday / this morning) so it matches
 * the event time as of `now`. Used when opening or creating a thank-you draft.
 */
export const freshenRelativeCopy = (text: string, eventAt: string | undefined, now = new Date()): string => {
  if (!text || !eventAt || !Number.isFinite(Date.parse(eventAt))) return text;
  const { bare, possessive } = relativeDayPhrase(eventAt, now);
  return text
    .replace(/\bearlier today\b/gi, bare)
    .replace(/\bthis (morning|afternoon|evening)\b/gi, bare)
    .replace(/\btoday's\b/gi, possessive)
    .replace(/\byesterday's\b/gi, possessive)
    .replace(/\btoday\b/gi, bare)
    .replace(/\byesterday\b/gi, bare);
};
