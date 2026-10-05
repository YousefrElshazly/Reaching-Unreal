import assert from "node:assert/strict";

const base = process.argv[2] || "http://localhost:1234";
const health = await fetch(`${base}/healthz`);
assert.equal(health.status, 200);
assert.match(await health.text(), /Reaching Unreal sync OK/);

const page = await fetch(base);
assert.equal(page.status, 200);
assert.match(page.headers.get("content-type"), /text\/html/);
const html = await page.text();
const asset = html.match(/src="(\/assets\/[^\"]+\.js)"/)?.[1];
assert.ok(asset, "built app script is linked from the page");

const script = await fetch(new URL(asset, base));
assert.equal(script.status, 200);
assert.match(await script.text(), /View archive/);
assert.equal((await fetch(`${base}/assets/missing.js`)).status, 404);
console.log("App and sync server check passed");
