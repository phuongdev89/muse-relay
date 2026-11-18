#!/usr/bin/env python3
"""Acceptance tests for Muse Relay v7 (E2E) — local simulation only.

No network, no live relay, no real Supabase. A small in-memory fake
implements the REST surface the code uses (threads / messages / relay_keys
/ projects), and relay_auth.api is patched to route to it in every module
that imported it.

Run from the work directory:
    .venv/bin/python -m unittest discover -s tests -v
"""
import json
import os
import sys
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path
from unittest import mock
from urllib.parse import parse_qs, urlsplit

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import keys as relay_keys  # noqa: E402
import muse_client  # noqa: E402
import poller  # noqa: E402
import relay_auth  # noqa: E402
import safety as relay_safety  # noqa: E402
from crypto import (  # noqa: E402
    decrypt_message, encrypt_message, key_id, pack_message,
)
from nacl.public import PrivateKey  # noqa: E402

PID = 33


def _now_iso():
    return datetime.now(timezone.utc).isoformat()


class FakeResponse:
    def __init__(self, status_code, payload):
        self.status_code = status_code
        self._payload = payload

    def json(self):
        return self._payload


class FakeSupabase:
    """In-memory stand-in for the Supabase REST API used by the relay."""

    def __init__(self):
        self.projects = [{"id": PID, "muse_id": "muse_test", "name": "Test Muse",
                          "tags": ["chat", "image"], "email": "muse_test@muserelay.local"}]
        self.threads = [{"id": 35, "project_id": PID, "title": "setup"}]
        self.messages = []
        self.relay_keys = []
        self._next_msg = 1
        self._next_key = 1
        self._tick = 0  # monotonic clock so created_at ordering is deterministic

    def _ts(self):
        from datetime import timedelta
        self._tick += 1
        return (datetime(2026, 11, 18, tzinfo=timezone.utc)
                + timedelta(seconds=self._tick)).isoformat()

    # -- table helpers -------------------------------------------------
    def insert_message(self, row):
        row = dict(row)
        row["id"] = self._next_msg
        self._next_msg += 1
        row.setdefault("created_at", self._ts())
        self.messages.append(row)
        return row

    def insert_key(self, row):
        row = dict(row)
        row["id"] = self._next_key
        self._next_key += 1
        row.setdefault("created_at", self._ts())
        row.setdefault("revoked_at", None)
        self.relay_keys.append(row)
        return row

    # -- query parsing ---------------------------------------------------
    @staticmethod
    def _parse(path):
        parts = urlsplit(path)
        qs = {k: v[0] for k, v in parse_qs(parts.query).items()}
        return parts.path, qs

    @staticmethod
    def _match(row, qs, skip=("select", "order", "limit")):
        for key, val in qs.items():
            if key in skip:
                continue
            if val.startswith("eq."):
                if str(row.get(key)) != val[3:]:
                    return False
            elif val.startswith("in.(") and val.endswith(")"):
                want = set(val[4:-1].split(","))
                if str(row.get(key)) not in want:
                    return False
            elif val.startswith("gt."):
                if not (row.get(key) is not None and row.get(key) > int(val[3:])):
                    return False
            elif val == "is.null":
                if row.get(key) is not None:
                    return False
            else:
                raise AssertionError(f"fake: unsupported filter {key}={val}")
        return True

    @staticmethod
    def _order_limit(rows, qs):
        order = qs.get("order")
        if order:
            field, _, direction = order.partition(".")
            rows = sorted(rows, key=lambda r: (r.get(field) is None, r.get(field)),
                          reverse=(direction == "desc"))
        limit = qs.get("limit")
        if limit:
            rows = rows[:int(limit)]
        return rows

    # -- the fake api() --------------------------------------------------
    def api(self, cfg, method, path, name, extra_headers=None, data=None,
            expect=(200, 201)):
        resource, qs = self._parse(path)
        if method == "GET" and resource == "projects":
            rows = list(self.projects)
        elif method == "GET" and resource == "threads":
            rows = [t for t in self.threads if self._match(t, qs)]
            rows = self._order_limit(rows, qs)
        elif method == "GET" and resource == "messages":
            rows = [m for m in self.messages if self._match(m, qs)]
            rows = self._order_limit(rows, qs)
        elif method == "GET" and resource == "relay_keys":
            rows = [k for k in self.relay_keys if self._match(k, qs)]
            rows = self._order_limit(rows, qs)
        elif method == "POST" and resource == "messages":
            row = json.loads(data.decode("utf-8"))
            return FakeResponse(201, self.insert_message(row))
        elif method == "POST" and resource == "relay_keys":
            row = json.loads(data.decode("utf-8"))
            return FakeResponse(201, self.insert_key(row))
        elif method == "PATCH" and resource == "relay_keys":
            body = json.loads(data.decode("utf-8"))
            updated = [k for k in self.relay_keys if self._match(k, qs)]
            for k in updated:
                k.update(body)
            return FakeResponse(200, updated)
        else:
            raise AssertionError(f"fake: unexpected call {method} {path}")
        return FakeResponse(200, rows)

    def dump_all_text(self):
        """Every stored value as one string — for the 'export the DB' test."""
        return json.dumps({"messages": self.messages, "relay_keys": self.relay_keys,
                           "threads": self.threads}, ensure_ascii=False)


def make_cfg(tmpdir, allow_legacy=False):
    state = Path(tmpdir) / "state"
    outbox = Path(tmpdir) / "outbox"
    state.mkdir(parents=True, exist_ok=True)
    outbox.mkdir(parents=True, exist_ok=True)
    return {
        "project_id": str(PID),
        "url": "https://fake.supabase.co",
        "publishable": "sb_publishable_fake",
        "email": "muse_test@muserelay.local",
        "session_ref": "",
        "session_in_config": False,
        "allow_legacy_plaintext": allow_legacy,
        "enc_version": 1,
        "state_dir": state,
        "outbox_dir": outbox,
        "session": {"access_token": "fake-access", "expires_at": 9999999999},
        "pid": PID,
        "cursor": 0,
        "backoff": 1,
    }


def patch_api(testcase, fake):
    """Route every module's api() to the fake. Returns a context manager."""
    patches = [
        mock.patch.object(relay_auth, "api", fake.api),
        mock.patch.object(poller, "api", fake.api),
        mock.patch.object(muse_client, "api", fake.api),
        mock.patch.object(relay_keys, "api", fake.api),
    ]
    ctx = mock.patch.object(relay_auth, "api", fake.api)
    for p in patches:
        p.start()
        testcase.addCleanup(p.stop)
    return ctx


def setup_verified_pair(testcase, fake, tmpdir):
    """Create muse + web keypairs, publish both, sync, verify. Returns
    (muse_keys_dict, web_secret_key, web_public_key, web_key_id)."""
    cfg = make_cfg(tmpdir)
    muse_state = relay_keys.get_or_create_keys(cfg["state_dir"])
    relay_keys.publish_public_key(cfg, muse_state)
    web_sk = PrivateKey.generate()
    web_pk = web_sk.public_key
    web_kid = key_id(bytes(web_pk))
    fake.insert_key({"endpoint": "web",
                     "public_key": __import__("crypto").b64encode(bytes(web_pk)),
                     "key_id": web_kid, "verified": True})
    row, changed = relay_keys.sync_web_key(cfg, muse_state)
    assert row is not None and not changed, "first web-key sync must not count as a change"
    relay_keys.mark_verified(cfg, cfg["state_dir"])
    muse_state = relay_keys.load_keys(cfg["state_dir"])
    assert muse_state["verified"] is True
    number = relay_safety.compute_for_keys(
        muse_state["muse_public_key"], muse_state["web_public_key"],
        muse_state["muse_key_id"], muse_state["web_key_id"])
    relay_safety.write_safety_number(cfg["state_dir"], number)
    return muse_state, web_sk, web_pk, web_kid


def web_encrypt_to_muse(fake, web_sk, muse_public_b64, body, thread_id=35):
    """Simulate the web UI sending one encrypted user message. The web UI
    holds the Muse public key as base64 (from relay_keys) — decode it here,
    exactly as the browser would."""
    from crypto import b64decode, b64encode
    from nacl.public import PublicKey
    muse_pk = PublicKey(b64decode(muse_public_b64, "muse public key"))
    pkg = pack_message("text", body, str(thread_id), _now_iso())
    ct, nonce = encrypt_message(pkg, muse_pk, web_sk)
    from crypto import key_id as _kid
    return fake.insert_message({
        "thread_id": thread_id, "project_id": PID, "role": "user",
        "ciphertext": ct, "nonce": nonce,
        "sender_key_id": _kid(bytes(web_sk.public_key)),
        "enc_version": 1, "alg": "crypto_box"})


class AcceptanceTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.fake = FakeSupabase()
        patch_api(self, self.fake)
        # poller writes inbox/log under its module BASE — point it at tmp.
        self._poller_base = mock.patch.object(poller, "BASE", Path(self.tmp.name))
        self._poller_base.start()
        self.addCleanup(self._poller_base.stop)
        self._poller_log = mock.patch.object(
            poller, "LOG", Path(self.tmp.name) / "state" / "poller.log")
        self._poller_log.start()
        self.addCleanup(self._poller_log.stop)
        self.logs = []
        self._log_patch = mock.patch.object(poller, "log", self.logs.append)
        self._log_patch.start()
        self.addCleanup(self._log_patch.stop)

    def tearDown(self):
        self.tmp.cleanup()

    def _inbox(self):
        path = Path(self.tmp.name) / "state" / "inbox.jsonl"
        if not path.exists():
            return []
        return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line]

    # -- A1: forged row ------------------------------------------------
    def test_a1_forged_row_is_dropped(self):
        cfg = make_cfg(self.tmp.name)
        muse_state, web_sk, web_pk, web_kid = setup_verified_pair(self, self.fake, self.tmp.name)
        from crypto import b64encode
        forged = self.fake.insert_message({
            "thread_id": 35, "project_id": PID, "role": "user",
            "ciphertext": b64encode(b"\x00" * 60), "nonce": b64encode(b"\x00" * 24),
            "sender_key_id": web_kid, "enc_version": 1, "alg": "crypto_box"})
        cfg["cursor"] = 0
        msgs = poller.fetch(cfg, cfg["cursor"])
        self.assertEqual([m["id"] for m in msgs], [forged["id"]])
        accepted, _ = poller.process_rows(cfg, muse_state, msgs)
        self.assertEqual(accepted, [])
        self.assertEqual(self._inbox(), [])
        self.assertTrue(any("dropped message" in line and "auth_failed" in line
                            for line in self.logs),
                        f"expected an auth_failed drop log, got: {self.logs}")
        # cursor advanced past it: a re-fetch returns nothing (no jam)
        self.assertEqual(poller.fetch(cfg, forged["id"]), [])

    # -- A2: DB export shows no readable content -----------------------
    def test_a2_exported_db_contains_no_readable_content(self):
        cfg = make_cfg(self.tmp.name)
        muse_state, web_sk, web_pk, web_kid = setup_verified_pair(self, self.fake, self.tmp.name)
        web_encrypt_to_muse(self.fake, web_sk, muse_state["muse_public_key"], "hello muse, this is secret")
        cfg["cursor"] = 0
        msgs = poller.fetch(cfg, cfg["cursor"])
        accepted, _ = poller.process_rows(cfg, muse_state, msgs)
        self.assertEqual(len(accepted), 1)
        # reply through the daemon's push path
        (Path(self.tmp.name) / "outbox" / "35.txt").write_text("hello back, also secret",
                                                              encoding="utf-8")
        poller.push_outbox(cfg, muse_state)
        dump = self.fake.dump_all_text()
        for secret in ("hello muse, this is secret", "hello back, also secret"):
            self.assertNotIn(secret, dump, "plaintext leaked into the stored rows")
        # every user/muse row carries ciphertext, never content in `text`
        for row in self.fake.messages:
            if row.get("text") in ("...", "pong"):
                continue
            self.assertIn("ciphertext", row, f"row {row['id']} has no ciphertext")
            self.assertNotIn("text", row, f"row {row['id']} carries plaintext in text")

    # -- A3: key substitution -------------------------------------------
    def test_a3_swapped_public_key_stops_processing(self):
        cfg = make_cfg(self.tmp.name)
        muse_state, web_sk, web_pk, web_kid = setup_verified_pair(self, self.fake, self.tmp.name)
        # attacker publishes a foreign key under a NEW key id (same endpoint)
        attacker_sk = PrivateKey.generate()
        attacker_pk = attacker_sk.public_key
        from crypto import b64encode
        self.fake.insert_key({"endpoint": "web",
                              "public_key": b64encode(bytes(attacker_pk)),
                              "key_id": key_id(bytes(attacker_pk)), "verified": False})
        old_number = relay_safety.read_safety_number(cfg["state_dir"])
        ready, web_row, published = poller.ensure_e2e_ready(cfg, muse_state, True)
        self.assertFalse(ready, "daemon must stop when the web key changes")
        reloaded = relay_keys.load_keys(cfg["state_dir"])
        self.assertFalse(reloaded["verified"], "local verification must be revoked")
        self.assertTrue(any("web public key changed" in line for line in self.logs))
        # and the safety number changed, so the owner would see the mismatch
        number = relay_safety.compute_for_keys(
            reloaded["muse_public_key"], reloaded["web_public_key"],
            reloaded["muse_key_id"], reloaded["web_key_id"])
        self.assertNotEqual(number, old_number)

    def test_a3b_same_key_id_different_key_bytes_still_fails(self):
        cfg = make_cfg(self.tmp.name)
        muse_state, web_sk, web_pk, web_kid = setup_verified_pair(self, self.fake, self.tmp.name)
        # attacker swaps the key BYTES but keeps the key id
        attacker_pk = PrivateKey.generate().public_key
        from crypto import b64encode
        for row in self.fake.relay_keys:
            if row["endpoint"] == "web":
                row["public_key"] = b64encode(bytes(attacker_pk))
        # a message encrypted to the ORIGINAL web key must now fail: the
        # daemon syncs the attacker's bytes and decryption with them fails
        web_encrypt_to_muse(self.fake, web_sk, muse_state["muse_public_key"], "should not get through")
        poller.ensure_e2e_ready(cfg, muse_state, True)
        msgs = poller.fetch(cfg, 0)
        accepted, _ = poller.process_rows(cfg, relay_keys.load_keys(cfg["state_dir"]), msgs)
        self.assertEqual(accepted, [])
        self.assertEqual(self._inbox(), [])

    # -- A4: lost key ----------------------------------------------------
    def test_a4_lost_key_refuses_and_history_unreadable(self):
        cfg = make_cfg(self.tmp.name)
        muse_state, web_sk, web_pk, web_kid = setup_verified_pair(self, self.fake, self.tmp.name)
        row = web_encrypt_to_muse(self.fake, web_sk, muse_state["muse_public_key"], "history I cannot lose")
        (cfg["state_dir"] / "keys.json").unlink()
        with self.assertRaises(relay_keys.KeysError):
            relay_keys.get_or_create_keys(cfg["state_dir"])
        # a fresh keypair cannot decrypt the old ciphertext
        fresh_sk = PrivateKey.generate()
        with self.assertRaises(Exception):
            decrypt_message(row["ciphertext"], row["nonce"], web_pk, fresh_sk)

    # -- A5: nonce (envelope level) --------------------------------------
    def test_a5_two_identical_replies_differ(self):
        cfg = make_cfg(self.tmp.name)
        muse_state, web_sk, web_pk, web_kid = setup_verified_pair(self, self.fake, self.tmp.name)
        from crypto import encrypt_reply_envelope, secret_key_from_b64, public_key_from_b64
        own_secret, _ = relay_keys.muse_keys(muse_state)
        web_public, _ = relay_keys.web_keys(muse_state)
        env1 = encrypt_reply_envelope("same answer", "35", _now_iso(),
                                      own_secret, web_public, muse_state["muse_key_id"])
        env2 = encrypt_reply_envelope("same answer", "35", _now_iso(),
                                      own_secret, web_public, muse_state["muse_key_id"])
        self.assertNotEqual(env1["nonce"], env2["nonce"])
        self.assertNotEqual(env1["ciphertext"], env2["ciphertext"])

    # -- A6: full local E2E simulation ------------------------------------
    def test_a6_end_to_end_simulation(self):
        cfg = make_cfg(self.tmp.name)
        muse_state, web_sk, web_pk, web_kid = setup_verified_pair(self, self.fake, self.tmp.name)
        # web -> muse
        web_encrypt_to_muse(self.fake, web_sk, muse_state["muse_public_key"], "xin chao, day la tin mat")
        cfg["cursor"] = 0
        msgs = poller.fetch(cfg, cfg["cursor"])
        accepted, threads = poller.process_rows(cfg, muse_state, msgs)
        self.assertEqual(len(accepted), 1)
        self.assertEqual(accepted[0]["text"], "xin chao, day la tin mat")
        self.assertTrue(accepted[0]["e2e"])
        self.assertEqual(self._inbox()[0]["text"], "xin chao, day la tin mat")
        # transport check after the inbound leg: no plaintext anywhere
        self.assertNotIn("xin chao", self.fake.dump_all_text())
        # muse -> web (through the daemon's push path)
        (Path(self.tmp.name) / "outbox" / "35.txt").write_text("chao lai, day la tra loi mat",
                                                              encoding="utf-8")
        poller.push_outbox(cfg, muse_state)
        self.assertFalse((Path(self.tmp.name) / "outbox" / "35.txt").exists())
        replies = [m for m in self.fake.messages if m.get("role") == "muse"
                   and m.get("ciphertext")]
        self.assertEqual(len(replies), 1)
        reply = replies[0]
        self.assertNotIn("text", reply)
        # web decrypts the reply
        from crypto import unpack_message
        plain = decrypt_message(reply["ciphertext"], reply["nonce"], 
                                __import__("crypto").public_key_from_b64(
                                    muse_state["muse_public_key"]), web_sk)
        self.assertEqual(unpack_message(plain)["body"], "chao lai, day la tra loi mat")
        self.assertNotIn("chao lai", self.fake.dump_all_text())

    # -- A7: single puller -------------------------------------------------
    def test_a7_single_puller_lock(self):
        from relay_auth import acquire_lock, release_lock
        state = Path(self.tmp.name) / "state"
        self.assertTrue(acquire_lock(state))
        self.assertFalse(acquire_lock(state), "second puller must be refused")
        release_lock(state)
        self.assertTrue(acquire_lock(state))
        release_lock(state)

    # -- A8: cursor never goes back ----------------------------------------
    def test_a8_cursor_max_and_corrupt(self):
        from relay_auth import AuthError, read_cursor, write_cursor
        state = Path(self.tmp.name) / "state"
        state.mkdir(parents=True, exist_ok=True)
        write_cursor(state, 50)
        (state / "cursor.json").write_text(json.dumps({"last_id": 50, "after": 30}),
                                           encoding="utf-8")
        self.assertEqual(read_cursor(state), 50, "MAX(last_id, after)")
        (state / "cursor.json").write_text(json.dumps({"last_id": 40, "after": 55}),
                                           encoding="utf-8")
        self.assertEqual(read_cursor(state), 55)
        (state / "cursor.json").write_text("{corrupt", encoding="utf-8")
        with self.assertRaises(AuthError):
            read_cursor(state)

    # -- A9: session install ------------------------------------------------
    def test_a9_install_session_and_build_cfg(self):
        state = Path(self.tmp.name) / "state"
        relay_auth.install_session(state, "muse_test@muserelay.local", "fake-refresh-token")
        saved = json.loads((state / "session.json").read_text(encoding="utf-8"))
        self.assertEqual(saved["refresh_token"], "fake-refresh-token")
        self.assertEqual(saved["email"], "muse_test@muserelay.local")
        self.assertEqual((state / "session.json").stat().st_mode & 0o777, 0o600)
        # get_session uses the file (refresh stubbed — no network)
        cfg = make_cfg(self.tmp.name)
        with mock.patch.object(relay_auth, "_refresh_session",
                               return_value={"access_token": "live-access",
                                             "refresh_token": "rotated-refresh",
                                             "expires_at": 9999999999}):
            sess = relay_auth.get_session(cfg)
        self.assertEqual(sess["access_token"], "live-access")
        # build_cfg: RELAY_SESSION in config is IGNORED, not required
        config_path = Path(self.tmp.name) / "config.json"
        config_path.write_text(json.dumps({
            "SUPABASE_PROJECT_ID": "33",
            "SUPABASE_URL": "https://fake.supabase.co",
            "SUPABASE_PUBLISHABLE_KEY": "sb_publishable_fake",
            "MUSE_EMAIL": "muse_test@muserelay.local",
            "RELAY_SESSION": "should-be-ignored"}), encoding="utf-8")
        cfg2 = relay_auth.build_cfg(config_path, state, Path(self.tmp.name) / "outbox")
        self.assertTrue(cfg2["session_in_config"])
        self.assertEqual(cfg2["session_ref"], "")
        # and a config WITHOUT any session at all still builds
        config_path.write_text(json.dumps({
            "SUPABASE_PROJECT_ID": "33",
            "SUPABASE_URL": "https://fake.supabase.co",
            "SUPABASE_PUBLISHABLE_KEY": "sb_publishable_fake",
            "MUSE_EMAIL": "muse_test@muserelay.local"}), encoding="utf-8")
        cfg3 = relay_auth.build_cfg(config_path, state, Path(self.tmp.name) / "outbox")
        self.assertEqual(cfg3["email"], "muse_test@muserelay.local")
        # ENC_VERSION other than 1 is refused
        config_path.write_text(json.dumps({
            "SUPABASE_PROJECT_ID": "33",
            "SUPABASE_URL": "https://fake.supabase.co",
            "SUPABASE_PUBLISHABLE_KEY": "sb_publishable_fake",
            "MUSE_EMAIL": "muse_test@muserelay.local",
            "ENC_VERSION": 2}), encoding="utf-8")
        with self.assertRaises(relay_auth.AuthError):
            relay_auth.build_cfg(config_path, state, Path(self.tmp.name) / "outbox")

    # -- A11: legacy gate at the poller level ------------------------------
    def test_a11_legacy_row_gated_by_flag(self):
        cfg = make_cfg(self.tmp.name, allow_legacy=False)
        muse_state, web_sk, web_pk, web_kid = setup_verified_pair(self, self.fake, self.tmp.name)
        self.fake.insert_message({"thread_id": 35, "project_id": PID, "role": "user",
                                  "text": "old plaintext row"})
        msgs = poller.fetch(cfg, 0)
        accepted, _ = poller.process_rows(cfg, muse_state, msgs)
        self.assertEqual(accepted, [])
        self.assertEqual(self._inbox(), [])
        cfg["allow_legacy_plaintext"] = True
        accepted, _ = poller.process_rows(cfg, muse_state, msgs)
        self.assertEqual(len(accepted), 1)
        self.assertFalse(accepted[0]["e2e"])
        self.assertEqual(self._inbox()[0]["text"], "old plaintext row")

    # -- A12: malformed rows dropped ----------------------------------------
    def test_a12_malformed_rows_dropped(self):
        cfg = make_cfg(self.tmp.name)
        muse_state, web_sk, web_pk, web_kid = setup_verified_pair(self, self.fake, self.tmp.name)
        good = web_encrypt_to_muse(self.fake, web_sk, muse_state["muse_public_key"], "good message")
        bad_version = dict(good); bad_version.pop("id")
        bad_version.update({"enc_version": 99})
        self.fake.insert_message(bad_version)
        bad_alg = dict(good); bad_alg.pop("id"); bad_alg.update({"alg": "aes-gcm"})
        self.fake.insert_message(bad_alg)
        bad_sender = dict(good); bad_sender.pop("id")
        bad_sender.update({"sender_key_id": "0000000000000000"})
        self.fake.insert_message(bad_sender)
        msgs = poller.fetch(cfg, 0)
        accepted, _ = poller.process_rows(cfg, muse_state, msgs)
        self.assertEqual([a["text"] for a in accepted], ["good message"])
        self.assertEqual(len(self.logs and [l for l in self.logs if "dropped message" in l]), 3)

    # -- A13: muse_client --once end to end ---------------------------------
    def test_a13_muse_client_once_full_round(self):
        import muse_client as mc
        tmpdir = Path(self.tmp.name)
        config_path = tmpdir / "config.json"
        config_path.write_text(json.dumps({
            "SUPABASE_PROJECT_ID": "33",
            "SUPABASE_URL": "https://fake.supabase.co",
            "SUPABASE_PUBLISHABLE_KEY": "sb_publishable_fake",
            "MUSE_EMAIL": "muse_test@muserelay.local"}), encoding="utf-8")
        relay_auth.install_session(tmpdir / "state", "muse_test@muserelay.local",
                                   "fake-refresh-token")
        with mock.patch.object(relay_auth, "_refresh_session",
                               return_value={"access_token": "live-access",
                                             "refresh_token": "rotated-refresh",
                                             "expires_at": 9999999999}):
            # run 1: first run — keys created, pong sent, cursor 0, not verified.
            # main() resolves relative "state"/"outbox" from the cwd, so run
            # it from the tmp dir.
            old_cwd = os.getcwd()
            os.chdir(tmpdir)
            try:
                with mock.patch.object(sys, "argv", ["muse_client.py", "--config",
                                                     str(config_path), "--once"]):
                    mc.main()
            finally:
                os.chdir(old_cwd)
        # pong was posted (plaintext signal) and keys exist
        self.assertTrue(any(m.get("text") == "pong" for m in self.fake.messages))
        muse_state = relay_keys.load_keys(tmpdir / "state")
        self.assertIsNotNone(muse_state)
        self.assertTrue(any(k["endpoint"] == "muse" for k in self.fake.relay_keys))
        # web side appears + verifies (simulating the web UI)
        web_sk = PrivateKey.generate()
        web_pk = web_sk.public_key
        from crypto import b64encode
        self.fake.insert_key({"endpoint": "web", "public_key": b64encode(bytes(web_pk)),
                              "key_id": key_id(bytes(web_pk)), "verified": True})
        # sync the new web key into keys.json BEFORE marking verified
        cfg_v = relay_auth.build_cfg(config_path, tmpdir / "state", tmpdir / "outbox")
        muse_state = relay_keys.load_keys(tmpdir / "state")
        row, _changed = relay_keys.sync_web_key(cfg_v, muse_state)
        self.assertIsNotNone(row)
        with mock.patch.object(relay_auth, "_refresh_session",
                               return_value={"access_token": "live-access",
                                             "refresh_token": "rotated-refresh",
                                             "expires_at": 9999999999}):
            relay_keys.mark_verified(cfg_v, tmpdir / "state")
        # web sends an encrypted message; run --once again -> inbox gets it
        web_encrypt_to_muse(self.fake, web_sk, muse_state["muse_public_key"], "once-mode hello")
        with mock.patch.object(relay_auth, "_refresh_session",
                               return_value={"access_token": "live-access",
                                             "refresh_token": "rotated-refresh",
                                             "expires_at": 9999999999}):
            old_cwd = os.getcwd()
            os.chdir(tmpdir)
            try:
                with mock.patch.object(sys, "argv", ["muse_client.py", "--config",
                                                     str(config_path), "--once"]):
                    mc.main()
            finally:
                os.chdir(old_cwd)
        inbox = [json.loads(l) for l in (tmpdir / "state" / "inbox.jsonl")
                 .read_text(encoding="utf-8").splitlines() if l]
        self.assertEqual([m["text"] for m in inbox if m["role"] == "user"],
                         ["once-mode hello"])
        # reply via outbox; run --once a third time -> encrypted push
        (tmpdir / "outbox" / "35.txt").write_text("once-mode reply", encoding="utf-8")
        with mock.patch.object(relay_auth, "_refresh_session",
                               return_value={"access_token": "live-access",
                                             "refresh_token": "rotated-refresh",
                                             "expires_at": 9999999999}):
            old_cwd = os.getcwd()
            os.chdir(tmpdir)
            try:
                with mock.patch.object(sys, "argv", ["muse_client.py", "--config",
                                                     str(config_path), "--once"]):
                    mc.main()
            finally:
                os.chdir(old_cwd)
        self.assertFalse((tmpdir / "outbox" / "35.txt").exists())
        replies = [m for m in self.fake.messages if m.get("role") == "muse"
                   and m.get("ciphertext")]
        self.assertEqual(len(replies), 1)
        from crypto import unpack_message
        plain = decrypt_message(replies[0]["ciphertext"], replies[0]["nonce"],
                                __import__("crypto").public_key_from_b64(
                                    muse_state["muse_public_key"]), web_sk)
        self.assertEqual(unpack_message(plain)["body"], "once-mode reply")
        # the fake transport never held either plaintext
        dump = self.fake.dump_all_text()
        self.assertNotIn("once-mode hello", dump)
        self.assertNotIn("once-mode reply", dump)


if __name__ == "__main__":
    unittest.main()
