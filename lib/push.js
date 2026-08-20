'use strict';

var http = require('http');
var https = require('https');
var http2 = require('http2');
var dns = require('dns');
var net = require('net');
var fs = require('fs');
var crypto = require('crypto');

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

// Transports a client may register. 'null' (dev/test), 'unifiedpush' (P4a,
// self-hosted credential-free HTTP wake), 'fcm' (P2) and 'apns' (P3) are wired.
var KNOWN_TRANSPORTS = [TRANSPORT_NULL, TRANSPORT_UNIFIEDPUSH, TRANSPORT_FCM, TRANSPORT_APNS];

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

// ── APNs constants (P3) ────────────────────────────────────────────────────
// The two Apple push hosts. Never client-supplied; the per-endpoint env picks
// which one a wake routes to. The SAME .p8 authenticates against both.
var APNS_HOST_PRODUCTION = 'api.push.apple.com';
var APNS_HOST_SANDBOX = 'api.sandbox.push.apple.com';
var APNS_PORT = 443;
var APNS_ENV_PRODUCTION = 'production';
var APNS_ENV_SANDBOX = 'sandbox';
// Provider-JWT refresh cadence. Apple requires REUSING one provider token and
// refreshing it AT MOST once per 20 min; a token is valid for up to 60 min. We
// re-sign on this interval (well inside 60 min, comfortably above 20 min), NOT
// per send — one JWT is reused across all sends until it ages past this.
var APNS_JWT_REFRESH_MS = 40 * 60 * 1000;

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

// FcmTransport (P4b): FCM HTTP v1 wake. Authenticates with a service-account
// key via the OAuth JWT-bearer flow (the legacy "server key" was shut off in
// 2024) and sends a data-only, high-priority, CONTENTLESS message to the
// registered device token. Both endpoints are fixed Google hosts, never
// client-supplied, so the UnifiedPush SSRF guard does not apply here.
//
// MULTI-PROJECT: FCM HTTP v1 is project-scoped — a service account can only push
// to tokens whose app was built with THAT project's google-services.json. So the
// transport holds a MAP of app_id -> project plus an optional DEFAULT project.
// Each project = { sa, project_id, tokenUrl, own OAuth token cache }. send()
// picks the project by endpoint.app_id (falling back to the default), signs the
// JWT-bearer assertion with THAT project's SA, caches the OAuth token PER project,
// and POSTs to that project's /v1/projects/<project_id>/messages:send. With only
// a default project configured the behaviour is byte-identical to single-project.
//
// Result contract (matches fireWake's expectations):
//   2xx           -> { ok:true }
//   404 / 410     -> { ok:false, gone:true }  (UNREGISTERED token -> prune)
//   other/timeout -> { ok:false }             (transient -> retain)
//   no project for app_id (no default)        -> { ok:false } + token-free warn
function FcmTransport(opts) {
    opts = opts || {};
    this.name = TRANSPORT_FCM;
    this.timeoutMs = opts.timeoutMs || PUSH_HTTP_TIMEOUT_MS;
    // TEST-ONLY override; production always talks to the fixed FCM host.
    this._fcmBaseUrl = opts.fcmBaseUrl || 'https://fcm.googleapis.com';
    // Optional logger for the token-free AUTH-failure warn (401/403) and the
    // no-project warn. Injected in tests; wired to server.logger at boot. Never
    // receives token material.
    this.logger = opts.logger || null;
    this._lastAuthWarnMs = 0;       // throttle for the auth warn (see _warnAuth)
    this._lastNoProjectWarnMs = 0;  // throttle for the no-project warn
    // Default project (from opts.serviceAccount) — used for any endpoint whose
    // app_id has no explicit project mapping. May be null in a map-only config.
    this._default = opts.serviceAccount ? makeFcmProject(opts.serviceAccount) : null;
    // Per-app_id projects (from opts.projects: { app_id: serviceAccount }). Each
    // gets its OWN OAuth token cache so a send never crosses project credentials.
    this._projectsByAppId = {};
    if (opts.projects) {
        var self = this;
        Object.keys(opts.projects).forEach(function (appId) {
            self._projectsByAppId[appId] = makeFcmProject(opts.projects[appId]);
        });
    }
    // A transport with neither a default nor any mapped project can never wake
    // anything — that is a misconfiguration; fail loud (keeps the legacy
    // single-project error message for the no-args case).
    if (!this._default && Object.keys(this._projectsByAppId).length === 0)
        throw new Error('FcmTransport requires a service account with client_email and private_key');
}

// Validate a service-account object and wrap it in a per-project descriptor with
// its OWN OAuth token cache. Throws (same messages as the legacy single-project
// constructor) on a missing/invalid SA so a misconfig fails loud at boot.
function makeFcmProject(sa) {
    if (!sa || !sa.client_email || !sa.private_key)
        throw new Error('FcmTransport requires a service account with client_email and private_key');
    if (!sa.project_id)
        throw new Error('FcmTransport requires a service account with project_id');
    return {
        sa: sa,
        project_id: sa.project_id,
        tokenUrl: sa.token_uri || 'https://oauth2.googleapis.com/token',
        token: null,          // { value, expiresAtMs }
        tokenPromise: null,   // in-flight mint (dedupes concurrent sends)
    };
}

// Select the project servicing an endpoint's app_id: an explicit per-app_id
// project if mapped, else the default. Prototype-pollution-safe (app_id is
// client-supplied): a prototype key like '__proto__' never matches the map.
// Returns null only when there is no mapping AND no default.
FcmTransport.prototype._projectFor = function (appId) {
    if (appId && Object.prototype.hasOwnProperty.call(this._projectsByAppId, appId))
        return this._projectsByAppId[appId];
    return this._default;
};

// Refresh margin: treat a token as expired this long before its real expiry so
// a send never rides a token that dies mid-request.
var FCM_TOKEN_REFRESH_MARGIN_MS = 60 * 1000;

FcmTransport.prototype._getAccessToken = function (project) {
    var self = this;
    if (project.token && Date.now() < project.token.expiresAtMs - FCM_TOKEN_REFRESH_MARGIN_MS)
        return Promise.resolve(project.token.value);
    if (project.tokenPromise) return project.tokenPromise;
    project.tokenPromise = self._mintAccessToken(project).then(
        function (tok) { project.tokenPromise = null; project.token = tok; return tok.value; },
        function (err) { project.tokenPromise = null; throw err; },
    );
    return project.tokenPromise;
};

// OAuth 2.0 JWT-bearer: sign an RS256 assertion with THAT project's SA private
// key and exchange it at the project's token endpoint for a short-lived access
// token. Each project mints and caches independently.
FcmTransport.prototype._mintAccessToken = function (project) {
    var nowSec = Math.floor(Date.now() / 1000);
    var header = { alg: 'RS256', typ: 'JWT' };
    var claims = {
        iss: project.sa.client_email,
        scope: 'https://www.googleapis.com/auth/firebase.messaging',
        aud: project.tokenUrl,
        iat: nowSec,
        exp: nowSec + 3600,
    };
    var b64url = function (obj) {
        return Buffer.from(JSON.stringify(obj), 'utf8').toString('base64url');
    };
    var signingInput = b64url(header) + '.' + b64url(claims);
    var signature = crypto
        .createSign('RSA-SHA256')
        .update(signingInput)
        .sign(project.sa.private_key)
        .toString('base64url');
    var body = Buffer.from(
        'grant_type=' + encodeURIComponent('urn:ietf:params:oauth:grant-type:jwt-bearer') +
        '&assertion=' + encodeURIComponent(signingInput + '.' + signature),
        'utf8',
    );
    return simplePost(project.tokenUrl, {
        'content-type': 'application/x-www-form-urlencoded',
    }, body, this.timeoutMs).then(function (res) {
        if (res.status < 200 || res.status >= 300)
            throw new Error('fcm token endpoint returned ' + res.status);
        var parsed = JSON.parse(res.body);
        if (!parsed.access_token) throw new Error('fcm token response missing access_token');
        var lifetimeSec = Number(parsed.expires_in);
        if (!Number.isFinite(lifetimeSec) || lifetimeSec <= 0) lifetimeSec = 3600;
        return { value: parsed.access_token, expiresAtMs: Date.now() + lifetimeSec * 1000 };
    });
};

FcmTransport.prototype.send = function (endpoint) {
    var self = this;
    endpoint = endpoint || {};
    // Pick the FCM project by app_id (per-app_id mapping, else the default).
    var project = self._projectFor(endpoint.app_id);
    if (!project) {
        // No mapped project for this app_id AND no default: we cannot reach this
        // token's Firebase project. Skip (token-free warn) — do NOT prune, do NOT
        // crash. Retain so a later config fix can wake it.
        self._warnNoProject(endpoint.app_id);
        return Promise.resolve({ ok: false });
    }
    var payload = endpoint.payload || buildWakePayload();
    // FCM v1 requires string data values; the payload stays contentless.
    var data = {};
    Object.keys(payload).forEach(function (k) { data[k] = String(payload[k]); });
    return self._getAccessToken(project)
        .then(function (accessToken) {
            var body = Buffer.from(JSON.stringify({
                message: {
                    token: endpoint.token,
                    data: data,
                    android: { priority: 'HIGH' },
                },
            }), 'utf8');
            var url = self._fcmBaseUrl + '/v1/projects/' +
                encodeURIComponent(project.project_id) + '/messages:send';
            return simplePost(url, {
                'content-type': 'application/json',
                'authorization': 'Bearer ' + accessToken,
            }, body, self.timeoutMs);
        })
        .then(function (res) {
            var cls = classifyFcmResponse(res.status, res.body);
            if (cls.auth) {
                // OUR service-account creds/permission are wrong — NOT the device
                // token. Warn (token-free) and retain the token (do not prune).
                self._warnAuth(res.status);
                return { ok: false };
            }
            if (cls.gone) return { ok: false, gone: true };
            return cls.ok ? { ok: true } : { ok: false };
        })
        .catch(function () { return { ok: false }; });
};

// Emit a rate-limited, TOKEN-FREE warn when FCM rejects OUR credentials/permission
// (HTTP 401/403). This is a distinct signal from a per-endpoint transient failure:
// it means the broker's service account is misconfigured, so the device token must
// NOT be pruned. NEVER logs the device token, the access token, or the private key.
FcmTransport.prototype._warnAuth = function (status) {
    var logger = this.logger;
    if (!logger || typeof logger.warn !== 'function') return;
    var now = Date.now();
    if (now - this._lastAuthWarnMs < PUSH_FAIL_LOG_WINDOW_MS) return;
    this._lastAuthWarnMs = now;
    logger.warn('push wake failed: transport=fcm reason=auth status=' + status +
        ' (FCM service-account credentials/permission rejected — device token NOT pruned)');
};

// Emit a rate-limited, TOKEN-FREE warn when an endpoint's app_id has no mapped
// FCM project and there is no default project — the broker cannot reach that
// token's Firebase project, so the send is skipped (token retained, not pruned).
// Logs only the app_id label (a public PUSH_REGISTER field), never the token.
FcmTransport.prototype._warnNoProject = function (appId) {
    var logger = this.logger;
    if (!logger || typeof logger.warn !== 'function') return;
    var now = Date.now();
    if (now - this._lastNoProjectWarnMs < PUSH_FAIL_LOG_WINDOW_MS) return;
    this._lastNoProjectWarnMs = now;
    logger.warn('push wake skipped: transport=fcm reason=no-project app_id=' +
        JSON.stringify(appId === undefined ? null : appId) +
        ' (no FCM project mapped for this app_id and no default project — device token NOT pruned)');
};

// Classify an FCM HTTP v1 send response into a wake result. Critical: the wrong
// call either prunes a valid device token or spams a dead one.
//   2xx                                        -> { ok:true }
//   401 / 403 (auth/permission — OUR creds)     -> { ok:false, auth:true } (retain + warn)
//   404, or error.status/errorCode UNREGISTERED
//     or 400 INVALID_ARGUMENT (bad device token) -> { ok:false, gone:true } (prune)
//   429 / 5xx / INTERNAL / UNAVAILABLE / other   -> { ok:false } (transient — retain)
function classifyFcmResponse(status, body) {
    if (status >= 200 && status < 300) return { ok: true };
    // Auth/permission failures are about the broker's own creds, never the device.
    if (status === 401 || status === 403) return { ok: false, auth: true };
    var e = parseFcmError(body);
    if (status === 404) return { ok: false, gone: true };
    if (e.code === 'UNREGISTERED') return { ok: false, gone: true };
    if (status === 400 && (e.status === 'INVALID_ARGUMENT' ||
        e.code === 'INVALID_ARGUMENT' || e.code === 'UNREGISTERED'))
        return { ok: false, gone: true };
    // INTERNAL / UNAVAILABLE / QUOTA_EXCEEDED / 5xx / 429 / unparsable -> transient.
    return { ok: false };
}

// Parse an FCM v1 error body into { status, code } (both nullable). The v1 error
// shape is { error: { status, message, details:[{ '@type', errorCode }] } }; the
// device-token verdict lives in error.status and/or the FcmError detail errorCode.
function parseFcmError(body) {
    try {
        var p = JSON.parse(body || '{}');
        var err = p && p.error;
        if (!err) return { status: null, code: null };
        var code = null;
        if (Array.isArray(err.details)) {
            for (var i = 0; i < err.details.length; i++) {
                var d = err.details[i];
                if (d && d.errorCode) { code = d.errorCode; break; }
            }
        }
        return { status: err.status || null, code: code };
    } catch (e) { return { status: null, code: null }; }
}

// Minimal POST helper for FIXED (non-client-supplied) endpoints: no redirect
// following, hard timeout, response body capped. Distinct from
// UnifiedPushTransport._post, which additionally pins DNS for attacker-chosen
// URLs — unnecessary here and undesirable to entangle.
function simplePost(rawUrl, headers, body, timeoutMs) {
    return new Promise(function (resolve, reject) {
        var u;
        try { u = new URL(rawUrl); } catch (e) { return reject(e); }
        var isHttps = u.protocol === 'https:';
        var lib = isHttps ? https : http;
        var settled = false;
        function done(fn, v) { if (settled) return; settled = true; fn(v); }
        var req = lib.request({
            method: 'POST',
            hostname: stripBrackets(u.hostname),
            port: u.port || (isHttps ? 443 : 80),
            path: (u.pathname || '/') + (u.search || ''),
            headers: Object.assign({ 'content-length': body.length }, headers),
            timeout: timeoutMs,
        }, function (res) {
            var chunks = [];
            var received = 0;
            res.on('data', function (chunk) {
                received += chunk.length;
                if (received > PUSH_RESP_MAX_BYTES) return res.destroy();
                chunks.push(chunk);
            });
            var finish = function () {
                done(resolve, { status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') });
            };
            res.on('end', finish);
            res.on('close', finish);
        });
        req.on('timeout', function () { req.destroy(new Error('timeout')); });
        req.on('error', function (err) { done(reject, err); });
        try {
            req.write(body);
            req.end();
        } catch (e) { done(reject, e); }
    });
}

// Load + validate a Firebase service-account JSON from a path. Throws (with the
// given env-var label) on an unreadable/non-JSON file, a non-service_account
// type, or a SA missing client_email/private_key/project_id — so a misconfig
// fails loudly at boot, never per-send. `label` is the env var it came from so
// the error is actionable.
function loadFcmServiceAccountFile(credFile, label) {
    var sa;
    try {
        sa = JSON.parse(fs.readFileSync(credFile, 'utf8'));
    } catch (e) {
        throw new Error(label + ' unreadable or not JSON: ' + credFile + ' (' + e.message + ')');
    }
    if (sa.type !== 'service_account')
        throw new Error(label + ' must be a service_account JSON (type=service_account): ' + credFile);
    if (!sa.client_email || !sa.private_key || !sa.project_id)
        throw new Error(label + ' must contain client_email, private_key and project_id: ' + credFile);
    return sa;
}

// Build an FcmTransport from env. FCM HTTP v1 is project-scoped, so the transport
// can carry several projects keyed by app_id (see FcmTransport):
//   TYO_MQ_PUSH_FCM_CREDENTIALS (existing) — the DEFAULT project's service-account
//     JSON path. With only this set the behaviour is byte-identical to before
//     (one project used for every fcm endpoint).
//   TYO_MQ_PUSH_FCM_PROJECTS (new, optional) — a JSON OBJECT string mapping
//     app_id -> service-account JSON path, e.g.
//     {"operator":"/home/dev/.config/tyo-mq/fcm-id-tyo-com-au.json"}. Each SA is
//     loaded+validated at boot; a send to an endpoint with that app_id signs +
//     routes to that project. An app_id not in the map falls back to the default.
// At least one of the two must be set. Every referenced SA is read + validated at
// boot so a misconfig (unparseable map, missing/invalid file, bad SA) fails loud.
function createFcmTransportFromEnv(env) {
    var credFile = env.TYO_MQ_PUSH_FCM_CREDENTIALS;
    var projectsRaw = env.TYO_MQ_PUSH_FCM_PROJECTS;
    if (!credFile && !projectsRaw)
        throw new Error("push transport 'fcm' requires TYO_MQ_PUSH_FCM_CREDENTIALS " +
            '(path to the Firebase service-account JSON)');
    var opts = {};
    if (credFile)
        opts.serviceAccount = loadFcmServiceAccountFile(credFile, 'TYO_MQ_PUSH_FCM_CREDENTIALS');
    if (projectsRaw) {
        var map;
        try {
            map = JSON.parse(projectsRaw);
        } catch (e) {
            throw new Error('TYO_MQ_PUSH_FCM_PROJECTS must be a JSON object mapping app_id -> ' +
                'service-account JSON path (parse error: ' + e.message + ')');
        }
        if (!map || typeof map !== 'object' || Array.isArray(map))
            throw new Error('TYO_MQ_PUSH_FCM_PROJECTS must be a JSON object mapping app_id -> ' +
                'service-account JSON path');
        var projects = {};
        Object.keys(map).forEach(function (appId) {
            var p = map[appId];
            if (typeof p !== 'string' || !p)
                throw new Error('TYO_MQ_PUSH_FCM_PROJECTS entry for app_id "' + appId +
                    '" must be a path string to a service-account JSON');
            projects[appId] = loadFcmServiceAccountFile(p, 'TYO_MQ_PUSH_FCM_PROJECTS[' + appId + ']');
        });
        opts.projects = projects;
    }
    return new FcmTransport(opts);
}

// ApnsTransport (P3): Apple Push Notification service wake over HTTP/2 with
// provider-token (ES256 JWT) auth. Sends a CONTENTLESS silent background push
// ({"aps":{"content-available":1}}) that nudges an offline iOS device to wake
// and drain its sealed queue — no alert, no sound, no sender, no content.
//
// Auth: one ES256 provider JWT (header {alg:'ES256',kid}, payload {iss:team,iat})
// is signed with the .p8 EC key and REUSED across all sends, re-signed only on
// the refresh interval (Apple requires reuse + refresh at most once per 20 min).
//
// Transport: one HTTP/2 session PER ENV (production/sandbox host) is opened
// lazily and reused across sends; a GOAWAY/close drops it so the next send
// reconnects. Each request has a hard timeout and the response body is capped.
// Both hosts are fixed Apple endpoints, never client-supplied — the UnifiedPush
// SSRF guard does not apply.
//
// Result contract (matches fireWake's expectations):
//   200                                          -> { ok:true }
//   410 Unregistered, 400 BadDeviceToken /
//     DeviceTokenNotForTopic                      -> { ok:false, gone:true }  (prune device token)
//   403 InvalidProviderToken/ExpiredProviderToken/
//     BadEnvironmentKeyInToken/MissingProviderToken -> { ok:false } (OUR creds/env —
//       retain device token, warn token-free; re-sign next send on Expired)
//   429 / 5xx / timeout / GOAWAY / other          -> { ok:false } (transient — retain)
function ApnsTransport(opts) {
    opts = opts || {};
    if (!opts.p8) throw new Error('ApnsTransport requires a p8 key (contents or path)');
    if (!opts.keyId) throw new Error('ApnsTransport requires a keyId');
    if (!opts.teamId) throw new Error('ApnsTransport requires a teamId');
    if (!opts.topic) throw new Error('ApnsTransport requires a topic');
    // p8 may be the key contents (PEM) or a filesystem path.
    var pem = String(opts.p8);
    if (pem.indexOf('BEGIN') < 0) {
        try { pem = fs.readFileSync(opts.p8, 'utf8'); }
        catch (e) { throw new Error('ApnsTransport p8 unreadable: ' + opts.p8 + ' (' + e.message + ')'); }
    }
    var key;
    try { key = crypto.createPrivateKey(pem); }
    catch (e) { throw new Error('ApnsTransport p8 is not a valid private key: ' + e.message); }
    if (key.asymmetricKeyType !== 'ec')
        throw new Error('ApnsTransport p8 must be an EC (P-256) key, got ' + key.asymmetricKeyType);
    this.name = TRANSPORT_APNS;
    this._key = key;
    this.keyId = opts.keyId;
    this.teamId = opts.teamId;
    this.topic = opts.topic;
    this.defaultEnv = normalizeApnsEnv(opts.defaultEnv, APNS_ENV_PRODUCTION);
    this.timeoutMs = opts.timeoutMs || PUSH_HTTP_TIMEOUT_MS;
    this.refreshMs = opts.refreshMs || APNS_JWT_REFRESH_MS;
    // Per-env authority (host). TEST-ONLY overrides; production always talks to
    // the fixed Apple hosts.
    this._hosts = {};
    this._hosts[APNS_ENV_PRODUCTION] = opts.productionHost || ('https://' + APNS_HOST_PRODUCTION + ':' + APNS_PORT);
    this._hosts[APNS_ENV_SANDBOX] = opts.sandboxHost || ('https://' + APNS_HOST_SANDBOX + ':' + APNS_PORT);
    // Injectable http2 connect (tests point it at a mock APNs server).
    this._connect = opts.connect || http2.connect;
    // TEST-ONLY: accept a self-signed cert from the mock server.
    this._rejectUnauthorized = opts.rejectUnauthorized;
    this._sessions = {};          // env -> ClientHttp2Session (reused)
    this._jwt = null;             // { value, mintedAtMs } — cached provider JWT
    this._signCount = 0;          // observable: how many times we've signed
    this.logger = opts.logger || null;
    this._lastAuthWarnMs = 0;
}

// Normalise an env string to 'production' | 'sandbox', falling back to dflt.
function normalizeApnsEnv(env, dflt) {
    if (env === APNS_ENV_SANDBOX || env === APNS_ENV_PRODUCTION) return env;
    return dflt || APNS_ENV_PRODUCTION;
}

// Sign a fresh ES256 provider JWT with the .p8 EC key. ieee-p1363 yields the
// raw r||s signature APNs requires (NOT the DER encoding). NEVER logged.
ApnsTransport.prototype._signProviderToken = function () {
    var nowSec = Math.floor(Date.now() / 1000);
    var b64url = function (obj) {
        return Buffer.from(JSON.stringify(obj), 'utf8').toString('base64url');
    };
    var signingInput = b64url({ alg: 'ES256', kid: this.keyId }) + '.' + b64url({ iss: this.teamId, iat: nowSec });
    var sig = crypto
        .createSign('SHA256')
        .update(signingInput)
        .sign({ key: this._key, dsaEncoding: 'ieee-p1363' })
        .toString('base64url');
    this._signCount++;
    return signingInput + '.' + sig;
};

// Return the cached provider JWT, re-signing only when past the refresh window
// or after an invalidation (Expired). One token is reused across all sends.
ApnsTransport.prototype._getProviderToken = function () {
    var now = Date.now();
    if (this._jwt && (now - this._jwt.mintedAtMs) < this.refreshMs)
        return this._jwt.value;
    var value = this._signProviderToken();
    this._jwt = { value: value, mintedAtMs: now };
    return value;
};

// Drop a session from the pool (on error/goaway/close) so the next send opens a
// fresh one.
ApnsTransport.prototype._dropSession = function (env, session) {
    if (this._sessions[env] === session) delete this._sessions[env];
};

// Lazily open (and reuse) an HTTP/2 session to the env's Apple host.
ApnsTransport.prototype._getSession = function (env) {
    var self = this;
    var existing = this._sessions[env];
    if (existing && !existing.destroyed && !existing.closed) return existing;
    var authority = this._hosts[env];
    var connectOpts = {};
    if (this._rejectUnauthorized === false) connectOpts.rejectUnauthorized = false;
    var session = this._connect(authority, connectOpts);
    // Swallow session-level errors (the pending request's stream surfaces them
    // as a per-send transient) and drop the session so the next send reconnects.
    session.on('error', function () { self._dropSession(env, session); });
    session.on('goaway', function () { self._dropSession(env, session); });
    session.on('close', function () { self._dropSession(env, session); });
    this._sessions[env] = session;
    return session;
};

// Perform one HTTP/2 POST /3/device/<token>. Resolves { status, body } (body
// capped) or rejects on a transport error/timeout (caller maps reject->transient).
ApnsTransport.prototype._request = function (env, token, jwt) {
    var self = this;
    return new Promise(function (resolve, reject) {
        var session;
        try { session = self._getSession(env); }
        catch (e) { return reject(e); }
        var body = Buffer.from('{"aps":{"content-available":1}}', 'utf8');
        var headers = {
            ':method': 'POST',
            ':path': '/3/device/' + token,
            'authorization': 'bearer ' + jwt,
            'apns-topic': self.topic,
            'apns-push-type': 'background',
            'apns-priority': '5',
            'apns-expiration': '0',
            'content-length': body.length,
        };
        var settled = false;
        function done(fn, v) { if (settled) return; settled = true; fn(v); }
        var req;
        try { req = session.request(headers); }
        catch (e) { self._dropSession(env, session); return reject(e); }
        req.setTimeout(self.timeoutMs, function () {
            try { req.close(); } catch (e) { /* noop */ }
            done(reject, new Error('timeout'));
        });
        var status;
        var chunks = [];
        var received = 0;
        req.on('response', function (h) { status = h[':status']; });
        req.on('data', function (c) {
            received += c.length;
            if (received > PUSH_RESP_MAX_BYTES) { try { req.close(); } catch (e) {} return; }
            chunks.push(c);
        });
        req.on('end', function () { done(resolve, { status: status, body: Buffer.concat(chunks).toString('utf8') }); });
        req.on('error', function (e) { done(reject, e); });
        req.on('close', function () {
            // A close without a response (refused stream / GOAWAY) surfaces as a
            // transient with an undefined status.
            done(resolve, { status: status, body: Buffer.concat(chunks).toString('utf8') });
        });
        try { req.end(body); }
        catch (e) { done(reject, e); }
    });
};

ApnsTransport.prototype.send = function (endpoint) {
    var self = this;
    endpoint = endpoint || {};
    var env = normalizeApnsEnv(endpoint.env, self.defaultEnv);
    var jwt;
    try { jwt = self._getProviderToken(); }
    catch (e) { return Promise.resolve({ ok: false }); }
    return self._request(env, endpoint.token, jwt)
        .then(function (res) {
            var cls = classifyApnsResponse(res.status, res.body);
            if (cls.auth) {
                // OUR provider token / env-scope is wrong — NOT the device token.
                // Warn (token-free) and retain. Re-sign next send on Expired.
                if (cls.expired) self._jwt = null;
                self._warnAuth(res.status, cls.reason);
                return { ok: false };
            }
            if (cls.gone) return { ok: false, gone: true };
            return cls.ok ? { ok: true } : { ok: false };
        })
        .catch(function () { return { ok: false }; });
};

// Emit a rate-limited, TOKEN-FREE warn when APNs rejects OUR provider token /
// env scope (403). The device token must NOT be pruned. NEVER logs the device
// token, the provider JWT, or the .p8 key — transport + coarse reason only.
ApnsTransport.prototype._warnAuth = function (status, reason) {
    var logger = this.logger;
    if (!logger || typeof logger.warn !== 'function') return;
    var now = Date.now();
    if (now - this._lastAuthWarnMs < PUSH_FAIL_LOG_WINDOW_MS) return;
    this._lastAuthWarnMs = now;
    logger.warn('push wake failed: transport=apns reason=auth status=' + status +
        (reason ? ' apns-reason=' + reason : '') +
        ' (APNs provider token / env scope rejected — device token NOT pruned)');
};

// Parse an APNs error body's `reason` (nullable). APNs errors are
// { "reason": "BadDeviceToken" } with the verdict in `reason`.
function parseApnsReason(body) {
    try {
        var p = JSON.parse(body || '{}');
        return (p && p.reason) || null;
    } catch (e) { return null; }
}

// Classify an APNs response into a wake verdict. The wrong call either prunes a
// valid device token or spams a dead one.
//   200                                              -> { ok:true }
//   403 provider-token reasons (OUR creds/env)        -> { auth:true, expired?, reason }
//   410, 400 BadDeviceToken / DeviceTokenNotForTopic  -> { gone:true }
//   429 / 5xx / timeout / GOAWAY / other              -> { } (transient)
function classifyApnsResponse(status, body) {
    if (status >= 200 && status < 300) return { ok: true };
    var reason = parseApnsReason(body);
    if (status === 403) {
        return {
            auth: true,
            reason: reason,
            expired: reason === 'ExpiredProviderToken',
        };
    }
    if (status === 410) return { gone: true, reason: reason };
    if (status === 400 && (reason === 'BadDeviceToken' || reason === 'DeviceTokenNotForTopic'))
        return { gone: true, reason: reason };
    // 429 TooManyRequests / 500 / 503 / other 400 / undefined (GOAWAY/timeout) -> transient.
    return { reason: reason };
}

// Build an ApnsTransport from env: a .p8 key path + the four Apple identifiers.
// Read + validated at boot so a misconfig fails loudly at config time.
function createApnsTransportFromEnv(env) {
    var keyPath = env.TYO_MQ_PUSH_APNS_KEY;
    var keyId = env.TYO_MQ_PUSH_APNS_KEY_ID;
    var teamId = env.TYO_MQ_PUSH_APNS_TEAM_ID;
    var topic = env.TYO_MQ_PUSH_APNS_TOPIC;
    var defaultEnv = env.TYO_MQ_PUSH_APNS_ENV || APNS_ENV_PRODUCTION;
    var missing = [];
    if (!keyPath) missing.push('TYO_MQ_PUSH_APNS_KEY');
    if (!keyId) missing.push('TYO_MQ_PUSH_APNS_KEY_ID');
    if (!teamId) missing.push('TYO_MQ_PUSH_APNS_TEAM_ID');
    if (!topic) missing.push('TYO_MQ_PUSH_APNS_TOPIC');
    if (missing.length)
        throw new Error("push transport 'apns' requires " + missing.join(', ') +
            ' (path to the .p8 key + Key ID / Team ID / topic)');
    if (defaultEnv !== APNS_ENV_PRODUCTION && defaultEnv !== APNS_ENV_SANDBOX)
        throw new Error('TYO_MQ_PUSH_APNS_ENV must be "production" or "sandbox": ' + defaultEnv);
    var p8;
    try { p8 = fs.readFileSync(keyPath, 'utf8'); }
    catch (e) { throw new Error('TYO_MQ_PUSH_APNS_KEY unreadable: ' + keyPath + ' (' + e.message + ')'); }
    // Constructor validates the key loads as EC and fails loud otherwise.
    return new ApnsTransport({ p8: p8, keyId: keyId, teamId: teamId, topic: topic, defaultEnv: defaultEnv });
}

// Factory: select a transport implementation by name. 'null' (dev/test),
// 'unifiedpush' (self-hosted HTTP wake), 'fcm' (FCM HTTP v1) and 'apns' (APNs
// HTTP/2) are wired.
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
            return createFcmTransportFromEnv(env);
        case TRANSPORT_APNS:
            return createApnsTransportFromEnv(env);
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

// Returns null (feature OFF) when TYO_MQ_PUSH_TRANSPORT is absent/empty, else a
// config holding a name->transport MAP so a single broker can wake several
// client types at once (e.g. Android via fcm, iOS via apns, self-hosted via
// unifiedpush). TYO_MQ_PUSH_TRANSPORT is a comma-separated list; each name is
// trimmed, empties are dropped, and EACH transport is built (and validates its
// own creds) via createTransport. THROWS synchronously when the env names an
// unknown/unwired transport OR a transport whose credentials are missing — a
// boot-time caller wraps this and emits an actionable error, exactly like
// SealedSender.loadConfig. A single name still yields a one-entry map plus the
// legacy `transport`/`transportName` aliases for 100% backward-compat.
//
// Shape: { transports: { <name>: <transport>, ... },
//          transportNames: ['fcm','apns','unifiedpush'],
//          allowLocal: <the unifiedpush transport's allowLocal, or false> }
function loadConfig(env) {
    env = env || process.env;
    var raw = env.TYO_MQ_PUSH_TRANSPORT;
    if (!raw) return null;
    var names = String(raw)
        .split(',')
        .map(function (s) { return s.trim(); })
        .filter(function (s) { return s.length > 0; });
    if (!names.length) return null;
    var transports = {};
    var transportNames = [];
    for (var i = 0; i < names.length; i++) {
        var name = names[i];
        // createTransport validates each transport's own creds and throws on an
        // unknown name — fail loud so the boot caller disables push with an error.
        var transport = createTransport(name, env);
        if (!Object.prototype.hasOwnProperty.call(transports, name))
            transportNames.push(name);
        transports[name] = transport;
    }
    // allowLocal is only meaningful for unifiedpush (surfaced so the
    // PUSH_REGISTER handler can run the same SSRF policy the transport enforces).
    var up = Object.prototype.hasOwnProperty.call(transports, TRANSPORT_UNIFIEDPUSH)
        ? transports[TRANSPORT_UNIFIEDPUSH] : null;
    var cfg = {
        transports: transports,
        transportNames: transportNames,
        allowLocal: !!(up && up.allowLocal),
    };
    // Backward-compat: a single-transport config still exposes the old
    // `transport`/`transportName` fields (unchanged callers keep working).
    if (transportNames.length === 1) {
        cfg.transport = transports[transportNames[0]];
        cfg.transportName = transportNames[0];
    }
    return cfg;
}

function isConfigured(cfg) {
    return !!(cfg && cfg.transports && Object.keys(cfg.transports).length > 0);
}

// Resolve the transport instance able to service an endpoint's transport name.
// Prototype-pollution-safe lookup (endpoint transport names are client-supplied):
// a name with no configured transport — or a prototype key like '__proto__' —
// returns null, so that endpoint is simply not woken.
function transportFor(cfg, name) {
    if (!isConfigured(cfg)) return null;
    if (Object.prototype.hasOwnProperty.call(cfg.transports, name))
        return cfg.transports[name];
    return null;
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
        if (ep.env !== undefined) existing.env = ep.env;
        return existing;
    }
    var endpoint = {
        transport: ep.transport,
        token: ep.token,
        app_id: ep.app_id !== undefined ? ep.app_id : null,
        // env is only meaningful for apns ('sandbox'|'production'); other
        // transports leave it null and ignore it.
        env: ep.env !== undefined ? ep.env : null,
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
                env: ep.env,
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

// ── TYO Notify phone delivery (N3) ─────────────────────────────────────────
// Unlike the sealed wake, a Notify push is the delivery mechanism itself, so it
// may be content-ful (opt-in per publish) and is NOT coalesced — each message
// is a distinct notification. Reuses the transports + TokenRegistry (keyed by
// (notifyRealm, topic)). Best-effort; a delivery never throws into the caller.
var NOTIFY_PUSH_MSG_MAX = 1024;

function buildNotifyPayload(msg, mode) {
    msg = msg || {};
    // Always string-valued (FCM data requires strings). Topic is the channel the
    // subscriber already knows, not message content, so a 'wake' carries it too.
    var p = {type: 'notify', v: '1', topic: String(msg.topic || '')};
    if (msg.id) p.id = String(msg.id);
    if (mode === 'content') {
        var body = msg.message == null ? '' : String(msg.message);
        if (body.length > NOTIFY_PUSH_MSG_MAX) body = body.slice(0, NOTIFY_PUSH_MSG_MAX);
        p.message = body;
        if (msg.title) p.title = String(msg.title);
        if (msg.priority) p.priority = String(msg.priority);
        if (msg.tags && msg.tags.length) p.tags = msg.tags.join(',');
        if (msg.click) p.click = String(msg.click);
    } else {
        p.wake = '1'; // contentless: "topic has a new message, go fetch"
    }
    return p;
}

function deliverNotifyPush(cfg, registry, realm, topic, msg, mode, opts) {
    opts = opts || {};
    var now = opts.now || Date.now();
    var logger = opts.logger || null;
    try {
        if (mode === 'off')
            return Promise.resolve({ sent: 0, skipped: 'off' });
        if (!isConfigured(cfg))
            return Promise.resolve({ sent: 0, skipped: 'unconfigured' });
        if (!registry)
            return Promise.resolve({ sent: 0, skipped: 'no-registry' });
        var endpoints = registry.list(realm, topic);
        if (!endpoints.length)
            return Promise.resolve({ sent: 0, skipped: 'no-endpoints' });

        var payload = buildNotifyPayload(msg, mode);
        var attempts = endpoints.map(function (ep) {
            var transport = transportFor(cfg, ep.transport);
            if (!transport) return Promise.resolve();
            return Promise.resolve(transport.send({
                transport: ep.transport,
                token: ep.token,
                app_id: ep.app_id,
                env: ep.env,
                payload: payload,
            })).then(function (res) {
                if (res && res.gone) {
                    registry.prune(realm, topic, ep);
                    logWakeFailure(registry, logger, ep.transport, 'gone', now);
                } else if (res && res.ok) {
                    registry.markOk(realm, topic, ep, now);
                } else {
                    logWakeFailure(registry, logger, ep.transport, (res && res.unsafe) ? 'unsafe' : 'transient', now);
                }
            }).catch(function () {
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
    FcmTransport: FcmTransport,
    ApnsTransport: ApnsTransport,
    // SSRF guard (exported so the server + tests can enforce the same policy).
    isSafePushUrl: isSafePushUrl,
    classifyAddress: classifyAddress,
    // payload
    buildWakePayload: buildWakePayload,
    assertContentless: assertContentless,
    // registry + wake
    TokenRegistry: TokenRegistry,
    fireWake: fireWake,
    buildNotifyPayload: buildNotifyPayload,
    deliverNotifyPush: deliverNotifyPush,
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
