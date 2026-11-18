#!/usr/bin/env python3
"""End-to-end encryption for Muse Relay v7 — the ONLY module that calls PyNaCl.

Algorithm (fixed by design, do not change): libsodium crypto_box
(X25519 + XSalsa20-Poly1305) via PyNaCl.
  - Encrypt with: own secret key + recipient's public key.
  - Decrypt with: own secret key + sender's public key.
  - Fresh random 24-byte nonce per message, never reused with the same key pair.
  - No shared symmetric key, no double ratchet.

Correct-usage warning (the easiest point to get wrong): never encrypt with
your own secret key expecting the other side to decrypt with your public
key — a public key is public, so anyone holding it could read the message.
The formulas above are the only correct ones.

Plaintext package (encrypted as one JSON object; everything outside it is
public metadata):
    {"type": "text" | "reply", "body": "<message text>",
     "thread_ref": "<internal thread reference, if any>",
     "client_time": "<ISO 8601 send time>"}

Supabase envelope (new columns on the messages table):
    ciphertext (base64), nonce (base64, 24 bytes), sender_key_id,
    enc_version = 1, alg = "crypto_box".
Metadata stays plaintext for routing: id, thread_id, role, created_at.

Two deliberate, documented exceptions to "no plaintext on Supabase":
  1. The daemon's own protocol signals '...' (typing) and 'pong' (ready)
     are fixed constant strings, not message content. They stay plaintext
     exactly as in v6 so both endpoints recognise them without decrypting;
     they carry no user content. They are written by relay_auth.py, not here.
  2. The design docs call the content column "content"; the real v6 column
     is named "text". v7 stops writing user content to "text"; the column is
     kept only for the two fixed signals above and for the (opt-in, off by
     default) legacy-plaintext migration window. Deleting the column entirely
     would require moving the signals into the encrypted envelope — a later
     phase, needing the web side to agree.

Logging rule: this module NEVER logs anything. Callers log only metadata
(ids, thread ids, key ids, drop reasons) — never plaintext, ciphertext,
nonces, or keys.
"""
import base64
import binascii
import hashlib
import json

from nacl.exceptions import CryptoError as _NaclCryptoError
from nacl.public import Box, PrivateKey, PublicKey
from nacl.utils import random as _random

ENC_VERSION = 1
ALG = "crypto_box"
NONCE_SIZE = Box.NONCE_SIZE  # 24

# Message types allowed inside the encrypted JSON package.
MESSAGE_TYPES = ("text", "reply")


class CryptoError(Exception):
    """Any crypto failure (bad format, bad key, authentication failure)."""


class DropMessage(Exception):
    """A fetched row must be dropped (fail-closed). `reason` is metadata
    only — safe to log. Never contains content."""

    def __init__(self, reason):
        super().__init__(reason)
        self.reason = reason


# ---------- base64 (strict) ----------

def b64encode(data):
    return base64.b64encode(data).decode("ascii")


def b64decode(text, what):
    if not isinstance(text, str):
        raise CryptoError(f"{what} is not a base64 string")
    try:
        return base64.b64decode(text.encode("ascii"), validate=True)
    except (binascii.Error, ValueError, UnicodeEncodeError):
        raise CryptoError(f"{what} is not valid base64")


# ---------- key material helpers ----------

def public_key_from_b64(text):
    raw = b64decode(text, "public key")
    if len(raw) != PublicKey.SIZE:
        raise CryptoError("public key has the wrong length")
    return PublicKey(raw)


def secret_key_from_b64(text):
    raw = b64decode(text, "secret key")
    if len(raw) != PrivateKey.SIZE:
        raise CryptoError("secret key has the wrong length")
    return PrivateKey(raw)


def key_id(public_key_bytes):
    """Short fingerprint of a public key: first 16 hex chars of its SHA-256.
    Used as sender_key_id so the recipient can pick the right key and notice
    when a key changes. Documented construction — the web side must compute
    it exactly the same way."""
    return hashlib.sha256(public_key_bytes).hexdigest()[:16]


# ---------- plaintext package ----------

def pack_message(msg_type, body, thread_ref, client_time):
    """Build the single JSON package that gets encrypted. Returns bytes."""
    if msg_type not in MESSAGE_TYPES:
        raise CryptoError(f"unknown message type: {msg_type!r}")
    if not isinstance(body, str):
        raise CryptoError("message body must be text")
    package = {
        "type": msg_type,
        "body": body,
        "thread_ref": thread_ref if thread_ref is not None else "",
        "client_time": client_time if client_time is not None else "",
    }
    return json.dumps(package, ensure_ascii=False).encode("utf-8")


def unpack_message(data):
    """Parse and validate a decrypted package. Returns the dict.
    Raises CryptoError on any structural problem."""
    try:
        package = json.loads(data.decode("utf-8"))
    except (ValueError, UnicodeDecodeError):
        raise CryptoError("decrypted package is not valid JSON")
    if not isinstance(package, dict):
        raise CryptoError("decrypted package is not a JSON object")
    if package.get("type") not in MESSAGE_TYPES:
        raise CryptoError("decrypted package has an unknown type")
    if not isinstance(package.get("body"), str):
        raise CryptoError("decrypted package has no text body")
    if not isinstance(package.get("thread_ref", ""), str):
        raise CryptoError("decrypted package has a bad thread_ref")
    if not isinstance(package.get("client_time", ""), str):
        raise CryptoError("decrypted package has a bad client_time")
    return package


# ---------- crypto_box ----------

def encrypt_message(plaintext, recipient_public_key, own_secret_key):
    """Encrypt one package. Returns (ciphertext_b64, nonce_b64) with a fresh
    random 24-byte nonce. `plaintext` is bytes; keys are nacl key objects."""
    nonce = _random(NONCE_SIZE)
    box = Box(own_secret_key, recipient_public_key)
    encrypted = box.encrypt(plaintext, nonce)
    return b64encode(encrypted.ciphertext), b64encode(nonce)


def decrypt_message(ciphertext_b64, nonce_b64, sender_public_key, own_secret_key):
    """Decrypt one package. Returns the plaintext bytes.
    Raises CryptoError on bad base64, bad nonce length, or authentication
    failure (tampered ciphertext or wrong sender key)."""
    ciphertext = b64decode(ciphertext_b64, "ciphertext")
    nonce = b64decode(nonce_b64, "nonce")
    if len(nonce) != NONCE_SIZE:
        raise CryptoError(f"nonce is {len(nonce)} bytes, expected {NONCE_SIZE}")
    box = Box(own_secret_key, sender_public_key)
    try:
        return box.decrypt(ciphertext, nonce)
    except _NaclCryptoError:
        raise CryptoError("authentication failed — wrong sender key or tampered ciphertext")


# ---------- row-level helpers (shared by poller.py and muse_client.py) ----------

def encrypt_reply_envelope(body, thread_ref, client_time,
                           own_secret_key, recipient_public_key, sender_key_id):
    """Build the Supabase envelope for one reply. Returns the dict of new
    columns; the caller adds routing fields (thread_id, project_id, role).
    No plaintext content leaves this function."""
    plaintext = pack_message("reply", body, thread_ref, client_time)
    ciphertext_b64, nonce_b64 = encrypt_message(plaintext, recipient_public_key, own_secret_key)
    return {
        "ciphertext": ciphertext_b64,
        "nonce": nonce_b64,
        "sender_key_id": sender_key_id,
        "enc_version": ENC_VERSION,
        "alg": ALG,
    }


def decrypt_row(row, own_secret_key, web_public_key, web_key_id, allow_legacy=False):
    """Validate + decrypt one fetched Supabase row (role='user').

    Returns ("e2e", package_dict) for a valid encrypted message, or
    ("legacy", {"body": ...}) for a pre-E2E plaintext row when the migration
    window is explicitly enabled. Raises DropMessage(reason) for anything
    else — the caller must drop the row, log only the reason + ids, and
    never write it to the inbox.

    Check order (fail-closed): version -> algorithm -> sender key ->
    nonce -> ciphertext -> authentication -> package structure.
    """
    ciphertext = row.get("ciphertext")
    if ciphertext is None:
        # No ciphertext: either a legacy plaintext row or a malformed row.
        text = row.get("text")
        if text is not None and allow_legacy:
            return ("legacy", {"type": "text", "body": text,
                               "thread_ref": str(row.get("thread_id", "")),
                               "client_time": row.get("created_at", "")})
        raise DropMessage("legacy_plaintext_not_allowed" if text is not None
                          else "missing_ciphertext")
    if row.get("enc_version") != ENC_VERSION:
        raise DropMessage("bad_enc_version")
    if row.get("alg") != ALG:
        raise DropMessage("bad_alg")
    if row.get("sender_key_id") != web_key_id:
        raise DropMessage("unknown_sender_key")
    try:
        plaintext = decrypt_message(ciphertext, row.get("nonce"),
                                    web_public_key, own_secret_key)
    except CryptoError as e:
        raise DropMessage("bad_nonce" if "nonce" in str(e) else "auth_failed")
    try:
        package = unpack_message(plaintext)
    except CryptoError:
        raise DropMessage("bad_package")
    return ("e2e", package)
