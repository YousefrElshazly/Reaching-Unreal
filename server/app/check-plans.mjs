import assert from "node:assert/strict";
import { build } from "esbuild";

const storage = new Map();
globalThis.localStorage = {
  getItem: (key) => storage.get(key) ?? null,
  setItem: (key, value) => storage.set(key, value),
};
globalThis.window = { dispatchEvent() {} };

const result = await build({
  entryPoints: ["src/store/yjs.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  write: false,
  logLevel: "silent",
});
const { upsertPlan, getPlans, updatePlan, addGoalToPlan, updateGoal, deletePlan } = await import(
  `data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`
);
const totalsBuild = await build({
  entryPoints: ["src/utils/planGoalTotals.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  write: false,
  logLevel: "silent",
});
const { goalProgress } = await import(
  `data:text/javascript;base64,${Buffer.from(totalsBuild.outputFiles[0].text).toString("base64")}`
);
const store = { plans: new Map() };
const plan = {
  id: "test-plan",
  name: "Test",
  userId: "me",
  private: true,
  startDate: "2026-10-03",
  endDate: "2026-10-03",
  goals: [],
  createdAt: 1,
};

upsertPlan(store, plan);
assert.equal(store.plans.has(plan.id), false);
assert.equal(getPlans(store)[0].name, "Test");
addGoalToPlan(store, plan.id, { tag: "Writing", target: 5, details: "# Big title\n\n- First step" });
const goalId = getPlans(store)[0].goals[0].id;
assert.equal(getPlans(store)[0].goals[0].details, "# Big title\n\n- First step");
updateGoal(store, plan.id, goalId, { details: "# Revised\n- Next step" });
assert.equal(getPlans(store)[0].goals[0].details, "# Revised\n- Next step");
const weeks = [{ tables: [{
  userId: "me",
  columns: [
    { id: "a", name: "Reading", type: "hours" },
    { id: "b", name: "Meetings", type: "hours" },
    { id: "c", name: "Workout", type: "boolean" },
  ],
  rows: [{ values: { a: 2, b: 3, c: 1 } }],
}] }];
assert.equal(goalProgress(weeks, "me", { tag: "Workout", target: 2 }).total, 1);
const buckets = {
  freeWill: { target: 4, sources: ["Reading", "Workout"] },
  scheduled: { target: 2, sources: ["Meetings", "Reading"] },
};
const progress = goalProgress(weeks, "me", { tag: "Writing", target: 6, buckets });
assert.deepEqual(
  [progress.freeWillTotal, progress.scheduledTotal, progress.satisfaction],
  [2, 3, 67]
);
updateGoal(store, plan.id, goalId, { target: 6, sources: ["Reading", "Meetings"], buckets });
assert.deepEqual(getPlans(store)[0].goals[0].buckets, buckets);
updatePlan(store, plan.id, { archived: true });
assert.equal(getPlans(store)[0].archived, true);
updatePlan(store, plan.id, { private: false });
assert.equal(store.plans.has(plan.id), true);
assert.equal(getPlans(store)[0].goals[0].details, "# Revised\n- Next step");
assert.deepEqual(getPlans(store)[0].goals[0].buckets, buckets);
assert.equal(storage.get("reaching-unreal:private-plans"), "{}");
deletePlan(store, plan.id);
assert.equal(getPlans(store).length, 0);
console.log("Plan privacy, archive, and hour buckets check passed");
