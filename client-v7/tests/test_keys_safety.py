#!/usr/bin/env python3
"""Unit tests for keys.py and safety.py (Muse Relay v7).

Run from the work directory:
    .venv/bin/python -m unittest discover -s tests -v
"""
import base64
import json
import os
import stat
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import keys  # noqa: E402
import safety  # noqa: E402
from crypto import key_id  # noqa: E402
from nacl.public import PrivateKey  # noqa: E402


class TestKeys(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.state = Path(self.tmp.name) / "state"
        self.state.mkdir()

    def tearDown(self):
        self.tmp.cleanup()

    def test_create_and_load_round_trip(self):
        created = keys.create_keys(self.state)
        self.assertEqual((self.state / "keys.json").stat().st_mode & 0o777, 0o600)
        self.assertTrue((self.state / "keys.ever_created").exists())
        loaded = keys.load_keys(self.state)
        self.assertEqual(loaded["muse_key_id"], created["muse_key_id"])
        self.assertEqual(loaded["muse_public_key"], created["muse_public_key"])
        self.assertFalse(loaded["verified"])

    def test_get_or_create_first_run_then_loads_same(self):
        first = keys.get_or_create_keys(self.state)
        second = keys.get_or_create_keys(self.state)
        self.assertEqual(first["muse_key_id"], second["muse_key_id"])
        self.assertEqual(first["muse_secret_key"], second["muse_secret_key"])

    def test_load_rejects_unsafe_permissions(self):
        keys.create_keys(self.state)
        os.chmod(self.state / "keys.json", 0o640)
        with self.assertRaises(keys.KeysError):
            keys.load_keys(self.state)

    def test_load_rejects_corrupt_file(self):
        (self.state / "keys.json").write_text("{not json", encoding="utf-8")
        os.chmod(self.state / "keys.json", 0o600)
        with self.assertRaises(keys.KeysError):
            keys.load_keys(self.state)

    def test_load_rejects_wrong_key_length(self):
        data = keys.create_keys(self.state)
        data["muse_public_key"] = base64.b64encode(b"\x00" * 16).decode()
        (self.state / "keys.json").write_text(json.dumps(data), encoding="utf-8")
        os.chmod(self.state / "keys.json", 0o600)
        with self.assertRaises(keys.KeysError):
            keys.load_keys(self.state)

    def test_load_rejects_mismatched_key_id(self):
        data = keys.create_keys(self.state)
        data["muse_key_id"] = "0000000000000000"
        (self.state / "keys.json").write_text(json.dumps(data), encoding="utf-8")
        os.chmod(self.state / "keys.json", 0o600)
        with self.assertRaises(keys.KeysError):
            keys.load_keys(self.state)

    def test_lost_key_refuses_silent_replacement(self):
        keys.create_keys(self.state)
        (self.state / "keys.json").unlink()
        self.assertTrue((self.state / "keys.ever_created").exists())
        with self.assertRaises(keys.KeysError) as cm:
            keys.get_or_create_keys(self.state)
        self.assertIn("LOST KEY", str(cm.exception))

    def test_key_id_matches_public_key(self):
        data = keys.create_keys(self.state)
        raw = base64.b64decode(data["muse_public_key"])
        self.assertEqual(data["muse_key_id"], key_id(raw))


class TestSafety(unittest.TestCase):
    def test_number_is_48_digits_in_12_groups(self):
        a = PrivateKey.generate()
        b = PrivateKey.generate()
        n = safety.compute_safety_number(bytes(a.public_key), bytes(b.public_key),
                                         key_id(bytes(a.public_key)),
                                         key_id(bytes(b.public_key)))
        groups = n.split(" ")
        self.assertEqual(len(groups), 12)
        self.assertTrue(all(len(g) == 4 and g.isdigit() for g in groups))
        self.assertEqual(len(n.replace(" ", "")), 48)

    def test_number_is_order_independent(self):
        a = PrivateKey.generate()
        b = PrivateKey.generate()
        ka, kb = key_id(bytes(a.public_key)), key_id(bytes(b.public_key))
        n1 = safety.compute_safety_number(bytes(a.public_key), bytes(b.public_key), ka, kb)
        n2 = safety.compute_safety_number(bytes(b.public_key), bytes(a.public_key), kb, ka)
        self.assertEqual(n1, n2)

    def test_number_is_deterministic(self):
        a = PrivateKey.generate()
        b = PrivateKey.generate()
        ka, kb = key_id(bytes(a.public_key)), key_id(bytes(b.public_key))
        self.assertEqual(
            safety.compute_safety_number(bytes(a.public_key), bytes(b.public_key), ka, kb),
            safety.compute_safety_number(bytes(a.public_key), bytes(b.public_key), ka, kb))

    def test_different_keys_give_different_numbers(self):
        a = PrivateKey.generate()
        b = PrivateKey.generate()
        c = PrivateKey.generate()
        ka, kb, kc = (key_id(bytes(k.public_key)) for k in (a, b, c))
        n_ab = safety.compute_safety_number(bytes(a.public_key), bytes(b.public_key), ka, kb)
        n_ac = safety.compute_safety_number(bytes(a.public_key), bytes(c.public_key), ka, kc)
        self.assertNotEqual(n_ab, n_ac)

    def test_write_read_round_trip_and_idempotent(self):
        with tempfile.TemporaryDirectory() as d:
            state = Path(d)
            self.assertTrue(safety.write_safety_number(state, "0001 0002 0003 0004 0005 0006 "
                                                              "0007 0008 0009 0010 0011 0012"))
            self.assertEqual((state / "safety_number.txt").stat().st_mode & 0o777, 0o600)
            self.assertEqual(safety.read_safety_number(state),
                             "0001 0002 0003 0004 0005 0006 0007 0008 0009 0010 0011 0012")
            # rewriting the same value is a no-op (mtime unchanged)
            mtime = (state / "safety_number.txt").stat().st_mtime_ns
            self.assertFalse(safety.write_safety_number(state, "0001 0002 0003 0004 0005 0006 "
                                                               "0007 0008 0009 0010 0011 0012"))
            self.assertEqual((state / "safety_number.txt").stat().st_mtime_ns, mtime)
            self.assertIsNone(safety.read_safety_number(Path(d) / "nonexistent"))


if __name__ == "__main__":
    unittest.main()
