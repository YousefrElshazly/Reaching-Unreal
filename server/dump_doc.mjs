/**
 * READ-ONLY diagnostic. Connects to the live sync server, downloads the full
 * Yjs doc for the room, and writes a JSON snapshot to /tmp/ru_dump.json.
 * Does not mutate the doc.
 */
import WebSocket from "ws";
import * as Y from "yjs";
import * as syncProtocol from "y-protocols/sync.js";
import * as encoding from "lib0/encoding.js";
import * as decoding from "lib0/decoding.js";
import fs from "node:fs";

const URL = process.env.RU_WS || "wss://reaching-unreal-sync.onrender.com";
const ROOM = process.env.RU_ROOM || "shazly-sayed-2026";
const OUT = process.env.RU_OUT || "/tmp/ru_dump.json";

const MESSAGE_SYNC = 0;

const doc = new Y.Doc();
const ws = new WebSocket(`${URL}/${ROOM}`);
ws.binaryType = "arraybuffer";

let lastUpdate = Date.now();
let gotStep2 = false;

doc.on("update", () => {
  lastUpdate = Date.now();
});

function send(enc) {
  const msg = encoding.toUint8Array(enc);
  if (msg.length > 1) ws.send(msg);
}

ws.on("open", () => {
  console.error(`[dump] connected to ${URL}/${ROOM}; requesting state…`);
  const enc = encoding.createEncoder();
  encoding.writeVarUint(enc, MESSAGE_SYNC);
  syncProtocol.writeSyncStep1(enc, doc);
  send(enc);
});

ws.on("message", (data) => {
  const buf = data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  const dec = decoding.createDecoder(buf);
  const messageType = decoding.readVarUint(dec);
  if (messageType !== MESSAGE_SYNC) return; // ignore awareness
  const enc = encoding.createEncoder();
  encoding.writeVarUint(enc, MESSAGE_SYNC);
  const syncType = syncProtocol.readSyncMessage(dec, enc, doc, null);
  if (syncType === syncProtocol.messageYjsSyncStep2) gotStep2 = true;
  lastUpdate = Date.now();
  send(enc);
});

ws.on("error", (e) => {
  console.error("[dump] ws error:", e.message);
});

// Settle detector: once we've gotten step2 and no updates for 2.5s, dump.
const startedAt = Date.now();
const timer = setInterval(() => {
  const idleMs = Date.now() - lastUpdate;
  const elapsed = Date.now() - startedAt;
  if ((gotStep2 && idleMs > 2500) || elapsed > 60000) {
    clearInterval(timer);
    dumpAndExit();
  }
}, 500);

function dumpAndExit() {
  const meta = doc.getMap("meta");
  const structure = doc.getMap("structure");
  const weekMeta = doc.getMap("weekMeta");
  const userTables = doc.getMap("userTables");
  const cells = doc.getMap("cells");
  const notes = doc.getMap("notes");
  const plans = doc.getMap("plans");

  const out = {
    fetchedAt: new Date().toISOString(),
    room: ROOM,
    meta: {
      users: safeParse(meta.get("users")),
      calendarId: meta.get("calendarId") ?? null,
      structureMigratedV2: meta.get("structureMigratedV2") ?? null,
    },
    legacyStructure: safeParse(structure.get("json")),
    weekMeta: mapToObj(weekMeta, true),
    userTables: mapToObj(userTables, true),
    notesKeys: Array.from(notes.keys()),
    plansKeys: Array.from(plans.keys()),
    cells: cellsToObj(cells),
    counts: {
      weekMeta: weekMeta.size,
      userTables: userTables.size,
      cells: cells.size,
      notes: notes.size,
      plans: plans.size,
    },
  };

  fs.writeFileSync(OUT, JSON.stringify(out, null, 2));
  console.error(`[dump] wrote ${OUT}`);
  console.error("[dump] counts:", JSON.stringify(out.counts));
  console.error(
    "[dump] legacyStructure weeks:",
    Array.isArray(out.legacyStructure) ? out.legacyStructure.length : "(none)"
  );
  ws.close();
  process.exit(0);
}

function safeParse(v) {
  if (typeof v !== "string") return null;
  try {
    return JSON.parse(v);
  } catch {
    return { __unparseable: v.slice(0, 200) };
  }
}

function mapToObj(m, parse) {
  const o = {};
  m.forEach((v, k) => {
    o[k] = parse ? safeParse(v) : v;
  });
  return o;
}

function cellsToObj(m) {
  const o = {};
  m.forEach((v, k) => {
    o[k] = v;
  });
  return o;
}
