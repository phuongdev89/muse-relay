-- Per-muse routing capabilities: which actions the owner may route to this
-- muse from the direct-channel composer (chat / image / video). UI gating
-- only — submit_message still validates params server-side regardless.
-- Defaults true so pre-existing muses keep every capability.
alter table public.relay_muses
  add column if not exists cap_chat boolean not null default true,
  add column if not exists cap_image boolean not null default true,
  add column if not exists cap_video boolean not null default true;
