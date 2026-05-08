export interface CalendarLabel {
  /** Long display, e.g. "Stanford Spring 2026 · Week 4" */
  display: string;
  /** Compact label, e.g. "SPR W4" */
  short: string;
}

export interface CalendarBucket {
  /** Stable key for grouping, e.g. "2026-Spring" */
  key: string;
  /** Human label, e.g. "Spring 2026" */
  label: string;
}

export interface Calendar {
  id: string;
  /** Display name in settings, e.g. "Meteorological seasons" / "Stanford academic" */
  name: string;
  /** What "the bucket" is called, e.g. "Season" or "Quarter" */
  bucketTerm: string;
  labelForWeekStart(saturday: Date): CalendarLabel;
  bucketForDate(date: Date): CalendarBucket;
}
