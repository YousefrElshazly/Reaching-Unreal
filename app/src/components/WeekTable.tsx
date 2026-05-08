import { useState } from "react";
import type { ColumnDef, UserTable, Week } from "../types";
import { DAYS } from "../types";
import {
  addColumn,
  deleteColumn,
  deleteUserTableFromWeek,
  getStore,
  reorderColumns,
  setCell,
  updateColumn,
} from "../store/yjs";
import { columnTotal, dayScore, weekScore } from "../utils/score";
import {
  colorForBoolean,
  colorForHours,
  colorForResult,
  textColorFor,
} from "../utils/colors";

interface Props {
  week: Week;
  table: UserTable;
  isOwner: boolean;
}

function newColumnId(weekId: string, userId: string, name: string): string {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "_").slice(0, 24);
  return `${userId}-${weekId}-${Date.now().toString(36)}-${slug}`;
}

export function WeekTable({ week, table, isOwner }: Props) {
  const [adding, setAdding] = useState(false);
  const [newName, setNewName] = useState("");
  const [newWeight, setNewWeight] = useState(10);
  const [newType, setNewType] = useState<"hours" | "boolean">("hours");
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dropTargetId, setDropTargetId] = useState<string | null>(null);

  const handleAdd = () => {
    if (!newName.trim()) return;
    const col: ColumnDef = {
      id: newColumnId(week.id, table.userId, newName),
      name: newName.trim(),
      type: newType,
      weight: newWeight,
    };
    addColumn(getStore(), week.id, table.userId, col);
    setNewName("");
    setNewWeight(10);
    setNewType("hours");
    setAdding(false);
  };

  const onCellChange = (day: string, columnId: string, raw: string) => {
    const v = parseFloat(raw);
    setCell(
      getStore(),
      week.id,
      table.userId,
      day,
      columnId,
      Number.isFinite(v) ? v : 0
    );
  };

  const cellId = (day: string, columnId: string) =>
    `cell-${week.id}-${table.userId}-${day}-${columnId}`;

  const focusCell = (day: string, columnId: string) => {
    const el = document.getElementById(cellId(day, columnId)) as
      | HTMLInputElement
      | null;
    if (el) {
      el.focus();
      el.select();
    }
  };

  const onCellKeyDown = (
    e: React.KeyboardEvent<HTMLInputElement>,
    day: string,
    columnId: string
  ) => {
    const dayIdx = DAYS.indexOf(day as (typeof DAYS)[number]);
    const colIdx = table.columns.findIndex((c) => c.id === columnId);
    const move = (dRow: number, dCol: number) => {
      const nextRow = dayIdx + dRow;
      const nextCol = colIdx + dCol;
      if (nextRow < 0 || nextRow >= DAYS.length) return;
      if (nextCol < 0 || nextCol >= table.columns.length) return;
      e.preventDefault();
      focusCell(DAYS[nextRow], table.columns[nextCol].id);
    };
    switch (e.key) {
      case "Enter":
        move(e.shiftKey ? -1 : 1, 0);
        break;
      case "ArrowDown":
        move(1, 0);
        break;
      case "ArrowUp":
        move(-1, 0);
        break;
      case "ArrowRight":
        // only navigate if cursor is at end of input (so left/right within text still works)
        if (
          (e.target as HTMLInputElement).selectionStart ===
          (e.target as HTMLInputElement).value.length
        ) {
          move(0, 1);
        }
        break;
      case "ArrowLeft":
        if ((e.target as HTMLInputElement).selectionStart === 0) {
          move(0, -1);
        }
        break;
      case "Tab":
        move(0, e.shiftKey ? -1 : 1);
        break;
      default:
        break;
    }
  };

  const onWeightChange = (col: ColumnDef, value: string) => {
    const w = parseFloat(value);
    if (!Number.isFinite(w)) return;
    updateColumn(getStore(), week.id, table.userId, col.id, { weight: w });
  };

  const onRenameColumn = (col: ColumnDef) => {
    const next = window.prompt("Rename column", col.name);
    if (!next || next.trim() === col.name) return;
    updateColumn(getStore(), week.id, table.userId, col.id, {
      name: next.trim(),
    });
  };

  const onTypeToggle = (col: ColumnDef) => {
    const next: "hours" | "boolean" = col.type === "hours" ? "boolean" : "hours";
    updateColumn(getStore(), week.id, table.userId, col.id, { type: next });
  };

  const onDelete = (col: ColumnDef) => {
    if (!window.confirm(`Delete column "${col.name}"?`)) return;
    deleteColumn(getStore(), week.id, table.userId, col.id);
  };

  const onDeleteTable = () => {
    if (
      !window.confirm(
        `Delete ${table.userName}'s table for this week? You can re-add it afterwards.`
      )
    )
      return;
    deleteUserTableFromWeek(getStore(), week.id, table.userId);
  };

  return (
    <div className="rounded-xl border border-stone-200 bg-white shadow-sm overflow-hidden">
      <div className="flex items-center justify-between px-4 py-3 border-b border-stone-200 bg-stone-50">
        <div className="flex items-center gap-2">
          <div
            className="w-2.5 h-2.5 rounded-full"
            style={{ backgroundColor: colorOfUser(table.userId) }}
          />
          <h3 className="font-semibold text-stone-800">{table.userName}</h3>
          {!isOwner && (
            <span className="text-xs text-stone-500 ml-1">(viewing)</span>
          )}
        </div>
        <div className="flex items-center gap-3 text-xs text-stone-500">
          <span>
            Week score:{" "}
            <span className="font-semibold text-stone-800">
              {weekScore(table)}
            </span>
          </span>
          <button
            onClick={() => setAdding((v) => !v)}
            className="px-2 py-1 rounded-md bg-stone-100 hover:bg-stone-200 text-stone-700 text-xs font-medium"
          >
            {adding ? "Cancel" : "+ Column"}
          </button>
          {isOwner && (
            <button
              onClick={onDeleteTable}
              className="px-2 py-1 rounded-md bg-white border border-rose-200 text-rose-600 hover:bg-rose-50 text-xs font-medium"
              title="Delete my table for this week"
            >
              Delete table
            </button>
          )}
        </div>
      </div>

      {adding && (
        <div className="flex flex-wrap items-end gap-3 px-4 py-3 bg-amber-50 border-b border-amber-200">
          <label className="flex flex-col text-xs text-stone-600">
            Column name
            <input
              autoFocus
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              className="mt-1 px-2 py-1.5 rounded border border-stone-300 text-sm w-56"
              placeholder="e.g. Reading"
              onKeyDown={(e) => e.key === "Enter" && handleAdd()}
            />
          </label>
          <label className="flex flex-col text-xs text-stone-600">
            Weight (%)
            <input
              type="number"
              value={newWeight}
              onChange={(e) => setNewWeight(parseFloat(e.target.value) || 0)}
              className="mt-1 px-2 py-1.5 rounded border border-stone-300 text-sm w-24"
            />
          </label>
          <label className="flex flex-col text-xs text-stone-600">
            Type
            <select
              value={newType}
              onChange={(e) =>
                setNewType(e.target.value as "hours" | "boolean")
              }
              className="mt-1 px-2 py-1.5 rounded border border-stone-300 text-sm bg-white"
            >
              <option value="hours">Hours</option>
              <option value="boolean">Boolean (0/1)</option>
            </select>
          </label>
          <button
            onClick={handleAdd}
            className="px-3 py-1.5 bg-emerald-600 hover:bg-emerald-700 text-white text-sm font-medium rounded"
          >
            Add
          </button>
        </div>
      )}

      <div className="overflow-x-auto">
        <table className="ru-grid">
          <thead>
            <tr>
              <th style={{ minWidth: 110, textAlign: "left", paddingLeft: 12 }}>
                Day \ Project
              </th>
              {table.columns.map((col) => {
                const isDragging = draggingId === col.id;
                const isDropTarget =
                  dropTargetId === col.id && draggingId && draggingId !== col.id;
                return (
                  <th
                    key={col.id}
                    style={{
                      minWidth: 96,
                      opacity: isDragging ? 0.4 : 1,
                      boxShadow: isDropTarget
                        ? "inset 3px 0 0 #16a34a"
                        : undefined,
                      transition: "box-shadow 80ms",
                    }}
                    draggable
                    onDragStart={(e) => {
                      setDraggingId(col.id);
                      e.dataTransfer.effectAllowed = "move";
                      e.dataTransfer.setData("text/plain", col.id);
                    }}
                    onDragEnd={() => {
                      setDraggingId(null);
                      setDropTargetId(null);
                    }}
                    onDragOver={(e) => {
                      if (!draggingId || draggingId === col.id) return;
                      e.preventDefault();
                      e.dataTransfer.dropEffect = "move";
                      if (dropTargetId !== col.id) setDropTargetId(col.id);
                    }}
                    onDragLeave={() => {
                      if (dropTargetId === col.id) setDropTargetId(null);
                    }}
                    onDrop={(e) => {
                      e.preventDefault();
                      const fromId =
                        e.dataTransfer.getData("text/plain") || draggingId;
                      if (fromId && fromId !== col.id) {
                        reorderColumns(
                          getStore(),
                          week.id,
                          table.userId,
                          fromId,
                          col.id
                        );
                      }
                      setDraggingId(null);
                      setDropTargetId(null);
                    }}
                  >
                    <div
                      className="flex flex-col items-center gap-1 group cursor-grab active:cursor-grabbing select-none"
                      onDoubleClick={() => onRenameColumn(col)}
                      title="Drag to reorder · Double-click to rename"
                    >
                      <div className="flex items-center gap-1.5">
                        <span
                          className="text-stone-400 leading-none"
                          aria-hidden
                          style={{ fontSize: 14 }}
                        >
                          ⋮⋮
                        </span>
                        <span className="whitespace-pre-line leading-tight">
                          {col.name}
                        </span>
                      </div>
                      <div
                        className="flex items-center gap-1 text-[11px] text-stone-500"
                        onMouseDown={(e) => e.stopPropagation()}
                        draggable={false}
                      >
                        <input
                          type="number"
                          value={col.weight}
                          onChange={(e) => onWeightChange(col, e.target.value)}
                          className="w-10 px-1 py-0.5 rounded border border-stone-200 bg-white text-center"
                          title="Weight (%)"
                          draggable={false}
                          onDragStart={(e) => e.preventDefault()}
                        />
                        <button
                          onClick={() => onTypeToggle(col)}
                          className="px-1.5 py-0.5 rounded border border-stone-200 bg-white hover:bg-stone-50"
                          title="Toggle type"
                        >
                          {col.type === "hours" ? "h" : "0/1"}
                        </button>
                        <button
                          onClick={() => onDelete(col)}
                          className="opacity-0 group-hover:opacity-100 transition-opacity text-rose-500 hover:text-rose-700"
                          title="Delete column"
                        >
                          ×
                        </button>
                      </div>
                    </div>
                  </th>
                );
              })}
              <th style={{ minWidth: 78, background: "#fef3c7" }}>Results</th>
            </tr>
          </thead>
          <tbody>
            {DAYS.map((day) => {
              const row = table.rows.find((r) => r.day === day) ?? {
                day,
                values: {},
              };
              const score = dayScore(row, table.columns);
              const resultBg = colorForResult(score);
              return (
                <tr key={day}>
                  <td className="day-label">{day}</td>
                  {table.columns.map((col) => {
                    const v = row.values[col.id] ?? 0;
                    const bg =
                      col.type === "boolean"
                        ? colorForBoolean(v)
                        : colorForHours(v);
                    const fg = textColorFor(bg);
                    return (
                      <td key={col.id} style={{ background: bg, color: fg }}>
                        <input
                          id={cellId(day, col.id)}
                          className="ru-cell"
                          type="number"
                          step={col.type === "boolean" ? 1 : 0.25}
                          min={0}
                          max={col.type === "boolean" ? 1 : undefined}
                          value={v || ""}
                          onChange={(e) =>
                            onCellChange(day, col.id, e.target.value)
                          }
                          onFocus={(e) => e.currentTarget.select()}
                          onKeyDown={(e) => onCellKeyDown(e, day, col.id)}
                          placeholder="0"
                          inputMode="decimal"
                        />
                      </td>
                    );
                  })}
                  <td
                    style={{
                      background: resultBg,
                      color: textColorFor(resultBg),
                      fontWeight: 700,
                    }}
                  >
                    {score ? Math.round(score) : ""}
                  </td>
                </tr>
              );
            })}
          </tbody>
          <tfoot>
            <tr>
              <td className="day-label" style={{ background: "#f5f5f4" }}>
                Total
              </td>
              {table.columns.map((col) => {
                const t = columnTotal(table, col.id);
                return (
                  <td key={col.id}>
                    {col.type === "boolean"
                      ? `${t}/7`
                      : t
                      ? t.toFixed(2).replace(/\.00$/, "")
                      : ""}
                  </td>
                );
              })}
              <td
                style={{
                  background: colorForResult(weekScore(table)),
                  color: textColorFor(colorForResult(weekScore(table))),
                  fontWeight: 800,
                }}
              >
                {weekScore(table)}%
              </td>
            </tr>
          </tfoot>
        </table>
      </div>
    </div>
  );
}

function colorOfUser(userId: string): string {
  // Stable color from the seed users; fallback hash-based.
  if (userId === "shazly") return "#7c3aed";
  if (userId === "sayed") return "#0ea5e9";
  let h = 0;
  for (const ch of userId) h = (h * 31 + ch.charCodeAt(0)) | 0;
  return `hsl(${Math.abs(h) % 360} 70% 45%)`;
}
