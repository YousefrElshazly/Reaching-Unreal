import type { Week } from "../types";
import { formatRange, parseISO } from "../utils/seasons";
import { useCalendar } from "../hooks/useStore";

interface Props {
  weeks: Week[];
  currentId: string;
  onSelect: (id: string) => void;
  onAddWeek: () => void;
  onShowSummary: () => void;
  onShowSettings: () => void;
}

export function WeekNav({
  weeks,
  currentId,
  onSelect,
  onAddWeek,
  onShowSummary,
  onShowSettings,
}: Props) {
  const cal = useCalendar();
  const cur = weeks.find((w) => w.id === currentId);
  const idx = weeks.findIndex((w) => w.id === currentId);

  const goPrev = () => {
    if (idx > 0) onSelect(weeks[idx - 1].id);
  };
  const goNext = () => {
    if (idx >= 0 && idx < weeks.length - 1) onSelect(weeks[idx + 1].id);
  };
  const goCurrent = () => {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    let best: Week | null = null;
    for (const w of weeks) {
      const start = parseISO(w.startDate);
      if (start.getTime() <= today.getTime()) best = w;
    }
    if (best) onSelect(best.id);
  };

  const label = cur ? cal.labelForWeekStart(parseISO(cur.startDate)) : null;
  const range = cur ? formatRange(parseISO(cur.startDate), parseISO(cur.endDate)) : "";

  return (
    <div className="flex items-center gap-2 flex-wrap">
      <button
        onClick={goPrev}
        disabled={idx <= 0}
        className="px-2.5 py-1.5 rounded-md bg-white border border-stone-200 hover:bg-stone-50 disabled:opacity-40 text-sm"
      >
        ←
      </button>
      <select
        value={currentId}
        onChange={(e) => onSelect(e.target.value)}
        className="px-3 py-1.5 rounded-md bg-white border border-stone-200 text-sm font-medium min-w-[260px]"
      >
        {weeks.map((w) => {
          const lbl = cal.labelForWeekStart(parseISO(w.startDate));
          return (
            <option value={w.id} key={w.id}>
              {lbl.short} · Week {w.weekNumber} · {formatRange(parseISO(w.startDate), parseISO(w.endDate))}
            </option>
          );
        })}
      </select>
      <button
        onClick={goNext}
        disabled={idx >= weeks.length - 1}
        className="px-2.5 py-1.5 rounded-md bg-white border border-stone-200 hover:bg-stone-50 disabled:opacity-40 text-sm"
      >
        →
      </button>
      <button
        onClick={goCurrent}
        className="px-3 py-1.5 rounded-md bg-emerald-100 text-emerald-800 hover:bg-emerald-200 text-sm font-medium"
      >
        Today
      </button>
      <button
        onClick={onAddWeek}
        className="px-3 py-1.5 rounded-md bg-stone-900 text-white hover:bg-stone-800 text-sm font-medium"
      >
        + New Week
      </button>
      <button
        onClick={onShowSummary}
        className="px-3 py-1.5 rounded-md bg-white border border-stone-200 hover:bg-stone-50 text-sm font-medium"
      >
        Summary
      </button>
      <button
        onClick={onShowSettings}
        className="px-3 py-1.5 rounded-md bg-white border border-stone-200 hover:bg-stone-50 text-sm font-medium"
        title="Settings"
        aria-label="Settings"
      >
        ⚙
      </button>
      <div className="ml-auto text-right">
        <div className="text-xs uppercase tracking-wider text-stone-500">
          {label ? label.display : ""}
        </div>
        <div className="text-sm text-stone-700 font-medium">{range}</div>
      </div>
    </div>
  );
}
