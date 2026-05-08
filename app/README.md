# Reaching Unreal

Two-player productivity tracker that replaces the original `Reaching Unreal.xlsx`.

## What it does

- Tracks one table per user per week, with **Sat → Fri** weeks.
- Each column has a configurable **weight** (the % multiplier you used in Excel).
- Booleans (e.g. `Gym`, `Squash`, `Wake up at 10:30`) and hours co-exist in the same row.
- Daily **Result** cell = Σ (value × weight); week total = ROUND(Σ daily / 7).
- Smooth color gradient: hours → yellow→green→deep green; results → 0–100 yellow→green, 100+ darker green.
- **Seasonal labeling** — every week is also tagged `Spring W4`, `Summer W7`, etc., based on its Saturday's meteorological season.
- **Summary view** — aggregate by month, season, or year, per user.
- **New Week** button clones the previous week's columns/weights with **zeroed** values.
- **Real-time collab** between both users via P2P (Yjs + y-webrtc) — live cell edits + cursor presence with names. No backend required; data is also persisted locally via IndexedDB.

## Run locally

In one terminal, start the sync server:

```bash
cd server
npm install
npm start
# Reaching Unreal sync server listening on http://0.0.0.0:1234
```

In another, start the app pointed at it:

```bash
cd app
cp .env.example .env.local      # sets VITE_YWS_URL=ws://localhost:1234
npm install
npm run dev
```

Open [http://localhost:5173](http://localhost:5173) in two browsers (or two devices on the same network using the printed `Network:` URL) — pick "El Shazly" in one and "El Sayed" in the other and you'll see each other's edits and cursors live.

## Deploy

See [`../DEPLOY.md`](../DEPLOY.md) for a 10-minute Fly.io + Vercel setup, plus iPhone "Add to Home Screen" instructions.

## Reseed from the original xlsx

The original spreadsheet (`Reaching Unreal.xlsx`) was converted into `app/src/data/seed.json` by the importer at `import_xlsx.py`. To regenerate:

```bash
pip3 install openpyxl
python3 import_xlsx.py
```

The importer reads weight values out of the Excel array formulas (e.g. `=SUM([Studying]*15, [Squash]*15, ...)`).

## Architecture

- **React + TypeScript + Vite + Tailwind**
- **Yjs** (`y-websocket` against a tiny self-hosted Node sync server; `y-indexeddb` for local persistence)
  - `meta` map → users
  - `structure` map → JSON snapshot of weeks/tables/columns (modified atomically when adding/renaming/deleting)
  - `cells` map → per-cell numbers, keyed `weekId:userId:day:columnId` (fine-grained CRDT merging — both of you can edit different cells simultaneously without conflicts)
- **Awareness** → drives presence/cursors

## Notes

- Two calendars ship out of the box: meteorological (Dec/Jan/Feb = Winter) and Stanford academic (quarters with breaks). Pick yours under the ⚙ Settings button. Add more under `src/calendars/`.
- Cross-device sync is configured via `VITE_YWS_URL` pointing at the websocket sync server in `../server`.
- The app is a PWA — installable to your iPhone Home Screen, works offline, and resumes sync when reconnected.
