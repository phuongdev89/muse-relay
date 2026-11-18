#!/usr/bin/env python3
"""Safety number for out-of-band key verification (Muse Relay v7).

Pushing a public key to relay_keys is transport only — whoever controls
the database could substitute their own key. Trust is established by
comparing a safety number OUTSIDE the relay (the official Muse chat, or
in person). The number is computed from BOTH public keys, so a substituted
key changes the number and the mismatch is visible.

Construction (fixed — the web side must compute it EXACTLY the same way):
  1. Order the two raw public keys lexicographically (fixed order, so both
     sides agree which is "first" regardless of who computes it).
  2. digest = SHA-256(b"muse-relay-safety-v1" || b"\\x00" || key_first
                      || b"\\x00" || key_second
                      || b"\\x00" || key_id_first || b"\\x00" || key_id_second)
     (key_ids follow their own keys through the ordering.)
  3. Take the digest as a big-endian integer, write it in decimal, left-pad
     with zeros to 78 digits, keep the FIRST 48 digits.
  4. Display as 12 groups of 4 digits ("1234 5678 ..."); the copyable form
     is the same 48 digits without spaces.

Note on the design text: it says "12 groups x 4 digits (or 60 continuous
digits for the copyable version)". 12 x 4 = 48, not 60 — the "60" is an
arithmetic slip in the design. This implementation uses 48 digits in both
forms. If the web side implements 60 digits the numbers will never match,
so both sides must use 48.

The safety number is NOT secret (it is derived from public keys) — but it
must never be compared THROUGH the relay itself, because that is the very
channel being verified. The daemon writes it to state/safety_number.txt
(mode 600); Muse reads it out in the official chat when the owner asks.
"""
import argparse
import hashlib
import sys
from pathlib import Path

GROUPS = 12
DIGITS_PER_GROUP = 4
TOTAL_DIGITS = GROUPS * DIGITS_PER_GROUP  # 48
DOMAIN = b"muse-relay-safety-v1"


def compute_safety_number(pub_a, pub_b, kid_a, kid_b):
    """Safety number (grouped string) from two raw public keys + key ids.
    pub_a/pub_b are raw 32-byte keys; kid_a/kid_b are their key_id strings."""
    ordered = sorted(((bytes(pub_a), str(kid_a)), (bytes(pub_b), str(kid_b))))
    (key_first, kid_first), (key_second, kid_second) = ordered
    digest = hashlib.sha256(
        DOMAIN + b"\x00" + key_first + b"\x00" + key_second
        + b"\x00" + kid_first.encode("ascii") + b"\x00" + kid_second.encode("ascii")
    ).digest()
    decimal = str(int.from_bytes(digest, "big")).zfill(78)
    digits = decimal[:TOTAL_DIGITS]
    return " ".join(digits[i:i + DIGITS_PER_GROUP]
                    for i in range(0, TOTAL_DIGITS, DIGITS_PER_GROUP))


def compute_for_keys(muse_public_b64, web_public_b64, muse_key_id, web_key_id):
    """Convenience wrapper taking base64 public keys (as stored in keys.json)."""
    import base64
    muse_pub = base64.b64decode(muse_public_b64.encode("ascii"))
    web_pub = base64.b64decode(web_public_b64.encode("ascii"))
    return compute_safety_number(muse_pub, web_pub, muse_key_id, web_key_id)


def safety_number_path(state_dir):
    return Path(state_dir) / "safety_number.txt"


def write_safety_number(state_dir, number):
    """Write the safety number (mode 600). Rewriting the same value is a
    no-op — the daemon calls this every round and must not churn the file."""
    path = safety_number_path(state_dir)
    content = ("# Muse Relay safety number — compare it OUT OF BAND "
               "(official Muse chat, or in person). Never compare it through "
               "a relay message; that is the very channel being verified.\n"
               + number + "\n")
    if path.exists():
        try:
            if path.read_text(encoding="utf-8") == content:
                return False
        except OSError:
            pass
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")
    try:
        path.chmod(0o600)
    except OSError:
        pass
    return True


def read_safety_number(state_dir):
    """The safety number string, or None if the file is absent."""
    path = safety_number_path(state_dir)
    if not path.exists():
        return None
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if line and not line.startswith("#"):
            return line
    return None


def _cli():
    ap = argparse.ArgumentParser(description="Muse Relay v7 safety number")
    ap.add_argument("--state-dir", default="state")
    ap.add_argument("cmd", choices=["show"],
                    help="show: print the safety number from state/safety_number.txt")
    args = ap.parse_args()
    number = read_safety_number(args.state_dir)
    if number is None:
        print("no safety number yet — start the daemon once (it needs both public keys)",
              file=sys.stderr)
        sys.exit(1)
    print(number)


if __name__ == "__main__":
    _cli()
