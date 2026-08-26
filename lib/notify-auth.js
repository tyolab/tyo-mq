'use strict';

// TYO Notify private topics — crypto + validation helpers. Pure, no storage,
// no server. See docs/specs/2026-08-26-tyo-notify-private-topics-design.md.

var crypto = require('crypto');
var adminSignature = require('tyo-mq-protocol').adminSignature;

// ── reserved namespace (future-proofing, §8 of the design doc) ─────────────
var RESERVED_TOPIC_RE = /^(_|system:)/;

function isReservedTopic(topic) {
    return typeof topic === 'string' && RESERVED_TOPIC_RE.test(topic);
}

// ── proof verification ──────────────────────────────────────────────────────
// Client-generated timestamp+nonce, no server-issued challenge (see design
// doc §4) — the freshness window bounds replay, same shape as
// tyo-mq-protocol's admin-signature.js.
var SIGNATURE_MAX_AGE_MS = 60 * 1000;

// admin-signature.js has this exact function internally but does not export
// it (module.exports only lists createAdminProof/signAdminAction/
// stableStringify/verifyAdminProof — checked). Rebuilding it here from the
// one primitive that IS exported (stableStringify) avoids modifying and
// republishing that shared package for one missing export.
function signatureBase(action, body, timestamp, nonce) {
    return [
        String(action || ''),
        String(timestamp || ''),
        String(nonce || ''),
        adminSignature.stableStringify(body || {})
    ].join('\n');
}

function importPubkey(pubkeyBase64) {
    try {
        var der = Buffer.from(String(pubkeyBase64), 'base64');
        return crypto.createPublicKey({ key: der, format: 'der', type: 'spki' });
    }
    catch (e) {
        return null;
    }
}

function pubkeyFingerprint(pubkeyBase64) {
    return crypto.createHash('sha256')
        .update(Buffer.from(String(pubkeyBase64), 'base64'))
        .digest('hex');
}

// Verifies a self-signed proof of key possession, scoped to (action, body) —
// callers MUST include {topic: <url topic>} in body to prevent a proof for
// one claimed topic being replayed against another topic owned by the same
// key. Never throws.
function verifyProof(pubkeyBase64, action, body, proof) {
    if (!proof || proof.timestamp === undefined || !proof.nonce || !proof.signature)
        return false;
    var timestamp = Number(proof.timestamp);
    if (!Number.isFinite(timestamp))
        return false;
    if (Math.abs(Date.now() - timestamp) > SIGNATURE_MAX_AGE_MS)
        return false;
    var key = importPubkey(pubkeyBase64);
    if (!key)
        return false;
    try {
        var base = signatureBase(action, body || {}, timestamp, proof.nonce);
        var signature = Buffer.from(String(proof.signature), 'base64');
        return crypto.verify('sha256', Buffer.from(base), key, signature);
    }
    catch (e) {
        return false; // malformed key/signature bytes
    }
}

// ── replay defense: bounded, TTL-swept (topic, nonce) set ──────────────────
// Same bounding discipline as the existing SSE ticket store — an in-memory
// Map swept opportunistically, never allowed to grow unbounded.
function NonceSeen(opts) {
    opts = opts || {};
    this.ttlMs = opts.ttlMs || SIGNATURE_MAX_AGE_MS;
    this._seen = new Map(); // "topic nonce" -> expiresAt
}

NonceSeen.prototype._sweep = function (now) {
    if (this._seen.size < 5000) return;
    var seen = this._seen;
    seen.forEach(function (exp, key) { if (exp < now) seen.delete(key); });
};

// A single-space delimiter is collision-safe here specifically because every
// caller has already validated `topic` against Notify.TOPIC_RE
// (letters/digits/dash/underscore only) before reaching this function —
// topic can never contain the delimiter, so it's always unambiguously
// recoverable as the prefix up to the first delimiter, regardless of what
// the (unrestricted) client-supplied nonce contains.
NonceSeen.prototype.checkAndRecord = function (topic, nonce, now) {
    now = now || Date.now();
    this._sweep(now);
    var key = String(topic) + ' ' + String(nonce);
    var exp = this._seen.get(key);
    if (exp !== undefined && exp >= now)
        return false; // replay within the window
    this._seen.set(key, now + this.ttlMs);
    return true;
};

// ── publish token ────────────────────────────────────────────────────────────
function generatePublishToken() {
    return crypto.randomBytes(32).toString('hex'); // 256-bit, hex
}

function hashPublishToken(token) {
    return crypto.createHash('sha256').update(String(token)).digest('hex');
}

function publishTokenMatches(token, hash) {
    var left = Buffer.from(hashPublishToken(token), 'hex');
    var right = Buffer.from(String(hash || ''), 'hex');
    return left.length === right.length && crypto.timingSafeEqual(left, right);
}

module.exports = {
    isReservedTopic: isReservedTopic,
    signatureBase: signatureBase,
    importPubkey: importPubkey,
    pubkeyFingerprint: pubkeyFingerprint,
    verifyProof: verifyProof,
    NonceSeen: NonceSeen,
    generatePublishToken: generatePublishToken,
    hashPublishToken: hashPublishToken,
    publishTokenMatches: publishTokenMatches,
    SIGNATURE_MAX_AGE_MS: SIGNATURE_MAX_AGE_MS
};
