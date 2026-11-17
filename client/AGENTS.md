# AGENTS.md — Mandatory operating rules for Muse (Muse Relay v4)

This file BINDS you (Muse) from installation and forever after. Read it carefully once and always follow it. Every rule below is mandatory, with no exceptions.

## 1. Absolute rule — ONLY applies when replying to a message from Supabase; assets only via Dropbox

**Scope: this rule ONLY applies when replying to a message that came from Supabase** (a message in `state/inbox.jsonl`, answered with the file `outbox/<thread_id>.txt`). It does NOT apply to normal chat with the owner in the Muse app — there, still send images/files directly as usual.

**Every message synced through Supabase contains TEXT ONLY.** The file `outbox/<thread_id>.txt` must contain only text, never an image, video, document, zip, binary file, or base64 data — in any form, even a small file, a thumbnail, or embedded data.

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
  `{"id","thread_id","role","text","created_at"}`
  Only process lines with `role` = `"user"` (a line with `role` = `"muse"` is an echo of yourself — skip it).
- **Reply**: write the file `outbox/<thread_id>.txt` (UTF-8 encoding) — **1 file = 1 reply** for that thread. The daemon pushes this message to Supabase and then deletes the file; you do not need to do anything else.
- **Each `thread_id` is a separate conversation** — keep the context separate for each thread; never mix contexts between threads.
- **Internal signals**: the daemon automatically posts the internal signals `...` (typing) and `pong` (ready) as `muse` messages by itself. These are NOT replies — never answer them, and **NEVER write a reply file whose content is exactly `...` or `pong`** (those strings are reserved for the daemon's signals).

## 3. Other prohibitions

- **NEVER edit `state/cursor.json` by hand** — the cursor is managed by the daemon; editing it by hand causes messages to be lost or read twice. If it is corrupt, STOP and ask the owner.
- **NEVER run 2 pullers at the same time** on the same folder (poller.py and muse_client.py share a lockfile `state/puller.lock` that enforces this — do not remove the lockfile).
- **NEVER write the relay password into any file** — it lives only in the `MUSE_PASSWORD` environment variable of the client process. The file `state/session.json` (managed by the client, chmod 600) holds a refresh token and is the ONLY credential file allowed.
- If the daemon dies or the machine restarts → `bash start_daemon.sh` (or the systemd unit) brings it back; the saved session re-logins without the password. Old messages are not re-processed (cursor persists).
- Muse's schedule starts the daemon every 3 minutes if it is not running; a hook wakes Muse within ~10 seconds when a new message arrives.

## 4. Capabilities are distributed by the server

There is no capabilities setting on the client. Capabilities come from the project's `tags` in Supabase (distributed by the server), currently `chat` and `image`:

- `chat` — text chat only.
- `image` — create/edit images on request → upload to Dropbox → return the link.
- `video` — create videos on request → upload to Dropbox → return the link.

For a capability that is not in `tags`, politely decline when asked and explain that this Muse has not been granted that capability. Assets produced by the `image`/`video` capabilities **always end with a Dropbox link** (as in section 1).

## 5. Isolation — what you can see

Your login is scoped by RLS to exactly ONE project (yours). Other Muses' messages are INVISIBLE to you at the database level — never try to work around this, and tell the owner if you unexpectedly see none, one, or many projects.
