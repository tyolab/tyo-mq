'use strict';

// TYO Notify — ntfy-compatible message model + in-memory topic ring.
//
// Pure, transport-agnostic helpers used by the broker's public /notify HTTP
// surface (see docs/specs/2026-08-20-tyo-notify-service-design.md). No socket,
// no storage, no account data — this is the "publish a message to a topic and
// it appears on your phone" primitive, isolated to the reserved `notify` realm.
//
// "ntfy" here means the reference wire-format (ntfy.sh) we stay compatible
// with; the TYO product is TYO Notify.

var crypto = require('crypto');

// ── topic keys ────────────────────────────────────────────────────────────────
// Same charset ntfy allows: letters, digits, dash, underscore, 1..64 chars.
// (A stricter-than-realm charset also keeps the value safe as a Map key.)
var TOPIC_RE = /^[-_A-Za-z0-9]{1,64}$/;

function isValidTopic (topic) {
    return typeof topic === 'string' && TOPIC_RE.test(topic);
}

// ── priority ──────────────────────────────────────────────────────────────────
// 1..5, or the ntfy names. Default 3 (ntfy "default").
var PRIORITY_NAMES = { min: 1, low: 2, default: 3, high: 4, max: 5, urgent: 5 };

function parsePriority (v) {
    if (v === undefined || v === null || v === '') return 3;
    var s = String(v).trim().toLowerCase();
    if (Object.prototype.hasOwnProperty.call(PRIORITY_NAMES, s))
        return PRIORITY_NAMES[s];
    var n = parseInt(s, 10);
    if (!isNaN(n) && n >= 1 && n <= 5) return n;
    return 3;
}

// ── tags ──────────────────────────────────────────────────────────────────────
var MAX_TAGS = 20;
var MAX_TAG_LEN = 64;
var MAX_TITLE_LEN = 256;
var MAX_CLICK_LEN = 2048;

function parseTags (v) {
    if (!v) return [];
    if (Array.isArray(v)) v = v.join(',');
    return String(v).split(',')
        .map(function (t) { return t.trim(); })
        .filter(function (t) { return t.length > 0 && t.length <= MAX_TAG_LEN; })
        .slice(0, MAX_TAGS);
}

// ── actions (ntfy subset; spec 2026-08-28) ────────────────────────────────────
// Buttons the phone renders (shade: first 3, card: all). Cap 6 (laxer than
// ntfy's 3, format-identical). https-only; fail-loud — the publish path 400s
// on any violation rather than silently stripping a pipeline's buttons.
var MAX_ACTIONS = 6;
var MAX_ACTION_LABEL = 64;
var MAX_ACTION_URL = 2048;
var MAX_ACTION_BODY = 1024;
var MAX_ACTION_HEADERS = 8;
var MAX_ACTION_HEADER_LEN = 256;
var ACTION_METHODS = ['GET', 'POST', 'PUT', 'DELETE'];

// Returns {actions: [...normalized]} or {error: 'reason'}. Never throws.
function validateActions (raw) {
    if (!Array.isArray(raw)) return { error: 'actions must be an array' };
    if (raw.length > MAX_ACTIONS) return { error: 'too many actions (max ' + MAX_ACTIONS + ')' };
    var out = [];
    for (var i = 0; i < raw.length; i++) {
        var a = raw[i];
        if (!a || typeof a !== 'object' || Array.isArray(a))
            return { error: 'action ' + i + ': must be an object' };
        if (a.action !== 'http' && a.action !== 'view')
            return { error: 'action ' + i + ": type must be 'http' or 'view'" };
        if (typeof a.label !== 'string' || !a.label || a.label.length > MAX_ACTION_LABEL)
            return { error: 'action ' + i + ': label required (max ' + MAX_ACTION_LABEL + ')' };
        if (typeof a.url !== 'string' || a.url.indexOf('https://') !== 0 || a.url.length > MAX_ACTION_URL)
            return { error: 'action ' + i + ': url must be https (max ' + MAX_ACTION_URL + ')' };
        var norm = { action: a.action, label: a.label, url: a.url };
        if (a.action === 'http') {
            var method = a.method === undefined ? 'POST' : String(a.method).toUpperCase();
            if (ACTION_METHODS.indexOf(method) === -1)
                return { error: 'action ' + i + ': method must be one of ' + ACTION_METHODS.join('/') };
            norm.method = method;
            if (a.body !== undefined) {
                if (typeof a.body !== 'string' || a.body.length > MAX_ACTION_BODY)
                    return { error: 'action ' + i + ': body must be a string (max ' + MAX_ACTION_BODY + ')' };
                norm.body = a.body;
            }
            if (a.headers !== undefined) {
                if (!a.headers || typeof a.headers !== 'object' || Array.isArray(a.headers))
                    return { error: 'action ' + i + ': headers must be an object' };
                var keys = Object.keys(a.headers);
                if (keys.length > MAX_ACTION_HEADERS)
                    return { error: 'action ' + i + ': too many headers (max ' + MAX_ACTION_HEADERS + ')' };
                var headers = {};
                for (var k = 0; k < keys.length; k++) {
                    var v = a.headers[keys[k]];
                    if (typeof v !== 'string' || v.length > MAX_ACTION_HEADER_LEN || keys[k].length > MAX_ACTION_HEADER_LEN)
                        return { error: 'action ' + i + ': header entries must be strings (max ' + MAX_ACTION_HEADER_LEN + ')' };
                    headers[keys[k]] = v;
                }
                norm.headers = headers;
            }
        }
        out.push(norm);
    }
    return { actions: out };
}

// ── push mode ─────────────────────────────────────────────────────────────────
// content-ful vs contentless wake vs no phone push. Default 'wake' (the
// privacy-first choice); the publisher opts in to 'content' per message.
function parsePush (headerVal, queryVal) {
    var v = (queryVal !== undefined && queryVal !== null && queryVal !== '')
        ? queryVal : headerVal;
    if (v === undefined || v === null || v === '') return 'wake';
    var s = String(v).trim().toLowerCase();
    if (s === 'content' || s === 'message' || s === 'full') return 'content';
    if (s === 'off' || s === 'none' || s === 'no' || s === '0' || s === 'false') return 'off';
    return 'wake';
}

// ── canonical message ─────────────────────────────────────────────────────────
// Build the ntfy-shaped message object delivered to subscribers and cached in
// the ring. Empty optional fields are omitted so the JSON stays lean.
function buildMessage (opts) {
    opts = opts || {};
    var msg = {
        id: opts.id || ('n-' + crypto.randomBytes(9).toString('hex')),
        time: opts.time || Math.floor(Date.now() / 1000),
        event: 'message',
        topic: opts.topic,
        message: opts.message != null ? String(opts.message) : ''
    };
    // Bound optional fields so an oversized JSON-body field can't bloat the ring,
    // the SSE frame, or blow the FCM 4KB data limit downstream.
    if (opts.title) msg.title = String(opts.title).slice(0, MAX_TITLE_LEN);
    var pr = parsePriority(opts.priority);
    if (pr !== 3) msg.priority = pr;
    var tags = Array.isArray(opts.tags) ? opts.tags.slice(0, MAX_TAGS) : parseTags(opts.tags);
    if (tags.length) msg.tags = tags.map(function (t) { return String(t).slice(0, MAX_TAG_LEN); });
    if (opts.click) msg.click = String(opts.click).slice(0, MAX_CLICK_LEN);
    if (Array.isArray(opts.actions) && opts.actions.length) msg.actions = opts.actions;
    if (opts.markdown) msg.content_type = 'text/markdown';
    else if (opts.contentType) msg.content_type = String(opts.contentType);
    return msg;
}

// ── topic ring ────────────────────────────────────────────────────────────────
// In-memory, per-topic, TTL-bounded buffer purely to serve `?since=` catch-up.
// Non-durable by design: lost on restart, never written to account storage.
function NotifyRing (opts) {
    opts = opts || {};
    this.ttlMs = opts.ttlMs || 12 * 60 * 60 * 1000; // 12h, like ntfy
    this.maxPerTopic = opts.maxPerTopic || 100;
    this.maxTopics = opts.maxTopics || 5000;
    this._topics = new Map(); // topic -> { msgs: [{at, msg}], last: ms }
}

NotifyRing.prototype._evictTopicsIfNeeded = function () {
    if (this._topics.size <= this.maxTopics) return;
    // LRU: drop the least-recently-touched topics until back under the cap.
    var entries = Array.from(this._topics.entries());
    entries.sort(function (a, b) { return a[1].last - b[1].last; });
    var toDrop = this._topics.size - this.maxTopics;
    for (var i = 0; i < toDrop; i++)
        this._topics.delete(entries[i][0]);
};

NotifyRing.prototype._prune = function (entry, now) {
    var cutoff = now - this.ttlMs;
    while (entry.msgs.length && entry.msgs[0].at < cutoff)
        entry.msgs.shift();
};

NotifyRing.prototype.append = function (topic, msg, now) {
    if (now === undefined) now = Date.now();
    var entry = this._topics.get(topic);
    if (!entry) { entry = { msgs: [], last: now }; this._topics.set(topic, entry); }
    entry.last = now;
    this._prune(entry, now);
    entry.msgs.push({ at: now, msg: msg });
    if (entry.msgs.length > this.maxPerTopic)
        entry.msgs.splice(0, entry.msgs.length - this.maxPerTopic);
    this._evictTopicsIfNeeded();
    return msg;
};

// since: 'all' | a message id | a duration with unit ('30s','10m','2h','1d').
// Returns the matching cached messages (oldest→newest). An unknown id yields
// the whole retained window (ntfy's "give me what you have" behaviour).
NotifyRing.prototype.since = function (topic, since, now) {
    if (now === undefined) now = Date.now();
    var entry = this._topics.get(topic);
    if (!entry) return [];
    this._prune(entry, now);
    var all = entry.msgs;
    var pick = function (r) { return r.msg; };

    if (since === undefined || since === null || since === '') return [];
    if (since === 'all') return all.map(pick);

    var durMatch = /^(\d+)([smhd])$/.exec(String(since));
    if (durMatch) {
        var mult = { s: 1000, m: 60000, h: 3600000, d: 86400000 }[durMatch[2]];
        var cutoff = now - parseInt(durMatch[1], 10) * mult;
        return all.filter(function (r) { return r.at >= cutoff; }).map(pick);
    }

    // otherwise treat as a message id → everything strictly after it
    for (var i = 0; i < all.length; i++)
        if (all[i].msg.id === since)
            return all.slice(i + 1).map(pick);
    return all.map(pick); // unknown id → the whole window
};

NotifyRing.prototype.topicCount = function () { return this._topics.size; };

module.exports = {
    TOPIC_RE: TOPIC_RE,
    isValidTopic: isValidTopic,
    parsePriority: parsePriority,
    parseTags: parseTags,
    parsePush: parsePush,
    validateActions: validateActions,
    MAX_ACTIONS: MAX_ACTIONS,
    buildMessage: buildMessage,
    NotifyRing: NotifyRing
};
