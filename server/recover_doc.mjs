/**
 * Authoritative recovery for the Reaching Unreal shared doc.
 *
 * Problem recap (see analyze_dump.mjs): the monolithic `structure` key was
 * last-write-wins, so column definitions split-brained away from the `cells`
 * map, and repeated column-ID regeneration fragmented a single logical column
 * (e.g. "P") across several IDs. The logged VALUES in `cells` are intact; the
 * column DEFINITIONS and their grouping are what's broken.
 *
 * This script:
 *   1. Downloads the live doc.
 *   2. Builds a best-known column template per user (name/type/weight) from the
 *      legacy structure + seed.json, preferring non-zero weights.
 *   3. For every (week,user): groups that user's cells by logical slug,
 *      coalesces duplicate IDs (MAX per day so nothing is lost and booleans
 *      aren't double-counted), and emits ONE clean column per slug with a
 *      deterministic ID `${userId}-${weekId}-${slug}` and the template's
 *      name/type/weight.
 *   4. Writes a dry-run proposal to /tmp/ru_clean.json with before/after
 *      validation. With `--apply`, backs up the raw doc then writes the clean
 *      weekMeta + userTables + rewritten cells (and mirrors a clean
 *      structure.json for the server's notifications) to the live doc.
 *
 * Usage:
 *   node recover_doc.mjs            # dry run -> /tmp/ru_clean.json
 *   node recover_doc.mjs --apply    # back up + write to the live doc
 */
import WebSocket from "ws";
import * as Y from "yjs";
import * as syncProtocol from "y-protocols/sync.js";
import * as encoding from "lib0/encoding.js";
import * as decoding from "lib0/decoding.js";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const URL = process.env.RU_WS || "wss://reaching-unreal-sync.onrender.com";
const ROOM = process.env.RU_ROOM || "shazly-sayed-2026";
const APPLY = process.argv.includes("--apply");
const MESSAGE_SYNC = 0;
const DAYS = ["Saturday", "Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday"];
const USERS = ["shazly", "sayed"];

const seed = JSON.parse(
  fs.readFileSync(path.join(__dirname, "../app/src/data/seed.json"), "utf8")
);

const doc = new Y.Doc();
const ws = new WebSocket(`${URL}/${ROOM}`);
ws.binaryType = "arraybuffer";
let lastUpdate = Date.now();
let gotStep2 = false;
let phase = "download"; // download -> done

doc.on("update", (update, origin) => {
  lastUpdate = Date.now();
  // Forward local recovery writes to the server.
  if (origin !== ws && phase === "applying") {
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, MESSAGE_SYNC);
    syncProtocol.writeUpdate(enc, update);
    ws.send(encoding.toUint8Array(enc));
  }
});

ws.on("open", () => {
  const enc = encoding.createEncoder();
  encoding.writeVarUint(enc, MESSAGE_SYNC);
  syncProtocol.writeSyncStep1(enc, doc);
  ws.send(encoding.toUint8Array(enc));
});
ws.on("message", (data) => {
  const buf = data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  const dec = decoding.createDecoder(buf);
  if (decoding.readVarUint(dec) !== MESSAGE_SYNC) return;
  const enc = encoding.createEncoder();
  encoding.writeVarUint(enc, MESSAGE_SYNC);
  const t = syncProtocol.readSyncMessage(dec, enc, doc, ws);
  if (t === syncProtocol.messageYjsSyncStep2) gotStep2 = true;
  lastUpdate = Date.now();
  if (encoding.length(enc) > 1) ws.send(encoding.toUint8Array(enc));
});
ws.on("error", (e) => console.error("[recover] ws error:", e.message));

const timer = setInterval(() => {
  if (phase !== "download") return;
  if (gotStep2 && Date.now() - lastUpdate > 2500) {
    clearInterval(timer);
    run();
  } else if (Date.now() - lastUpdate > 60000) {
    clearInterval(timer);
    console.error("[recover] timed out waiting for sync");
    process.exit(1);
  }
}, 500);

// ---------- helpers ----------
const slugify = (name) =>
  String(name).toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 32);

function safeParse(v) {
  if (typeof v !== "string") return null;
  try {
    return JSON.parse(v);
  } catch {
    return null;
  }
}

// Extract the logical slug from a (possibly fragmented) column ID.
// IDs seen in the wild:
//   shazly-8-p                         (seed: user-weeknum-slug)
//   shazly-week-13-rbs                 (user-weekid-slug)
//   shazly-week-16-5-business_brainstorm   (user-weekid-idx-slug)
//   shazly-week-16-mpp5w29i-admin_tasks    (user-weekid-tsid-slug)
function slugOfColumnId(colId, userId, weekId) {
  let rest = colId;
  if (rest.startsWith(`${userId}-`)) rest = rest.slice(userId.length + 1);
  // strip weekId forms: "week-16-" or "16-"
  const wkNum = weekId.replace(/^week-/, "");
  if (rest.startsWith(`week-${wkNum}-`)) rest = rest.slice(`week-${wkNum}-`.length);
  else if (rest.startsWith(`${wkNum}-`)) rest = rest.slice(`${wkNum}-`.length);
  // After the user+week prefixes, the remainder is either `slug` or
  // `<idx-or-tsid>-slug`. Strip only a LEADING index/timestamp segment, so
  // hyphenated names (e.g. "anti-scrolling", whose old ID kept the hyphen
  // because the clone code only replaced spaces) survive intact.
  const dash = rest.indexOf("-");
  if (dash > 0) {
    const head = rest.slice(0, dash);
    const isIndex = /^\d+$/.test(head);
    // Date.now().toString(36) in the 2026 era is 8 chars starting with "m".
    const isTimestamp = /^[0-9a-z]{7,10}$/.test(head) && (/\d/.test(head) || /^m[a-z0-9]{7}$/.test(head));
    if (isIndex || isTimestamp) rest = rest.slice(dash + 1);
  }
  return slugify(rest);
}

function buildTemplates() {
  // userId -> slug -> {name, type, weight, order}
  const t = { shazly: new Map(), sayed: new Map() };
  const consider = (userId, col, recencyRank) => {
    if (!t[userId]) t[userId] = new Map();
    const slug = slugify(col.name);
    if (!slug) return;
    const prev = t[userId].get(slug);
    const w = Number(col.weight) || 0;
    // Prefer a definition with a non-zero weight; otherwise prefer most recent.
    if (!prev || (w && !prev.weight) || (recencyRank > prev.order && (w || !prev.weight))) {
      t[userId].set(slug, {
        name: col.name,
        type: col.type === "boolean" ? "boolean" : "hours",
        weight: w || prev?.weight || 0,
        order: prev ? Math.min(prev.order, recencyRank) : recencyRank,
      });
    }
  };
  // Legacy structure (most authoritative for names/weights), then seed.
  const legacy = safeParse(doc.getMap("structure").get("json")) || [];
  legacy.forEach((w, i) => {
    for (const tab of w.tables || []) for (const c of tab.columns || []) consider(tab.userId, c, i + 100);
  });
  (seed.weeks || []).forEach((w, i) => {
    for (const tab of w.tables || []) for (const c of tab.columns || []) consider(tab.userId, c, i);
  });
  return t;
}

const BOOLEAN_HINTS = ["gym", "squash", "p", "wake", "sleep", "scroll", "scrolling", "screentime", "cardio", "shower", "anti", "cut", "hydration", "diet", "early", "cold"];
function guessType(slug) {
  return BOOLEAN_HINTS.some((h) => slug === h || slug.includes(h)) ? "boolean" : "hours";
}
function prettyName(slug) {
  return slug.split("_").filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1)).join(" ");
}

function run() {
  const weekMeta = doc.getMap("weekMeta");
  const userTables = doc.getMap("userTables");
  const cells = doc.getMap("cells");

  const rows = [];
  weekMeta.forEach((raw) => {
    const r = safeParse(raw);
    if (r) rows.push(r);
  });
  rows.sort((a, b) => String(a.startDate).localeCompare(String(b.startDate)));

  const templates = buildTemplates();

  // Gather cells grouped by week:user:slug:day with MAX coalescing.
  // grouped[`${w}:${u}`] = Map(slug -> { days: {day->val}, ids:Set, name })
  const grouped = {};
  let beforeNonZero = 0;
  cells.forEach((v, k) => {
    const p = k.split(":");
    if (p.length < 4) return;
    const [weekId, userId, day] = p;
    const colId = p.slice(3).join(":");
    if (!USERS.includes(userId)) return;
    const slug = slugOfColumnId(colId, userId, weekId);
    if (!slug) return;
    const gk = `${weekId}:${userId}`;
    (grouped[gk] ||= new Map());
    if (!grouped[gk].has(slug)) grouped[gk].set(slug, { days: {}, ids: new Set() });
    const g = grouped[gk].get(slug);
    g.ids.add(colId);
    const num = typeof v === "number" ? v : 0;
    if (num !== 0) beforeNonZero++;
    g.days[day] = Math.max(g.days[day] || 0, num); // MAX coalesce
  });

  // Build clean weeks.
  const cleanWeeks = [];
  const report = { recoveredTables: [], emptyTables: [], perWeek: [] };
  let afterNonZero = 0;
  let afterSum = 0;
  let beforeSum = 0;
  cells.forEach((v) => {
    if (typeof v === "number") beforeSum += v;
  });

  for (const m of rows) {
    const week = { id: m.id, weekNumber: m.weekNumber, startDate: m.startDate, endDate: m.endDate, tables: [] };
    for (const userId of USERS) {
      const userName = userId === "shazly" ? "El Shazly" : "El Sayed";
      const gk = `${m.id}:${userId}`;
      const g = grouped[gk];
      const tmpl = templates[userId] || new Map();

      if (g && g.size > 0) {
        const columns = [];
        const rowsByDay = Object.fromEntries(DAYS.map((d) => [d, {}]));
        // Order: template order if known, else by min embedded index, else alpha.
        const slugs = [...g.keys()].sort((a, b) => {
          const oa = tmpl.get(a)?.order ?? 9999;
          const ob = tmpl.get(b)?.order ?? 9999;
          if (oa !== ob) return oa - ob;
          return a.localeCompare(b);
        });
        for (const slug of slugs) {
          const def = tmpl.get(slug);
          const id = `${userId}-${m.id}-${slug}`;
          const col = {
            id,
            name: def?.name || prettyName(slug),
            type: def?.type || guessType(slug),
            weight: def?.weight || 10,
          };
          columns.push(col);
          for (const [day, val] of Object.entries(g.get(slug).days)) {
            if (val !== 0) {
              rowsByDay[day][id] = val;
              afterNonZero++;
              afterSum += val;
            }
          }
        }
        week.tables.push({
          userId,
          userName,
          columns,
          rows: DAYS.map((day) => ({ day, values: rowsByDay[day] })),
        });
        report.recoveredTables.push({ week: m.id, start: m.startDate, userId, columns: columns.length });
      } else {
        // No surviving cells. Create an empty table from the user's template so
        // the table at least EXISTS (data was lost upstream / never synced).
        const tmplSlugs = [...tmpl.entries()].sort((a, b) => a[1].order - b[1].order).slice(0, 11);
        const columns = tmplSlugs.map(([slug, def]) => ({
          id: `${userId}-${m.id}-${slug}`,
          name: def.name,
          type: def.type,
          weight: def.weight || 10,
        }));
        week.tables.push({
          userId,
          userName,
          columns,
          rows: DAYS.map((day) => ({ day, values: {} })),
        });
        report.emptyTables.push({ week: m.id, start: m.startDate, userId });
      }
    }
    cleanWeeks.push(week);
  }

  const validation = {
    beforeNonZero,
    afterNonZero,
    beforeSum: Math.round(beforeSum * 100) / 100,
    afterSum: Math.round(afterSum * 100) / 100,
    note: "afterNonZero may be <= beforeNonZero when duplicate IDs logged the same day/slug (coalesced by MAX). afterSum should be <= beforeSum for the same reason; it must never exceed it.",
    ok: afterSum <= beforeSum + 0.001,
  };

  fs.writeFileSync("/tmp/ru_clean.json", JSON.stringify({ cleanWeeks, report, validation }, null, 2));

  console.error("\n===== DRY-RUN SUMMARY =====");
  console.error("validation:", JSON.stringify(validation));
  console.error(`recovered tables (with data): ${report.recoveredTables.length}`);
  console.error(`empty tables (no surviving cells): ${report.emptyTables.length}`);
  for (const e of report.emptyTables) console.error(`   EMPTY ${e.week} ${e.userId} (${e.start})`);
  console.error("\nper (week,user) with data:");
  for (const r of report.recoveredTables) console.error(`   ${r.week} ${r.userId}: ${r.columns} cols (${r.start})`);
  console.error("\nFull proposal written to /tmp/ru_clean.json");

  if (!APPLY) {
    console.error("\nDRY RUN ONLY — no changes written. Re-run with --apply to commit.");
    ws.close();
    process.exit(0);
  }
  if (!validation.ok) {
    console.error("\nVALIDATION FAILED (afterSum > beforeSum). Aborting apply.");
    ws.close();
    process.exit(2);
  }

  // ----- APPLY -----
  const backup = Buffer.from(Y.encodeStateAsUpdate(doc));
  const backupFile = `/tmp/ru_backup_${Date.now()}.bin`;
  fs.writeFileSync(backupFile, backup);
  console.error(`\n[apply] backed up live doc (${backup.length} bytes) -> ${backupFile}`);

  // Pairs with no surviving cells are NOT written: fabricating an empty table
  // could overwrite (last-write-wins) a table that still exists, unsynced, on
  // another device — hiding its data. We leave them untouched so that data can
  // still flow in later, after which recovery can be re-run.
  const emptyKeys = new Set(report.emptyTables.map((e) => `${e.week}:${e.userId}`));

  phase = "applying";
  doc.transact(() => {
    const structure = doc.getMap("structure");
    for (const wk of cleanWeeks) {
      weekMeta.set(wk.id, JSON.stringify({ id: wk.id, weekNumber: wk.weekNumber, startDate: wk.startDate, endDate: wk.endDate }));
      for (const tab of wk.tables) {
        if (emptyKeys.has(`${wk.id}:${tab.userId}`)) continue;
        // userTable WITHOUT values (cells hold values)
        const sanitized = {
          userId: tab.userId,
          userName: tab.userName,
          columns: tab.columns,
          rows: DAYS.map((d) => ({ day: d, values: Object.fromEntries(tab.columns.map((c) => [c.id, 0])) })),
        };
        userTables.set(`${wk.id}:${tab.userId}`, JSON.stringify(sanitized));

        // Rewrite cells: delete all existing for this (week,user), then set canonical.
        const prefix = `${wk.id}:${tab.userId}:`;
        for (const key of Array.from(cells.keys())) {
          if (key.startsWith(prefix)) cells.delete(key);
        }
        for (const row of tab.rows) {
          for (const [colId, val] of Object.entries(row.values)) {
            if (val !== 0) cells.set(`${wk.id}:${tab.userId}:${row.day}:${colId}`, val);
          }
        }
      }
    }
    // Mirror a clean monolithic structure for the server's notification reader
    // and any legacy fallback. Values are zeroed (cells are the source).
    const mono = cleanWeeks.map((wk) => ({
      ...wk,
      tables: wk.tables
        .filter((t) => !emptyKeys.has(`${wk.id}:${t.userId}`))
        .map((t) => ({
          ...t,
          rows: DAYS.map((d) => ({ day: d, values: Object.fromEntries(t.columns.map((c) => [c.id, 0])) })),
        })),
    }));
    structure.set("json", JSON.stringify(mono));
    doc.getMap("meta").set("structureMigratedV2", "1");
  }, "recover");

  console.error("[apply] wrote clean state; flushing to server…");
  setTimeout(() => {
    console.error("[apply] done.");
    ws.close();
    process.exit(0);
  }, 6000);
}
