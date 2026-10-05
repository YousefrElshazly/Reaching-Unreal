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
updatePlan(store, plan.id, { archived: true });
assert.equal(getPlans(store)[0].archived, true);
updatePlan(store, plan.id, { private: false });
assert.equal(store.plans.has(plan.id), true);
assert.equal(getPlans(store)[0].goals[0].details, "# Revised\n- Next step");
assert.equal(storage.get("reaching-unreal:private-plans"), "{}");
deletePlan(store, plan.id);
assert.equal(getPlans(store).length, 0);
console.log("Plan privacy and archive check passed");
