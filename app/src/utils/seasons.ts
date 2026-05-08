/**
 * Meteorological seasons (used by climatologists; aligns calendar months
 * with seasons cleanly, which makes monthly + seasonal aggregates consistent).
 *
 *   Winter: Dec, Jan, Feb
 *   Spring: Mar, Apr, May
 *   Summer: Jun, Jul, Aug
 *   Fall:   Sep, Oct, Nov
 */
export type Season = "Winter" | "Spring" | "Summer" | "Fall";

export const SEASONS: Season[] = ["Winter", "Spring", "Summer", "Fall"];

export function parseISO(d: string): Date {
  // Treat as local date to avoid timezone surprises with date-only strings
  const [y, m, day] = d.split("-").map(Number);
  return new Date(y, m - 1, day);
}

export function formatISO(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function addDays(d: Date, n: number): Date {
  const c = new Date(d);
  c.setDate(c.getDate() + n);
  return c;
}

/** Saturday of the week containing `d` (Saturday-anchored weeks). */
export function saturdayOf(d: Date): Date {
  const dow = d.getDay(); // Sun=0..Sat=6
  const back = (dow + 1) % 7; // days since Saturday
  return addDays(d, -back);
}

export function seasonOfMonth(monthIdx: number): Season {
  if (monthIdx === 11 || monthIdx === 0 || monthIdx === 1) return "Winter";
  if (monthIdx >= 2 && monthIdx <= 4) return "Spring";
  if (monthIdx >= 5 && monthIdx <= 7) return "Summer";
  return "Fall";
}

/** Returns the calendar year that "owns" the season for the given date.
 *  Winter spans Dec(year)+Jan/Feb(year+1); we attribute the whole winter
 *  to the year in which it ENDS (so Dec 2025 belongs to Winter 2026). */
export function seasonYear(d: Date): number {
  const m = d.getMonth();
  const y = d.getFullYear();
  if (m === 11) return y + 1;
  return y;
}

/** First Saturday on or after the start of the season containing `d`. */
export function firstSaturdayOfSeason(d: Date): Date {
  const m = d.getMonth();
  const y = d.getFullYear();
  let startMonth: number;
  let startYear = y;
  if (m === 11) {
    startMonth = 11; // Dec start
  } else if (m === 0 || m === 1) {
    startMonth = 11;
    startYear = y - 1;
  } else if (m >= 2 && m <= 4) {
    startMonth = 2;
  } else if (m >= 5 && m <= 7) {
    startMonth = 5;
  } else {
    startMonth = 8;
  }
  const seasonStart = new Date(startYear, startMonth, 1);
  const dow = seasonStart.getDay(); // Sun=0..Sat=6
  const fwd = (6 - dow + 7) % 7;
  return addDays(seasonStart, fwd);
}

export interface SeasonLabel {
  season: Season;
  year: number;
  weekInSeason: number; // 1-based
  display: string; // e.g. "Spring 2026 · Week 4"
  short: string; // e.g. "Spring W4"
}

export function labelForWeekStart(saturday: Date): SeasonLabel {
  const season = seasonOfMonth(saturday.getMonth());
  const year = seasonYear(saturday);
  const seasonStart = firstSaturdayOfSeason(saturday);
  const diffDays = Math.round(
    (saturday.getTime() - seasonStart.getTime()) / (1000 * 60 * 60 * 24)
  );
  const weekInSeason = Math.floor(diffDays / 7) + 1;
  return {
    season,
    year,
    weekInSeason,
    display: `${season} ${year} · Week ${weekInSeason}`,
    short: `${season} W${weekInSeason}`,
  };
}

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

export function monthName(idx: number): string {
  return MONTHS[idx];
}

export function formatRange(start: Date, end: Date): string {
  const sameMonth =
    start.getMonth() === end.getMonth() && start.getFullYear() === end.getFullYear();
  const m1 = MONTHS[start.getMonth()].slice(0, 3);
  const m2 = MONTHS[end.getMonth()].slice(0, 3);
  if (sameMonth) {
    return `${m1} ${start.getDate()}\u2013${end.getDate()}, ${end.getFullYear()}`;
  }
  return `${m1} ${start.getDate()} \u2013 ${m2} ${end.getDate()}, ${end.getFullYear()}`;
}
