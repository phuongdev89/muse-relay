**English** | [Tiếng Việt](README.vi.md)

# Muse Relay

> Asynchronous command center and Supabase relay connecting an owner dashboard with distributed Muse AI agents (each isolated to its own Dropbox root) and OpenAI-compatible endpoints.

Muse Relay lets a single authenticated owner dispatch `chat`, `image`, and `video` jobs to independent Muse agents, organize agents into **Projects & Conversations**, and talk directly to OpenAI-compatible `/chat/completions` endpoints from a static React dashboard. The backend runs on Supabase (Auth, Postgres, Storage, and Deno Edge Functions); the frontend builds to static assets in `dashboard/dist/`.

---

## Architecture

```
Dashboard (React + Vite + TypeScript, static bundle)
    │  Supabase Auth (owner email/password; public sign-ups disabled) + owner-only RLS REST reads
    │  submit_message (Edge Function: verifies owner JWT, validates params, signs HMAC-SHA256)
    │  OpenAI-compatible agents → direct POST .../chat/completions (persisted to relay_openai_messages)
    ▼
Supabase Postgres ── relay_messages / relay_results (production-frozen for Nyx)
    │                relay_muses (SHA-256 token_hash registry, fail-closed, live telemetry)
    │                relay_groups / relay_group_members / relay_group_posts (v6 group fan-out)
    │                relay_agents_openai / relay_projects / relay_project_agents /
    │                relay_conversations / relay_openai_messages (v7 projects & conversations)
    ▼
Muse ×N ── claim_message (x-relay-token → SHA-256 match in relay_muses; stamps last_claim_at)
    │       executes job → writes outputs under its assigned Dropbox root
    └───── submit_result (validates claim lease + dropbox_root prefix; stamps last_result_at)
```

### Invariant Principles

Read these four rules before modifying any database migration, Edge Function, or dashboard API call:

1. **Nyx is production-frozen** — Do not alter `relay_messages` or `relay_results`. Every schema or function change must be strictly additive, backward-compatible, and verified with a clean `scripts/acceptance-tests.sh` run.
2. **No privileged Muse (fail-closed registry)** — All Muse authentication resolves `x-relay-token` by its SHA-256 hash in `relay_muses`. Any lookup miss or registry error returns `401` with no fallback. Every `submit_message` call must explicitly specify a `recipient` UUID or `group_id` — there is no default Muse.
3. **`RELAY_TOKEN` stays in the Muse's Secure Vault** — Never send tokens through chat, logs, or files. The dashboard displays a Muse token once during creation (`AddMuseWizard.tsx`) or rotation (`MuseManage.tsx`).
4. **Exactly two server secrets** — Supabase Edge Functions rely only on `RELAY_SIGNING_SECRET` (HMAC-SHA256 message signing/verification) and `RELAY_OWNER_ID` (owner UUID allowlist).

---

## Live `relay_muses` Telemetry

Added via [`20261127000500_relay_muses_last_claim.sql`](supabase/migrations/20261127000500_relay_muses_last_claim.sql) and [`20261127000700_muse_connection_state.sql`](supabase/migrations/20261127000700_muse_connection_state.sql) (with trigger `trg_relay_muses_connection_state` calling `sync_muse_connection_state()`), `relay_muses` tracks real-time setup and heartbeat telemetry for each agent:

| Column | Type | Meaning |
|--------|------|---------|
| `setup_done` | `boolean` | Automatically set to `true` by trigger/claim once the Muse makes its first authenticated `claim_message` call. |
| `first_connected_at` | `timestamptz` | Timestamp of the Muse's first successful `claim_message` poll. |
| `last_claim_at` | `timestamptz` | Stamped on every authorized `claim_message` poll (even when the queue is empty). |
| `last_result_at` | `timestamptz` | Stamped best-effort on every successful `submit_result` call. |
| `token_rotated_at` | `timestamptz` | Set when the owner rotates the Muse's token from the dashboard; if newer than `last_claim_at`, the UI shows a reconnecting state until the Muse polls with the new token. |

In `dashboard/src/lib/format.ts` (`museConnectionInfo`), the dashboard derives live status badges from these timestamps: `not_setup`, `reconnecting`, `live` (`last_claim_at` ≤ 3 minutes), `standby` (`last_claim_at` ≤ 15 minutes), or `offline`.

---

## Folder Structure

```text
dashboard/                         Static React 18 + Vite 6 + TypeScript web app
  ├─ index.html                    Entrypoint with pre-paint theme and language boot script
  ├─ package.json                  Scripts: dev, build, preview
  └─ src/
     ├─ App.tsx                    Root state, auth session, 10s fleet polling, room routing
     ├─ types.ts                   Shared domain types matching the Supabase schema
     ├─ lib/
     │  ├─ api.ts                  Supabase REST queries, Edge Function calls, OpenAI /chat/completions client
     │  ├─ config.ts               Public SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, OWNER_DISPLAY_NAME
     │  ├─ dropbox.ts              Dropbox root normalization (email → /email/) and resource path helpers
     │  ├─ format.ts               Message ownerState, summarizeMuseFleet, museConnectionInfo telemetry
     │  ├─ i18n.ts                 EN/VI translation dictionary & hook persisted to localStorage (muse_relay_lang)
     │  ├─ instructions.ts         Canonical onboarding prompt builder for newly created Muses
     │  ├─ supabase.ts             Supabase browser client
     │  └─ theme.ts                Dark/Light theme state hook persisted to localStorage (muse_relay_theme)
     ├─ components/
     │  ├─ OverviewView.tsx        Fleet KPI cards, Muse status list, and filterable activity feed
     │  ├─ AgentsAdminView.tsx     Manage Muses (rename/rotate/delete) and OpenAI-compatible agents
     │  ├─ ProjectView.tsx         Project overview: assigned agents and conversation launcher
     │  ├─ ConversationRoom.tsx    Unified chat room for muse_single, muse_group, openai, and mixed modes
     │  ├─ MuseRoom.tsx            Direct 1:1 channel for a single Muse (chat, image, video)
     │  ├─ Composer.tsx            Prompt bar with action mode, aspect ratio, count/duration, and reference uploads
     │  ├─ InspectorPanel.tsx      Context drawer showing Muse telemetry, Dropbox paths, or project/conversation info
     │  ├─ AddMuseWizard.tsx       2-step Muse onboarding wizard (one-time token + canonical instructions)
     │  ├─ ProjectWizard.tsx       Create/edit project and assign Muse or OpenAI agents
     │  ├─ NewConversationModal.tsx Create conversations in muse_single, muse_group, openai, or mixed mode
     │  ├─ OpenAIAgentModal.tsx    Add/edit/delete OpenAI-compatible agent configs (base_url, model, api_key)
     │  ├─ MuseManage.tsx          Dialogs for rename, token rotation, delete, and clearing Muse history
     │  ├─ LoginView.tsx           Owner email/password sign-in screen with theme toggle
     │  ├─ Sidebar.tsx             Navigation rail (Overview, Agent Admin, Projects, Direct Muses, Theme toggle)
     │  ├─ TokenPanel.tsx          One-time token display panel
     │  ├─ MarkdownBody.tsx        Markdown renderer with syntax-labeled code blocks
     │  ├─ MessageBubble.tsx       Owner/agent bubbles, resource cards, and URL previews
     │  ├─ Icons.tsx               SVG icon set
     │  └─ ui.tsx                  Shared Modal, Chip, ErrorMsg, copyText, and ToastHost
     └─ styles/
        ├─ tokens.css              Dark and Light CSS design tokens
        └─ app.css                 Layout and component styles
supabase/
  ├─ config.toml                   JWT verification flags (submit_message=true; claim_message & submit_result=false)
  ├─ README.md                     Detailed Vietnamese spec: schema, Muse contract, group chat, operations
  ├─ functions/
  │  ├─ _shared/relay.ts           HMAC-SHA256 signing, SHA-256 token lookup, param/result validation, group fan-out
  │  ├─ submit_message/index.ts    Authenticated owner submission (direct recipient or group_id)
  │  ├─ claim_message/index.ts     Muse polling/claim endpoint (validates x-relay-token, stamps heartbeat)
  │  └─ submit_result/index.ts     Muse completion endpoint (validates claim lease + dropbox_root, fans out group turns)
  └─ migrations/
     ├─ 20261127000000_relay.sql                       Core relay_messages, relay_results, relay-inputs bucket + RLS
     ├─ 20261127000100_relay_chat.sql                  Ensures action check allows chat, image, video
     ├─ 20261127000200_recipient_hash.sql              Allows lowercase UUID recipients alongside 'nyx'
     ├─ 20261127000300_relay_muses.sql                 Muse registry (token_hash, dropbox_root, owner-only RLS)
     ├─ 20261127000400_relay_groups.sql                Group chat tables (relay_groups, relay_group_members, relay_group_posts)
     ├─ 20261127000500_relay_muses_last_claim.sql      Adds last_claim_at heartbeat column to relay_muses
     ├─ 20261127000500_relay_projects.sql              v7 tables (relay_agents_openai, relay_projects, relay_project_agents, relay_conversations, relay_openai_messages)
     ├─ 20261127000600_cleanup_legacy_and_owner_delete.sql Grants owner DELETE on relay_messages/relay_results and clears legacy rows
     └─ 20261127000700_muse_connection_state.sql       Adds setup_done, first_connected_at, last_result_at, token_rotated_at + trigger
scripts/
  ├─ deploy-functions.sh           Deploys all 3 Edge Functions using .env (SUPABASE_URL + SUPABASE_ACCESS_TOKEN)
  └─ acceptance-tests.sh           Live end-to-end acceptance suite (53 assertions) with self-cleanup
docs/examples/
  └─ submit-example.ts             TypeScript example showing Supabase Auth + submit_message invocation
.env.example                       Annotated template for the 8 environment variables
```

---

## Dashboard Features

- **Overview (`OverviewView.tsx`)**: Displays fleet-wide job counts (`processing`, `pending`, `done`, `error/expired`), registered agent totals, live Muse connection cards, and a filterable activity feed polled every 10 seconds.
- **Agent Admin (`AgentsAdminView.tsx`)**: Unified management screen for both Muse Relay agents (onboard via `AddMuseWizard`, rename, rotate token, delete, inspect `dropbox_root` and telemetry) and OpenAI-compatible agents (`OpenAIAgentModal` for `base_url`, `model`, `api_key`, and `system_prompt`, plus a live 20-second `testOpenAIAgentConnection` check).
- **Projects & Conversations (`ProjectView.tsx`, `ConversationRoom.tsx`)**: Group Muse and OpenAI-compatible agents into projects (`relay_projects` / `relay_project_agents`) and launch conversations (`relay_conversations`) in four modes:
  - `muse_single`: 1:1 Muse thread tagged with `thread_id` (supports `chat`, `image`, `video`).
  - `muse_group`: Owner-initiated group chat backed by `relay_groups` (`submit_result` auto-fans out turns up to `GROUP_TURN_LIMIT = 12`).
  - `openai`: Direct browser calls to each selected agent's `/chat/completions` endpoint, persisted in `relay_openai_messages`.
  - `mixed`: Fans out each owner prompt simultaneously to both Muse Relay participants and OpenAI-compatible agents in one timeline.
- **Direct Muse Channels (`MuseRoom.tsx`)**: Dedicated per-Muse workspace with `Composer.tsx` (supports `chat`, `image`, `video`, aspect ratio, count/duration, `resource_type`, `output_format`, and `relay-inputs` reference image uploads), `InspectorPanel.tsx`, and owner history cleanup (`ClearMuseHistoryDialog`). Sending is automatically locked until the Muse completes its initial setup/claim (`setup_done = true`).
- **Dark / Light Themes & EN / VI Localization**: Toggle between Dark and Light themes (`dashboard/src/lib/theme.ts`, `muse_relay_theme`) and English / Vietnamese UI (`dashboard/src/lib/i18n.ts`, `muse_relay_lang`) from the login screen or sidebar; both preferences persist in `localStorage` and are pre-applied before paint in `dashboard/index.html`. Documentation is maintained in both English ([`README.md`](README.md)) and Vietnamese ([`README.vi.md`](README.vi.md)).

---

## Running the Dashboard

1. Install dependencies and start the Vite development server:

   ```bash
   cd dashboard
   npm install
   npm run dev        # http://localhost:5173
   ```

2. Build a production static bundle or preview it locally:

   ```bash
   npm run build      # runs `tsc --noEmit && vite build` → dashboard/dist/
   npm run preview    # http://localhost:4173
   ```

Sign in with the owner Supabase Auth account (public sign-ups are disabled on the Supabase project). Public connection settings (`SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, `OWNER_DISPLAY_NAME`) live in [`dashboard/src/lib/config.ts`](dashboard/src/lib/config.ts).

---

## Deploying Backend & Running Acceptance Tests

1. Copy [`.env.example`](.env.example) to `.env` and populate the required values (`SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_SECRET_KEY`, `SUPABASE_ACCESS_TOKEN`, `RELAY_OWNER_ID`, `RELAY_SIGNING_SECRET`, `RELAY_TOKEN`, `RELAY_RECIPIENT_ID`).
2. Set the two server secrets on your Supabase project (`RELAY_SIGNING_SECRET` and `RELAY_OWNER_ID` — see [`supabase/README.md`](supabase/README.md)).
3. Apply database migrations, deploy the three Edge Functions, and run the live acceptance suite:

   ```bash
   npx --yes supabase db push            # or run supabase/migrations/*.sql in the Supabase SQL Editor
   bash scripts/deploy-functions.sh      # deploys submit_message, claim_message, submit_result
   bash scripts/acceptance-tests.sh      # runs against the live project — expects PASS=53 FAIL=0
   ```

> **Note**: `scripts/acceptance-tests.sh` runs directly against the live Supabase project and cleans up its test rows afterward. Legacy queue tests (`T-LG`) seed a temporary test Muse so a live Nyx daemon cannot race and claim test messages.

---

## Further Documentation

- [`supabase/README.md`](supabase/README.md) — Detailed schema breakdown, Muse claim/result contract, onboarding/rotation/deletion workflows, group chat fan-out rules, and operational notes (in Vietnamese).
- [`.env.example`](.env.example) — Documentation for all 8 environment variables, secret rotation steps, and a local SHA-256 hash verification command for `relay_muses`.
