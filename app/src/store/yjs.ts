import * as Y from "yjs";
import { WebsocketProvider } from "y-websocket";
import { IndexeddbPersistence } from "y-indexeddb";
import { Awareness } from "y-protocols/awareness";
import seed from "../data/seed.json";
import type {
  AppData,
  AppUser,
  ColumnDef,
  Plan,
  PlanGoal,
  UserTable,
  Week,
} from "../types";
import { DAYS } from "../types";

/**
 * Storage layout (v2 — granular CRDT)
 * -----------------------------------
 *
 * Up to v1 the entire week structure (every week's metadata + every user's
 * tables + columns) was JSON.stringified into a single key in `structure`.
 * Yjs treats string values as last-write-wins, so any two devices editing
 * the structure concurrently would overwrite each other — losing whole
 * tables, columns, or weeks depending on which write landed last. The
 * auto-week-creation effect amplified this because both devices started
 * racing on every app open.
 *
 * v2 splits the structure into per-week and per-user-table keys so that
 * different writers touch disjoint Yjs keys and merge cleanly:
 *
 *  - Y.Map "meta"
 *      "users" -> JSON-encoded AppUser[]
 *      "calendarId" -> string
 *      "structureMigratedV2" -> "1" once migration has run on this doc
 *
 *  - Y.Map "weekMeta"
 *      key `${weekId}` -> JSON { id, weekNumber, startDate, endDate }
 *
 *  - Y.Map "userTables"
 *      key `${weekId}:${userId}` -> JSON UserTable
 *      (the table's `rows` array carries only day names; cell values still
 *      live in the `cells` map for cell-level conflict-free merges.)
 *
 *  - Y.Map "cells"
 *      key `${weekId}:${userId}:${day}:${columnId}` -> number
 *
 *  - Y.Map "structure"  (legacy, kept readable as a migration source —
 *      writes to it are best-effort mirrors for graceful downgrade)
 *
 *  - Y.Map "notes"
 *      key `${weekId}:${userId}` -> note text
 *
 *  - Y.Map "plans"
 *      key planId -> JSON Plan
 */

const env = (import.meta as unknown as { env?: Record<string, string> }).env;

const ROOM = (env?.VITE_ROOM ?? "reaching-unreal-default").trim();
const SYNC_URL = (env?.VITE_YWS_URL ?? "").trim();

export interface WeekMetaRow {
  id: string;
  weekNumber: number;
  startDate: string;
  endDate: string;
}

export interface Store {
  doc: Y.Doc;
  provider: WebsocketProvider | null;
  idb: IndexeddbPersistence;
  awareness: Awareness;
  meta: Y.Map<unknown>;
  /** Legacy monolithic structure — only used as a migration source. */
  structure: Y.Map<unknown>;
  /** weekId -> JSON WeekMetaRow */
  weekMeta: Y.Map<string>;
  /** `${weekId}:${userId}` -> JSON UserTable (no cell values) */
  userTables: Y.Map<string>;
  cells: Y.Map<number>;
  notes: Y.Map<string>;
  plans: Y.Map<string>;
  status: { value: "offline" | "connecting" | "connected" | "disconnected" };
  /**
   * Resolves once it's safe to make structural writes: local IndexedDB has
   * fully hydrated AND (the websocket has completed its initial sync OR we've
   * waited long enough that we won't block the UI on a cold server). This is
   * the guard that prevents the old "write to a half-loaded doc" corruption.
   */
  whenReady: Promise<void>;
}

let _store: Store | null = null;

// How long to wait for the websocket's first sync before proceeding with the
// locally-hydrated doc anyway. Render free tier can cold-start for 30-50s; we
// don't want to block seeding/auto-week that long, and for a returning user
// IndexedDB already holds the full doc, so proceeding is safe.
const WS_SYNC_TIMEOUT_MS = 45_000;
/** Re-request server state periodically (helps iOS after backgrounding). */
const WS_RESYNC_INTERVAL_MS = 30_000;

/** True sync state — websocket "connected" ≠ Yjs merged with server. */
export type SyncState =
  | "offline"
  | "connecting"
  | "syncing"
  | "synced"
  | "disconnected";

export function getConfiguredRoom(): string {
  return ROOM;
}

export function getConfiguredSyncUrl(): string {
  return SYNC_URL;
}

export function getSyncState(store: Store): SyncState {
  if (!SYNC_URL || !store.provider) return "offline";
  const p = store.provider;
  if (p.wsconnected) return p.synced ? "synced" : "syncing";
  return p.wsconnecting ? "connecting" : "disconnected";
}

/** Whether edits will reach other devices right now. */
export function isLiveSynced(store: Store): boolean {
  return getSyncState(store) === "synced";
}

export function getStore(): Store {
  if (_store) return _store;
  const doc = new Y.Doc();
  const idb = new IndexeddbPersistence(ROOM, doc);

  const status: Store["status"] = { value: SYNC_URL ? "connecting" : "offline" };
  let provider: WebsocketProvider | null = null;

  if (SYNC_URL) {
    try {
      provider = new WebsocketProvider(SYNC_URL, ROOM, doc, {
        // Critical: connect only after IndexedDB has hydrated below. If a
        // phone has unsynced local cells, connecting to the server first can
        // merge remote deletions/older structure before the local update is in
        // memory. Loading local first means the first websocket sync advertises
        // the complete local state and uploads it.
        connect: false,
        // Periodically re-pull server state — critical on iPhone after the OS
        // kills the websocket while the PWA was in the background.
        resyncInterval: WS_RESYNC_INTERVAL_MS,
        maxBackoffTime: 10_000,
      });
      provider.on("status", (e: { status: string }) => {
        status.value = (e.status as Store["status"]["value"]) ?? "disconnected";
      });
    } catch (e) {
      console.warn("[yjs] WebsocketProvider failed to initialise", e);
      status.value = "offline";
    }
  }

  // Build the readiness promise: wait for IndexedDB, then (best-effort) the
  // first websocket sync, with a hard timeout so we never hang the app.
  const idbReady = new Promise<void>((resolve) => {
    if (idb.synced) resolve();
    else idb.once("synced", () => resolve());
  });
  const wsReady = new Promise<void>((resolve) => {
    if (!provider) return resolve();
    if (provider.synced) return resolve();
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      resolve();
    };
    provider.once("sync", (isSynced: boolean) => {
      if (isSynced) finish();
    });
    setTimeout(finish, WS_SYNC_TIMEOUT_MS);
  });
  const whenReady = idbReady.then(() => {
    provider?.connect();
    return wsReady;
  });

  const awareness = provider?.awareness ?? new Awareness(doc);
  const meta = doc.getMap<unknown>("meta");
  const structure = doc.getMap<unknown>("structure");
  const weekMeta = doc.getMap<string>("weekMeta");
  const userTables = doc.getMap<string>("userTables");
  const cells = doc.getMap<number>("cells");
  const notes = doc.getMap<string>("notes");
  const plans = doc.getMap<string>("plans");

  _store = {
    doc,
    provider,
    idb,
    awareness,
    meta,
    structure,
    weekMeta,
    userTables,
    cells,
    notes,
    plans,
    status,
    whenReady,
  };
  return _store;
}

// ---------- Key helpers ----------

export function noteKey(weekId: string, userId: string): string {
  return `${weekId}:${userId}`;
}

export function tableKey(weekId: string, userId: string): string {
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

/** Stable slug used for deterministic column IDs. */
export function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 32);
}

/**
 * Deterministic, collision-safe column ID. The same column name in the same
 * (week, user) always maps to the same ID across devices — which is what
 * stops the duplicate-column fragmentation we used to get from
 * `Date.now()`-based IDs (two devices adding "Gym" produced two different
 * columns that never merged). If a *different* column already occupies the
 * base slug locally, a numeric suffix is appended so genuine duplicates are
 * still allowed.
 */
export function columnId(
  weekId: string,
  userId: string,
  name: string,
  existing: { id: string }[] = []
): string {
  const slug = slugify(name) || "col";
  const base = `${userId}-${weekId}-${slug}`;
  if (!existing.some((c) => c.id === base)) return base;
  let n = 2;
  while (existing.some((c) => c.id === `${base}-${n}`)) n++;
  return `${base}-${n}`;
}

/** Extract logical slug from a (possibly legacy) column id string. */
function slugFromColumnId(colId: string, userId: string, weekId: string): string {
  let rest = colId;
  if (rest.startsWith(`${userId}-`)) rest = rest.slice(userId.length + 1);
  const wkNum = weekId.replace(/^week-/, "");
  if (rest.startsWith(`week-${wkNum}-`)) rest = rest.slice(`week-${wkNum}-`.length);
  else if (rest.startsWith(`${wkNum}-`)) rest = rest.slice(`${wkNum}-`.length);
  const dash = rest.indexOf("-");
  if (dash > 0) {
    const head = rest.slice(0, dash);
    const isIndex = /^\d+$/.test(head);
    const isTimestamp =
      /^[0-9a-z]{7,10}$/.test(head) &&
      (/\d/.test(head) || /^m[a-z0-9]{7}$/.test(head));
    if (isIndex || isTimestamp) rest = rest.slice(dash + 1);
  }
  return slugify(rest);
}

// ---------- Granular read/write helpers ----------

function parseWeekMetaRow(raw: unknown): WeekMetaRow | null {
  if (typeof raw !== "string") return null;
  try {
    const v = JSON.parse(raw) as WeekMetaRow;
    if (!v?.id || !v.startDate || !v.endDate) return null;
    return v;
  } catch {
    return null;
  }
}

function parseUserTable(raw: unknown): UserTable | null {
  if (typeof raw !== "string") return null;
  try {
    const v = JSON.parse(raw) as UserTable;
    if (!v?.userId || !Array.isArray(v.columns) || !Array.isArray(v.rows))
      return null;
    return v;
  } catch {
    return null;
  }
}

function writeWeekMeta(store: Store, row: WeekMetaRow): void {
  store.weekMeta.set(row.id, JSON.stringify(row));
}

function writeUserTable(store: Store, weekId: string, table: UserTable): void {
  // Strip cell values from the row.values map; cells live in their own map.
  const sanitized: UserTable = {
    ...table,
    rows: table.rows.map((r) => ({
      day: r.day,
      values: Object.fromEntries(Object.keys(r.values).map((k) => [k, 0])),
    })),
  };
  store.userTables.set(tableKey(weekId, table.userId), JSON.stringify(sanitized));
}

function listWeekMetaRows(store: Store): WeekMetaRow[] {
  const out: WeekMetaRow[] = [];
  store.weekMeta.forEach((v) => {
    const r = parseWeekMetaRow(v);
    if (r) out.push(r);
  });
  return out.sort((a, b) => a.startDate.localeCompare(b.startDate));
}

function listUserTablesForWeek(store: Store, weekId: string): UserTable[] {
  const prefix = `${weekId}:`;
  const out: UserTable[] = [];
  store.userTables.forEach((v, k) => {
    if (!k.startsWith(prefix)) return;
    const t = parseUserTable(v);
    if (t) out.push(t);
  });
  return out;
}

function getUserTable(
  store: Store,
  weekId: string,
  userId: string
): UserTable | null {
  return parseUserTable(store.userTables.get(tableKey(weekId, userId)));
}

// ---------- Public read API (unchanged shape) ----------

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

/** Legacy v1 structure JSON. Returned for migration use only. */
export function getStructure(store: Store): Week[] {
  const raw = store.structure.get("json");
  if (typeof raw !== "string") return [];
  try {
    return JSON.parse(raw) as Week[];
  } catch {
    return [];
  }
}

/** Build the full AppData from the v2 maps (with v1 fallback). */
export function buildAppData(store: Store): AppData {
  const users = getUsers(store);
  const v2Rows = listWeekMetaRows(store);

  let baseWeeks: Week[];
  if (v2Rows.length > 0) {
    baseWeeks = v2Rows.map((m) => ({
      id: m.id,
      weekNumber: m.weekNumber,
      startDate: m.startDate,
      endDate: m.endDate,
      tables: listUserTablesForWeek(store, m.id),
    }));
  } else {
    // Pre-migration fallback (first load on a fresh device before hydrate
    // runs, or a doc that's never been migrated yet).
    baseWeeks = getStructure(store);
  }

  // Splice cell values in. Doing this here rather than at write time keeps
  // cell edits CRDT-conflict-free. Also fall back to orphan keys whose slug
  // matches the column (legacy IDs from before recovery / deterministic IDs).
  const weeks: Week[] = baseWeeks.map((w) => ({
    ...w,
    tables: w.tables.map((t) => {
      const slugToColId = new Map(
        t.columns.map((c) => [slugify(c.name), c.id] as const)
      );
      const canonicalIds = new Set(t.columns.map((c) => c.id));
      const prefix = `${w.id}:${t.userId}:`;
      // Index orphan values for this table: day -> slug -> max value
      const orphanByDaySlug = new Map<string, Map<string, number>>();
      store.cells.forEach((v, k) => {
        if (!k.startsWith(prefix)) return;
        const parts = k.split(":");
        if (parts.length < 4) return;
        const day = parts[2];
        const colId = parts.slice(3).join(":");
        if (canonicalIds.has(colId)) return;
        const slug = slugFromColumnId(colId, t.userId, w.id);
        if (!slugToColId.has(slug)) return;
        if (!orphanByDaySlug.has(day)) orphanByDaySlug.set(day, new Map());
        const m = orphanByDaySlug.get(day)!;
        m.set(slug, Math.max(m.get(slug) ?? 0, v));
      });
      return {
        ...t,
        rows: t.rows.map((r) => ({
          day: r.day,
          values: Object.fromEntries(
            t.columns.map((c) => {
              const direct =
                store.cells.get(cellKey(w.id, t.userId, r.day, c.id)) ?? 0;
              const slug = slugify(c.name);
              const orphan = orphanByDaySlug.get(r.day)?.get(slug) ?? 0;
              return [c.id, Math.max(direct, orphan)];
            })
          ),
        })),
      };
    }),
  }));
  return { users, weeks };
}

// ---------- Cell mutator ----------

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

// ---------- Per-user-table mutators (v2, granular) ----------

/**
 * Apply a pure transformation to a single user's table. Only that table's
 * Yjs key is rewritten, so two devices editing different (week, user)
 * tables — or even the same user across different weeks — merge cleanly.
 */
function mutateUserTable(
  store: Store,
  weekId: string,
  userId: string,
  fn: (t: UserTable) => UserTable
): void {
  const cur = getUserTable(store, weekId, userId);
  if (!cur) return;
  const next = fn(cur);
  writeUserTable(store, weekId, next);
}

export function addColumn(
  store: Store,
  weekId: string,
  userId: string,
  col: ColumnDef
): void {
  mutateUserTable(store, weekId, userId, (t) => ({
    ...t,
    columns: [...t.columns, col],
    rows: t.rows.map((r) => ({
      ...r,
      values: { ...r.values, [col.id]: 0 },
    })),
  }));
}

export function deleteColumn(
  store: Store,
  weekId: string,
  userId: string,
  columnId: string
): void {
  mutateUserTable(store, weekId, userId, (t) => ({
    ...t,
    columns: t.columns.filter((c) => c.id !== columnId),
    rows: t.rows.map((r) => {
      const { [columnId]: _, ...rest } = r.values;
      return { ...r, values: rest };
    }),
  }));
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
  mutateUserTable(store, weekId, userId, (t) => {
    const cols = [...t.columns];
    const fromIdx = cols.findIndex((c) => c.id === fromId);
    const toIdx = cols.findIndex((c) => c.id === toId);
    if (fromIdx < 0 || toIdx < 0) return t;
    const [moved] = cols.splice(fromIdx, 1);
    cols.splice(toIdx, 0, moved);
    return { ...t, columns: cols };
  });
}

export function updateColumn(
  store: Store,
  weekId: string,
  userId: string,
  columnId: string,
  patch: Partial<ColumnDef>
): void {
  mutateUserTable(store, weekId, userId, (t) => ({
    ...t,
    columns: t.columns.map((c) =>
      c.id !== columnId ? c : { ...c, ...patch }
    ),
  }));
}

export function deleteUserTableFromWeek(
  store: Store,
  weekId: string,
  userId: string
): void {
  store.userTables.delete(tableKey(weekId, userId));
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
  // Idempotent: if the table already exists, leave it alone instead of
  // wiping its columns. This guards against double-tap and concurrent
  // "Add my table" presses across devices.
  if (store.userTables.has(tableKey(weekId, user.id))) return;
  const fresh: UserTable = {
    userId: user.id,
    userName: user.name,
    columns: [],
    rows: DAYS.map((day) => ({ day, values: {} })),
  };
  writeUserTable(store, weekId, fresh);
}

// ---------- Week creation ----------

function fmtISO(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate()
  ).padStart(2, "0")}`;
}

/**
 * Clone a table into a new week: deterministic per-(week,user,slug) IDs and
 * de-duplicated columns. Because IDs are derived purely from the name, two
 * devices cloning the same source week compute identical IDs and converge
 * instead of fragmenting. Duplicate source slugs collapse into one column.
 */
function cloneTableForWeek(weekId: string, table: UserTable): UserTable {
  const columns: ColumnDef[] = [];
  const seen = new Set<string>();
  for (const c of table.columns) {
    const slug = slugify(c.name) || "col";
    if (seen.has(slug)) continue;
    seen.add(slug);
    columns.push({ ...c, id: `${table.userId}-${weekId}-${slug}` });
  }
  return {
    userId: table.userId,
    userName: table.userName,
    columns,
    rows: DAYS.map((day) => ({ day, values: {} })),
  };
}

/**
 * Add the next Saturday-anchored week after the chronologically last one.
 *
 * Idempotent by startDate: if a week with the computed next-start already
 * exists in the store (because the other device beat us to it), we return
 * the existing one instead of creating a duplicate. This is what keeps
 * the auto-week-creation effect on multiple devices from racing.
 *
 * Each user's table is written to its own key, so concurrent calls from
 * two devices can never wipe one user's table out of the new week —
 * they'll merge per-user.
 */
export function addWeekAfterLast(store: Store): Week | null {
  const rows = listWeekMetaRows(store);
  if (rows.length === 0) return null;
  const last = rows[rows.length - 1];

  const lastStart = new Date(last.startDate + "T00:00:00");
  const newStart = new Date(lastStart);
  newStart.setDate(newStart.getDate() + 7);
  const newEnd = new Date(newStart);
  newEnd.setDate(newEnd.getDate() + 6);
  const startISO = fmtISO(newStart);
  const endISO = fmtISO(newEnd);

  // Idempotency: a week with this start date already exists? Return it.
  const existing = rows.find((r) => r.startDate === startISO);
  if (existing) {
    return {
      id: existing.id,
      weekNumber: existing.weekNumber,
      startDate: existing.startDate,
      endDate: existing.endDate,
      tables: listUserTablesForWeek(store, existing.id),
    };
  }

  const id = `week-${last.weekNumber + 1}`;
  const meta: WeekMetaRow = {
    id,
    weekNumber: last.weekNumber + 1,
    startDate: startISO,
    endDate: endISO,
  };

  // Clone last week's tables (one Yjs write per user table).
  const lastTables = listUserTablesForWeek(store, last.id);
  store.doc.transact(() => {
    writeWeekMeta(store, meta);
    for (const t of lastTables) {
      writeUserTable(store, id, cloneTableForWeek(id, t));
    }
  }, "addWeekAfterLast");

  return {
    id,
    weekNumber: meta.weekNumber,
    startDate: meta.startDate,
    endDate: meta.endDate,
    tables: listUserTablesForWeek(store, id),
  };
}

// ---------- Hydrate + migration + recovery ----------

const MIGRATION_FLAG = "structureMigratedV2";

/** First-launch seed. Writes directly to the v2 maps. */
export function hydrateSeedIfEmpty(store: Store): void {
  const { meta, weekMeta, userTables, cells, doc } = store;

  doc.transact(() => {
    if (!meta.has("users")) {
      meta.set("users", JSON.stringify(seed.users));
    }

    // If we have weekMeta entries, we're already populated.
    // If we have legacy structure but no v2 entries, migrate.
    // If we have nothing, seed.
    const hasV2 = weekMeta.size > 0;
    const legacy = getStructure(store);

    if (!hasV2 && legacy.length === 0) {
      // Pure first-launch — seed directly into v2.
      for (const w of seed.weeks as Week[]) {
        writeWeekMeta(store, {
          id: w.id,
          weekNumber: w.weekNumber,
          startDate: w.startDate,
          endDate: w.endDate,
        });
        for (const t of w.tables) {
          writeUserTable(store, w.id, t);
        }
        // Seed cells from the original (with values).
        for (const t of w.tables) {
          for (const r of t.rows) {
            for (const [colId, v] of Object.entries(r.values)) {
              const k = cellKey(w.id, t.userId, r.day, colId);
              if (!cells.has(k) && v) cells.set(k, v as number);
            }
          }
        }
      }
      meta.set(MIGRATION_FLAG, "1");
    } else if (!hasV2 && legacy.length > 0) {
      // Existing data on this doc but never migrated. Run migration.
      migrateLegacyStructureInto(store, legacy);
      meta.set(MIGRATION_FLAG, "1");
    } else if (hasV2 && !meta.get(MIGRATION_FLAG)) {
      // Someone else's device migrated, set the flag locally too.
      meta.set(MIGRATION_FLAG, "1");
    }
  }, "hydrate-and-migrate");

  // NOTE: We deliberately do NOT auto-run table recovery here. Recovery
  // reconstructs columns/values and must only run against a fully-synced doc,
  // under explicit user control (Settings → "Scan & restore"). Running it
  // automatically on every load — especially before sync completed — is what
  // corrupted data previously.
}

/** Copy the legacy monolithic structure into the granular v2 maps. */
function migrateLegacyStructureInto(store: Store, weeks: Week[]): void {
  for (const w of weeks) {
    writeWeekMeta(store, {
      id: w.id,
      weekNumber: w.weekNumber,
      startDate: w.startDate,
      endDate: w.endDate,
    });
    for (const t of w.tables) {
      // Only write if there isn't already a v2 entry (another device might
      // have migrated first and synced their version).
      if (!store.userTables.has(tableKey(w.id, t.userId))) {
        writeUserTable(store, w.id, t);
      }
    }
  }
  console.info(
    `[migrate] copied ${weeks.length} legacy weeks into the granular v2 store.`
  );
}

export interface RecoveryReport {
  /** (weekId, userId) pairs that had cell data but no table, now restored. */
  restored: Array<{
    weekId: string;
    userId: string;
    weekStartDate: string;
    columns: number;
  }>;
  /** Pairs we tried but couldn't restore (no template anywhere). */
  unrecoverable: Array<{ weekId: string; userId: string }>;
}

/**
 * Walk the cells map looking for (weekId, userId) pairs whose UserTable
 * is missing. For each, rebuild a UserTable using:
 *   - column IDs extracted directly from cell keys (so existing cell
 *     values are preserved — they're keyed on these IDs);
 *   - column metadata (name/type/weight) cloned from the most recent
 *     week where the same userId has a table with the same slug.
 *
 * Safe to re-run: tables that already exist are never touched.
 */
export function recoverMissingTables(store: Store): RecoveryReport {
  const report: RecoveryReport = { restored: [], unrecoverable: [] };
  const v2Rows = listWeekMetaRows(store);
  if (v2Rows.length === 0) return report;

  // Index: { (weekId,userId) -> Set<columnId> } discovered from cells map.
  const discovered = new Map<string, Set<string>>();
  for (const k of Array.from(store.cells.keys())) {
    const parts = k.split(":");
    if (parts.length < 4) continue;
    const [weekId, userId, , columnId] = parts;
    const key = `${weekId}:${userId}`;
    if (!discovered.has(key)) discovered.set(key, new Set());
    discovered.get(key)!.add(columnId);
  }

  // Build a per-user template index: for each user, a slug -> ColumnDef
  // taken from their most recent (latest startDate) existing table.
  const usersInData = new Set<string>();
  for (const row of v2Rows) {
    for (const t of listUserTablesForWeek(store, row.id)) {
      usersInData.add(t.userId);
    }
  }
  // Also include users discovered via cells (in case a user has NO surviving
  // table anywhere).
  for (const key of discovered.keys()) {
    const [, userId] = key.split(":");
    usersInData.add(userId);
  }

  const templateFor = (userId: string): Map<string, ColumnDef> => {
    const slugMap = new Map<string, ColumnDef>();
    // Walk weeks newest -> oldest so newer column defs win.
    for (let i = v2Rows.length - 1; i >= 0; i--) {
      const t = getUserTable(store, v2Rows[i].id, userId);
      if (!t) continue;
      for (const c of t.columns) {
        const slug = c.name.toLowerCase().replace(/\s+/g, "_");
        if (!slugMap.has(slug)) slugMap.set(slug, c);
      }
    }
    return slugMap;
  };

  // Fall back to seed.json for users who have ZERO tables anywhere — we can
  // pull their original column metadata that way.
  const seedTemplateFor = (userId: string): Map<string, ColumnDef> => {
    const slugMap = new Map<string, ColumnDef>();
    for (const w of seed.weeks as Week[]) {
      const t = w.tables.find((tt) => tt.userId === userId);
      if (!t) continue;
      for (const c of t.columns) {
        const slug = c.name.toLowerCase().replace(/\s+/g, "_");
        if (!slugMap.has(slug)) slugMap.set(slug, c);
      }
    }
    return slugMap;
  };

  // Resolve missing tables.
  for (const userId of usersInData) {
    const templ = templateFor(userId);
    const seedTempl = seedTemplateFor(userId);
    const users = getUsers(store);
    const userName =
      users.find((u) => u.id === userId)?.name ??
      // best-effort capitalisation if we don't even have user record
      userId.charAt(0).toUpperCase() + userId.slice(1);

    for (const row of v2Rows) {
      const haveTable = !!getUserTable(store, row.id, userId);
      if (haveTable) continue;

      const colIds = discovered.get(`${row.id}:${userId}`);
      if (!colIds || colIds.size === 0) {
        // No cells for this user this week — nothing to restore.
        continue;
      }

      // Build columns from the discovered IDs.
      const columns: ColumnDef[] = [];
      for (const colId of colIds) {
        // Convention: `${userId}-${weekId}-${idx}-${slug}` (idx is optional
        // — older IDs were `${userId}-${weekId}-${slug}`).
        const slug = colId
          .replace(new RegExp(`^${userId}-${row.id}-`), "")
          .replace(/^\d+-/, "");
        const tpl = templ.get(slug) ?? seedTempl.get(slug);
        const name = tpl?.name ?? humanise(slug);
        const type = tpl?.type ?? "hours";
        const weight = tpl?.weight ?? 0;
        columns.push({ id: colId, name, type, weight });
      }
      // Stable ordering: match the template's order where possible, then
      // alphabetical for anything new.
      const order = new Map<string, number>();
      let i = 0;
      for (const slug of templ.keys()) order.set(slug, i++);
      for (const slug of seedTempl.keys())
        if (!order.has(slug)) order.set(slug, i++);
      columns.sort((a, b) => {
        const sa = a.name.toLowerCase().replace(/\s+/g, "_");
        const sb = b.name.toLowerCase().replace(/\s+/g, "_");
        const ra = order.get(sa) ?? 9_999;
        const rb = order.get(sb) ?? 9_999;
        if (ra !== rb) return ra - rb;
        return a.name.localeCompare(b.name);
      });

      if (columns.length === 0) {
        report.unrecoverable.push({ weekId: row.id, userId });
        continue;
      }

      const restored: UserTable = {
        userId,
        userName,
        columns,
        rows: DAYS.map((day) => ({ day, values: {} })),
      };
      writeUserTable(store, row.id, restored);
      report.restored.push({
        weekId: row.id,
        userId,
        weekStartDate: row.startDate,
        columns: columns.length,
      });
    }
  }

  if (report.restored.length > 0) {
    console.info(
      `[recover] restored ${report.restored.length} missing table(s):`,
      report.restored
    );
  }
  if (report.unrecoverable.length > 0) {
    console.warn(
      `[recover] ${report.unrecoverable.length} (week,user) pair(s) had no cells to rebuild from`,
      report.unrecoverable
    );
  }
  return report;
}

function humanise(slug: string): string {
  return slug
    .split("_")
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
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

/**
 * Move cell values keyed under legacy column IDs into the canonical column IDs
 * declared in the current userTables. Safe to re-run; uses MAX when both exist.
 * Runs after a successful websocket sync so other devices see the same keys.
 */
export function reconcileOrphanCells(store: Store): number {
  let moved = 0;
  const rows = listWeekMetaRows(store);
  store.doc.transact(() => {
    for (const w of rows) {
      for (const t of listUserTablesForWeek(store, w.id)) {
        const slugToColId = new Map(
          t.columns.map((c) => [slugify(c.name), c.id] as const)
        );
        const canonicalIds = new Set(t.columns.map((c) => c.id));
        const prefix = `${w.id}:${t.userId}:`;
        const toDelete: string[] = [];
        store.cells.forEach((v, k) => {
          if (!k.startsWith(prefix)) return;
          const parts = k.split(":");
          if (parts.length < 4) return;
          const day = parts[2];
          const colId = parts.slice(3).join(":");
          if (canonicalIds.has(colId)) return;
          const slug = slugFromColumnId(colId, t.userId, w.id);
          const canonical = slugToColId.get(slug);
          if (!canonical) return;
          const ck = cellKey(w.id, t.userId, day, canonical);
          const cur = store.cells.get(ck) ?? 0;
          store.cells.set(ck, Math.max(cur, v));
          toDelete.push(k);
          moved++;
        });
        for (const k of toDelete) store.cells.delete(k);
      }
    }
  }, "reconcileOrphanCells");
  if (moved > 0) {
    console.info(`[sync] reconciled ${moved} orphan cell key(s) to canonical column IDs`);
  }
  return moved;
}

export interface LocalImportReport {
  rooms: Array<{
    room: string;
    cells: number;
    tables: number;
    weeks: number;
    notes: number;
    plans: number;
  }>;
  totalCells: number;
  totalTables: number;
  totalWeeks: number;
  totalNotes: number;
  totalPlans: number;
  reconciled: number;
}

const LOCAL_IMPORT_ROOMS = [
  // Original fallback when VITE_ROOM was missing in a stale bundle.
  "reaching-unreal-default",
  // Suggested example room from DEPLOY.md / older local testing.
  "elshazly-and-elsayed",
  // Common typo/variant users may have opened locally.
  "elshazly-and-elsayed-2026",
];

function waitForIndexedDb(p: IndexeddbPersistence): Promise<void> {
  return new Promise((resolve) => {
    if (p.synced) resolve();
    else p.once("synced", () => resolve());
  });
}

function mergeImportedTable(
  store: Store,
  weekId: string,
  incoming: UserTable
): boolean {
  const existing = getUserTable(store, weekId, incoming.userId);
  if (!existing) {
    writeUserTable(store, weekId, incoming);
    return true;
  }

  const existingSlugs = new Set(existing.columns.map((c) => slugify(c.name)));
  const additions = incoming.columns.filter((c) => !existingSlugs.has(slugify(c.name)));
  if (additions.length === 0) return false;

  const columns = [...existing.columns];
  for (const c of additions) {
    columns.push({
      ...c,
      id: columnId(weekId, incoming.userId, c.name, columns),
    });
  }
  writeUserTable(store, weekId, {
    ...existing,
    columns,
    rows: DAYS.map((day) => ({ day, values: {} })),
  });
  return true;
}

function importLegacyStructure(store: Store, weeks: Week[]): {
  weeks: number;
  tables: number;
} {
  let weekCount = 0;
  let tableCount = 0;
  for (const w of weeks) {
    if (!store.weekMeta.has(w.id)) {
      writeWeekMeta(store, {
        id: w.id,
        weekNumber: w.weekNumber,
        startDate: w.startDate,
        endDate: w.endDate,
      });
      weekCount++;
    }
    for (const t of w.tables) {
      if (mergeImportedTable(store, w.id, t)) tableCount++;
    }
  }
  return { weeks: weekCount, tables: tableCount };
}

/**
 * Import positive cell values from older local IndexedDB rooms on this same
 * browser/device. This is the recovery path for "I can see the logs on my
 * phone, but nobody else can": the old/stale app may have written them into
 * `reaching-unreal-default` or another local-only room, so the current shared
 * room never saw them.
 *
 * Safe to run repeatedly. It only adds/raises positive cell values, imports
 * missing weeks/tables/columns, then reconciles legacy column IDs into the
 * current deterministic column IDs.
 */
export async function importLocalOfflineRooms(store: Store): Promise<LocalImportReport> {
  const report: LocalImportReport = {
    rooms: [],
    totalCells: 0,
    totalTables: 0,
    totalWeeks: 0,
    totalNotes: 0,
    totalPlans: 0,
    reconciled: 0,
  };

  const rooms = Array.from(new Set(LOCAL_IMPORT_ROOMS.filter((r) => r && r !== ROOM)));
  for (const room of rooms) {
    const tempDoc = new Y.Doc();
    const tempIdb = new IndexeddbPersistence(room, tempDoc);
    await waitForIndexedDb(tempIdb);

    const localWeekMeta = tempDoc.getMap<string>("weekMeta");
    const localUserTables = tempDoc.getMap<string>("userTables");
    const localStructure = tempDoc.getMap<unknown>("structure");
    const localCells = tempDoc.getMap<number>("cells");
    const localNotes = tempDoc.getMap<string>("notes");
    const localPlans = tempDoc.getMap<string>("plans");

    const roomReport = {
      room,
      cells: 0,
      tables: 0,
      weeks: 0,
      notes: 0,
      plans: 0,
    };

    store.doc.transact(() => {
      localWeekMeta.forEach((raw) => {
        const row = parseWeekMetaRow(raw);
        if (!row || store.weekMeta.has(row.id)) return;
        writeWeekMeta(store, row);
        roomReport.weeks++;
      });

      localUserTables.forEach((raw, key) => {
        const table = parseUserTable(raw);
        const [weekId] = key.split(":");
        if (!table || !weekId) return;
        if (mergeImportedTable(store, weekId, table)) roomReport.tables++;
      });

      const legacy = localStructure.get("json");
      if (typeof legacy === "string") {
        try {
          const imported = importLegacyStructure(store, JSON.parse(legacy) as Week[]);
          roomReport.weeks += imported.weeks;
          roomReport.tables += imported.tables;
        } catch {
          /* ignore corrupt local legacy structure */
        }
      }

      localCells.forEach((value, key) => {
        if (typeof value !== "number" || value <= 0) return;
        const current = store.cells.get(key) ?? 0;
        if (value <= current) return;
        store.cells.set(key, value);
        roomReport.cells++;
      });

      localNotes.forEach((value, key) => {
        if (typeof value !== "string" || !value) return;
        if (store.notes.get(key)) return;
        store.notes.set(key, value);
        roomReport.notes++;
      });

      localPlans.forEach((value, key) => {
        if (typeof value !== "string" || !value) return;
        if (store.plans.get(key)) return;
        store.plans.set(key, value);
        roomReport.plans++;
      });
    }, `importLocalOfflineRoom:${room}`);

    tempIdb.destroy();
    tempDoc.destroy();

    if (
      roomReport.cells ||
      roomReport.tables ||
      roomReport.weeks ||
      roomReport.notes ||
      roomReport.plans
    ) {
      report.rooms.push(roomReport);
      report.totalCells += roomReport.cells;
      report.totalTables += roomReport.tables;
      report.totalWeeks += roomReport.weeks;
      report.totalNotes += roomReport.notes;
      report.totalPlans += roomReport.plans;
    }
  }

  report.reconciled = reconcileOrphanCells(store);
  forceReconnect(store);
  return report;
}

export function forceReconnect(store: Store): void {
  const provider = store.provider;
  if (!provider) return;
  provider.disconnect();
  window.setTimeout(() => provider.connect(), 250);
}

/**
 * Keep the websocket alive and re-merge after iOS background / network drops.
 * Call once after the store is created (App mount).
 */
export function setupSyncLifecycle(store: Store): () => void {
  const provider = store.provider;
  if (!provider || typeof document === "undefined") return () => {};

  const nudge = () => {
    provider.connect();
  };

  const onSync = (isSynced: boolean) => {
    if (isSynced) reconcileOrphanCells(store);
  };

  const onVisible = () => {
    if (document.visibilityState === "visible") {
      nudge();
      if (provider.synced) reconcileOrphanCells(store);
    }
  };

  provider.on("sync", onSync);
  document.addEventListener("visibilitychange", onVisible);
  window.addEventListener("online", nudge);
  window.addEventListener("focus", nudge);

  return () => {
    provider.off("sync", onSync);
    document.removeEventListener("visibilitychange", onVisible);
    window.removeEventListener("online", nudge);
    window.removeEventListener("focus", nudge);
  };
}

export function subscribeAll(store: Store, cb: () => void): () => void {
  const handler = () => cb();
  store.meta.observeDeep(handler);
  store.weekMeta.observe(handler);
  store.userTables.observe(handler);
  store.cells.observe(handler);
  store.notes.observe(handler);
  store.plans.observe(handler);
  // Also observe legacy structure so consumers still react in the brief
  // window after a doc loads but before migration has run.
  store.structure.observeDeep(handler);
  return () => {
    store.meta.unobserveDeep(handler);
    store.weekMeta.unobserve(handler);
    store.userTables.unobserve(handler);
    store.cells.unobserve(handler);
    store.notes.unobserve(handler);
    store.plans.unobserve(handler);
    store.structure.unobserveDeep(handler);
  };
}

// ---------- Notes ----------

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

/**
 * Plans created before we switched to date-anchored ranges stored
 * `startWeekId`/`endWeekId` instead of `startDate`/`endDate`. Resolve the
 * dates from the current weeks on read so legacy data keeps working
 * without an explicit migration write.
 */
function resolveLegacyPlan(store: Store, raw: Plan): Plan {
  if (raw.startDate && raw.endDate) return raw;
  const rows = listWeekMetaRows(store);
  const start = raw.startWeekId
    ? rows.find((w) => w.id === raw.startWeekId)?.startDate
    : undefined;
  const end = raw.endWeekId
    ? rows.find((w) => w.id === raw.endWeekId)?.startDate
    : undefined;
  return {
    ...raw,
    startDate: start ?? raw.startDate ?? "",
    endDate: end ?? raw.endDate ?? "",
  };
}

export function getPlans(store: Store): Plan[] {
  const out: Plan[] = [];
  store.plans.forEach((raw) => {
    if (typeof raw !== "string") return;
    try {
      out.push(resolveLegacyPlan(store, JSON.parse(raw) as Plan));
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
    return resolveLegacyPlan(store, JSON.parse(raw) as Plan);
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
