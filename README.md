**English** | [Tiếng Việt](README.vi.md)

# Muse Relay

> Asynchronous command center and Supabase relay connecting an owner dashboard with distributed Muse AI agents (each isolated to its own Dropbox root) and OpenAI-compatible endpoints.

Muse Relay lets a single authenticated owner dispatch `chat`, `image`, and `video` jobs to independent Muse agents, organize agents into **Projects & Conversations**, preview or upload files directly to each Muse's Dropbox root, and chat with OpenAI-compatible `/chat/completions` endpoints. The stack pairs a Supabase relay backend (Auth, Postgres, Storage, and 3 Deno Edge Functions) with a **Node.js (>= 20.11) + Express 5 + TypeScript** backend (`server/`) and a **React 18 + Vite 6 + TypeScript** SPA (`dashboard/`).

---

## Quick Start

> **Prerequisites**: **Node.js >= 20.11** (required for `import.meta.dirname` in `server/`), **npm**, a **Supabase project**, and on Windows **Git Bash + Python 3** for `.sh` scripts. See the full [Setup Guide](docs/setup-guide.md) for step-by-step instructions.

```bash
# 1. Configure environment variables (14 vars, see .env.example)
cp .env.example .env

# 2. Install dependencies for both server/ and dashboard/
npm run install:all

# 3. Verify TypeScript types across server/ and dashboard/
npm run typecheck

# 4. Run development mode (Express on :3000 + Vite HMR on :5173 with /api proxy)
npm run dev
```

For **production** (compiles `server/dist/` and `dashboard/dist/`, then serves `/api/*` and the built SPA on one port `PORT`, default `3000`):

```bash
npm run build
npm start
```

Deploy Supabase migrations & Edge Functions, then run the 68-assertion live acceptance suite:

```bash
npx --yes supabase db push            # applies all 11 migrations (000000..01100); see note below
bash scripts/deploy-functions.sh      # deploys submit_message, claim_message, submit_result
bash scripts/acceptance-tests.sh      # expects RESULT: PASS=68 FAIL=0
```

> Note: the remote project tracks no CLI migration history (migrations were
> applied via the Management API), so `db push` would replay every migration.
> Apply new migrations individually (they are additive + idempotent); rollback
> for the group-rules migration lives in `scripts/rollback-group-rules.sql`.

---

## Why `server/` Exists

All browser-sensitive configuration, Dropbox transfers, OpenAI proxy calls, and production static hosting run through [`server/`](server/src/index.ts):

1. **Runtime `.env` configuration (`GET /api/config`)**: Loads `.env` at runtime and exposes `{ supabaseUrl, supabasePublishableKey, ownerDisplayName, dropboxConfigured }` with `Cache-Control: no-store`. [`dashboard/src/lib/config.ts`](dashboard/src/lib/config.ts) (`loadRuntimeConfig`) fetches this before initializing Supabase, so `dashboard/dist/` contains **zero hardcoded Supabase URLs or keys**.
2. **Direct Dropbox proxy (`POST /api/dropbox/temp-link`, `POST /api/dropbox/upload`)**: Authenticated by the owner's Supabase JWT (`requireOwnerAuth`), `server/` calls Dropbox API directly using credentials in `.env`. Uploads accept up to **50 MB** raw `application/octet-stream` payloads and write directly under the target Muse's `dropbox_root` (`0` Supabase egress, replacing the removed `dropbox_proxy` Edge Function).
3. **Server-side OpenAI proxy (`POST /api/openai/test`, `POST /api/openai/chat`)**: Verifies the owner's JWT, queries `relay_agents_openai` through Supabase PostgREST with owner RLS, prepends `system_prompt` server-side, and forwards requests to `/chat/completions` from Node (avoiding browser CORS limits and keeping API keys out of browser chat payloads).
4. **Single-port production serving**: When `dashboard/dist/index.html` exists, `server/` serves both `/api/*` and the built React SPA on `PORT` (default `3000`). In dev, [`dashboard/vite.config.ts`](dashboard/vite.config.ts) proxies `/api` to `VITE_API_ORIGIN` (default `http://127.0.0.1:3000`).

---

## Architecture & Invariants

```text
Browser (React 18 + Vite 6 + TypeScript SPA — dashboard/)
    ├──► Express 5 Server (Node.js >= 20.11 + TypeScript — server/)
    │      ├─ GET  /api/health             Liveness check
    │      ├─ GET  /api/config             Runtime config from .env (Cache-Control: no-store)
    │      ├─ POST /api/dropbox/temp-link  Owner JWT → Dropbox temporary link (0 Supabase egress)
    │      ├─ POST /api/dropbox/upload     Owner JWT → raw binary ≤50 MB to Muse dropbox_root
    │      ├─ POST /api/openai/test        Owner JWT → server-side /chat/completions probe
    │      ├─ POST /api/openai/chat        Owner JWT → RLS lookup + server-side /chat/completions
    │      └─ GET  /*                      Serves dashboard/dist/ static SPA in production
    │
    └──► Supabase (Auth + Postgres + Storage + 3 Deno Edge Functions)
           ├─ Supabase Auth (owner email/password; public sign-ups disabled)
           ├─ Owner-only RLS PostgREST reads/writes
           └─ submit_message (verify_jwt = true; verifies owner allowlist, signs HMAC-SHA256)
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
         Muse ×N
           ├─ claim_message (x-relay-token → SHA-256 in relay_muses; stamps last_claim_at & setup_done)
           ├─ Executes job → writes outputs under its assigned Dropbox root
           └─ submit_result (validates claim lease + dropbox_root prefix; stamps last_result_at)
```

### Invariant Principles

1. **Nyx is production-frozen** — Never alter `relay_messages` or `relay_results` in breaking ways; all schema changes must be strictly additive and verified with `bash scripts/acceptance-tests.sh` (`PASS=68 FAIL=0`).
2. **No privileged Muse (fail-closed)** — All Muse auth resolves `sha256(x-relay-token)` against `relay_muses`. Any miss or lookup error returns `401` with no fallback. Every `submit_message` must target an explicit `recipient` UUID or `group_id`.
3. **`RELAY_TOKEN` stays in the Muse's Secure Vault** — Never send tokens through chat, logs, or files; the dashboard displays them once during creation (`AddMuseWizard.tsx`) or rotation (`MuseManage.tsx`).
4. **Minimal Edge Function secrets; runtime `.env` on `server/`** — Edge Functions use only `RELAY_SIGNING_SECRET` and `RELAY_OWNER_ID`. Dropbox and server settings live exclusively in the root `.env` read by `server/`.

For full protocol schemas, RLS policies, and `relay_muses` telemetry rules (`setup_done`, `first_connected_at`, `last_claim_at`, `last_result_at`, `token_rotated_at`), see [`docs/architecture.md`](docs/architecture.md).

---

## Folder Structure

```text
package.json                       Root scripts: install:all, dev, build, start, typecheck
.env.example                       Annotated template for all 14 environment variables
docs/
  ├─ README.md                     Documentation index (EN + VI)
  ├─ setup-guide.md                Full setup, deployment, dashboard & troubleshooting guide (EN)
  ├─ setup-guide.vi.md             Full setup, deployment, dashboard & troubleshooting guide (VI)
  ├─ architecture.md               Architecture, schemas, Edge Function contracts & security invariants
  └─ examples/submit-example.ts    TypeScript client example invoking submit_message
server/                            Node.js (>= 20.11) + Express 5 + TypeScript backend
  ├─ package.json                  Scripts: dev (tsx watch), typecheck, build (tsc), start
  ├─ tsconfig.json                 TypeScript NodeNext config (src/ → dist/)
  └─ src/
     ├─ index.ts                   Express app, /api/* routes, 50 MB raw upload parser, static SPA
     ├─ env.ts                     Runtime .env loader and validator
     ├─ auth.ts                    requireOwnerAuth middleware (Supabase JWT + RELAY_OWNER_ID)
     ├─ dropbox.ts                 OAuth refresh-token cache + /api/dropbox/{temp-link,upload}
     ├─ openai.ts                  /api/openai/{test,chat} proxy (RLS lookup + system_prompt)
     └─ supabase.ts                supabaseRestSelectSingle helper using owner JWT + RLS
dashboard/                         React 18 + Vite 6 + TypeScript frontend SPA
  ├─ index.html                    Entrypoint with pre-paint theme & language boot script
  ├─ package.json                  Scripts: dev, build (tsc --noEmit && vite build), preview
  ├─ vite.config.ts                Dev server proxy (/api → VITE_API_ORIGIN or http://127.0.0.1:3000)
  └─ src/
     ├─ main.tsx                   Calls loadRuntimeConfig() and initSupabase() before mount
     ├─ App.tsx                    Root state, auth session, 10s fleet polling, room routing
     ├─ types.ts                   Shared domain types matching the Supabase schema
     ├─ lib/
     │  ├─ api.ts                  Supabase REST, Edge Functions, /api/dropbox/* & /api/openai/* clients
     │  ├─ config.ts               Fetches runtime config from GET /api/config (no-store)
     │  ├─ dropbox.ts              Dropbox root normalization (/email/), 50 MB / 4-file helpers
     │  ├─ format.ts               ownerState, summarizeMuseFleet, museConnectionInfo telemetry
     │  ├─ i18n.ts                 EN/VI translation dictionary & hook (localStorage: muse_relay_lang)
     │  ├─ instructions.ts         Canonical onboarding prompt builder for new Muses
     │  ├─ supabase.ts             Lazy-initialized Supabase browser client
     │  └─ theme.ts                Dark/Light theme state hook (localStorage: muse_relay_theme)
     ├─ components/
     │  ├─ common/                 Icons.tsx, TokenPanel.tsx, ui.tsx
     │  ├─ layout/                 LoginView.tsx, Sidebar.tsx, InspectorPanel.tsx
     │  ├─ chat/                   Composer.tsx, MarkdownBody.tsx, MessageBubble.tsx
     │  ├─ views/                  OverviewView.tsx, AgentsAdminView.tsx, ProjectView.tsx,
     │  │                          MuseRoom.tsx, ConversationRoom.tsx
     │  └─ modals/                 AddMuseWizard.tsx, MuseManage.tsx, OpenAIAgentModal.tsx,
     │                             ProjectWizard.tsx, NewConversationModal.tsx
     └─ styles/                    tokens.css (Dark/Light tokens) + app.css
supabase/
  ├─ config.toml                   JWT verification flags (submit_message=true; claim/result=false)
  ├─ README.md                     Detailed Vietnamese backend spec (migrations, contracts, ops)
  ├─ functions/                    3 active Edge Functions (dropbox_proxy removed → server/)
  │  ├─ _shared/relay.ts           HMAC-SHA256 signing, SHA-256 lookup, validation, group fan-out
  │  ├─ submit_message/index.ts    Owner submission (direct recipient or group_id)
  │  ├─ claim_message/index.ts     Muse poll/claim (validates x-relay-token, stamps heartbeat)
  │  └─ submit_result/index.ts     Muse completion (validates lease + dropbox_root, group fan-out)
  └─ migrations/                   11 strictly additive SQL migrations:
     ├─ 20261127000000_relay.sql
     ├─ 20261127000100_relay_chat.sql
     ├─ 20261127000200_recipient_hash.sql
     ├─ 20261127000300_relay_muses.sql
     ├─ 20261127000400_relay_groups.sql
     ├─ 20261127000500_relay_muses_last_claim.sql
     ├─ 20261127000550_relay_projects.sql
     ├─ 20261127000600_cleanup_legacy_and_owner_delete.sql
     ├─ 20261127000700_muse_connection_state.sql
     ├─ 20261127000800_relay_muses_email_owner.sql
     ├─ 20261127000900_relay_muses_caps.sql
     ├─ 20261128001000_backfill_group_thread_id.sql
     └─ 20261128001100_group_rules.sql
scripts/
  ├─ deploy-functions.sh           Deploys submit_message, claim_message, submit_result using .env
  ├─ rollback-group-rules.sql      Reverse of migration 20261128001100 (drop the 2 v9 columns)
  └─ acceptance-tests.sh           Live 68-assertion acceptance suite using isolated temp directory
```

---

## Documentation

- [`docs/README.md`](docs/README.md) — Documentation index (English & Vietnamese).
- [`docs/setup-guide.md`](docs/setup-guide.md) — Step-by-step setup, deployment, dashboard usage, acceptance tests & troubleshooting ([Vietnamese version](docs/setup-guide.vi.md)).
- [`docs/architecture.md`](docs/architecture.md) — System architecture, Express routes, React modules, Supabase schema/RLS, Muse contracts, and telemetry.
- [`supabase/README.md`](supabase/README.md) — Detailed Vietnamese Supabase schema, Muse contract, and operations spec.
- [`docs/examples/submit-example.ts`](docs/examples/submit-example.ts) — Client example for `submit_message`.
- [`.env.example`](.env.example) — Annotated template for all 14 environment variables.
