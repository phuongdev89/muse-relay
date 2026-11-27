-- v5 (multi-muse): runtime registry of muses. The dashboard wizard inserts rows
-- here as the owner (RLS below); claim_message / submit_result resolve the
-- presented x-relay-token by its SHA-256 hash with the service role, which
-- bypasses RLS. Tokens are only ever stored hashed — the plaintext is shown
-- once in the wizard's final step. Legacy Nyx keeps the RELAY_TOKEN /
-- RELAY_RECIPIENT_ID env pair; its display row (token_hash NULL) is seeded
-- separately, not in this file, so no credential material lands in the repo.
create table if not exists public.relay_muses (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null,
  recipient uuid not null unique,
  name text not null check (char_length(name) between 1 and 64),
  token_hash text check (token_hash ~ '^[0-9a-f]{64}$'),
  dropbox_root text not null
    check (
      dropbox_root like '/%'
      and right(dropbox_root, 1) = '/'
      and char_length(dropbox_root) <= 256
      and position('..' in dropbox_root) = 0
    ),
  created_at timestamptz not null default now()
);

create unique index if not exists relay_muses_token_hash_key
  on public.relay_muses (token_hash) where token_hash is not null;

alter table public.relay_muses enable row level security;

drop policy if exists "muses owner full control" on public.relay_muses;
create policy "muses owner full control" on public.relay_muses
  for all using (owner_id = (select auth.uid()))
  with check (owner_id = (select auth.uid()));
