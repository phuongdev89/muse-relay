#!/usr/bin/env python3
"""Daemon-loop smoke test: run poller.main() against the fake Supabase.

Proves the real entry point (not just the pieces) works: startup, key
setup, pong, verified gate, fetch + decrypt + inbox, cursor advance,
typing signal, lock release. The loop is stopped by making time.sleep
raise KeyboardInterrupt after a few rounds.

NOTE on the cursor: on a first run poller.init_cursor() starts at the
newest message id and never replays history (v6 behaviour). So the test
pre-seeds state/cursor.json with last_id 0 (as if the daemon had run
once before) so round 1 fetches the pre-inserted message.

Run from the work directory:
    .venv/bin/python -m unittest discover -s tests -v
"""
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import poller  # noqa: E402
import relay_auth  # noqa: E402
import keys as relay_keys  # noqa: E402
from test_acceptance import (  # noqa: E402
    FakeSupabase, make_cfg, patch_api, setup_verified_pair,
    web_encrypt_to_muse,
)


class DaemonSmokeTest(unittest.TestCase):
    def test_poller_main_loop_against_fake(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        tmpdir = Path(tmp.name)
        fake = FakeSupabase()
        patch_api(self, fake)
        p_base = mock.patch.object(poller, "BASE", tmpdir)
        p_base.start()
        self.addCleanup(p_base.stop)
        p_log = mock.patch.object(poller, "LOG", tmpdir / "state" / "poller.log")
        p_log.start()
        self.addCleanup(p_log.stop)
        # config + verified keys, as setup would leave them
        (tmpdir / "config.json").write_text(json.dumps({
            "SUPABASE_PROJECT_ID": "33",
            "SUPABASE_URL": "https://fake.supabase.co",
            "SUPABASE_PUBLISHABLE_KEY": "sb_publishable_fake",
            "MUSE_EMAIL": "muse_test@muserelay.local"}), encoding="utf-8")
        cfg = make_cfg(tmp.name)
        muse_state, web_sk, web_pk, web_kid = setup_verified_pair(self, fake, tmp.name)
        web_encrypt_to_muse(fake, web_sk, muse_state["muse_public_key"],
                            "daemon smoke hello")
        # pre-seed the cursor at 0: the daemon has "run once before", so
        # round 1 fetches the pre-inserted message (init_cursor would
        # otherwise skip history on a true first run — v6 behaviour).
        relay_auth.write_cursor(tmpdir / "state", 0)
        # stop the infinite loop after 3 sleeps
        calls = {"n": 0}

        def fake_sleep(seconds):
            calls["n"] += 1
            if calls["n"] >= 3:
                raise KeyboardInterrupt

        with mock.patch("time.sleep", fake_sleep):
            with self.assertRaises(KeyboardInterrupt):
                poller.main()
        # the message reached the inbox, decrypted
        inbox_path = tmpdir / "state" / "inbox.jsonl"
        self.assertTrue(inbox_path.exists(), "inbox was never written")
        lines = [json.loads(l) for l in inbox_path.read_text(encoding="utf-8").splitlines() if l]
        self.assertEqual([l["text"] for l in lines if l["role"] == "user"],
                         ["daemon smoke hello"])
        self.assertTrue(all(l.get("e2e") for l in lines))
        # cursor advanced past everything fetched (web msg + typing signal)
        cursor = json.loads((tmpdir / "state" / "cursor.json").read_text(encoding="utf-8"))
        self.assertGreaterEqual(cursor["last_id"], 2)
        # lock released by the finally block
        self.assertFalse((tmpdir / "state" / "puller.lock").exists())
        # log shows the daemon started and processed the message
        log_text = (tmpdir / "state" / "poller.log").read_text(encoding="utf-8")
        self.assertIn("daemon start — E2E v7", log_text)
        self.assertIn("inbox +1 new messages", log_text)
        # transport never held the plaintext
        self.assertNotIn("daemon smoke hello", fake.dump_all_text())


if __name__ == "__main__":
    unittest.main()
