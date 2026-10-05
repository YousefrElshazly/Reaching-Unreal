import { useEffect, useMemo, useRef, useState } from "react";
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
import { goalProgress } from "../utils/planGoalTotals";

interface Props {
  data: AppData;
  me: AppUser | null;
  onJumpToWeek?: (weekId: string) => void;
}

/** Pick the slice of weeks whose Saturday start falls in
 * [startDate, endDate] inclusive. Auto-orders the dates so picking
 * "end before start" still yields a non-empty range. Returns only weeks
 * that have already been materialized — future weeks not yet created
 * are simply absent until auto-week-generation catches up. */
function weekRange(weeks: Week[], startDate: string, endDate: string): Week[] {
  if (!startDate || !endDate) return [];
  const lo = startDate < endDate ? startDate : endDate;
  const hi = startDate < endDate ? endDate : startDate;
  return weeks
    .filter((w) => w.startDate >= lo && w.startDate <= hi)
    .slice()
    .sort((a, b) => a.startDate.localeCompare(b.startDate));
}

/** Total number of Saturday-anchored weeks in the inclusive date range,
 * regardless of whether each one has been materialized as a Week yet. */
function totalWeeksInRange(startDate: string, endDate: string): number {
  if (!startDate || !endDate) return 0;
  const a = parseISO(startDate < endDate ? startDate : endDate);
  const b = parseISO(startDate < endDate ? endDate : startDate);
  const days = Math.round((b.getTime() - a.getTime()) / 86400000);
  return Math.floor(days / 7) + 1;
}

function fmtIso(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate()
  ).padStart(2, "0")}`;
}

/** Snap an arbitrary date to the Saturday on or before it (our weeks are
 * Saturday-anchored). Returns YYYY-MM-DD. */
function snapToSaturday(iso: string): string {
  if (!iso) return "";
  const d = parseISO(iso);
  d.setHours(0, 0, 0, 0);
  // JS getDay: Sun=0..Sat=6. Distance back to Saturday:
  const offset = (d.getDay() - 6 + 7) % 7;
  d.setDate(d.getDate() - offset);
  return fmtIso(d);
}

/** Resolve which column names a goal pulls from. If the goal has explicit
 * `sources`, those are it; otherwise we fall back to the goal's tag itself
 * so legacy goals (tag = column name) keep working. */
function effectiveSources(goal: PlanGoal): string[] {
  if (goal.sources && goal.sources.length > 0) return goal.sources;
  if (goal.tag.trim()) return [goal.tag];
  return [];
}

/** Every distinct column name that's ever appeared in the given user's
 * tables, sorted by recent usage (last-seen week first) so the most
 * relevant chips bubble to the top. */
function availableSourcesForUser(weeks: Week[], userId: string, hoursOnly = false): string[] {
  const lastSeen = new Map<string, number>();
  weeks.forEach((w, idx) => {
    const t = w.tables.find((tt) => tt.userId === userId);
    if (!t) return;
    for (const c of t.columns) {
      if (hoursOnly && c.type !== "hours") continue;
      const name = c.name.trim();
      if (!name) continue;
      lastSeen.set(name, idx);
    }
  });
  return Array.from(lastSeen.entries())
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([name]) => name);
}

export function PlansView({ data, me, onJumpToWeek }: Props) {
  const plans = usePlans();
  const [openId, setOpenId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [filterUser, setFilterUser] = useState<string>("all");
  const [showArchived, setShowArchived] = useState(false);

  useEffect(() => {
    setOpenId(null);
    setCreating(false);
  }, [me?.id]);

  const visible = plans.filter((p) => !p.private || p.userId === me?.id);
  const openPlan = visible.find((p) => p.id === openId);
  const filtered = visible.filter((p) =>
    Boolean(p.archived) === showArchived &&
    (filterUser === "all" || p.userId === filterUser)
  );

  return (
    <div className="bg-white rounded-2xl shadow-sm border border-stone-200 max-w-5xl mx-auto overflow-hidden">
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
                onClick={() => setShowArchived((value) => !value)}
                className="px-3 py-1.5 rounded-md border border-stone-200 text-sm"
                aria-pressed={showArchived}
              >
                {showArchived ? "← Active plans" : "View archive"}
              </button>
              <button
                onClick={() => {
                  setShowArchived(false);
                  setCreating(true);
                }}
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
        </div>

        <div className="p-6">
          {creating && (
            <PlanCreateForm
              data={data}
              defaultUserId={me?.id ?? data.users[0]?.id ?? ""}
              me={me}
              onCancel={() => setCreating(false)}
              onCreated={(id) => {
                setCreating(false);
                setOpenId(id);
              }}
            />
          )}
          {!creating && openId && openPlan && (
            <PlanDetail
              plan={openPlan}
              data={data}
              me={me}
              onJumpToWeek={onJumpToWeek}
              onDeleted={() => setOpenId(null)}
            />
          )}
          {!creating && (!openId || !openPlan) && (
            <PlanList
              plans={filtered}
              archived={showArchived}
              data={data}
              onOpen={(id) => setOpenId(id)}
            />
          )}
        </div>
    </div>
  );
}

// ---------- List ----------

function PlanList({
  plans,
  archived,
  data,
  onOpen,
}: {
  plans: Plan[];
  archived: boolean;
  data: AppData;
  onOpen: (id: string) => void;
}) {
  const calendar = useCalendar();
  if (plans.length === 0) {
    return (
      <div className="text-center text-stone-500 py-16">
        <p className="text-sm">{archived ? "No archived plans." : "No plans yet."}</p>
        {!archived && <p className="text-xs mt-1">Click <strong>+ New plan</strong> to create one.</p>}
      </div>
    );
  }
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      {plans.map((p) => {
        const user = data.users.find((u) => u.id === p.userId);
        const range = weekRange(data.weeks, p.startDate, p.endDate);
        const totalWks = totalWeeksInRange(p.startDate, p.endDate);
        const totals = p.goals.map((g) => ({ g, progress: goalProgress(range, p.userId, g) }));
        const avg = averageSatisfaction(totals);
        const dateRange =
          p.startDate && p.endDate
            ? formatRange(
                parseISO(p.startDate),
                addDays(parseISO(p.endDate), 6)
              )
            : "no range";
        const calendarHint =
          p.startDate && p.endDate
            ? `${calendar.labelForWeekStart(parseISO(p.startDate)).display} → ${
                calendar.labelForWeekStart(parseISO(p.endDate)).display
              }`
            : undefined;
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
                  {p.name || "(untitled plan)"} {p.private && <span className="text-xs font-normal text-stone-500">· Private</span>}
                </div>
                <div
                  className="text-xs text-stone-500 mt-0.5"
                  title={calendarHint}
                >
                  {user?.name ?? "Unknown"} · {dateRange}
                  <span className="text-stone-400 ml-1">
                    ({totalWks} wk
                    {totalWks === 1 ? "" : "s"}
                    {range.length < totalWks
                      ? `, ${range.length} logged`
                      : ""}
                    )
                  </span>
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
              {totals.slice(0, 6).map(({ g, progress }) => {
                return (
                  <span
                    key={g.id}
                    className="text-[11px] px-1.5 py-0.5 rounded border border-stone-200 bg-white text-stone-700"
                  >
                    {g.tag}{" "}
                    <strong className="text-stone-900">
                      {progress.bucketed
                        ? `Free will ${progress.freeWillTotal}/${g.buckets!.freeWill.target} · Scheduled ${progress.scheduledTotal}/${g.buckets!.scheduled.target}`
                        : `${progress.total}/${progress.target}`}
                    </strong>{" "}
                    <span className="text-stone-400">({progress.satisfaction}%)</span>
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
  me,
  onCancel,
  onCreated,
}: {
  data: AppData;
  defaultUserId: string;
  me: AppUser | null;
  onCancel: () => void;
  onCreated: (id: string) => void;
}) {
  const calendar = useCalendar();
  const [name, setName] = useState("");
  const [userId, setUserId] = useState(defaultUserId);
  const [isPrivate, setIsPrivate] = useState(false);
  // Default: this week's Saturday → 4 weeks out, so a "new plan" reads as
  // "plan for the next month" out of the box.
  const todaySaturday = snapToSaturday(fmtIso(new Date()));
  const fourWeeksOut = (() => {
    const d = parseISO(todaySaturday);
    d.setDate(d.getDate() + 7 * 4);
    return fmtIso(d);
  })();
  const [startDate, setStartDate] = useState(todaySaturday);
  const [endDate, setEndDate] = useState(fourWeeksOut);

  const submit = () => {
    if (!name.trim() || !startDate || !endDate || !userId || (isPrivate && userId !== me?.id)) return;
    const id = newPlanId();
    const plan: Plan = {
      id,
      name: name.trim(),
      userId,
      private: isPrivate,
      startDate,
      endDate,
      goals: [],
      createdAt: Date.now(),
    };
    upsertPlan(getStore(), plan);
    onCreated(id);
  };

  const totalWks = totalWeeksInRange(startDate, endDate);

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
      <label className="flex items-start gap-2 text-sm text-stone-700">
        <input type="checkbox" checked={isPrivate} onChange={(e) => setIsPrivate(e.target.checked)} disabled={!me || userId !== me.id} className="mt-1" />
        <span>Private <span className="block text-xs text-stone-500">Stored only in this browser, not synced. Anyone using this browser can switch identities.</span></span>
      </label>
      <label className="block">
        <span className="text-xs uppercase tracking-wider text-stone-500">
          Assigned to
        </span>
        <select
          value={userId}
          onChange={(e) => {
            setUserId(e.target.value);
            if (e.target.value !== me?.id) setIsPrivate(false);
          }}
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
            Start date
          </span>
          <SaturdayPicker
            value={startDate}
            onChange={setStartDate}
            weeks={data.weeks}
            calendar={calendar}
          />
        </label>
        <label className="block">
          <span className="text-xs uppercase tracking-wider text-stone-500">
            End date
          </span>
          <SaturdayPicker
            value={endDate}
            onChange={setEndDate}
            weeks={data.weeks}
            calendar={calendar}
          />
        </label>
      </div>
      {totalWks > 0 && (
        <div className="text-xs text-stone-500">
          Spans <strong>{totalWks}</strong> week{totalWks === 1 ? "" : "s"}.
          Weeks that haven't happened yet will be picked up automatically as
          they're created.
        </div>
      )}
      <div className="flex gap-2 pt-2">
        <button
          onClick={submit}
          disabled={!name.trim() || !startDate || !endDate}
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

/** Date-of-Saturday picker. The user can choose any date in the past or
 * future; we snap to the Saturday on or before it and surface which
 * calendar week that resolves to so they know what they picked. */
function SaturdayPicker({
  value,
  onChange,
  weeks,
  calendar,
}: {
  /** ISO Saturday date the picker is currently anchored to. */
  value: string;
  onChange: (iso: string) => void;
  weeks: Week[];
  calendar: Calendar;
}) {
  const matchedWeek = weeks.find((w) => w.startDate === value);
  const date = value ? parseISO(value) : null;
  const lbl = date ? calendar.labelForWeekStart(date) : null;
  return (
    <div className="mt-1 space-y-1">
      <input
        type="date"
        value={value}
        onChange={(e) => onChange(snapToSaturday(e.target.value))}
        className="w-full px-3 py-2 rounded-md border border-stone-300 text-sm bg-white"
      />
      {date && lbl && (
        <div className="text-[11px] text-stone-500 leading-tight">
          <span className="font-medium text-stone-700">{lbl.short}</span>{" "}
          <span className="text-stone-400">·</span>{" "}
          {formatRange(date, addDays(date, 6))}
          {matchedWeek ? (
            <span className="ml-1 text-stone-400">
              · Wk {matchedWeek.weekNumber}
            </span>
          ) : (
            <span className="ml-1 text-amber-600">· future (not created yet)</span>
          )}
        </div>
      )}
    </div>
  );
}

function addDays(d: Date, n: number): Date {
  const out = new Date(d);
  out.setDate(out.getDate() + n);
  return out;
}

/**
 * Chip picker for selecting which logged columns ("tags") feed a goal.
 * Shows every distinct column name the assigned user has used, sorted by
 * recency. The picker is purely additive — a goal with no sources falls
 * back to matching its own tag name (handy for one-to-one goals).
 *
 * Also supports adding custom names that aren't in the user's tables yet
 * (e.g. a column that hasn't been created but is planned), via the "+ add"
 * field on the right.
 */
function SourcesPicker({
  available,
  selected,
  onChange,
  fallbackTag,
  label = "Feeds from",
}: {
  available: string[];
  selected: string[];
  onChange: (next: string[]) => void;
  /** When selected is empty, we say "will match column named …" — preview. */
  fallbackTag?: string;
  label?: string;
}) {
  const [customInput, setCustomInput] = useState("");
  const isSelected = (name: string) =>
    selected.some((s) => s.toLowerCase() === name.toLowerCase());
  const toggle = (name: string) => {
    if (isSelected(name)) {
      onChange(selected.filter((s) => s.toLowerCase() !== name.toLowerCase()));
    } else {
      onChange([...selected, name]);
    }
  };
  const addCustom = () => {
    const v = customInput.trim();
    if (!v) return;
    if (!isSelected(v)) onChange([...selected, v]);
    setCustomInput("");
  };
  // Show available chips merged with selected ones that aren't in available
  // (custom-typed) so the user can always see + remove them.
  const extras = selected.filter(
    (s) => !available.some((a) => a.toLowerCase() === s.toLowerCase())
  );
  const allChips = [...available, ...extras];

  return (
    <div className="text-xs">
      <div className="flex items-center gap-2 mb-1.5">
        <span className="uppercase tracking-wider text-stone-500">
          {label}
        </span>
        {selected.length === 0 ? (
          <span className="text-stone-400">
            none —
            {fallbackTag?.trim() ? (
              <> auto-matches column <strong>{fallbackTag.trim()}</strong></>
            ) : (
              <> pick at least one</>
            )}
          </span>
        ) : (
          <span className="text-stone-400">
            {selected.length} source{selected.length === 1 ? "" : "s"}
          </span>
        )}
        {selected.length > 0 && (
          <button
            onClick={() => onChange([])}
            className="ml-auto text-stone-500 hover:text-stone-800 underline"
          >
            clear
          </button>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        {allChips.length === 0 && (
          <span className="text-stone-400 italic">
            No columns logged yet for this user — type one below.
          </span>
        )}
        {allChips.map((name) => {
          const on = isSelected(name);
          return (
            <button
              key={name}
              type="button"
              onClick={() => toggle(name)}
              className={
                "px-2 py-0.5 rounded-full border text-[11px] transition-colors " +
                (on
                  ? "bg-stone-900 border-stone-900 text-white"
                  : "bg-white border-stone-200 text-stone-700 hover:bg-stone-100")
              }
            >
              {name}
            </button>
          );
        })}
        <span className="ml-1 inline-flex items-center gap-1">
          <input
            value={customInput}
            onChange={(e) => setCustomInput(e.target.value)}
            placeholder="+ add"
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                addCustom();
              }
            }}
            className="w-20 px-2 py-0.5 rounded-full border border-dashed border-stone-300 text-[11px] bg-white focus:w-32 transition-[width]"
          />
        </span>
      </div>
    </div>
  );
}

function BucketEditor({
  label, target, onTargetChange, sources, onSourcesChange, available,
}: {
  label: string;
  target: number;
  onTargetChange: (value: number) => void;
  sources: string[];
  onSourcesChange: (value: string[]) => void;
  available: string[];
}) {
  return (
    <div className="rounded-lg border border-stone-200 bg-white p-3 space-y-3">
      <label className="flex items-center justify-between gap-3 text-sm font-medium text-stone-700">
        {label} target (hours)
        <input
          type="number"
          min="0"
          step="0.5"
          value={target}
          onChange={(e) => onTargetChange(Math.max(0, Number(e.target.value) || 0))}
          className="w-24 px-2 py-1 rounded border border-stone-300 text-sm"
        />
      </label>
      <details className="text-xs text-stone-600">
        <summary className="cursor-pointer select-none">{sources.length ? `${sources.length} linked: ${sources.join(", ")}` : "Link week-log tags"}</summary>
        <div className="mt-3">
          <SourcesPicker available={available} selected={sources} onChange={onSourcesChange} label={`${label} tags`} />
        </div>
      </details>
    </div>
  );
}

// ---------- Detail ----------

function PlanDetail({
  plan,
  data,
  me,
  onJumpToWeek,
  onDeleted,
}: {
  plan: Plan;
  data: AppData;
  me: AppUser | null;
  onJumpToWeek?: (weekId: string) => void;
  onDeleted: () => void;
}) {
  const calendar = useCalendar();
  const user = data.users.find((u) => u.id === plan.userId);

  const [editing, setEditing] = useState(false);
  const [draftName, setDraftName] = useState(plan.name);
  const [draftUserId, setDraftUserId] = useState(plan.userId);
  const [draftStart, setDraftStart] = useState(plan.startDate);
  const [draftEnd, setDraftEnd] = useState(plan.endDate);
  const [draftPrivate, setDraftPrivate] = useState(Boolean(plan.private));

  const range = useMemo(
    () => weekRange(data.weeks, plan.startDate, plan.endDate),
    [data.weeks, plan.startDate, plan.endDate]
  );
  const totalWks = totalWeeksInRange(plan.startDate, plan.endDate);

  const goalRows = useMemo(
    () =>
      plan.goals.map((g) => ({ g, progress: goalProgress(range, plan.userId, g) })),
    [plan.goals, range, plan.userId]
  );

  const avg = averageSatisfaction(goalRows);

  const [newTag, setNewTag] = useState("");
  const [newFreeWillTarget, setNewFreeWillTarget] = useState(0);
  const [newScheduledTarget, setNewScheduledTarget] = useState(0);
  const [newFreeWillSources, setNewFreeWillSources] = useState<string[]>([]);
  const [newScheduledSources, setNewScheduledSources] = useState<string[]>([]);
  const [newDetails, setNewDetails] = useState("");

  const availableSources = useMemo(
    () => availableSourcesForUser(data.weeks, plan.userId),
    [data.weeks, plan.userId]
  );
  const availableHourSources = useMemo(
    () => availableSourcesForUser(data.weeks, plan.userId, true),
    [data.weeks, plan.userId]
  );

  const addGoal = () => {
    if (!newTag.trim() || !(newFreeWillTarget > 0 || newScheduledTarget > 0)) return;
    addGoalToPlan(getStore(), plan.id, {
      tag: newTag.trim(),
      target: newFreeWillTarget + newScheduledTarget,
      details: newDetails,
      sources: [...newFreeWillSources, ...newScheduledSources],
      buckets: {
        freeWill: { target: newFreeWillTarget, sources: newFreeWillSources },
        scheduled: { target: newScheduledTarget, sources: newScheduledSources },
      },
    });
    setNewTag("");
    setNewFreeWillTarget(0);
    setNewScheduledTarget(0);
    setNewDetails("");
    setNewFreeWillSources([]);
    setNewScheduledSources([]);
  };

  const saveEdit = () => {
    if (!draftName.trim() || !draftStart || !draftEnd || !draftUserId || (draftPrivate && draftUserId !== me?.id)) return;
    updatePlan(getStore(), plan.id, {
      name: draftName.trim(),
      userId: draftUserId,
      startDate: draftStart,
      endDate: draftEnd,
      private: draftPrivate,
      // Clear legacy weekId pointers once we've upgraded to date-anchored.
      startWeekId: undefined,
      endWeekId: undefined,
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
                Assigned to <strong>{user?.name ?? "?"}</strong> · {totalWks}{" "}
                week{totalWks === 1 ? "" : "s"} (
                {range.length} logged) ·{" "}
                {plan.startDate && plan.endDate && (
                  <span
                    title={`${
                      calendar.labelForWeekStart(parseISO(plan.startDate)).display
                    } → ${calendar.labelForWeekStart(parseISO(plan.endDate)).display}`}
                  >
                    {formatRange(
                      parseISO(plan.startDate),
                      addDays(parseISO(plan.endDate), 6)
                    )}
                  </span>
                )}
              </div>
              {plan.private && <div className="text-xs text-stone-500 mt-1">Private · saved in this browser only</div>}
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
                onClick={() => updatePlan(getStore(), plan.id, { archived: !plan.archived })}
                className="px-3 py-1.5 rounded-md bg-white border border-stone-200 hover:bg-stone-100 text-sm"
              >
                {plan.archived ? "Restore" : "Archive"}
              </button>
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
                onChange={(e) => {
                  setDraftUserId(e.target.value);
                  if (e.target.value !== me?.id) setDraftPrivate(false);
                }}
                className="px-3 py-2 rounded-md border border-stone-300 text-sm bg-white"
              >
                {data.users.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.name}
                  </option>
                ))}
              </select>
              <SaturdayPicker
                value={draftStart}
                onChange={setDraftStart}
                weeks={data.weeks}
                calendar={calendar}
              />
              <SaturdayPicker
                value={draftEnd}
                onChange={setDraftEnd}
                weeks={data.weeks}
                calendar={calendar}
              />
            </div>
            <label className="flex items-start gap-2 text-sm text-stone-700">
              <input type="checkbox" checked={draftPrivate} onChange={(e) => setDraftPrivate(e.target.checked)} disabled={!me || draftUserId !== me.id} className="mt-1" />
              <span>Private <span className="block text-xs text-stone-500">Stored only in this browser, not synced. Anyone using this browser can switch identities.</span></span>
            </label>
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
                  setDraftStart(plan.startDate);
                  setDraftEnd(plan.endDate);
                  setDraftPrivate(Boolean(plan.private));
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
            No goals yet. Name a goal, set Free will and Scheduled hour targets,
            then link the matching week-log tags to each bucket.
          </div>
        )}
        <div className="rounded-xl border border-stone-200 overflow-hidden">
          {goalRows.map(({ g, progress }) => (
            <GoalRow
              key={g.id}
              planId={plan.id}
              goal={g}
              progress={progress}
              availableSources={availableSources}
              availableHourSources={availableHourSources}
            />
          ))}
          <div className="p-3 bg-stone-50 border-t border-stone-200 space-y-2.5">
            <div className="flex flex-wrap items-center gap-2">
              <input
                value={newTag}
                onChange={(e) => setNewTag(e.target.value)}
                placeholder="Goal name (e.g. Sports)"
                className="flex-1 min-w-[160px] px-3 py-1.5 rounded-md border border-stone-300 text-sm"
              />
            </div>
            <GoalDetailsEditor value={newDetails} onChange={setNewDetails} />
            <div className="grid gap-2 sm:grid-cols-2">
              <BucketEditor label="Free will" target={newFreeWillTarget} onTargetChange={setNewFreeWillTarget} sources={newFreeWillSources} onSourcesChange={(next) => {
                setNewFreeWillSources(next);
                setNewScheduledSources((current) => current.filter((s) => !next.some((n) => n.toLowerCase() === s.toLowerCase())));
              }} available={availableHourSources} />
              <BucketEditor label="Scheduled" target={newScheduledTarget} onTargetChange={setNewScheduledTarget} sources={newScheduledSources} onSourcesChange={(next) => {
                setNewScheduledSources(next);
                setNewFreeWillSources((current) => current.filter((s) => !next.some((n) => n.toLowerCase() === s.toLowerCase())));
              }} available={availableHourSources} />
            </div>
            <p className="text-xs text-stone-500">Only week-log tags set to Hours count toward these buckets.</p>
            <button onClick={addGoal} disabled={!newTag.trim() || !(newFreeWillTarget > 0 || newScheduledTarget > 0)} className="px-3 py-1.5 rounded-md bg-stone-900 text-white text-sm font-medium disabled:opacity-50">+ Goal</button>
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
  progress,
  availableSources,
  availableHourSources,
}: {
  planId: string;
  goal: PlanGoal;
  progress: ReturnType<typeof goalProgress>;
  availableSources: string[];
  availableHourSources: string[];
}) {
  const [editing, setEditing] = useState(false);
  const [draftTag, setDraftTag] = useState(goal.tag);
  const [draftTarget, setDraftTarget] = useState(goal.target);
  const [draftDetails, setDraftDetails] = useState(goal.details ?? "");
  const [draftSources, setDraftSources] = useState<string[]>(
    goal.sources ?? []
  );
  const [bucketed, setBucketed] = useState(Boolean(goal.buckets));
  const [freeWillTarget, setFreeWillTarget] = useState(goal.buckets?.freeWill.target ?? 0);
  const [scheduledTarget, setScheduledTarget] = useState(goal.buckets?.scheduled.target ?? 0);
  const [freeWillSources, setFreeWillSources] = useState(goal.buckets?.freeWill.sources ?? []);
  const [scheduledSources, setScheduledSources] = useState(goal.buckets?.scheduled.sources ?? []);

  const save = () => {
    if (!draftTag.trim() || (bucketed ? !(freeWillTarget > 0 || scheduledTarget > 0) : !(draftTarget > 0))) return;
    updateGoal(getStore(), planId, goal.id, {
      tag: draftTag.trim(),
      target: bucketed ? freeWillTarget + scheduledTarget : draftTarget,
      details: draftDetails,
      sources: bucketed ? [...freeWillSources, ...scheduledSources] : draftSources.length > 0 ? draftSources : undefined,
      buckets: bucketed ? {
        freeWill: { target: freeWillTarget, sources: freeWillSources },
        scheduled: { target: scheduledTarget, sources: scheduledSources },
      } : undefined,
    });
    setEditing(false);
  };

  const cappedPct = Math.min(100, progress.satisfaction);
  const barColor = colorForResult(cappedPct);
  const displaySources = effectiveSources(goal);
  const isImplicit = !goal.sources || goal.sources.length === 0;

  return (
    <div className="px-3 py-2.5 border-b border-stone-200 last:border-b-0">
      {!editing ? (
        <>
          <div className="flex items-center gap-3">
            <div className="flex-1 min-w-0">
              <div className="font-medium text-stone-800 truncate">
                {goal.tag}
              </div>
              <div className="text-xs text-stone-500">
                {goal.buckets ? (
                  <div className="flex flex-wrap gap-x-4 gap-y-1 mt-1">
                    <span>Free will <strong className="text-stone-700">{progress.freeWillTotal}/{goal.buckets.freeWill.target} h</strong></span>
                    <span>Scheduled <strong className="text-stone-700">{progress.scheduledTotal}/{goal.buckets.scheduled.target} h</strong></span>
                  </div>
                ) : <><span className="font-semibold text-stone-700">{progress.total}</span> / {goal.target} · Unsplit</>}
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
                {progress.satisfaction}%
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
          </div>
          {goal.details && <GoalDetails text={goal.details} />}
          {goal.buckets ? (
            <div className="mt-2 grid gap-1 text-xs text-stone-500">
              <div>Free will tags: {goal.buckets.freeWill.sources.join(", ") || "none linked"}</div>
              <div>Scheduled tags: {goal.buckets.scheduled.sources.join(", ") || "none linked"}</div>
            </div>
          ) : (
            <div className="mt-1.5 flex flex-wrap items-center gap-1 text-[11px] text-stone-500">
              <span className="uppercase tracking-wider text-stone-400">{isImplicit ? "matches" : "feeds from"}</span>
              {displaySources.map((s) => <span key={s} className="px-1.5 py-0.5 rounded border border-stone-200 bg-white text-stone-700">{s}</span>)}
              {isImplicit && displaySources.length > 0 && <span className="text-stone-400 italic">(auto-matched to column name)</span>}
            </div>
          )}
        </>
      ) : (
        <div className="space-y-2.5">
          <div className="flex items-center gap-2 flex-wrap">
            <input
              value={draftTag}
              onChange={(e) => setDraftTag(e.target.value)}
              className="flex-1 min-w-[140px] px-2 py-1 rounded border border-stone-300 text-sm"
              placeholder="Goal name"
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
                setDraftDetails(goal.details ?? "");
                setDraftSources(goal.sources ?? []);
                setBucketed(Boolean(goal.buckets));
                setFreeWillTarget(goal.buckets?.freeWill.target ?? 0);
                setScheduledTarget(goal.buckets?.scheduled.target ?? 0);
                setFreeWillSources(goal.buckets?.freeWill.sources ?? []);
                setScheduledSources(goal.buckets?.scheduled.sources ?? []);
              }}
              className="px-2.5 py-1 rounded bg-stone-100 text-xs"
            >
              cancel
            </button>
          </div>
          <GoalDetailsEditor value={draftDetails} onChange={setDraftDetails} />
          {bucketed ? (
            <div className="grid gap-2 sm:grid-cols-2">
              <BucketEditor label="Free will" target={freeWillTarget} onTargetChange={setFreeWillTarget} sources={freeWillSources} onSourcesChange={(next) => {
                setFreeWillSources(next);
                setScheduledSources((current) => current.filter((s) => !next.some((n) => n.toLowerCase() === s.toLowerCase())));
              }} available={availableHourSources} />
              <BucketEditor label="Scheduled" target={scheduledTarget} onTargetChange={setScheduledTarget} sources={scheduledSources} onSourcesChange={(next) => {
                setScheduledSources(next);
                setFreeWillSources((current) => current.filter((s) => !next.some((n) => n.toLowerCase() === s.toLowerCase())));
              }} available={availableHourSources} />
            </div>
          ) : (
            <div className="space-y-2">
              <label className="flex items-center gap-2 text-sm text-stone-600">Unsplit target
                <input type="number" min="0" value={draftTarget} onChange={(e) => setDraftTarget(Number(e.target.value) || 0)} className="w-24 px-2 py-1 rounded border border-stone-300" />
              </label>
              <SourcesPicker available={availableSources} selected={draftSources} onChange={setDraftSources} fallbackTag={draftTag} />
              <button type="button" onClick={() => {
                setBucketed(true);
                setFreeWillTarget(draftTarget);
                setFreeWillSources(effectiveSources({ ...goal, tag: draftTag, sources: draftSources }).filter((s) =>
                  !availableSources.some((a) => a.toLowerCase() === s.toLowerCase()) ||
                  availableHourSources.some((a) => a.toLowerCase() === s.toLowerCase())
                ));
              }} className="text-xs underline text-stone-600">Split into Free will and Scheduled hours</button>
              <p className="text-xs text-stone-400">After splitting, only hour-type week-log tags count toward these targets.</p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function GoalDetails({ text }: { text: string }) {
  return (
    <div className="mt-3 text-sm leading-6 text-stone-700">
      {text.split("\n").map((line, i) =>
        line.startsWith("# ") ? (
          <h5 key={i} className="text-xl font-semibold leading-7 text-stone-900">{line.slice(2)}</h5>
        ) : line.startsWith("## ") ? (
          <h6 key={i} className="text-base font-semibold text-stone-900">{line.slice(3)}</h6>
        ) : line.startsWith("- ") ? (
          <ul key={i} className="list-disc pl-6"><li>{line.slice(2)}</li></ul>
        ) : (
          <p key={i} className="min-h-6 whitespace-pre-wrap">{line || "\u00a0"}</p>
        )
      )}
    </div>
  );
}

function GoalDetailsEditor({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  const textarea = useRef<HTMLTextAreaElement>(null);
  const addLine = (prefix: string) => {
    const input = textarea.current;
    if (!input) return;
    const start = input.selectionStart;
    const lineStart = value.lastIndexOf("\n", start - 1) + 1;
    onChange(value.slice(0, lineStart) + prefix + value.slice(lineStart));
    requestAnimationFrame(() => {
      input.focus();
      input.setSelectionRange(start + prefix.length, start + prefix.length);
    });
  };

  return (
    <div className="rounded-md border border-stone-300 bg-white overflow-hidden">
      <div className="flex gap-1 p-1 border-b border-stone-200 bg-stone-50">
        <button type="button" onClick={() => addLine("# ")} className="px-2 py-1 rounded hover:bg-stone-200 text-sm font-semibold" title="Big heading">Title</button>
        <button type="button" onClick={() => addLine("## ")} className="px-2 py-1 rounded hover:bg-stone-200 text-sm font-medium" title="Small heading">Heading</button>
        <button type="button" onClick={() => addLine("- ")} className="px-2 py-1 rounded hover:bg-stone-200 text-sm" title="Bullet point">• List</button>
      </div>
      <textarea
        ref={textarea}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key !== "Enter" || e.shiftKey) return;
          const input = e.currentTarget;
          const start = input.selectionStart;
          const lineStart = value.lastIndexOf("\n", start - 1) + 1;
          if (!value.slice(lineStart, start).startsWith("- ")) return;
          e.preventDefault();
          const emptyBullet = value.slice(lineStart, start) === "- ";
          onChange(emptyBullet
            ? value.slice(0, lineStart) + value.slice(start)
            : value.slice(0, start) + "\n- " + value.slice(input.selectionEnd));
          requestAnimationFrame(() => {
            input.setSelectionRange(emptyBullet ? lineStart : start + 3, emptyBullet ? lineStart : start + 3);
          });
        }}
        rows={5}
        aria-label="Goal writing"
        placeholder="Write about this goal. Press Enter for a new line; use Title, Heading, or List to format a line."
        className="w-full resize-y p-3 text-sm leading-6 text-stone-800 outline-none"
      />
      {value.trim() && <div className="border-t border-stone-200 px-3 pb-3"><div className="pt-2 text-xs text-stone-400">Preview</div><GoalDetails text={value} /></div>}
    </div>
  );
}

function averageSatisfaction(
  rows: Array<{ progress: ReturnType<typeof goalProgress> }>
): number {
  if (rows.length === 0) return 0;
  return Math.round(rows.reduce((sum, row) => sum + row.progress.satisfaction, 0) / rows.length);
}
