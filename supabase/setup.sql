-- ============================================================
-- Muse Relay v2 — schema cho Supabase (zero-server)
--
-- Run in the Supabase project's SQL Editor (New → SQL Editor → paste → Run).
-- Idempotent: safe to run repeatedly, never loses data.
--
-- After running: Settings → API gives you the values for .env:
--   1. Project URL        (SUPABASE_URL)
--   2. anon public key    (SUPABASE_ANON_KEY)
--   3. secret key         (SECRET_KEY — keep it private, server-side only)
-- ============================================================

-- ---------- tables ----------
create table if not exists public.projects(
    id         bigint generated always as identity primary key,
    muse_id    text unique not null,
    name       text not null,
    tags       text[] not null default '{}',
    user_id    uuid not null references auth.users(id) on delete cascade,  -- this Muse's auth user
    email      text unique not null,                                       -- '<muse_id>@muserelay.local'
    secret     text not null,                                              -- the Muse's login password (RLS identity)
    created_at timestamptz not null default now()
);

create table if not exists public.threads(
    id           bigint generated always as identity primary key,
    project_id   bigint not null references public.projects(id) on delete cascade,
    title        text not null default 'New thread',
    last_read_id bigint not null default 0,   -- the admin side's read watermark
    created_at   timestamptz not null default now()
);

create table if not exists public.messages(
    id          bigint generated always as identity primary key,
    thread_id   bigint not null references public.threads(id) on delete cascade,
    project_id  bigint not null references public.projects(id) on delete cascade,
    role        text not null check (role in ('user', 'muse')),
    text        text not null check (char_length(text) <= 20000),  -- blocks dumping files/base64 into chat
    created_at  timestamptz not null default now()
);

create index if not exists idx_threads_project  on public.threads(project_id, id);
create index if not exists idx_messages_thread  on public.messages(thread_id, id);
create index if not exists idx_messages_project on public.messages(project_id, id);

-- tags accept only 3 values
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'projects_tags_check') then
    alter table public.projects add constraint projects_tags_check
      check (tags <@ array['chat', 'image', 'video']::text[]);
  end if;
end $$;

-- ---------- row level security ----------
-- An authenticated Muse can only touch its OWN project.
-- The admin (serve.py proxy) uses the secret key → bypasses RLS, no policy needed.
-- Anon has no policies → sees nothing.

alter table public.projects enable row level security;
alter table public.threads  enable row level security;
alter table public.messages enable row level security;

drop policy if exists muse_select_own_project on public.projects;
create policy muse_select_own_project on public.projects
    for select to authenticated
    using (user_id = auth.uid());

drop policy if exists muse_select_own_threads on public.threads;
create policy muse_select_own_threads on public.threads
    for select to authenticated
    using (exists (select 1 from public.projects p
                   where p.id = project_id and p.user_id = auth.uid()));

drop policy if exists muse_select_own_messages on public.messages;
create policy muse_select_own_messages on public.messages
    for select to authenticated
    using (exists (select 1 from public.projects p
                   where p.id = project_id and p.user_id = auth.uid()));

-- A Muse may only reply (role='muse'), into its own project,
-- and into a thread that belongs to that same project (no cross-posting).
drop policy if exists muse_insert_own_reply on public.messages;
create policy muse_insert_own_reply on public.messages
    for insert to authenticated
    with check (
        role = 'muse'
        and exists (select 1 from public.projects p
                    where p.id = project_id and p.user_id = auth.uid())
        and exists (select 1 from public.threads t
                    where t.id = thread_id and t.project_id = project_id)
    );

-- ---------- realtime cho web UI ----------
do $$ begin
  if not exists (select 1 from pg_publication_tables
                 where pubname = 'supabase_realtime'
                   and schemaname = 'public' and tablename = 'messages') then
    alter publication supabase_realtime add table public.messages;
  end if;
end $$;
