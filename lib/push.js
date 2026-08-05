'use strict';

// Push-wake (P1): a transport-agnostic mechanism to WAKE an offline mobile
// client so it reconnects and drains its (sealed) durable queue over its own
// authenticated socket. For sealed traffic the wake is CONTENTLESS — no
// sender, no content, no message id — so a push provider (FCM/APNs) learns
// only "device X was nudged at time T", never who-talks-to-whom.
//
// This module mirrors lib/sealed-sender.js: config is read from the
// environment, and the whole feature stays OFF / no-op when unconfigured
// (loadConfig returns null, isConfigured is false, and no wake ever fires).
//
// P1 only wires the NullTransport (records send() calls for assertions). The
// factory + KNOWN_TRANSPORTS leave clear seams for fcm / apns / unifiedpush,
// which are added in later phases.
//
// CONSTANTS DECISION: the sealed limits live in tyo-mq-protocol/constants.js
// (an Apache package the broker depends on). Adding push constants there would
// need a version bump + re-vendor of node_modules/tyo-mq-protocol. For P1 that
// is heavier than the feature warrants, so the push-wake constants live here,
// broker-local, and are documented below. They can migrate into the protocol
// package alongside fcm/apns wiring (P2+) if the wire contract stabilises.

// ── Constants (deliverable #6) ─────────────────────────────────────────────

// Max distinct push endpoints kept per (realm, identity). Registering past the
// cap evicts the oldest endpoint (FIFO) so token rotation never locks a device
// out. Dedup by (transport, token) means re-registering the same token is free.
var PUSH_MAX_TOKENS_PER_IDENTITY = 10;

// Coalesce window: at most one wake per identity per window regardless of how
// many messages arrive. A wake means "drain now", not "one push per message" —
// this prevents push floods and shrinks the timing-oracle surface.
var PUSH_COALESCE_WINDOW_MS = 30 * 1000;

// Length bound on a token / endpoint string. FCM tokens are ~200 chars, APNs
// device tokens 64 hex, a UnifiedPush/ntfy endpoint is a URL — 4 KiB is ample
// headroom while keeping a registration un-abusable as a memory sink.
var PUSH_MAX_TOKEN_LENGTH = 4096;

// Length bound on an optional client-supplied app_id label.
var PUSH_MAX_APP_ID_LENGTH = 128;

// Per-connection PUSH_REGISTER budget (fixed 1-minute window), defence-in-depth
// on top of the per-identity cap.
var PUSH_REGISTERS_PER_MIN = 30;

// Sealed durable-inbox TTL (SECONDS). The durable store's generic default TTL
// is 24h; sealed messages for an offline identity need to survive long enough
// for a push-woken device to reconnect and drain — decoupled from both the 24h
// default AND the 5-min consumer idle-eviction grace. Default: 7 days.
// Overridable via TYO_MQ_SEALED_INBOX_TTL_SECONDS.
var SEALED_INBOX_TTL_SECONDS = 7 * 24 * 60 * 60;

// Socket event names for the registration surface.
var PUSH_REGISTER_EVENT = 'PUSH_REGISTER';
var PUSH_UNREGISTER_EVENT = 'PUSH_UNREGISTER';

// Transport names that are RESERVED in the wire contract. Only 'null' is WIRED
// in P1; fcm/apns/unifiedpush are seams — createTransport throws for them until
// their phase lands, and KNOWN_TRANSPORTS gates what a client may register.
var TRANSPORT_NULL = 'null';
var TRANSPORT_FCM = 'fcm';
var TRANSPORT_APNS = 'apns';
var TRANSPORT_UNIFIEDPUSH = 'unifiedpush';

// Transports a client may register in P1. Extend as transports are wired.
var KNOWN_TRANSPORTS = [TRANSPORT_NULL];

// Keys that MUST NEVER appear in a sealed wake payload — asserting on this set
// is how buildWakePayload guarantees the nudge stays contentless.
var FORBIDDEN_WAKE_KEYS = [
    'sender', 'from', 'content', 'blob', 'msg_id', 'msgId', 'message',
    'payload', 'to', 'identity', 'realm', 'uak',
];

var WAKE_TYPE = 'wake';

// ── Contentless wake payload (deliverable #1) ──────────────────────────────

// Build the bare "you have messages, drain now" nudge. It carries NO sender,
// content, or message id — only an opaque type/version marker. assertContentless
// then verifies nothing forbidden leaked in (defence against a future edit that
// naively threads metadata through here).
function buildWakePayload() {
    return assertContentless({ type: WAKE_TYPE, v: 1 });
}

// Throw if a payload carries any metadata that would defeat the contentless
// guarantee. Returns the payload on success so it composes.
function assertContentless(payload) {
    var obj = payload || {};
    Object.keys(obj).forEach(function (k) {
        if (FORBIDDEN_WAKE_KEYS.indexOf(k) >= 0)
            throw new Error('wake payload leaks forbidden key: ' + k);
    });
    return obj;
}

// ── PushTransport implementations (deliverable #1) ─────────────────────────

// NullTransport: dev/test transport. Records every send() for assertions and
// returns {ok:true}; a token passed to markGone() returns {ok:false, gone:true}
// so the registry-pruning path can be exercised.
function NullTransport() {
    this.name = TRANSPORT_NULL;
    this.sent = [];              // recorded { transport, token, app_id, payload }
    this._gone = new Set();
}

NullTransport.prototype.markGone = function (token) {
    this._gone.add(token);
    return this;
};

NullTransport.prototype.send = function (endpoint) {
    endpoint = endpoint || {};
    if (this._gone.has(endpoint.token))
        return Promise.resolve({ ok: false, gone: true });
    this.sent.push({
        transport: endpoint.transport,
        token: endpoint.token,
        app_id: endpoint.app_id,
        payload: endpoint.payload,
    });
    return Promise.resolve({ ok: true });
};

// Factory: select a transport implementation by name. Only 'null' is wired in
// P1; the reserved names throw a clear "not implemented" so a misconfig fails
// loudly rather than silently no-op'ing.
function createTransport(name, env) {
    switch (name) {
        case TRANSPORT_NULL:
            return new NullTransport();
        case TRANSPORT_FCM:
        case TRANSPORT_APNS:
        case TRANSPORT_UNIFIEDPUSH:
            throw new Error("push transport '" + name + "' is not implemented yet (P1 wires only 'null')");
        default:
            throw new Error('unknown push transport: ' + name);
    }
}

// ── Config (deliverable #1), mirrors sealed-sender.loadConfig ──────────────

// Returns null (feature OFF) when TYO_MQ_PUSH_TRANSPORT is absent, else a
// { transport, transportName } config. THROWS synchronously when the env names
// an unknown/unwired transport — a boot-time caller should wrap this and emit
// an actionable error, exactly like SealedSender.loadConfig.
function loadConfig(env) {
    env = env || process.env;
    var name = env.TYO_MQ_PUSH_TRANSPORT;
    if (!name) return null;
    return { transport: createTransport(name, env), transportName: name };
}

function isConfigured(cfg) {
    return !!(cfg && cfg.transport);
}

// Resolve the transport instance able to service an endpoint's transport name.
// In P1 only the single configured transport is live, so a registered endpoint
// whose transport name differs is simply not woken.
function transportFor(cfg, name) {
    if (!isConfigured(cfg)) return null;
    return cfg.transportName === name ? cfg.transport : null;
}

// Read the sealed durable-inbox TTL (seconds) from env, falling back to the
// SEALED_INBOX_TTL_SECONDS default. Invalid / non-positive values fall back.
function sealedInboxTtlSeconds(env) {
    env = env || process.env;
    var raw = env.TYO_MQ_SEALED_INBOX_TTL_SECONDS;
    var n = Number(raw);
    if (raw !== undefined && raw !== '' && Number.isFinite(n) && n > 0)
        return n;
    return SEALED_INBOX_TTL_SECONDS;
}

// ── Token registry (deliverable #2) ────────────────────────────────────────
// Per (realm, identity) → list of { transport, token, app_id, added_at,
// last_ok }. Node-local (like the sealed UAK registry) — a cluster mirror is a
// tracked follow-up. Uses Map (not a plain object) so attacker-influenced
// realm/identity strings cannot reach Object.prototype.
function TokenRegistry(opts) {
    opts = opts || {};
    this.maxPerIdentity = opts.maxPerIdentity || PUSH_MAX_TOKENS_PER_IDENTITY;
    this.coalesceWindowMs = opts.coalesceWindowMs || PUSH_COALESCE_WINDOW_MS;
    this._byRealm = new Map();   // realm -> Map(identity -> [endpoint])
    this._lastWake = new Map();  // realm -> Map(identity -> ts)
}

TokenRegistry.prototype._identityMap = function (realm, create) {
    var m = this._byRealm.get(realm);
    if (!m && create) {
        m = new Map();
        this._byRealm.set(realm, m);
    }
    return m || null;
};

// Register/rotate an endpoint. Dedup by (transport, token) — a repeat refreshes
// added_at in place. Past the cap the oldest endpoint is evicted (FIFO) so
// rotation never locks a device out. Returns the stored endpoint.
TokenRegistry.prototype.register = function (realm, identity, ep) {
    ep = ep || {};
    var now = ep.now || Date.now();
    var m = this._identityMap(realm, true);
    var list = m.get(identity);
    if (!list) {
        list = [];
        m.set(identity, list);
    }
    var existing = null;
    for (var i = 0; i < list.length; i++) {
        if (list[i].transport === ep.transport && list[i].token === ep.token) {
            existing = list[i];
            break;
        }
    }
    if (existing) {
        existing.added_at = now;
        if (ep.app_id !== undefined) existing.app_id = ep.app_id;
        return existing;
    }
    var endpoint = {
        transport: ep.transport,
        token: ep.token,
        app_id: ep.app_id !== undefined ? ep.app_id : null,
        added_at: now,
        last_ok: null,
    };
    list.push(endpoint);
    while (list.length > this.maxPerIdentity)
        list.shift();   // evict oldest
    return endpoint;
};

// Remove endpoints matching (transport, token). Returns the count removed.
TokenRegistry.prototype.unregister = function (realm, identity, ep) {
    ep = ep || {};
    var m = this._identityMap(realm, false);
    if (!m) return 0;
    var list = m.get(identity);
    if (!list) return 0;
    var before = list.length;
    var kept = list.filter(function (e) {
        return !(e.transport === ep.transport && e.token === ep.token);
    });
    if (kept.length === 0) m.delete(identity);
    else m.set(identity, kept);
    return before - kept.length;
};

// Prune a single endpoint (used when a transport reports gone:true).
TokenRegistry.prototype.prune = function (realm, identity, ep) {
    return this.unregister(realm, identity, ep);
};

// Mark an endpoint as last successfully woken.
TokenRegistry.prototype.markOk = function (realm, identity, ep, now) {
    var m = this._identityMap(realm, false);
    if (!m) return;
    var list = m.get(identity);
    if (!list) return;
    for (var i = 0; i < list.length; i++) {
        if (list[i].transport === ep.transport && list[i].token === ep.token) {
            list[i].last_ok = now || Date.now();
            return;
        }
    }
};

// Return a shallow copy of the endpoints for (realm, identity).
TokenRegistry.prototype.list = function (realm, identity) {
    var m = this._identityMap(realm, false);
    if (!m) return [];
    var list = m.get(identity);
    return list ? list.slice() : [];
};

TokenRegistry.prototype.count = function (realm, identity) {
    return this.list(realm, identity).length;
};

// Coalesce gate: return true (and record the timestamp) when a wake is allowed
// for (realm, identity) now, false when one already fired inside the window.
TokenRegistry.prototype.coalesceOk = function (realm, identity, now, windowMs) {
    now = now || Date.now();
    windowMs = windowMs || this.coalesceWindowMs;
    var m = this._lastWake.get(realm);
    if (!m) {
        m = new Map();
        this._lastWake.set(realm, m);
    }
    var last = m.get(identity);
    if (last !== undefined && (now - last) < windowMs)
        return false;
    m.set(identity, now);
    return true;
};

// ── Wake orchestration (deliverable #4) ────────────────────────────────────
// Best-effort, async, contentless. NEVER throws (callers fire-and-forget).
// Coalesces per identity, sends a contentless nudge through each endpoint's
// transport, prunes gone endpoints, records last_ok. Resolves with a small
// summary for tests/introspection.
function fireWake(cfg, registry, realm, identity, opts) {
    opts = opts || {};
    var now = opts.now || Date.now();
    var windowMs = opts.coalesceWindowMs || (registry && registry.coalesceWindowMs) || PUSH_COALESCE_WINDOW_MS;
    try {
        if (!isConfigured(cfg))
            return Promise.resolve({ sent: 0, skipped: 'unconfigured' });
        if (!registry)
            return Promise.resolve({ sent: 0, skipped: 'no-registry' });
        var endpoints = registry.list(realm, identity);
        if (!endpoints.length)
            return Promise.resolve({ sent: 0, skipped: 'no-endpoints' });
        // Only consume the coalesce window once we know there is something to
        // wake — a no-endpoint identity must not burn its window.
        if (!registry.coalesceOk(realm, identity, now, windowMs))
            return Promise.resolve({ sent: 0, skipped: 'coalesced' });

        var payload = buildWakePayload();   // contentless; asserts internally
        var attempts = endpoints.map(function (ep) {
            var transport = transportFor(cfg, ep.transport);
            if (!transport) return Promise.resolve();
            return Promise.resolve(transport.send({
                transport: ep.transport,
                token: ep.token,
                app_id: ep.app_id,
                payload: payload,
            })).then(function (res) {
                if (res && res.gone) registry.prune(realm, identity, ep);
                else if (res && res.ok) registry.markOk(realm, identity, ep, now);
            }).catch(function () { /* best-effort: a wake must never throw */ });
        });
        return Promise.all(attempts).then(function () {
            return { sent: endpoints.length };
        });
    } catch (e) {
        return Promise.resolve({ sent: 0, skipped: 'error' });
    }
}

module.exports = {
    // config / transports
    loadConfig: loadConfig,
    isConfigured: isConfigured,
    createTransport: createTransport,
    transportFor: transportFor,
    NullTransport: NullTransport,
    // payload
    buildWakePayload: buildWakePayload,
    assertContentless: assertContentless,
    // registry + wake
    TokenRegistry: TokenRegistry,
    fireWake: fireWake,
    sealedInboxTtlSeconds: sealedInboxTtlSeconds,
    // constants
    PUSH_MAX_TOKENS_PER_IDENTITY: PUSH_MAX_TOKENS_PER_IDENTITY,
    PUSH_COALESCE_WINDOW_MS: PUSH_COALESCE_WINDOW_MS,
    PUSH_MAX_TOKEN_LENGTH: PUSH_MAX_TOKEN_LENGTH,
    PUSH_MAX_APP_ID_LENGTH: PUSH_MAX_APP_ID_LENGTH,
    PUSH_REGISTERS_PER_MIN: PUSH_REGISTERS_PER_MIN,
    SEALED_INBOX_TTL_SECONDS: SEALED_INBOX_TTL_SECONDS,
    PUSH_REGISTER_EVENT: PUSH_REGISTER_EVENT,
    PUSH_UNREGISTER_EVENT: PUSH_UNREGISTER_EVENT,
    KNOWN_TRANSPORTS: KNOWN_TRANSPORTS,
    FORBIDDEN_WAKE_KEYS: FORBIDDEN_WAKE_KEYS,
};
