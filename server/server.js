/**
 * Minimal Yjs sync server — single file, zero config, durable-on-disk.
 *
 *  - Listens on PORT (default 1234) for /<roomname> websocket clients.
 *  - Bridges y-protocols sync + awareness messages between connected peers.
 *  - Keeps a Y.Doc per room in memory; periodically snapshots each room's
 *    state to ./data/<room>.bin so a redeploy/restart doesn't lose data.
 *
 * Used by the React app (y-websocket) to keep all of your devices in sync.
 */

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { WebSocketServer } from "ws";
import webpush from "web-push";
import * as Y from "yjs";
import * as syncProtocol from "y-protocols/sync.js";
import * as awarenessProtocol from "y-protocols/awareness.js";
import * as encoding from "lib0/encoding.js";
import * as decoding from "lib0/decoding.js";
import * as map from "lib0/map.js";

const PORT = Number(process.env.PORT || 1234);
const HOST = process.env.HOST || "0.0.0.0";
const DATA_DIR = process.env.DATA_DIR || path.resolve("./data");
const PERSIST_INTERVAL_MS = Number(process.env.PERSIST_INTERVAL_MS || 5_000);
const MAX_ROOM_NAME_LEN = 256;
const MAX_PAYLOAD = 16 * 1024 * 1024; // 16 MB safety ceiling per message

// Notifications config -------------------------------------------------------
const VAPID_PUBLIC = process.env.VAPID_PUBLIC_KEY || "";
const VAPID_PRIVATE = process.env.VAPID_PRIVATE_KEY || "";
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || "mailto:reaching-unreal@example.com";
const CRON_SECRET = process.env.CRON_SECRET || "";
// The wall-clock hour (0-23) at which to fire the "log your day" reminder, in
// each subscription's local timezone. Default 23 (= 11pm).
const REMINDER_HOUR = Number(process.env.REMINDER_HOUR || 23);
// Allowed origins for the HTTP API (subscribe / unsubscribe). The websocket
// upgrade is unaffected. Comma-separated list, or "*" to allow any.
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || "*")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

if (VAPID_PUBLIC && VAPID_PRIVATE) {
  webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC, VAPID_PRIVATE);
  console.log("[push] VAPID configured; reminders will fire at hour", REMINDER_HOUR);
} else {
  console.warn(
    "[push] VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY missing — /subscribe and /cron/tick will return 503"
  );
}

// Try to create the data directory. If we can't (e.g. ephemeral hosting like
// Render free tier), fall back to /tmp so the server still runs. Each client
// has the full Yjs history in IndexedDB, so even when the server's state is
// wiped on a restart the next reconnecting client uploads its full doc and
// the server is whole again.
let persistEnabled = true;
try {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  // Probe writability
  const probe = path.join(DATA_DIR, ".write-probe");
  fs.writeFileSync(probe, "ok");
  fs.unlinkSync(probe);
} catch (e) {
  console.warn(
    `[boot] DATA_DIR=${DATA_DIR} not writable (${e?.code ?? e?.message}); persistence disabled. ` +
      `Server still works — client IndexedDB acts as the durable store.`
  );
  persistEnabled = false;
}

// --- Per-room state ----------------------------------------------------------

const MESSAGE_SYNC = 0;
const MESSAGE_AWARENESS = 1;

class Room {
  constructor(name) {
    this.name = name;
    this.doc = new Y.Doc();
    this.awareness = new awarenessProtocol.Awareness(this.doc);
    this.awareness.setLocalState(null); // server isn't a participant
    this.conns = new Map(); // ws -> Set<clientID>
    this.dirty = false;

    // Restore from disk if we have a snapshot
    if (persistEnabled) {
      const snap = path.join(DATA_DIR, `${this.safeFile()}.bin`);
      try {
        if (fs.existsSync(snap)) {
          const buf = fs.readFileSync(snap);
          Y.applyUpdate(this.doc, new Uint8Array(buf));
          console.log(`[room ${name}] restored ${buf.length} bytes from disk`);
        }
      } catch (e) {
        console.warn(`[room ${name}] restore failed:`, e?.message ?? e);
      }
    }

    this.doc.on("update", (update, origin) => {
      this.dirty = true;
      const enc = encoding.createEncoder();
      encoding.writeVarUint(enc, MESSAGE_SYNC);
      syncProtocol.writeUpdate(enc, update);
      const msg = encoding.toUint8Array(enc);
      for (const ws of this.conns.keys()) {
        if (ws === origin) continue;
        sendBinary(ws, msg);
      }
    });

    this.awareness.on("update", ({ added, updated, removed }, origin) => {
      const changed = added.concat(updated, removed);
      const enc = encoding.createEncoder();
      encoding.writeVarUint(enc, MESSAGE_AWARENESS);
      encoding.writeVarUint8Array(
        enc,
        awarenessProtocol.encodeAwarenessUpdate(this.awareness, changed)
      );
      const msg = encoding.toUint8Array(enc);
      for (const ws of this.conns.keys()) {
        if (ws === origin) continue;
        sendBinary(ws, msg);
      }
    });
  }

  safeFile() {
    return this.name.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, MAX_ROOM_NAME_LEN);
  }

  persist() {
    if (!this.dirty || !persistEnabled) return;
    const update = Y.encodeStateAsUpdate(this.doc);
    const file = path.join(DATA_DIR, `${this.safeFile()}.bin`);
    try {
      fs.writeFileSync(file, Buffer.from(update));
      this.dirty = false;
    } catch (e) {
      console.warn(`[room ${this.name}] persist failed:`, e?.message ?? e);
    }
  }

  addConn(ws) {
    this.conns.set(ws, new Set());

    // Send sync step 1 to start exchange
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, MESSAGE_SYNC);
    syncProtocol.writeSyncStep1(enc, this.doc);
    sendBinary(ws, encoding.toUint8Array(enc));

    // Send full awareness state
    const awStates = this.awareness.getStates();
    if (awStates.size > 0) {
      const enc2 = encoding.createEncoder();
      encoding.writeVarUint(enc2, MESSAGE_AWARENESS);
      encoding.writeVarUint8Array(
        enc2,
        awarenessProtocol.encodeAwarenessUpdate(
          this.awareness,
          Array.from(awStates.keys())
        )
      );
      sendBinary(ws, encoding.toUint8Array(enc2));
    }
  }

  removeConn(ws) {
    const ids = this.conns.get(ws);
    this.conns.delete(ws);
    if (ids && ids.size > 0) {
      awarenessProtocol.removeAwarenessStates(
        this.awareness,
        Array.from(ids),
        null
      );
    }
  }

  handleMessage(ws, data) {
    try {
      const enc = encoding.createEncoder();
      const dec = decoding.createDecoder(data);
      const messageType = decoding.readVarUint(dec);
      switch (messageType) {
        case MESSAGE_SYNC: {
          encoding.writeVarUint(enc, MESSAGE_SYNC);
          syncProtocol.readSyncMessage(dec, enc, this.doc, ws);
          if (encoding.length(enc) > 1) {
            sendBinary(ws, encoding.toUint8Array(enc));
          }
          break;
        }
        case MESSAGE_AWARENESS: {
          const update = decoding.readVarUint8Array(dec);
          awarenessProtocol.applyAwarenessUpdate(this.awareness, update, ws);
          // Track which client IDs this connection has authored so we can
          // remove them on disconnect.
          const ids = this.conns.get(ws);
          if (ids) {
            const added = decodeAwarenessClientIds(update);
            for (const id of added) ids.add(id);
          }
          break;
        }
        default:
          // Unknown message; ignore.
          break;
      }
    } catch (e) {
      console.warn(`[room ${this.name}] bad message:`, e?.message ?? e);
    }
  }
}

function decodeAwarenessClientIds(update) {
  // The update is a varUint length followed by N (clientID, clock, state) entries.
  const dec = decoding.createDecoder(update);
  const len = decoding.readVarUint(dec);
  const ids = [];
  for (let i = 0; i < len; i++) {
    const clientID = decoding.readVarUint(dec);
    decoding.readVarUint(dec); // clock
    decoding.readVarString(dec); // state
    ids.push(clientID);
  }
  return ids;
}

function sendBinary(ws, data) {
  if (ws.readyState !== ws.OPEN) return;
  try {
    ws.send(data, { binary: true });
  } catch (e) {
    try {
      ws.close();
    } catch {}
  }
}

const rooms = new Map();
function getRoom(name) {
  return map.setIfUndefined(rooms, name, () => new Room(name));
}

// --- Push notifications -----------------------------------------------------

/**
 * subscriptions.json layout:
 *   [{ endpoint, keys, room, userId, timezone, lastNotifiedDate? }]
 *
 * Persisted alongside Yjs snapshots so it survives restarts on hosts with a
 * writable data dir. On ephemeral hosts (Render free tier without a disk) the
 * file is rewritten on every change but is lost on redeploy — devices will
 * just re-subscribe automatically when the user next opens the app and the
 * server replies that their endpoint is unknown.
 */
const SUBS_FILE = path.join(persistEnabled ? DATA_DIR : "/tmp", "subscriptions.json");
let subscriptions = [];
try {
  if (fs.existsSync(SUBS_FILE)) {
    subscriptions = JSON.parse(fs.readFileSync(SUBS_FILE, "utf8"));
    console.log(`[push] loaded ${subscriptions.length} subscription(s)`);
  }
} catch (e) {
  console.warn("[push] could not load subscriptions:", e?.message ?? e);
  subscriptions = [];
}

function saveSubscriptions() {
  try {
    fs.writeFileSync(SUBS_FILE, JSON.stringify(subscriptions));
  } catch (e) {
    console.warn("[push] could not save subscriptions:", e?.message ?? e);
  }
}

function isOriginAllowed(origin) {
  if (!origin) return true;
  if (ALLOWED_ORIGINS.includes("*")) return true;
  return ALLOWED_ORIGINS.includes(origin);
}

function applyCors(req, res) {
  const origin = req.headers.origin;
  if (origin && isOriginAllowed(origin)) {
    res.setHeader("access-control-allow-origin", origin);
    res.setHeader("access-control-allow-methods", "GET,POST,DELETE,OPTIONS");
    res.setHeader("access-control-allow-headers", "content-type,x-cron-secret");
    res.setHeader("access-control-max-age", "86400");
  }
}

function readJson(req, max = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let total = 0;
    const chunks = [];
    req.on("data", (c) => {
      total += c.length;
      if (total > max) {
        reject(new Error("payload too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      try {
        const raw = Buffer.concat(chunks).toString("utf8") || "{}";
        resolve(JSON.parse(raw));
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}

function isValidTimezone(tz) {
  if (typeof tz !== "string" || tz.length > 64) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/**
 * Returns true if the given user has zero (or no) values logged for "today" in
 * the active week of the supplied room. "Today" is computed in the supplied
 * IANA timezone. The lookup uses the live in-memory Y.Doc so server-side
 * checks always see the latest synced state from any device.
 */
function isTodayZeroForUser(roomName, userId, timezone) {
  const room = rooms.get(roomName);
  if (!room) return false; // can't decide → don't spam
  const structureRaw = room.doc.getMap("structure").get("json");
  if (typeof structureRaw !== "string") return false;
  let weeks;
  try {
    weeks = JSON.parse(structureRaw);
  } catch {
    return false;
  }
  if (!Array.isArray(weeks) || weeks.length === 0) return false;

  // Find the week whose Saturday-anchored window contains "today" in the user's
  // timezone. Falls back to the most recent week if "today" is past the last
  // logged week (the user simply hasn't created the new week yet).
  const todayStr = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date()); // "YYYY-MM-DD"

  let week = null;
  for (const w of weeks) {
    if (w.startDate <= todayStr && todayStr <= w.endDate) {
      week = w;
      break;
    }
  }
  if (!week) {
    // "today" is after the last logged week → the table doesn't even exist
    // yet for today, which counts as zeroed.
    const last = weeks[weeks.length - 1];
    if (todayStr > last.endDate) return true;
    return false;
  }

  const table = week.tables.find((t) => t.userId === userId);
  if (!table) return true; // user hasn't joined this week → zero

  // Day name from the day-of-week in the timezone
  const weekday = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    weekday: "long",
  }).format(new Date());

  const cells = room.doc.getMap("cells");
  for (const col of table.columns) {
    const k = `${week.id}:${userId}:${weekday}:${col.id}`;
    const v = cells.get(k);
    if (typeof v === "number" && v > 0) return false;
  }
  return true;
}

async function sendReminderTo(sub) {
  const payload = JSON.stringify({
    title: "Reaching Unreal",
    body: "log your day, get those points ..",
    tag: "ru-daily",
    url: "/",
  });
  try {
    await webpush.sendNotification(
      { endpoint: sub.endpoint, keys: sub.keys },
      payload,
      { TTL: 60 * 60 * 6 } // expires in 6h if device is offline
    );
    return { ok: true };
  } catch (e) {
    const status = e?.statusCode || 0;
    // 404/410 = subscription is dead; drop it.
    if (status === 404 || status === 410) {
      subscriptions = subscriptions.filter((s) => s.endpoint !== sub.endpoint);
      saveSubscriptions();
      return { ok: false, dropped: true, status };
    }
    return { ok: false, status, error: e?.message || String(e) };
  }
}

async function runReminderTick() {
  if (!VAPID_PUBLIC || !VAPID_PRIVATE) return { ok: false, error: "vapid-missing" };
  const results = [];
  // Snapshot to avoid mutating during iteration
  for (const sub of [...subscriptions]) {
    let hour;
    let dateKey;
    try {
      hour = Number(
        new Intl.DateTimeFormat("en-US", {
          timeZone: sub.timezone,
          hour: "2-digit",
          hour12: false,
        }).format(new Date())
      );
      dateKey = new Intl.DateTimeFormat("en-CA", {
        timeZone: sub.timezone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }).format(new Date());
    } catch (e) {
      results.push({ endpoint: sub.endpoint.slice(-12), skipped: "bad-tz" });
      continue;
    }
    if (hour !== REMINDER_HOUR) {
      results.push({ endpoint: sub.endpoint.slice(-12), skipped: `hour=${hour}` });
      continue;
    }
    if (sub.lastNotifiedDate === dateKey) {
      results.push({ endpoint: sub.endpoint.slice(-12), skipped: "already-sent-today" });
      continue;
    }
    if (!isTodayZeroForUser(sub.room, sub.userId, sub.timezone)) {
      results.push({ endpoint: sub.endpoint.slice(-12), skipped: "already-logged" });
      continue;
    }
    const r = await sendReminderTo(sub);
    if (r.ok) {
      sub.lastNotifiedDate = dateKey;
      saveSubscriptions();
      results.push({ endpoint: sub.endpoint.slice(-12), sent: true });
    } else {
      results.push({ endpoint: sub.endpoint.slice(-12), error: r });
    }
  }
  return { ok: true, results };
}

// --- HTTP + WebSocket --------------------------------------------------------

const server = http.createServer(async (req, res) => {
  applyCors(req, res);

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.url === "/" || req.url === "/healthz") {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end(
      `Reaching Unreal sync OK · rooms=${rooms.size} · subs=${subscriptions.length}`
    );
    return;
  }

  if (req.url === "/vapid-public-key" && req.method === "GET") {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end(VAPID_PUBLIC);
    return;
  }

  if (req.url === "/subscribe" && req.method === "POST") {
    if (!VAPID_PUBLIC || !VAPID_PRIVATE) {
      res.writeHead(503, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "push-not-configured" }));
      return;
    }
    let body;
    try {
      body = await readJson(req);
    } catch {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "bad-json" }));
      return;
    }
    const { subscription, room, userId, timezone } = body || {};
    if (
      !subscription?.endpoint ||
      !subscription?.keys?.p256dh ||
      !subscription?.keys?.auth ||
      typeof room !== "string" ||
      !room ||
      typeof userId !== "string" ||
      !userId ||
      !isValidTimezone(timezone)
    ) {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "bad-fields" }));
      return;
    }
    const entry = {
      endpoint: subscription.endpoint,
      keys: { p256dh: subscription.keys.p256dh, auth: subscription.keys.auth },
      room,
      userId,
      timezone,
    };
    const idx = subscriptions.findIndex((s) => s.endpoint === entry.endpoint);
    if (idx >= 0) subscriptions[idx] = entry;
    else subscriptions.push(entry);
    saveSubscriptions();
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, count: subscriptions.length }));
    return;
  }

  if (req.url?.startsWith("/unsubscribe") && req.method === "POST") {
    let body;
    try {
      body = await readJson(req);
    } catch {
      body = {};
    }
    const ep = body?.endpoint;
    if (typeof ep === "string") {
      const before = subscriptions.length;
      subscriptions = subscriptions.filter((s) => s.endpoint !== ep);
      if (subscriptions.length !== before) saveSubscriptions();
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  if (req.url?.startsWith("/cron/tick") && (req.method === "POST" || req.method === "GET")) {
    if (CRON_SECRET) {
      const supplied =
        req.headers["x-cron-secret"] ||
        new URL(req.url, "http://x").searchParams.get("secret");
      if (supplied !== CRON_SECRET) {
        res.writeHead(401, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "unauthorized" }));
        return;
      }
    }
    const r = await runReminderTick();
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(r));
    return;
  }

  res.writeHead(404);
  res.end();
});

const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD });

server.on("upgrade", (req, socket, head) => {
  // The client connects to wss://host/<roomname>
  const url = new URL(req.url, "http://x");
  const roomName = decodeURIComponent(url.pathname.slice(1));
  if (!roomName || roomName.length > MAX_ROOM_NAME_LEN) {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    const room = getRoom(roomName);
    room.addConn(ws);
    ws.binaryType = "arraybuffer";
    ws.on("message", (data) => {
      const buf =
        data instanceof ArrayBuffer
          ? new Uint8Array(data)
          : Buffer.isBuffer(data)
          ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
          : new Uint8Array(data);
      room.handleMessage(ws, buf);
    });
    const pinger = setInterval(() => {
      if (ws.readyState !== ws.OPEN) {
        clearInterval(pinger);
        return;
      }
      try {
        ws.ping();
      } catch {}
    }, 25_000);
    ws.on("close", () => {
      clearInterval(pinger);
      room.removeConn(ws);
    });
    ws.on("error", () => {
      clearInterval(pinger);
      room.removeConn(ws);
    });
  });
});

// Periodic snapshot to disk
setInterval(() => {
  for (const room of rooms.values()) room.persist();
}, PERSIST_INTERVAL_MS);

const shutdown = () => {
  console.log("shutting down, persisting rooms...");
  for (const room of rooms.values()) room.persist();
  server.close(() => process.exit(0));
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

server.listen(PORT, HOST, () => {
  console.log(
    `Reaching Unreal sync server listening on http://${HOST}:${PORT} (data: ${DATA_DIR})`
  );
});
