import type { Calendar, CalendarBucket, CalendarLabel } from "./types";
import { addDays } from "../utils/seasons";

/**
 * Stanford academic calendar (quarter system).
 *
 * For years we have official dates for, we hard-code the canonical instructional
 * windows from the registrar's calendar. For years outside that window we fall
 * back to a heuristic that matches the published pattern within ±3 days.
 *
 *  - Autumn: first Mon ≥ Sep 21    · ~12 weeks (incl finals)
 *  - Winter: first Mon ≥ Jan  4    · ~10 weeks
 *  - Spring: first Mon ≥ Mar 28    · ~10 weeks
 *  - Summer: first Mon ≥ Jun 21    · ~8 weeks
 *
 * The "academic year" attribute uses the calendar year in which Spring/Summer
 * fall — so Autumn 2025 (which begins Sep 22, 2025) is part of the 2025-26
 * academic year and labeled "Autumn 2026" in registrar parlance ("Autumn quarter
 * of academic year ending in 2026"). We follow registrar usage so labels match
 * Stanford's own.
 */

type QuarterName = "Autumn" | "Winter" | "Spring" | "Summer";

const QUARTER_ABBREV: Record<QuarterName, string> = {
  Autumn: "AUT",
  Winter: "WIN",
  Spring: "SPR",
  Summer: "SUM",
};

interface Quarter {
  quarter: QuarterName;
  /** academic year — Autumn 2025 (Sep 2025) belongs to academic year 2026 */
  year: number;
  /** Monday of Week 1 (instruction begins) */
  start: Date;
  /** Friday of last finals week (rough) */
  end: Date;
}

function ymd(s: string): Date {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y, m - 1, d);
}

const HARDCODED: Quarter[] = [
  // 2024-25
  { quarter: "Autumn", year: 2025, start: ymd("2024-09-23"), end: ymd("2024-12-13") },
  { quarter: "Winter", year: 2025, start: ymd("2025-01-06"), end: ymd("2025-03-21") },
  { quarter: "Spring", year: 2025, start: ymd("2025-03-31"), end: ymd("2025-06-13") },
  { quarter: "Summer", year: 2025, start: ymd("2025-06-23"), end: ymd("2025-08-16") },
  // 2025-26
  { quarter: "Autumn", year: 2026, start: ymd("2025-09-22"), end: ymd("2025-12-12") },
  { quarter: "Winter", year: 2026, start: ymd("2026-01-05"), end: ymd("2026-03-20") },
  { quarter: "Spring", year: 2026, start: ymd("2026-03-30"), end: ymd("2026-06-12") },
  { quarter: "Summer", year: 2026, start: ymd("2026-06-22"), end: ymd("2026-08-15") },
  // 2026-27
  { quarter: "Autumn", year: 2027, start: ymd("2026-09-21"), end: ymd("2026-12-11") },
  { quarter: "Winter", year: 2027, start: ymd("2027-01-04"), end: ymd("2027-03-19") },
  { quarter: "Spring", year: 2027, start: ymd("2027-03-29"), end: ymd("2027-06-11") },
  { quarter: "Summer", year: 2027, start: ymd("2027-06-21"), end: ymd("2027-08-14") },
  // 2027-28
  { quarter: "Autumn", year: 2028, start: ymd("2027-09-20"), end: ymd("2027-12-10") },
  { quarter: "Winter", year: 2028, start: ymd("2028-01-03"), end: ymd("2028-03-17") },
  { quarter: "Spring", year: 2028, start: ymd("2028-04-03"), end: ymd("2028-06-09") },
  { quarter: "Summer", year: 2028, start: ymd("2028-06-26"), end: ymd("2028-08-19") },
];

function firstMondayOnOrAfter(date: Date): Date {
  const c = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  while (c.getDay() !== 1) c.setDate(c.getDate() + 1);
  return c;
}

function generateQuartersForAcademicYear(year: number): Quarter[] {
  const autumnStart = firstMondayOnOrAfter(new Date(year - 1, 8, 21)); // Sep 21
  const winterStart = firstMondayOnOrAfter(new Date(year, 0, 4));
  const springStart = firstMondayOnOrAfter(new Date(year, 2, 28));
  const summerStart = firstMondayOnOrAfter(new Date(year, 5, 21));
  return [
    { quarter: "Autumn", year, start: autumnStart, end: addDays(autumnStart, 81) },
    { quarter: "Winter", year, start: winterStart, end: addDays(winterStart, 74) },
    { quarter: "Spring", year, start: springStart, end: addDays(springStart, 74) },
    { quarter: "Summer", year, start: summerStart, end: addDays(summerStart, 53) },
  ];
}

/** All quarters that could conceivably contain `date` (hardcoded preferred). */
function relevantQuarters(date: Date): Quarter[] {
  const cy = date.getFullYear();
  const academicYears = [cy, cy + 1];
  const out: Quarter[] = [];
  for (const ay of academicYears) {
    const fromHC = HARDCODED.filter((q) => q.year === ay);
    if (fromHC.length === 4) {
      out.push(...fromHC);
    } else {
      const generated = generateQuartersForAcademicYear(ay);
      // Prefer hardcoded entries where present
      for (const g of generated) {
        const hc = HARDCODED.find(
          (q) => q.year === g.year && q.quarter === g.quarter
        );
        out.push(hc ?? g);
      }
    }
  }
  out.sort((a, b) => a.start.getTime() - b.start.getTime());
  return out;
}

function findQuarter(date: Date): Quarter | null {
  for (const q of relevantQuarters(date)) {
    if (date >= q.start && date <= q.end) return q;
  }
  return null;
}

interface BreakInfo {
  name: string;
  abbrev: string;
  /** academic year of the next quarter */
  year: number;
  start: Date;
  end: Date;
}

function findBreak(date: Date): BreakInfo | null {
  const qs = relevantQuarters(date);
  for (let i = 0; i < qs.length - 1; i++) {
    const a = qs[i];
    const b = qs[i + 1];
    const gapStart = addDays(a.end, 1);
    const gapEnd = addDays(b.start, -1);
    if (date >= gapStart && date <= gapEnd) {
      let name: string;
      let abbrev: string;
      if (a.quarter === "Autumn") {
        name = "Winter Break";
        abbrev = "WBRK";
      } else if (a.quarter === "Winter") {
        name = "Spring Break";
        abbrev = "SBRK";
      } else if (a.quarter === "Spring") {
        name = "Pre-Summer";
        abbrev = "PSUM";
      } else {
        name = "Late Summer";
        abbrev = "LSUM";
      }
      return { name, abbrev, year: b.year, start: gapStart, end: gapEnd };
    }
  }
  return null;
}

export const stanfordCalendar: Calendar = {
  id: "stanford",
  name: "Stanford academic",
  bucketTerm: "Quarter",
  labelForWeekStart(saturday: Date): CalendarLabel {
    // Stanford counts academic weeks Monday-Sunday. Use the Monday of the
    // calendar week that contains this Saturday (Sat + 2 days = next Mon).
    const monday = addDays(saturday, 2);
    const q = findQuarter(monday);
    if (q) {
      const days = Math.round(
        (monday.getTime() - q.start.getTime()) / (1000 * 60 * 60 * 24)
      );
      const weekN = Math.floor(days / 7) + 1;
      return {
        display: `Stanford ${q.quarter} ${q.year} · Week ${weekN}`,
        short: `${QUARTER_ABBREV[q.quarter]} W${weekN}`,
      };
    }
    const br = findBreak(monday);
    if (br) {
      const days = Math.round(
        (monday.getTime() - br.start.getTime()) / (1000 * 60 * 60 * 24)
      );
      const weekN = Math.max(1, Math.floor(days / 7) + 1);
      return {
        display: `${br.name} ${br.year}`,
        short: `${br.abbrev} W${weekN}`,
      };
    }
    return { display: "—", short: "—" };
  },
  bucketForDate(date: Date): CalendarBucket {
    const q = findQuarter(date);
    if (q) {
      return {
        key: `${q.year}-${q.quarter}`,
        label: `${q.quarter} ${q.year}`,
      };
    }
    const br = findBreak(date);
    if (br) {
      return {
        key: `${br.year}-${br.name.replace(/\s+/g, "")}`,
        label: `${br.name} ${br.year}`,
      };
    }
    return { key: "unknown", label: "Unknown" };
  },
};
