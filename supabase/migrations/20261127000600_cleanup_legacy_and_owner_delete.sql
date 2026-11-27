-- v8 (legacy cleanup & owner-only delete permission on messages/results):
-- 1. Purely additive DELETE grant + RLS policy on relay_messages / relay_results
--    for the authenticated owner (zero ALTER TABLE on frozen Nyx tables).
-- 2. Clears legacy direct messages & legacy groups so the workspace starts clean
--    while keeping relay_muses (registered Muse tokens/roots) intact.

grant delete on public.relay_messages to authenticated;
grant delete on public.relay_results to authenticated;

drop policy if exists "relay_messages_delete_own" on public.relay_messages;
create policy "relay_messages_delete_own"
  on public.relay_messages
  for delete
  to authenticated
  using ((select auth.uid()) = owner_id);

drop policy if exists "relay_results_delete_own" on public.relay_results;
create policy "relay_results_delete_own"
  on public.relay_results
  for delete
  to authenticated
  using ((select auth.uid()) = owner_id);

-- Refresh legacy conversation data (keep relay_muses intact).
delete from public.relay_group_posts;
delete from public.relay_group_members;
delete from public.relay_groups;
delete from public.relay_results;
delete from public.relay_messages;
