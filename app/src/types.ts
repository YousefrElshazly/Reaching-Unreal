export type DayName =
  | "Saturday"
  | "Sunday"
  | "Monday"
  | "Tuesday"
  | "Wednesday"
  | "Thursday"
  | "Friday";

export const DAYS: DayName[] = [
  "Saturday",
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
];

export type ColumnType = "hours" | "boolean";

export interface ColumnDef {
  id: string;
  name: string;
  type: ColumnType;
  /** weight in percentage points; daily score = sum(value * weight) */
  weight: number;
}

export interface DayRow {
  day: DayName;
  values: Record<string, number>; // columnId -> value
}

export interface UserTable {
  userId: string;
  userName: string;
  columns: ColumnDef[];
  rows: DayRow[]; // exactly 7 rows in DAYS order
}

export interface Week {
  id: string;
  weekNumber: number; // overall index (1, 2, ...)
  startDate: string; // YYYY-MM-DD (Saturday)
  endDate: string; // YYYY-MM-DD (Friday)
  tables: UserTable[];
}

export interface AppUser {
  id: string;
  name: string;
  color: string;
}

export interface AppData {
  users: AppUser[];
  weeks: Week[];
}

export interface PresenceState {
  userId: string;
  name: string;
  color: string;
  cursor: { x: number; y: number } | null;
}

/** A single tag-target goal inside a Plan. */
export interface PlanGoal {
  id: string;
  /** Display label for the goal (e.g. "Sports", "Creative"). May be a meta
   * tag that aggregates several real columns via `sources`, or — when
   * `sources` is empty — used directly as a case-insensitive column-name
   * matcher for backward compatibility. */
  tag: string;
  /** Numeric target (hours for hour-columns, days/count for boolean columns). */
  target: number;
  /** Column names (case-insensitive) whose values feed this goal. Lets one
   * goal aggregate multiple logged tags, e.g. "Sports" = ["Gym", "Squash"].
   * When undefined or empty, the goal falls back to matching by `tag`. */
  sources?: string[];
}

/** A user-assigned plan spanning a contiguous range of weeks.
 *
 * Ranges are anchored to ISO Saturday dates (YYYY-MM-DD) rather than week
 * ids. That lets plans cover future weeks that haven't been auto-created
 * yet — once those weeks roll around and are materialized, they slot
 * naturally into the plan's range without any migration needed.
 */
export interface Plan {
  id: string;
  name: string;
  /** Which user this plan belongs to. Matches AppUser.id. */
  userId: string;
  /** ISO date (YYYY-MM-DD) of the first week's Saturday, inclusive. */
  startDate: string;
  /** ISO date (YYYY-MM-DD) of the last week's Saturday, inclusive. */
  endDate: string;
  /** @deprecated Legacy: pre-dates-anchored plans referenced weeks by id.
   * Reads migrate them transparently via resolveLegacyPlan(). */
  startWeekId?: string;
  /** @deprecated see startWeekId. */
  endWeekId?: string;
  goals: PlanGoal[];
  /** Free-form description / notes about the plan as a whole. */
  notes?: string;
  /** Unix ms of creation; used for stable sort. */
  createdAt: number;
}

/** A note attached to one (week, user) pair. */
export interface WeekNote {
  weekId: string;
  userId: string;
  text: string;
}
