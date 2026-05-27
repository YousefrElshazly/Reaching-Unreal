import { useMemo, useState } from "react";
import type { AppData, AppUser, Plan, PlanGoal, Week } from "../types";
import {
  addGoalToPlan,
  deletePlan,
  getStore,
  newPlanId,
  removeGoal,
  updateGoal,
  updatePlan,
  upsertPlan,
} from "../store/yjs";
import { usePlans, useCalendar } from "../hooks/useStore";
import type { Calendar } from "../calendars";
import { formatRange, parseISO } from "../utils/seasons";
import { colorForResult, textColorFor } from "../utils/colors";

interface Props {
  data: AppData;
  me: AppUser | null;
  onClose: () => void;
  onJumpToWeek?: (weekId: string) => void;
}

/** Picks the slice of weeks in [startWeekId, endWeekId] inclusive, in
 * chronological order (the order they appear in data.weeks). */
function weekRange(weeks: Week[], startId: string, endId: string): Week[] {
  const startIdx = weeks.findIndex((w) => w.id === startId);
  const endIdx = weeks.findIndex((w) => w.id === endId);
  if (startIdx < 0 || endIdx < 0) return [];
  const lo = Math.min(startIdx, endIdx);
  const hi = Math.max(startIdx, endIdx);
  return weeks.slice(lo, hi + 1);
}

/** Sum the values in a user's columns whose name matches `tag`
 * (case-insensitively) across the supplied week slice. */
function computeGoalTotal(
  weeks: Week[],
  userId: string,
  tag: string
): number {
  const needle = tag.trim().toLowerCase();
  if (!needle) return 0;
  let total = 0;
  for (const w of weeks) {
    const t = w.tables.find((tt) => tt.userId === userId);
    if (!t) continue;
    const matchingCols = t.columns.filter(
      (c) => c.name.trim().toLowerCase() === needle
    );
    if (matchingCols.length === 0) continue;
    for (const row of t.rows) {
      for (const c of matchingCols) {
        total += row.values[c.id] || 0;
      }
    }
  }
  return Math.round(total * 100) / 100;
}

export function PlansView({ data, me, onClose, onJumpToWeek }: Props) {
  const plans = usePlans();
  const [openId, setOpenId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [filterUser, setFilterUser] = useState<string>("all");

  const filtered = plans.filter((p) =>
    filterUser === "all" ? true : p.userId === filterUser
  );

  return (
    <div className="fixed inset-0 z-40 bg-stone-900/40 backdrop-blur-sm flex items-start justify-center overflow-auto py-10 px-4">
      <div className="bg-white rounded-2xl shadow-xl border border-stone-200 max-w-5xl w-full overflow-hidden">
        <div className="flex items-center gap-3 px-6 py-4 border-b border-stone-200 flex-wrap">
          <h2 className="text-lg font-semibold text-stone-800">Plans</h2>
          {!openId && !creating && (
            <>
              <select
                value={filterUser}
                onChange={(e) => setFilterUser(e.target.value)}
                className="px-3 py-1.5 rounded-md border border-stone-200 text-sm bg-white"
              >
                <option value="all">All users</option>
                {data.users.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.name}
                  </option>
                ))}
              </select>
              <button
                onClick={() => setCreating(true)}
                className="px-3 py-1.5 rounded-md bg-stone-900 text-white hover:bg-stone-800 text-sm font-medium"
              >
                + New plan
              </button>
            </>
          )}
          {(openId || creating) && (
            <button
              onClick={() => {
                setOpenId(null);
                setCreating(false);
              }}
              className="px-3 py-1.5 rounded-md bg-stone-100 hover:bg-stone-200 text-sm"
            >
              ← Back
            </button>
          )}
          <button
            onClick={onClose}
            className="ml-auto px-3 py-1.5 rounded-md bg-stone-100 hover:bg-stone-200 text-sm"
          >
            Close
          </button>
        </div>

        <div className="p-6">
          {creating && (
            <PlanCreateForm
              data={data}
              defaultUserId={me?.id ?? data.users[0]?.id ?? ""}
              onCancel={() => setCreating(false)}
              onCreated={(id) => {
                setCreating(false);
                setOpenId(id);
              }}
            />
          )}
          {!creating && openId && (
            <PlanDetail
              plan={
                plans.find((p) => p.id === openId) ??
                ({} as Plan)
              }
              data={data}
              onJumpToWeek={onJumpToWeek}
              onDeleted={() => setOpenId(null)}
            />
          )}
          {!creating && !openId && (
            <PlanList
              plans={filtered}
              data={data}
              onOpen={(id) => setOpenId(id)}
            />
          )}
        </div>
      </div>
    </div>
  );
}

// ---------- List ----------

function PlanList({
  plans,
  data,
  onOpen,
}: {
  plans: Plan[];
  data: AppData;
  onOpen: (id: string) => void;
}) {
  const calendar = useCalendar();
  if (plans.length === 0) {
    return (
      <div className="text-center text-stone-500 py-16">
        <p className="text-sm">No plans yet.</p>
        <p className="text-xs mt-1">
          Click <strong>+ New plan</strong> to create one.
        </p>
      </div>
    );
  }
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      {plans.map((p) => {
        const user = data.users.find((u) => u.id === p.userId);
        const range = weekRange(data.weeks, p.startWeekId, p.endWeekId);
        const totals = p.goals.map((g) => ({
          g,
          total: computeGoalTotal(range, p.userId, g.tag),
        }));
        const avg = averageSatisfaction(totals);
        const start = range[0];
        const end = range[range.length - 1];
        return (
          <button
            key={p.id}
            onClick={() => onOpen(p.id)}
            className="text-left rounded-xl border border-stone-200 bg-white hover:bg-stone-50 p-4 transition-colors"
          >
            <div className="flex items-start gap-3">
              {user && (
                <span
                  className="w-2.5 h-2.5 mt-1.5 rounded-full flex-shrink-0"
                  style={{ backgroundColor: user.color }}
                />
              )}
              <div className="flex-1 min-w-0">
                <div className="font-semibold text-stone-800 truncate">
                  {p.name || "(untitled plan)"}
                </div>
                <div className="text-xs text-stone-500 mt-0.5">
                  {user?.name ?? "Unknown"} ·{" "}
                  {start && end ? (
                    <>
                      {calendar.labelForWeekStart(parseISO(start.startDate)).short}
                      {" → "}
                      {calendar.labelForWeekStart(parseISO(end.startDate)).short}
                      <span className="text-stone-400 ml-1">
                        ({range.length} wk)
                      </span>
                    </>
                  ) : (
                    "no range"
                  )}
                </div>
              </div>
              <div
                className="px-2 py-0.5 rounded font-bold text-xs"
                style={{
                  background: colorForResult(avg),
                  color: textColorFor(colorForResult(avg)),
                }}
              >
                {avg}%
              </div>
            </div>
            <div className="mt-3 flex flex-wrap gap-1.5">
              {p.goals.length === 0 && (
                <span className="text-xs text-stone-400">No goals yet</span>
              )}
              {totals.slice(0, 6).map(({ g, total }) => {
                const pct =
                  g.target > 0 ? Math.round((total / g.target) * 100) : 0;
                return (
                  <span
                    key={g.id}
                    className="text-[11px] px-1.5 py-0.5 rounded border border-stone-200 bg-white text-stone-700"
                  >
                    {g.tag}{" "}
                    <strong className="text-stone-900">
                      {total}/{g.target}
                    </strong>{" "}
                    <span className="text-stone-400">({pct}%)</span>
                  </span>
                );
              })}
              {totals.length > 6 && (
                <span className="text-[11px] text-stone-400">
                  +{totals.length - 6} more
                </span>
              )}
            </div>
          </button>
        );
      })}
    </div>
  );
}

// ---------- Create ----------

function PlanCreateForm({
  data,
  defaultUserId,
  onCancel,
  onCreated,
}: {
  data: AppData;
  defaultUserId: string;
  onCancel: () => void;
  onCreated: (id: string) => void;
}) {
  const calendar = useCalendar();
  const [name, setName] = useState("");
  const [userId, setUserId] = useState(defaultUserId);
  const [startWeekId, setStartWeekId] = useState(
    data.weeks[0]?.id ?? ""
  );
  const [endWeekId, setEndWeekId] = useState(
    data.weeks[data.weeks.length - 1]?.id ?? ""
  );

  const submit = () => {
    if (!name.trim() || !startWeekId || !endWeekId || !userId) return;
    const id = newPlanId();
    const plan: Plan = {
      id,
      name: name.trim(),
      userId,
      startWeekId,
      endWeekId,
      goals: [],
      createdAt: Date.now(),
    };
    upsertPlan(getStore(), plan);
    onCreated(id);
  };

  return (
    <div className="max-w-xl mx-auto space-y-4">
      <h3 className="font-semibold text-stone-800">New plan</h3>
      <label className="block">
        <span className="text-xs uppercase tracking-wider text-stone-500">
          Plan name
        </span>
        <input
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. Finish thesis core chapters"
          className="mt-1 w-full px-3 py-2 rounded-md border border-stone-300 text-sm"
        />
      </label>
      <label className="block">
        <span className="text-xs uppercase tracking-wider text-stone-500">
          Assigned to
        </span>
        <select
          value={userId}
          onChange={(e) => setUserId(e.target.value)}
          className="mt-1 w-full px-3 py-2 rounded-md border border-stone-300 text-sm bg-white"
        >
          {data.users.map((u) => (
            <option key={u.id} value={u.id}>
              {u.name}
            </option>
          ))}
        </select>
      </label>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <label className="block">
          <span className="text-xs uppercase tracking-wider text-stone-500">
            Start week
          </span>
          <WeekPicker
            value={startWeekId}
            onChange={setStartWeekId}
            weeks={data.weeks}
            calendar={calendar}
          />
        </label>
        <label className="block">
          <span className="text-xs uppercase tracking-wider text-stone-500">
            End week
          </span>
          <WeekPicker
            value={endWeekId}
            onChange={setEndWeekId}
            weeks={data.weeks}
            calendar={calendar}
          />
        </label>
      </div>
      <div className="flex gap-2 pt-2">
        <button
          onClick={submit}
          disabled={!name.trim() || !startWeekId || !endWeekId}
          className="px-4 py-2 rounded-md bg-emerald-600 hover:bg-emerald-700 text-white text-sm font-medium disabled:opacity-50"
        >
          Create plan
        </button>
        <button
          onClick={onCancel}
          className="px-4 py-2 rounded-md bg-stone-100 hover:bg-stone-200 text-sm"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

function WeekPicker({
  value,
  onChange,
  weeks,
  calendar,
}: {
  value: string;
  onChange: (id: string) => void;
  weeks: Week[];
  calendar: Calendar;
}) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="mt-1 w-full px-3 py-2 rounded-md border border-stone-300 text-sm bg-white"
    >
      {weeks.map((w) => {
        const lbl = calendar.labelForWeekStart(parseISO(w.startDate));
        return (
          <option key={w.id} value={w.id}>
            {lbl.short} · Wk {w.weekNumber} ·{" "}
            {formatRange(parseISO(w.startDate), parseISO(w.endDate))}
          </option>
        );
      })}
    </select>
  );
}

// ---------- Detail ----------

function PlanDetail({
  plan,
  data,
  onJumpToWeek,
  onDeleted,
}: {
  plan: Plan;
  data: AppData;
  onJumpToWeek?: (weekId: string) => void;
  onDeleted: () => void;
}) {
  const calendar = useCalendar();
  const user = data.users.find((u) => u.id === plan.userId);

  const [editing, setEditing] = useState(false);
  const [draftName, setDraftName] = useState(plan.name);
  const [draftUserId, setDraftUserId] = useState(plan.userId);
  const [draftStart, setDraftStart] = useState(plan.startWeekId);
  const [draftEnd, setDraftEnd] = useState(plan.endWeekId);

  const range = useMemo(
    () => weekRange(data.weeks, plan.startWeekId, plan.endWeekId),
    [data.weeks, plan.startWeekId, plan.endWeekId]
  );

  const goalRows = useMemo(
    () =>
      plan.goals.map((g) => {
        const total = computeGoalTotal(range, plan.userId, g.tag);
        const pct =
          g.target > 0 ? Math.round((total / g.target) * 100) : 0;
        return { g, total, pct };
      }),
    [plan.goals, range, plan.userId]
  );

  const avg = averageSatisfaction(goalRows.map((r) => ({ g: r.g, total: r.total })));

  const [newTag, setNewTag] = useState("");
  const [newTarget, setNewTarget] = useState<number>(10);

  const addGoal = () => {
    if (!newTag.trim() || !(newTarget > 0)) return;
    addGoalToPlan(getStore(), plan.id, {
      tag: newTag.trim(),
      target: newTarget,
    });
    setNewTag("");
    setNewTarget(10);
  };

  const saveEdit = () => {
    if (!draftName.trim() || !draftStart || !draftEnd || !draftUserId) return;
    updatePlan(getStore(), plan.id, {
      name: draftName.trim(),
      userId: draftUserId,
      startWeekId: draftStart,
      endWeekId: draftEnd,
    });
    setEditing(false);
  };

  const doDelete = () => {
    if (!window.confirm(`Delete plan "${plan.name}"? This cannot be undone.`))
      return;
    deletePlan(getStore(), plan.id);
    onDeleted();
  };

  if (!plan.id) return <div className="text-stone-500">Plan not found.</div>;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="rounded-xl border border-stone-200 bg-stone-50 p-4">
        {!editing ? (
          <div className="flex items-start gap-3 flex-wrap">
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                {user && (
                  <span
                    className="w-2.5 h-2.5 rounded-full flex-shrink-0"
                    style={{ backgroundColor: user.color }}
                  />
                )}
                <h3 className="text-lg font-semibold text-stone-800 truncate">
                  {plan.name}
                </h3>
              </div>
              <div className="text-xs text-stone-500 mt-1">
                Assigned to <strong>{user?.name ?? "?"}</strong> · {range.length}{" "}
                week{range.length === 1 ? "" : "s"} ·{" "}
                {range[0] && range[range.length - 1] && (
                  <>
                    {calendar.labelForWeekStart(parseISO(range[0].startDate)).short}
                    {" → "}
                    {
                      calendar.labelForWeekStart(
                        parseISO(range[range.length - 1].startDate)
                      ).short
                    }
                  </>
                )}
              </div>
            </div>
            <div className="flex items-center gap-2">
              <div
                className="px-3 py-1 rounded-md font-bold text-sm"
                style={{
                  background: colorForResult(avg),
                  color: textColorFor(colorForResult(avg)),
                }}
                title="Average goal satisfaction (each goal capped at 100%)"
              >
                {avg}% overall
              </div>
              <button
                onClick={() => setEditing(true)}
                className="px-3 py-1.5 rounded-md bg-white border border-stone-200 hover:bg-stone-100 text-sm"
              >
                Edit
              </button>
              <button
                onClick={doDelete}
                className="px-3 py-1.5 rounded-md bg-white border border-rose-200 text-rose-600 hover:bg-rose-50 text-sm"
              >
                Delete
              </button>
            </div>
          </div>
        ) : (
          <div className="space-y-3">
            <input
              value={draftName}
              onChange={(e) => setDraftName(e.target.value)}
              className="w-full px-3 py-2 rounded-md border border-stone-300 text-sm"
              placeholder="Plan name"
            />
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <select
                value={draftUserId}
                onChange={(e) => setDraftUserId(e.target.value)}
                className="px-3 py-2 rounded-md border border-stone-300 text-sm bg-white"
              >
                {data.users.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.name}
                  </option>
                ))}
              </select>
              <WeekPicker
                value={draftStart}
                onChange={setDraftStart}
                weeks={data.weeks}
                calendar={calendar}
              />
              <WeekPicker
                value={draftEnd}
                onChange={setDraftEnd}
                weeks={data.weeks}
                calendar={calendar}
              />
            </div>
            <div className="flex gap-2">
              <button
                onClick={saveEdit}
                className="px-4 py-2 rounded-md bg-emerald-600 hover:bg-emerald-700 text-white text-sm font-medium"
              >
                Save
              </button>
              <button
                onClick={() => {
                  setEditing(false);
                  setDraftName(plan.name);
                  setDraftUserId(plan.userId);
                  setDraftStart(plan.startWeekId);
                  setDraftEnd(plan.endWeekId);
                }}
                className="px-4 py-2 rounded-md bg-stone-100 hover:bg-stone-200 text-sm"
              >
                Cancel
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Goals */}
      <section>
        <h4 className="text-sm font-semibold text-stone-700 mb-2">Goals</h4>
        {goalRows.length === 0 && (
          <div className="text-sm text-stone-400 mb-3">
            No goals yet. Add a tag (must match a column name in{" "}
            {user?.name ?? "the user"}'s table, case-insensitive) and a target.
          </div>
        )}
        <div className="rounded-xl border border-stone-200 overflow-hidden">
          {goalRows.map(({ g, total, pct }) => (
            <GoalRow
              key={g.id}
              planId={plan.id}
              goal={g}
              total={total}
              pct={pct}
            />
          ))}
          <div className="flex flex-wrap items-center gap-2 p-3 bg-stone-50 border-t border-stone-200">
            <input
              value={newTag}
              onChange={(e) => setNewTag(e.target.value)}
              placeholder="Tag (e.g. Studying)"
              className="flex-1 min-w-[160px] px-3 py-1.5 rounded-md border border-stone-300 text-sm"
              onKeyDown={(e) => e.key === "Enter" && addGoal()}
            />
            <input
              type="number"
              value={newTarget}
              onChange={(e) => setNewTarget(parseFloat(e.target.value) || 0)}
              placeholder="Target"
              className="w-28 px-3 py-1.5 rounded-md border border-stone-300 text-sm"
              onKeyDown={(e) => e.key === "Enter" && addGoal()}
            />
            <button
              onClick={addGoal}
              disabled={!newTag.trim() || !(newTarget > 0)}
              className="px-3 py-1.5 rounded-md bg-stone-900 text-white text-sm font-medium disabled:opacity-50"
            >
              + Goal
            </button>
          </div>
        </div>
      </section>

      {/* Stacked weekly notes */}
      <section>
        <h4 className="text-sm font-semibold text-stone-700 mb-2">
          Weekly notes
          <span className="ml-2 text-xs font-normal text-stone-400">
            (synced from each week's table — hover to see the calendar label)
          </span>
        </h4>
        <div className="space-y-2">
          {range.length === 0 && (
            <div className="text-sm text-stone-400">No weeks in range.</div>
          )}
          {range.map((w, i) => {
            const note = (
              getStore().notes.get(`${w.id}:${plan.userId}`) ?? ""
            ).toString();
            const lbl = calendar.labelForWeekStart(parseISO(w.startDate));
            const display = `${lbl.display} · ${formatRange(
              parseISO(w.startDate),
              parseISO(w.endDate)
            )}`;
            return (
              <div
                key={w.id}
                className="rounded-lg border border-stone-200 bg-white overflow-hidden group"
                title={display}
              >
                <div className="flex items-center gap-2 px-3 py-1.5 bg-stone-50 border-b border-stone-200">
                  <span className="text-xs font-semibold text-stone-600">
                    Week {i + 1}
                  </span>
                  <span className="text-[11px] text-stone-400 truncate group-hover:text-stone-600 transition-colors">
                    {display}
                  </span>
                  {onJumpToWeek && (
                    <button
                      onClick={() => onJumpToWeek(w.id)}
                      className="ml-auto text-[11px] underline text-stone-500 hover:text-stone-800"
                    >
                      open
                    </button>
                  )}
                </div>
                <div
                  className="px-3 py-2 text-sm leading-6 whitespace-pre-wrap text-stone-800"
                  style={{
                    fontFamily: "ui-serif, Georgia, serif",
                    minHeight: 32,
                  }}
                >
                  {note.trim() ? (
                    note
                  ) : (
                    <span className="text-stone-300 italic">(empty)</span>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </section>
    </div>
  );
}

function GoalRow({
  planId,
  goal,
  total,
  pct,
}: {
  planId: string;
  goal: PlanGoal;
  total: number;
  pct: number;
}) {
  const [editing, setEditing] = useState(false);
  const [draftTag, setDraftTag] = useState(goal.tag);
  const [draftTarget, setDraftTarget] = useState(goal.target);

  const save = () => {
    updateGoal(getStore(), planId, goal.id, {
      tag: draftTag.trim(),
      target: draftTarget,
    });
    setEditing(false);
  };

  const cappedPct = Math.min(100, pct);
  const overshoot = pct > 100;
  const barColor = colorForResult(cappedPct);

  return (
    <div className="px-3 py-2.5 border-b border-stone-200 last:border-b-0">
      <div className="flex items-center gap-3">
        {!editing ? (
          <>
            <div className="flex-1 min-w-0">
              <div className="font-medium text-stone-800 truncate">
                {goal.tag}
              </div>
              <div className="text-xs text-stone-500">
                <span className="font-semibold text-stone-700">{total}</span> /{" "}
                {goal.target}
                {overshoot && (
                  <span className="ml-2 text-emerald-700 font-semibold">
                    over by {Math.round(pct - 100)}%
                  </span>
                )}
              </div>
            </div>
            <div className="w-40 sm:w-56 flex-shrink-0">
              <div className="h-2 rounded-full bg-stone-100 overflow-hidden">
                <div
                  className="h-full transition-all"
                  style={{
                    width: `${cappedPct}%`,
                    background: barColor,
                  }}
                />
              </div>
              <div className="text-[11px] text-right text-stone-500 mt-0.5">
                {pct}%
              </div>
            </div>
            <button
              onClick={() => setEditing(true)}
              className="text-xs text-stone-500 hover:text-stone-800 underline"
            >
              edit
            </button>
            <button
              onClick={() => {
                if (!window.confirm(`Remove goal "${goal.tag}"?`)) return;
                removeGoal(getStore(), planId, goal.id);
              }}
              className="text-xs text-rose-500 hover:text-rose-700"
              title="Remove goal"
            >
              ×
            </button>
          </>
        ) : (
          <>
            <input
              value={draftTag}
              onChange={(e) => setDraftTag(e.target.value)}
              className="flex-1 px-2 py-1 rounded border border-stone-300 text-sm"
            />
            <input
              type="number"
              value={draftTarget}
              onChange={(e) => setDraftTarget(parseFloat(e.target.value) || 0)}
              className="w-24 px-2 py-1 rounded border border-stone-300 text-sm"
            />
            <button
              onClick={save}
              className="px-2.5 py-1 rounded bg-emerald-600 text-white text-xs font-medium"
            >
              save
            </button>
            <button
              onClick={() => {
                setEditing(false);
                setDraftTag(goal.tag);
                setDraftTarget(goal.target);
              }}
              className="px-2.5 py-1 rounded bg-stone-100 text-xs"
            >
              cancel
            </button>
          </>
        )}
      </div>
    </div>
  );
}

function averageSatisfaction(
  rows: Array<{ g: PlanGoal; total: number }>
): number {
  if (rows.length === 0) return 0;
  let sum = 0;
  for (const { g, total } of rows) {
    if (!(g.target > 0)) continue;
    sum += Math.min(1, total / g.target);
  }
  return Math.round((sum / rows.length) * 100);
}
