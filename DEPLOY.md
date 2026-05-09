# Deploying Reaching Unreal

You'll deploy two pieces:

| Piece | Where | Cost | Notes |
|---|---|---|---|
| **Sync server** (`server/`) | [Render.com](https://render.com) | **Free** (no credit card) | Truly free, never expires. Sleeps after 15 min of inactivity unless you use the optional UptimeRobot keep-alive (also free). |
| **Frontend** (`app/`) | [Vercel](https://vercel.com) | **Free** | Always-on, no card needed. |

Total cost: **$0/month, forever**. Time to first deploy: ~10 minutes.

> Heads-up: even if Render's server goes to sleep and gets wiped on a redeploy, **no data is lost** — every client (your Macbook, your iPhone, your friend's devices) keeps a full Yjs CRDT history in IndexedDB and re-uploads it the next time it connects. The server is just a fan-out hub, not a database of record.

---

## Step 1 — Push the repo to GitHub

Render and Vercel both deploy by reading from a GitHub repo. You only need to push once; future updates are auto-deployed by both services on every `git push`.

1. Go to [github.com/new](https://github.com/new).
2. Name it `reaching-unreal` (or anything). **Pick "Private"** so only you can see it. **Don't** initialize with a README, .gitignore, or license — we already have those.
3. Copy the two `git remote add` and `git push` commands GitHub shows you. They'll look like:

```bash
cd /Users/elshazly/Projects/ReachingUnreal
git remote add origin https://github.com/<YOUR-USERNAME>/reaching-unreal.git
git branch -M main
git push -u origin main
```

Run them. (You'll be asked to authenticate — easiest path is the GitHub CLI which prompts a browser flow, but a personal access token also works.)

---

## Step 2 — Deploy the sync server to Render

### 2.1. Sign up

1. Go to [render.com](https://render.com) → **Get Started**.
2. **Sign in with GitHub** (the easiest path — it gives Render permission to read your private repo).
3. **No credit card needed** for the free tier.

### 2.2. Create the service from the Blueprint

The repo includes `render.yaml` at the root, which is a "Blueprint" Render reads to know exactly how to deploy.

1. In the Render dashboard, click **New → Blueprint**.
2. Connect the `reaching-unreal` repo.
3. Render reads `render.yaml`, shows you a preview of the service it'll create. Click **Apply**.
4. Wait ~3 minutes for the first deploy. When status shows `Live`, copy the URL — it'll look like `https://reaching-unreal-sync.onrender.com`.

Sanity-check it: `curl https://reaching-unreal-sync.onrender.com/healthz` should return `Reaching Unreal sync OK · rooms=0`.

> **The websocket URL is the same hostname with `wss://`** — i.e. `wss://reaching-unreal-sync.onrender.com`. You'll plug this into Vercel in the next step.

### 2.3. (Strongly recommended) Set up UptimeRobot keep-alive

Render's free tier sleeps the server after 15 minutes of no traffic. A free UptimeRobot monitor pinging `/healthz` every 5 minutes keeps it warm forever.

1. Go to [uptimerobot.com](https://uptimerobot.com), make a free account (no card).
2. **Add New Monitor**:
   - Type: **HTTP(s)**
   - URL: `https://reaching-unreal-sync.onrender.com/healthz`
   - Monitoring interval: **5 minutes**
3. Save. Done — the server now stays awake 24/7.

If you skip this step, the server still works, but the first request after 15 min of idle takes ~30s to wake up (the rest of the session is instant).

---

## Step 3 — Deploy the frontend to Vercel

### 3.1. Sign up

[vercel.com](https://vercel.com) → **Continue with GitHub**. No card needed.

### 3.2. Import the repo

1. [vercel.com/new](https://vercel.com/new) → import `reaching-unreal`.
2. **Root Directory**: `app` ← **critical**, otherwise the build fails.
3. Vercel auto-detects Vite and fills in build/output dirs.
4. Expand **Environment Variables** and add:
   - `VITE_YWS_URL` = `wss://reaching-unreal-sync.onrender.com` (from Step 2.2)
   - `VITE_ROOM` = anything unique, e.g. `shazly-sayed-2026` *(optional; defaults to `reaching-unreal-default`. Use a unique value so randos who guess the URL can't read your data)*
5. Click **Deploy**.

Wait ~1 minute. You'll get a URL like `https://reaching-unreal.vercel.app`. Open it on your laptop, pick **El Shazly**. Send the same URL to your friend, they pick **El Sayed**. You'll see each other's edits and cursors live.

> **Vercel auto-redeploys on every `git push`.** Updating the app is just a commit and push.

### Custom domain (optional)

In Vercel → Project → Domains, add a domain you own. Free SSL is automatic.

---

## Step 4 — Add to Home Screen on iPhone / iPad

Once your Vercel URL is live:

1. Open it in **Safari** on your phone.
2. Tap **Share → Add to Home Screen**.
3. Confirm. The app installs as a standalone icon — full-screen, no Safari UI.

Works offline thanks to the service worker (`app/public/sw.js`).

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

- **No data loss on server restart.** Every client has a complete Yjs CRDT log in IndexedDB. Server-side state is best-effort: the next reconnecting client uploads its full doc and the server is whole again. (Tested.)
- **Rotating room names** — bump `VITE_ROOM` in Vercel and redeploy. Old data stays on the clients (in their IndexedDB under the old room key).
- **Privacy** — anyone who learns your room name + the websocket URL can read+write the doc. The sync URL is in the JS bundle that any visitor can read, so the room name is the only secret. Pick something non-obvious for `VITE_ROOM` or wrap the websocket upgrade with a shared-secret cookie check (see `server.js` `server.on('upgrade', …)`).
- **Failure modes** — when the sync server is unreachable the badge in the app reads `Reconnecting…`. Edits keep working locally and replay automatically once the server is back.
- **iPhone backgrounding** — when iOS pauses the tab/PWA in the background, y-websocket's auto-reconnect kicks in on resume and pulls the latest state.

---

## Architecture diagram

```
┌────────────┐   wss   ┌──────────────────┐   wss   ┌────────────┐
│   iPhone   │ ─────►  │ Render.com web   │ ◄────── │   Macbook  │
│ (Reaching) │ ◄────── │ reaching-unreal  │ ──────► │ (Reaching) │
└────────────┘         │      -sync       │         └────────────┘
                       │                  │
                       │  In-memory Y.Doc │   ◄── kept warm by UptimeRobot
                       │  per room        │       pinging /healthz every 5m
                       └──────────────────┘
                              ▲
                              │ Y.applyUpdate / Y.encodeStateAsUpdate
                              │
                       Each client's IndexedDB
                       holds the durable backup
```

Each device is a Yjs client. The Render server is a "fan-out hub" that broadcasts every Yjs sync + awareness message to other clients in the same room. The clients' local IndexedDB stores act as the durable backup — there is no single point of data loss.
