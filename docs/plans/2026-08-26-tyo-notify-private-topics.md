# TYO Notify private topics — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add opt-in, per-topic access control to TYO Notify: a device
(Android now, iOS later) claims a topic by binding an ECDSA-P256 keypair to
it; reads (json/raw/register/unregister/SSE) require proof of possession of
that key; publish requires a bearer token issued at claim time. Unclaimed
topics are completely unaffected — still fully public, exactly as today.

**Architecture:** Two new small modules (`lib/notify-store.js` for durable
claim persistence, `lib/notify-auth.js` for the crypto/validation helpers),
wired into the existing `/notify` HTTP surface in `lib/server.js`. No changes
to `lib/notify.js`'s message ring, no changes to `Push.TokenRegistry` (push
tokens for delivery stay exactly where they are today, in-memory).

**Tech Stack:** Node.js, `node:sqlite` (`DatabaseSync`), `crypto` (ECDSA
P-256 sign/verify), the repo's minimal test runner (`tests/runner.js` +
`tests/helpers.js`).

**Spec:** `docs/specs/2026-08-26-tyo-notify-private-topics-design.md`

---

## Key facts about the existing code (read before starting)

All line numbers are in `lib/server.js` at the time of writing; treat them as
anchors, not guarantees.

- `handleNotifyRequest(req, res)` (~line 4113) claims `/notify` and
  `/notify/{topic}` for GET (dispatches to `handleNotifySubscribe`), and for
  POST/PUT (publish, or dispatches to `handleNotifyRegister` when
  `subPath === 'register'|'unregister'`). Both new routes (`claim`,
  `sse-ticket`) are added as more `subPath` branches alongside those, ~line
  4164.
- `handleNotifyRegister(req, res, cfg, topic, action, ip)` (~line 4454) —
  parses a JSON body via `readRawBody(req, NOTIFY_MAX_BODY, cb)`, validates
  `{transport, token, app_id?, env?, min_priority?}`, then calls
  `notifyRegistry.register(cfg.realm, topic, ep)` /
  `.unregister(cfg.realm, topic, ep)`. This is the shape the new `claim`
  handler reuses for its own push-registration half.
- `handleNotifySubscribe(req, res, url, cfg, topic, format, ip)` (~line 4373)
  serves `json`/`sse`/`raw`. The `sse` case (`format === 'sse'`) is the only
  one that opens a long-lived stream; `json`/`raw` with `?poll=1` (or
  without) still complete as a single response.
- `getNotifyConfig()` (~line 1366) — returns `null` when Notify is disabled
  (off by default), else `{enabled, realm, allowedTransports}`.
- `notifyRing` (`Notify.NotifyRing`, ~line 1391), `notifyRegistry`
  (`Push.TokenRegistry`, ~line 3052), `notifyRateOk` (~line 1407),
  `isUnsafePubKey` (~line 1422), `sendJson` (~line 1439), `readRawBody`
  (~line 1550), `requestIp` (~line 119) — all existing helpers this plan
  reuses as-is.
- `tyo-mq-protocol`'s `adminSignature.stableStringify` /
  `signatureBase(action, body, timestamp, nonce)` (already imported into
  `server.js` as `adminSignature`, `/data/tyolab/node/tyo-mq-protocol/admin-signature.js`)
  is reused for building the string every signature covers — only the final
  primitive differs (ECDSA-verify vs HMAC).
- The existing SSE ticket precedent: `POST /sub-ticket/:realm` →
  `issueSseTicket(realm)` → `sseTickets` Map (~line 3641,
  `SSE_TICKET_TTL_MS = 60000`, ~line 3646) → `consumeSseTicket(ticket)`
  (~line 3688). This plan does **not** reuse that exact Map (it's
  realm-scoped, for a different surface) — it adds a parallel, topic-scoped
  ticket store in the notify section, same shape (single-use, 60s TTL,
  swept).
- Test conventions: `tests/notify.test.js` (integration, boots a real server
  via `startServer()` from `tests/helpers.js`, makes raw HTTP calls with the
  local `httpRequest()` helper at the top of that file), `tests/notify-unit.test.js`
  (pure `lib/notify.js` functions, no server). `node tests/<file>.test.js`
  runs a file directly; `test()`/`run()` come from `tests/runner.js`.

**Signing convention used throughout this plan** (fixes a cross-topic replay
gap: two topics claimed by the same device would otherwise validate each
other's proofs, since verification only checks "does this signature match
this pubkey", not which topic it was intended for):

- Every signed action's body **always includes `{topic: <the URL topic>}`**,
  merged with any operation-specific fields.
- Action names: `'claim'`, `'register'`, `'unregister'`, `'json'`, `'raw'`,
  `'sse-ticket'`.
- A proof is `{timestamp, nonce, signature}` — `timestamp`/`nonce` are
  **client-generated** (no server-issued challenge), freshness window 60s,
  `signature = base64(ECDSA-P256-sign(sha256, adminSignature.signatureBase(action, body, timestamp, nonce)))`.

---

## Task 1: `lib/notify-auth.js` — crypto + validation helpers

**Files:**
- Create: `lib/notify-auth.js`
- Test: `tests/notify-auth-unit.test.js`

- [ ] **Step 1: Write the failing tests**

```js
// tests/notify-auth-unit.test.js
/**
 * TYO Notify private topics — unit tests for lib/notify-auth.js.
 * Pure functions, no server. Usage: node tests/notify-auth-unit.test.js
 */

'use strict';

const assert = require('assert');
const crypto = require('crypto');
const { test, run } = require('./runner');
const A = require('../lib/notify-auth');

function genKeyPair() {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const pubkey = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
    return { pubkey, privateKey };
}

function signProof(privateKey, action, body, timestamp, nonce) {
    const adminSignature = require('tyo-mq-protocol').adminSignature;
    const base = adminSignature.signatureBase(action, body, timestamp, nonce);
    const signature = crypto.sign('sha256', Buffer.from(base), privateKey).toString('base64');
    return { timestamp: timestamp, nonce: nonce, signature: signature };
}

test('isReservedTopic rejects _ and system: prefixes, allows everything else', () => {
    assert.ok(A.isReservedTopic('_internal'));
    assert.ok(A.isReservedTopic('system:takedown'));
    assert.ok(!A.isReservedTopic('contact-tyo'));
    assert.ok(!A.isReservedTopic('alerts'));
});

test('verifyProof accepts a valid, fresh, correctly-bound signature', () => {
    const { pubkey, privateKey } = genKeyPair();
    const now = Date.now();
    const body = { topic: 'contact-tyo' };
    const proof = signProof(privateKey, 'json', body, now, 'nonce-1');
    assert.ok(A.verifyProof(pubkey, 'json', body, proof));
});

test('verifyProof rejects a signature for a different action', () => {
    const { pubkey, privateKey } = genKeyPair();
    const now = Date.now();
    const body = { topic: 'contact-tyo' };
    const proof = signProof(privateKey, 'json', body, now, 'nonce-1');
    assert.ok(!A.verifyProof(pubkey, 'raw', body, proof));
});

test('verifyProof rejects a signature bound to a different topic', () => {
    const { pubkey, privateKey } = genKeyPair();
    const now = Date.now();
    const proof = signProof(privateKey, 'json', { topic: 'topic-a' }, now, 'nonce-1');
    assert.ok(!A.verifyProof(pubkey, 'json', { topic: 'topic-b' }, proof));
});

test('verifyProof rejects a stale timestamp outside the freshness window', () => {
    const { pubkey, privateKey } = genKeyPair();
    const stale = Date.now() - (A.SIGNATURE_MAX_AGE_MS + 5000);
    const body = { topic: 'contact-tyo' };
    const proof = signProof(privateKey, 'json', body, stale, 'nonce-1');
    assert.ok(!A.verifyProof(pubkey, 'json', body, proof));
});

test('verifyProof rejects a signature from the wrong key', () => {
    const { privateKey } = genKeyPair();
    const other = genKeyPair();
    const now = Date.now();
    const body = { topic: 'contact-tyo' };
    const proof = signProof(privateKey, 'json', body, now, 'nonce-1');
    assert.ok(!A.verifyProof(other.pubkey, 'json', body, proof));
});

test('verifyProof rejects malformed pubkey/signature without throwing', () => {
    const now = Date.now();
    assert.ok(!A.verifyProof('not-a-key', 'json', { topic: 't' }, { timestamp: now, nonce: 'n', signature: 'x' }));
});

test('NonceSeen accepts a nonce once, rejects replay, allows a different nonce', () => {
    const seen = new A.NonceSeen();
    const now = Date.now();
    assert.ok(seen.checkAndRecord('topic-a', 'n1', now));
    assert.ok(!seen.checkAndRecord('topic-a', 'n1', now), 'replay must be rejected');
    assert.ok(seen.checkAndRecord('topic-a', 'n2', now), 'a different nonce is fine');
    assert.ok(seen.checkAndRecord('topic-b', 'n1', now), 'same nonce, different topic, is fine');
});

test('generatePublishToken/hashPublishToken/publishTokenMatches round-trip', () => {
    const token = A.generatePublishToken();
    assert.strictEqual(token.length, 64, '256-bit token, hex-encoded');
    const hash = A.hashPublishToken(token);
    assert.ok(A.publishTokenMatches(token, hash));
    assert.ok(!A.publishTokenMatches('wrong-token', hash));
});

test('pubkeyFingerprint is stable and differs across keys', () => {
    const a = genKeyPair();
    const b = genKeyPair();
    assert.strictEqual(A.pubkeyFingerprint(a.pubkey), A.pubkeyFingerprint(a.pubkey));
    assert.notStrictEqual(A.pubkeyFingerprint(a.pubkey), A.pubkeyFingerprint(b.pubkey));
});

run();
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node tests/notify-auth-unit.test.js`
Expected: fails with `Cannot find module '../lib/notify-auth'`.

- [ ] **Step 3: Write the implementation**

```js
// lib/notify-auth.js
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
        var base = adminSignature.signatureBase(action, body || {}, timestamp, proof.nonce);
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
    this._seen = new Map(); // "topic nonce" -> expiresAt
}

NonceSeen.prototype._sweep = function (now) {
    if (this._seen.size < 5000) return;
    var seen = this._seen;
    seen.forEach(function (exp, key) { if (exp < now) seen.delete(key); });
};

NonceSeen.prototype.checkAndRecord = function (topic, nonce, now) {
    now = now || Date.now();
    this._sweep(now);
    var key = String(topic) + ' ' + String(nonce);
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
    importPubkey: importPubkey,
    pubkeyFingerprint: pubkeyFingerprint,
    verifyProof: verifyProof,
    NonceSeen: NonceSeen,
    generatePublishToken: generatePublishToken,
    hashPublishToken: hashPublishToken,
    publishTokenMatches: publishTokenMatches,
    SIGNATURE_MAX_AGE_MS: SIGNATURE_MAX_AGE_MS
};
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node tests/notify-auth-unit.test.js`
Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add lib/notify-auth.js tests/notify-auth-unit.test.js
git commit -m "feat(notify): add crypto/validation helpers for private topics"
```

---

## Task 2: `lib/notify-store.js` — durable claim persistence

**Files:**
- Create: `lib/notify-store.js`
- Test: `tests/notify-store.test.js`

- [ ] **Step 1: Write the failing tests**

```js
// tests/notify-store.test.js
/**
 * TYO Notify private topics — SQLite claim store (lib/notify-store.js).
 * Usage: node tests/notify-store.test.js
 */

'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { test, run } = require('./runner');
const NotifyStore = require('../lib/notify-store');

function tmpFile() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tyo-mq-notify-store-'));
    return path.join(dir, 'notify.sqlite');
}

test('claim() creates a row and getClaim() returns it', () => {
    const store = new NotifyStore({ filename: tmpFile() });
    try {
        const row = store.claim('contact-tyo', {
            pubkey: 'pk-a', pubkey_fingerprint: 'fp-a',
            publish_token_hash: 'hash-a', created_at: 1000
        });
        assert.ok(row);
        assert.strictEqual(row.topic, 'contact-tyo');
        assert.strictEqual(row.pubkey, 'pk-a');

        const fetched = store.getClaim('contact-tyo');
        assert.strictEqual(fetched.pubkey_fingerprint, 'fp-a');
    } finally {
        store.close();
    }
});

test('getClaim() returns null for an unclaimed topic', () => {
    const store = new NotifyStore({ filename: tmpFile() });
    try {
        assert.strictEqual(store.getClaim('never-claimed'), null);
    } finally {
        store.close();
    }
});

test('claim() is first-claim-wins: a second claim on the same topic is rejected', () => {
    const store = new NotifyStore({ filename: tmpFile() });
    try {
        const first = store.claim('contact-tyo', {
            pubkey: 'pk-a', pubkey_fingerprint: 'fp-a',
            publish_token_hash: 'hash-a', created_at: 1000
        });
        assert.ok(first);

        const second = store.claim('contact-tyo', {
            pubkey: 'pk-b', pubkey_fingerprint: 'fp-b',
            publish_token_hash: 'hash-b', created_at: 2000
        });
        assert.strictEqual(second, null, 'second claim on an already-claimed topic must fail');

        // The original claim must be unchanged.
        assert.strictEqual(store.getClaim('contact-tyo').pubkey, 'pk-a');
    } finally {
        store.close();
    }
});

test('claims survive a reopen of the same file (durability)', () => {
    const file = tmpFile();
    const first = new NotifyStore({ filename: file });
    first.claim('contact-tyo', {
        pubkey: 'pk-a', pubkey_fingerprint: 'fp-a',
        publish_token_hash: 'hash-a', created_at: 1000
    });
    first.close();

    const second = new NotifyStore({ filename: file });
    try {
        const row = second.getClaim('contact-tyo');
        assert.ok(row, 'claim must survive reopening the store file');
        assert.strictEqual(row.pubkey, 'pk-a');
    } finally {
        second.close();
    }
});

run();
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node tests/notify-store.test.js`
Expected: fails with `Cannot find module '../lib/notify-store'`.

- [ ] **Step 3: Write the implementation**

```js
// lib/notify-store.js
/**
 * @file notify-store.js
 *
 * SQLite-backed store for TYO Notify's private-topic claims: which pubkey
 * owns which topic, and that topic's hashed publish token. Durable across
 * broker restarts (unlike the notify message ring or push-token registry,
 * both deliberately in-memory — see
 * docs/specs/2026-08-26-tyo-notify-private-topics-design.md §6).
 *
 * A separate, dedicated store from lib/auth-store.js: auth-store is built
 * around diffing an in-memory settings.auth object (admin-configured
 * realms/tokens); claims are server-generated records from a single atomic
 * claim event, which doesn't fit that diff-sync shape.
 */

'use strict';

let DatabaseSync;
try {
    DatabaseSync = require('node:sqlite').DatabaseSync;
}
catch (err) {
    DatabaseSync = null;
}

function NotifyStore(options) {
    options = options || {};
    if (!DatabaseSync)
        throw new Error('The SQLite notify store requires a Node.js runtime with node:sqlite support (Node 22+)');

    this.filename = options.filename || options.file || options.path || 'tyo-mq.notify.sqlite';
    this.db = new DatabaseSync(this.filename);
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec(
        'CREATE TABLE IF NOT EXISTS notify_claims (' +
        'topic TEXT PRIMARY KEY,' +
        'pubkey TEXT NOT NULL,' +
        'pubkey_fingerprint TEXT NOT NULL,' +
        'publish_token_hash TEXT NOT NULL,' +
        'created_at INTEGER NOT NULL' +
        ')'
    );
}

NotifyStore.prototype.getClaim = function (topic) {
    var row = this.db.prepare(
        'SELECT topic, pubkey, pubkey_fingerprint, publish_token_hash, created_at FROM notify_claims WHERE topic = ?'
    ).get(topic);
    return row || null;
};

// Atomic first-claim-wins insert (INSERT OR IGNORE avoids a read-then-write
// race between two concurrent claim attempts on the same topic). Returns the
// stored row on success, or null if the topic was already claimed.
NotifyStore.prototype.claim = function (topic, entry) {
    var stmt = this.db.prepare(
        'INSERT OR IGNORE INTO notify_claims (topic, pubkey, pubkey_fingerprint, publish_token_hash, created_at) VALUES (?, ?, ?, ?, ?)'
    );
    var result = stmt.run(topic, entry.pubkey, entry.pubkey_fingerprint, entry.publish_token_hash, entry.created_at);
    if (!result.changes)
        return null;
    return this.getClaim(topic);
};

NotifyStore.prototype.close = function () {
    this.db.close();
};

NotifyStore.isSupported = function () {
    return !!DatabaseSync;
};

module.exports = NotifyStore;
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node tests/notify-store.test.js`
Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add lib/notify-store.js tests/notify-store.test.js
git commit -m "feat(notify): add durable claim store for private topics"
```

---

## Task 3: Wire `claim` + reserved-namespace rejection into `lib/server.js`

**Files:**
- Modify: `lib/server.js`
- Test: `tests/notify-claim.test.js` (new)

- [ ] **Step 1: Write the failing tests**

```js
// tests/notify-claim.test.js
/**
 * TYO Notify private topics — POST /notify/{topic}/claim.
 * Usage: node tests/notify-claim.test.js
 */

'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { test, run } = require('./runner');
const { startServer, delay } = require('./helpers');
const adminSignature = require('tyo-mq-protocol').adminSignature;
const http = require('http');

function httpRequest(port, method, pathname, opts) {
    opts = opts || {};
    return new Promise((resolve) => {
        const payload = opts.body === undefined ? '' : JSON.stringify(opts.body);
        const headers = Object.assign({ 'content-type': 'application/json' }, opts.headers || {});
        headers['content-length'] = Buffer.byteLength(payload);
        const req = http.request({ host: '127.0.0.1', port, path: pathname, method, headers, timeout: 3000 }, (res) => {
            let data = '';
            res.setEncoding('utf8');
            res.on('data', (c) => { data += c; });
            res.on('end', () => {
                let json = null;
                try { json = data ? JSON.parse(data) : null; } catch (e) { /* leave null */ }
                resolve({ status: res.statusCode, json });
            });
        });
        req.on('timeout', () => { req.destroy(); resolve({ status: null, json: null }); });
        req.on('error', () => resolve({ status: null, json: null }));
        req.end(payload);
    });
}

function genKeyPair() {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    return { pubkey: publicKey.export({ type: 'spki', format: 'der' }).toString('base64'), privateKey };
}

function claimBody(privateKey, topic, extra) {
    const now = Date.now();
    const nonce = crypto.randomBytes(8).toString('hex');
    const body = Object.assign({ topic: topic }, extra);
    const base = adminSignature.signatureBase('claim', body, now, nonce);
    const signature = crypto.sign('sha256', Buffer.from(base), privateKey).toString('base64');
    return Object.assign({}, body, { timestamp: now, nonce: nonce, signature: signature });
}

function tmpNotifyStoreFile() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tyo-mq-notify-claim-'));
    return path.join(dir, 'notify.sqlite');
}

test('claiming an already-reserved topic name is rejected', async () => {
    const server = await startServer({ notify: { enabled: true }, notify_store: { filename: tmpNotifyStoreFile() } });
    try {
        const { pubkey, privateKey } = genKeyPair();
        const res = await httpRequest(server.port, 'POST', '/notify/_internal/claim', {
            body: claimBody(privateKey, '_internal', { pubkey, transport: 'null', token: 'dev-token' })
        });
        assert.strictEqual(res.status, 400, JSON.stringify(res));
    } finally {
        await server.close();
    }
});

test('a valid claim returns a publish token and binds the topic', async () => {
    const server = await startServer({ notify: { enabled: true }, notify_store: { filename: tmpNotifyStoreFile() } });
    try {
        const { pubkey, privateKey } = genKeyPair();
        const res = await httpRequest(server.port, 'POST', '/notify/contact-tyo/claim', {
            body: claimBody(privateKey, 'contact-tyo', { pubkey, transport: 'null', token: 'dev-token' })
        });
        assert.strictEqual(res.status, 200, JSON.stringify(res));
        assert.ok(res.json.publish_token, 'response carries a publish token');
        assert.strictEqual(res.json.publish_token.length, 64);
    } finally {
        await server.close();
    }
});

test('claiming an already-claimed topic is rejected (first-claim-wins)', async () => {
    const server = await startServer({ notify: { enabled: true }, notify_store: { filename: tmpNotifyStoreFile() } });
    try {
        const a = genKeyPair();
        const first = await httpRequest(server.port, 'POST', '/notify/contact-tyo/claim', {
            body: claimBody(a.privateKey, 'contact-tyo', { pubkey: a.pubkey, transport: 'null', token: 'dev-token' })
        });
        assert.strictEqual(first.status, 200);

        const b = genKeyPair();
        const second = await httpRequest(server.port, 'POST', '/notify/contact-tyo/claim', {
            body: claimBody(b.privateKey, 'contact-tyo', { pubkey: b.pubkey, transport: 'null', token: 'dev-token-2' })
        });
        assert.strictEqual(second.status, 409, JSON.stringify(second));
    } finally {
        await server.close();
    }
});

test('a claim with an invalid signature is rejected', async () => {
    const server = await startServer({ notify: { enabled: true }, notify_store: { filename: tmpNotifyStoreFile() } });
    try {
        const { pubkey, privateKey } = genKeyPair();
        const body = claimBody(privateKey, 'contact-tyo', { pubkey, transport: 'null', token: 'dev-token' });
        body.signature = 'tampered' + body.signature.slice(8);
        const res = await httpRequest(server.port, 'POST', '/notify/contact-tyo/claim', { body });
        assert.strictEqual(res.status, 401, JSON.stringify(res));
    } finally {
        await server.close();
    }
});

run();
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node tests/notify-claim.test.js`
Expected: fails — `/notify/{topic}/claim` doesn't exist yet (404s, so `status` assertions fail).

- [ ] **Step 3: Wire the requires and lazy store accessor**

In `lib/server.js`, alongside the other `lib/` requires (~line 20-29), add:

```js
var NotifyStore = require('./notify-store');
var NotifyAuth = require('./notify-auth');
```

Near the existing `notifyRing`/`notifyRegistry` setup (search for
`var notifyRing = new Notify.NotifyRing`), add a **lazy** accessor — unlike
`notifyRing` (always constructed), the store touches disk on construction, so
it must not be created when Notify is disabled:

```js
var notifyStore = null;
var getNotifyStore = function () {
    if (notifyStore) return notifyStore;
    if (!NotifyStore.isSupported()) return null;
    var cfg = server.options.notify_store || server.settings.get('notify_store') || {};
    notifyStore = new NotifyStore({filename: cfg.filename || 'tyo-mq.notify.sqlite'});
    return notifyStore;
};
var notifyNonceSeen = new NotifyAuth.NonceSeen();
```

- [ ] **Step 4: Add the `claim` route and handler**

In `handleNotifyRequest`, find the existing dispatch:
```js
if (subPath === 'register' || subPath === 'unregister')
    return handleNotifyRegister(req, res, cfg, topicFromPath, subPath, ip);
```
Add immediately above it:
```js
if (subPath === 'claim')
    return handleNotifyClaim(req, res, cfg, topicFromPath, ip);
```

Add the handler function near `handleNotifyRegister`:

```js
// ── TYO Notify — private-topic claim ────────────────────────────────────────
// POST /notify/{topic}/claim
//   {pubkey, transport, token, app_id?, env?, timestamp, nonce, signature}
// First-claim-wins: binds the topic to `pubkey` (proven by a self-signed
// proof under that same key — see docs/specs/2026-08-26-tyo-notify-private-topics-design.md
// §3), generates a publish token (returned once, stored hashed), and
// performs the initial push registration under the SAME code path
// handleNotifyRegister uses. Returns true always.
function handleNotifyClaim (req, res, cfg, topic, ip) {
    if (!Notify.isValidTopic(topic) || isUnsafePubKey(topic)) {
        sendJson(res, 400, {ok: false, code: 400, message: 'invalid or missing topic'});
        return true;
    }
    if (NotifyAuth.isReservedTopic(topic)) {
        sendJson(res, 400, {ok: false, code: 400, message: 'topic name is reserved'});
        return true;
    }
    var store = getNotifyStore();
    if (!store) {
        sendJson(res, 503, {ok: false, code: 503, message: 'private topics are not available on this broker'});
        return true;
    }
    if (!notifyRateOk('reg', ip)) {
        incMetric('tyo_mq_rate_limited_total', {reason: 'notify_claim'});
        sendJson(res, 429, {ok: false, code: 429, message: 'rate limit reached', retry_after: 1});
        return true;
    }

    readRawBody(req, NOTIFY_MAX_BODY, function (bodyErr, bodyBuf, tooLarge) {
        if (tooLarge) { sendJson(res, 413, {ok: false, code: 413, message: 'payload too large'}); return; }
        if (bodyErr) { sendJson(res, 400, {ok: false, code: 400, message: 'error reading request body'}); return; }

        var body = null;
        try { body = bodyBuf ? JSON.parse(bodyBuf.toString('utf8')) : null; } catch (e) { body = null; }
        if (!body || typeof body !== 'object') {
            sendJson(res, 400, {ok: false, code: 400, message: 'JSON body required'});
            return;
        }
        var pubkey = body.pubkey;
        var transport = body.transport;
        var token = body.token;
        if (typeof pubkey !== 'string' || !pubkey || typeof transport !== 'string' || !token) {
            sendJson(res, 400, {ok: false, code: 400, message: 'pubkey, transport and token are required'});
            return;
        }
        if (cfg.allowedTransports.indexOf(transport) === -1) {
            sendJson(res, 403, {ok: false, code: 403, message: 'transport not allowed on this surface'});
            return;
        }

        var signedBody = {topic: topic, pubkey: pubkey, transport: transport, token: token, app_id: body.app_id, env: body.env};
        if (!NotifyAuth.verifyProof(pubkey, 'claim', signedBody, body)) {
            sendJson(res, 401, {ok: false, code: 401, message: 'invalid or stale signature'});
            return;
        }

        var publishToken = NotifyAuth.generatePublishToken();
        var claimed = store.claim(topic, {
            pubkey: pubkey,
            pubkey_fingerprint: NotifyAuth.pubkeyFingerprint(pubkey),
            publish_token_hash: NotifyAuth.hashPublishToken(publishToken),
            created_at: Date.now()
        });
        if (!claimed) {
            sendJson(res, 409, {ok: false, code: 409, message: 'topic is already claimed'});
            return;
        }

        // Initial push registration — same registry, same shape as
        // handleNotifyRegister's own `ep`.
        notifyRegistry.register(cfg.realm, topic, {transport: transport, token: token, app_id: body.app_id, env: body.env});
        incMetric('tyo_mq_notify_claimed_total', {});
        sendJson(res, 200, {ok: true, topic: topic, publish_token: publishToken});
    });
    return true;
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `node tests/notify-claim.test.js`
Expected: all tests pass.

- [ ] **Step 6: Commit**

```bash
git add lib/server.js tests/notify-claim.test.js
git commit -m "feat(notify): wire POST /notify/{topic}/claim into the broker"
```

---

## Task 4: Gate publish with the bearer publish token

**Files:**
- Modify: `lib/server.js`
- Test: `tests/notify-claim.test.js` (append)

- [ ] **Step 1: Append failing tests**

```js
// append to tests/notify-claim.test.js, before run():

test('publish to a claimed topic without a token is rejected', async () => {
    const server = await startServer({ notify: { enabled: true }, notify_store: { filename: tmpNotifyStoreFile() } });
    try {
        const { pubkey, privateKey } = genKeyPair();
        const claim = await httpRequest(server.port, 'POST', '/notify/contact-tyo/claim', {
            body: claimBody(privateKey, 'contact-tyo', { pubkey, transport: 'null', token: 'dev-token' })
        });
        assert.strictEqual(claim.status, 200);

        const pub = await httpRequest(server.port, 'POST', '/notify/contact-tyo', { body: { message: 'hi' } });
        assert.strictEqual(pub.status, 401, JSON.stringify(pub));
    } finally {
        await server.close();
    }
});

test('publish to a claimed topic with the correct bearer token succeeds', async () => {
    const server = await startServer({ notify: { enabled: true }, notify_store: { filename: tmpNotifyStoreFile() } });
    try {
        const { pubkey, privateKey } = genKeyPair();
        const claim = await httpRequest(server.port, 'POST', '/notify/contact-tyo/claim', {
            body: claimBody(privateKey, 'contact-tyo', { pubkey, transport: 'null', token: 'dev-token' })
        });
        const publishToken = claim.json.publish_token;

        const pub = await httpRequest(server.port, 'POST', '/notify/contact-tyo', {
            headers: { authorization: 'Bearer ' + publishToken },
            body: { message: 'hi' }
        });
        assert.strictEqual(pub.status, 200, JSON.stringify(pub));
    } finally {
        await server.close();
    }
});

test('publish to an unclaimed topic still needs no auth (unchanged behaviour)', async () => {
    const server = await startServer({ notify: { enabled: true }, notify_store: { filename: tmpNotifyStoreFile() } });
    try {
        const pub = await httpRequest(server.port, 'POST', '/notify/never-claimed', { body: { message: 'hi' } });
        assert.strictEqual(pub.status, 200, JSON.stringify(pub));
    } finally {
        await server.close();
    }
});
```

- [ ] **Step 2: Run to verify the new tests fail**

Run: `node tests/notify-claim.test.js`
Expected: the first two new tests fail (publish succeeds/fails against the
wrong expectation — no gating exists yet); the "unclaimed" test already
passes (behaviour is unchanged).

- [ ] **Step 3: Add the gate in `handleNotifyRequest`**

In `lib/server.js`, inside `handleNotifyRequest`, immediately before the
existing `readRawBody(req, NOTIFY_MAX_BODY, function (bodyErr, ...) { ... publish ... })`
call for the publish path (the block starting right after the
`notifyRateOk('pub', ip)` check, ~line 4178), add the claim check. The
existing code:

```js
            readRawBody(req, NOTIFY_MAX_BODY, function (bodyErr, bodyBuf, tooLarge) {
```

becomes:

```js
            var claimedTopicForPublish = null;
            if (topicFromPath) {
                var storeForPublish = getNotifyStore();
                claimedTopicForPublish = storeForPublish ? storeForPublish.getClaim(topicFromPath) : null;
                if (claimedTopicForPublish) {
                    var authHeader = req.headers['authorization'] || '';
                    var authMatch = authHeader.match(/^Bearer\s+(.+)$/i);
                    if (!authMatch || !NotifyAuth.publishTokenMatches(authMatch[1], claimedTopicForPublish.publish_token_hash)) {
                        sendJson(res, 401, {ok: false, code: 401, message: 'publish token required for this topic'});
                        return true;
                    }
                }
            }

            readRawBody(req, NOTIFY_MAX_BODY, function (bodyErr, bodyBuf, tooLarge) {
```

Note: the JSON-publish form (`POST /notify` with `{topic, ...}` in the body,
`topicFromPath` falsy) can't be gated before the body is parsed, since the
topic itself is inside the body. That form is a pre-existing, documented
JSON-body convenience path — leave it out of scope for claim-gating in this
task (claimed topics are published to via the path form,
`POST /notify/{topic}`, which is what the claim response and the
contact-form hook both use). Add a one-line comment noting this at the
`claimedTopicForPublish` block: `// Path-form only; JSON-body publish
(topic in the body) is out of scope for v1 — see plan Task 4.`

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node tests/notify-claim.test.js`
Expected: all tests pass, including the pre-existing claim tests from Task 3.

- [ ] **Step 5: Run the full existing notify suite to check for regressions**

Run: `node tests/notify.test.js && node tests/notify-push.test.js`
Expected: all pass unchanged (unclaimed-topic behaviour is untouched).

- [ ] **Step 6: Commit**

```bash
git add lib/server.js tests/notify-claim.test.js
git commit -m "feat(notify): gate publish on claimed topics with a bearer publish token"
```

---

## Task 5: Gate register/unregister/json/raw with self-signed proofs

**Files:**
- Modify: `lib/server.js`
- Test: `tests/notify-claim.test.js` (append)

- [ ] **Step 1: Append failing tests**

```js
// append to tests/notify-claim.test.js, before run():

function signedGetHeaders(privateKey, action, topic) {
    const now = Date.now();
    const nonce = crypto.randomBytes(8).toString('hex');
    const base = adminSignature.signatureBase(action, { topic: topic }, now, nonce);
    const signature = crypto.sign('sha256', Buffer.from(base), privateKey).toString('base64');
    return {
        'x-tyo-notify-timestamp': String(now),
        'x-tyo-notify-nonce': nonce,
        'x-tyo-notify-signature': signature
    };
}

test('reading a claimed topic without a signature is rejected', async () => {
    const server = await startServer({ notify: { enabled: true }, notify_store: { filename: tmpNotifyStoreFile() } });
    try {
        const { pubkey, privateKey } = genKeyPair();
        await httpRequest(server.port, 'POST', '/notify/contact-tyo/claim', {
            body: claimBody(privateKey, 'contact-tyo', { pubkey, transport: 'null', token: 'dev-token' })
        });
        const res = await httpRequest(server.port, 'GET', '/notify/contact-tyo/json?poll=1');
        assert.strictEqual(res.status, 401, JSON.stringify(res));
    } finally {
        await server.close();
    }
});

test('reading a claimed topic with a valid signature succeeds', async () => {
    const server = await startServer({ notify: { enabled: true }, notify_store: { filename: tmpNotifyStoreFile() } });
    try {
        const { pubkey, privateKey } = genKeyPair();
        await httpRequest(server.port, 'POST', '/notify/contact-tyo/claim', {
            body: claimBody(privateKey, 'contact-tyo', { pubkey, transport: 'null', token: 'dev-token' })
        });
        const res = await httpRequest(server.port, 'GET', '/notify/contact-tyo/json?poll=1', {
            headers: signedGetHeaders(privateKey, 'json', 'contact-tyo')
        });
        assert.strictEqual(res.status, 200, JSON.stringify(res));
    } finally {
        await server.close();
    }
});

test('replaying the same signature twice is rejected the second time', async () => {
    const server = await startServer({ notify: { enabled: true }, notify_store: { filename: tmpNotifyStoreFile() } });
    try {
        const { pubkey, privateKey } = genKeyPair();
        await httpRequest(server.port, 'POST', '/notify/contact-tyo/claim', {
            body: claimBody(privateKey, 'contact-tyo', { pubkey, transport: 'null', token: 'dev-token' })
        });
        const headers = signedGetHeaders(privateKey, 'json', 'contact-tyo');
        const first = await httpRequest(server.port, 'GET', '/notify/contact-tyo/json?poll=1', { headers });
        assert.strictEqual(first.status, 200);
        const second = await httpRequest(server.port, 'GET', '/notify/contact-tyo/json?poll=1', { headers });
        assert.strictEqual(second.status, 401, 'replayed signature must be rejected');
    } finally {
        await server.close();
    }
});

test('registering push for a claimed topic requires a valid signature bound to the register body', async () => {
    const server = await startServer({ notify: { enabled: true }, notify_store: { filename: tmpNotifyStoreFile() } });
    try {
        const { pubkey, privateKey } = genKeyPair();
        await httpRequest(server.port, 'POST', '/notify/contact-tyo/claim', {
            body: claimBody(privateKey, 'contact-tyo', { pubkey, transport: 'null', token: 'dev-token' })
        });

        const now = Date.now();
        const nonce = crypto.randomBytes(8).toString('hex');
        const regBody = { topic: 'contact-tyo', transport: 'null', token: 'dev-token-2' };
        const base = adminSignature.signatureBase('register', regBody, now, nonce);
        const signature = crypto.sign('sha256', Buffer.from(base), privateKey).toString('base64');

        const res = await httpRequest(server.port, 'POST', '/notify/contact-tyo/register', {
            headers: {
                'x-tyo-notify-timestamp': String(now),
                'x-tyo-notify-nonce': nonce,
                'x-tyo-notify-signature': signature
            },
            body: { transport: 'null', token: 'dev-token-2' }
        });
        assert.strictEqual(res.status, 200, JSON.stringify(res));
    } finally {
        await server.close();
    }
});

test('register/json on an UNCLAIMED topic still needs no signature (unchanged behaviour)', async () => {
    const server = await startServer({ notify: { enabled: true }, notify_store: { filename: tmpNotifyStoreFile() } });
    try {
        const res = await httpRequest(server.port, 'GET', '/notify/never-claimed/json?poll=1');
        assert.strictEqual(res.status, 200, JSON.stringify(res));
    } finally {
        await server.close();
    }
});
```

- [ ] **Step 2: Run to verify the new tests fail**

Run: `node tests/notify-claim.test.js`
Expected: signed-read tests fail (no gate exists), unclaimed test passes.

- [ ] **Step 3: Add a shared gate helper**

Add near `handleNotifyRegister` in `lib/server.js`:

```js
// Returns true if `topic` is claimed AND the request's proof does not
// verify (caller should reject); false if the topic is unclaimed (no gate)
// or the proof verifies (caller should proceed). `body` must already
// include {topic: topic, ...} per the plan's signing convention.
function notifyProofRejected (req, action, topic, body) {
    var store = getNotifyStore();
    var claim = store ? store.getClaim(topic) : null;
    if (!claim) return false; // unclaimed — no gate, unchanged behaviour
    var proof = {
        timestamp: req.headers['x-tyo-notify-timestamp'],
        nonce: req.headers['x-tyo-notify-nonce'],
        signature: req.headers['x-tyo-notify-signature']
    };
    if (!NotifyAuth.verifyProof(claim.pubkey, action, body, proof))
        return true;
    if (!notifyNonceSeen.checkAndRecord(topic, proof.nonce))
        return true;
    return false;
}
```

- [ ] **Step 4: Gate `handleNotifySubscribe`'s `json`/`raw` formats**

At the top of `handleNotifySubscribe`, after the existing topic-validity
check and before the SSE-count-cap check, add:

```js
            if (format !== 'sse' && notifyProofRejected(req, format, topic, {topic: topic})) {
                sendJson(res, 401, {ok: false, code: 401, message: 'invalid or missing signature for this topic'});
                return true;
            }
```

(SSE is excluded here — it's gated by ticket in Task 6, not a header
signature, since a browser/`EventSource`-style client can't set one on the
initial GET either way and the connection can't be resigned per event.)

- [ ] **Step 5: Gate `handleNotifyRegister`**

Inside `handleNotifyRegister`, after the body is parsed and validated (right
after the existing `transport`/`token` required-fields check, before the
`cfg.allowedTransports` check), add:

```js
                var signedBody = {topic: topic, transport: transport, token: token, app_id: body.app_id, env: body.env};
                if (notifyProofRejected(req, action, topic, signedBody)) {
                    sendJson(res, 401, {ok: false, code: 401, message: 'invalid or missing signature for this topic'});
                    return;
                }
```

(`action` is already the function parameter — `'register'` or
`'unregister'` — matching the signing convention.)

- [ ] **Step 6: Run the tests to verify they pass**

Run: `node tests/notify-claim.test.js`
Expected: all tests pass.

- [ ] **Step 7: Run the full existing notify suite to check for regressions**

Run: `node tests/notify.test.js && node tests/notify-push.test.js`
Expected: all pass unchanged.

- [ ] **Step 8: Commit**

```bash
git add lib/server.js tests/notify-claim.test.js
git commit -m "feat(notify): gate json/raw/register/unregister on claimed topics with self-signed proofs"
```

---

## Task 6: SSE ticket for claimed topics

**Files:**
- Modify: `lib/server.js`
- Test: `tests/notify-claim.test.js` (append)

- [ ] **Step 1: Append failing tests**

```js
// append to tests/notify-claim.test.js, before run():

test('opening an SSE stream on a claimed topic without a ticket is rejected', async () => {
    const server = await startServer({ notify: { enabled: true }, notify_store: { filename: tmpNotifyStoreFile() } });
    try {
        const { pubkey, privateKey } = genKeyPair();
        await httpRequest(server.port, 'POST', '/notify/contact-tyo/claim', {
            body: claimBody(privateKey, 'contact-tyo', { pubkey, transport: 'null', token: 'dev-token' })
        });
        const res = await httpRequest(server.port, 'GET', '/notify/contact-tyo/sse');
        assert.strictEqual(res.status, 401, JSON.stringify(res));
    } finally {
        await server.close();
    }
});

test('sse-ticket issues a ticket that opens the SSE stream', async () => {
    const server = await startServer({ notify: { enabled: true }, notify_store: { filename: tmpNotifyStoreFile() } });
    try {
        const { pubkey, privateKey } = genKeyPair();
        await httpRequest(server.port, 'POST', '/notify/contact-tyo/claim', {
            body: claimBody(privateKey, 'contact-tyo', { pubkey, transport: 'null', token: 'dev-token' })
        });

        const now = Date.now();
        const nonce = crypto.randomBytes(8).toString('hex');
        const base = adminSignature.signatureBase('sse-ticket', { topic: 'contact-tyo' }, now, nonce);
        const signature = crypto.sign('sha256', Buffer.from(base), privateKey).toString('base64');
        const ticketRes = await httpRequest(server.port, 'POST', '/notify/contact-tyo/sse-ticket', {
            body: { timestamp: now, nonce: nonce, signature: signature }
        });
        assert.strictEqual(ticketRes.status, 200, JSON.stringify(ticketRes));
        assert.ok(ticketRes.json.ticket);

        // A poll-mode SSE connect (poll isn't implemented for sse in this repo's
        // handler — use a raw request with a short timeout instead, just to
        // check the ticket is accepted (non-401) and the stream opens.
        const http2 = require('http');
        const opened = await new Promise((resolve) => {
            const req = http2.request({
                host: '127.0.0.1', port: server.port,
                path: '/notify/contact-tyo/sse?ticket=' + ticketRes.json.ticket,
                method: 'GET', timeout: 1000
            }, (res) => { resolve(res.statusCode); res.destroy(); req.destroy(); });
            req.on('timeout', () => { req.destroy(); resolve(null); });
            req.on('error', () => resolve(null));
            req.end();
        });
        assert.strictEqual(opened, 200, 'ticket must open the SSE stream');
    } finally {
        await server.close();
    }
});

test('sse on an UNCLAIMED topic still needs no ticket (unchanged behaviour)', async () => {
    const server = await startServer({ notify: { enabled: true }, notify_store: { filename: tmpNotifyStoreFile() } });
    try {
        const http2 = require('http');
        const opened = await new Promise((resolve) => {
            const req = http2.request({
                host: '127.0.0.1', port: server.port, path: '/notify/never-claimed/sse',
                method: 'GET', timeout: 1000
            }, (res) => { resolve(res.statusCode); res.destroy(); req.destroy(); });
            req.on('timeout', () => { req.destroy(); resolve(null); });
            req.on('error', () => resolve(null));
            req.end();
        });
        assert.strictEqual(opened, 200);
    } finally {
        await server.close();
    }
});
```

- [ ] **Step 2: Run to verify the new tests fail**

Run: `node tests/notify-claim.test.js`
Expected: the `sse-ticket` route 404s, so both new claimed-topic tests fail;
the unclaimed test already passes.

- [ ] **Step 3: Add the notify SSE ticket store**

Near the existing `notifySinks`/`notifyCountByTopic` declarations (~line
4273), add a parallel ticket store, mirroring `sseTickets`/`SSE_TICKET_TTL_MS`
(~line 3641/3646) in shape but scoped to notify topics:

```js
        var notifySseTickets = new Map();          // ticket -> {topic, expires}
        var NOTIFY_SSE_TICKET_TTL_MS = 60000;

        function issueNotifySseTicket (topic) {
            var ticket = crypto.randomBytes(24).toString('hex');
            notifySseTickets.set(ticket, {topic: topic, expires: Date.now() + NOTIFY_SSE_TICKET_TTL_MS});
            return ticket;
        }

        function consumeNotifySseTicket (ticket) {
            if (typeof ticket !== 'string' || !ticket) return null;
            var entry = notifySseTickets.get(ticket);
            notifySseTickets.delete(ticket); // single-use, burned even if later rejected
            if (!entry || entry.expires < Date.now()) return null;
            return entry;
        }

        var notifySseTicketSweep = setInterval(function () {
            var now = Date.now();
            notifySseTickets.forEach(function (entry, ticket) {
                if (entry.expires < now) notifySseTickets.delete(ticket);
            });
        }, NOTIFY_SSE_TICKET_TTL_MS);
        if (notifySseTicketSweep.unref) notifySseTicketSweep.unref();
```

- [ ] **Step 4: Add the `sse-ticket` route and handler**

In `handleNotifyRequest`, alongside the `claim` dispatch added in Task 3, add:

```js
            if (subPath === 'sse-ticket')
                return handleNotifySseTicket(req, res, cfg, topicFromPath, ip);
```

Add the handler near `handleNotifyClaim`:

```js
// POST /notify/{topic}/sse-ticket  {timestamp, nonce, signature}
// Self-signed proof (action='sse-ticket', body={topic}) → single-use, 60s
// ticket for the one case that can't resign per-request: a live SSE stream.
// Only meaningful for a CLAIMED topic — unclaimed topics need no ticket.
function handleNotifySseTicket (req, res, cfg, topic, ip) {
    if (!Notify.isValidTopic(topic) || isUnsafePubKey(topic)) {
        sendJson(res, 400, {ok: false, code: 400, message: 'invalid or missing topic'});
        return true;
    }
    var store = getNotifyStore();
    var claim = store ? store.getClaim(topic) : null;
    if (!claim) {
        sendJson(res, 404, {ok: false, code: 404, message: 'topic is not claimed'});
        return true;
    }
    readRawBody(req, NOTIFY_MAX_BODY, function (bodyErr, bodyBuf, tooLarge) {
        if (tooLarge) { sendJson(res, 413, {ok: false, code: 413, message: 'payload too large'}); return; }
        if (bodyErr) { sendJson(res, 400, {ok: false, code: 400, message: 'error reading request body'}); return; }
        var body = null;
        try { body = bodyBuf ? JSON.parse(bodyBuf.toString('utf8')) : null; } catch (e) { body = null; }
        var proof = body || {};
        if (!NotifyAuth.verifyProof(claim.pubkey, 'sse-ticket', {topic: topic}, proof) ||
            !notifyNonceSeen.checkAndRecord(topic, proof.nonce)) {
            sendJson(res, 401, {ok: false, code: 401, message: 'invalid or stale signature'});
            return;
        }
        var ticket = issueNotifySseTicket(topic);
        sendJson(res, 200, {ok: true, ticket: ticket, expires_in: Math.floor(NOTIFY_SSE_TICKET_TTL_MS / 1000)});
    });
    return true;
}
```

- [ ] **Step 5: Gate the SSE format in `handleNotifySubscribe`**

Replace the Task 5 exclusion comment for SSE with an actual gate. Find the
`format !== 'sse'` block added in Task 5, Step 4, and change it to also
handle the `sse` case:

```js
            if (format !== 'sse' && notifyProofRejected(req, format, topic, {topic: topic})) {
                sendJson(res, 401, {ok: false, code: 401, message: 'invalid or missing signature for this topic'});
                return true;
            }
            if (format === 'sse') {
                var claimForSse = (function () {
                    var store = getNotifyStore();
                    return store ? store.getClaim(topic) : null;
                })();
                if (claimForSse) {
                    var ticketParam = url.searchParams.get('ticket');
                    var ticketEntry = consumeNotifySseTicket(ticketParam);
                    if (!ticketEntry || ticketEntry.topic !== topic) {
                        sendJson(res, 401, {ok: false, code: 401, message: 'valid ticket required for this topic'});
                        return true;
                    }
                }
            }
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `node tests/notify-claim.test.js`
Expected: all tests pass.

- [ ] **Step 7: Run the full existing notify + SSE-related suites for regressions**

Run: `node tests/notify.test.js && node tests/notify-push.test.js && node tests/notify-unit.test.js`
Expected: all pass unchanged.

- [ ] **Step 8: Commit**

```bash
git add lib/server.js tests/notify-claim.test.js
git commit -m "feat(notify): SSE ticket auth for claimed topics"
```

---

## Task 7: End-to-end round-trip test + docs update

**Files:**
- Test: `tests/notify-claim.test.js` (append)
- Modify: `docs/specs/2026-08-26-tyo-notify-private-topics-design.md`

- [ ] **Step 1: Append an end-to-end test covering the full flow**

```js
// append to tests/notify-claim.test.js, before run():

test('end-to-end: claim, gated register, gated read, bearer publish, unauthorized attempts all rejected', async () => {
    const server = await startServer({ notify: { enabled: true }, notify_store: { filename: tmpNotifyStoreFile() } });
    try {
        const { pubkey, privateKey } = genKeyPair();
        const owner = genKeyPair(); // a second, non-owning key for negative checks

        // 1. Claim.
        const claim = await httpRequest(server.port, 'POST', '/notify/contact-tyo/claim', {
            body: claimBody(privateKey, 'contact-tyo', { pubkey, transport: 'null', token: 'dev-token' })
        });
        assert.strictEqual(claim.status, 200);
        const publishToken = claim.json.publish_token;

        // 2. A stranger's key cannot read.
        const strangerRead = await httpRequest(server.port, 'GET', '/notify/contact-tyo/json?poll=1', {
            headers: signedGetHeaders(owner.privateKey, 'json', 'contact-tyo')
        });
        assert.strictEqual(strangerRead.status, 401);

        // 3. The owner can read.
        const ownerRead = await httpRequest(server.port, 'GET', '/notify/contact-tyo/json?poll=1', {
            headers: signedGetHeaders(privateKey, 'json', 'contact-tyo')
        });
        assert.strictEqual(ownerRead.status, 200);

        // 4. Publish without the token fails; with it, succeeds.
        const badPub = await httpRequest(server.port, 'POST', '/notify/contact-tyo', { body: { message: 'hi' } });
        assert.strictEqual(badPub.status, 401);
        const goodPub = await httpRequest(server.port, 'POST', '/notify/contact-tyo', {
            headers: { authorization: 'Bearer ' + publishToken },
            body: { message: 'A visitor submitted your contact form' }
        });
        assert.strictEqual(goodPub.status, 200);

        // 5. A second claim attempt by anyone (including the true owner) fails —
        // claiming is one-shot; rotation means picking a new topic name.
        const reclaim = await httpRequest(server.port, 'POST', '/notify/contact-tyo/claim', {
            body: claimBody(privateKey, 'contact-tyo', { pubkey, transport: 'null', token: 'dev-token' })
        });
        assert.strictEqual(reclaim.status, 409);
    } finally {
        await server.close();
    }
});

run();
```

- [ ] **Step 2: Run the full file**

Run: `node tests/notify-claim.test.js`
Expected: all tests pass.

- [ ] **Step 3: Run the entire test suite for regressions**

Run: `for f in tests/*.test.js; do node "$f" || exit 1; done`
Expected: everything passes.

- [ ] **Step 4: Mark the spec as implemented**

In `docs/specs/2026-08-26-tyo-notify-private-topics-design.md`, change the
header line:
```
- **Status:** Design for review (not yet built)
```
to:
```
- **Status:** Implemented (broker side). Android app + pymailer contact-form
  hook are follow-up work in their own repos — see
  `docs/plans/2026-08-26-tyo-notify-private-topics.md`.
```

- [ ] **Step 5: Commit**

```bash
git add tests/notify-claim.test.js docs/specs/2026-08-26-tyo-notify-private-topics-design.md
git commit -m "test(notify): end-to-end private-topic round trip; mark broker spec implemented"
```

---

## After all tasks

Use **superpowers:finishing-a-development-branch** to wrap up. Two follow-up
plans exist outside this repo, tracked separately (not part of this plan):

1. **TYO Notify Android app** (own repo) — generate an EC P-256 keypair in
   the Android Keystore, call `claim`, sign requests for `json`/`register`
   with `X-Tyo-Notify-*` headers, obtain an `sse-ticket` before opening the
   SSE stream.
2. **pymailer contact-form hook** (own repo) — after a successful
   `template=contactus.html` send, `POST /notify/{claimed-topic}` with
   `Authorization: Bearer <publish_token>` and `mode=wake`.
