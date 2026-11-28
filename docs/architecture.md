# Architecture & Security Reference

This document describes the technical architecture, component layout, database schema, Edge Function contracts, telemetry model, and security invariants of **Muse Relay**.

---

## 1. High-Level Topology

```text
Browser (React 18 + Vite 6 + TypeScript SPA — dashboard/)
    ├──► Express 5 Server (Node.js >= 20.11 + TypeScript — server/)
    │      ├─ GET  /api/health             Liveness probe
    │      ├─ GET  /api/config             Runtime config from .env (Cache-Control: no-store)
    │      ├─ POST /api/dropbox/temp-link  Owner JWT → Dropbox temporary link (0 Supabase egress)
    │      ├─ POST /api/dropbox/upload     Owner JWT → raw binary ≤50 MB to Muse dropbox_root
    │      ├─ POST /api/openai/test        Owner JWT → server-side /chat/completions probe (20s timeout)
    │      ├─ POST /api/openai/chat        Owner JWT → RLS lookup + server-side /chat/completions (60s timeout)
    │      └─ GET  /*                      Serves dashboard/dist/ static SPA in production
    │
    └──► Supabase (Auth + Postgres + Storage + 3 Deno Edge Functions)
           ├─ Supabase Auth (owner email/password; public sign-ups disabled)
           ├─ Owner-only RLS PostgREST reads/writes
           ├─ Storage bucket `relay-inputs` (private, owner-scoped `<owner_id>/...`)
           └─ submit_message (verify_jwt = true; checks owner allowlist, validates params, signs HMAC-SHA256)
                │
                ▼
         Supabase Postgres (10 strictly additive migrations)
           ├─ relay_messages / relay_results (production-frozen for Nyx)
           ├─ relay_muses (SHA-256 token_hash registry, fail-closed, live telemetry)
           ├─ relay_groups / relay_group_members / relay_group_posts (v6 group fan-out)
           └─ relay_agents_openai / relay_projects / relay_project_agents /
              relay_conversations / relay_openai_messages (v7 projects & conversations)
                │
                ▼
         Muse Agents ×N
           ├─ claim_message (verify_jwt = false; x-relay-token → SHA-256 in relay_muses; stamps last_claim_at)
           ├─ Executes job → writes outputs under assigned Dropbox root (`/<email>/`)
           └─ submit_result (verify_jwt = false; validates claim lease + dropbox_root prefix; stamps last_result_at)
```

---

## 2. The Four Invariant Principles

Any change to migrations, Edge Functions, `server/`, or `dashboard/` must preserve these four invariants:

1. **Nyx is production-frozen**
   - `relay_messages` and `relay_results` schemas must never be altered in breaking ways (`ALTER TABLE` altering existing columns/contracts is forbidden).
   - All schema updates must be strictly additive, backward-compatible, and verified against a live Supabase project with `bash scripts/acceptance-tests.sh` (`PASS=53 FAIL=0`).
2. **No privileged Muse (fail-closed registry)**
   - Every Muse — including Nyx — is registered as a row in `relay_muses` and authenticated solely by matching `sha256(x-relay-token)` against `relay_muses.token_hash`.
   - Any missing token, unknown hash, or registry lookup error returns `401 unauthorized` with **zero fallback** to any default Muse or env variable.
   - Every direct `submit_message` call must explicitly specify `recipient` (UUID) or `group_id`. Missing `recipient` returns `400`; unknown `recipient` returns `403 recipient_mismatch`.
3. **`RELAY_TOKEN` lives only in the Muse's Secure Vault**
   - Plaintext Muse tokens are never stored in Postgres (`relay_muses` stores only lowercase 64-hex SHA-256 hashes), never sent in chat, and never written to logs or files.
   - The dashboard displays a generated token **once** during creation (`AddMuseWizard.tsx`) or token rotation (`MuseManage.tsx`).
4. **Minimal Edge Function secrets; runtime `.env` on `server/`**
   - Supabase Edge Functions require only **2 secrets**: `RELAY_SIGNING_SECRET` (HMAC-SHA256) and `RELAY_OWNER_ID` (owner UUID allowlist).
   - The legacy `dropbox_proxy` Edge Function has been removed. All Dropbox OAuth credentials, server port, display name, and Supabase public config live in the root `.env` read by `server/` at runtime.

---

## 3. Express Backend (`server/`)

Implemented in [`server/src/index.ts`](../server/src/index.ts), `server/` uses Node.js >= 20.11 (`import.meta.dirname` for resolving `.env` and `dashboard/dist/`).

### Environment Loading ([`server/src/env.ts`](../server/src/env.ts))

At startup, `env.ts` searches for `.env` in `../../.env` (relative to `server/src` or `server/dist`), then `.env` and `../.env` relative to `cwd`.
Required variables: `SUPABASE_URL` (HTTP/HTTPS URL), `SUPABASE_PUBLISHABLE_KEY`. Optional: `PORT` (default `3000`), `OWNER_DISPLAY_NAME` (default `Owner`), `RELAY_OWNER_ID`, `SUPABASE_SECRET_KEY`, and `DROPBOX_*`.

### Owner Auth Middleware ([`server/src/auth.ts`](../server/src/auth.ts))

`requireOwnerAuth`:
1. Extracts the `Authorization: Bearer <jwt>` header (missing → `401 unauthorized`).
2. Verifies the JWT against `${SUPABASE_URL}/auth/v1/user` with `apikey: SUPABASE_PUBLISHABLE_KEY` (invalid → `401 unauthorized`, upstream error → `502 auth_upstream_error`).
3. If `RELAY_OWNER_ID` is set in `.env`, enforces `user.id.toLowerCase() === RELAY_OWNER_ID.toLowerCase()` (mismatch → `403 forbidden`).
4. Attaches `req.auth = { userId, jwt }`.

### HTTP Endpoints

| Method & Path | Auth | Behavior |
|---|---|---|
| `GET /api/health` | Public | Returns `{ ok: true }`. |
| `GET /api/config` | Public | Serves `{ supabaseUrl, supabasePublishableKey, ownerDisplayName, dropboxConfigured }` with `Cache-Control: no-store`. Ensures `dashboard/dist/` embeds zero keys. |
| `POST /api/dropbox/temp-link` | `requireOwnerAuth` | Validates Dropbox path (`/...`, no `..`, ≤ 512 chars), refreshes OAuth access token in memory if needed, calls `2/files/get_temporary_link`, returns `{ link, name, size, path }`. Returns `503 dropbox_not_configured` if Dropbox credentials are missing. |
| `POST /api/dropbox/upload` | `requireOwnerAuth` | Accepts `application/octet-stream` up to **50 MB** (`413 payload_too_large` if exceeded). Reads `x-recipient` (UUID), `x-file-name` (URI-encoded), and optional `x-thread-id` (`^[A-Za-z0-9_-]{1,64}$`, defaults to `uploads`). Looks up `relay_muses.dropbox_root` via PostgREST with the owner's JWT (RLS), sanitizes the filename, prefixes it with an `Asia/Bangkok` timestamp (`yyyy-mm-dd_hh-mm-ss_<name>`), and uploads directly to `${dropbox_root}/${folder}/${stamp}_${name}`. |
| `POST /api/openai/test` | `requireOwnerAuth` | Tests `/chat/completions` connectivity (by `agent_id` via RLS lookup or inline `base_url`/`model`/`api_key`) with a 20s timeout; returns `{ ok, latencyMs, reply, error }`. |
| `POST /api/openai/chat` | `requireOwnerAuth` | Looks up `relay_agents_openai` by `agent_id` via owner RLS, prepends `system_prompt` server-side, and sends a non-streaming `/chat/completions` call (`stream: false`, 60s timeout). Returns `{ content, error }`. |
| `GET /*` | Public | When `dashboard/dist/index.html` exists, serves the built SPA and falls back to `index.html` for non-`/api/` GET routes. |

---

## 4. React Dashboard (`dashboard/`)

Built with React 18, Vite 6, and TypeScript:

- **Runtime boot ([`dashboard/src/main.tsx`](../dashboard/src/main.tsx) & [`dashboard/src/lib/config.ts`](../dashboard/src/lib/config.ts))**: Calls `loadRuntimeConfig()` (`GET /api/config` with `cache: "no-store"`) and initializes the lazy Supabase client (`initSupabase()`) before mounting React.
- **Pre-paint theme & language ([`dashboard/index.html`](../dashboard/index.html), [`theme.ts`](../dashboard/src/lib/theme.ts), [`i18n.ts`](../dashboard/src/lib/i18n.ts))**: Persists `muse_relay_theme` (`dark`/`light`) and `muse_relay_lang` (`en`/`vi`) in `localStorage`.
- **Component organization (`dashboard/src/components/`)**:
  - `common/` — `Icons.tsx` (SVG icon set), `TokenPanel.tsx` (one-time token display), `ui.tsx` (shared `Modal`, `Chip`, `ErrorMsg`, `LangToggle`, `ToastHost`, `copyText`, `setButtonBusy`).
  - `layout/` — `LoginView.tsx` (owner sign-in + theme/language controls), `Sidebar.tsx` (navigation rail for Overview, Agent Admin, Projects & Conversations, Direct Muses, theme/lang toggles), `InspectorPanel.tsx` (context drawer for Muse telemetry, Dropbox paths, or project/conversation details).
  - `chat/` — `Composer.tsx` (prompt input, `chat`/`image`/`video` mode selector, `aspect_ratio`, `count`, `duration_seconds`, `resource_type`, `output_format`, `thread_id`, and up to 4 file attachments ≤ 50 MB), `MarkdownBody.tsx` (markdown & syntax-labeled code block renderer), `MessageBubble.tsx` (owner/agent message bubbles, Dropbox resource cards, URL previews).
  - `views/` — `OverviewView.tsx` (fleet KPIs & 10s-polled activity feed), `AgentsAdminView.tsx` (Muse + OpenAI agent registry management & live test), `ProjectView.tsx` (project details, assigned agents, conversation list), `MuseRoom.tsx` (direct 1:1 channel locked until `setup_done = true`), `ConversationRoom.tsx` (unified timeline for `muse_single`, `muse_group`, `openai`, and `mixed` modes).
  - `modals/` — `AddMuseWizard.tsx` (2-step Muse creation + canonical onboarding prompt), `MuseManage.tsx` (rename, rotate token, delete Muse, clear direct history), `OpenAIAgentModal.tsx` (CRUD for OpenAI-compatible endpoints), `ProjectWizard.tsx` (create/edit project & assign agents), `NewConversationModal.tsx` (launch conversation in any of the 4 modes).

---

## 5. Supabase Database Schema & Migrations

All 10 migrations in [`supabase/migrations/`](../supabase/migrations/) are strictly additive:

| Migration | Purpose |
|---|---|
| `20261127000000_relay.sql` | Creates `relay_messages`, `relay_results`, indexes, owner-select RLS, and private `relay-inputs` storage bucket with owner-scoped policies. |
| `20261127000100_relay_chat.sql` | Ensures `relay_messages.action` check constraint allows `'chat'`, `'image'`, `'video'`. |
| `20261127000200_recipient_hash.sql` | Relaxes `relay_messages.recipient` check to allow lowercase UUIDs alongside `'nyx'`. |
| `20261127000300_relay_muses.sql` | Creates `relay_muses` (`recipient`, `name`, `token_hash` 64-hex SHA-256 unique partial index, `dropbox_root` validated `/.../` without `..`, owner-all RLS). |
| `20261127000400_relay_groups.sql` | Creates `relay_groups`, `relay_group_members`, and `relay_group_posts` (owner-read-only posts written by Edge Functions via service role). |
| `20261127000500_relay_muses_last_claim.sql` | Adds `last_claim_at` (`timestamptz`) heartbeat column to `relay_muses`. |
| `20261127000550_relay_projects.sql` | Creates v7 tables: `relay_agents_openai`, `relay_projects`, `relay_project_agents`, `relay_conversations`, `relay_openai_messages` with strict owner-only RLS. |
| `20261127000600_cleanup_legacy_and_owner_delete.sql` | Grants authenticated owner `DELETE` on `relay_messages` and `relay_results` (via RLS) and cleans up legacy pre-v7 rows while keeping `relay_muses` intact. |
| `20261127000700_muse_connection_state.sql` | Adds `setup_done`, `first_connected_at`, `last_result_at`, `token_rotated_at` to `relay_muses`, backfills existing connected Muses, and creates trigger `trg_relay_muses_connection_state` (`sync_muse_connection_state()`). |
| `20261127000800_relay_muses_email_owner.sql` | Adds `email_owner` metadata column to `relay_muses` so the owner email is stored cleanly alongside derived `dropbox_root`. |

---

## 6. Edge Functions & Muse Contract

Configured in [`supabase/config.toml`](../supabase/config.toml):
- [`submit_message`](../supabase/functions/submit_message/index.ts): `verify_jwt = true`.
- [`claim_message`](../supabase/functions/claim_message/index.ts): `verify_jwt = false` (uses `x-relay-token`).
- [`submit_result`](../supabase/functions/submit_result/index.ts): `verify_jwt = false` (uses `x-relay-token`).

### Message Signing ([`_shared/relay.ts`](../supabase/functions/_shared/relay.ts))

`submit_message` signs every inserted `relay_messages` row using HMAC-SHA256 (`RELAY_SIGNING_SECRET`) over a deterministic canonical JSON representation (`stableStringify` with sorted keys) of:
`{ action, expires_at_unix, id, nonce, owner_id, params, recipient }`.

`claim_message` re-computes and timing-safe-compares this signature before leasing a message. If manual SQL edits tamper with `params` or other signed fields, `claim_message` marks the message `failed`, inserts an `invalid_signature` row in `relay_results`, and moves on to the next candidate.

`validateParams` whitelists every param key per action. `chat` accepts an optional `command` — only the value `"usage"` (`400` otherwise), forwarded verbatim into the signed row params (direct + group fan-out) so muses can react to machine commands like the /usage quota check.

### `claim_message` Contract

- **Request**: `POST /functions/v1/claim_message` with header `x-relay-token: <token>` and JSON body `{}`.
- **Auth & Heartbeat**: `resolveMuse(req)` computes `sha256Hex(x-relay-token)` and queries `relay_muses`. On success, stamps `last_claim_at = now()` and `setup_done = true` even if no messages are pending (the DB trigger populates `first_connected_at` on first claim).
- **Candidate Selection**: Filters `recipient = muse.recipient`, `status = 'pending'`, `expires_at_unix > nowUnix` (30-minute submission TTL), ordered oldest first, scoped to `RELAY_OWNER_ID` if set.
- **Claim Lease**: Atomically transitions `pending` → `processing`, sets a 30-minute `claim_expires_at`, generates a `claim_id` UUID, increments `attempts`, and creates 1-hour signed download URLs for any `reference_storage_paths` in `relay-inputs`.
- **Response**: `{ message: null }` when empty, or `{ message: { id, claim_id, recipient, action, params, reference_signed_urls, claim_expires_at } }`.
- **Group Context (v9, additive)**: when the claimed row belongs to a group (has a `relay_group_posts` row), the response also carries `group: { system_prompt, history }`. `system_prompt` is the stored `relay_groups.rules` regulation text, included only on the muse's **first** claim in that group (per-member cursor `relay_group_members.last_seen_at` is null). `history` lists every prior group utterance — owner fan-out batches + muse `relay_results` replies — that this muse has never received, oldest first, capped at the 30 most recent entries with ≤ 2000 chars each; the currently claimed utterance is never duplicated into `history`. Direct (non-group) claims carry no `group` key and the `message` shape is byte-for-byte unchanged.
- **Group Rules Generation (v9)**: the first `submit_message` addressed to a group (mention fan-out or record-only) generates the regulation text (`buildGroupRules`: group name, member roster as `@Name`, reply/tag discipline, 12-turn cap) and stores it in `relay_groups.rules` (idempotent `rules is null` guard). Pre-existing groups get theirs on the first send after deploy; the dashboard renders it as the collapsed "System prompt" block via `fetchGroupThread`.
- **Mention Routing Enforcement (v9 owner ruling)**: `parseMentionTargets` is speaker-aware. `@all` works only for owner-sent utterances (`speakerRecipient = null` in `submit_message`); inside a muse reply (`submit_result` chain) `@all` is silently ignored like an unknown mention, and a muse reply tagging **more than one** distinct member fans out to NOBODY (chain stops) — a muse steers the work with at most one `@Name` per output; multi-agent involvement goes through one coordinator mention or separate turns. The owner keeps full power (`@all`, multi-mention).

### `submit_result` Contract

- **Request**: `POST /functions/v1/submit_result` with `x-relay-token: <token>` and body:
  ```json
  {
    "message_id": "<uuid>",
    "claim_id": "<uuid>",
    "status": "done",
    "output": {
      "dropbox_paths": ["/muse@example.com/thread-1/2026-11-27_14-05-00_output.png"],
      "notes": null,
      "text": "Optional summary or required chat reply"
    },
    "error": null
  }
  ```
- **Validation**:
  - `message.recipient === muse.recipient` (`403 recipient_mismatch` otherwise).
  - `message.status === 'processing'` and `message.claim_id === body.claim_id` (`409 claim_mismatch` otherwise).
  - `claim_expires_at >= now()` (`409 claim_expired` otherwise).
  - Every item in `output.dropbox_paths` (max 8) must start with `muse.dropboxRoot`, contain no `..`, and be ≤ 512 chars (`400` otherwise).
  - `done` + `chat` requires non-empty `output.text` (≤ 8000 chars).
  - `done` + `image`/`video` requires at least 1 path in `output.dropbox_paths`.
  - `failed` accepts either `error` or `error_code` (e.g., `"out_of_scope"`, ≤ 2000 chars).
- **Group Chain Fan-Out**: If `status === 'done'` and `action === 'chat'` and the message belongs to `relay_group_posts` with `turn < GROUP_TURN_LIMIT` (`12`), `submit_result` automatically spawns pending `chat` rows (at `turn + 1`) for all **other** group members using `"[<Muse Name>]: <truncated text>"` (≤ 3800 chars). Owner messages always reset `turn = 1`.

---

## 7. Live `relay_muses` Telemetry

The dashboard (`museConnectionInfo` in [`dashboard/src/lib/format.ts`](../dashboard/src/lib/format.ts)) derives connection status from `relay_muses` columns:

| State | Condition | Meaning |
|---|---|---|
| `not_setup` | `!setup_done && !last_claim_at` | Newly created Muse; daemon has never polled `claim_message` yet. Direct room Composer is locked. |
| `reconnecting` | `token_rotated_at > last_claim_at` | Owner rotated the token; waiting for the Muse daemon to poll with the new `RELAY_TOKEN`. |
| `live` | `now - last_claim_at ≤ 3 min` | Muse daemon is actively polling within the 3-minute live window. |
| `standby` | `3 min < now - last_claim_at ≤ 15 min` | Muse polled recently (within watchdog interval). |
| `offline` | `now - last_claim_at > 15 min` | No recent `claim_message` heartbeat. |
