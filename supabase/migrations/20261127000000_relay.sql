-- Supabase relay for Muse (Nyx): image/video requests in, results out.
-- Run once in the Supabase SQL Editor, or with `supabase db push`.

create table if not exists public.relay_messages (
  id uuid primary key,
  owner_id uuid not null references auth.users (id) on delete cascade,
  recipient text not null check (recipient = 'nyx'),
  action text not null check (action in ('chat', 'image', 'video')),
  params jsonb not null,
  status text not null default 'pending'
    check (status in ('pending', 'processing', 'done', 'failed')),
  nonce text not null unique,
  expires_at timestamptz not null,
  expires_at_unix bigint not null,
  signature text not null,
  claim_id uuid,
  claim_expires_at timestamptz,
  claimed_at timestamptz,
  completed_at timestamptz,
  attempts integer not null default 0,
  created_at timestamptz not null default now()
);

create table if not exists public.relay_results (
  id uuid primary key default gen_random_uuid(),
  message_id uuid not null unique references public.relay_messages (id) on delete cascade,
  owner_id uuid not null references auth.users (id) on delete cascade,
  status text not null check (status in ('done', 'failed')),
  output jsonb not null default '{"dropbox_paths": [], "notes": null}'::jsonb,
  error text,
  created_at timestamptz not null default now()
);

create index if not exists relay_messages_pending_idx
  on public.relay_messages (status, created_at)
  where status = 'pending';

create index if not exists relay_messages_owner_idx
  on public.relay_messages (owner_id, created_at desc);

alter table public.relay_messages enable row level security;
alter table public.relay_results enable row level security;

revoke all on public.relay_messages from anon, authenticated;
revoke all on public.relay_results from anon, authenticated;
grant select on public.relay_messages to authenticated;
grant select on public.relay_results to authenticated;

drop policy if exists "relay_messages_select_own" on public.relay_messages;
create policy "relay_messages_select_own"
  on public.relay_messages
  for select
  to authenticated
  using ((select auth.uid()) = owner_id);

drop policy if exists "relay_results_select_own" on public.relay_results;
create policy "relay_results_select_own"
  on public.relay_results
  for select
  to authenticated
  using ((select auth.uid()) = owner_id);

-- No insert/update/delete policies for authenticated users on purpose:
-- writes happen only through Edge Functions after JWT/HMAC/relay-token checks.

insert into storage.buckets (id, name, public)
values ('relay-inputs', 'relay-inputs', false)
on conflict (id) do nothing;

drop policy if exists "relay_inputs_select_own" on storage.objects;
create policy "relay_inputs_select_own"
  on storage.objects
  for select
  to authenticated
  using (
    bucket_id = 'relay-inputs'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );

drop policy if exists "relay_inputs_insert_own" on storage.objects;
create policy "relay_inputs_insert_own"
  on storage.objects
  for insert
  to authenticated
  with check (
    bucket_id = 'relay-inputs'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );

drop policy if exists "relay_inputs_update_own" on storage.objects;
create policy "relay_inputs_update_own"
  on storage.objects
  for update
  to authenticated
  using (
    bucket_id = 'relay-inputs'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  )
  with check (
    bucket_id = 'relay-inputs'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );

drop policy if exists "relay_inputs_delete_own" on storage.objects;
create policy "relay_inputs_delete_own"
  on storage.objects
  for delete
  to authenticated
  using (
    bucket_id = 'relay-inputs'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );
