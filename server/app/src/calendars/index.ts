import type { Calendar } from "./types";
import { meteorologicalCalendar } from "./meteorological";
import { stanfordCalendar } from "./stanford";

export const CALENDARS: Calendar[] = [
  meteorologicalCalendar,
  stanfordCalendar,
];

export const DEFAULT_CALENDAR_ID = meteorologicalCalendar.id;

export function getCalendarById(id: string): Calendar {
  return CALENDARS.find((c) => c.id === id) ?? meteorologicalCalendar;
}

export type { Calendar, CalendarLabel, CalendarBucket } from "./types";
