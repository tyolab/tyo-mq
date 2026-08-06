'use strict';

var http = require('http');
var https = require('https');
var dns = require('dns');
var net = require('net');

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

// Transports a client may register. 'null' (dev/test) and 'unifiedpush' (P4a,
// self-hosted credential-free HTTP wake) are wired; fcm/apns remain seams.
var KNOWN_TRANSPORTS = [TRANSPORT_NULL, TRANSPORT_UNIFIEDPUSH];

// ── UnifiedPush / HTTP transport constants (P4a) ───────────────────────────
// Hard timeout on the wake POST. A wake is best-effort — never let a slow or
// black-holing endpoint tie up a request slot.
var PUSH_HTTP_TIMEOUT_MS = 5000;
// Cap on the response body we read. A wake ignores the body; we only need the
// status line. Bound the read so a hostile endpoint can't stream us to death.
var PUSH_RESP_MAX_BYTES = 8 * 1024;
// Rate-limit window for the token-free wake-failure warn/metric (carry-forward
// #1): at most one warn per (transport, coarse-reason) per window, so a
// persistently-broken endpoint cannot flood the logs.
var PUSH_FAIL_LOG_WINDOW_MS = 60 * 1000;

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

// ── SSRF guard (P4a, deliverable #2) ───────────────────────────────────────
// The security core of the self-hosted push transport: the broker is about to
// POST to a CLIENT-SUPPLIED URL, so an unguarded endpoint is a server-side
// request forgery primitive (hit cloud metadata at 169.254.169.254, internal
// admin panels on 10/172.16/192.168, loopback services, etc.). isSafePushUrl
// is enforced BOTH at registration time (PUSH_REGISTER) and again at send time,
// and the transport additionally pins the connect-time DNS resolution through
// the SAME address classifier (guardedLookup) so a DNS-rebind between the check
// and the connect still cannot reach a blocked address.
//
// IP-range checks are implemented explicitly (no hand-rolled URL/host regex)
// against parsed address bytes, covering IPv4, IPv6, IPv4-mapped IPv6, and the
// shortened/expanded IPv6 forms.

// Parse a dotted-quad into [a,b,c,d] octets, or null. Rejects octal/hex/short
// forms — only canonical decimal quads are accepted.
function parseIPv4(str) {
    var parts = String(str).split('.');
    if (parts.length !== 4) return null;
    var out = [];
    for (var i = 0; i < 4; i++) {
        if (!/^\d{1,3}$/.test(parts[i])) return null;
        var n = parseInt(parts[i], 10);
        if (n > 255) return null;
        out.push(n);
    }
    return out;
}

// Parse an IPv6 literal (incl. :: compression and a trailing embedded IPv4)
// into 16 bytes, or null. Zone ids (%eth0) are stripped.
function parseIPv6(str) {
    var s = String(str);
    var zi = s.indexOf('%');
    if (zi >= 0) s = s.slice(0, zi);
    if (s.indexOf('.') >= 0) {
        // embedded IPv4 in the final segment -> fold into two hextets
        var li = s.lastIndexOf(':');
        if (li < 0) return null;
        var v4 = parseIPv4(s.slice(li + 1));
        if (!v4) return null;
        var hi = ((v4[0] << 8) | v4[1]).toString(16);
        var lo = ((v4[2] << 8) | v4[3]).toString(16);
        s = s.slice(0, li + 1) + hi + ':' + lo;
    }
    var halves = s.split('::');
    if (halves.length > 2) return null;
    function toWords(part) {
        if (part === '') return [];
        var segs = part.split(':');
        var w = [];
        for (var i = 0; i < segs.length; i++) {
            if (!/^[0-9a-fA-F]{1,4}$/.test(segs[i])) return null;
            w.push(parseInt(segs[i], 16));
        }
        return w;
    }
    var head = toWords(halves[0]);
    if (head === null) return null;
    var words;
    if (halves.length === 2) {
        var tail = toWords(halves[1]);
        if (tail === null) return null;
        var missing = 8 - head.length - tail.length;
        if (missing < 0) return null;
        words = head.concat(new Array(missing).fill(0)).concat(tail);
    } else {
        words = head;
    }
    if (words.length !== 8) return null;
    var bytes = new Uint8Array(16);
    for (var j = 0; j < 8; j++) {
        bytes[j * 2] = (words[j] >> 8) & 0xff;
        bytes[j * 2 + 1] = words[j] & 0xff;
    }
    return bytes;
}

// Classify an IPv4 octet array: 'loopback' | 'blocked' | 'ok'. Loopback is
// separated out so the dev flag can opt INTO it while everything else in the
// private/link-local/metadata space stays hard-blocked.
function classifyV4(v4) {
    var a = v4[0], b = v4[1];
    if (a === 127) return 'loopback';               // 127.0.0.0/8
    if (a === 0) return 'blocked';                   // 0.0.0.0/8 (incl 0.0.0.0)
    if (a === 10) return 'blocked';                  // 10.0.0.0/8
    if (a === 169 && b === 254) return 'blocked';    // 169.254.0.0/16 (incl 169.254.169.254 metadata)
    if (a === 172 && b >= 16 && b <= 31) return 'blocked'; // 172.16.0.0/12
    if (a === 192 && b === 168) return 'blocked';    // 192.168.0.0/16
    return 'ok';
}

// Classify a resolved address string (+optional family) into
// 'loopback' | 'blocked' | 'ok'. Anything we cannot parse is 'blocked'
// (fail closed).
function classifyAddress(address, family) {
    var addr = String(address);
    if (family === 4 || net.isIPv4(addr)) {
        var v4 = parseIPv4(addr);
        return v4 ? classifyV4(v4) : 'blocked';
    }
    var bytes = parseIPv6(addr);
    if (!bytes) return 'blocked';
    // ::ffff:a.b.c.d — IPv4-mapped: classify the embedded v4.
    var mapped = true;
    for (var i = 0; i < 10; i++) if (bytes[i] !== 0) { mapped = false; break; }
    if (mapped && bytes[10] === 0xff && bytes[11] === 0xff)
        return classifyV4([bytes[12], bytes[13], bytes[14], bytes[15]]);
    // IPv6->IPv4 TRANSLATION / EMBEDDING prefixes: an address that carries a
    // v4 payload must be classified by that EMBEDDED v4, or a literal like
    // 64:ff9b::a9fe:a9fe (NAT64) would smuggle 169.254.169.254 past the guard
    // on a DNS64/NAT64 host. Decode each known form and classify the embedded v4.
    // NAT64 well-known prefix 64:ff9b::/96 (RFC 6052): 00 64 ff 9b :: v4.
    if (bytes[0] === 0x00 && bytes[1] === 0x64 && bytes[2] === 0xff && bytes[3] === 0x9b) {
        var nat64Zero = true;
        for (var n = 4; n < 12; n++) if (bytes[n] !== 0) { nat64Zero = false; break; }
        if (nat64Zero) return classifyV4([bytes[12], bytes[13], bytes[14], bytes[15]]);
    }
    // 6to4 2002::/16 (RFC 3056): 20 02 then the v4 in bytes[2..5]. NOTE: 6to4
    // sits inside 2000::/3, so a "global-unicast only" check does NOT catch it —
    // it must be decoded explicitly.
    if (bytes[0] === 0x20 && bytes[1] === 0x02)
        return classifyV4([bytes[2], bytes[3], bytes[4], bytes[5]]);
    // IPv4-compatible ::a.b.c.d (deprecated): first 12 bytes zero, last 4 the v4
    // (and not ::1 / ::). Classify the embedded v4.
    var compatZero = true;
    for (var c = 0; c < 12; c++) if (bytes[c] !== 0) { compatZero = false; break; }
    if (compatZero) {
        var lastNonZero = (bytes[12] | bytes[13] | bytes[14] | bytes[15]) !== 0;
        // ::1 is loopback, handled below; anything else zero-prefixed with a v4
        // tail is IPv4-compatible -> classify the embedded v4.
        if (lastNonZero && !(bytes[12] === 0 && bytes[13] === 0 && bytes[14] === 0 && bytes[15] === 1))
            return classifyV4([bytes[12], bytes[13], bytes[14], bytes[15]]);
    }
    // ::1 loopback
    var loopback = true;
    for (var k = 0; k < 15; k++) if (bytes[k] !== 0) { loopback = false; break; }
    if (loopback && bytes[15] === 1) return 'loopback';
    // :: unspecified
    var allZero = true;
    for (var z = 0; z < 16; z++) if (bytes[z] !== 0) { allZero = false; break; }
    if (allZero) return 'blocked';
    if ((bytes[0] & 0xfe) === 0xfc) return 'blocked';                 // fc00::/7 ULA
    if (bytes[0] === 0xfe && (bytes[1] & 0xc0) === 0x80) return 'blocked'; // fe80::/10 link-local
    // FAIL CLOSED: only genuine global-unicast 2000::/3 is allowed. Any other
    // range (incl. novel translation/embedding forms, 0000::/8, fec0::/10, ff00
    // multicast, etc.) is not explicitly vetted -> blocked, so a form we do not
    // yet decode fails closed rather than open.
    if ((bytes[0] & 0xe0) === 0x20) return 'ok';                      // 2000::/3 global-unicast
    return 'blocked';
}

function stripBrackets(host) {
    if (host && host.length > 1 && host.charAt(0) === '[' && host.charAt(host.length - 1) === ']')
        return host.slice(1, host.length - 1);
    return host;
}

function defaultDnsLookup(host) {
    return new Promise(function (resolve, reject) {
        dns.lookup(host, { all: true, verbatim: true }, function (err, addresses) {
            if (err) return reject(err);
            resolve(addresses || []);
        });
    });
}

// Validate a client-supplied push endpoint URL. Returns a Promise resolving to
// { ok:true, hostname } or { ok:false, reason }. NEVER throws for a bad URL —
// a DNS failure or parse error resolves to { ok:false } so callers just refuse.
//
// opts.allowLocal (dev flag): permit http:// AND loopback addresses, but ONLY
// for loopback hosts — used for local/dev/self-test endpoints. Default false.
// opts.dnsLookup: injectable resolver (for tests) returning a Promise of
// [{ address, family }].
async function isSafePushUrl(rawUrl, opts) {
    opts = opts || {};
    var allowLocal = !!opts.allowLocal;
    var lookup = opts.dnsLookup || defaultDnsLookup;
    try {
        if (typeof rawUrl !== 'string' || rawUrl.length === 0)
            return { ok: false, reason: 'empty' };
        if (rawUrl.length > PUSH_MAX_TOKEN_LENGTH)
            return { ok: false, reason: 'too-long' };
        var u;
        try { u = new URL(rawUrl); } catch (e) { return { ok: false, reason: 'invalid-url' }; }
        // Credentials in the URL are a smell (and can be logged upstream) — reject.
        if (u.username || u.password) return { ok: false, reason: 'credentials-in-url' };
        var isHttps = u.protocol === 'https:';
        var isHttp = u.protocol === 'http:';
        if (!isHttps && !isHttp) return { ok: false, reason: 'bad-scheme' };
        if (isHttp && !allowLocal) return { ok: false, reason: 'http-forbidden' };
        var host = stripBrackets(u.hostname);
        if (!host) return { ok: false, reason: 'no-host' };
        // NOTE on ports: we do NOT restrict the port. The SSRF defence is the
        // address-range classification below (a non-standard port on a public
        // host is not itself a private-network reach); internal services are
        // blocked by IP range regardless of port.
        var addrs;
        if (net.isIP(host)) {
            addrs = [{ address: host, family: net.isIP(host) }];
        } else {
            try {
                addrs = await lookup(host);
            } catch (e) {
                return { ok: false, reason: 'dns-failed' };
            }
            if (!addrs || !addrs.length) return { ok: false, reason: 'dns-empty' };
        }
        var sawPublic = false, sawLoopback = false;
        for (var i = 0; i < addrs.length; i++) {
            var c = classifyAddress(addrs[i].address, addrs[i].family);
            if (c === 'blocked') return { ok: false, reason: 'blocked-address' };
            if (c === 'loopback') {
                if (!allowLocal) return { ok: false, reason: 'loopback' };
                sawLoopback = true;
            } else {
                sawPublic = true;
            }
        }
        // http:// is only ever permitted to a loopback target under allowLocal.
        if (isHttp && sawPublic) return { ok: false, reason: 'http-non-local' };
        // RESIDUAL GAP: this validates the addresses resolved NOW; a DNS-rebind
        // between here and the connect could differ. The transport closes that
        // by routing the actual connect through classifyAddress via a guarded
        // dns.lookup (see UnifiedPushTransport._guardedLookup), so the socket
        // only ever connects to a re-validated address.
        return { ok: true, hostname: host };
    } catch (e) {
        return { ok: false, reason: 'error' };
    }
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

// UnifiedPushTransport (P4a): credential-free self-hosted wake. send() HTTPS
// POSTs the CONTENTLESS wake JSON to endpoint.token (a client-supplied
// UnifiedPush/ntfy/webhook URL). No Google/Apple, no API key. Redirect
// following is disabled (Node core http/https never follows redirects), a hard
// timeout bounds the request, the response body is capped/ignored, and the URL
// is re-validated at send time — with the actual connect pinned to a
// re-classified address via a guarded DNS lookup (DNS-rebind defence).
//
// Result contract (matches fireWake's expectations):
//   2xx           -> { ok:true }
//   404 / 410     -> { ok:false, gone:true }   (endpoint dead -> prune)
//   other/timeout -> { ok:false }              (transient -> retain)
//   unsafe URL    -> { ok:false, unsafe:true } (never connected; retain)
function UnifiedPushTransport(opts) {
    opts = opts || {};
    this.name = TRANSPORT_UNIFIEDPUSH;
    this.allowLocal = !!opts.allowLocal;
    this.timeoutMs = opts.timeoutMs || PUSH_HTTP_TIMEOUT_MS;
    this._dnsLookup = opts.dnsLookup || null;       // injectable (tests)
    // TEST-ONLY escape hatch for a self-signed https test server. Undefined in
    // production => Node's default certificate validation applies.
    this._rejectUnauthorized = opts.rejectUnauthorized;
}

// dns.lookup-shaped guarded resolver passed to http(s).request({lookup}). The
// connection's OWN resolution is routed through classifyAddress, so the socket
// can only ever connect to a re-validated (non-blocked) address — closing the
// check-vs-connect DNS-rebind gap.
UnifiedPushTransport.prototype._guardedLookup = function (hostname, options, callback) {
    var self = this;
    if (typeof options === 'function') { callback = options; options = {}; }
    if (typeof options === 'number') options = { family: options };
    var lookupOpts = Object.assign({}, options, { verbatim: true });
    dns.lookup(hostname, lookupOpts, function (err, address, family) {
        if (err) return callback(err);
        // all:true -> address is an array of {address,family}; else a string.
        if (Array.isArray(address)) {
            for (var i = 0; i < address.length; i++) {
                var c = classifyAddress(address[i].address, address[i].family);
                if (c === 'blocked' || (c === 'loopback' && !self.allowLocal))
                    return callback(new Error('blocked address'));
            }
            return callback(null, address);
        }
        var cls = classifyAddress(address, family);
        if (cls === 'blocked' || (cls === 'loopback' && !self.allowLocal))
            return callback(new Error('blocked address'));
        callback(null, address, family);
    });
};

UnifiedPushTransport.prototype.send = function (endpoint) {
    var self = this;
    endpoint = endpoint || {};
    var url = endpoint.token;
    var payload = endpoint.payload || buildWakePayload();
    // Re-validate at SEND time (defence-in-depth over registration-time check).
    return isSafePushUrl(url, { allowLocal: self.allowLocal, dnsLookup: self._dnsLookup })
        .then(function (check) {
            if (!check.ok) return { ok: false, unsafe: true };
            return self._post(url, payload);
        })
        .catch(function () { return { ok: false }; });
};

UnifiedPushTransport.prototype._post = function (rawUrl, payload) {
    var self = this;
    return new Promise(function (resolve) {
        var u;
        try { u = new URL(rawUrl); } catch (e) { return resolve({ ok: false }); }
        var isHttps = u.protocol === 'https:';
        var lib = isHttps ? https : http;
        var body = Buffer.from(JSON.stringify(payload), 'utf8');
        var options = {
            method: 'POST',
            hostname: stripBrackets(u.hostname),
            port: u.port || (isHttps ? 443 : 80),
            path: (u.pathname || '/') + (u.search || ''),
            headers: {
                'content-type': 'application/json',
                'content-length': body.length,
            },
            timeout: self.timeoutMs,
            // Guarded resolution => the connect can only land on a re-validated
            // address (DNS-rebind defence).
            lookup: function () { return self._guardedLookup.apply(self, arguments); },
        };
        if (isHttps && self._rejectUnauthorized === false)
            options.rejectUnauthorized = false;

        var settled = false;
        function done(v) { if (settled) return; settled = true; resolve(v); }

        var req = lib.request(options, function (res) {
            var status = res.statusCode;
            var received = 0;
            res.on('data', function (chunk) {
                received += chunk.length;
                if (received > PUSH_RESP_MAX_BYTES) res.destroy(); // ignore/cap body
            });
            var finish = function () {
                if (status >= 200 && status < 300) return done({ ok: true });
                if (status === 404 || status === 410) return done({ ok: false, gone: true });
                return done({ ok: false });
            };
            res.on('end', finish);
            res.on('close', finish);
        });
        req.on('timeout', function () { req.destroy(new Error('timeout')); });
        req.on('error', function () { done({ ok: false }); });
        try {
            req.write(body);
            req.end();
        } catch (e) { done({ ok: false }); }
    });
};

// Factory: select a transport implementation by name. 'null' (dev/test) and
// 'unifiedpush' (self-hosted HTTP wake) are wired; fcm/apns remain reserved
// seams that throw a clear "not implemented" so a misconfig fails loudly.
function createTransport(name, env) {
    env = env || {};
    switch (name) {
        case TRANSPORT_NULL:
            return new NullTransport();
        case TRANSPORT_UNIFIEDPUSH:
            return new UnifiedPushTransport({
                allowLocal: isTruthyFlag(env.TYO_MQ_PUSH_ALLOW_LOCAL),
            });
        case TRANSPORT_FCM:
        case TRANSPORT_APNS:
            throw new Error("push transport '" + name + "' is not implemented yet (P4a wires 'null' and 'unifiedpush')");
        default:
            throw new Error('unknown push transport: ' + name);
    }
}

function isTruthyFlag(v) {
    if (v === undefined || v === null) return false;
    var s = String(v).trim().toLowerCase();
    return s === '1' || s === 'true' || s === 'yes' || s === 'on';
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
    var transport = createTransport(name, env);
    return {
        transport: transport,
        transportName: name,
        // Surfaced so the PUSH_REGISTER handler can run the same SSRF policy the
        // transport enforces (only meaningful for unifiedpush).
        allowLocal: !!transport.allowLocal,
    };
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
// Rate-limited, TOKEN-FREE wake-failure warn/metric (carry-forward #1). Logs
// ONLY the transport name + a coarse reason — NEVER the token/URL, which for a
// UnifiedPush endpoint can itself carry a secret. State lives on the registry
// (per-node) so a persistently-broken endpoint warns at most once per window.
function logWakeFailure(registry, logger, transport, reason, now) {
    if (!logger || typeof logger.warn !== 'function' || !registry) return;
    now = now || Date.now();
    if (!registry._failLog) registry._failLog = new Map();
    var key = String(transport) + ':' + String(reason);
    var last = registry._failLog.get(key);
    if (last !== undefined && (now - last) < PUSH_FAIL_LOG_WINDOW_MS) return;
    registry._failLog.set(key, now);
    // token-free: transport + coarse reason ONLY.
    logger.warn('push wake failed: transport=' + transport + ' reason=' + reason);
}

function fireWake(cfg, registry, realm, identity, opts) {
    opts = opts || {};
    var now = opts.now || Date.now();
    var logger = opts.logger || null;
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
                if (res && res.gone) {
                    registry.prune(realm, identity, ep);
                    logWakeFailure(registry, logger, ep.transport, 'gone', now);
                } else if (res && res.ok) {
                    registry.markOk(realm, identity, ep, now);
                } else {
                    // transient (retain) or send-time-unsafe (rebind refusal).
                    logWakeFailure(registry, logger, ep.transport, (res && res.unsafe) ? 'unsafe' : 'transient', now);
                }
            }).catch(function () {
                // best-effort: a wake must never throw
                logWakeFailure(registry, logger, ep.transport, 'error', now);
            });
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
    UnifiedPushTransport: UnifiedPushTransport,
    // SSRF guard (exported so the server + tests can enforce the same policy).
    isSafePushUrl: isSafePushUrl,
    classifyAddress: classifyAddress,
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
    PUSH_HTTP_TIMEOUT_MS: PUSH_HTTP_TIMEOUT_MS,
    PUSH_RESP_MAX_BYTES: PUSH_RESP_MAX_BYTES,
    SEALED_INBOX_TTL_SECONDS: SEALED_INBOX_TTL_SECONDS,
    PUSH_REGISTER_EVENT: PUSH_REGISTER_EVENT,
    PUSH_UNREGISTER_EVENT: PUSH_UNREGISTER_EVENT,
    KNOWN_TRANSPORTS: KNOWN_TRANSPORTS,
    FORBIDDEN_WAKE_KEYS: FORBIDDEN_WAKE_KEYS,
};
