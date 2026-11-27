-- v7 (projects, conversations & openai-compatible agents):
-- Purely additive owner-only tables — relay_messages / relay_results /
-- relay_muses / relay_groups / relay_group_members / relay_group_posts are
-- NOT altered in any way (Nyx production-freeze).

create table if not exists public.relay_agents_openai (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users (id) on delete cascade,
  name text not null check (char_length(name) between 1 and 64),
  base_url text not null check (char_length(base_url) between 1 and 512),
  model text not null check (char_length(model) between 1 and 128),
  api_key text not null check (char_length(api_key) between 1 and 512),
  system_prompt text not null default '',
  created_at timestamptz not null default now()
);

create index if not exists relay_agents_openai_owner_idx
  on public.relay_agents_openai (owner_id, created_at);

create table if not exists public.relay_projects (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users (id) on delete cascade,
  name text not null check (char_length(name) between 1 and 64),
  description text not null default '',
  created_at timestamptz not null default now()
);

create index if not exists relay_projects_owner_idx
  on public.relay_projects (owner_id, created_at);

create table if not exists public.relay_project_agents (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.relay_projects (id) on delete cascade,
  owner_id uuid not null references auth.users (id) on delete cascade,
  agent_kind text not null check (agent_kind in ('muse', 'openai')),
  agent_ref text not null check (char_length(agent_ref) between 1 and 128),
  agent_name text not null check (char_length(agent_name) between 1 and 64),
  created_at timestamptz not null default now(),
  unique (project_id, agent_kind, agent_ref)
);

create index if not exists relay_project_agents_project_idx
  on public.relay_project_agents (project_id, created_at);

create table if not exists public.relay_conversations (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.relay_projects (id) on delete cascade,
  owner_id uuid not null references auth.users (id) on delete cascade,
  title text not null check (char_length(title) between 1 and 80),
  mode text not null check (mode in ('muse_single', 'muse_group', 'openai', 'mixed')),
  group_id uuid references public.relay_groups (id) on delete set null,
  participants jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists relay_conversations_project_idx
  on public.relay_conversations (project_id, created_at);

create table if not exists public.relay_openai_messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.relay_conversations (id) on delete cascade,
  owner_id uuid not null references auth.users (id) on delete cascade,
  role text not null check (role in ('owner', 'agent')),
  agent_ref text,
  agent_name text not null check (char_length(agent_name) between 1 and 64),
  content text not null,
  status text not null default 'done' check (status in ('done', 'failed')),
  error text,
  created_at timestamptz not null default now()
);

create index if not exists relay_openai_messages_conv_idx
  on public.relay_openai_messages (conversation_id, created_at);

-- ---- Row Level Security (strict owner-only) --------------------------------

alter table public.relay_agents_openai enable row level security;
alter table public.relay_projects enable row level security;
alter table public.relay_project_agents enable row level security;
alter table public.relay_conversations enable row level security;
alter table public.relay_openai_messages enable row level security;

revoke all on public.relay_agents_openai from anon, authenticated;
revoke all on public.relay_projects from anon, authenticated;
revoke all on public.relay_project_agents from anon, authenticated;
revoke all on public.relay_conversations from anon, authenticated;
revoke all on public.relay_openai_messages from anon, authenticated;

grant select, insert, update, delete on public.relay_agents_openai to authenticated;
grant select, insert, update, delete on public.relay_projects to authenticated;
grant select, insert, update, delete on public.relay_project_agents to authenticated;
grant select, insert, update, delete on public.relay_conversations to authenticated;
grant select, insert, update, delete on public.relay_openai_messages to authenticated;

drop policy if exists "openai agents owner full control" on public.relay_agents_openai;
create policy "openai agents owner full control" on public.relay_agents_openai
  for all to authenticated
  using (owner_id = (select auth.uid()))
  with check (owner_id = (select auth.uid()));

drop policy if exists "projects owner full control" on public.relay_projects;
create policy "projects owner full control" on public.relay_projects
  for all to authenticated
  using (owner_id = (select auth.uid()))
  with check (owner_id = (select auth.uid()));

drop policy if exists "project agents owner full control" on public.relay_project_agents;
create policy "project agents owner full control" on public.relay_project_agents
  for all to authenticated
  using (
    owner_id = (select auth.uid())
    and exists (
      select 1 from public.relay_projects p
      where p.id = project_id and p.owner_id = (select auth.uid())
    )
  )
  with check (
    owner_id = (select auth.uid())
    and exists (
      select 1 from public.relay_projects p
      where p.id = project_id and p.owner_id = (select auth.uid())
    )
  );

drop policy if exists "conversations owner full control" on public.relay_conversations;
create policy "conversations owner full control" on public.relay_conversations
  for all to authenticated
  using (
    owner_id = (select auth.uid())
    and exists (
      select 1 from public.relay_projects p
      where p.id = project_id and p.owner_id = (select auth.uid())
    )
  )
  with check (
    owner_id = (select auth.uid())
    and exists (
      select 1 from public.relay_projects p
      where p.id = project_id and p.owner_id = (select auth.uid())
    )
  );

drop policy if exists "openai messages owner full control" on public.relay_openai_messages;
create policy "openai messages owner full control" on public.relay_openai_messages
  for all to authenticated
  using (
    owner_id = (select auth.uid())
    and exists (
      select 1 from public.relay_conversations c
      where c.id = conversation_id and c.owner_id = (select auth.uid())
    )
  )
  with check (
    owner_id = (select auth.uid())
    and exists (
      select 1 from public.relay_conversations c
      where c.id = conversation_id and c.owner_id = (select auth.uid())
    )
  );
