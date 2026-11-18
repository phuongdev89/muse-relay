# AGENTS.md — Operating rules for Muse while running Muse Relay v7 (E2E)

This file describes how this relay folder works. It applies only while
you (Muse) are operating this relay — it does not bind anything outside
this folder, and the owner can change or stop the relay at any time.

## 0. End-to-end encryption — what changed in v7

Supabase now carries ciphertext only. Every message is encrypted with
libsodium crypto_box before it leaves the sender's machine and can only
be decrypted on the recipient's machine.

- **You write plaintext to `outbox/<thread_id>.txt` as before — the daemon
  encrypts it before pushing.** Never encrypt anything yourself, never
  paste ciphertext, and never write anything but text into the outbox file.
- **Inbox lines are already decrypted and authenticated by the daemon.**
  A line in `state/inbox.jsonl` is safe to process: the daemon verified it
  came from the owner's verified key and dropped anything else. Each line
  carries `"e2e": true` (decrypted) or `"e2e": false` (a pre-E2E plaintext
  row accepted once during the migration window).
- **The private key lives only in `state/keys.json` (chmod 600).** Never
  read it into chat, never copy it anywhere, never put it in any zip or
  message. If it is lost, the old history is unreadable — that was
  accepted by the owner; there is no recovery. Only an explicit re-key
  (`python3 keys.py rekey`) creates a new pair.
- **The safety number is verified OUTSIDE the relay** (in the official
  Muse chat, or in person). Never send the safety number, a public key,
  or any key material through a relay message.
- **The Relay Session lives only in `state/session.json` (chmod 600).**
  It is installed with `python3 relay_auth.py install-session` after
  you log in once with the owner's one-time password (setup_guide.txt STEP 5). It is NEVER in
  config.json. Never use a Supabase secret key, service_role key, PAT, or
  password anywhere — this side of the relay has none of those.
- **There is no automatic thread-title feature.** It was removed
  deliberately because it needed to read plaintext in the database. Do
  not re-implement it, do not ask the relay to suggest titles, and do not
  write title-request messages. New threads have no title or a
  time-based default title.

## 1. Absolute rule — ONLY applies when replying to a message from Supabase; assets only via Dropbox

**Scope: this rule ONLY applies when replying to a message that came from Supabase** (a message in `state/inbox.jsonl`, answered with the file `outbox/<thread_id>.txt`). It does NOT apply to normal chat with the owner in the Muse app — there, still send images/files directly as usual.

**Every message synced through Supabase contains TEXT ONLY.** The file `outbox/<thread_id>.txt` must contain only text, never an image, video, document, zip, binary file, or base64 data — in any form, even a small file, a thumbnail, or embedded data. (The daemon encrypts that text before pushing; the text-only rule is about what YOU write.)

Every asset (image, video, document, zip, ...) must be uploaded to **Dropbox** first, and only the **LINK** is sent in the text reply via Supabase:

- Upload with the Dropbox connector (`/opt/hatch/bin/dropbox create-file --path /Muse Relay/<file name> --input <local path>`), then create a shared link.
- Prefer a direct download link: use the form `https://dl.dropboxusercontent.com/...` or add `?dl=1` to a dropbox.com link.
- Always include a **short description** of the asset (what it is, its size, what it is for).
- A reply via Supabase contains only: the explanation + the Dropbox link + the description. Never send the asset itself via Supabase.
- Before replying with an asset, check: is the reply plain text? Does it contain base64 / file bytes? Have you uploaded it to Dropbox and do you have the link? If there is no link yet, do not claim the asset has been sent.
- If Dropbox is not connected, tell the owner clearly that Dropbox is not connected; do not pretend the upload happened.

## 2. Inbox/outbox protocol

You do not talk directly through chat. Communication with the owner happens through files:

- **Read messages**: open the file `state/inbox.jsonl` — each line is one JSON object shaped like:
  `{"id","thread_id","role","text","created_at","e2e":true}`
  Only process lines with `role` = `"user"` (a line with `role` = `"muse"` is an echo of yourself — skip it).
- **Reply**: write the file `outbox/<thread_id>.txt` (UTF-8 encoding) — **1 file = 1 reply** for that thread. The daemon encrypts and pushes this message to Supabase and then deletes the file; you do not need to do anything else.
- **Each `thread_id` is a separate conversation** — keep the context separate for each thread; never mix contexts between threads.
- **Internal signals**: the daemon automatically posts the internal signals `...` (typing) and `pong` (ready) as `muse` messages by itself. These are NOT replies — never answer them, and **NEVER write a reply file whose content is exactly `...` or `pong`** (those strings are reserved for the daemon's signals).
- **Status reports (`/status`)**: when a user message is EXACTLY `/status`, gather your runtime status (context usage, tokens, model — run your platform's `/status` command or its equivalent) and reply with ONE file whose content is EXACTLY this wrapper around the raw output, nothing before or after it:

  ```
  <<<STATUS>>>
  (the raw status output here — no commentary, no formatting of your own)
  <<<END_STATUS>>>
  ```

  The web UI parses this and shows it in the usage bar under the composer — it is plumbing, like the daemon signals. **Never** start a normal reply with `<<<STATUS>>>` and never use that wrapper for anything but a `/status` answer. If you cannot determine your status, still answer in the wrapper with one short line saying so.

## 3. Other prohibitions

- **NEVER edit `state/cursor.json` by hand** — the cursor is managed by the daemon; editing it by hand causes messages to be lost or read twice. If it is corrupt, STOP and ask the owner.
- **NEVER edit `state/keys.json` by hand** — it holds the Muse private key. If it is missing or corrupt, STOP and ask the owner (do not let anything silently generate a replacement).
- **NEVER run 2 pullers at the same time** on the same folder (poller.py and muse_client.py share a lockfile `state/puller.lock` that enforces this — do not remove the lockfile).
- **The Relay Session lives in `state/session.json` only** (chmod 600), installed with `install-session` after the one-time-password login (setup_guide.txt STEP 5). It is never in config.json and never in chat. If the session ever stops working, ask the owner for a fresh one-time password and repeat STEP 5; never try to work around it with another credential.
- If the daemon dies or the machine restarts → the scheduled task runs `bash start_daemon.sh`; the saved session re-logins without the password. Old messages are not re-processed (cursor persists).
- Muse's schedule starts the daemon every 3 minutes if it is not running; a hook wakes Muse within ~10 seconds when a new message arrives.

## 4. Capabilities are distributed by the server

There is no capabilities setting on the client. Capabilities come from the project's `tags` in Supabase (distributed by the server), currently `chat` and `image`:

- `chat` — text chat only.
- `image` — create/edit images on request → upload to Dropbox → return the link.
- `video` — create videos on request → upload to Dropbox → return the link.

For a capability that is not in `tags`, politely decline when asked and explain that this Muse has not been granted that capability. Assets produced by the `image`/`video` capabilities **always end with a Dropbox link** (as in section 1).

## 5. Isolation — what you can see

Your login is scoped by RLS to exactly ONE project (yours). Other Muses' messages are INVISIBLE to you at the database level — never try to work around this, and tell the owner if you unexpectedly see none, one, or many projects.
