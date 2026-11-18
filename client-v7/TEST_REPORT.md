# Muse Relay v7 (E2E) — Test Report

Date: 2026-11-18. Work directory: `~/workspace/muse-relay-e2e/`.
Environment: Python 3.12.3, venv `.venv` with PyNaCl 1.6.2, requests 2.34.2, cffi 2.1.1.
All tests are local simulations only — no real Supabase, no live relay, no real message sent.

## How to run

```bash
cd ~/workspace/muse-relay-e2e
.venv/bin/python -m unittest discover -s tests -v
```

## Result: 46 tests, 46 passed, 0 failed

`Ran 46 tests in ~0.05s — OK` (verified on 3 consecutive runs, plus after every fix below).

## 1. Unit tests — crypto.py (`tests/test_crypto.py`, 19 tests)

Round-trip / auth:
- `test_web_to_muse_and_back` — web→Muse→web encrypt/decrypt round-trip both directions — PASS
- `test_wrong_recipient_key_fails` — ciphertext for another key cannot be decrypted — PASS
- `test_wrong_sender_key_fails` — decrypting with the wrong sender public key fails — PASS
- `test_tampered_ciphertext_fails` — one flipped ciphertext byte → CryptoError — PASS
- `test_tampered_nonce_fails` — one flipped nonce byte → CryptoError — PASS
- `test_bad_nonce_length` — nonce not 24 bytes rejected — PASS
- `test_bad_base64` — malformed base64 rejected — PASS
- `test_nonce_uniqueness` — 100 messages, all nonces distinct — PASS

Package validation:
- `test_pack_unpack_round_trip` — pack/unpack of text and reply packages — PASS
- `test_bad_package_rejected` — wrong type / missing body / bad thread_ref / bad client_time rejected — PASS
- `test_key_id_construction` — key_id = sha256(public bytes)[:16] — PASS

decrypt_row (fail-closed gate):
- `test_valid_row_decrypts` — a well-formed E2E row decrypts — PASS
- `test_unknown_sender_key_dropped` — sender_key_id not matching the verified web key → dropped — PASS
- `test_forged_ciphertext_dropped` — valid envelope, forged ciphertext → dropped — PASS
- `test_bad_enc_version_dropped` — enc_version != 1 → dropped — PASS
- `test_bad_alg_dropped` — alg != "crypto_box" → dropped — PASS
- `test_missing_ciphertext_dropped_by_default` — row with no ciphertext → dropped (legacy off) — PASS
- `test_legacy_accepted_only_when_enabled` — plaintext row accepted only with ALLOW_LEGACY_PLAINTEXT=true — PASS
- `test_encrypt_reply_envelope` — reply envelope carries ciphertext+nonce only, no plaintext field — PASS

## 2. Unit tests — keys.py / safety.py (`tests/test_keys_safety.py`, 13 tests)

Keys:
- `test_create_and_load_round_trip` — create → load returns the same pair — PASS
- `test_get_or_create_first_run_then_loads_same` — first run creates, second run loads the same pair — PASS
- `test_key_id_matches_public_key` — stored key_id matches the public key — PASS
- `test_load_rejects_unsafe_permissions` — keys.json with group/other bits → KeysError — PASS
- `test_load_rejects_corrupt_file` — invalid JSON / missing fields → KeysError — PASS
- `test_load_rejects_wrong_key_length` — public/secret key not 32 bytes → KeysError — PASS
- `test_load_rejects_mismatched_key_id` — stored key_id not matching the public key → KeysError — PASS
- `test_lost_key_refuses_silent_replacement` — keys.json missing but keys.ever_created present → KeysError, no auto-create — PASS

Safety number:
- `test_number_is_48_digits_in_12_groups` — "1234 5678 ..." format, 48 digits — PASS
- `test_number_is_order_independent` — swapping the two keys gives the same number — PASS
- `test_number_is_deterministic` — same keys → same number — PASS
- `test_different_keys_give_different_numbers` — different keys → different number — PASS
- `test_write_read_round_trip_and_idempotent` — write → read returns the number; rewriting the same value is a no-op — PASS

## 3. Acceptance tests (`tests/test_acceptance.py`, 13 tests)

FakeSupabase: in-memory REST fake (projects/threads/messages/relay_keys; supports eq/in/gt/is.null/order/limit; POST/PATCH; monotonic created_at clock for deterministic ordering). `api` is patched in relay_auth, poller, muse_client and keys, so no network is touched.

- **A1 forged row dropped** — hand-written row with no valid auth is dropped, never reaches inbox, cursor still advances past it — PASS
- **A2 exported DB unreadable** — dump of the whole fake DB contains no readable message body; the row still decrypts correctly for the daemon — PASS
- **A3 swapped public key stops processing** — attacker replaces the web public key in relay_keys → daemon stops processing and warns; safety number changes — PASS
- **A3b same key_id, different key bytes** — a row whose key_id matches but whose key bytes differ is still dropped (bytes are compared, not just the id) — PASS
- **A4 lost key refuses + history unreadable** — deleting keys.json with the marker present → daemon refuses to auto-create; old ciphertext cannot be decrypted with a fresh keypair — PASS
- **A5 nonce check** — two identical replies produce different nonces and different ciphertext — PASS
- **A6 full E2E simulation** — web→Muse→web through the fake transport; inbox receives the decrypted message; the reply is encrypted before push; a scan of the fake transport finds neither plaintext — PASS
- **A7 single puller lock** — a second puller on the same folder exits without processing — PASS
- **A8 cursor MAX + corrupt** — read_cursor takes MAX(last_id, after); corrupt cursor.json → AuthError, daemon refuses to guess — PASS
- **A9 install_session + build_cfg** — session installed from stdin into state/session.json (600); build_cfg reads the session only from there; RELAY_SESSION in config.json is ignored with a loud warning; ENC_VERSION != 1 rejected — PASS
- **A11 legacy gate at poller level** — a plaintext row is dropped by default and accepted only with ALLOW_LEGACY_PLAINTEXT=true — PASS
- **A12 malformed rows dropped** — missing nonce / bad base64 / wrong version / missing fields are all dropped; a valid row in the same batch is still processed — PASS
- **A13 muse_client --once full round** — run 1: first run, keys created, pong sent, cursor 0, not verified, exits; after out-of-band verification: run 2 decrypts the inbound message into inbox; run 3 pushes the outbox reply encrypted; transport scan finds no plaintext — PASS

## 4. Daemon-loop smoke test (`tests/test_daemon_smoke.py`, 1 test)

- `test_poller_main_loop_against_fake` — runs the real `poller.main()` entry point against the fake Supabase (cursor pre-seeded at 0 so round 1 fetches the pre-inserted message; the loop is stopped by making `time.sleep` raise KeyboardInterrupt after 3 rounds). Verifies: daemon start log, pong sent, verified gate passed, message decrypted into inbox with `"e2e": true`, cursor advanced, lock file released, transport holds no plaintext — PASS

## 5. CLI smoke checks (manual, scratch dir /tmp/e2e-cli-smoke, no network)

- `keys.py --config config.json --state-dir state status` — fresh state: "no keys yet — start the daemon once to generate them" (exit 0); with keys: shows muse key_id, web key_id, verified False/False, safety-file path — PASS
- `relay_auth.py install-session --config config.json --state-dir state` (token via stdin) — writes `state/session.json` mode 600 containing email + refresh_token — PASS
- `safety.py --state-dir state show` — no number: stderr message + exit 1; with number: prints the 48-digit number, exit 0 — PASS
- `safety.write_safety_number` — first write returns True, rewriting the same value returns False (no churn) — PASS
- File permissions after key creation: `keys.json` 600, `keys.ever_created` 600, `safety_number.txt` 600, `session.json` 600 — PASS

## Bugs found by the tests (all fixed, suite re-run green after each fix)

1. `keys.muse_keys`/`web_keys` returned raw bytes while `crypto` expects nacl key objects → `Box must be created from a PrivateKey and a PublicKey` (8 errors). Fixed: the key helpers now return nacl objects.
2. Test helper `web_encrypt_to_muse` was passed the *web* public key where the *Muse* public key belongs, so valid messages were encrypted to the wrong key and dropped (4 failures). Fixed: the helper now takes the Muse public key as base64 (as the web UI would read it from relay_keys) and decodes it.
3. `relay_auth.write_cursor` crashed when the state dir did not exist. Fixed: it now creates the parent dir.
4. `test_a13` had dead code (stray `mock.patch("os.chdir",...)` block and an `mc.main.__wrapped__` line) and called `mark_verified` before syncing the web key. Fixed: dead code removed; sync before verify; final transport assertion simplified.
5. Daemon smoke test initially failed because `poller.init_cursor()` on a true first run starts at the newest id and never replays history (v6 behaviour) — the pre-inserted message was correctly skipped. Fixed the test: pre-seed `cursor.json` with last_id 0.
6. `keys.ever_created` marker was written with default umask perms (660). Tightened to 600 (marker holds only a timestamp, no secret — defence in depth).

## Not covered by these tests (known gaps)

- The web UI + browser client side (GLM's job) — no browser-side code exists in this tree, so cross-implementation interop (safety-number construction, envelope fields) is untested until GLM's side exists.
- Real Supabase against the v7 schema — the fake implements the documented REST behaviour; a live round-trip against a test project is still needed before cutover.
- The migration window (ALLOW_LEGACY_PLAINTEXT=true) against real pre-E2E rows — covered only at the fake level (A11).
- `start_daemon.sh` / `restart_poller.sh` were not executed end-to-end (they need a real Supabase + session); they were reviewed by reading and compile-checked via `bash -n`.
