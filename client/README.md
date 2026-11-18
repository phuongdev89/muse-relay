# Muse Relay — client bundle v6.2 (password-mint auth)

Client-only bundle. Base: v6 plaintext relay (NOT the v7 E2E code — the
Cloud UI in this release reads plaintext, so E2E must stay out of this
bundle until the UI can decrypt).

## What changed vs v6

- `relay_auth.py` — NEW auth path, backward compatible:
  - Priority: `state/session.json` (saved) → `RELAY_SESSION` (legacy v6)
    → `MUSE_PASSWORD` (new, first run only, `grant_type=password`).
  - A dead saved/legacy token now falls through to the next source
    instead of failing outright (v6 raised immediately). Transient
    errors (network / 429 / 5xx) still propagate at once.
  - Password login errors are explicit: wrong email/password, or the
    auth user has not confirmed its email (the `@muserelay.local`
    address cannot receive mail — the user must be created with
    Auto Confirm / `email_confirm=true`).
  - After a successful password mint, the daemon saves the refresh
    token to `state/session.json` (chmod 600), scrubs `MUSE_PASSWORD`
    out of `config.json` (atomic rewrite, chmod 600), and clears the
    password from memory. Restarts need neither credential.
  - `build_cfg()` no longer requires `RELAY_SESSION` or
    `SUPABASE_PROJECT_ID`. It requires URL + publishable key + email,
    plus one credential OR an already-saved session.
  - New check: `python3 relay_auth.py test-login --config config.json`
    prints only `auth_source` + email, never a token or password.
  - `read_cursor()` now takes `max(last_id, after)` (the v7 cursor fix),
    so a legacy `after` key can never move the cursor backwards.
  - Passwords and tokens are never logged and never appear in errors.
- `muse_client.py`, `poller.py` — docstrings + log/error messages only;
  poll/send/fetch logic unchanged. Startup now logs `auth=<source>`.
- `AGENTS.md` §3 — credential rules updated for v6.2 (two files only,
  never chat; no service_role / PAT / dashboard password anywhere).
- `setup_guide.txt` — rewritten for the new model: Muse builds the relay
  for its own owner (own Supabase project, own daemon, own 4 UI values),
  Step 0 covers creating the project + `setup.sql` + auto-confirmed
  auth user, Step 3 covers `test-login` and the password scrub check.
- `config.example.json` — NEW. Placeholders only, no real values.
  Copy it to `config.json` and fill it in. `RELAY_SESSION` is empty
  by default (legacy only); `SUPABASE_PROJECT_ID` is optional.
- `run.sh` / `run.bat` — comments updated for the mint-once flow.

## Files in this bundle

```
AGENTS.md  README.md  config.example.json  muse_client.py  poller.py
relay_auth.py  requirements.txt  restart_poller.sh  run.bat  run.sh
setup_guide.txt  start_daemon.sh  tests/test_password_auth.py
```

No `config.json`, no `state/`, no `outbox/` — those are created on
first run. No real project ID, key, email or session is in this zip.

## What was tested (2026-11-18, mocked Supabase — see below)

`tests/test_password_auth.py` (stdlib unittest, mocks `requests.post`):
1. Password mint succeeds → refresh token saved to `state/session.json`,
   `MUSE_PASSWORD` removed from `config.json`, in-memory password cleared.
2. Second run uses the saved session, never calls password login again.
3. Legacy `RELAY_SESSION` still works with no password present (v6 compat).
4. Dead saved token + dead `RELAY_SESSION` fall through to password mint.
5. Wrong password / unconfirmed email → `AuthError` naming the cause,
   no retry loop, no secret in the message.
6. `build_cfg` rejects a config with no credential and no saved session.
7. `read_cursor` takes `max(last_id, after)`.
8. A network failure during login raises `TransientError` (back off and
   retry) instead of crashing with a raw `requests` traceback — found
   while smoke-testing `test-login` against the placeholder config.
9. All files compile (`python3 -m py_compile`).

Run it: `python3 -m unittest discover -s tests -v` (needs `requests`
installed, or `pip install -r requirements.txt` first).

## What was NOT tested live — read before you ship

- NO live Supabase project was created in this build. Creating one
  needs a Supabase account + an email inbox that can receive the
  verification link (or an existing account), and that was not
  provided. The prototype from the previous message is still blocked
  on exactly that — see “Prototype status” below. Do not claim the
  end-to-end flow works until it is run against a real project.
- UI session vs daemon session: the design assumes GoTrue allows two
  concurrent sessions for the same auth user (UI `signInWithPassword`
  + daemon refresh token) without one revoking/rotating the other.
  That is standard GoTrue behaviour, but it has NOT been verified
  against this project yet — test it with the UI before promising it.
- `setup.sql` v3 (UI repo) is a dependency, not in this bundle: the
  daemon assumes the `projects` / `threads` / `messages` tables and
  the user-scoped RLS policies it creates. If v3 changes a column or
  policy name, `fetch_project` / `init_cursor` will fail loudly —
  that is by design (fail closed, do not guess).

## Prototype status (Supabase test project)

Still blocked, same as the previous message: no test email inbox and
no Supabase account were supplied, so no account was created, no
project was created, and no live `grant_type=password` call was made.
What would unblock it (needs the owner, directly): (a) which email to
use for a Supabase test account and who reads its verification mail,
(b) whether to create the test project in the owner's existing
Supabase account or in a brand-new account, (c) confirmation that
the test project may be created at all. Until then, the mocked tests
above are the only verification for the new auth path.

## Integration notes for the UI repo (ZCode)

- Drop this bundle's files into `client/` as-is. Do not merge the v7
  E2E files (`crypto.py`, `keys.py`, `safety.py`) into this folder —
  this client sends plaintext, matching the Cloud UI.
- The UI needs the same 4 values the daemon was set up with
  (`SUPABASE_URL`, publishable key, `MUSE_EMAIL`, `MUSE_PASSWORD`).
  The UI must sign in as that SAME auth user, or the v3 RLS policies
  (scoped by `user_id = auth.uid()`) will block it.
- `setup.sql` v3 must create the auth user path the daemon expects:
  the user must exist and be confirmed BEFORE first daemon run.
- Cutover warning: this bundle does not touch the live relay. Do not
  replace a running v6 folder in place — install in a fresh folder,
  run `test-login`, send one test message, and only then stop the old
  daemon. The final cutover decision belongs to the owner.
