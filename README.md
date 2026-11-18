# Muse Relay v6

Coordinate multiple **AI Muses** running on their own machines: you chat with each Muse through a web UI, while each Muse runs a small client on its machine to receive and reply to messages.

> **Built with ZCode** — this entire codebase (web UI, local server, Muse client, docs, tests) was implemented by **ZCode**, the AI coding agent.

```
[serve.py (your machine) + web UI] ⇄ [Supabase: Postgres + RLS + Auth] ⇄ [Muse client on each Muse's machine]
```

- **No keys ever live in the browser**: `serve.py` reads `.env` and proxies every Supabase call; the web UI only talks to the local server.
- **Each Muse = its own session identity scoped by RLS**: Muse A cannot read Muse B's data — isolation enforced at the database level, not the application level.
- **Files/images/videos never travel through the relay**: the Muse uploads to its own Dropbox and returns a link in the message.

## Setup (5 minutes, once)

1. Create a project on [supabase.com](https://supabase.com) → **SQL Editor** → paste `supabase/setup.sql` → **Run**.
2. Copy `.env.example` to `.env` and fill in:

   ```ini
   SUPABASE_PROJECT_ID=abcdefghijklmnopqrst    # 20-letter project ref (the part before .supabase.co)
   SUPABASE_SECRET_KEY=sb_secret_…             # Dashboard → Settings → API → Secret key
   SUPABASE_PUBLISHABLE_KEY=sb_publishable_…   # Dashboard → Settings → API
   PORT=8080                                   # web UI port (pick any free port)
   WEB_UI_PASSWORD=change-me                   # login password for the web UI — required
   API_KEY=mr_change-me                        # Bearer key for the REST API /api/v1 — optional
   ```

   Either key style works for `SUPABASE_SECRET_KEY` (new `sb_secret_…` or legacy JWT `eyJ…`) — server-side code is not subject to the browser restriction.
3. Install `requests` (`pip install requests`) if you don't have it.

## Run

```bash
python3 serve.py            # → http://127.0.0.1:<PORT from .env>
# expose to LAN: python3 serve.py --host 0.0.0.0     (--port overrides .env)
```

One server does everything: hosts the web UI **behind a password login** (`WEB_UI_PASSWORD` from `.env` — without it the server refuses to start), proxies Supabase (`/sb/*`), streams realtime messages (SSE `/api/events`, 3s poll), and serves the REST API (below). Moving machines = copy the repo + `.env` and run again.

## REST API + docs

Scripts can drive the relay through `/api/v1/*` with `Authorization: Bearer <API_KEY>`:

| Endpoint | What it does |
|---|---|
| `GET /api/v1/muses` | List all Muses |
| `GET /api/v1/threads?muse_id=<id>` · `POST /api/v1/threads` | List / create threads |
| `POST /api/v1/messages` `{"thread_id":…, "text":"…"}` | Send a message to a Muse |
| `GET /api/v1/messages?thread_id=<id>&after_id=<id>` | Read messages (polling) |

Proper interactive docs ship with the server: **Swagger UI at `/docs`** and **Redoc at `/redoc`** (spec: `/openapi.json`).

## Create a new Muse

1. Web UI → **＋ New Muse**:
   - **Step 1**: type the **Muse name** — the Muse ID auto-slugs from the name (Vietnamese diacritics stripped, still editable), pick capability tags (chat / image / video).
   - **Step 2**: the wizard creates the Muse's identity (a dedicated login + a long-lived **Relay Session** value) and shows a **copy-ready English instruction** with four values — Project ID, Publishable Key, Muse Email, Relay Session — click **Copy**.
2. Paste the instruction into the Muse's chat. The Muse downloads the zip (link inside the instruction) and writes all four values into `config.json` itself — plain config, no secure form involved.
3. The Muse's client renews its own session from that value → RLS locks it to its own project → daemon starts → **the daemon automatically posts a `pong` ready-signal** and the web UI unlocks the Muse (until then it shows "Setting up…" and the composer is disabled) → send a test message from the web UI → the Muse replies. Done!

> The login seed stays server-side (`projects.secret`, never displayed). If a Muse ever loses its config or the session dies, mint a fresh Relay Session via **⚙ → Token** — each mint creates an independent session, so running clients are never disturbed.

## How the Muse client works

`client/` in this repo is the source of the `muse-relay.zip` the Muse receives. The client needs only five plain values in `config.json`: `Project ID`, `Publishable Key`, `URL`, `Muse Email` and `RELAY_SESSION` (the Muse's session — from ⚙ → Token). The session renews itself on every refresh; the live value is kept in `state/session.json` (chmod 600).

- **Daemon** `poller.py` runs forever, ~3s per round: new messages (role `user`) → `state/inbox.jsonl`; Muse replies go to `outbox/<thread_id>.txt` → the daemon pushes them to Supabase and deletes the file.
- **Internal signals** posted by the daemon itself: `pong` (ready — unlocks the Muse in the web UI) and `…` typing signals (`...`) when new messages arrive — the web UI uses them for the "Setting up…" gate, the typing bubble, and the ✓✓ received state. Never ordinary chat content.
- **Cursor** `state/cursor.json` is written atomically (first run starts at the newest message — history is never replayed).
- **Muse-platform schedule**: every 3 minutes a check restarts the daemon if it died; a hook wakes the Muse within ~10 seconds of a new message.
- A lockfile (`state/puller.lock`) guarantees exactly ONE puller per folder.
- Operating rules for the Muse: `client/AGENTS.md` (Dropbox-only assets, inbox/outbox protocol, cursor prohibitions…). Full install walkthrough: `client/setup_guide.txt`.

## Resource previews & message meta

Dropbox links the Muse returns render as **preview cards** right in the chat:

- Images (jpg/png/webp/…) show an inline thumbnail, videos (mp4/webm/…) an inline player, audio a player bar — streamed directly via Dropbox `raw=1`. Click the preview (or the file name row) for the direct download (`dl=1`).
- PDFs get a 👁 toggle that expands an embedded viewer (loaded lazily on first open); any other file keeps a plain download card. A preview that fails to load falls back to the card gracefully.
- Time and the send-state chip (`sending → ✓ sent → ✓✓ received / ✗ failed`) sit **outside** the bubble, on a small meta line under it.
- While a send is in flight or the Muse is typing, the send button turns into a red **■ Stop** — abort the in-flight send (the text returns to the composer) or stop the waiting UI (typing bubble); the Muse's reply then simply arrives as a normal message.

The old usage/`/status` bar was removed. Its plumbing rows still live in older threads — the web UI keeps filtering `/status` requests and `<<<STATUS>>>…` replies out of the chat history.

## Auto-titling & the hidden ⌘ sys channel

New threads start as **"New thread"**; after the Muse's first answer the web UI asks the Muse — through a **hidden `⌘ sys` thread** (one per Muse, created lazily) — to propose a short title and applies it automatically. The channel rides the normal message pipeline, so **no client-zip change is needed**: the daemon already reads every project thread and replies to the same `thread_id`. System rows never render in a real thread and never count toward previews or unread badges; one task runs per Muse at a time, and requests/replies there cost regular Muse turns.

To peek at the channel: hover the Muse → ⚙ → **Display hidden thread On** — the `⌘ sys` thread then stays pinned at the top of that Muse's group (it only exists after the first automated task). Pinned threads show their plain title in the Pinned section, without the Muse-name prefix.

## Tags: chat / image / video

Capabilities are **distributed by the server** (the `tags` column on the project — edit any time in the web UI: hover the Muse → ⚙):

| Tag | What the Muse may do |
|---|---|
| `chat` | Text chat only |
| `image` | Create/edit images on request → upload to Dropbox → return a link |
| `video` | Create videos on request → upload to Dropbox → return a link |

## Security

- **The browser holds zero keys** — every key lives in `.env` on your machine (git-ignored).
- **The web UI is password-gated** — `WEB_UI_PASSWORD` from `.env`; every page and every browser-facing endpoint (proxy, SSE, config) requires the session; scripts use the separate `API_KEY` Bearer credential.
- **The project Secret Key never reaches a Muse** — every Muse request carries its own session JWT and passes RLS, so **Muse A cannot read Muse B's data at the database level** (verified with a real JWT).
- **The Muse's Relay Session** is handed over as ordinary config (a deliberate owner trade-off — the value acts as that Muse's identity and is bounded by RLS to its own project; whoever holds it can act as that Muse, nothing more). The login seed that can mint new sessions stays server-side and is never displayed.
- **1 Muse = 1 auth account**: deleting a Muse in the web UI (⚙) removes its account + data (cascade) and revokes access instantly.
- Relay messages are text only; assets must go through Dropbox links.

## Repository layout

```
muse-relay/
├── README.md              ← this file (all the docs live here)
├── LICENSE                ← MIT
├── serve.py               ← local server: password login, hosts the UI, proxies Supabase, SSE, REST API + /docs /redoc
├── .env.example           ← template; copy to .env and fill in your keys
├── supabase/
│   └── setup.sql          ← run once in the Supabase SQL Editor
├── web/
│   ├── index.html         ← web UI (single file, keyless)
│   ├── muse-relay.zip     ← the built Muse setup bundle (downloaded by Muses)
│   └── openapi.json       ← REST API spec (rendered at /docs and /redoc)
└── client/                ← source of the Muse setup bundle (= muse-relay.zip)
    ├── muse_client.py     ← one-shot client (poll once + push, for cron)
    ├── poller.py          ← the main background daemon (infinite loop, ~3s/round)
    ├── relay_auth.py      ← shared: GoTrue login, session refresh, lockfile
    ├── config.json        ← Project ID + Publishable Key + Muse Email (public)
    ├── AGENTS.md          ← mandatory operating rules for the Muse
    ├── setup_guide.txt    ← step-by-step install guide inside the zip
    └── run.sh / run.bat / start_daemon.sh / restart_poller.sh
```

> Build the Muse zip from `client/`: `cd client && zip -r ../web/muse-relay.zip .`
> The built `web/muse-relay.zip` is committed to main — the download link inside the wizard's instruction points there.

## License

[MIT](LICENSE)
