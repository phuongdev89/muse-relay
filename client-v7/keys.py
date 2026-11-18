#!/usr/bin/env python3
"""Key management for the Muse endpoint (Muse Relay v7).

One static X25519 key pair per endpoint — no shared key, no ratchet.
The Muse private key lives ONLY in state/keys.json (chmod 600), created by
the daemon on first run. It is never sent to Supabase, never logged, never
printed in chat, and never included in any shared zip.

Lost-key rule (locked by the owner): losing the private key means losing
the ability to decrypt old history. There is no backdoor and no recovery
flow — only re-keying (see rekey()). To enforce that, a marker file
state/keys.ever_created is written when keys are first created: if
keys.json later disappears while the marker exists, the daemon REFUSES to
silently generate a replacement and stops with a clear error instead.

Public keys are published to the relay_keys table (public keys only — a
private key never appears in any table). Verification is a separate,
out-of-band step: the owner compares the safety number (see safety.py) in
the official Muse chat and only then marks the keys verified.

This module is the only place that reads/writes state/keys.json.
"""
import argparse
import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

from nacl.public import PrivateKey, PublicKey

sys.path.insert(0, str(Path(__file__).resolve().parent))
from crypto import b64decode, b64encode, key_id  # noqa: E402
from relay_auth import AuthError, TransientError, api, build_cfg  # noqa: E402


class KeysError(Exception):
    """Key file missing, corrupt, unsafe, or lost (fail-closed)."""


KEYS_FILE = "keys.json"
MARKER_FILE = "keys.ever_created"
SAFETY_FILE = "safety_number.txt"


def _now_iso():
    return datetime.now(timezone.utc).isoformat()


def _atomic_write_600(path, text):
    """Write text to path atomically with mode 600 from the first byte:
    the temp file is created with 0o600 (never with default umask perms),
    then renamed over the target."""
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    fd = os.open(path.with_suffix(".tmp"), os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    try:
        os.write(fd, text.encode("utf-8"))
    finally:
        os.close(fd)
    os.replace(path.with_suffix(".tmp"), path)
    os.chmod(path, 0o600)


def generate_keypair():
    """A fresh X25519 key pair. Returns (secret_key_bytes, public_key_bytes)."""
    secret = PrivateKey.generate()
    return bytes(secret), bytes(secret.public_key)


def _check_public_key(public_b64):
    public = b64decode(public_b64, "public key")
    if len(public) != 32:
        raise KeysError("public key has the wrong length")
    return public


def _check_key_bytes(secret_b64, public_b64):
    try:
        secret = b64decode(secret_b64, "secret key")
    except Exception as e:
        raise KeysError(f"keys.json has undecodable key material: {e}")
    if len(secret) != PrivateKey.SIZE:
        raise KeysError("keys.json secret key has the wrong length")
    return secret, _check_public_key(public_b64)


def load_keys(state_dir):
    """Load and validate state/keys.json. Returns the dict, or None if the
    file does not exist. Raises KeysError on corrupt content or unsafe
    permissions (any group/other access is refused)."""
    path = Path(state_dir) / KEYS_FILE
    if not path.exists():
        return None
    mode = path.stat().st_mode & 0o777
    if mode & 0o077:
        raise KeysError(
            f"state/keys.json has unsafe permissions {oct(mode)} — it must be "
            "readable only by its owner (600). Refusing to use it.")
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (ValueError, OSError) as e:
        raise KeysError(f"state/keys.json is corrupt: {e}")
    if not isinstance(data, dict) or data.get("version") != 1:
        raise KeysError("state/keys.json has an unknown format version")
    for field in ("muse_secret_key", "muse_public_key", "muse_key_id"):
        if not isinstance(data.get(field), str) or not data[field]:
            raise KeysError(f"state/keys.json is missing {field}")
    _check_key_bytes(data["muse_secret_key"], data["muse_public_key"])
    if data["muse_key_id"] != key_id(b64decode(data["muse_public_key"], "public key")):
        raise KeysError("state/keys.json muse_key_id does not match its public key")
    if data.get("web_public_key"):
        _check_public_key(data["web_public_key"])
    return data


def _save_keys(state_dir, data):
    _atomic_write_600(Path(state_dir) / KEYS_FILE, json.dumps(data, indent=2))


def create_keys(state_dir):
    """First run only: generate a key pair and store it (mode 600, atomic).
    Also writes the ever-created marker. Returns the keys dict."""
    secret, public = generate_keypair()
    data = {
        "version": 1,
        "muse_secret_key": b64encode(secret),
        "muse_public_key": b64encode(public),
        "muse_key_id": key_id(public),
        "web_public_key": None,
        "web_key_id": None,
        "web_verified": False,
        "verified": False,
        "created_at": _now_iso(),
        "revoked_key_ids": [],
    }
    _save_keys(state_dir, data)
    marker = Path(state_dir) / MARKER_FILE
    marker.write_text(f"keys first created {_now_iso()}\n", encoding="utf-8")
    try:
        marker.chmod(0o600)
    except OSError:
        pass
    return data


def get_or_create_keys(state_dir):
    """Load existing keys, or create them on a genuine first run.
    If keys.json is missing but the marker shows keys existed before, this
    is a LOST KEY: raise KeysError and refuse to auto-create a replacement.
    The operator must run an explicit re-key instead."""
    existing = load_keys(state_dir)
    if existing is not None:
        return existing
    if (Path(state_dir) / MARKER_FILE).exists():
        raise KeysError(
            "state/keys.json is missing but keys were created before — this is "
            "a LOST KEY. Refusing to silently generate a replacement (old "
            "history would become unreadable without warning). Run an "
            "explicit re-key: python3 keys.py rekey --config config.json")
    return create_keys(state_dir)


def muse_keys(data):
    """(PrivateKey, PublicKey) objects for the Muse endpoint."""
    secret, public = _check_key_bytes(data["muse_secret_key"], data["muse_public_key"])
    return PrivateKey(secret), PublicKey(public)


def web_keys(data):
    """(PublicKey object, key_id) for the web endpoint, or (None, None)."""
    if not data.get("web_public_key"):
        return None, None
    public = _check_public_key(data["web_public_key"])
    return PublicKey(public), data.get("web_key_id")


# ---------- relay_keys table (public keys only) ----------

def publish_public_key(cfg, keys):
    """Publish the Muse public key to relay_keys (verified=false).
    Returns True when the row exists afterwards. Idempotent: a row for this
    key_id is never duplicated. Raises TransientError/AuthError on failure —
    the caller retries on a later round."""
    key_id_value = keys["muse_key_id"]
    r = api(cfg, "GET",
            f"relay_keys?select=key_id&endpoint=eq.muse&key_id=eq.{key_id_value}",
            "checking the published Muse key")
    if r.json():
        return True
    api(cfg, "POST", "relay_keys", "publishing the Muse public key",
        extra_headers={"Prefer": "return=minimal", "Content-Type": "application/json"},
        data=json.dumps({"endpoint": "muse", "public_key": keys["muse_public_key"],
                         "key_id": key_id_value, "verified": False},
                        ensure_ascii=False).encode("utf-8"),
        expect=(200, 201))
    return True


def sync_web_key(cfg, keys):
    """Fetch the newest non-revoked web public key from relay_keys.
    Returns (web_row_or_None, changed_bool). On a key change the cached web
    key is replaced, local verification is REVOKED (verified=False) and the
    updated keys.json is saved — the daemon must stop processing until the
    owner re-verifies out of band. This is the key-substitution detector."""
    r = api(cfg, "GET",
            "relay_keys?select=public_key,key_id,verified&endpoint=eq.web"
            "&revoked_at=is.null&order=created_at.desc&limit=1",
            "fetching the web public key")
    rows = r.json()
    if not rows:
        return None, False
    row = rows[0]
    had_previous = bool(keys.get("web_key_id")) and bool(keys.get("web_public_key"))
    if had_previous and row.get("key_id") == keys.get("web_key_id") \
            and row.get("public_key") == keys.get("web_public_key"):
        # Same key: only the web side's verified flag may have moved.
        changed = bool(row.get("verified")) != bool(keys.get("web_verified"))
        keys["web_verified"] = bool(row.get("verified"))
        if changed:
            _save_keys(cfg["state_dir"], keys)
        return row, False
    # New key (or first sync, or a substituted key): never trust it silently.
    # A change after a previous key existed revokes local verification.
    keys["web_public_key"] = row["public_key"]
    keys["web_key_id"] = row["key_id"]
    keys["web_verified"] = bool(row.get("verified"))
    keys["verified"] = False
    _save_keys(cfg["state_dir"], keys)
    return row, had_previous


def mark_verified(cfg, state_dir):
    """Owner confirmed the safety number out of band: mark the keys verified
    locally and (best-effort) on the relay_keys row so the web side can see
    it. Raises KeysError when there is no web key to verify against."""
    keys = load_keys(state_dir)
    if keys is None:
        raise KeysError("no keys yet — start the daemon once to generate them")
    if not keys.get("web_public_key"):
        raise KeysError("no web public key yet — the web side has not published one")
    keys["verified"] = True
    _save_keys(state_dir, keys)
    try:
        api(cfg, "PATCH",
            f"relay_keys?endpoint=eq.muse&key_id=eq.{keys['muse_key_id']}",
            "marking the Muse key verified",
            extra_headers={"Prefer": "return=minimal", "Content-Type": "application/json"},
            data=json.dumps({"verified": True}).encode("utf-8"),
            expect=(200, 201, 204))
    except (AuthError, TransientError) as e:
        # Local verification is what gates the daemon; the row update only
        # informs the web side, so a failure here is a warning, not fatal.
        print(f"[keys] warning: could not mark the relay_keys row verified: {e}",
              file=sys.stderr)
    return keys


def revoke_key(cfg, key_id_value, endpoint="muse"):
    """Mark a key revoked in relay_keys (never deleted, so history stays
    attributable). Best-effort: returns True on success."""
    try:
        api(cfg, "PATCH",
            f"relay_keys?endpoint=eq.{endpoint}&key_id=eq.{key_id_value}",
            "revoking a key",
            extra_headers={"Prefer": "return=minimal", "Content-Type": "application/json"},
            data=json.dumps({"revoked_at": _now_iso()}).encode("utf-8"),
            expect=(200, 201, 204))
        return True
    except (AuthError, TransientError) as e:
        print(f"[keys] warning: could not revoke key {key_id_value}: {e}", file=sys.stderr)
        return False


def rekey(cfg, state_dir):
    """Explicit operator re-key (lost key, suspected leak): generate a new
    pair, revoke the old one, publish the new one unverified. Old history
    becomes unreadable — accepted by design. Returns the new keys dict."""
    old = load_keys(state_dir)
    old_key_id = old["muse_key_id"] if old else None
    new = create_keys(state_dir) if old is None else None
    if old is not None:
        if old_key_id:
            revoke_key(cfg, old_key_id, "muse")
        # Replace the key material in place, keeping the revoked list.
        secret, public = generate_keypair()
        old["muse_secret_key"] = b64encode(secret)
        old["muse_public_key"] = b64encode(public)
        old["muse_key_id"] = key_id(public)
        old["verified"] = False
        old["web_verified"] = False
        old["revoked_key_ids"] = list(old.get("revoked_key_ids") or []) + [old_key_id]
        old["created_at"] = _now_iso()
        _save_keys(state_dir, old)
        new = old
    publish_public_key(cfg, new)
    return new


# ---------- CLI (operator use during setup / re-key) ----------

def _cli():
    ap = argparse.ArgumentParser(description="Muse Relay v7 key management")
    ap.add_argument("--config", default="config.json")
    ap.add_argument("--state-dir", default="state")
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("status", help="show key ids and verification state (local only)")
    sub.add_parser("publish", help="publish the Muse public key to relay_keys")
    sub.add_parser("verify", help="mark keys verified after out-of-band safety-number check")
    sub.add_parser("rekey", help="generate a new key pair (old history becomes unreadable)")
    args = ap.parse_args()
    state_dir = Path(args.state_dir)
    if args.cmd == "status":
        keys = load_keys(state_dir)
        if keys is None:
            print("no keys yet — start the daemon once to generate them")
            return
        print(f"muse key_id: {keys['muse_key_id']} (created {keys.get('created_at')})")
        print(f"web key_id:  {keys.get('web_key_id') or '(none yet)'}")
        print(f"verified:    {keys.get('verified')} (local) / web row: {keys.get('web_verified')}")
        if keys.get("revoked_key_ids"):
            print(f"revoked:     {', '.join(keys['revoked_key_ids'])}")
        safety = state_dir / SAFETY_FILE
        if safety.exists():
            print(f"safety number file: {safety} (compare out of band, never via relay)")
        return
    try:
        cfg = build_cfg(args.config, args.state_dir, "outbox")
    except AuthError as e:
        print(f"[keys] {e}", file=sys.stderr)
        sys.exit(1)
    cfg["state_dir"] = Path(args.state_dir)
    if args.cmd == "publish":
        keys = get_or_create_keys(state_dir)
        publish_public_key(cfg, keys)
        print(f"[keys] published muse public key {keys['muse_key_id']} (verified=false)")
    elif args.cmd == "verify":
        keys = mark_verified(cfg, state_dir)
        print(f"[keys] verified muse key {keys['muse_key_id']} — daemon may now process messages")
    elif args.cmd == "rekey":
        keys = rekey(cfg, state_dir)
        print(f"[keys] re-keyed: new muse key_id {keys['muse_key_id']} (verified=false). "
              "Old history is unreadable. Verify the new safety number out of band, "
              "then run: python3 keys.py verify --config config.json")


if __name__ == "__main__":
    _cli()
