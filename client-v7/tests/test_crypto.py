#!/usr/bin/env python3
"""Unit tests for crypto.py (Muse Relay v7).

Run from the work directory:
    .venv/bin/python -m unittest discover -s tests -v
"""
import base64
import json
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from crypto import (  # noqa: E402
    ALG, ENC_VERSION, NONCE_SIZE, CryptoError, DropMessage, b64decode,
    b64encode, decrypt_message, decrypt_row, encrypt_message, encrypt_reply_envelope,
    key_id, pack_message, unpack_message,
)
from nacl.public import PrivateKey  # noqa: E402


def make_pair():
    sk = PrivateKey.generate()
    return sk, sk.public_key


def make_row(ciphertext_b64, nonce_b64, sender_key_id, enc_version=1, alg="crypto_box",
             text=None, thread_id=35, msg_id=101):
    row = {"id": msg_id, "thread_id": thread_id, "role": "user",
           "ciphertext": ciphertext_b64, "nonce": nonce_b64,
           "sender_key_id": sender_key_id, "enc_version": enc_version, "alg": alg,
           "created_at": "2026-11-18T00:00:00Z"}
    if text is not None:
        row["text"] = text
    return row


class TestRoundTrip(unittest.TestCase):
    def test_web_to_muse_and_back(self):
        web_sk, web_pk = make_pair()
        muse_sk, muse_pk = make_pair()
        msg = pack_message("text", "hello muse", "35", "2026-11-18T00:00:00Z")
        ct, nonce = encrypt_message(msg, muse_pk, web_sk)
        out = decrypt_message(ct, nonce, web_pk, muse_sk)
        self.assertEqual(out, msg)
        self.assertEqual(unpack_message(out)["body"], "hello muse")
        # and the reply direction
        reply = pack_message("reply", "hello back", "35", "2026-11-18T00:00:01Z")
        ct2, nonce2 = encrypt_message(reply, web_pk, muse_sk)
        self.assertEqual(unpack_message(decrypt_message(ct2, nonce2, muse_pk, web_sk))["body"],
                         "hello back")

    def test_wrong_recipient_key_fails(self):
        web_sk, web_pk = make_pair()
        muse_sk, muse_pk = make_pair()
        other_sk, _ = make_pair()
        ct, nonce = encrypt_message(b"secret", muse_pk, web_sk)
        with self.assertRaises(CryptoError):
            decrypt_message(ct, nonce, web_pk, other_sk)

    def test_wrong_sender_key_fails(self):
        web_sk, web_pk = make_pair()
        muse_sk, muse_pk = make_pair()
        attacker_sk, attacker_pk = make_pair()
        ct, nonce = encrypt_message(b"secret", muse_pk, web_sk)
        # Attacker re-encrypts nothing: the row claims the web key but the
        # ciphertext was not made with it — decrypt with attacker key fails.
        with self.assertRaises(CryptoError):
            decrypt_message(ct, nonce, attacker_pk, muse_sk)

    def test_tampered_ciphertext_fails(self):
        web_sk, web_pk = make_pair()
        muse_sk, muse_pk = make_pair()
        ct, nonce = encrypt_message(b"secret", muse_pk, web_sk)
        raw = bytearray(b64decode(ct, "ciphertext"))
        raw[0] ^= 1
        with self.assertRaises(CryptoError):
            decrypt_message(b64encode(bytes(raw)), nonce, web_pk, muse_sk)

    def test_tampered_nonce_fails(self):
        web_sk, web_pk = make_pair()
        muse_sk, muse_pk = make_pair()
        ct, nonce = encrypt_message(b"secret", muse_pk, web_sk)
        raw = bytearray(b64decode(nonce, "nonce"))
        raw[-1] ^= 1
        with self.assertRaises(CryptoError):
            decrypt_message(ct, b64encode(bytes(raw)), web_pk, muse_sk)

    def test_bad_nonce_length(self):
        web_sk, web_pk = make_pair()
        muse_sk, muse_pk = make_pair()
        ct, _ = encrypt_message(b"secret", muse_pk, web_sk)
        short = b64encode(b"\x00" * 23)
        with self.assertRaises(CryptoError):
            decrypt_message(ct, short, web_pk, muse_sk)

    def test_bad_base64(self):
        with self.assertRaises(CryptoError):
            b64decode("!!!not-base64!!!", "ciphertext")
        with self.assertRaises(CryptoError):
            decrypt_message("!!!", b64encode(b"\x00" * NONCE_SIZE),
                            make_pair()[1], make_pair()[0])

    def test_nonce_uniqueness(self):
        web_sk, _ = make_pair()
        _, muse_pk = make_pair()
        msg = pack_message("text", "identical content", "35", "2026-11-18T00:00:00Z")
        seen_nonce, seen_ct = set(), set()
        for _ in range(100):
            ct, nonce = encrypt_message(msg, muse_pk, web_sk)
            self.assertNotIn(nonce, seen_nonce)
            self.assertNotIn(ct, seen_ct)
            seen_nonce.add(nonce)
            seen_ct.add(ct)
        self.assertEqual(len(seen_nonce), 100)
        self.assertEqual(len(seen_ct), 100)


class TestPackage(unittest.TestCase):
    def test_pack_unpack_round_trip(self):
        data = pack_message("reply", "hi", "35", "2026-11-18T00:00:00Z")
        pkg = unpack_message(data)
        self.assertEqual(pkg, {"type": "reply", "body": "hi",
                               "thread_ref": "35",
                               "client_time": "2026-11-18T00:00:00Z"})

    def test_bad_package_rejected(self):
        with self.assertRaises(CryptoError):
            unpack_message(b"not json")
        with self.assertRaises(CryptoError):
            unpack_message(json.dumps({"type": "signal", "body": "x"}).encode())
        with self.assertRaises(CryptoError):
            unpack_message(json.dumps({"type": "text", "body": 123}).encode())
        with self.assertRaises(CryptoError):
            pack_message("signal", "x", "35", "2026-11-18T00:00:00Z")

    def test_key_id_construction(self):
        import hashlib
        _, pk = make_pair()
        raw = bytes(pk)
        self.assertEqual(key_id(raw), hashlib.sha256(raw).hexdigest()[:16])
        self.assertEqual(len(key_id(raw)), 16)


class TestDecryptRow(unittest.TestCase):
    def setUp(self):
        self.web_sk, self.web_pk = make_pair()
        self.muse_sk, self.muse_pk = make_pair()
        self.web_kid = key_id(bytes(self.web_pk))

    def _valid_row(self, body="hello"):
        pkg = pack_message("text", body, "35", "2026-11-18T00:00:00Z")
        ct, nonce = encrypt_message(pkg, self.muse_pk, self.web_sk)
        return make_row(ct, nonce, self.web_kid)

    def test_valid_row_decrypts(self):
        kind, pkg = decrypt_row(self._valid_row(), self.muse_sk, self.web_pk, self.web_kid)
        self.assertEqual(kind, "e2e")
        self.assertEqual(pkg["body"], "hello")

    def test_unknown_sender_key_dropped(self):
        row = self._valid_row()
        row["sender_key_id"] = "deadbeefdeadbeef"
        with self.assertRaises(DropMessage) as cm:
            decrypt_row(row, self.muse_sk, self.web_pk, self.web_kid)
        self.assertEqual(cm.exception.reason, "unknown_sender_key")

    def test_bad_enc_version_dropped(self):
        row = self._valid_row()
        row["enc_version"] = 2
        with self.assertRaises(DropMessage) as cm:
            decrypt_row(row, self.muse_sk, self.web_pk, self.web_kid)
        self.assertEqual(cm.exception.reason, "bad_enc_version")

    def test_bad_alg_dropped(self):
        row = self._valid_row()
        row["alg"] = "aes-gcm"
        with self.assertRaises(DropMessage) as cm:
            decrypt_row(row, self.muse_sk, self.web_pk, self.web_kid)
        self.assertEqual(cm.exception.reason, "bad_alg")

    def test_forged_ciphertext_dropped(self):
        row = make_row(b64encode(b"\x00" * 60), b64encode(b"\x00" * NONCE_SIZE), self.web_kid)
        with self.assertRaises(DropMessage) as cm:
            decrypt_row(row, self.muse_sk, self.web_pk, self.web_kid)
        self.assertEqual(cm.exception.reason, "auth_failed")

    def test_missing_ciphertext_dropped_by_default(self):
        row = {"id": 101, "thread_id": 35, "role": "user",
               "ciphertext": None, "nonce": None, "sender_key_id": None,
               "enc_version": None, "alg": None, "text": "plaintext hello"}
        with self.assertRaises(DropMessage) as cm:
            decrypt_row(row, self.muse_sk, self.web_pk, self.web_kid, allow_legacy=False)
        self.assertEqual(cm.exception.reason, "legacy_plaintext_not_allowed")

    def test_legacy_accepted_only_when_enabled(self):
        row = {"id": 101, "thread_id": 35, "role": "user",
               "ciphertext": None, "nonce": None, "sender_key_id": None,
               "enc_version": None, "alg": None, "text": "plaintext hello"}
        kind, pkg = decrypt_row(row, self.muse_sk, self.web_pk, self.web_kid, allow_legacy=True)
        self.assertEqual(kind, "legacy")
        self.assertEqual(pkg["body"], "plaintext hello")

    def test_encrypt_reply_envelope(self):
        env = encrypt_reply_envelope("answer", "35", "2026-11-18T00:00:00Z",
                                     self.muse_sk, self.web_pk, key_id(bytes(self.muse_pk)))
        self.assertEqual(env["enc_version"], ENC_VERSION)
        self.assertEqual(env["alg"], ALG)
        self.assertEqual(env["sender_key_id"], key_id(bytes(self.muse_pk)))
        out = decrypt_message(env["ciphertext"], env["nonce"], self.muse_pk, self.web_sk)
        self.assertEqual(unpack_message(out)["body"], "answer")
        # envelope carries no plaintext
        blob = json.dumps(env)
        self.assertNotIn("answer", blob)


if __name__ == "__main__":
    unittest.main()
