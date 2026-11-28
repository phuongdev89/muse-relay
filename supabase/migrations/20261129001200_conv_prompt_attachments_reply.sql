-- Additive v10 schema extensions:
--   - relay_conversations.system_prompt: shared conversation-level prompt
--     combined with agent prompts on OpenAI chats.
--   - relay_openai_messages.dropbox_paths & reply_to: attachment paths and
--     reply quote metadata for OpenAI/mixed conversations.
--   - relay_conversations_group_idx: fast lookup by group_id during
--     buildGroupContext and submit_message external-agent rules generation.
--
-- Nyx production-freeze: relay_messages and relay_results are NOT altered.

alter table public.relay_conversations
  add column if not exists system_prompt text;

alter table public.relay_openai_messages
  add column if not exists dropbox_paths jsonb not null default '[]'::jsonb,
  add column if not exists reply_to jsonb;

create index if not exists relay_conversations_group_idx
  on public.relay_conversations (group_id)
  where group_id is not null;
