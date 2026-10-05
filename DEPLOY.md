# Deploying Reaching Unreal on Render

The existing `reaching-unreal-sync` Render web service hosts both the app and its sync server. No second service or Vercel account is needed.

## Existing service settings

Keep these settings in Render:

| Setting | Value |
|---|---|
| Repository | `YousefrElshazly/Reaching-Unreal` |
| Branch | `main` |
| Root Directory | `server` |
| Build Command | `npm install` |
| Start Command | `node server.js` |
| Health Check Path | `/healthz` |

The server's install step builds `server/app/` automatically. The app opens at `https://reaching-unreal-sync.onrender.com/`; `/healthz` remains the server health check. Existing push-notification and Upstash environment variables stay on this service.

## Updating the app

Push changes to `main`, then redeploy `reaching-unreal-sync` in Render as usual. Because the frontend now lives under `server/`, Render's existing root directory includes it, and the build step produces the latest app. Once the deploy is live, refresh the Render URL above. You can bookmark it or add it to your phone's Home Screen.

The app uses the same sync URL and room as the previous frontend, so shared weekly logs and public plans come from the existing server snapshot. Data stored only in the browser, including private plans, does not move automatically between the old Vercel URL and the Render URL.

## Local development

```bash
cd server
npm install
npm start
# Open http://localhost:1234 for the built app; /healthz checks the server.
```

For live frontend editing, run `cd server/app && cp .env.example .env.local && npm run dev` in another terminal and open `http://localhost:5173`.

The current room name is configured as a build fallback in `server/package.json`. Set `VITE_ROOM` and `VITE_YWS_URL` in Render if those values ever need to change. The room name is included in browser code and is not authentication; the sync server currently permits anyone who knows its URL and room to connect.
