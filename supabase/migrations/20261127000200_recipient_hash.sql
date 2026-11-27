-- ZCode delta (v3 gap-fill): allow recipient ids shaped like RELAY_OWNER_ID
-- (lowercase UUID) in addition to the bootstrap 'nyx' value. Required BEFORE
-- setting RELAY_RECIPIENT_ID, otherwise submit_message inserts violate the old
-- recipient = 'nyx' check. Owner preference: UUID format over rcp_<hex>.
alter table public.relay_messages
  drop constraint if exists relay_messages_recipient_check;
alter table public.relay_messages
  add constraint relay_messages_recipient_check
  check (recipient = 'nyx' or recipient ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$');
