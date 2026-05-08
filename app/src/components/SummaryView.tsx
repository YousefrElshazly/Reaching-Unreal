import { useMemo, useState } from "react";
import type { AppData, Week } from "../types";
import { DAYS } from "../types";
import {
  formatRange,
  monthName,
  parseISO,
} from "../utils/seasons";
import { useCalendar } from "../hooks/useStore";
import type { Calendar } from "../calendars";
import { columnTotal, dayScore, weekScore } from "../utils/score";
import {
  colorForBoolean,
  colorForHours,
  colorForMiss,
  colorForResult,
  textColorFor,
} from "../utils/colors";

type Mode = "month" | "season" | "year";
type Tab = "trends" | "heatmap";

interface Props {
  data: AppData;
  onClose: () => void;
}

interface Bucket {
  key: string;
  label: string;
  weeks: Week[];
}

const RESULTS_TAG = "__results__";

function bucketsForMode(
  weeks: Week[],
  mode: Mode,
  calendar: Calendar
): Bucket[] {
  const map = new Map<string, Bucket>();
  // Track first-occurrence date per bucket for stable chronological ordering
  // (calendar bucket keys aren't always lexicographically sortable).
  const firstDate = new Map<string, number>();
  for (const w of weeks) {
    const start = parseISO(w.startDate);
    let key: string;
    let label: string;
    if (mode === "month") {
      key = `${start.getFullYear()}-${String(start.getMonth() + 1).padStart(2, "0")}`;
      label = `${monthName(start.getMonth())} ${start.getFullYear()}`;
    } else if (mode === "season") {
      const b = calendar.bucketForDate(start);
      key = b.key;
      label = b.label;
    } else {
      key = String(start.getFullYear());
      label = String(start.getFullYear());
    }
    if (!map.has(key)) {
      map.set(key, { key, label, weeks: [] });
      firstDate.set(key, start.getTime());
    }
    map.get(key)!.weeks.push(w);
  }
  return Array.from(map.values()).sort(
    (a, b) => (firstDate.get(a.key) ?? 0) - (firstDate.get(b.key) ?? 0)
  );
}

export function SummaryView({ data, onClose }: Props) {
  const [tab, setTab] = useState<Tab>("trends");
  const [mode, setMode] = useState<Mode>("month");
  const [userId, setUserId] = useState<string>(data.users[0]?.id ?? "shazly");
  const calendar = useCalendar();

  const buckets = useMemo(
    () => bucketsForMode(data.weeks, mode, calendar),
    [data.weeks, mode, calendar]
  );

  return (
    <div className="fixed inset-0 z-40 bg-stone-900/40 backdrop-blur-sm flex items-start justify-center overflow-auto py-10 px-4">
      <div className="bg-white rounded-2xl shadow-xl border border-stone-200 max-w-5xl w-full overflow-hidden">
        <div className="flex items-center gap-3 px-6 py-4 border-b border-stone-200 flex-wrap">
          <h2 className="text-lg font-semibold text-stone-800">Summary</h2>
          <div className="flex rounded-md bg-stone-100 p-0.5 text-sm">
            {(["trends", "heatmap"] as const).map((t) => (
              <button
                key={t}
                onClick={() => setTab(t)}
                className={`px-3 py-1 rounded ${
                  tab === t
                    ? "bg-white shadow text-stone-900"
                    : "text-stone-500"
                }`}
              >
                {t[0].toUpperCase() + t.slice(1)}
              </button>
            ))}
          </div>
          <div className="ml-auto flex items-center gap-2 flex-wrap">
            <div className="flex rounded-md bg-stone-100 p-0.5 text-sm">
              {(["month", "season", "year"] as const).map((m) => {
                const label =
                  m === "season"
                    ? calendar.bucketTerm
                    : m[0].toUpperCase() + m.slice(1);
                return (
                  <button
                    key={m}
                    onClick={() => setMode(m)}
                    className={`px-3 py-1 rounded ${
                      mode === m
                        ? "bg-white shadow text-stone-900"
                        : "text-stone-500"
                    }`}
                  >
                    {label}
                  </button>
                );
              })}
            </div>
            <select
              value={userId}
              onChange={(e) => setUserId(e.target.value)}
              className="px-3 py-1.5 rounded-md border border-stone-200 text-sm bg-white"
            >
              {data.users.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.name}
                </option>
              ))}
            </select>
            <button
              onClick={onClose}
              className="px-3 py-1.5 rounded-md bg-stone-100 hover:bg-stone-200 text-sm"
            >
              Close
            </button>
          </div>
        </div>

        <div className="p-6">
          {tab === "trends" ? (
            <TrendsTab
              buckets={buckets}
              userId={userId}
              calendar={calendar}
            />
          ) : (
            <HeatmapTab
              buckets={buckets}
              userId={userId}
              calendar={calendar}
            />
          )}
        </div>
      </div>
    </div>
  );
}

// ---------- Trends ----------

function TrendsTab({
  buckets,
  userId,
  calendar,
}: {
  buckets: Bucket[];
  userId: string;
  calendar: Calendar;
}) {
  const rows = useMemo(() => {
    return buckets.map((b) => {
      const colTotals = new Map<string, number>();
      const weekScores: number[] = [];
      let activeWeeks = 0;
      for (const w of b.weeks) {
        const t = w.tables.find((tt) => tt.userId === userId);
        if (!t) continue;
        const ws = weekScore(t);
        if (ws > 0 || t.columns.length > 0) activeWeeks++;
        weekScores.push(ws);
        for (const col of t.columns) {
          const total = columnTotal(t, col.id);
          colTotals.set(col.name, (colTotals.get(col.name) ?? 0) + total);
        }
      }
      const avg =
        weekScores.length > 0
          ? Math.round(
              weekScores.reduce((a, x) => a + x, 0) / weekScores.length
            )
          : 0;
      const allCols = Array.from(colTotals.entries()).sort(
        (a, b) => b[1] - a[1]
      );
      return { bucket: b, avg, weekCount: activeWeeks, allCols };
    });
  }, [buckets, userId]);

  return (
    <div className="space-y-6">
      {rows.length === 0 && (
        <div className="text-center text-stone-500 py-12">No data yet</div>
      )}
      {rows.map(({ bucket, avg, weekCount, allCols }) => (
        <BucketCard
          key={bucket.key}
          bucket={bucket}
          avg={avg}
          weekCount={weekCount}
          allCols={allCols}
          userId={userId}
          calendar={calendar}
        />
      ))}
    </div>
  );
}

function BucketCard({
  bucket,
  avg,
  weekCount,
  allCols,
  userId,
  calendar,
}: {
  bucket: Bucket;
  avg: number;
  weekCount: number;
  allCols: Array<[string, number]>;
  userId: string;
  calendar: Calendar;
}) {
  const [showAll, setShowAll] = useState(false);
  const TOP_N = 8;
  const visible = showAll ? allCols : allCols.slice(0, TOP_N);
  const hidden = Math.max(0, allCols.length - TOP_N);

  return (
    <div className="rounded-xl border border-stone-200 overflow-hidden">
      <div className="px-4 py-3 bg-stone-50 border-b border-stone-200 flex items-center gap-3">
        <h3 className="font-semibold text-stone-800">{bucket.label}</h3>
        <span className="text-xs text-stone-500">
          {weekCount} week{weekCount === 1 ? "" : "s"}
        </span>
        <div className="ml-auto flex items-center gap-2">
          <span className="text-xs text-stone-500">Avg score</span>
          <span
            className="px-2 py-0.5 rounded font-bold"
            style={{
              background: colorForResult(avg),
              color: textColorFor(colorForResult(avg)),
            }}
          >
            {avg}%
          </span>
        </div>
      </div>
      <div className="px-4 py-3">
        <div className="flex items-center justify-between mb-2">
          <div className="text-xs uppercase tracking-wider text-stone-500">
            {showAll ? "All categories" : "Top categories"}
          </div>
          {hidden > 0 && (
            <button
              onClick={() => setShowAll((v) => !v)}
              className="text-xs px-2 py-0.5 rounded border border-stone-200 bg-white hover:bg-stone-50 text-stone-700 font-medium"
            >
              {showAll ? `Show top ${TOP_N}` : `View all (${allCols.length})`}
            </button>
          )}
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
          {visible.length === 0 && (
            <div className="text-sm text-stone-400 col-span-4">
              No activity logged
            </div>
          )}
          {visible.map(([name, total]) => (
            <div
              key={name}
              className="rounded-md border border-stone-200 px-3 py-2"
            >
              <div className="text-xs text-stone-500 truncate" title={name}>
                {name}
              </div>
              <div className="text-sm font-semibold text-stone-800">
                {total.toFixed(2).replace(/\.00$/, "")}
              </div>
            </div>
          ))}
        </div>
        <div className="mt-3 flex flex-wrap gap-1.5">
          {bucket.weeks.map((w) => {
            const t = w.tables.find((tt) => tt.userId === userId);
            const s = t ? weekScore(t) : 0;
            const lbl = calendar.labelForWeekStart(parseISO(w.startDate));
            return (
              <div
                key={w.id}
                className="text-xs px-2 py-1 rounded border border-stone-200 flex items-center gap-1.5"
                title={`${formatRange(parseISO(w.startDate), parseISO(w.endDate))}`}
              >
                <span className="font-medium">{lbl.short}</span>
                <span
                  className="px-1.5 py-0.5 rounded font-bold"
                  style={{
                    background: colorForResult(s),
                    color: textColorFor(colorForResult(s)),
                  }}
                >
                  {s}
                </span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// ---------- Heatmap ----------

interface DayPoint {
  date: Date;
  iso: string; // YYYY-MM-DD
  hasData: boolean;
  /** total numeric value across selected tags for this day */
  value: number;
  /** number of selected tags considered (0 if no table that week) */
  selectedCount: number;
  /** number of those tags whose value was zero */
  zeroCount: number;
  /** breakdown for tooltip */
  breakdown: Array<{ name: string; value: number; type: "hours" | "boolean" | "results" }>;
  /** what colour mode to use */
  colorMode: "hours" | "boolean" | "results";
}

function HeatmapTab({
  buckets,
  userId,
  calendar,
}: {
  buckets: Bucket[];
  userId: string;
  calendar: Calendar;
}) {
  // Calendar is currently used only via parent for bucketing; reserved here for
  // future per-cell labels.
  void calendar;
  const [bucketKey, setBucketKey] = useState<string>(
    buckets[buckets.length - 1]?.key ?? ""
  );
  const bucket = buckets.find((b) => b.key === bucketKey) ?? buckets[buckets.length - 1];

  // Collect available tags across this user's tables in the selected bucket,
  // ranked by *consistency* (# of days with a positive value), and only
  // include tags that have at least one positive day in the period.
  const rankedTags = useMemo(() => {
    if (!bucket) return [] as Array<{ name: string; days: number }>;
    const counts = new Map<string, number>();
    for (const w of bucket.weeks) {
      const t = w.tables.find((tt) => tt.userId === userId);
      if (!t) continue;
      for (const col of t.columns) {
        let posDays = 0;
        for (const r of t.rows) {
          if ((r.values[col.id] ?? 0) > 0) posDays++;
        }
        counts.set(col.name, (counts.get(col.name) ?? 0) + posDays);
      }
    }
    return Array.from(counts.entries())
      .filter(([, days]) => days > 0)
      .map(([name, days]) => ({ name, days }))
      .sort((a, b) => b.days - a.days || a.name.localeCompare(b.name));
  }, [bucket, userId]);

  const [showAllTags, setShowAllTags] = useState(false);
  const TOP_TAGS = 10;
  const visibleTags = showAllTags
    ? rankedTags
    : rankedTags.slice(0, TOP_TAGS);
  const hiddenCount = Math.max(0, rankedTags.length - TOP_TAGS);

  const [selected, setSelected] = useState<Set<string>>(
    () => new Set([RESULTS_TAG])
  );
  const [flipped, setFlipped] = useState(false);

  const toggleTag = (name: string) => {
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  };

  const points = useMemo<DayPoint[]>(() => {
    if (!bucket) return [];
    const out: DayPoint[] = [];
    for (const w of bucket.weeks) {
      const t = w.tables.find((tt) => tt.userId === userId);
      const start = parseISO(w.startDate);
      for (let i = 0; i < 7; i++) {
        const date = new Date(start);
        date.setDate(start.getDate() + i);
        const iso = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
        const dayName = DAYS[i];
        const row = t?.rows.find((r) => r.day === dayName);
        let total = 0;
        let modeUsed: "hours" | "boolean" | "results" = "hours";
        const breakdown: DayPoint["breakdown"] = [];
        let hasData = false;
        let allBool = true;
        let touchedAny = false;
        let selectedCount = 0;
        let zeroCount = 0;
        const resultsSelected = selected.has(RESULTS_TAG);

        if (resultsSelected && t && row) {
          const v = dayScore(row, t.columns);
          total += v;
          if (v) hasData = true;
          breakdown.push({ name: "Results", value: v, type: "results" });
          modeUsed = "results";
          touchedAny = true;
          selectedCount++;
          if (!v) zeroCount++;
        }
        if (t && row) {
          for (const col of t.columns) {
            if (!selected.has(col.name)) continue;
            const v = row.values[col.id] ?? 0;
            total += v;
            if (v) hasData = true;
            breakdown.push({ name: col.name, value: v, type: col.type });
            if (col.type !== "boolean") allBool = false;
            touchedAny = true;
            selectedCount++;
            if (!v) zeroCount++;
          }
        }
        if (!resultsSelected && touchedAny) {
          modeUsed = allBool ? "boolean" : "hours";
        } else if (resultsSelected) {
          modeUsed = "results";
        }
        out.push({
          date,
          iso,
          hasData,
          value: total,
          selectedCount,
          zeroCount,
          breakdown,
          colorMode: modeUsed,
        });
      }
    }
    return out;
  }, [bucket, userId, selected]);

  const max = useMemo(() => {
    let m = 0;
    for (const p of points) m = Math.max(m, p.value);
    return m;
  }, [points]);

  if (buckets.length === 0) {
    return (
      <div className="text-center text-stone-500 py-12">No data yet</div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2 flex-wrap">
        <label className="text-xs uppercase tracking-wider text-stone-500">
          Period
        </label>
        <select
          value={bucketKey}
          onChange={(e) => setBucketKey(e.target.value)}
          className="px-3 py-1.5 rounded-md border border-stone-200 text-sm bg-white"
        >
          {buckets.map((b) => (
            <option key={b.key} value={b.key}>
              {b.label}
            </option>
          ))}
        </select>
        <span className="text-xs text-stone-400 ml-2">
          {bucket && bucket.weeks.length} week{bucket && bucket.weeks.length === 1 ? "" : "s"}
        </span>
      </div>

      <div>
        <div className="flex items-center justify-between mb-2 gap-2 flex-wrap">
          <div className="text-xs uppercase tracking-wider text-stone-500">
            Categories <span className="text-stone-400">(by consistency)</span>
          </div>
          <div className="flex items-center gap-1.5">
            <button
              onClick={() => setFlipped((v) => !v)}
              className={
                "text-xs px-2 py-0.5 rounded border font-medium transition-colors " +
                (flipped
                  ? "bg-rose-100 border-rose-300 text-rose-700 hover:bg-rose-200"
                  : "bg-white border-stone-200 text-stone-700 hover:bg-stone-50")
              }
              title="Flip: highlight days where the selected categories were missed"
            >
              {flipped ? "Flipped: showing misses" : "Flip"}
            </button>
            {hiddenCount > 0 && (
              <button
                onClick={() => setShowAllTags((v) => !v)}
                className="text-xs px-2 py-0.5 rounded border border-stone-200 bg-white hover:bg-stone-50 text-stone-700 font-medium"
              >
                {showAllTags
                  ? `Show top ${TOP_TAGS}`
                  : `Show all (${rankedTags.length})`}
              </button>
            )}
          </div>
        </div>
        <div className="flex flex-wrap gap-1.5">
          <TagChip
            label="Results"
            active={selected.has(RESULTS_TAG)}
            onToggle={() => toggleTag(RESULTS_TAG)}
            accent
          />
          {rankedTags.length === 0 && (
            <span className="text-sm text-stone-400">
              No active categories in this period
            </span>
          )}
          {visibleTags.map(({ name }) => (
            <TagChip
              key={name}
              label={name}
              active={selected.has(name)}
              onToggle={() => toggleTag(name)}
            />
          ))}
        </div>
      </div>

      <HeatmapGrid points={points} max={max} flipped={flipped} />
    </div>
  );
}

function TagChip({
  label,
  active,
  onToggle,
  accent,
}: {
  label: string;
  active: boolean;
  onToggle: () => void;
  accent?: boolean;
}) {
  return (
    <button
      onClick={onToggle}
      className={
        "text-xs px-2.5 py-1 rounded-full border transition-colors " +
        (active
          ? accent
            ? "bg-emerald-600 border-emerald-700 text-white"
            : "bg-stone-900 border-stone-900 text-white"
          : "bg-white border-stone-200 text-stone-700 hover:bg-stone-50")
      }
    >
      {label}
    </button>
  );
}

function HeatmapGrid({
  points,
  max,
  flipped,
}: {
  points: DayPoint[];
  max: number;
  flipped: boolean;
}) {
  if (points.length === 0) {
    return (
      <div className="text-center text-stone-400 py-8 border border-dashed border-stone-200 rounded-lg">
        Pick at least one category to see the heatmap.
      </div>
    );
  }
  const weeks: DayPoint[][] = [];
  for (let i = 0; i < points.length; i += 7) {
    weeks.push(points.slice(i, i + 7));
  }
  const colorFor = (p: DayPoint): string => {
    if (flipped) {
      if (p.selectedCount <= 0) return "transparent";
      return colorForMiss(p.zeroCount, p.selectedCount);
    }
    if (!p.hasData) return "transparent";
    if (p.colorMode === "results") return colorForResult(p.value);
    if (p.colorMode === "boolean") return colorForBoolean(p.value);
    return colorForHours(p.value);
  };
  return (
    <div className="rounded-xl border border-stone-200 overflow-hidden">
      <div className="overflow-x-auto p-4">
        <table className="border-separate" style={{ borderSpacing: 4 }}>
          <thead>
            <tr>
              <th />
              {DAYS.map((d) => (
                <th
                  key={d}
                  className="text-[10px] font-medium uppercase tracking-wider text-stone-500 px-1"
                >
                  {d.slice(0, 3)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {weeks.map((w, wi) => {
              const start = w[0]?.date;
              const startLabel = start
                ? `${monthName(start.getMonth()).slice(0, 3)} ${start.getDate()}`
                : "";
              return (
                <tr key={wi}>
                  <td className="text-[10px] text-stone-500 pr-2 whitespace-nowrap">
                    {startLabel}
                  </td>
                  {w.map((p) => {
                    const bg = colorFor(p);
                    const fg = textColorFor(bg);
                    const tooltip = [
                      p.iso,
                      ...p.breakdown.map(
                        (b) =>
                          `${b.name}: ${
                            b.type === "boolean"
                              ? b.value
                                ? "✓"
                                : "—"
                              : b.value.toFixed(2).replace(/\.00$/, "")
                          }`
                      ),
                      p.breakdown.length > 1
                        ? `Total: ${p.value.toFixed(2).replace(/\.00$/, "")}`
                        : "",
                    ]
                      .filter(Boolean)
                      .join("\n");
                    return (
                      <td
                        key={p.iso}
                        title={tooltip}
                        style={{
                          width: 32,
                          height: 32,
                          background: bg,
                          color: fg,
                          borderRadius: 6,
                          border: "1px solid #e7e5e4",
                          textAlign: "center",
                          fontSize: 10,
                          fontWeight: 600,
                          fontVariantNumeric: "tabular-nums",
                        }}
                      >
                        {p.hasData
                          ? p.value >= 10
                            ? Math.round(p.value)
                            : p.value.toFixed(1).replace(/\.0$/, "")
                          : ""}
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <Legend max={max} flipped={flipped} />
    </div>
  );
}

function Legend({ max, flipped }: { max: number; flipped: boolean }) {
  const ratios = [0, 0.25, 0.5, 0.75, 1];
  return (
    <div className="px-4 py-2 border-t border-stone-200 bg-stone-50 flex items-center gap-3 text-xs text-stone-500">
      <span>{flipped ? "Hit all" : "Less"}</span>
      <div className="flex gap-1">
        {ratios.map((r, i) => {
          const bg = flipped
            ? r === 0
              ? "#fff"
              : colorForMiss(r, 1)
            : r === 0
            ? "#fff"
            : colorForHours(Math.max(0.5, max * r));
          return (
            <span
              key={i}
              style={{
                width: 16,
                height: 16,
                background: bg,
                border: "1px solid #e7e5e4",
                borderRadius: 4,
              }}
            />
          );
        })}
      </div>
      <span>{flipped ? "Missed all" : "More"}</span>
      {!flipped && (
        <span className="ml-auto">
          Max in period:{" "}
          <strong className="text-stone-700">
            {max.toFixed(2).replace(/\.00$/, "")}
          </strong>
        </span>
      )}
    </div>
  );
}
