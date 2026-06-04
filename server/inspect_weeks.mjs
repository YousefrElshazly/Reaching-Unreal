import fs from "node:fs";
const dump = JSON.parse(fs.readFileSync("/tmp/ru_dump.json", "utf8"));

// Distinct (weekId,userId) present in cells + sanity on stray weekIds.
const knownWeeks = new Set(Object.values(dump.weekMeta).filter(Boolean).map((w) => w.id));
const strayWeekIds = new Set();
const byWU = {};
for (const [k, v] of Object.entries(dump.cells)) {
  const p = k.split(":");
  if (p.length < 4) continue;
  const [weekId, userId] = p;
  if (!knownWeeks.has(weekId)) strayWeekIds.add(weekId);
  const wu = `${weekId}:${userId}`;
  (byWU[wu] ||= []).push([p.slice(3).join(":"), v]);
}
console.log("stray weekIds in cells (not in weekMeta):", [...strayWeekIds]);
console.log("distinct userIds in cells:", [
  ...new Set(Object.keys(dump.cells).map((k) => k.split(":")[1])),
]);

// Legacy column names per user (to know each person's typical columns).
const legacyCols = {};
for (const w of dump.legacyStructure || []) {
  for (const t of w.tables || []) {
    for (const c of t.columns || []) {
      (legacyCols[t.userId] ||= new Map()).set(
        c.name.toLowerCase(),
        c.weight
      );
    }
  }
}
for (const [u, m] of Object.entries(legacyCols)) {
  console.log(`\nlegacy distinct columns for ${u} (${m.size}):`);
  console.log([...m.entries()].map(([n, w]) => `${n}=${w}`).join(", "));
}

// Detailed look at the suspicious weeks.
for (const wid of ["week-5", "week-8", "week-13", "week-14", "week-15", "week-16", "week-17"]) {
  console.log(`\n===== ${wid} =====`);
  for (const u of ["shazly", "sayed"]) {
    const cells = byWU[`${wid}:${u}`] || [];
    const cols = new Map();
    for (const [colId, v] of cells) {
      cols.set(colId, (cols.get(colId) || 0) + (v ? 1 : 0));
    }
    const v2 = dump.userTables[`${wid}:${u}`];
    const v2cols = v2 ? v2.columns.map((c) => `${c.name}=${c.weight}`).join(", ") : "(no v2 table)";
    console.log(` ${u}: ${cells.length} cell entries across ${cols.size} columns`);
    if (cols.size) {
      for (const [colId, nz] of cols)
        console.log(`    ${colId}  (${nz} nonzero)`);
    }
    console.log(`    v2 columns: ${v2cols}`);
  }
}
