# Deploying Reaching Unreal

You'll deploy two pieces:

| Piece | Where | Cost |
|---|---|---|
| **Sync server** (`server/`) — keeps your data in sync | [Fly.io](https://fly.io) | Free machine on the hobby plan |
| **Frontend** (`app/`) — the website itself | [Vercel](https://vercel.com) | Free hobby plan |

Total cost: **$0**. Time to first deploy: ~10 minutes.

---

## Step 1 — Deploy the sync server to Fly.io

The sync server is a tiny Node websocket server that bridges Yjs updates between all your devices and persists them to a small disk volume.

### 1.1. Install the Fly CLI

```bash
brew install flyctl
fly auth signup     # or `fly auth login` if you already have an account
```

### 1.2. Create the app

```bash
cd server
# Pick a unique app name. Edit `app = "..."` in fly.toml first if you like.
fly launch --no-deploy --copy-config --name <YOUR-APP-NAME>
fly volumes create ru_data --region sjc --size 1 --yes
fly deploy
```

`fly launch` will detect the Dockerfile and `fly.toml`, create the app, and skip auto-deploy so we can attach the volume first. The volume gives you 1 GB of persistent disk for free, which is plenty.

When `fly deploy` finishes, your sync server lives at:

```
wss://<YOUR-APP-NAME>.fly.dev
```

Sanity-check it with `curl https://<YOUR-APP-NAME>.fly.dev/healthz` — you should see `Reaching Unreal sync OK · rooms=0`.

### Optional: tail logs

```bash
fly logs
```

---

## Step 2 — Deploy the frontend to Vercel

### 2.1. Push the repo to GitHub (any private repo will do)

```bash
git init
git add .
git commit -m "Initial commit"
gh repo create reaching-unreal --private --source=. --push
```

### 2.2. Import to Vercel

1. Go to [vercel.com/new](https://vercel.com/new).
2. Import the repo.
3. **Root Directory**: `app`. Vercel will auto-detect Vite and use `npm run build`.
4. **Environment Variables** — add:
   - `VITE_YWS_URL` = `wss://<YOUR-APP-NAME>.fly.dev` (from Step 1)
   - `VITE_ROOM` = something private like `elshazly-and-elsayed-2026` *(optional — defaults to `reaching-unreal-default`. Use a unique value so randos who guess your URL can't read your data)*
5. Click **Deploy**.

You'll get a URL like `https://reaching-unreal.vercel.app`. Open it on your laptop, pick "El Shazly". Send the same URL to your friend, they pick "El Sayed". You'll see each other's edits and cursors live.

> Vercel automatically redeploys whenever you push to `main`. Updating the app is a `git push`.

### Custom domain (optional)

In Vercel → Project → Domains, add a domain you own. Free SSL is automatic.

---

## Step 3 — Add to Home Screen on iPhone / iPad

Once your Vercel URL is live:

1. Open it in **Safari** on your phone.
2. Tap **Share → Add to Home Screen**.
3. Confirm. The app installs as a standalone icon — full-screen, no Safari UI.

The page name is "Reaching" and the icon is a green-blue checkmark. Works offline thanks to the service worker (`app/public/sw.js`).

Repeat on iPad / Mac for an instant cross-device setup.

---

## Local development

### Run the sync server locally

```bash
cd server
npm install
npm start
# listening on http://0.0.0.0:1234
```

### Run the app pointed at it

```bash
cd app
cp .env.example .env.local      # already sets VITE_YWS_URL=ws://localhost:1234
npm install
npm run dev
```

Open `http://localhost:5173` in two browsers — they'll sync through your local server.

---

## Operational notes

- **Backups** — the Fly volume holds your sync state at `/data/<room>.bin`. Snapshot it any time with `fly ssh console -C "cat /data/<room>.bin" > backup.bin`.
- **Rotating room names** — bump `VITE_ROOM` in Vercel and redeploy. Old data stays on the server (in the old room file) until you delete it.
- **Privacy** — the sync server is public-readable for anyone who knows the room name. If that worries you, stick the server behind Cloudflare Access, or wrap the websocket upgrade with a shared-secret cookie check (see `server.js` `server.on('upgrade', …)`).
- **Failure modes** — if the sync server is down, the app's badge will read `Reconnecting…`. All edits keep working locally (IndexedDB) and replay automatically once the server is back up. No data loss.
- **iPhone backgrounding** — when iOS pauses the tab/PWA in the background, y-websocket's auto-reconnect kicks in on resume and pulls the latest state.

---

## Architecture diagram

```
┌────────────┐   wss   ┌──────────────────┐   wss   ┌────────────┐
│   iPhone   │ ─────►  │  Fly.io machine  │ ◄───── │   Macbook  │
│ (Reaching) │ ◄────── │  reaching-unreal │ ──────►│ (Reaching) │
└────────────┘   sync  │     -sync        │  sync  └────────────┘
                       │                  │
                       │  /data/<room>.bin (1GB volume)
                       └──────────────────┘
                              ▲
                              │ Y.applyUpdate / Y.encodeStateAsUpdate
                              ▼
                        Single Y.Doc per room
```

Each device is a Yjs client. The Fly server is a "fan-out hub" that:

1. Restores `/data/<room>.bin` into a server-side Y.Doc on first connect for that room
2. Forwards every Yjs sync + awareness message to all the other clients in that room
3. Persists the doc back to disk every 5s (`PERSIST_INTERVAL_MS`)

When a client disconnects, its local IndexedDB still has a full copy of the doc; on reconnect, Yjs computes a delta against the server and they merge automatically.
