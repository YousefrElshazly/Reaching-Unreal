import type { ColumnDef, DayRow, UserTable } from "../types";

export function dayScore(row: DayRow, columns: ColumnDef[]): number {
  let s = 0;
  for (const c of columns) {
    const v = row.values[c.id] ?? 0;
    s += v * c.weight;
  }
  return s;
}

export function columnTotal(table: UserTable, columnId: string): number {
  let s = 0;
  for (const r of table.rows) s += r.values[columnId] ?? 0;
  return s;
}

export function weekScore(table: UserTable): number {
  let s = 0;
  for (const r of table.rows) s += dayScore(r, table.columns);
  return Math.round(s / 7);
}
