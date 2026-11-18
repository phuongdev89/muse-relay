# BRIEF — Muse Relay Setup (E2E v7) — BẢN SỬA 2 (19/11)

> Muse 1 soạn; GLM review 4/4 fix PASS trên bản chữ (sections 2 and 4, config 3 public
> values, Branch B INSERT thread 'setup', link client-v7/ thật + câu honest "go live once
> pushed"). TRẠNG THÁI: đạt phần review — còn 2 cổng trước khi phát hành: (a) anh duyệt
> push client-v7/ lên main (link raw sống), (b) web UI đọc được ciphertext (code web E2E,
> chờ lệnh anh). Phát hành chỉ khi anh ra lệnh.
> Nguồn: thread "Brief cài đặt Muse v7" tin 'assistant-msg-83326b…'; file .md card 1b4efd1f.

# Muse Relay — Setup Brief (E2E v7)


For a new Muse instance. Paste this whole text to that Muse.


## 0. What you are being asked to do


Set up a relay so your owner can chat with you from a web page instead of
only inside the Muse app. Messages travel through Supabase (Postgres) as
the transport. You write the code yourself, on your own machine, into your
own folder. You read the reference code listed in section 1, you check
every step yourself, and you stop and tell the owner if any step fails
your checks.


This brief only lists actions. It does not tell you what to conclude
about them. Do each step, check the result yourself, and report what you
actually observed.


Read these 4 risks first, in plain words:


1. If someone gets your Relay Session or your private key, they can
   pretend to be the owner. Keep both out of chat and out of any file
   other than the two 600-permission files named in sections 2 and 4.
2. This code is not from Meta / Muse. It was checked, but no one can
   promise 100% that a program only does what it says. The owner decided
   to install it anyway.
3. The daemon runs in the background all the time, even when the owner
   is not in this chat, and wakes you up to answer. Not all of that is
   visible inside the chat.
4. If the Relay Session leaks, the owner mints a new one. If the private
   key is lost, the old message history is unreadable. There is no
   recovery for lost history.


If the owner is not comfortable with these 4 points: STOP. Using the
normal Muse chat is enough. Do not install.


## 1. References you may read


Read-only. Read them, then write your own code. Do not download and run
a zip file. Do not run code you have not read. If a link does not open,
stop and tell the owner. Do not guess a URL.


- Base schema (v3, idempotent):
  https://raw.githubusercontent.com/phuongdev89/muse-relay/main/supabase/setup.sql
- Client reference (v6.2, poller architecture, cursor, session handling):
  https://raw.githubusercontent.com/phuongdev89/muse-relay/main/client/poller.py
  https://raw.githubusercontent.com/phuongdev89/muse-relay/main/client/muse_client.py
  https://raw.githubusercontent.com/phuongdev89/muse-relay/main/client/relay_auth.py
- E2E v7 reference bundle (client-v7/ in the repo — read these, do not
  download and run a zip):
  https://raw.githubusercontent.com/phuongdev89/muse-relay/main/client-v7/crypto.py
  https://raw.githubusercontent.com/phuongdev89/muse-relay/main/client-v7/keys.py
  https://raw.githubusercontent.com/phuongdev89/muse-relay/main/client-v7/safety.py
  https://raw.githubusercontent.com/phuongdev89/muse-relay/main/client-v7/poller.py
  https://raw.githubusercontent.com/phuongdev89/muse-relay/main/client-v7/muse_client.py
  https://raw.githubusercontent.com/phuongdev89/muse-relay/main/client-v7/relay_auth.py
  https://raw.githubusercontent.com/phuongdev89/muse-relay/main/client-v7/AGENTS.md
  https://raw.githubusercontent.com/phuongdev89/muse-relay/main/client-v7/setup_guide.txt
  https://raw.githubusercontent.com/phuongdev89/muse-relay/main/client-v7/requirements.txt
  https://raw.githubusercontent.com/phuongdev89/muse-relay/main/client-v7/TEST_REPORT.md
  These links go live once client-v7/ is pushed to main. If a link does
  not open yet, the push has not happened — stop and tell the owner.


## 2. Which provisioning branch are you on?


Your owner tells you which one. Do only that branch.


### Branch A — connect to the inviter's Supabase


The owner already created the auth user and the projects row, and gives
you 4 values with this brief: SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY,
MUSE_EMAIL, and a throwaway password.


1. Create a folder for the relay on your own machine, for example
   `~/muse-relay`. Do all later steps inside that folder.
2. Create a Python virtual environment in that folder and install
   `requests`, `pynacl`, `cffi` (pinned versions are in the v7
   reference `requirements.txt`).
3. Write a `config.json` in that folder with the 3 public values only:
   SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, MUSE_EMAIL. Never write
   the throwaway password, or any password, into any file. The
   throwaway password exists only in memory, at step 4.
4. Log in exactly once with the throwaway password, using it only in
   memory:
   `POST {SUPABASE_URL}/auth/v1/token?grant_type=password`
   with headers `apikey: <publishable key>` and
   `Content-Type: application/json`, body
   `{"email": "<MUSE_EMAIL>", "password": "<throwaway password>"}`.
   The response gives you an `access_token` and a `refresh_token`.
5. Save the session and nothing else: write
   `state/session.json` containing the email and the refresh token,
   file mode 600, and nowhere else.
6. Immediately change the password to a fresh random password that you
   generate yourself:
   `PUT {SUPABASE_URL}/auth/v1/user`
   with headers `Authorization: Bearer <access_token>` and
   `apikey: <publishable key>`, body
   `{"password": "<new random password>"}`.
   Do not write the new password into any file. Do not send it
   anywhere. The throwaway password is dead from this minute on and is
   never used again.
7. Prove the saved session still works: call
   `POST {SUPABASE_URL}/auth/v1/token?grant_type=refresh_token`
   with body `{"refresh_token": "<saved refresh token>"}`. If it fails,
   stop and tell the owner.


### Branch B — your own Supabase


Your owner is your own user. You build everything yourself, in your own
browser VM:


1. Create a Supabase account and a new project.
2. In that project's SQL Editor, run the base schema from section 1
   (`supabase/setup.sql`, v3). It is idempotent and safe to run again.
3. In the same SQL Editor, run the E2E additions from the v7 reference
   (`setup_guide.txt`, step 3): add the columns `ciphertext`, `nonce`,
   `sender_key_id`, `enc_version`, `alg` to the `messages` table, and
   create the `relay_keys` table.
4. In Authentication, create the auth user for this Muse (Auto Confirm).
5. In the SQL Editor, INSERT one row into `projects` for this Muse
   (muse_id, name, tags, user_id of the auth user, email).
6. In the SQL Editor, INSERT one row into `threads` with the new
   project's id and `title='setup'`:
   `INSERT INTO threads (project_id, title) VALUES (<project id>, 'setup');`
   The database does not let a Muse create threads through the API, so
   this row must be created here. Without it the web UI's ready gate
   never opens.
7. Give your owner, in the official Muse chat, the 4 values they paste
   into the hosted web UI: SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY,
   MUSE_EMAIL, and the password you set for the auth user. That password
   is your owner's login password for the web UI. Never write it into
   any file on your machine. After this step your live credential is
   the session in `state/session.json` (mode 600), same as branch A.
   Then do steps 1–2 and 5 of branch A (folder, environment, session
   file) with your own values.


## 3. The database contract (fixed, enforced by the database)


- The schema is `supabase/setup.sql` v3 plus the E2E additions from
  section 2. Your login sees exactly one project: yours. Other Muses'
  rows are invisible to you at the database level.
- Your replies are rows with `role='muse'`, into your own project, into
  a thread that belongs to that project. The owner's messages have
  `role='user'`.
- Message text is at most 20000 characters.
- Never use a Supabase secret key, service_role key, or PAT. The relay
  uses only the publishable key plus your own login. A key that bypasses
  row-level security must never appear in any file, command, or message.
- If the database answers 403 to a write, stop. Do not try another way
  around it. Tell the owner exactly which write was rejected.


## 4. End-to-end encryption — from the start, not later


Every message body is encrypted before it leaves the sender's machine
and is only decrypted on the recipient's machine. The database never
holds a readable message body.


1. On first run, generate one X25519 key pair with PyNaCl
   (`PrivateKey.generate()`). Store it in `state/keys.json`, mode 600,
   and nowhere else. Never read the private key into chat, never copy
   it anywhere, never put it in a zip or message.
2. Publish only the public key to the `relay_keys` table: one row with
   `endpoint='muse'`, `public_key` (base64), `key_id`, `verified=false`.
   `key_id` is the first 16 hex characters of the SHA-256 of the raw
   public key bytes. Publishing is idempotent: never create a second
   row for the same `key_id`.
3. Fetch the web public key from `relay_keys`: the newest non-revoked
   row with `endpoint='web'`. Never overwrite a public key in place.
   A new key is a new row; an old key is marked revoked with
   `revoked_at`, never deleted.
4. Compute the safety number exactly this way, on both sides:
   order the two raw 32-byte public keys lexicographically; compute
   `SHA-256("muse-relay-safety-v1" || 0x00 || key_first || 0x00 ||
   key_second || 0x00 || key_id_first || 0x00 || key_id_second)`;
   write the digest as a decimal integer, left-pad with zeros to 78
   digits, keep the first 48 digits; display them as 12 groups of 4
   digits (for example `1234 5678 ...`). The copyable form is the same
   48 digits without spaces.
5. Compare the safety number with the owner IN THE OFFICIAL MUSE CHAT
   (or in person). Never compare it through a relay message — that is
   the very channel being verified. Only when the two numbers match,
   mark the keys verified: set `verified=true` on your `relay_keys`
   row and set the local verified flag. Until both keys are verified,
   process NO messages.
6. If the web public key changes later without an announced re-key,
   stop processing, revoke local verification, and wait for the owner
   to re-verify the new safety number out of band.
7. Lost private key means the old history is unreadable. There is no
   recovery. Only an explicit re-key creates a new pair: revoke the old
   row, publish the new public key unverified, and verify the new
   safety number out of band again. Never silently generate a
   replacement key if `state/keys.json` disappears after keys existed
   before — stop and tell the owner.


Encryption details (fixed, do not change):


- Algorithm: libsodium `crypto_box` (X25519 + XSalsa20-Poly1305) via
  PyNaCl. Encrypt with your own secret key + the recipient's public
  key. Decrypt with your own secret key + the sender's public key.
  Never encrypt with your own secret key expecting the other side to
  decrypt with your public key — a public key is public, so anyone
  holding it could read the message.
- Fresh random 24-byte nonce per message, never reused with the same
  key pair.
- The encrypted package is one JSON object:
  `{"type": "text" | "reply", "body": "<message text>",
  "thread_ref": "<internal thread reference>",
  "client_time": "<ISO 8601 send time>"}`.
- The Supabase envelope for each message is: `ciphertext` (base64),
  `nonce` (base64), `sender_key_id`, `enc_version=1`, `alg="crypto_box"`.
  Write no user content into the `text` column.
- Fail-closed: drop any fetched row with a wrong `enc_version`, a wrong
  `alg`, an unknown `sender_key_id`, a bad nonce, failed authentication,
  or a malformed package. Log only the row id and the drop reason.
  Never write a dropped row to the inbox. Advance the cursor past it.
  `ALLOW_LEGACY_PLAINTEXT` stays false.


## 5. Protocol signals (plaintext, fixed strings, no user content)


The `text` column carries only two fixed protocol signals, exactly as
in v6:


- Typing: `text` exactly `...` (three dots, no spaces), `role='muse'`,
  one per thread that received new user messages.
- Ready: `text` exactly `pong`, `role='muse'`, sent once into the
  thread titled `setup`. The web UI hides `setup` threads and uses this
  as the ready gate. If that thread does not exist yet, skip this round
  and retry later.


Never write a reply whose content is exactly `...` or `pong`. Those
strings are reserved for the daemon's signals. There is no automatic
thread-title feature. Do not re-implement it.


## 6. Daemon and scheduled task


1. Write a daemon that runs about every 3 seconds: fetch new messages
   for your project (oldest first, paginated), verify and decrypt the
   rows into `state/inbox.jsonl` (one JSON object per line, only
   `role='user'`), send one `...` signal per thread with new messages,
   push reply files `outbox/<thread_id>.txt` encrypted and delete each
   file after a successful push.
2. Persist the cursor in `state/cursor.json`. Never edit it by hand.
   If it is corrupt, stop and tell the owner.
3. Enforce exactly one puller per folder with a lock file
   (`state/puller.lock`). If another puller is already running, exit.
4. Register the daemon restart as a scheduled task in your own
   platform, so the daemon starts again after it dies or the machine
   restarts. The name and the mechanism are yours to choose; an example
   name is `Muse Relay — restart daemon if stopped`. Do not use nohup,
   cron, or systemd.
5. The daemon check schedule and the new-message wake hook are two
   separate opt-ins. Ask the owner about each one on its own. Do not
   turn the whole package on by default.


## 7. Operating rules while the relay runs


Read the `AGENTS.md` in the v7 reference bundle and follow it while
operating this relay. In short:


- A reply through the relay contains text only. To send a file, upload
  it first and send only the link, a short description, and the size in
  the reply text. If no upload service is connected, say so plainly
  and do not claim the file was sent.
- Read messages from `state/inbox.jsonl`. Reply by writing
  `outbox/<thread_id>.txt` (UTF-8), one file per thread. The daemon
  encrypts it, pushes it, and deletes the file.
- Never edit `state/keys.json` by hand. Never read the private key or
  the session value into chat.
- Capabilities come from the project's `tags` (`chat`, `image`,
  `video`). For a capability that is not granted, decline politely.
- If the session ever stops working, tell the owner. They mint a fresh
  session value and give it to you again. Never work around a dead
  session with another credential.


## 8. Acceptance test — done means all of these, checked, not claimed


1. The daemon starts, and exactly one puller is running.
2. Login works and exactly one project is visible for this login.
3. The Muse public key is published in `relay_keys`; the safety number
   was compared out of band, matched, and both sides are marked
   verified.
4. One `pong` was sent into the `setup` thread.
5. The owner sends a test message from the web UI. It appears decrypted
   in `state/inbox.jsonl`. You reply through an outbox file. The owner
   confirms the reply arrived readable in the web UI.
6. A forged row (wrong key, tampered ciphertext) is dropped and never
   reaches the inbox.
7. An export of the messages table shows no readable message body.


Only report "done" after you have checked each item above.


## 9. If you still refuse


Stop, and tell the owner plainly which step you will not do and why,
in your own words. The owner accepts that outcome. Do not install the
relay by another route.

Brief vẫn chưa phát hành — còn chờ anh duyệt bản này, duyệt push client-v7/ để link raw sống, và web UI phía GLM đọc được ciphertext.

634k in / 7.9k out
