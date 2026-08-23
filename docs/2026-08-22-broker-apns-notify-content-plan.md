# Broker APNs Content Push (TYO Notify iOS enablement) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Teach the tyo-mq broker to deliver TYO Notify messages to iOS via APNs as *user-visible alert* pushes (CONTENT mode) while keeping the contentless silent wake (WAKE mode), route APNs by per-`app_id` bundle id, and honour a per-registration minimum-priority filter — so the iOS app (a separate plan) has a real delivery backend.

**Architecture:** Three contained changes to `lib/push.js` + one to `lib/server.js`, each mirroring a pattern already in the codebase (per-`app_id` FCM projects; the existing APNs contentless path). `ApnsTransport.send` becomes payload-aware: a content payload → APNs `alert` frame; a wake/empty payload → the existing `content-available:1` background frame. The APNs bundle id (`apns-topic`) is selected per endpoint by `app_id`, mirroring FCM's `_projectFor`. The Notify register handler persists a `min_priority`, and `deliverNotifyPush` skips endpoints whose minimum exceeds the message priority.

**Tech Stack:** Node.js, the repo's custom test runner (`tests/runner.js`), `http2` mock APNs server (already used by `tests/push-apns.test.js`).

**Scope note:** This is Plan A (broker) of two. The iOS app itself (NotifyCore, push, SwiftUI, release) is a separate plan authored after this lands. Design: `docs/2026-08-22-tyo-notify-ios-design.md` §5.

---

## File structure

- `lib/push.js` — **Modify.** `ApnsTransport` (ctor `topics` map, `_topicFor`, `send`, `_request`), new `buildApnsFrame(payload)`, `createApnsTransportFromEnv` (parse `TYO_MQ_PUSH_APNS_TOPICS`), `TokenRegistry.register` (persist `min_priority`), `deliverNotifyPush` (min-priority skip + accurate `sent`).
- `lib/server.js` — **Modify.** `handleNotifyRegister` — parse and store `body.min_priority` on the endpoint.
- `tests/push-apns-topics.test.js` — **Create.** Per-`app_id` bundle-id routing + env wiring.
- `tests/push-apns-content.test.js` — **Create.** CONTENT alert frame vs WAKE contentless frame.
- `tests/notify-push.test.js` — **Modify.** Add a min-priority delivery-filter case (this file already covers `deliverNotifyPush`).
- `package.json` — **Modify.** Add the two new test files to the `test` script.

Existing invariants to preserve (asserted by `tests/push-apns.test.js`, which must stay green):
- `send({transport:'apns', token})` with **no payload** ⇒ body exactly `{"aps":{"content-available":1}}`, `apns-push-type: background`, `apns-priority: 5`, `apns-expiration: 0`.
- Provider-JWT signing/caching, env routing, 4xx/5xx classification, token-free logging.

---

## Task 1: Per-`app_id` APNs bundle id (`apns-topic` routing)

Mirror FCM's per-`app_id` project routing for APNs: an optional `topics` map (`app_id → bundleId`) selected per send, falling back to the single default `topic`.

**Files:**
- Modify: `lib/push.js` — `ApnsTransport` ctor (~`lib/push.js:909-931`), `send` (~`lib/push.js:1040-1061`), `_request` (~`lib/push.js:993-1009`), `createApnsTransportFromEnv` (~`lib/push.js:1111-1132`)
- Create: `tests/push-apns-topics.test.js`
- Modify: `package.json`

- [ ] **Step 1: Write the failing test**

Create `tests/push-apns-topics.test.js`:

```js
'use strict';
const assert = require('assert');
const crypto = require('crypto');
const http2 = require('http2');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { test, run } = require('./runner');
const push = require('../lib/push');

const EC = crypto.generateKeyPairSync('ec', {
    namedCurve: 'P-256',
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});
const KEY_ID = 'YU4YDV365T';
const TEAM_ID = 'GR4ZBUUW77';
const DEFAULT_TOPIC = 'au.com.tyo.hilia';
const NOTIFY_TOPIC = 'au.com.tyo.notify';

// h2c mock APNs: records apns-topic + path per request.
function startFakeApns() {
    const state = { requests: [] };
    const server = http2.createServer();
    server.on('stream', (stream, headers) => {
        let body = '';
        stream.setEncoding('utf8');
        stream.on('data', (c) => { body += c; });
        stream.on('error', () => {});
        stream.on('end', () => {
            state.requests.push({ path: headers[':path'], topic: headers['apns-topic'], body });
            try { stream.respond({ ':status': 200 }); stream.end(); } catch (e) {}
        });
    });
    return new Promise((resolve) => {
        server.listen(0, '127.0.0.1', () => {
            resolve({
                state,
                authority: 'http://127.0.0.1:' + server.address().port,
                close: () => new Promise((r) => server.close(r)),
            });
        });
    });
}

function makeTransport(fake, extra) {
    return new push.ApnsTransport(Object.assign({
        p8: EC.privateKey, keyId: KEY_ID, teamId: TEAM_ID, topic: DEFAULT_TOPIC,
        productionHost: fake.authority, sandboxHost: fake.authority,
    }, extra || {}));
}

test('send routes each app_id to its own apns-topic, default for the rest', async () => {
    const fake = await startFakeApns();
    try {
        const t = makeTransport(fake, { topics: { notify: NOTIFY_TOPIC } });
        await t.send({ transport: 'apns', app_id: 'notify', token: 'notify-dev-1' });
        await t.send({ transport: 'apns', app_id: 'hilia', token: 'hilia-dev-1' }); // unmapped -> default
        await t.send({ transport: 'apns', token: 'noapp-dev-1' });                   // no app_id -> default
        assert.strictEqual(fake.state.requests.length, 3);
        const byPath = {};
        fake.state.requests.forEach((r) => { byPath[r.path] = r.topic; });
        assert.strictEqual(byPath['/3/device/notify-dev-1'], NOTIFY_TOPIC);
        assert.strictEqual(byPath['/3/device/hilia-dev-1'], DEFAULT_TOPIC);
        assert.strictEqual(byPath['/3/device/noapp-dev-1'], DEFAULT_TOPIC);
    } finally { await fake.close(); }
});

test('a prototype-key app_id ("__proto__") falls through to the default topic', async () => {
    const fake = await startFakeApns();
    try {
        const t = makeTransport(fake, { topics: { notify: NOTIFY_TOPIC } });
        await t.send({ transport: 'apns', app_id: '__proto__', token: 'x' });
        assert.strictEqual(fake.state.requests[0].topic, DEFAULT_TOPIC);
    } finally { await fake.close(); }
});

test('a map-only transport (no default topic) skips an unmapped app_id, sends a mapped one', async () => {
    const fake = await startFakeApns();
    try {
        const t = new push.ApnsTransport({
            p8: EC.privateKey, keyId: KEY_ID, teamId: TEAM_ID,
            topics: { notify: NOTIFY_TOPIC },
            productionHost: fake.authority, sandboxHost: fake.authority,
        });
        const ok = await t.send({ transport: 'apns', app_id: 'notify', token: 'n-1' });
        assert.deepStrictEqual(ok, { ok: true });
        const skip = await t.send({ transport: 'apns', app_id: 'nope', token: 'y' });
        assert.deepStrictEqual(skip, { ok: false }); // NOT gone — retain, do not prune
        assert.strictEqual(fake.state.requests.length, 1);
    } finally { await fake.close(); }
});

test('loadConfig wires the default topic + per-app_id topics from env', () => {
    const file = path.join(os.tmpdir(), 'apns-key-topics-' + process.pid + '.p8');
    fs.writeFileSync(file, EC.privateKey);
    try {
        const cfg = push.loadConfig({
            TYO_MQ_PUSH_TRANSPORT: 'apns',
            TYO_MQ_PUSH_APNS_KEY: file,
            TYO_MQ_PUSH_APNS_KEY_ID: KEY_ID,
            TYO_MQ_PUSH_APNS_TEAM_ID: TEAM_ID,
            TYO_MQ_PUSH_APNS_TOPIC: DEFAULT_TOPIC,
            TYO_MQ_PUSH_APNS_TOPICS: JSON.stringify({ notify: NOTIFY_TOPIC }),
        });
        assert.ok(cfg.transport instanceof push.ApnsTransport);
        assert.strictEqual(cfg.transport._topicFor('notify'), NOTIFY_TOPIC);
        assert.strictEqual(cfg.transport._topicFor('other'), DEFAULT_TOPIC);
    } finally { fs.unlinkSync(file); }
});

test('unparseable TYO_MQ_PUSH_APNS_TOPICS throws at config load', () => {
    const file = path.join(os.tmpdir(), 'apns-key-badtopics-' + process.pid + '.p8');
    fs.writeFileSync(file, EC.privateKey);
    try {
        assert.throws(() => push.loadConfig({
            TYO_MQ_PUSH_TRANSPORT: 'apns',
            TYO_MQ_PUSH_APNS_KEY: file,
            TYO_MQ_PUSH_APNS_KEY_ID: KEY_ID,
            TYO_MQ_PUSH_APNS_TEAM_ID: TEAM_ID,
            TYO_MQ_PUSH_APNS_TOPIC: DEFAULT_TOPIC,
            TYO_MQ_PUSH_APNS_TOPICS: '{not json',
        }), /TYO_MQ_PUSH_APNS_TOPICS/);
    } finally { fs.unlinkSync(file); }
});

run();
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node tests/push-apns-topics.test.js`
Expected: FAIL — `_topicFor` is not a function / apns-topic is always the default (or a throw because `topics`/`TYO_MQ_PUSH_APNS_TOPICS` is unknown).

- [ ] **Step 3: Implement the minimal code**

In `lib/push.js`, `ApnsTransport` ctor — after `this.topic = opts.topic;` (currently `lib/push.js:913`), relax the required-topic check and add the map. Replace the constructor's topic handling so that **either** a default `topic` **or** a non-empty `topics` map satisfies it:

```js
    // A default bundle id (apns-topic) and/or a per-app_id map. At least one is
    // required so every send resolves to some bundle id.
    this.topic = opts.topic || null;
    this.topics = (opts.topics && typeof opts.topics === 'object') ? opts.topics : {};
    if (!this.topic && Object.keys(this.topics).length === 0)
        throw new Error('ApnsTransport requires a topic (default bundle id) or a non-empty topics map');
    this._lastNoTopicWarnMs = 0; // dedicated throttle (do NOT reuse _lastAuthWarnMs)
```

(The `_lastNoTopicWarnMs` field mirrors `FcmTransport`'s dedicated `_lastNoProjectWarnMs` so a no-topic misconfig warning and an APNs-auth warning don't cross-suppress each other.)

Delete the old `if (!opts.topic) throw ...` line (`lib/push.js:897`).

Add a prototype-safe resolver (place it right after the constructor, near `normalizeApnsEnv`):

```js
// Resolve the apns-topic (iOS bundle id) for an endpoint's app_id: the mapped
// bundle id if present (own-property only, prototype-pollution-safe), else the
// default topic (may be null when only a map is configured).
ApnsTransport.prototype._topicFor = function (appId) {
    if (appId != null && Object.prototype.hasOwnProperty.call(this.topics, appId))
        return this.topics[appId];
    return this.topic;
};
```

Thread the resolved topic through `send` and `_request`. In `send` (`lib/push.js:1040`), after computing `env`:

```js
ApnsTransport.prototype.send = function (endpoint) {
    var self = this;
    endpoint = endpoint || {};
    var env = normalizeApnsEnv(endpoint.env, self.defaultEnv);
    var apnsTopic = self._topicFor(endpoint.app_id);
    if (!apnsTopic) {
        // No bundle id for this app_id and no default — retain (do not prune).
        self._warnNoTopic(endpoint.app_id);
        return Promise.resolve({ ok: false });
    }
    var jwt;
    try { jwt = self._getProviderToken(); }
    catch (e) { return Promise.resolve({ ok: false }); }
    return self._request(env, endpoint.token, jwt, apnsTopic)
        .then(function (res) {
            var cls = classifyApnsResponse(res.status, res.body);
            if (cls.auth) {
                if (cls.expired) self._jwt = null;
                self._warnAuth(res.status, cls.reason);
                return { ok: false };
            }
            if (cls.gone) return { ok: false, gone: true };
            return cls.ok ? { ok: true } : { ok: false };
        })
        .catch(function () { return { ok: false }; });
};
```

Change `_request` to take `apnsTopic` and use it for the header (`lib/push.js:993` signature + `lib/push.js:1004`):

```js
ApnsTransport.prototype._request = function (env, token, jwt, apnsTopic) {
```
and
```js
            'apns-topic': apnsTopic,
```

Add the token-free no-topic warn (near `_warnAuth`):

```js
// Token-free warn when no bundle id resolves for an app_id (misconfig). Never
// logs the device token — transport + app_id only.
ApnsTransport.prototype._warnNoTopic = function (appId) {
    var logger = this.logger;
    if (!logger || typeof logger.warn !== 'function') return;
    var now = Date.now();
    if (now - this._lastNoTopicWarnMs < PUSH_FAIL_LOG_WINDOW_MS) return;
    this._lastNoTopicWarnMs = now;
    logger.warn('push wake failed: transport=apns reason=no-topic app_id=' +
        (appId == null ? '(none)' : String(appId)) +
        ' (no apns-topic/bundle id configured — device token NOT pruned)');
};
```

In `createApnsTransportFromEnv` (`lib/push.js:1111`): the four-identifier check must accept a `topics` map instead of a bare `topic`, and parse `TYO_MQ_PUSH_APNS_TOPICS`:

```js
function createApnsTransportFromEnv(env) {
    var keyPath = env.TYO_MQ_PUSH_APNS_KEY;
    var keyId = env.TYO_MQ_PUSH_APNS_KEY_ID;
    var teamId = env.TYO_MQ_PUSH_APNS_TEAM_ID;
    var topic = env.TYO_MQ_PUSH_APNS_TOPIC;
    var defaultEnv = env.TYO_MQ_PUSH_APNS_ENV || APNS_ENV_PRODUCTION;

    var topics = {};
    if (env.TYO_MQ_PUSH_APNS_TOPICS) {
        try { topics = JSON.parse(env.TYO_MQ_PUSH_APNS_TOPICS); }
        catch (e) { throw new Error('TYO_MQ_PUSH_APNS_TOPICS must be JSON {app_id: bundleId}: ' + e.message); }
        if (!topics || typeof topics !== 'object' || Array.isArray(topics))
            throw new Error('TYO_MQ_PUSH_APNS_TOPICS must be a JSON object {app_id: bundleId}');
    }

    var missing = [];
    if (!keyPath) missing.push('TYO_MQ_PUSH_APNS_KEY');
    if (!keyId) missing.push('TYO_MQ_PUSH_APNS_KEY_ID');
    if (!teamId) missing.push('TYO_MQ_PUSH_APNS_TEAM_ID');
    if (!topic && Object.keys(topics).length === 0)
        missing.push('TYO_MQ_PUSH_APNS_TOPIC (or TYO_MQ_PUSH_APNS_TOPICS)');
    if (missing.length)
        throw new Error("push transport 'apns' requires " + missing.join(', ') +
            ' (path to the .p8 key + Key ID / Team ID / bundle id)');
    if (defaultEnv !== APNS_ENV_PRODUCTION && defaultEnv !== APNS_ENV_SANDBOX)
        throw new Error('TYO_MQ_PUSH_APNS_ENV must be "production" or "sandbox": ' + defaultEnv);
    var p8;
    try { p8 = fs.readFileSync(keyPath, 'utf8'); }
    catch (e) { throw new Error('TYO_MQ_PUSH_APNS_KEY unreadable: ' + keyPath + ' (' + e.message + ')'); }
    return new ApnsTransport({ p8: p8, keyId: keyId, teamId: teamId, topic: topic, topics: topics, defaultEnv: defaultEnv });
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node tests/push-apns-topics.test.js && node tests/push-apns.test.js`
Expected: PASS (new routing tests green; the existing contentless/JWT/classification suite still green — the default `topic` path is unchanged).

- [ ] **Step 5: Wire the new file into `npm test` and commit**

In `package.json`, append ` && node tests/push-apns-topics.test.js` to the `test` script (after `node tests/push-apns.test.js`).

```bash
git add lib/push.js tests/push-apns-topics.test.js package.json
git commit -m "feat(push): per-app_id APNs bundle id (apns-topic) routing"
```

---

## Task 2: APNs CONTENT alert frame (WAKE stays contentless)

Make `ApnsTransport.send` payload-aware: a Notify **content** payload → an `alert` push (title/body, `mutable-content:1` for the app's Notification Service Extension); a **wake**/empty payload → the existing silent `content-available:1` background push.

**Files:**
- Modify: `lib/push.js` — new `buildApnsFrame(payload)`; `send` passes the frame; `_request` uses the frame's body/headers
- Create: `tests/push-apns-content.test.js`
- Modify: `package.json`

- [ ] **Step 1: Write the failing test**

Create `tests/push-apns-content.test.js`:

```js
'use strict';
const assert = require('assert');
const crypto = require('crypto');
const http2 = require('http2');
const { test, run } = require('./runner');
const push = require('../lib/push');

const EC = crypto.generateKeyPairSync('ec', {
    namedCurve: 'P-256',
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});
const KEY_ID = 'YU4YDV365T', TEAM_ID = 'GR4ZBUUW77', TOPIC = 'au.com.tyo.notify';

function startFakeApns() {
    const state = { requests: [] };
    const server = http2.createServer();
    server.on('stream', (stream, headers) => {
        let body = '';
        stream.setEncoding('utf8');
        stream.on('data', (c) => { body += c; });
        stream.on('error', () => {});
        stream.on('end', () => {
            state.requests.push({
                path: headers[':path'], topic: headers['apns-topic'],
                pushType: headers['apns-push-type'], priority: headers['apns-priority'], body,
            });
            try { stream.respond({ ':status': 200 }); stream.end(); } catch (e) {}
        });
    });
    return new Promise((resolve) => {
        server.listen(0, '127.0.0.1', () => resolve({
            state, authority: 'http://127.0.0.1:' + server.address().port,
            close: () => new Promise((r) => server.close(r)),
        }));
    });
}
function makeTransport(fake) {
    return new push.ApnsTransport({
        p8: EC.privateKey, keyId: KEY_ID, teamId: TEAM_ID, topic: TOPIC,
        productionHost: fake.authority, sandboxHost: fake.authority,
    });
}

test('a CONTENT payload sends an APNs alert with title + body', async () => {
    const fake = await startFakeApns();
    try {
        const t = makeTransport(fake);
        const payload = push.buildNotifyPayload(
            { topic: 'deploys', id: '42', title: 'Deploy succeeded', message: 'v2.4.1 is live', priority: 4 },
            'content');
        const r = await t.send({ transport: 'apns', token: 'dev-1', payload: payload });
        assert.deepStrictEqual(r, { ok: true });
        const req = fake.state.requests[0];
        assert.strictEqual(req.pushType, 'alert');
        assert.strictEqual(req.priority, '10');
        const b = JSON.parse(req.body);
        assert.strictEqual(b.aps.alert.title, 'Deploy succeeded');
        assert.strictEqual(b.aps.alert.body, 'v2.4.1 is live');
        assert.strictEqual(b.aps.sound, 'default');
        assert.strictEqual(b.aps['mutable-content'], 1);
        // custom keys let the NSE / app record to history without a fetch
        assert.strictEqual(b.topic, 'deploys');
        assert.strictEqual(b.id, '42');
    } finally { await fake.close(); }
});

test('a CONTENT payload with no title falls back to the topic as the alert title', async () => {
    const fake = await startFakeApns();
    try {
        const t = makeTransport(fake);
        const payload = push.buildNotifyPayload({ topic: 'orders', message: 'New order #4821' }, 'content');
        await t.send({ transport: 'apns', token: 'dev-1', payload: payload });
        const b = JSON.parse(fake.state.requests[0].body);
        assert.strictEqual(b.aps.alert.title, 'orders');
        assert.strictEqual(b.aps.alert.body, 'New order #4821');
    } finally { await fake.close(); }
});

test('a WAKE payload stays a contentless silent background push', async () => {
    const fake = await startFakeApns();
    try {
        const t = makeTransport(fake);
        const payload = push.buildNotifyPayload({ topic: 'deploys', id: '42' }, 'wake');
        await t.send({ transport: 'apns', token: 'dev-1', payload: payload });
        const req = fake.state.requests[0];
        assert.strictEqual(req.pushType, 'background');
        assert.strictEqual(req.priority, '5');
        assert.deepStrictEqual(JSON.parse(req.body), { aps: { 'content-available': 1 } });
    } finally { await fake.close(); }
});

run();
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node tests/push-apns-content.test.js`
Expected: FAIL — the first two tests fail because `send` currently always emits the contentless background body regardless of payload (`pushType` is `background`, no `aps.alert`).

- [ ] **Step 3: Implement the minimal code**

In `lib/push.js`, add `buildApnsFrame` (place it just above `ApnsTransport.prototype.send`):

```js
// Build the APNs request frame for a Notify payload. A content payload (has a
// `message`, no `wake` flag) -> a user-visible alert; a wake/empty payload ->
// the contentless silent background push. `mutable-content:1` lets the iOS
// Notification Service Extension record the message to history. The custom
// top-level keys (topic/id/priority) ride alongside `aps` for the app/NSE.
function buildApnsFrame(payload) {
    payload = payload || {};
    var isContent = payload.wake !== '1' && payload.message !== undefined;
    if (!isContent) {
        return {
            body: Buffer.from('{"aps":{"content-available":1}}', 'utf8'),
            pushType: 'background', priority: '5', expiration: '0',
        };
    }
    var obj = {
        aps: {
            alert: {
                title: String(payload.title || payload.topic || ''),
                body: String(payload.message || ''),
            },
            sound: 'default',
            'mutable-content': 1,
        },
    };
    if (payload.topic) obj.topic = String(payload.topic);
    if (payload.id) obj.id = String(payload.id);
    if (payload.priority) obj.priority = String(payload.priority);
    return {
        body: Buffer.from(JSON.stringify(obj), 'utf8'),
        pushType: 'alert', priority: '10', expiration: '0',
    };
}
```

Change `send` to build the frame and pass it (replace the `send` body from Task 1's version — the only change is computing `frame` and passing it to `_request`):

```js
ApnsTransport.prototype.send = function (endpoint) {
    var self = this;
    endpoint = endpoint || {};
    var env = normalizeApnsEnv(endpoint.env, self.defaultEnv);
    var apnsTopic = self._topicFor(endpoint.app_id);
    if (!apnsTopic) { self._warnNoTopic(endpoint.app_id); return Promise.resolve({ ok: false }); }
    var jwt;
    try { jwt = self._getProviderToken(); }
    catch (e) { return Promise.resolve({ ok: false }); }
    var frame = buildApnsFrame(endpoint.payload);
    return self._request(env, endpoint.token, jwt, apnsTopic, frame)
        .then(function (res) {
            var cls = classifyApnsResponse(res.status, res.body);
            if (cls.auth) {
                if (cls.expired) self._jwt = null;
                self._warnAuth(res.status, cls.reason);
                return { ok: false };
            }
            if (cls.gone) return { ok: false, gone: true };
            return cls.ok ? { ok: true } : { ok: false };
        })
        .catch(function () { return { ok: false }; });
};
```

Change `_request` to take and use the `frame` (replace the fixed body + the three fixed headers at `lib/push.js:999-1008`):

```js
ApnsTransport.prototype._request = function (env, token, jwt, apnsTopic, frame) {
    var self = this;
    return new Promise(function (resolve, reject) {
        var session;
        try { session = self._getSession(env); }
        catch (e) { return reject(e); }
        var body = frame.body;
        var headers = {
            ':method': 'POST',
            ':path': '/3/device/' + token,
            'authorization': 'bearer ' + jwt,
            'apns-topic': apnsTopic,
            'apns-push-type': frame.pushType,
            'apns-priority': frame.priority,
            'apns-expiration': frame.expiration,
            'content-length': body.length,
        };
        // ... rest of the function body is unchanged (settled/req/timeout/data/end/error/close) ...
```

Keep the remainder of `_request` (from `var settled = false;` through `try { req.end(body); } ...`) exactly as it is today.

Export `buildApnsFrame` in `module.exports` (next to `buildNotifyPayload`, `lib/push.js:1577`) so tests/other modules can reuse it:

```js
    buildNotifyPayload: buildNotifyPayload,
    buildApnsFrame: buildApnsFrame,
    deliverNotifyPush: deliverNotifyPush,
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node tests/push-apns-content.test.js && node tests/push-apns.test.js && node tests/push-apns-topics.test.js`
Expected: PASS. Note the existing `tests/push-apns.test.js` "contentless background wake" test still passes because it calls `send` with **no** payload → `buildApnsFrame(undefined)` → the contentless frame.

- [ ] **Step 5: Wire the new file into `npm test` and commit**

In `package.json`, append ` && node tests/push-apns-content.test.js` to the `test` script.

```bash
git add lib/push.js tests/push-apns-content.test.js package.json
git commit -m "feat(push): APNs alert push for Notify CONTENT mode (WAKE stays contentless)"
```

---

## Task 3: Server-side per-registration minimum priority

Persist a `min_priority` on the registration and skip a push when the message's priority is below it — so the iOS per-topic minimum-priority filter suppresses CONTENT alerts (an NSE cannot fully drop an alert).

**Files:**
- Modify: `lib/push.js` — `TokenRegistry.register` (persist `min_priority`, `lib/push.js:1309-1324`); `deliverNotifyPush` (skip + accurate `sent`, `lib/push.js:1512-1552`); add `NOTIFY_DEFAULT_PRIORITY` const
- Modify: `lib/server.js` — `handleNotifyRegister` endpoint object (`lib/server.js:4406`)
- Modify: `tests/notify-push.test.js`

- [ ] **Step 1: Write the failing test**

Append to `tests/notify-push.test.js` (before its final `run();`). It uses the same in-process `push` API the file already exercises; adjust the `NullTransport`/registry construction to match the helpers already present in that file if their names differ:

```js
test('deliverNotifyPush skips endpoints whose min_priority exceeds the message priority', async () => {
    const cfg = push.loadConfig({ TYO_MQ_PUSH_TRANSPORT: 'null' });
    const registry = new push.TokenRegistry({});
    // Two devices on the same topic: one wants only priority>=4, one takes all.
    registry.register('notify', 'alerts', { transport: 'null', token: 'high-only', min_priority: 4 });
    registry.register('notify', 'alerts', { transport: 'null', token: 'take-all', min_priority: 1 });

    // A low-priority message (priority 2) reaches only the take-all device.
    const low = await push.deliverNotifyPush(cfg, registry, 'notify', 'alerts',
        { topic: 'alerts', message: 'fyi', priority: 2 }, 'content');
    assert.strictEqual(low.sent, 1);

    // A high-priority message (priority 5) reaches both.
    const high = await push.deliverNotifyPush(cfg, registry, 'notify', 'alerts',
        { topic: 'alerts', message: 'urgent', priority: 5 }, 'content');
    assert.strictEqual(high.sent, 2);

    // A message with no priority defaults to 3 -> reaches take-all, not high-only.
    const dflt = await push.deliverNotifyPush(cfg, registry, 'notify', 'alerts',
        { topic: 'alerts', message: 'noprio' }, 'content');
    assert.strictEqual(dflt.sent, 1);
});

test('TokenRegistry.register persists min_priority (create and update)', () => {
    const registry = new push.TokenRegistry({});
    const created = registry.register('notify', 'alerts', { transport: 'null', token: 't1', min_priority: 4 });
    assert.strictEqual(created.min_priority, 4);
    // A re-register updates it in place.
    const updated = registry.register('notify', 'alerts', { transport: 'null', token: 't1', min_priority: 2 });
    assert.strictEqual(updated.min_priority, 2);
    // Absent min_priority defaults to null (no filtering).
    const nofilter = registry.register('notify', 'alerts', { transport: 'null', token: 't2' });
    assert.strictEqual(nofilter.min_priority, null);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node tests/notify-push.test.js`
Expected: FAIL — `created.min_priority` is `undefined` (not persisted), and `low.sent`/`dflt.sent` are `2` (no filtering yet).

- [ ] **Step 3: Implement the minimal code**

In `lib/push.js`, `TokenRegistry.register` — persist `min_priority` in **both** branches.

Update branch (after `lib/push.js:1312` `if (ep.env !== undefined) result.env = ep.env;`):
```js
        if (ep.min_priority !== undefined) result.min_priority = ep.min_priority;
```
Create branch (add to the object literal at `lib/push.js:1315-1324`, after `env:`):
```js
            // Per-registration minimum priority (Notify): skip pushes below it.
            // null = no filter.
            min_priority: (typeof ep.min_priority === 'number') ? ep.min_priority : null,
```

Add a default-priority constant near `NOTIFY_PUSH_MSG_MAX` (`lib/push.js:1489`):
```js
var NOTIFY_DEFAULT_PRIORITY = 3; // ntfy's default when a publish sets none
```

In `deliverNotifyPush` (`lib/push.js:1527`), replace the `var attempts = endpoints.map(...)` block so it filters and counts real sends:
```js
        var payload = buildNotifyPayload(msg, mode);
        var msgPriority = Number(msg && msg.priority) || NOTIFY_DEFAULT_PRIORITY;
        var sent = 0;
        var attempts = endpoints.map(function (ep) {
            if (typeof ep.min_priority === 'number' && ep.min_priority > 0 && msgPriority < ep.min_priority)
                return Promise.resolve(); // below this device's minimum — skip, do not count
            sent++;
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
            return { sent: sent };
        });
```

In `lib/server.js`, `handleNotifyRegister` — parse and attach `min_priority` (replace the endpoint object at `lib/server.js:4406`):
```js
                var minPriority = parseInt(body.min_priority, 10);
                if (!(minPriority >= 1 && minPriority <= 5)) minPriority = undefined;
                var ep = {transport: transport, token: token, app_id: body.app_id, env: body.env, min_priority: minPriority};
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node tests/notify-push.test.js && node tests/notify.test.js`
Expected: PASS (the new filter cases green; existing Notify delivery tests unaffected because absent `min_priority` ⇒ `null` ⇒ no filtering, and `sent` equals the endpoint count when nothing is filtered).

- [ ] **Step 5: Commit**

```bash
git add lib/push.js lib/server.js tests/notify-push.test.js
git commit -m "feat(notify): server-side per-registration minimum-priority filter"
```

---

## Task 4: Full suite, env documentation, deploy checklist

Prove nothing regressed, document the new env, and record the freemq deploy steps (executed with the user when the APNs key exists).

**Files:**
- Modify: `docs/2026-08-22-tyo-notify-ios-design.md` (append a "Broker env (delivered)" note) — optional but keeps the design current
- Reference only: `deploy-tw.sh`

- [ ] **Step 1: Run the whole test suite**

Run: `npm test`
Expected: PASS — every existing suite plus the two new APNs files and the extended `notify-push.test.js`. If any pre-existing suite fails, STOP and investigate before proceeding (do not "fix" unrelated failures in this plan).

- [ ] **Step 2: Optional real-device APNs smoke (only when the .p8 exists)**

This requires the Apple APNs Auth Key (created in Plan B's Apple-prereqs) and a real device token. Skipped otherwise. With the key in place:

Run: `APNS_REAL_SMOKE=1 node tests/push-apns.test.js`
Expected: the `[real smoke]` case reaches APNs sandbox and classifies a dummy token as `gone` (proves ES256 auth + reachability). This is the existing opt-in smoke; it does not yet exercise CONTENT (a live device token + a watching app does that in Plan B / P2).

- [ ] **Step 3: Document the broker env**

The freemq (operator) Notify APNs config, once the Apple APNs Auth Key exists:
```
TYO_MQ_PUSH_TRANSPORT=fcm,apns          # add apns alongside the existing fcm
TYO_MQ_PUSH_APNS_KEY=/path/AuthKey_XXXXXXXXXX.p8
TYO_MQ_PUSH_APNS_KEY_ID=<Key ID>
TYO_MQ_PUSH_APNS_TEAM_ID=GR4ZBUUW77
TYO_MQ_PUSH_APNS_TOPICS={"notify":"au.com.tyo.notify"}   # per-app_id bundle id
TYO_MQ_PUSH_APNS_ENV=production
```
If freemq already runs `apns` for another app via the single `TYO_MQ_PUSH_APNS_TOPIC`, move that value into `TYO_MQ_PUSH_APNS_TOPICS` under its `app_id` so both apps coexist (that is exactly what Task 1 enables). The iOS client registers with `app_id:"notify"`, so its pushes pick `au.com.tyo.notify`.

- [ ] **Step 4: Commit any doc change**

```bash
git add docs/2026-08-22-tyo-notify-ios-design.md
git commit -m "docs(notify): record broker APNs env for iOS content push"
```

- [ ] **Step 5: Deploy (with the user, when the APNs key is provisioned)**

Deploy the broker to both TW VMs (per the repo's existing release flow / `deploy-tw.sh`), set the env above on the operator/freemq unit, restart, and confirm `apns` is in the loaded transports. This step is gated on the Apple APNs Auth Key (Plan B, Apple prerequisites) and is performed interactively — not part of the automated task run.

---

## Self-review

**Spec coverage (design §5):**
- §5.1 APNs alert payload for CONTENT, contentless for WAKE → Task 2. ✅
- §5.2 per-`app_id` APNs bundle id → Task 1. ✅
- §5.3 server-side minimum priority → Task 3. ✅
- §5.4 tests + deploy to both TW VMs + real-device verify → Task 4 (deploy/real-device gated on the Apple key, called out explicitly). ✅

**Placeholder scan:** No TBD/TODO; every code step shows complete code; commands have expected output. ✅

**Type/signature consistency:** `_request(env, token, jwt, apnsTopic, frame)` — introduced with 4 args in Task 1 (topic) then 5 in Task 2 (frame); Task 2 shows the full final signature and both call sites (`send`) are updated in the same task. `buildApnsFrame(payload)` returns `{ body:Buffer, pushType, priority, expiration }`, consumed by `_request` exactly as produced. `_topicFor(appId)` defined in Task 1, used by `send` in Tasks 1 and 2 identically. `min_priority` is a `number|null` everywhere (registry, deliver filter, server parse). ✅

**Note on task independence:** Tasks 1 and 2 both edit `ApnsTransport.send`/`_request`; they are ordered (1 then 2) and Task 2 restates the full `send`/`_request` so an out-of-order reader still has complete code. Task 3 is independent of 1–2 (registry + deliver + server). Task 4 is verification/deploy.
