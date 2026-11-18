-- ============================================================
-- Muse Relay v4 — E2E v7 additions (DRAFT — pending §7.8 reconciliation
-- with the daemon side before it becomes supabase/setup.sql on main)
--
-- v4 = v3 (everything below line "v4 additions" is already live) + :
--   (a) messages: E2E envelope columns (ciphertext/nonce/sender_key_id/
--       enc_version/alg) — per the v7 contract and setup_guide.txt step 3
--   (b) messages.text: NOT NULL dropped — v7 writers omit `text` for
--       encrypted rows (found 2026-11-19: the v7 guide DDL misses this and
--       the first real v7 INSERT would fail on the v3 schema)
--   (c) relay_keys: key-transport table with RLS scoped to the owner user,
--       public keys immutable via trigger (INSERT-only semantics: a new key
--       is a new row; verified/revoked_at are the only mutable fields)
-- Idempotent: safe to run repeatedly, never loses data.
-- Run in the Supabase project's SQL Editor (New → SQL Editor → paste → Run).
-- ============================================================

-- (a) E2E envelope columns on messages (exact v7 contract names)
alter table public.messages
    add column if not exists ciphertext    text,
    add column if not exists nonce         text,
    add column if not exists sender_key_id text,
    add column if not exists enc_version   int,
    add column if not exists alg           text;

-- (b) v7 encrypted rows carry no plaintext: `text` becomes optional.
--     It keeps carrying only the two fixed protocol signals ('...', 'pong')
--     and, during the opt-in migration window, pre-E2E rows.
alter table public.messages alter column text drop not null;

-- (c) relay_keys — public keys only. Private keys never touch the server.
--
--     user_id defaults to auth.uid() so both endpoints insert under their
--     own GoTrue identity without sending it:
--       - the Muse daemon inserts its `endpoint='muse'` row (JWT session)
--       - the browser inserts its `endpoint='web'` row (Cloud mode signs in
--         as the SAME user, so both rows share one user_id and are mutually
--         visible under RLS)
--       - serve.py (LAN, service key → bypasses RLS, auth.uid() is NULL)
--         MUST set user_id explicitly when inserting the web row.
create table if not exists public.relay_keys(
    id         bigint generated always as identity primary key,
    user_id    uuid not null default auth.uid() references auth.users(id) on delete cascade,
    endpoint   text    not null check (endpoint in ('muse', 'web')),
    public_key text    not null,        -- base64 raw 32-byte X25519 public key
    key_id     text    not null,        -- hex(sha256(public_key))[:16], lowercase
    verified   boolean not null default false,
    created_at timestamptz not null default now(),
    revoked_at timestamptz
);

create index if not exists idx_relay_keys_user
    on public.relay_keys(user_id, endpoint, created_at desc);

alter table public.relay_keys enable row level security;

-- both endpoints see and publish only their own user's keys
drop policy if exists relay_keys_select_own on public.relay_keys;
create policy relay_keys_select_own on public.relay_keys
    for select to authenticated
    using (user_id = auth.uid());

drop policy if exists relay_keys_insert_own on public.relay_keys;
create policy relay_keys_insert_own on public.relay_keys
    for insert to authenticated
    with check (user_id = auth.uid());

-- verified / revoked_at may be updated by the key's own user (after the
-- out-of-band safety-number match); key material itself is immutable
-- (trigger below).
drop policy if exists relay_keys_update_own on public.relay_keys;
create policy relay_keys_update_own on public.relay_keys
    for update to authenticated
    using (user_id = auth.uid())
    with check (user_id = auth.uid());

-- INSERT-only semantics: public_key / endpoint / key_id / user_id can never
-- be rewritten in place. Re-key = insert a new row + revoke the old one
-- (revoked_at), exactly as the v7 contract requires.
create or replace function public.relay_keys_protect_key() returns trigger
language plpgsql as $$
begin
    if new.public_key is distinct from old.public_key
       or new.endpoint  is distinct from old.endpoint
       or new.key_id    is distinct from old.key_id
       or new.user_id   is distinct from old.user_id then
        raise exception 'relay_keys: key columns are immutable — re-key by inserting a new row and revoking the old one';
    end if;
    return new;
end;
$$;

drop trigger if exists relay_keys_protect_key_trg on public.relay_keys;
create trigger relay_keys_protect_key_trg
    before update on public.relay_keys
    for each row execute function public.relay_keys_protect_key();

-- ---------- everything below is v3 (already live, kept verbatim) ----------
