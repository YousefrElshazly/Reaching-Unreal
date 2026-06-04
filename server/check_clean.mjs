import fs from "node:fs";
const { cleanWeeks } = JSON.parse(fs.readFileSync("/tmp/ru_clean.json", "utf8"));
for (const wid of ["week-16", "week-17"]) {
  const w = cleanWeeks.find((x) => x.id === wid);
  console.log(`\n===== ${wid} (${w.startDate}) =====`);
  for (const t of w.tables) {
    console.log(` ${t.userId}: ${t.columns.map((c) => `${c.name}[${c.type[0]},w${c.weight}]`).join(" | ")}`);
    for (const r of t.rows) {
      const vals = Object.entries(r.values);
      if (vals.length) console.log(`    ${r.day}: ${vals.map(([id, v]) => `${id.split("-").pop()}=${v}`).join(", ")}`);
    }
  }
}
