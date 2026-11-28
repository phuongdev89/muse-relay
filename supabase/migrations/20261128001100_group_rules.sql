-- v9 group rules + unread backfill: additive columns on the UNFROZEN group
-- tables only. relay_messages / relay_results are NOT altered (frozen).
--
--   relay_groups.rules           text         group regulation text (system
--                                             prompt), generated server-side at
--                                             the group's first submit_message
--                                             when still null; null = not yet
--                                             generated.
--   relay_group_members.last_seen_at timestamptz per-(group, muse) delivery
--                                             cursor: utterances with time
--                                             > last_seen_at and before the
--                                             claimed post are delivered as
--                                             group.history on claim. NULL =
--                                             never claimed in this group
--                                             (first claim gets the full
--                                             history + rules).
--
-- ROLLBACK (run scripts/rollback-group-rules.sql AFTER redeploying functions
-- and dashboard from the previous release, e.g. commit a119356):
--   alter table public.relay_groups drop column if exists rules;
--   alter table public.relay_group_members drop column if exists last_seen_at;
--
alter table public.relay_groups
  add column if not exists rules text;
alter table public.relay_group_members
  add column if not exists last_seen_at timestamptz;
