-- v6 (group chat): owner-initiated group conversations between muses.
-- THREE NEW TABLES ONLY — relay_messages / relay_results are NOT altered in
-- any way (Nyx production-freeze). Fan-out reuses the existing claim
-- mechanism: every group utterance becomes ordinary pending `chat` rows in
-- relay_messages, so the muse-side contract stays byte-for-byte identical.

create table if not exists public.relay_groups (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users (id) on delete cascade,
  name text not null check (char_length(name) between 1 and 64),
  created_at timestamptz not null default now()
);

create table if not exists public.relay_group_members (
  group_id uuid not null references public.relay_groups (id) on delete cascade,
  muse_recipient uuid not null,
  name text not null check (char_length(name) between 1 and 64),
  joined_at timestamptz not null default now(),
  unique (group_id, muse_recipient)
);

create index if not exists relay_group_members_group_idx
  on public.relay_group_members (group_id);

create table if not exists public.relay_group_posts (
  message_id uuid primary key references public.relay_messages (id) on delete cascade,
  group_id uuid not null references public.relay_groups (id) on delete cascade,
  owner_id uuid not null references auth.users (id) on delete cascade,
  from_kind text not null check (from_kind in ('owner', 'muse')),
  from_name text not null check (char_length(from_name) between 1 and 64),
  turn integer not null check (turn between 1 and 999),
  -- Identifies all relay_messages rows spawned by ONE fan-out event (an owner
  -- utterance fans out to N members; a muse reply fans out to the others), so
  -- the dashboard renders one bubble per utterance, not one per message row.
  batch_id uuid not null default gen_random_uuid(),
  created_at timestamptz not null default now()
);

create index if not exists relay_group_posts_group_idx
  on public.relay_group_posts (group_id, created_at);

alter table public.relay_groups enable row level security;
alter table public.relay_group_members enable row level security;
alter table public.relay_group_posts enable row level security;

revoke all on public.relay_groups from anon, authenticated;
revoke all on public.relay_group_members from anon, authenticated;
revoke all on public.relay_group_posts from anon, authenticated;
grant select, insert, update, delete on public.relay_groups to authenticated;
grant select, insert, update, delete on public.relay_group_members to authenticated;
grant select on public.relay_group_posts to authenticated;

drop policy if exists "groups owner full control" on public.relay_groups;
create policy "groups owner full control" on public.relay_groups
  for all using (owner_id = (select auth.uid()))
  with check (owner_id = (select auth.uid()));

drop policy if exists "group members owner full control" on public.relay_group_members;
create policy "group members owner full control" on public.relay_group_members
  for all using (
    exists (
      select 1 from public.relay_groups g
      where g.id = group_id and g.owner_id = (select auth.uid())
    )
  )
  with check (
    exists (
      select 1 from public.relay_groups g
      where g.id = group_id and g.owner_id = (select auth.uid())
    )
  );

-- Posts are owner-read-only: rows are written exclusively by the Edge
-- Functions with the service role while recording fan-outs.
drop policy if exists "group posts owner select" on public.relay_group_posts;
create policy "group posts owner select" on public.relay_group_posts
  for select to authenticated
  using (owner_id = (select auth.uid()));
