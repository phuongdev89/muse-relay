-- Add the chat action to an existing relay install.
-- Run once in the Supabase SQL Editor, then redeploy submit_message and submit_result.

alter table public.relay_messages
  drop constraint if exists relay_messages_action_check;

alter table public.relay_messages
  add constraint relay_messages_action_check
  check (action in ('chat', 'image', 'video'));
