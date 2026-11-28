-- Rollback for migration 20261128001100_group_rules.sql (v9 group rules +
-- unread backfill). Additive-only feature, so the inverse is two column drops
-- on UNFROZEN tables; relay_messages / relay_results are never touched.
--
-- RUN ORDER:
--   1. Redeploy Edge Functions and dashboard from the previous release commit
--      (e.g. a119356) — old code never reads these columns.
--   2. Then run this script.
--
-- Effects (accepted): relay_groups.rules is auto-generated text and will be
-- rebuilt on the next group send; relay_group_members.last_seen_at resets the
-- per-group delivery cursors, so muses receive one full-history backfill on
-- their next group claim (bounded to the 30 most recent utterances).

alter table public.relay_groups
  drop column if exists rules;
alter table public.relay_group_members
  drop column if exists last_seen_at;
