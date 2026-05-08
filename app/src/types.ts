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
