-- ============================================================
-- Muse Relay v2 — schema cho Supabase (zero-server)
--
-- Chạy trong SQL Editor của Supabase project (New → SQL Editor → paste → Run).
-- Idempotent: chạy lại nhiều lần không lỗi, không mất dữ liệu.
--
-- Sau khi chạy xong: Settings → API để lấy 3 thứ dán vào web UI:
--   1. Project URL        (SUPABASE_URL)
--   2. anon public key    (SUPABASE_ANON_KEY)
--   3. service_role key   (SERVICE_KEY — giữ kín, chỉ dán vào web UI của mình)
-- ============================================================

-- ---------- bảng dữ liệu ----------
create table if not exists public.projects(
    id         bigint generated always as identity primary key,
    muse_id    text unique not null,
    name       text not null,
    tags       text[] not null default '{}',
    user_id    uuid not null references auth.users(id) on delete cascade,  -- auth user của Muse này
    email      text unique not null,                                       -- '<muse_id>@muserelay.local'
    secret     text not null,                                              -- password của Muse
    created_at timestamptz not null default now()
);

create table if not exists public.threads(
    id           bigint generated always as identity primary key,
    project_id   bigint not null references public.projects(id) on delete cascade,
    title        text not null default 'Thread mới',
    last_read_id bigint not null default 0,   -- mốc "đã đọc" phía admin
    created_at   timestamptz not null default now()
);

create table if not exists public.messages(
    id          bigint generated always as identity primary key,
    thread_id   bigint not null references public.threads(id) on delete cascade,
    project_id  bigint not null references public.projects(id) on delete cascade,
    role        text not null check (role in ('user', 'muse')),
    text        text not null check (char_length(text) <= 20000),  -- chặn đổ file/base64 vào chat
    created_at  timestamptz not null default now()
);

create index if not exists idx_threads_project  on public.threads(project_id, id);
create index if not exists idx_messages_thread  on public.messages(thread_id, id);
create index if not exists idx_messages_project on public.messages(project_id, id);

-- tags chỉ nhận 3 giá trị
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'projects_tags_check') then
    alter table public.projects add constraint projects_tags_check
      check (tags <@ array['chat', 'image', 'video']::text[]);
  end if;
end $$;

-- ---------- row level security ----------
-- Muse (authenticated) chỉ chạm được đúng project của mình.
-- Admin UI đi bằng service_role key → bypass RLS, không cần policy.
-- Anon không có policy nào → không thấy gì.

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

-- Muse chỉ được trả lời (role='muse'), vào đúng project của mình,
-- và thread phải thuộc đúng project đó (không nhét reply sang thread người khác).
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
