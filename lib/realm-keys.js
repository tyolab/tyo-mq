/**
 * @file realm-keys.js
 *
 * Realm pre-shared keys (PSK) at rest, and secret rotation with overlap.
 *
 * WHY: a realm's `key` is only ever equality-compared (a token-less consumer
 * presents it at AUTHENTICATION), so the broker never needs the raw value —
 * yet it was stored raw in the settings file / auth store, where a leaked
 * dump or an operator's console scroll-back handed out a working credential
 * (2026-10-15). Storing `sha256:<hex>` instead means a leak of what the
 * broker holds yields nothing usable; the client still sends the raw key and
 * the broker hashes it to compare. Manager keys cannot be hashed (they are
 * HMAC secrets — the broker must hold the raw value to verify a proof), so
 * for those the win is rotation, not hashing.
 *
 * ROTATION WITH OVERLAP: replacing a key used to be a flag day — the old
 * value stopped working the instant the new one landed, so every holder had
 * to switch atomically. `set_realm_key {key, grace}` / `set_realm_manager_key
 * {manager_key, grace}` (and POST /api/realms with `grace`) keep the previous
 * secret as `previous_*` with an `until` timestamp; both are accepted inside
 * the grace window, a match on the PREVIOUS one is logged so old-key use can
 * be watched down to zero, and the previous value is dropped once `until`
 * lapses (or on the next rotation). The JWKS validator already rolls signing
 * keys this way by `kid`; this brings the two static realm secrets up to the
 * same standard.
 *
 * Normalisation is one-way and idempotent: a realm config carrying a raw
 * `key` / `preshared_key` / `presharedKey` is rewritten in place to
 * `key_hash`. It runs on auth-store sync, at boot merge, and lazily at first
 * use, so correctness never depends on a migration step having happened.
 */

'use strict';

const crypto = require('crypto');

const HASH_PREFIX = 'sha256:';
const HASH_DOMAIN = 'tyo-mq realm key v1\0';
// A rotation grace window never outlives a month: a "previous" secret that
// is still valid after that is just two live secrets.
const MAX_GRACE_MS = 30 * 24 * 60 * 60 * 1000;

function hashRealmKey(key) {
    return HASH_PREFIX + crypto.createHash('sha256')
        .update(HASH_DOMAIN + String(key), 'utf8')
        .digest('hex');
}

function isRealmKeyHash(value) {
    return typeof value === 'string'
        && value.indexOf(HASH_PREFIX) === 0
        && value.length === HASH_PREFIX.length + 64;
}

// Constant-time: hash the presented raw key and compare digests.
function realmKeyMatches(presented, storedHash) {
    if (typeof presented !== 'string' || !presented || !isRealmKeyHash(storedHash))
        return false;
    var a = Buffer.from(hashRealmKey(presented), 'utf8');
    var b = Buffer.from(storedHash, 'utf8');
    return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// True while an ISO `until` is still in the future.
function stillValid(until, now) {
    var t = Date.parse(until);
    return Number.isFinite(t) && t > (now || Date.now());
}

// Bound a requested grace (ms) to [1 ms, MAX_GRACE_MS]; null when unusable.
function clampGraceMs(ms) {
    if (!Number.isFinite(ms) || ms <= 0) return null;
    return Math.min(ms, MAX_GRACE_MS);
}

// Rewrite ONE realm config in place: raw key → key_hash (one-way), expired
// previous_* dropped. Returns true when something changed.
function normalizeRealmConfig(rc, now) {
    if (!rc || typeof rc !== 'object') return false;
    now = now || Date.now();
    var changed = false;
    var raw = rc.key || rc.preshared_key || rc.presharedKey;
    if (typeof raw === 'string' && raw) {
        rc.key_hash = isRealmKeyHash(raw) ? raw : hashRealmKey(raw);
        delete rc.key; delete rc.preshared_key; delete rc.presharedKey;
        changed = true;
    }
    if (rc.previous_key_hash !== undefined && !(rc.previous_key_hash && stillValid(rc.previous_key_until, now))) {
        delete rc.previous_key_hash; delete rc.previous_key_until;
        changed = true;
    }
    if (rc.previous_manager_key !== undefined && !(rc.previous_manager_key && stillValid(rc.previous_manager_until, now))) {
        delete rc.previous_manager_key; delete rc.previous_manager_until;
        changed = true;
    }
    return changed;
}

// Normalise every realm in a {name → config} map. Returns true when any changed.
function normalizeRealms(realms, now) {
    var changed = false;
    Object.keys(realms || {}).forEach(function (name) {
        if (normalizeRealmConfig(realms[name], now)) changed = true;
    });
    return changed;
}

module.exports = {
    hashRealmKey: hashRealmKey,
    isRealmKeyHash: isRealmKeyHash,
    realmKeyMatches: realmKeyMatches,
    stillValid: stillValid,
    clampGraceMs: clampGraceMs,
    normalizeRealmConfig: normalizeRealmConfig,
    normalizeRealms: normalizeRealms,
    HASH_PREFIX: HASH_PREFIX,
    MAX_GRACE_MS: MAX_GRACE_MS,
};
