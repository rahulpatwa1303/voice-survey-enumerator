# Deploying Voice Survey Enumerator

One container serves the built client and the WebSocket on a single port, so any
platform that can run a Dockerfile and pass through WebSockets will do.

**HTTPS is not optional.** The browser only grants microphone access on a secure
origin, so the app is useless over plain HTTP. All options below terminate TLS
for you.

---

## What you need before starting

| Thing | Why |
|---|---|
| A Render account (free), or Fly.io / Railway | somewhere to run it |
| `ASSEMBLYAI_API_KEY` | the voice agent |
| `KOBO_TOKEN`, `KOBO_ASSET_UID` | optional — without them interviews still run and hand back the record for download, they just do not submit to Kobo |

Never commit these. `.env` is gitignored and excluded from the image; set them as
platform secrets instead.

---

## Option A — Render (free, recommended)

`render.yaml` is in the repo, so Render reads the whole setup from it.

1. render.com → **New → Blueprint** → connect the GitHub repo
   `rahulpatwa1303/voice-survey-enumerator`.
2. Render reads `render.yaml` (Docker, free plan, Singapore) and asks for
   `ASSEMBLYAI_API_KEY`, `KOBO_TOKEN` and `KOBO_ASSET_UID`. Paste them in.
3. **Apply.** The first build takes a few minutes; the URL is
   `https://voice-survey-enumerator.onrender.com` (or similar).

Render injects `PORT` itself — do not set it. Every push to `master` redeploys.

Free-tier catch: the service **sleeps after 15 minutes idle** and the next visit
waits 30–60 s for it to wake. Open the page once before a demo or recording.

## Option B — Fly.io (paid; no free tier for new accounts)

`fly.toml` is already in the repo. Fly builds the image remotely, so a local
Docker daemon is not needed.

```bash
fly auth login
fly launch --no-deploy          # keep the existing fly.toml when it asks
fly secrets set \
  ASSEMBLYAI_API_KEY=... \
  KOBO_TOKEN=... \
  KOBO_ASSET_UID=ayYSeWmmhZvaxAQZtW3ZXQ
fly deploy
fly open
```

Notes on what is already configured:

- `force_https = true` — required for the microphone.
- `internal_port = 8080` and `PORT = 8080` — the server reads `PORT`, so the two
  must agree.
- `auto_stop_machines` — the machine sleeps when idle, which matters because a
  live voice session bills at **$4.50/hour**. A sleeping machine costs nothing
  and the first request wakes it in a second or two.
- `primary_region = "bom"` (Mumbai). Change it to whatever is closest to where
  you will demo; every turn of the conversation crosses this link, so region
  choice is audible.

## Option C — Railway (trial credit only)

```bash
railway login
railway init
railway up
```

Then in the dashboard: add the same three variables, and generate a domain under
Settings → Networking. Railway detects the Dockerfile and injects `PORT` itself,
so leave `PORT` unset there.

---

## After deploying, check these five things

The build succeeding does not mean the app works. In order:

1. `curl https://<host>/health` → `{"ok":true,"hasKey":true}`. If `hasKey` is
   false the AssemblyAI secret did not land.
2. Open the site. The setup screen should render.
3. `curl https://<host>/audio-worklet.js` → 200. This file is loaded by URL at
   runtime rather than imported, so it is the one asset a bundler can silently
   drop. If it 404s, audio is dead and the UI gives no clue why.
4. Start an interview **on a phone**. Confirm you hear the agent and that
   hold-to-talk captures. This is the first real test of microphone access over
   a proper certificate.
5. Finish an interview and confirm the record appears in the KoboToolbox data
   table.

## Things that will bite

- **WebSockets.** The app is useless without them. All platforms above support
  them; a CDN or proxy in front that buffers or strips upgrades will break the
  conversation with no obvious error.
- **Idle cost.** Sessions bill per minute of active audio. Always press Stop
  rather than closing the tab; the server also ends the session on `pagehide`.
- **Cold starts.** On Render free (and Fly with `auto_stop_machines`), the first visit after a quiet
  period waits for a boot. Warm it before a demo by loading the page once.
- **Region.** Latency is the whole product experience here. Deploy near the demo.

## Running the production build locally

```bash
npm run build                       # vite -> dist/
NODE_ENV=production npm start       # Fastify serves dist/ and /ws on one port
```

Then open http://localhost:8787. Microphone access will be refused on plain HTTP
from anything other than localhost, which is expected — use `npm run dev` for
device testing over the LAN.
