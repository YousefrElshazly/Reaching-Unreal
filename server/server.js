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

// --- HTTP + WebSocket --------------------------------------------------------

const server = http.createServer((req, res) => {
  if (req.url === "/" || req.url === "/healthz") {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end(`Reaching Unreal sync OK · rooms=${rooms.size}`);
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
