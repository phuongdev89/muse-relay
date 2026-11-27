-- v8 mention routing: stamp thread_id = group_id onto existing group fan-out
-- rows so the direct channel (thread_id IS NULL filter) excludes them, same as
-- new fan-out rows. Data-only backfill — no schema change, idempotent (only
-- rows without thread_id are touched). params is part of the HMAC payload: a
-- row still pending at backfill time would fail signature verification on
-- claim, but fan-out rows expire after 30 minutes, so nothing claimable is
-- affected in practice when this runs at deploy time.
update public.relay_messages m
set params = m.params || jsonb_build_object('thread_id', p.group_id::text)
from public.relay_group_posts p
where p.message_id = m.id
  and m.params->>'thread_id' is null;
