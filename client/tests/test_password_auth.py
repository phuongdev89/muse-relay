"""Mocked tests for Muse Relay v6.2 password-mint auth.

No network, no real Supabase. requests.post is stubbed to behave like
GoTrue for the cases that matter: password mint, refresh, dead tokens,
wrong password. Run: python3 -m unittest discover -s tests -v
"""
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import requests

import relay_auth
from relay_auth import AuthError, TransientError, build_cfg, get_session, read_cursor


class FakeResp:
    def __init__(self, status, payload):
        self.status_code = status
        self._payload = payload
        self.text = json.dumps(payload)

    def json(self):
        return self._payload


def fake_post(url, headers=None, data=None, timeout=None):
    body = json.loads(data or "{}")
    if "grant_type=password" in url:
        if body.get("password") == "correct-password" and body.get("email") == "muse_test@muserelay.local":
            return FakeResp(200, {"access_token": "acc-pw", "refresh_token": "refresh-pw",
                                  "expires_in": 3600})
        return FakeResp(400, {"error": "invalid_grant",
                              "error_description": "Invalid login credentials"})
    if "grant_type=refresh_token" in url:
        token = body.get("refresh_token")
        if token in ("saved-refresh", "legacy-refresh", "refresh-pw"):
            return FakeResp(200, {"access_token": "acc-new-" + token,
                                  "refresh_token": "refresh-new-" + token,
                                  "expires_in": 3600})
        return FakeResp(400, {"error": "invalid_grant",
                              "error_description": "Invalid refresh token"})
    raise AssertionError(f"unexpected url {url}")


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.base = Path(self.tmp.name)
        self.state = self.base / "state"
        self.outbox = self.base / "outbox"
        self.state.mkdir()
        self.outbox.mkdir()
        self.config_path = self.base / "config.json"
        self.post_patch = patch.object(relay_auth.requests, "post", side_effect=fake_post)
        self.post_patch.start()

    def tearDown(self):
        self.post_patch.stop()
        self.tmp.cleanup()

    def write_config(self, **overrides):
        cfg = {"SUPABASE_URL": "https://testproject.supabase.co",
               "SUPABASE_PUBLISHABLE_KEY": "sb_publishable_test",
               "MUSE_EMAIL": "muse_test@muserelay.local"}
        cfg.update(overrides)
        self.config_path.write_text(json.dumps(cfg), encoding="utf-8")
        return cfg

    def build(self):
        return build_cfg(self.config_path, self.state, self.outbox)


class TestPasswordMint(Base):
    def test_password_mint_saves_session_and_scrubs_config(self):
        self.write_config(MUSE_PASSWORD="correct-password")
        cfg = self.build()
        sess = get_session(cfg)
        self.assertEqual(cfg["auth_source"], "password")
        self.assertEqual(sess["access_token"], "acc-pw")
        # Saved session holds the minted refresh token, chmod 600.
        saved = json.loads((self.state / "session.json").read_text(encoding="utf-8"))
        self.assertEqual(saved["refresh_token"], "refresh-pw")
        self.assertEqual(saved["email"], "muse_test@muserelay.local")
        self.assertEqual(oct((self.state / "session.json").stat().st_mode & 0o777), "0o600")
        # Password scrubbed from config.json and from memory.
        remaining = json.loads(self.config_path.read_text(encoding="utf-8"))
        self.assertNotIn("MUSE_PASSWORD", remaining)
        self.assertEqual(cfg["password"], "")

    def test_second_run_uses_saved_session_not_password(self):
        self.write_config(MUSE_PASSWORD="correct-password")
        cfg = self.build()
        get_session(cfg)
        # Simulate a restart: fresh cfg, password already scrubbed.
        cfg2 = self.build()
        self.assertEqual(cfg2["password"], "")
        sess = get_session(cfg2)
        self.assertEqual(cfg2["auth_source"], "saved-session")
        self.assertTrue(sess["access_token"].startswith("acc-new-refresh-pw"))

    def test_legacy_relay_session_still_works(self):
        self.write_config(RELAY_SESSION="legacy-refresh")
        cfg = self.build()
        sess = get_session(cfg)
        self.assertEqual(cfg["auth_source"], "relay-session")
        self.assertTrue(sess["access_token"].startswith("acc-new-legacy-refresh"))

    def test_dead_tokens_fall_through_to_password(self):
        # Dead saved session + dead legacy token -> password mint.
        (self.state / "session.json").write_text(
            json.dumps({"email": "muse_test@muserelay.local",
                        "refresh_token": "dead-refresh"}), encoding="utf-8")
        self.write_config(RELAY_SESSION="dead-refresh",
                          MUSE_PASSWORD="correct-password")
        cfg = self.build()
        sess = get_session(cfg)
        self.assertEqual(cfg["auth_source"], "password")
        self.assertEqual(sess["access_token"], "acc-pw")

    def test_wrong_password_raises_auth_error_without_secret(self):
        self.write_config(MUSE_PASSWORD="wrong-password")
        cfg = self.build()
        with self.assertRaises(AuthError) as cm:
            get_session(cfg)
        msg = str(cm.exception)
        self.assertIn("not confirmed", msg)
        self.assertNotIn("wrong-password", msg)
        self.assertNotIn("correct-password", msg)

    def test_build_cfg_rejects_no_credential(self):
        self.write_config()
        with self.assertRaises(AuthError):
            self.build()

    def test_network_error_is_transient_not_crash(self):
        self.write_config(MUSE_PASSWORD="correct-password")
        cfg = self.build()
        with patch.object(relay_auth.requests, "post",
                          side_effect=requests.ConnectionError("dns down")):
            with self.assertRaises(TransientError):
                get_session(cfg)


class TestCursor(unittest.TestCase):
    def test_read_cursor_takes_max_of_last_id_and_after(self):
        with tempfile.TemporaryDirectory() as d:
            state = Path(d)
            (state / "cursor.json").write_text(
                json.dumps({"last_id": 10, "after": 42}), encoding="utf-8")
            self.assertEqual(read_cursor(state), 42)
            (state / "cursor.json").write_text(
                json.dumps({"last_id": 99, "after": 3}), encoding="utf-8")
            self.assertEqual(read_cursor(state), 99)


if __name__ == "__main__":
    unittest.main()
