-- Heartbeat: claim_message stamps last_claim_at on every authorized poll —
-- queue empty or not, because the idle poll itself proves the muse's daemon
-- is alive (instruction contract: hook claims every 10s, watchdog claim
-- at least every 10 minutes). The dashboard reads a fresh stamp as
-- "live within the last ~10 minutes"; NULL means never claimed since this
-- column exists. Additive on the v5 registry only — relay_messages /
-- relay_results stay frozen.
alter table public.relay_muses
  add column if not exists last_claim_at timestamptz;
