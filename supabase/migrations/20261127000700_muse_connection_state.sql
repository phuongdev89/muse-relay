-- v9 (muse setup, connection & live heartbeat state on relay_muses):
-- Additive columns only — preserves all existing contracts and Nyx compatibility.

alter table public.relay_muses
  add column if not exists setup_done boolean not null default false,
  add column if not exists first_connected_at timestamptz,
  add column if not exists last_result_at timestamptz,
  add column if not exists token_rotated_at timestamptz;

-- Backfill existing connected muses (e.g. Nyx) from last_claim_at.
update public.relay_muses
set
  setup_done = true,
  first_connected_at = coalesce(first_connected_at, last_claim_at)
where last_claim_at is not null
  and (setup_done = false or first_connected_at is null);

-- Automatically mark setup_done = true and stamp first_connected_at on first
-- heartbeat / claim_message update.
create or replace function public.sync_muse_connection_state()
returns trigger
language plpgsql
as $$
begin
  if new.last_claim_at is not null then
    new.setup_done := true;
    if new.first_connected_at is null then
      new.first_connected_at := new.last_claim_at;
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_relay_muses_connection_state on public.relay_muses;
create trigger trg_relay_muses_connection_state
  before insert or update on public.relay_muses
  for each row
  execute function public.sync_muse_connection_state();
