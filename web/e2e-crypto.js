/* Muse Relay v7 — browser-side E2E crypto engine (web/e2e-crypto.js)
 *
 * Contract mirror of the daemon's client-v7/crypto.py + safety.py (PyNaCl
 * crypto_box_easy). Every construction below is verified byte-for-byte
 * against docs/e2e-test-vectors.json before any UI ships (design doc §9).
 *
 * Two engines, identical ciphertext:
 *   Tier A (primary): WebCrypto X25519 (private key = non-extractable
 *     CryptoKey, stored in IndexedDB) + tweetnacl's HSalsa20 core
 *     (lowlevel.crypto_core_hsalsa20) + tweetnacl secretbox (XSalsa20-Poly1305).
 *   Tier B (fallback, lazy CDN load): libsodium-wrappers crypto_box_easy —
 *     private key is raw 32 bytes, stored only in IndexedDB.
 *
 * Byte layout (must match libsodium "easy" / PyNaCl Box):
 *   ciphertext = MAC(16B) || XSalsa20-Poly1305(msg, nonce24, beforenm)
 *   beforenm   = HSalsa20(X25519(my_priv, their_pub), 16 zero bytes, sigma)
 *   nonce      = 24 random bytes per message — never reused, retry = new nonce
 *   key_id     = hex(sha256(raw public key 32B))[:16], lowercase
 *   SAS        = SHA-256("muse-relay-safety-v1" || 0x00 || key_first || 0x00 ||
 *               key_second || 0x00 || ascii(kid_first) || 0x00 ||
 *               ascii(kid_second)); decimal, zero-pad LEFT to 78 digits,
 *               FIRST 48 digits — 12 groups of 4 (never mod 10^48).
 *
 * This file is DOM-free: it loads in the browser (window.MRE2E) and in
 * Node (module.exports) for the vector test harness.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.MRE2E = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  var SIGMA = new Uint8Array([101, 120, 112, 97, 110, 100, 32, 51,
                              50, 45, 98, 121, 116, 101, 32, 107]); // "expand 32-byte k"
  var ENC_VERSION = 1;
  var ALG = "crypto_box";
  var SAS_DOMAIN = "muse-relay-safety-v1";
  var PACKAGE_TYPES = ["text", "reply"];

  var subtle = (typeof self !== "undefined" && self.crypto && self.crypto.subtle)
    ? self.crypto.subtle : null;
  var _nacl = null;   // injected via init()
  var tier = null;    // 'A' | 'B' — set by detectTier()
  var _sodium = null; // Tier B lazy

  function CryptoError(msg) {
    var e = new Error(msg); e.name = "CryptoError"; return e;
  }

  function init(opts) {
    opts = opts || {};
    _nacl = opts.nacl || (typeof self !== "undefined" ? self.nacl : null);
    if (opts.subtle) subtle = opts.subtle;
    if (!_nacl) throw CryptoError("tweetnacl not loaded — include web/vendor/nacl-fast.min.js first");
    if (!subtle) throw CryptoError("WebCrypto unavailable");
  }

  function requireNacl() {
    if (!_nacl) throw CryptoError("MRE2E.init({nacl}) was not called");
    return _nacl;
  }

  // ---------- base64 / utf8 (strict) ----------
  function b64encode(bytes) {
    var bin = "";
    for (var i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin);
  }
  function b64decode(text, what) {
    if (typeof text !== "string") throw CryptoError((what || "value") + " is not a base64 string");
    var bin;
    try {
      if (!/^[A-Za-z0-9+/]*={0,3}$/.test(text)) throw new Error("bad charset");
      bin = atob(text);
    } catch (e) {
      throw CryptoError((what || "value") + " is not valid base64");
    }
    var out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  function utf8encode(s) {
    return new TextEncoder().encode(s);
  }
  function utf8decode(bytes) {
    return new TextDecoder("utf-8").decode(bytes);
  }

  // ---------- key_id ----------
  async function keyIdFromRaw(pubRaw) {
    var digest = await subtle.digest("SHA-256", pubRaw);
    var hex = "";
    var v = new Uint8Array(digest);
    for (var i = 0; i < 16; i++) hex += (v[i] < 16 ? "0" : "") + v[i].toString(16);
    return hex.slice(0, 16); // first 16 HEX chars (8 bytes) — mirrors crypto.key_id
  }
  async function keyIdFromB64(pubB64) {
    return keyIdFromRaw(b64decode(pubB64, "public key"));
  }

  // ---------- tier detection ----------
  async function detectTier() {
    try {
      await subtle.generateKey({ name: "X25519" }, false, ["deriveBits"]);
      tier = "A";
    } catch (e) {
      tier = "B"; // libsodium path, loaded on demand
    }
    return tier;
  }
  function currentTier() { return tier; }

  // ---------- Tier B lazy load ----------
  function loadSodium() {
    if (_sodium) return Promise.resolve(_sodium);
    if (typeof self === "undefined" || !self.document) {
      return Promise.reject(CryptoError("Tier B needs a browser (CDN libsodium)"));
    }
    return new Promise(function (resolve, reject) {
      var s = document.createElement("script");
      s.src = "https://cdn.jsdelivr.net/npm/libsodium-wrappers-sumo@0.7.15/dist/browsers/sodiumjs.js";
      s.onload = function () {
        if (self.sodium) {
          self.sodium.ready.then(function () {
            _sodium = self.sodium; resolve(_sodium);
          }).catch(reject);
        } else reject(CryptoError("libsodium failed to load"));
      };
      s.onerror = function () { reject(CryptoError("libsodium CDN unreachable")); };
      document.head.appendChild(s);
    });
  }

  // ---------- Tier A key operations ----------
  async function generateKeypairA() {
    var pair = await subtle.generateKey({ name: "X25519" }, false, ["deriveBits"]);
    var pubRaw = new Uint8Array(await subtle.exportKey("raw", pair.publicKey));
    if (pubRaw.length !== 32) throw CryptoError("public key is not 32 bytes");
    var privKey = pair.privateKey; // non-extractable by construction
    return { publicRaw: pubRaw, privKey: privKey, tier: "A" };
  }

  async function deriveSharedA(privKey, peerPubRaw) {
    var peerKey = await subtle.importKey("raw", peerPubRaw, { name: "X25519" }, false, []);
    var bits = await subtle.deriveBits({ name: "X25519", public: peerKey }, privKey, 256);
    if (bits.byteLength !== 32) throw CryptoError("X25519 shared secret is not 32 bytes");
    return new Uint8Array(bits);
  }

  // HSalsa20(shared, 16 zero bytes, sigma) — the crypto_box_beforenm step.
  function beforenmFromShared(shared32) {
    var nacl = requireNacl();
    if (shared32.length !== 32) throw CryptoError("shared secret is not 32 bytes");
    var out = new Uint8Array(32);
    nacl.lowlevel.crypto_core_hsalsa20(out, new Uint8Array(16), shared32, SIGMA);
    return out;
  }

  // ---------- Tier B key operations ----------
  async function generateKeypairB() {
    var sodium = await loadSodium();
    var kp = sodium.crypto_box_keypair();
    return { publicRaw: new Uint8Array(kp.publicKey), privRaw: new Uint8Array(kp.privateKey), tier: "B" };
  }
  function beforenmFromKeysB(privRaw, peerPubRaw) {
    var sodium = _sodium;
    return new Uint8Array(sodium.crypto_box_beforenm(peerPubRaw, privRaw));
  }

  // ---------- symmetric core (both tiers) ----------
  function encryptToBytes(plainBytes, beforenm, opts) {
    var nacl = requireNacl();
    var nonce = (opts && opts.nonce) ? opts.nonce : nacl.randomBytes(24);
    if (nonce.length !== 24) throw CryptoError("nonce is " + nonce.length + " bytes, expected 24");
    var boxed = nacl.secretbox(plainBytes, nonce, beforenm); // MAC(16) first
    if (!boxed) throw CryptoError("secretbox failed");
    return { ciphertext: boxed, nonce: nonce };
  }
  function decryptFromBytes(boxedBytes, nonce, beforenm) {
    var nacl = requireNacl();
    if (nonce.length !== 24) throw CryptoError("nonce is " + nonce.length + " bytes, expected 24");
    var msg = nacl.secretbox.open(boxedBytes, nonce, beforenm);
    if (!msg) throw CryptoError("authentication failed — wrong sender key or tampered ciphertext");
    return msg;
  }

  // ---------- plaintext package (mirror crypto.py pack/unpack) ----------
  function packMessage(msgType, body, threadRef, clientTime) {
    if (PACKAGE_TYPES.indexOf(msgType) < 0) throw CryptoError("unknown message type: " + msgType);
    if (typeof body !== "string") throw CryptoError("message body must be text");
    return utf8encode(JSON.stringify({
      type: msgType,
      body: body,
      thread_ref: threadRef == null ? "" : threadRef,
      client_time: clientTime == null ? "" : clientTime,
    }));
  }
  function unpackMessage(plainBytes) {
    var pkg;
    try {
      pkg = JSON.parse(utf8decode(plainBytes));
    } catch (e) {
      throw CryptoError("decrypted package is not valid JSON");
    }
    if (!pkg || typeof pkg !== "object" || Array.isArray(pkg)) {
      throw CryptoError("decrypted package is not a JSON object");
    }
    if (PACKAGE_TYPES.indexOf(pkg.type) < 0) throw CryptoError("decrypted package has an unknown type");
    if (typeof pkg.body !== "string") throw CryptoError("decrypted package has no text body");
    if (typeof (pkg.thread_ref || "") !== "string") throw CryptoError("decrypted package has a bad thread_ref");
    if (typeof (pkg.client_time || "") !== "string") throw CryptoError("decrypted package has a bad client_time");
    return pkg;
  }

  // ---------- SAS (mirror safety.py) ----------
  async function computeSas(pubA_b64, kidA, pubB_b64, kidB) {
    var pubA = b64decode(pubA_b64, "public key A");
    var pubB = b64decode(pubB_b64, "public key B");
    if (pubA.length !== 32 || pubB.length !== 32) throw CryptoError("public key is not 32 bytes");
    // tuple sort: key bytes first, key_id tie-break (JS sort of byte arrays —
    // compare lexicographically, tie-break on the key_id strings)
    var cmp = lexicompare(pubA, pubB);
    var kFirst, kSecond, kidFirst, kidSecond;
    if (cmp < 0 || (cmp === 0 && kidA <= kidB)) {
      kFirst = pubA; kSecond = pubB; kidFirst = kidA; kidSecond = kidB;
    } else {
      kFirst = pubB; kSecond = pubA; kidFirst = kidB; kidSecond = kidA;
    }
    var parts = [utf8encode(SAS_DOMAIN), new Uint8Array([0]), kFirst, new Uint8Array([0]),
                 kSecond, new Uint8Array([0]), utf8encode(kidFirst), new Uint8Array([0]),
                 utf8encode(kidSecond)];
    var total = 0;
    for (var i = 0; i < parts.length; i++) total += parts[i].length;
    var input = new Uint8Array(total), off = 0;
    for (var j = 0; j < parts.length; j++) { input.set(parts[j], off); off += parts[j].length; }
    var digest = new Uint8Array(await subtle.digest("SHA-256", input));
    // big-endian integer → decimal string (BigInt), zero-pad LEFT to 78, FIRST 48 digits
    var hex = "0x";
    for (var d = 0; d < digest.length; d++) hex += (digest[d] < 16 ? "0" : "") + digest[d].toString(16);
    var dec = BigInt(hex).toString(10);
    while (dec.length < 78) dec = "0" + dec;
    var digits = dec.slice(0, 48);
    var grouped = "";
    for (var g = 0; g < 12; g++) {
      if (g) grouped += " ";
      grouped += digits.slice(g * 4, g * 4 + 4);
    }
    return { grouped: grouped, copyable: digits };
  }
  function lexicompare(a, b) {
    var n = Math.min(a.length, b.length);
    for (var i = 0; i < n; i++) {
      if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
    }
    if (a.length === b.length) return 0;
    return a.length < b.length ? -1 : 1;
  }

  // ---------- unified keypair API (tier-aware) ----------
  async function generateKeypair() {
    if (tier === null) await detectTier();
    return tier === "A" ? generateKeypairA() : generateKeypairB();
  }
  // beforenm from MY stored private material (privKey CryptoKey | privRaw bytes)
  async function beforenm(myPriv, peerPubRaw) {
    if (tier === null) await detectTier();
    var shared;
    if (tier === "A") {
      shared = await deriveSharedA(myPriv, peerPubRaw);
    } else {
      shared = null; // handled below via sodium beforenm
    }
    if (tier === "A") return beforenmFromShared(shared);
    return beforenmFromKeysB(myPriv, peerPubRaw);
  }

  // ---------- row-level gate (mirror crypto.decrypt_row, async) ----------
  // getBeforenm(senderKeyB64OrKid) -> Promise<Uint8Array|null> (UI resolves its
  //   own priv + the peer public key; null = unknown sender key)
  // Returns { kind:'e2e', package } | { kind:'legacy', body } | { drop: reason }
  async function decryptRow(row, opts) {
    var ciphertext = row.ciphertext;
    if (ciphertext == null) {
      var text = row.text;
      if (text != null && opts.allowLegacy) {
        return { kind: "legacy", body: text,
                 threadRef: String(row.thread_id == null ? "" : row.thread_id),
                 clientTime: row.created_at || "" };
      }
      return { drop: text != null ? "legacy_plaintext_not_allowed" : "missing_ciphertext" };
    }
    if (row.enc_version !== ENC_VERSION) return { drop: "bad_enc_version" };
    if (row.alg !== ALG) return { drop: "bad_alg" };
    var beforenm;
    try {
      beforenm = await opts.getBeforenm(row.sender_key_id, row);
    } catch (e) {
      return { drop: "unknown_sender_key" };
    }
    if (!beforenm) return { drop: "unknown_sender_key" };
    var nonce, boxed;
    try {
      nonce = b64decode(row.nonce, "nonce");
      boxed = b64decode(ciphertext, "ciphertext");
    } catch (e) {
      return { drop: "bad_nonce" };
    }
    var plain;
    try {
      plain = decryptFromBytes(boxed, nonce, beforenm);
    } catch (e) {
      return { drop: String(e.message).indexOf("nonce") >= 0 ? "bad_nonce" : "auth_failed" };
    }
    var pkg;
    try {
      pkg = unpackMessage(plain);
    } catch (e) {
      return { drop: "bad_package" };
    }
    return { kind: "e2e", package: pkg };
  }

  // ---------- reply envelope builder ----------
  async function encryptReplyEnvelope(body, threadRef, clientTime, beforenm, senderKeyId) {
    var plain = packMessage("reply", body, threadRef, clientTime);
    var box = encryptToBytes(plain, beforenm);
    return {
      ciphertext: b64encode(box.ciphertext),
      nonce: b64encode(box.nonce),
      sender_key_id: senderKeyId,
      enc_version: ENC_VERSION,
      alg: ALG,
    };
  }
  async function encryptUserEnvelope(text, threadRef, clientTime, beforenm, senderKeyId) {
    var plain = packMessage("text", text, threadRef, clientTime);
    var box = encryptToBytes(plain, beforenm);
    return {
      ciphertext: b64encode(box.ciphertext),
      nonce: b64encode(box.nonce),
      sender_key_id: senderKeyId,
      enc_version: ENC_VERSION,
      alg: ALG,
    };
  }

  return {
    // setup
    init: init, detectTier: detectTier, currentTier: currentTier, loadSodium: loadSodium,
    // encoding
    b64encode: b64encode, b64decode: b64decode, utf8encode: utf8encode, utf8decode: utf8decode,
    // keys
    keyIdFromRaw: keyIdFromRaw, keyIdFromB64: keyIdFromB64,
    generateKeypair: generateKeypair, generateKeypairA: generateKeypairA, generateKeypairB: generateKeypairB,
    deriveSharedA: deriveSharedA, beforenmFromShared: beforenmFromShared,
    beforenm: beforenm,
    // symmetric
    encryptToBytes: encryptToBytes, decryptFromBytes: decryptFromBytes,
    packMessage: packMessage, unpackMessage: unpackMessage,
    encryptReplyEnvelope: encryptReplyEnvelope, encryptUserEnvelope: encryptUserEnvelope,
    // SAS
    computeSas: computeSas,
    // row gate
    decryptRow: decryptRow,
    // constants
    ENC_VERSION: ENC_VERSION, ALG: ALG, SAS_DOMAIN: SAS_DOMAIN,
    CryptoError: CryptoError,
  };
});
