# Muse Relay v4

Coordinate multiple **AI Muses** running on their own machines: you chat with each Muse through a web UI, while each Muse runs a small client on its machine to receive and reply to messages.

```
[serve.py (your machine) + web UI] ⇄ [Supabase: Postgres + RLS + Auth] ⇄ [Muse client on each Muse's machine]
```

- **No keys ever live in the browser**: `serve.py` reads `.env` and proxies every Supabase call; the web UI only talks to the local server.
- **Each Muse = its own login (email/password) scoped by RLS**: Muse A cannot read Muse B's data — isolation enforced at the database level, not the application level.
- **Files/images/videos never travel through the relay**: the Muse uploads to its own Dropbox and returns a link in the message.

## Setup (5 minutes, once)

1. Create a project on [supabase.com](https://supabase.com) → **SQL Editor** → paste `supabase/setup.sql` → **Run**.
2. Copy `.env.example` to `.env` and fill in:

   ```ini
   SUPABASE_PROJECT_ID=abcdefghijklmnopqrst    # 20-letter project ref (the part before .supabase.co)
   SUPABASE_SECRET_KEY=sb_secret_…             # Dashboard → Settings → API → Secret key
   SUPABASE_PUBLISHABLE_KEY=sb_publishable_…   # Dashboard → Settings → API
   ```

   Either key style works for `SUPABASE_SECRET_KEY` (new `sb_secret_…` or legacy JWT `eyJ…`) — server-side code is not subject to the browser restriction.
3. Install `requests` (`pip install requests`) if you don't have it.

## Run

```bash
python3 serve.py            # → http://127.0.0.1:8080
# expose to LAN: python3 serve.py --host 0.0.0.0
```

One server does everything: hosts the web UI, proxies Supabase (`/sb/*`), streams realtime messages (SSE `/api/events`, 3s poll). Moving machines = copy the repo + `.env` and run again.

## Create a new Muse

1. Web UI → **＋ New Muse**:
   - **Step 1**: type the **Muse name** — the Muse ID auto-slugs from the name (Vietnamese diacritics stripped, still editable), pick capability tags (chat / image / video).
   - **Step 2**: the wizard creates a **dedicated login for the Muse** (email + a random 24-char password) and shows a **copy-ready English instruction** (with Email + Password) — click **Copy**.
2. Paste the instruction into the Muse's chat. The Muse downloads the zip (link inside the instruction), fills in `config.json` by itself, then shows a **secure form called "Muse Relay password"** — copy the Password from Step 2 (or ⚙ → Token anytime) and type it into that form. Never paste it into chat.
3. The Muse logs in → RLS locks it to its own project → daemon starts → send a test message from the web UI → the Muse replies. Done!

> The password is the ONLY secret the Muse ever handles. It lives only in the client's environment — never on disk (a refresh token in `state/session.json`, chmod 600, keeps the daemon restartable without the password).

## How the Muse client works

`client/` in this repo is the source of the `muse-relay.zip` the Muse receives. The client needs only 3 public values (`Project ID`, `Publishable Key`, `Muse Email` in `config.json`) plus the password from the secure form.

- **Daemon** `poller.py` runs forever, ~3s per round: new messages (role `user`) → `state/inbox.jsonl`; Muse replies go to `outbox/<thread_id>.txt` → the daemon pushes them to Supabase and deletes the file.
- **Cursor** `state/cursor.json` is written atomically — restarts never reprocess old messages, never miss new ones.
- **Muse-platform schedule**: every 3 minutes a check restarts the daemon if it died; a hook wakes the Muse within ~10 seconds of a new message.
- A lockfile (`state/puller.lock`) guarantees exactly ONE puller per folder.
- Operating rules for the Muse: `client/AGENTS.md` (Dropbox-only assets, inbox/outbox protocol, cursor prohibitions…). Full install walkthrough: `client/setup_guide.txt`.

## Tags: chat / image / video

Capabilities are **distributed by the server** (the `tags` column on the project — edit any time in the web UI: hover the Muse → ⚙):

| Tag | What the Muse may do |
|---|---|
| `chat` | Text chat only |
| `image` | Create/edit images on request → upload to Dropbox → return a link |
| `video` | Create videos on request → upload to Dropbox → return a link |

## Security

- **The browser holds zero keys** — every key lives in `.env` on your machine (git-ignored).
- **The project Secret Key never reaches a Muse** — Muses log in with their own email/password; every request passes RLS, so **Muse A cannot read Muse B's data at the database level** (verified with a real JWT).
- **The Muse password** goes only through the Muse platform's secure form — never chat, never files, never logs.
- **1 Muse = 1 auth account**: deleting a Muse in the web UI (⚙) removes its account + data (cascade) and revokes access instantly.
- Relay messages are text only; assets must go through Dropbox links.

## Repository layout

```
muse-relay/
├── README.md              ← this file (all the docs live here)
├── LICENSE                ← MIT
├── serve.py               ← local server: hosts the UI, proxies Supabase, SSE realtime
├── .env.example           ← template; copy to .env and fill in your keys
├── supabase/
│   └── setup.sql          ← run once in the Supabase SQL Editor
├── web/
│   └── index.html         ← web UI (single file, keyless)
└── client/                ← source of the Muse setup bundle (= muse-relay.zip)
    ├── muse_client.py     ← one-shot client (poll once + push, for cron)
    ├── poller.py          ← the main background daemon (infinite loop, ~3s/round)
    ├── relay_auth.py      ← shared: GoTrue login, session refresh, lockfile
    ├── config.json        ← Project ID + Publishable Key + Muse Email (public)
    ├── AGENTS.md          ← mandatory operating rules for the Muse
    ├── setup_guide.txt    ← step-by-step install guide inside the zip
    └── run.sh / run.bat / start_daemon.sh / restart_poller.sh
```

> Build the Muse zip from `client/`: `cd client && zip -r ../muse-relay.zip .`
> The `web` branch on GitHub holds the built `muse-relay.zip` — the download link inside the wizard's instruction points there.

## License

[MIT](LICENSE)
