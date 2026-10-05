import type { PlanGoal, Week } from "../types";

export function goalProgress(weeks: Week[], userId: string, goal: PlanGoal) {
  const names = (sources: string[]) => sources.map((s) => s.trim().toLowerCase()).filter(Boolean);
  const freeWill = new Set(names(goal.buckets?.freeWill.sources ?? []));
  const scheduled = new Set(names(goal.buckets?.scheduled.sources ?? []).filter((s) => !freeWill.has(s)));
  const legacy = new Set(names(goal.sources?.length ? goal.sources : [goal.tag]));
  let freeWillTotal = 0;
  let scheduledTotal = 0;
  let legacyTotal = 0;

  for (const week of weeks) {
    const table = week.tables.find((t) => t.userId === userId);
    if (!table) continue;
    for (const column of table.columns) {
      const name = column.name.trim().toLowerCase();
      if (goal.buckets && column.type !== "hours") continue;
      if (goal.buckets ? !freeWill.has(name) && !scheduled.has(name) : !legacy.has(name)) continue;
      const value = table.rows.reduce((sum, row) => sum + (row.values[column.id] || 0), 0);
      if (goal.buckets && freeWill.has(name)) freeWillTotal += value;
      else if (goal.buckets) scheduledTotal += value;
      else legacyTotal += value;
    }
  }

  const round = (n: number) => Math.round(n * 100) / 100;
  const freeTarget = goal.buckets?.freeWill.target ?? 0;
  const scheduledTarget = goal.buckets?.scheduled.target ?? 0;
  const target = goal.buckets ? freeTarget + scheduledTarget : goal.target;
  const total = goal.buckets ? freeWillTotal + scheduledTotal : legacyTotal;
  const credited = goal.buckets
    ? Math.min(freeWillTotal, freeTarget) + Math.min(scheduledTotal, scheduledTarget)
    : Math.min(legacyTotal, target);
  return {
    bucketed: Boolean(goal.buckets),
    total: round(total),
    target,
    pct: target > 0 ? Math.round((total / target) * 100) : 0,
    satisfaction: target > 0 ? Math.round((credited / target) * 100) : 0,
    freeWillTotal: round(freeWillTotal),
    scheduledTotal: round(scheduledTotal),
  };
}
