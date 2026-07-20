/**
 * @file limits.js
 *
 * Rate limits and quotas — opt-in abuse protection for operator-facing
 * deployments (public playgrounds, multi-tenant servers).
 *
 * Entirely inert unless a `limits` settings block exists. Configuration is
 * read through a live getter (hot-reloadable, cached ~1s), with per-realm
 * overrides under `limits.realms`:
 *
 *   "limits": {
 *     "enabled": true,
 *     "trust_proxy": true,                    // honour X-Forwarded-For
 *     "messages_per_second": 20,              // per socket (token bucket)
 *     "message_burst": 60,
 *     "bytes_per_second": 262144,             // per socket
 *     "max_connections_per_ip": 20,
 *     "connections_per_minute_per_ip": 60,
 *     "max_registrations_per_socket": 50,     // producers + consumers
 *     "max_registrations_per_realm": 500,
 *     "max_subscriptions_per_socket": 50,
 *     "max_subscriptions_per_realm": 500,
 *     "max_queued_per_realm": 1000,           // durable queue depth
 *     "realms_per_hour_per_ip": 10,           // POST /api/realms
 *     "max_pending_authorization_requests": 1000,
 *     "realms": { "org:acme": { "messages_per_second": 200 } }
 *   }
 *
 * Numeric limits that are absent, 0, or negative mean "unlimited" — an
 * operator enables exactly what they need.
 */

'use strict';

var CONFIG_CACHE_MS = 1000;
var BUCKET_IDLE_MS = 10 * 60 * 1000;
var PRUNE_INTERVAL_MS = 60 * 1000;

function Limits(getConfig) {
    this._getConfig = typeof getConfig === 'function' ? getConfig : function () { return null; };
    this._configCache = null;
    this._configCacheAt = 0;

    // key -> {tokens, updatedAt} token buckets, shared across limit kinds
    // (keys are namespaced: 'msg:<socketId>', 'bytes:<socketId>',
    // 'connrate:<ip>', 'realmrate:<ip>').
    this._buckets = new Map();
    this._lastPruneAt = Date.now();

    // ip -> current connection count
    this._connections = new Map();
}

Limits.prototype._config = function () {
    var now = Date.now();
    if (this._configCache !== null && now - this._configCacheAt < CONFIG_CACHE_MS)
        return this._configCache;
    var raw = this._getConfig();
    if (!raw || raw.enabled === false)
        this._configCache = false;
    else
        this._configCache = raw;
    this._configCacheAt = now;
    return this._configCache;
};

Limits.prototype.enabled = function () {
    return !!this._config();
};

Limits.prototype.trustProxy = function () {
    var config = this._config();
    return !!(config && (config.trust_proxy || config.trustProxy));
};

/**
 * Effective numeric limit for a realm: per-realm override first, then the
 * global value. Absent/0/negative -> Infinity (unlimited).
 */
Limits.prototype.value = function (realm, name) {
    var config = this._config();
    if (!config)
        return Infinity;
    var raw;
    var overrides = config.realms || {};
    if (realm && overrides[realm] && overrides[realm][name] !== undefined)
        raw = overrides[realm][name];
    else
        raw = config[name];
    raw = Number(raw);
    return Number.isFinite(raw) && raw > 0 ? raw : Infinity;
};

// ── token buckets ─────────────────────────────────────────────────────────

Limits.prototype._prune = function (now) {
    if (now - this._lastPruneAt < PRUNE_INTERVAL_MS)
        return;
    this._lastPruneAt = now;
    var buckets = this._buckets;
    buckets.forEach(function (bucket, key) {
        if (now - bucket.updatedAt > BUCKET_IDLE_MS)
            buckets.delete(key);
    });
};

/**
 * Take `cost` from the bucket refilling at `ratePerSec` up to `burst`.
 * Returns {ok: true} or {ok: false, retry_after: seconds}.
 */
Limits.prototype._take = function (key, ratePerSec, burst, cost) {
    if (!Number.isFinite(ratePerSec))
        return {ok: true};

    var now = Date.now();
    this._prune(now);

    var bucket = this._buckets.get(key);
    if (!bucket) {
        bucket = {tokens: burst, updatedAt: now};
        this._buckets.set(key, bucket);
    }
    else {
        bucket.tokens = Math.min(burst, bucket.tokens + ((now - bucket.updatedAt) / 1000) * ratePerSec);
        bucket.updatedAt = now;
    }

    if (bucket.tokens >= cost) {
        bucket.tokens -= cost;
        return {ok: true};
    }
    return {ok: false, retry_after: Math.max(1, Math.ceil((cost - bucket.tokens) / ratePerSec))};
};

// ── connections ───────────────────────────────────────────────────────────

/**
 * Admission check for a new socket. Registers the connection only when
 * admitted — rejected sockets have nothing to release.
 */
Limits.prototype.connectionAllowed = function (ip) {
    if (!this.enabled())
        return {ok: true};
    ip = String(ip || 'unknown');

    var maxConcurrent = this.value(null, 'max_connections_per_ip');
    var current = this._connections.get(ip) || 0;
    if (current >= maxConcurrent)
        return {ok: false, reason: 'max_connections_per_ip', retry_after: 30};

    var perMinute = this.value(null, 'connections_per_minute_per_ip');
    if (Number.isFinite(perMinute)) {
        var verdict = this._take('connrate:' + ip, perMinute / 60, perMinute, 1);
        if (!verdict.ok)
            return {ok: false, reason: 'connections_per_minute_per_ip', retry_after: verdict.retry_after};
    }

    this._connections.set(ip, current + 1);
    return {ok: true};
};

Limits.prototype.releaseConnection = function (ip) {
    ip = String(ip || 'unknown');
    var current = this._connections.get(ip) || 0;
    if (current <= 1)
        this._connections.delete(ip);
    else
        this._connections.set(ip, current - 1);
};

// ── messages ──────────────────────────────────────────────────────────────

/**
 * Per-socket produce check: message rate and byte rate, with per-realm
 * overrides. `bytes` is the approximate payload size.
 */
Limits.prototype.produceAllowed = function (socketId, realm, bytes) {
    if (!this.enabled())
        return {ok: true};

    var msgRate = this.value(realm, 'messages_per_second');
    if (Number.isFinite(msgRate)) {
        var burst = this.value(realm, 'message_burst');
        if (!Number.isFinite(burst))
            burst = msgRate * 3;
        var verdict = this._take('msg:' + socketId, msgRate, burst, 1);
        if (!verdict.ok)
            return {ok: false, reason: 'messages_per_second', retry_after: verdict.retry_after};
    }

    var byteRate = this.value(realm, 'bytes_per_second');
    if (Number.isFinite(byteRate)) {
        var byteBurst = this.value(realm, 'bytes_burst');
        if (!Number.isFinite(byteBurst))
            byteBurst = byteRate * 2;
        var byteVerdict = this._take('bytes:' + socketId, byteRate, byteBurst, Math.max(1, bytes || 0));
        if (!byteVerdict.ok)
            return {ok: false, reason: 'bytes_per_second', retry_after: byteVerdict.retry_after};
    }

    return {ok: true};
};

// ── realm provisioning ────────────────────────────────────────────────────

Limits.prototype.realmCreationAllowed = function (ip) {
    if (!this.enabled())
        return {ok: true};
    var perHour = this.value(null, 'realms_per_hour_per_ip');
    if (!Number.isFinite(perHour))
        return {ok: true};
    var verdict = this._take('realmrate:' + String(ip || 'unknown'), perHour / 3600, perHour, 1);
    if (!verdict.ok)
        return {ok: false, reason: 'realms_per_hour_per_ip', retry_after: verdict.retry_after};
    return {ok: true};
};

// ── cleanup ───────────────────────────────────────────────────────────────

Limits.prototype.forgetSocket = function (socketId) {
    this._buckets.delete('msg:' + socketId);
    this._buckets.delete('bytes:' + socketId);
};

module.exports = Limits;
