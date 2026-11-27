**English** | [Tiếng Việt](setup-guide.vi.md)

# Setup, Deployment & Operations Guide

This guide walks you through setting up **Muse Relay** from scratch, deploying the Supabase backend, running the Express server and React dashboard locally or in production, onboarding agents, and running the live acceptance test suite.

---

## 1. Prerequisites

| Requirement | Notes |
|---|---|
| **Node.js >= 20.11** and **npm** | Required because `server/src/index.ts` and `server/src/env.ts` use `import.meta.dirname` (introduced in Node 20.11). Verify with `node -v`. |
| **Supabase project** | Create a project in [Supabase](https://supabase.com/). You will need its Project URL, Publishable key, Secret (service role) key, and a Personal Access Token (`sbp_...`). |
| **Dropbox Scoped App** *(optional)* | Required only if you want in-dashboard Dropbox file previews and drag-and-drop uploads (up to 50 MB). |
| **Git Bash + Python 3** *(Windows only)* | Required on Windows to run `scripts/deploy-functions.sh` and `scripts/acceptance-tests.sh` (`bash`, `curl`, `openssl`, `python`). |

---

## 2. Environment Setup (`.env`)

Copy [`.env.example`](../.env.example) to `.env` in the repository root:

```bash
cp .env.example .env
```

> Never commit `.env` (it is git-ignored) and never paste secret keys or `RELAY_TOKEN` values into chat, logs, or screenshots.

### All 14 Environment Variables

#### Supabase & Relay Platform

| Variable | Required For | Description |
|---|---|---|
| `SUPABASE_URL` | `server/`, scripts | Project URL (`https://<project-ref>.supabase.co`), exposed to the SPA at runtime via `GET /api/config`. |
| `SUPABASE_PUBLISHABLE_KEY` | `server/`, scripts | Public Supabase anon/publishable key, exposed to the SPA via `GET /api/config`. Security is enforced by RLS + JWT + relay tokens. |
| `SUPABASE_SECRET_KEY` | `scripts/acceptance-tests.sh` | Service-role key (**strictly secret**). Used only server-side/by the test suite for admin auth and cleanup; never sent to the browser. |
| `SUPABASE_ACCESS_TOKEN` | `scripts/deploy-functions.sh`, CLI | Personal access token (`sbp_...` from Supabase Account → Access Tokens) used to deploy Edge Functions and push migrations. |

#### Owner & Edge Function Secrets

| Variable | Required For | Description |
|---|---|---|
| `RELAY_OWNER_ID` | Edge Functions, `server/` | Owner's Supabase Auth user UUID. Both `submit_message` and `server/src/auth.ts` (`requireOwnerAuth`) reject JWTs from any other user. |
| `RELAY_SIGNING_SECRET` | Edge Functions | HMAC-SHA256 secret (`openssl rand -hex 32`) kept only inside Supabase secrets. Signs messages in `submit_message` and verifies them in `claim_message`. |

#### Muse Test Credentials (Used Only by Acceptance Suite)

| Variable | Required For | Description |
|---|---|---|
| `RELAY_TOKEN` | `scripts/acceptance-tests.sh` | Test Muse token (`openssl rand -hex 32`). Also illustrates what gets pasted into a Muse's Secure Vault (the server only stores its SHA-256 hash in `relay_muses.token_hash`). |
| `RELAY_RECIPIENT_ID` | `scripts/acceptance-tests.sh` | Test Muse `recipient` UUID matching a row in `relay_muses`. |

#### Express Server & Dashboard (`server/`)

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | HTTP port for `server/` (serves `/api/*` and, when built, `dashboard/dist/`). |
| `OWNER_DISPLAY_NAME` | `Owner` | Display name returned by `GET /api/config` and shown in the dashboard UI. |

#### Dropbox OAuth Credentials (`server/`)

| Variable | Default | Description |
|---|---|---|
| `DROPBOX_APP_KEY` | — | App key from Dropbox App Console (`Scoped App` → `Full Dropbox`). |
| `DROPBOX_APP_SECRET` | — | App secret for OAuth token refresh. |
| `DROPBOX_REFRESH_TOKEN` | — | Non-expiring OAuth refresh token; `server/` caches short-lived access tokens in memory and refreshes automatically. |
| `DROPBOX_ACCESS_TOKEN` | — | Optional static/4-hour fallback token if refresh credentials are not configured. |

To enable Dropbox permissions in the [Dropbox App Console](https://www.dropbox.com/developers/apps):
1. Create a **Scoped App** with **Full Dropbox** access.
2. Under **Permissions**, enable `files.metadata.read`, `files.content.read`, and `files.content.write`.
3. Generate a Refresh Token (recommended) or temporary Access Token, add the values to `.env`, and restart `server/`.

---

## 3. Supabase Setup

### 3.1 Create Owner User & Lock Sign-ups

1. Open **Supabase Dashboard → Authentication → Users** and create your owner account (email + password).
2. Copy the user's **UUID** and paste it into `RELAY_OWNER_ID` in `.env`.
3. Go to **Authentication → Sign In / Providers** and disable **Allow new users to sign up** so no external user can register an account.

### 3.2 Apply All 10 Migrations

The [`supabase/migrations/`](../supabase/migrations/) directory contains **10 strictly additive SQL migrations**:

1. `20261127000000_relay.sql` — `relay_messages`, `relay_results`, `relay-inputs` private bucket, owner-select RLS.
2. `20261127000100_relay_chat.sql` — ensures `action` check allows `chat`, `image`, `video`.
3. `20261127000200_recipient_hash.sql` — allows lowercase UUID `recipient` values alongside `'nyx'`.
4. `20261127000300_relay_muses.sql` — `relay_muses` registry (SHA-256 `token_hash`, `dropbox_root`, owner-all RLS).
5. `20261127000400_relay_groups.sql` — `relay_groups`, `relay_group_members`, `relay_group_posts`.
6. `20261127000500_relay_muses_last_claim.sql` — `last_claim_at` heartbeat column on `relay_muses`.
7. `20261127000550_relay_projects.sql` — v7 tables (`relay_agents_openai`, `relay_projects`, `relay_project_agents`, `relay_conversations`, `relay_openai_messages`).
8. `20261127000600_cleanup_legacy_and_owner_delete.sql` — owner `DELETE` RLS on `relay_messages`/`relay_results` and legacy data cleanup.
9. `20261127000700_muse_connection_state.sql` — `setup_done`, `first_connected_at`, `last_result_at`, `token_rotated_at` + trigger `trg_relay_muses_connection_state`.
10. `20261127000800_relay_muses_email_owner.sql` — `email_owner` metadata column on `relay_muses`.

Apply them via Supabase CLI:

```bash
npx --yes supabase login
npx --yes supabase link --project-ref <your-project-ref>
npx --yes supabase db push
```

*(Alternatively, paste and run each file in order `000000` → `000800` inside **Supabase Dashboard → SQL Editor**.)*

### 3.3 Set the 2 Edge Function Secrets

Edge Functions require **only two** secrets on Supabase:

```bash
npx --yes supabase secrets set \
  RELAY_SIGNING_SECRET="<your-64-hex-signing-secret>" \
  RELAY_OWNER_ID="<your-owner-uuid>"
```

### 3.4 Deploy the 3 Edge Functions

Run [`scripts/deploy-functions.sh`](../scripts/deploy-functions.sh) (reads `SUPABASE_URL` and `SUPABASE_ACCESS_TOKEN` from `.env`):

```bash
bash scripts/deploy-functions.sh
```

This deploys `submit_message` (`verify_jwt = true`), `claim_message` (`verify_jwt = false`), and `submit_result` (`verify_jwt = false`) as configured in [`supabase/config.toml`](../supabase/config.toml). *(Note: `dropbox_proxy` has been removed and replaced by `server/`.)*

---

## 4. Local Development & Production Build

All root commands are defined in [`package.json`](../package.json):

```bash
# 1. Install dependencies for both server/ and dashboard/
npm run install:all

# 2. Verify TypeScript types across server/ and dashboard/
npm run typecheck

# 3. Start development mode (Express on :3000 + Vite HMR on :5173 with /api proxy)
npm run dev
```

For **production** (single-port mode serving both `/api/*` and `dashboard/dist/`):

```bash
npm run build
npm start
```

Open `http://localhost:5173` (dev) or `http://localhost:3000` (production) and sign in with your owner email and password.

---

## 5. Using the Dashboard

### 5.1 Onboarding a Muse (`AddMuseWizard`)

1. Open **Overview** or **Agent Admin** and click **Add Muse**.
2. Enter the **Muse Name** and **Muse Owner Email** (e.g., `alice@example.com`).
   - The Dropbox root is automatically derived as `/<lowercase-email>/` (e.g., `/alice@example.com/`) — you never type leading/trailing slashes manually.
3. Click **Create**. The wizard generates a `recipient` UUID and a 64-hex `RELAY_TOKEN`, computes its SHA-256 hash in the browser, and inserts the row into `relay_muses`.
4. Step 2 displays **two separate panels**:
   - **RELAY_TOKEN Panel**: Copy the token and paste it into the Muse's **Secure Vault**. This token is shown **once only** and is never included in the instructions panel.
   - **Canonical Instructions Panel**: Copy and send to your Muse so it configures `claim_message`, `submit_result`, its `dropbox_root`, and its 10s poll / 10m watchdog schedule.
5. **Initial `setup_done` lock**: Until the Muse makes its first authenticated `claim_message` poll (`setup_done = true`), its direct room composer remains locked with a waiting banner. Once the Muse polls, `claim_message` sets `setup_done = true` and `last_claim_at`, unlocking the room automatically on the next 10s dashboard refresh.

### 5.2 Rotating Tokens, Renaming, Clearing History & Deleting Muses

- In **Agent Admin** or inside a Muse's room (**Manage ▾** menu):
  - **Rename**: Updates `relay_muses.name` and syncs cached `agent_name` in `relay_project_agents`.
  - **Rotate token**: Generates a new token, updates `token_hash` and `token_rotated_at`. The old token stops working immediately (`401`); the dashboard shows **Reconnecting** until the Muse polls with the new token.
  - **Clear history** *(inside direct Muse room)*: Deletes the owner's direct `relay_messages` / `relay_results` for that Muse.
  - **Delete Muse**: Removes the row from `relay_muses` (revoking `claim_message`/`submit_result` immediately) and cleans up project/group memberships.

### 5.3 Configuring OpenAI-Compatible Agents

1. Open **Agent Admin** → **Add OpenAI Agent**.
2. Provide **Name**, **Base URL** (e.g., `https://api.openai.com/v1`), **Model**, **API Key**, and optional **System Prompt**.
3. Click **Test Connection** to verify `/chat/completions` connectivity through `POST /api/openai/test` (20s server-side timeout, avoids browser CORS).

### 5.4 Projects & Conversations

Click **+ New Project** in the left **Sidebar** (`ProjectWizard`), assign any mix of Muse and OpenAI-compatible agents, then create a **Conversation** (`NewConversationModal`) in one of four modes:

| Mode | Behavior |
|---|---|
| `muse_single` | 1:1 thread with one Muse (`chat`, `image`, `video` + up to 4 Dropbox file attachments ≤ 50 MB). |
| `muse_group` | Owner-initiated group chat backed by `relay_groups`. `submit_result` fans out replies to other Muse members up to `GROUP_TURN_LIMIT = 12`. |
| `openai` | Server-proxied `POST /api/openai/chat` to one or more OpenAI-compatible agents, stored in `relay_openai_messages`. |
| `mixed` | Broadcasts each owner prompt simultaneously to both Muse Relay agents and OpenAI-compatible agents in a single unified timeline. |

---

## 6. Running Acceptance Tests & Troubleshooting

### 6.1 Running the Live Acceptance Suite

[`scripts/acceptance-tests.sh`](../scripts/acceptance-tests.sh) runs **53 live assertions** against your deployed Supabase project using an isolated temporary directory (leaving zero leftover files in the repo) and cleans up test rows automatically:

```bash
bash scripts/acceptance-tests.sh
```

Expected final line:

```text
RESULT: PASS=53 FAIL=0
```

> **Note**: Ensure a valid Muse `RELAY_TOKEN` and matching `RELAY_RECIPIENT_ID` are set in `.env` before running the suite.

### 6.2 Troubleshooting

| Symptom | Cause & Fix |
|---|---|
| **`GET /api/config` shows `dropboxConfigured: false` or uploads return `503 dropbox_not_configured`** | Set `DROPBOX_APP_KEY`, `DROPBOX_APP_SECRET`, and `DROPBOX_REFRESH_TOKEN` (or a temporary `DROPBOX_ACCESS_TOKEN`) in `.env` and restart `server/`. Ensure the Dropbox Scoped App has `files.metadata.read`, `files.content.read`, and `files.content.write`. |
| **API or Edge Function returns `401` / `403 forbidden`** | Check that you signed in with the exact Supabase Auth user matching `RELAY_OWNER_ID` in both `.env` and `supabase secrets`. For Muse calls (`claim_message` / `submit_result`), verify `x-relay-token` matches the SHA-256 `token_hash` in `relay_muses`. |
| **Direct Muse composer is locked ("Waiting for Muse setup")** | `relay_muses.setup_done` is still `false`. Confirm the Muse has the right `SUPABASE_URL` and `RELAY_TOKEN` in its vault and has made at least one `POST /functions/v1/claim_message` call. |
| **Verify a Muse's `RELAY_TOKEN` hash locally** | Without sending the token over the network, run:<br>`python -c "import hashlib; print(hashlib.sha256(input().encode()).hexdigest())"`<br>and compare the output to `select token_hash from public.relay_muses where name = '<Muse>';` in Supabase SQL Editor. |
| **Node error `Cannot read properties of undefined` / `import.meta.dirname` undefined** | Upgrade Node.js to **>= 20.11** (`node -v`). |
| **Windows errors running `.sh` scripts** | Run `bash scripts/...` inside **Git Bash** with **Python 3** (`python`) available on `PATH`. |
