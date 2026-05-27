import * as Y from "yjs";
import { WebsocketProvider } from "y-websocket";
import { IndexeddbPersistence } from "y-indexeddb";
import { Awareness } from "y-protocols/awareness";
import seed from "../data/seed.json";
import type {
  AppData,
  AppUser,
  ColumnDef,
  DayRow,
  Plan,
  PlanGoal,
  UserTable,
  Week,
} from "../types";
import { DAYS } from "../types";

/**
 * Storage layout
 * --------------
 *  - Y.Map "meta"
 *      "users" -> JSON-encoded AppUser[]
 *  - Y.Map "structure"
 *      "json" -> JSON-encoded Week[] WITHOUT cell values (values are 0).
 *               Mutated as a snapshot when adding/removing columns,
 *               weeks, or editing weights.
 *  - Y.Map "cells"
 *      key `${weekId}:${userId}:${day}:${columnId}` -> number
 *      Cell values flow through this map for fine-grained CRDT merges.
 *
 * This split lets two users edit different cells with zero conflicts while
 * still keeping table/column structure consistent.
 */

const env = (import.meta as unknown as { env?: Record<string, string> }).env;

const ROOM = (env?.VITE_ROOM ?? "reaching-unreal-default").trim();

/**
 * Sync server URL. Set via `VITE_YWS_URL` at build time
 * (e.g. `wss://reaching-unreal-sync.fly.dev`). When empty, the app still works
 * fully offline using IndexedDB persistence — it just won't sync between
 * devices until you point this at a deployed server.
 */
const SYNC_URL = (env?.VITE_YWS_URL ?? "").trim();

export interface Store {
  doc: Y.Doc;
  provider: WebsocketProvider | null;
  awareness: Awareness;
  meta: Y.Map<unknown>;
  structure: Y.Map<unknown>;
  cells: Y.Map<number>;
  /** key `${weekId}:${userId}` -> note text (string). */
  notes: Y.Map<string>;
  /** key planId -> JSON-encoded Plan. */
  plans: Y.Map<string>;
  /** Reactive connection status for the sync server. */
  status: { value: "offline" | "connecting" | "connected" | "disconnected" };
}

let _store: Store | null = null;

export function getStore(): Store {
  if (_store) return _store;
  const doc = new Y.Doc();
  new IndexeddbPersistence(ROOM, doc);

  const status: Store["status"] = { value: SYNC_URL ? "connecting" : "offline" };
  let provider: WebsocketProvider | null = null;

  if (SYNC_URL) {
    try {
      provider = new WebsocketProvider(SYNC_URL, ROOM, doc, {
        // y-websocket auto-reconnects with backoff and survives sleeps/wakes;
        // ideal for iPhone backgrounding behaviour.
        connect: true,
      });
      provider.on("status", (e: { status: string }) => {
        status.value = (e.status as Store["status"]["value"]) ?? "disconnected";
      });
    } catch (e) {
      console.warn("[yjs] WebsocketProvider failed to initialise", e);
      status.value = "offline";
    }
  }

  const awareness = provider?.awareness ?? new Awareness(doc);
  const meta = doc.getMap<unknown>("meta");
  const structure = doc.getMap<unknown>("structure");
  const cells = doc.getMap<number>("cells");
  const notes = doc.getMap<string>("notes");
  const plans = doc.getMap<string>("plans");

  _store = {
    doc,
    provider,
    awareness,
    meta,
    structure,
    cells,
    notes,
    plans,
    status,
  };
  return _store;
}

export function noteKey(weekId: string, userId: string): string {
  return `${weekId}:${userId}`;
}

export function cellKey(
  weekId: string,
  userId: string,
  day: string,
  columnId: string
): string {
  return `${weekId}:${userId}:${day}:${columnId}`;
}

/** Hydrate seed data on first launch (when nothing has been synced yet). */
export function hydrateSeedIfEmpty(store: Store): void {
  const { meta, structure, cells, doc } = store;
  if (meta.has("users") && structure.has("json")) return;

  doc.transact(() => {
    if (!meta.has("users")) {
      meta.set("users", JSON.stringify(seed.users));
    }
    if (!structure.has("json")) {
      // Strip cell values from the seed for the structure (kept in cells map)
      const stripped: Week[] = (seed.weeks as Week[]).map((w) => ({
        ...w,
        tables: w.tables.map((t) => ({
          ...t,
          rows: t.rows.map((r) => ({
            day: r.day,
            values: Object.fromEntries(
              Object.keys(r.values).map((k) => [k, 0])
            ),
          })),
        })),
      }));
      structure.set("json", JSON.stringify(stripped));
    }
    // Seed cells from the original (with values)
    for (const w of seed.weeks as Week[]) {
      for (const t of w.tables) {
        for (const r of t.rows) {
          for (const [colId, v] of Object.entries(r.values)) {
            const k = cellKey(w.id, t.userId, r.day, colId);
            if (!cells.has(k) && v) cells.set(k, v as number);
          }
        }
      }
    }
  }, "seed");
}

// ---------- Read helpers ----------

export function getUsers(store: Store): AppUser[] {
  const raw = store.meta.get("users");
  if (typeof raw !== "string") return [];
  try {
    return JSON.parse(raw) as AppUser[];
  } catch {
    return [];
  }
}

export function getCalendarId(store: Store): string {
  const v = store.meta.get("calendarId");
  return typeof v === "string" && v ? v : "meteorological";
}

export function setCalendarId(store: Store, id: string): void {
  store.meta.set("calendarId", id);
}

export function getStructure(store: Store): Week[] {
  const raw = store.structure.get("json");
  if (typeof raw !== "string") return [];
  try {
    return JSON.parse(raw) as Week[];
  } catch {
    return [];
  }
}

export function setStructure(store: Store, next: Week[]): void {
  store.structure.set("json", JSON.stringify(next));
}

/** Build the full AppData by merging structure + cells map. */
export function buildAppData(store: Store): AppData {
  const users = getUsers(store);
  const structure = getStructure(store);
  const weeks: Week[] = structure.map((w) => ({
    ...w,
    tables: w.tables.map((t) => ({
      ...t,
      rows: t.rows.map((r) => ({
        day: r.day,
        values: Object.fromEntries(
          t.columns.map((c) => [
            c.id,
            store.cells.get(cellKey(w.id, t.userId, r.day, c.id)) ?? 0,
          ])
        ),
      })),
    })),
  }));
  return { users, weeks };
}

// ---------- Mutators ----------

export function setCell(
  store: Store,
  weekId: string,
  userId: string,
  day: string,
  columnId: string,
  value: number
): void {
  const k = cellKey(weekId, userId, day, columnId);
  if (!value) store.cells.delete(k);
  else store.cells.set(k, value);
}

export function updateStructure(
  store: Store,
  fn: (weeks: Week[]) => Week[]
): void {
  const cur = getStructure(store);
  const next = fn(cur);
  setStructure(store, next);
}

export function addColumn(
  store: Store,
  weekId: string,
  userId: string,
  col: ColumnDef
): void {
  updateStructure(store, (weeks) =>
    weeks.map((w) =>
      w.id !== weekId
        ? w
        : {
            ...w,
            tables: w.tables.map((t) =>
              t.userId !== userId
                ? t
                : {
                    ...t,
                    columns: [...t.columns, col],
                    rows: t.rows.map((r) => ({
                      ...r,
                      values: { ...r.values, [col.id]: 0 },
                    })),
                  }
            ),
          }
    )
  );
}

export function deleteColumn(
  store: Store,
  weekId: string,
  userId: string,
  columnId: string
): void {
  updateStructure(store, (weeks) =>
    weeks.map((w) =>
      w.id !== weekId
        ? w
        : {
            ...w,
            tables: w.tables.map((t) =>
              t.userId !== userId
                ? t
                : {
                    ...t,
                    columns: t.columns.filter((c) => c.id !== columnId),
                    rows: t.rows.map((r) => {
                      const { [columnId]: _, ...rest } = r.values;
                      return { ...r, values: rest };
                    }),
                  }
            ),
          }
    )
  );
  // Best-effort: also remove cell entries
  const prefix = `${weekId}:${userId}:`;
  for (const k of Array.from(store.cells.keys())) {
    if (k.startsWith(prefix) && k.endsWith(`:${columnId}`)) store.cells.delete(k);
  }
}

export function reorderColumns(
  store: Store,
  weekId: string,
  userId: string,
  fromId: string,
  toId: string
): void {
  if (fromId === toId) return;
  updateStructure(store, (weeks) =>
    weeks.map((w) =>
      w.id !== weekId
        ? w
        : {
            ...w,
            tables: w.tables.map((t) => {
              if (t.userId !== userId) return t;
              const cols = [...t.columns];
              const fromIdx = cols.findIndex((c) => c.id === fromId);
              const toIdx = cols.findIndex((c) => c.id === toId);
              if (fromIdx < 0 || toIdx < 0) return t;
              const [moved] = cols.splice(fromIdx, 1);
              cols.splice(toIdx, 0, moved);
              return { ...t, columns: cols };
            }),
          }
    )
  );
}

export function updateColumn(
  store: Store,
  weekId: string,
  userId: string,
  columnId: string,
  patch: Partial<ColumnDef>
): void {
  updateStructure(store, (weeks) =>
    weeks.map((w) =>
      w.id !== weekId
        ? w
        : {
            ...w,
            tables: w.tables.map((t) =>
              t.userId !== userId
                ? t
                : {
                    ...t,
                    columns: t.columns.map((c) =>
                      c.id !== columnId ? c : { ...c, ...patch }
                    ),
                  }
            ),
          }
    )
  );
}

export function addWeekAfterLast(store: Store): Week | null {
  const weeks = getStructure(store);
  if (weeks.length === 0) return null;
  const last = weeks[weeks.length - 1];
  const lastStart = new Date(last.startDate + "T00:00:00");
  const newStart = new Date(lastStart);
  newStart.setDate(newStart.getDate() + 7);
  const newEnd = new Date(newStart);
  newEnd.setDate(newEnd.getDate() + 6);
  const id = `week-${last.weekNumber + 1}`;
  const fmt = (d: Date) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
      d.getDate()
    ).padStart(2, "0")}`;
  const next: Week = {
    id,
    weekNumber: last.weekNumber + 1,
    startDate: fmt(newStart),
    endDate: fmt(newEnd),
    tables: last.tables.map((t) => ({
      userId: t.userId,
      userName: t.userName,
      // Same columns as the previous week so nothing is lost; new IDs to keep
      // cell-keyspace per-week.
      columns: t.columns.map((c) => ({
        ...c,
        id: c.id.replace(/-week-\d+-/, `-${id}-`).replace(/^.*?-(\d+)-/, (m) =>
          // fall back: ensure unique per-week IDs
          m
        ),
      })),
      rows: DAYS.map((day) => ({ day, values: {} })),
    })),
  };
  // Make sure column IDs are uniquely scoped to the new week id even if regex
  // didn't match the previous shape.
  next.tables = next.tables.map((t) => ({
    ...t,
    columns: t.columns.map((c, idx) => ({
      ...c,
      id: `${t.userId}-${id}-${idx}-${c.name.toLowerCase().replace(/\s+/g, "_")}`,
    })),
    rows: DAYS.map((day) => ({
      day,
      values: Object.fromEntries(t.columns.map((c, idx) => [
        `${t.userId}-${id}-${idx}-${c.name.toLowerCase().replace(/\s+/g, "_")}`,
        0,
      ])),
    })),
  }));
  setStructure(store, [...weeks, next]);
  return next;
}

export function deleteUserTableFromWeek(
  store: Store,
  weekId: string,
  userId: string
): void {
  updateStructure(store, (weeks) =>
    weeks.map((w) =>
      w.id !== weekId
        ? w
        : { ...w, tables: w.tables.filter((t) => t.userId !== userId) }
    )
  );
  // Also drop any cell entries for that user in that week
  const prefix = `${weekId}:${userId}:`;
  for (const k of Array.from(store.cells.keys())) {
    if (k.startsWith(prefix)) store.cells.delete(k);
  }
}

export function addUserTableToWeek(
  store: Store,
  weekId: string,
  user: AppUser
): void {
  updateStructure(store, (weeks) =>
    weeks.map((w) =>
      w.id !== weekId
        ? w
        : {
            ...w,
            tables: [
              ...w.tables,
              {
                userId: user.id,
                userName: user.name,
                columns: [],
                rows: DAYS.map((day) => ({ day, values: {} })),
              },
            ],
          }
    )
  );
}

// ---------- Awareness / Presence ----------

export interface PresenceData {
  user: AppUser;
  cursor: { x: number; y: number } | null;
}

export function setPresence(
  store: Store,
  data: Partial<PresenceData>
): void {
  const aw = store.awareness;
  const cur = aw.getLocalState() ?? {};
  aw.setLocalState({ ...cur, ...data });
}

export function listPresence(store: Store): Map<number, PresenceData> {
  return store.awareness.getStates() as Map<number, PresenceData>;
}

export function clientId(store: Store): number {
  return store.awareness.clientID;
}

// Useful for snapshot subscriptions: returns a function that fires on any
// update to any of the shared maps.
export function subscribeAll(
  store: Store,
  cb: () => void
): () => void {
  const handler = () => cb();
  store.meta.observeDeep(handler);
  store.structure.observeDeep(handler);
  store.cells.observe(handler);
  store.notes.observe(handler);
  store.plans.observe(handler);
  return () => {
    store.meta.unobserveDeep(handler);
    store.structure.unobserveDeep(handler);
    store.cells.unobserve(handler);
    store.notes.unobserve(handler);
    store.plans.unobserve(handler);
  };
}

// ---------- Notes (per-week-per-user) ----------

export function getNote(store: Store, weekId: string, userId: string): string {
  return store.notes.get(noteKey(weekId, userId)) ?? "";
}

export function setNote(
  store: Store,
  weekId: string,
  userId: string,
  text: string
): void {
  const k = noteKey(weekId, userId);
  if (!text) store.notes.delete(k);
  else store.notes.set(k, text);
}

// ---------- Plans ----------

export function getPlans(store: Store): Plan[] {
  const out: Plan[] = [];
  store.plans.forEach((raw) => {
    if (typeof raw !== "string") return;
    try {
      out.push(JSON.parse(raw) as Plan);
    } catch {
      /* ignore corrupt entry */
    }
  });
  return out.sort((a, b) => a.createdAt - b.createdAt);
}

export function getPlan(store: Store, planId: string): Plan | null {
  const raw = store.plans.get(planId);
  if (typeof raw !== "string") return null;
  try {
    return JSON.parse(raw) as Plan;
  } catch {
    return null;
  }
}

export function upsertPlan(store: Store, plan: Plan): void {
  store.plans.set(plan.id, JSON.stringify(plan));
}

export function deletePlan(store: Store, planId: string): void {
  store.plans.delete(planId);
}

export function newPlanId(): string {
  return `plan-${Date.now().toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 8)}`;
}

export function newGoalId(): string {
  return `goal-${Date.now().toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 6)}`;
}

export function updatePlan(
  store: Store,
  planId: string,
  patch: Partial<Plan>
): Plan | null {
  const cur = getPlan(store, planId);
  if (!cur) return null;
  const next: Plan = { ...cur, ...patch, id: cur.id };
  upsertPlan(store, next);
  return next;
}

export function addGoalToPlan(
  store: Store,
  planId: string,
  goal: Omit<PlanGoal, "id">
): Plan | null {
  const cur = getPlan(store, planId);
  if (!cur) return null;
  const next: Plan = {
    ...cur,
    goals: [...cur.goals, { id: newGoalId(), ...goal }],
  };
  upsertPlan(store, next);
  return next;
}

export function updateGoal(
  store: Store,
  planId: string,
  goalId: string,
  patch: Partial<Omit<PlanGoal, "id">>
): Plan | null {
  const cur = getPlan(store, planId);
  if (!cur) return null;
  const next: Plan = {
    ...cur,
    goals: cur.goals.map((g) => (g.id === goalId ? { ...g, ...patch } : g)),
  };
  upsertPlan(store, next);
  return next;
}

export function removeGoal(
  store: Store,
  planId: string,
  goalId: string
): Plan | null {
  const cur = getPlan(store, planId);
  if (!cur) return null;
  const next: Plan = { ...cur, goals: cur.goals.filter((g) => g.id !== goalId) };
  upsertPlan(store, next);
  return next;
}
