/**
 * READ-ONLY analysis of /tmp/ru_dump.json. Prints a per-week breakdown of
 * which user tables exist in (a) the frozen legacy monolith and (b) the v2
 * userTables map, plus which (week,user) pairs have real cell data. The goal
 * is to see exactly what got dropped/zeroed and what the best recovery source
 * is for each week.
 */
import fs from "node:fs";

const dump = JSON.parse(fs.readFileSync("/tmp/ru_dump.json", "utf8"));
const USERS = ["shazly", "sayed"];

// Weeks sorted by startDate, taken from weekMeta (fall back to legacy).
const weekMeta = dump.weekMeta || {};
let weeks = Object.values(weekMeta).filter(Boolean);
if (weeks.length === 0 && Array.isArray(dump.legacyStructure)) {
  weeks = dump.legacyStructure.map((w) => ({
    id: w.id,
    weekNumber: w.weekNumber,
    startDate: w.startDate,
    endDate: w.endDate,
  }));
}
weeks.sort((a, b) => String(a.startDate).localeCompare(String(b.startDate)));

// Index legacy structure tables by week.
const legacyByWeek = {};
if (Array.isArray(dump.legacyStructure)) {
  for (const w of dump.legacyStructure) {
    legacyByWeek[w.id] = {};
    for (const t of w.tables || []) legacyByWeek[w.id][t.userId] = t;
  }
}

// Cells: discover (week,user) -> Set(columnId) and count nonzero.
const cellsByWeekUser = {};
for (const [k, v] of Object.entries(dump.cells || {})) {
  const parts = k.split(":");
  if (parts.length < 4) continue;
  const [weekId, userId] = parts;
  const colId = parts.slice(3).join(":");
  const key = `${weekId}:${userId}`;
  if (!cellsByWeekUser[key]) cellsByWeekUser[key] = { cols: new Set(), nonzero: 0, total: 0 };
  cellsByWeekUser[key].cols.add(colId);
  cellsByWeekUser[key].total++;
  if (typeof v === "number" && v !== 0) cellsByWeekUser[key].nonzero++;
}

function weightSummary(table) {
  if (!table || !Array.isArray(table.columns)) return "—";
  const n = table.columns.length;
  const zero = table.columns.filter((c) => !c.weight).length;
  return `${n} cols, ${zero} zero-wt`;
}

console.log("users:", JSON.stringify(dump.meta.users?.map((u) => `${u.id}=${u.name}`)));
console.log("migratedV2:", dump.meta.structureMigratedV2, "| calendar:", dump.meta.calendarId);
console.log("counts:", JSON.stringify(dump.counts));
console.log("");
console.log(
  "WEEK".padEnd(10),
  "START".padEnd(11),
  "| v2 shazly".padEnd(22),
  "v2 sayed".padEnd(22),
  "| legacy shazly".padEnd(20),
  "legacy sayed".padEnd(20),
  "| cells s/y"
);

for (const w of weeks) {
  const v2s = dump.userTables[`${w.id}:shazly`];
  const v2y = dump.userTables[`${w.id}:sayed`];
  const ls = legacyByWeek[w.id]?.shazly;
  const ly = legacyByWeek[w.id]?.sayed;
  const cs = cellsByWeekUser[`${w.id}:shazly`];
  const cy = cellsByWeekUser[`${w.id}:sayed`];
  const cellStr = `${cs ? `${cs.cols.size}c/${cs.nonzero}nz` : "-"} ${cy ? `${cy.cols.size}c/${cy.nonzero}nz` : "-"}`;
  console.log(
    String(w.id).padEnd(10),
    String(w.startDate).padEnd(11),
    "|",
    weightSummary(v2s).padEnd(20),
    weightSummary(v2y).padEnd(20),
    "|",
    weightSummary(ls).padEnd(18),
    weightSummary(ly).padEnd(18),
    "|",
    cellStr
  );
}

// Flag the worrying cases.
console.log("\n--- ANOMALIES ---");
for (const w of weeks) {
  for (const u of USERS) {
    const v2 = dump.userTables[`${w.id}:${u}`];
    const legacy = legacyByWeek[w.id]?.[u];
    const cells = cellsByWeekUser[`${w.id}:${u}`];
    const hasCells = cells && cells.cols.size > 0;
    if (!v2 && hasCells) console.log(`MISSING v2 table but ${cells.nonzero}nz cells: ${w.id}:${u} (${w.startDate})`);
    if (v2 && Array.isArray(v2.columns)) {
      const zero = v2.columns.filter((c) => !c.weight).length;
      if (zero > 0 && v2.columns.length > 0)
        console.log(`ZERO-WEIGHT cols in v2: ${w.id}:${u} -> ${zero}/${v2.columns.length}`);
      if (v2.userId && v2.userId !== u)
        console.log(`OWNERSHIP MISMATCH: key ${w.id}:${u} but table.userId=${v2.userId}`);
    }
    // Column-id ownership check: do this user's cells reference another user's id prefix?
    if (hasCells) {
      for (const colId of cells.cols) {
        const owner = USERS.find((x) => colId.startsWith(`${x}-`));
        if (owner && owner !== u)
          console.log(`CELL COLUMN-ID belongs to ${owner} under ${u}: ${w.id}:${u} colId=${colId}`);
        break; // one example per pair is enough
      }
    }
  }
}
