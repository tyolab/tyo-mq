'use strict';

// One-shot attachment-capability ticket store for the anonymous secure-chat tier.
//
// The broker issues a short-lived, opaque, ONE-SHOT ticket to an authenticated
// (possibly anonymous) chat socket. The store backend later redeems it exactly
// once over the service-token-gated verify-ticket HTTP endpoint. This module is
// the authority for issuing and redeeming those tickets.
//
// Design (pinned with store-backend 2026-10-05):
//   * op-match (upload|download) and, for download, ref-match.
//   * CONSUME ONLY on a valid redemption — a wrong-op / wrong-ref probe can never
//     burn a legitimate ticket, and a redeemed ticket never verifies twice. Every
//     non-valid outcome is uniformly `false` (the HTTP layer maps that to
//     200 {valid:false}); nothing distinguishes unknown / expired / consumed /
//     mismatch, so a prober learns nothing.
//   * TTL <= 120s, hard-capped at 900s (ticket -> mint is immediate).
//   * a per-session mint cap on UPLOADS (downloads are uncapped — the store
//     throttles those); the authoritative cap lives here on the broker.
//   * tickets are kept HASHED at rest (same hygiene as publish tokens): a memory
//     dump yields sha256 hashes, not live capabilities.
//
// Deliberately in-memory and process-local: a capability that survives a broker
// restart is a bug, not a feature, and these tickets live <=120s. The sealed
// broker is a single pinned instance, so issue (over the socket) and verify (over
// HTTP) hit the same process.

var auth = require('./notify-auth');

var DEFAULT_TTL_MS = 120 * 1000;      // 120s
var HARD_TTL_CAP_MS = 900 * 1000;     // 900s absolute ceiling
var DEFAULT_UPLOAD_CAP = 60;          // uploads per session per window (~JWT mint rate)
var DEFAULT_WINDOW_MS = 60 * 60 * 1000; // 1h
var DEFAULT_MAX_TICKETS = 100000;     // global bound (DoS guard)

function err(code, message) {
    var e = new Error(message);
    e.code = code;
    return e;
}

function ChatTicketStore(opts) {
    opts = opts || {};
    this.ttlMs = Math.min(Math.max(1, opts.ttlMs || DEFAULT_TTL_MS), HARD_TTL_CAP_MS);
    this.uploadCapPerWindow = opts.uploadCapPerWindow || DEFAULT_UPLOAD_CAP;
    this.windowMs = opts.windowMs || DEFAULT_WINDOW_MS;
    this.maxTickets = opts.maxTickets || DEFAULT_MAX_TICKETS;
    this._tickets = new Map();   // sha256(ticket) -> { op, ref|null, session, exp }
    this._sessions = new Map();  // session -> { count, windowStart }  (upload cap)
}

ChatTicketStore.prototype._sweep = function (now) {
    var tickets = this._tickets;
    tickets.forEach(function (entry, hash) {
        if (now > entry.exp) tickets.delete(hash);
    });
};

// Issue a one-shot ticket to an authenticated session. Throws on invalid input
// or when the per-session upload cap / global bound is hit (the caller maps the
// thrown .code to a socket-ack error). Returns the raw ticket string — the ONLY
// time the raw value exists; the store keeps only its hash.
ChatTicketStore.prototype.issue = function (session, op, ref, now) {
    now = (now === undefined) ? Date.now() : now;

    if (typeof session !== 'string' || !session)
        throw err('missing_session', 'a session id is required to issue a ticket');
    if (op !== 'upload' && op !== 'download')
        throw err('invalid_op', 'unsupported op (must be "upload" or "download")');
    if (op === 'download' && (typeof ref !== 'string' || !ref))
        throw err('missing_ref', 'a download ticket requires a non-empty ref');
    if (op === 'upload' && ref !== undefined && ref !== null)
        throw err('unexpected_ref', 'an upload ticket must not carry a ref (the store generates it)');

    // Per-session cap applies to uploads only; downloads are uncapped here.
    if (op === 'upload') {
        var s = this._sessions.get(session);
        if (!s || (now - s.windowStart) >= this.windowMs)
            s = { count: 0, windowStart: now };
        if (s.count >= this.uploadCapPerWindow)
            throw err('cap_exceeded', 'per-session upload ticket cap reached');
        s.count += 1;
        this._sessions.set(session, s);
    }

    if (this._tickets.size >= this.maxTickets) {
        this._sweep(now);
        if (this._tickets.size >= this.maxTickets)
            throw err('store_full', 'ticket store is full');
    }

    var raw = auth.generatePublishToken();           // 256-bit hex, unguessable
    var hash = auth.hashPublishToken(raw);
    this._tickets.set(hash, {
        op: op,
        ref: (op === 'download') ? ref : null,
        session: session,
        exp: now + this.ttlMs
    });
    return raw;
};

// Redeem a ticket. Returns true exactly once, for a live ticket whose op (and,
// for download, ref) matches — and consumes it. Every other outcome is false and
// leaves any live ticket UNTOUCHED (a wrong-op/wrong-ref probe cannot burn it).
ChatTicketStore.prototype.verify = function (ticket, op, ref, now) {
    now = (now === undefined) ? Date.now() : now;
    this._sweep(now);

    if (typeof ticket !== 'string' || !ticket)
        return false;

    var hash = auth.hashPublishToken(ticket);
    var entry = this._tickets.get(hash);
    if (!entry)
        return false;
    if (now > entry.exp) {
        this._tickets.delete(hash);
        return false;
    }
    if (entry.op !== op)
        return false;                                // mismatch: do NOT consume
    if (op === 'download' && entry.ref !== ref)
        return false;                                // wrong ref: do NOT consume

    this._tickets.delete(hash);                      // consume on valid only
    return true;
};

// Live ticket count. Pass `now` to sweep expired entries first.
ChatTicketStore.prototype.size = function (now) {
    if (now !== undefined) this._sweep(now);
    return this._tickets.size;
};

module.exports = ChatTicketStore;
module.exports.DEFAULT_TTL_MS = DEFAULT_TTL_MS;
module.exports.HARD_TTL_CAP_MS = HARD_TTL_CAP_MS;
