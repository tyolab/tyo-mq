# TYO Notify Status Boards — Broker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Status Boards to the tyo-mq broker: compacted topics (latest-per-key) with a watchdog for real up/down, per-watcher publish tokens, board-key ownership, and the `/board` read — plus the `tyo-notify-watch` producer script.

**Architecture:** Extend the existing notify subsystem (`lib/notify-store.js` durable store + the `handleNotifyRequest` dispatcher in `lib/server.js`). Boards are service-managed compacted private topics owned by a broker-held board-key; management + reads are `x-service-token` authorized (the notify-vault pattern). No device-key proofs for boards. Personal topics are untouched.

**Tech Stack:** Node.js (broker, `node:sqlite` via `NotifyStore`), the existing `tests/*.test.js` harness (`tests/runner.js` + `tests/helpers.js` `startServer`), POSIX `sh` for the watcher.

**Design:** `docs/superpowers/specs/2026-09-10-tyo-notify-status-boards-design.md`.

**Ground truth / anchors (local `lib/server.js`, 7461 lines, == deployed `eb7001b`):**
- Dispatch: `handleNotifyRequest` @4239; subPath routing @4275–4290 (`claim`, `sse-ticket`, `register`; subscribe default).
- Publish token gate: `publishAuthRejected` @4310–4318 (checks `claim.publish_token_hash`).
- Publish append: `notifyRing.append(topic, msg)` @4399, after `Notify.buildMessage`.
- Claim: `handleNotifyClaim` @4667 (`generatePublishToken` → `store.claim`).
- SSE ticket: `handleNotifySseTicket` @4763 (device-key proof today).
- Store: `lib/notify-store.js` (`NotifyStore`, `claim`/`getClaim`, WAL sqlite).
- Auth helpers: `lib/notify-auth.js` (`generatePublishToken`/`hashPublishToken`/`publishTokenMatches`, `verifyProof`, `pubkeyFingerprint`).

**Env:** reuse a service token — `NOTIFY_SERVICE_TOKEN` (fall back to `REACH_SERVICE_TOKEN`), matching the notify-vault service-token flow store-backend already ships.

---

## File structure

```
lib/notify-store.js       # + board config, compacted state, publish-token set, watchdog queries
lib/notify-boards.js       # NEW: pure helpers — extractKey/extractTtl/boardKeypair/synthDownMsg
lib/server.js              # + dispatch board/tokens; multi-token auth; compaction hook; watchdog sweep; service-token
bin/tyo-notify-watch.sh    # NEW: the agentless producer (POSIX sh)
tests/notify-boards.test.js        # NEW: store + endpoint e2e
tests/notify-boards-unit.test.js   # NEW: notify-boards.js pure helpers
```

Compaction, the token set, and the watchdog are the novel logic and are TDD'd at
the store + pure-helper level first (cleanly unit-testable like the existing
`notify-store.test.js`), then wired into `server.js` and covered by an e2e test
that boots the real broker via `startServer`.

---

### Task 1: notify-boards.js pure helpers

**Files:**
- Create: `lib/notify-boards.js`
- Test: `tests/notify-boards-unit.test.js`

Pure functions (no storage, no server) so they unit-test on the JVM-equivalent
(plain node): extract the compaction `key` and `ttl` from a message's tags,
generate a board keypair, and build a synthetic watchdog message.

- [ ] **Step 1: Write the failing test**

`tests/notify-boards-unit.test.js`:
```js
const { test } = require('./runner');
const assert = require('assert');
const B = require('../lib/notify-boards');

test('extractField pulls key/ttl from a tags array (key=value csv already split)', () => {
    const tags = ['key=web1', 'metric=disk', 'value=96%', 'ttl=120', 'state=warn'];
    assert.strictEqual(B.extractField(tags, 'key'), 'web1');
    assert.strictEqual(B.extractField(tags, 'ttl'), '120');
    assert.strictEqual(B.extractField(tags, 'nope'), null);
    assert.strictEqual(B.extractField(null, 'key'), null);
});

test('boardKeypair returns matching PKCS8 + SPKI base64 (EC P-256)', () => {
    const kp = B.boardKeypair();
    assert.ok(kp.privateKeyPkcs8B64 && kp.publicKeySpkiB64);
    // fingerprint of the SPKI must be derivable (same algo as notify-auth)
    const fp = require('../lib/notify-auth').pubkeyFingerprint(kp.publicKeySpkiB64);
    assert.strictEqual(fp.length, 64);
});

test('synthDownMessage builds a high-priority watchdog DOWN card for a key', () => {
    const m = B.synthDownMessage('ops', 'web1', 'web1');
    assert.strictEqual(m.topic, 'ops');
    assert.ok(m.tags.includes('key=web1'));
    assert.ok(m.tags.includes('state=crit'));
    assert.ok(m.tags.includes('source=watchdog'));
    assert.strictEqual(m.priority, 5);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node tests/notify-boards-unit.test.js`
Expected: FAIL — `Cannot find module '../lib/notify-boards'`.

- [ ] **Step 3: Implement lib/notify-boards.js**

```js
'use strict';
// Pure helpers for TYO Notify Status Boards (compaction key/ttl extraction,
// board keypair generation, synthetic watchdog messages). No storage/server.
var crypto = require('crypto');

// tags is the already-split array of "key=value" strings (as stored on a msg).
function extractField(tags, name) {
    if (!Array.isArray(tags)) return null;
    var prefix = name + '=';
    for (var i = 0; i < tags.length; i++) {
        if (typeof tags[i] === 'string' && tags[i].indexOf(prefix) === 0)
            return tags[i].slice(prefix.length);
    }
    return null;
}

// A broker-held board key: EC P-256, exported as base64 PKCS8 + SPKI.
function boardKeypair() {
    var kp = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    return {
        privateKeyPkcs8B64: kp.privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64'),
        publicKeySpkiB64: kp.publicKey.export({ type: 'spki', format: 'der' }).toString('base64')
    };
}

// A synthetic watchdog message (DOWN/RECOVERED). state 'crit' for down,
// 'ok' for recovered; source=watchdog so clients can style/filter it.
function synthMessage(topic, key, label, state, text) {
    return {
        topic: topic, message: text, priority: 5,
        tags: ['key=' + key, 'label=' + (label || key), 'state=' + state, 'source=watchdog'],
        event: 'message'
    };
}
function synthDownMessage(topic, key, label) {
    return synthMessage(topic, key, label, 'crit', (label || key) + ' is DOWN — no heartbeat');
}
function synthRecoveredMessage(topic, key, label) {
    return synthMessage(topic, key, label, 'ok', (label || key) + ' RECOVERED');
}

module.exports = { extractField, boardKeypair, synthDownMessage, synthRecoveredMessage };
```

- [ ] **Step 4: Run to verify it passes**

Run: `node tests/notify-boards-unit.test.js`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/notify-boards.js tests/notify-boards-unit.test.js
git -c user.name=eric -c user.email=eric@tyo.com.au commit -m "feat(notify): board helpers — key/ttl extract, board keypair, watchdog msgs"
```

---

### Task 2: notify-store — board config + compacted state + token set

**Files:**
- Modify: `lib/notify-store.js`
- Test: `tests/notify-boards.test.js` (store-level portion)

Add three tables and their methods. Follow the existing `NotifyStore` style
(prepared statements, WAL). All additive — personal claims untouched.

- [ ] **Step 1: Write the failing store test**

`tests/notify-boards.test.js` (store section):
```js
const { test } = require('./runner');
const assert = require('assert');
const fs = require('fs'); const os = require('os'); const path = require('path');
const NotifyStore = require('../lib/notify-store');

function tmp() { return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'nb-')), 'n.sqlite'); }

test('createBoard + getBoard persists name, compact_key, board key, owner', () => {
    const s = new NotifyStore({ filename: tmp() });
    const b = s.createBoard('ops-ab12cd', { name: 'Production Fleet', compact_key: 'key',
        board_privkey: 'PK', board_pubkey: 'SP', owner_uid: 'u1' });
    assert.strictEqual(b.name, 'Production Fleet');
    const got = s.getBoard('ops-ab12cd');
    assert.strictEqual(got.owner_uid, 'u1');
    assert.strictEqual(got.board_pubkey, 'SP');
});

test('upsertBoardState keeps latest-per-key; getBoardState returns the set', () => {
    const s = new NotifyStore({ filename: tmp() });
    s.createBoard('ops', { name: 'o', compact_key: 'key', board_privkey: 'x', board_pubkey: 'y', owner_uid: 'u' });
    s.upsertBoardState('ops', 'web1', { msg: '{"a":1}', state: 'ok', expires_at: 100 });
    s.upsertBoardState('ops', 'web2', { msg: '{"b":2}', state: 'crit', expires_at: 0 });
    s.upsertBoardState('ops', 'web1', { msg: '{"a":9}', state: 'warn', expires_at: 200 }); // replace
    const rows = s.getBoardState('ops');
    assert.strictEqual(rows.length, 2);
    const web1 = rows.find(r => r.key === 'web1');
    assert.strictEqual(web1.msg, '{"a":9}');
    assert.strictEqual(web1.state, 'warn');
});

test('publish token set: add / matches / list / revoke', () => {
    const s = new NotifyStore({ filename: tmp() });
    const A = require('../lib/notify-auth');
    const tok = A.generatePublishToken();
    const id = s.addPublishToken('ops', { token_hash: A.hashPublishToken(tok), label: 'web1' });
    assert.ok(id);
    assert.ok(s.publishTokenMatchesAny('ops', tok));      // matches a set token
    assert.ok(!s.publishTokenMatchesAny('ops', 'nope'));
    assert.strictEqual(s.listPublishTokens('ops').length, 1);
    assert.strictEqual(s.listPublishTokens('ops')[0].label, 'web1'); // no raw token in listing
    s.revokePublishToken('ops', id);
    assert.ok(!s.publishTokenMatchesAny('ops', tok));     // revoked
});

test('dueBoardKeys returns keys past expires_at not already down', () => {
    const s = new NotifyStore({ filename: tmp() });
    s.createBoard('ops', { name:'o', compact_key:'key', board_privkey:'x', board_pubkey:'y', owner_uid:'u' });
    s.upsertBoardState('ops', 'web1', { msg:'{}', state:'ok', expires_at: 50 });
    s.upsertBoardState('ops', 'web2', { msg:'{}', state:'ok', expires_at: 0 }); // no watchdog
    const due = s.dueBoardKeys(100);
    assert.deepStrictEqual(due.map(d => d.key), ['web1']);
    s.setBoardDown('ops', 'web1', 1);
    assert.strictEqual(s.dueBoardKeys(100).length, 0); // already down → not re-fired
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node tests/notify-boards.test.js`
Expected: FAIL — `s.createBoard is not a function`.

- [ ] **Step 3: Implement the store methods**

In `lib/notify-store.js`, add to the constructor's `CREATE TABLE` block:
```js
this.db.exec(
    'CREATE TABLE IF NOT EXISTS notify_board_config (' +
    'topic TEXT PRIMARY KEY, name TEXT, compact_key TEXT NOT NULL DEFAULT \'key\',' +
    'board_privkey TEXT NOT NULL, board_pubkey TEXT NOT NULL, owner_uid TEXT, created_at INTEGER NOT NULL)'
);
this.db.exec(
    'CREATE TABLE IF NOT EXISTS notify_board_state (' +
    'topic TEXT NOT NULL, key TEXT NOT NULL, msg TEXT NOT NULL, state TEXT,' +
    'expires_at INTEGER NOT NULL DEFAULT 0, down INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL,' +
    'PRIMARY KEY (topic, key))'
);
this.db.exec(
    'CREATE TABLE IF NOT EXISTS notify_publish_tokens (' +
    'topic TEXT NOT NULL, token_id TEXT NOT NULL, token_hash TEXT NOT NULL, label TEXT,' +
    'created_at INTEGER NOT NULL, PRIMARY KEY (topic, token_id))'
);
```
Then add the methods (mirroring the existing prepared-statement style):
```js
NotifyStore.prototype.createBoard = function (topic, b) {
    this.db.prepare('INSERT OR REPLACE INTO notify_board_config' +
        '(topic,name,compact_key,board_privkey,board_pubkey,owner_uid,created_at) VALUES (?,?,?,?,?,?,?)')
        .run(topic, b.name || topic, b.compact_key || 'key', b.board_privkey, b.board_pubkey, b.owner_uid || null, Date.now());
    return this.getBoard(topic);
};
NotifyStore.prototype.getBoard = function (topic) {
    return this.db.prepare('SELECT topic,name,compact_key,board_privkey,board_pubkey,owner_uid,created_at ' +
        'FROM notify_board_config WHERE topic = ?').get(topic) || null;
};
NotifyStore.prototype.setBoardName = function (topic, name) {
    this.db.prepare('UPDATE notify_board_config SET name = ? WHERE topic = ?').run(name, topic);
};
NotifyStore.prototype.upsertBoardState = function (topic, key, s) {
    this.db.prepare('INSERT OR REPLACE INTO notify_board_state' +
        '(topic,key,msg,state,expires_at,down,updated_at) VALUES (?,?,?,?,?,COALESCE((SELECT down FROM notify_board_state WHERE topic=? AND key=?),0),?)')
        .run(topic, key, s.msg, s.state || null, s.expires_at || 0, topic, key, Date.now());
};
NotifyStore.prototype.getBoardState = function (topic) {
    return this.db.prepare('SELECT key,msg,state,expires_at,down,updated_at FROM notify_board_state WHERE topic = ? ORDER BY key').all(topic);
};
NotifyStore.prototype.setBoardDown = function (topic, key, down) {
    this.db.prepare('UPDATE notify_board_state SET down = ? WHERE topic = ? AND key = ?').run(down ? 1 : 0, topic, key);
};
NotifyStore.prototype.dueBoardKeys = function (now) {
    return this.db.prepare('SELECT topic,key FROM notify_board_state WHERE expires_at > 0 AND expires_at < ? AND down = 0').all(now);
};
NotifyStore.prototype.addPublishToken = function (topic, t) {
    var id = require('crypto').randomBytes(8).toString('hex');
    this.db.prepare('INSERT INTO notify_publish_tokens(topic,token_id,token_hash,label,created_at) VALUES (?,?,?,?,?)')
        .run(topic, id, t.token_hash, t.label || null, Date.now());
    return id;
};
NotifyStore.prototype.listPublishTokens = function (topic) {
    return this.db.prepare('SELECT token_id,label,created_at FROM notify_publish_tokens WHERE topic = ? ORDER BY created_at').all(topic);
};
NotifyStore.prototype.revokePublishToken = function (topic, id) {
    this.db.prepare('DELETE FROM notify_publish_tokens WHERE topic = ? AND token_id = ?').run(topic, id);
};
NotifyStore.prototype.publishTokenMatchesAny = function (topic, token) {
    var NotifyAuth = require('./notify-auth');
    var rows = this.db.prepare('SELECT token_hash FROM notify_publish_tokens WHERE topic = ?').all(topic);
    for (var i = 0; i < rows.length; i++)
        if (NotifyAuth.publishTokenMatches(token, rows[i].token_hash)) return true;
    return false;
};
```

- [ ] **Step 4: Run to verify it passes**

Run: `node tests/notify-boards.test.js`
Expected: PASS (4 store tests).

- [ ] **Step 5: Regression — existing store tests still green**

Run: `node tests/notify-store.test.js`
Expected: PASS (unchanged — additive schema).

- [ ] **Step 6: Commit**

```bash
git add lib/notify-store.js tests/notify-boards.test.js
git -c user.name=eric -c user.email=eric@tyo.com.au commit -m "feat(notify): store — board config, compacted state, per-watcher token set"
```

---

### Task 3: Multi-token publish auth

**Files:**
- Modify: `lib/server.js` (`publishAuthRejected` @4310–4318)
- Test: append to `tests/notify-boards.test.js`

Extend the publish gate: a token is valid if it matches the legacy single
`publish_token_hash` **or** any token in the board's `notify_publish_tokens` set.

- [ ] **Step 1: Write the failing e2e test**

Append to `tests/notify-boards.test.js` (uses `startServer` from `helpers`, like `notify-claim.test.js`):
```js
const { startServer } = require('./helpers');
const http = require('http');
// (reuse an httpRequest helper copied from notify-claim.test.js — POST/GET with headers)

test('publish accepted with a set token; rejected after it is revoked', async () => {
    // ... boot server with a notify_store filename; create a board with a broker key;
    // add a publish token via store; POST /notify/{board} with Bearer <tok> → 200;
    // revoke the token; POST again → 401.
    // (full body mirrors notify-claim.test.js's publish tests)
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node tests/notify-boards.test.js`
Expected: FAIL — publish with a set token returns 401 (gate only checks the legacy hash).

- [ ] **Step 3: Edit `publishAuthRejected`**

At `lib/server.js` ~4316, change the return so a set-token also passes:
```js
var publishAuthRejected = function (topic) {
    var store = getNotifyStore();
    var claim = store ? store.getClaim(topic) : null;
    if (!claim) return false; // unclaimed — unchanged
    var authHeader = req.headers['authorization'] || '';
    var authMatch = authHeader.match(/^Bearer\s+(.+)$/i);
    if (!authMatch) return true;
    var tok = authMatch[1];
    if (NotifyAuth.publishTokenMatches(tok, claim.publish_token_hash)) return false; // legacy single
    if (store.publishTokenMatchesAny && store.publishTokenMatchesAny(topic, tok)) return false; // per-watcher set
    return true;
};
```

- [ ] **Step 4: Run to verify it passes**

Run: `node tests/notify-boards.test.js` then `node tests/notify-claim.test.js` (regression).
Expected: PASS both.

- [ ] **Step 5: Commit**

```bash
git add lib/server.js tests/notify-boards.test.js
git -c user.name=eric -c user.email=eric@tyo.com.au commit -m "feat(notify): accept per-watcher publish tokens on the publish gate"
```

---

### Task 4: Compaction hook on publish

**Files:**
- Modify: `lib/server.js` (after `Notify.buildMessage`, near the `notifyRing.append` @4399)
- Test: append to `tests/notify-boards.test.js`

When a topic is a board (`store.getBoard(topic)` truthy), after building `msg`,
extract the `key` and `ttl` from `msg.tags`, upsert the compacted row (with
`expires_at = now + ttl*2` when `ttl>0`, else 0), and clear/recover watchdog
state. Still route/deliver as normal (live subscribers + push).

- [ ] **Step 1: Write the failing test** (publish to a board → `GET /board` shows latest-per-key)

```js
test('publishing keyed messages to a board; GET /board returns latest-per-key', async () => {
    // create board 'ops'; add a token; POST two web1 updates + one web2;
    // GET /notify/ops/board (service token) → board has web1(latest) + web2, 2 rows.
});
```

- [ ] **Step 2: Run to verify it fails** — `/board` 404 / empty (endpoint + hook not built).

- [ ] **Step 3: Implement the hook**

After `var msg = Notify.buildMessage({...});` and before/after `notifyRing.append`, add:
```js
var boardCfg = getNotifyStore() && getNotifyStore().getBoard(topic);
if (boardCfg) {
    var Boards = require('./notify-boards');
    var k = Boards.extractField(msg.tags, boardCfg.compact_key || 'key');
    if (k) {
        var ttl = parseInt(Boards.extractField(msg.tags, 'ttl') || '0', 10) || 0;
        var expires = ttl > 0 ? Date.now() + ttl * 2000 : 0;
        var st = getNotifyStore();
        var wasDown = (st.getBoardState(topic).find(function (r) { return r.key === k; }) || {}).down;
        st.upsertBoardState(topic, k, { msg: JSON.stringify(msg), state: Boards.extractField(msg.tags, 'state'), expires_at: expires });
        st.setBoardDown(topic, k, 0);
        if (wasDown) routeProducedMessage(cfg.realm, { from: 'notify', event: topic,
            message: Boards.synthRecoveredMessage(topic, k, Boards.extractField(msg.tags, 'label')), contentType: 'application/json' });
    }
    // a board keyed message with no key is rejected (keep boards from becoming a log)
    else { sendJson(res, 400, {ok:false, code:400, message:'board messages require a key tag'}); return; }
}
```
(Placement: inside the `readRawBody` callback, right after `msg` is built and the
board topic is known — before `routeProducedMessage`.)

- [ ] **Step 4: Add the `GET /notify/{topic}/board` handler** (dispatch + function)

In `handleNotifyRequest` dispatch (@~4275) add before subscribe:
```js
if (subPath === 'board') return handleNotifyBoard(req, res, cfg, topicFromPath, ip);
```
Add the handler (service-token gated read; see Task 6 for the service-token helper):
```js
function handleNotifyBoard (req, res, cfg, topic, ip) {
    var store = getNotifyStore();
    var board = store && store.getBoard(topic);
    if (!board) { sendJson(res, 404, {ok:false, code:404, message:'not a board'}); return true; }
    if (req.method === 'GET') {
        if (!serviceTokenOk(req)) { sendJson(res, 401, {ok:false, code:401, message:'service token required'}); return true; }
        var rows = store.getBoardState(topic).map(function (r) {
            return { key: r.key, state: r.state, down: !!r.down, updated_at: r.updated_at, message: JSON.parse(r.msg) };
        });
        sendJson(res, 200, { ok: true, topic: topic, name: board.name, board: rows });
        return true;
    }
    // POST = create/configure a board (Task 5)
    return handleNotifyBoardCreate(req, res, cfg, topic, ip);
}
```

- [ ] **Step 5: Run to verify it passes** — board publish + `/board` GET returns latest-per-key.

- [ ] **Step 6: Commit**

```bash
git add lib/server.js tests/notify-boards.test.js
git -c user.name=eric -c user.email=eric@tyo.com.au commit -m "feat(notify): compaction hook + GET /notify/{topic}/board"
```

---

### Task 5: Board create + token endpoints (service-token)

**Files:**
- Modify: `lib/server.js` (dispatch `tokens`; `handleNotifyBoardCreate`; `handleNotifyTokens`)
- Test: append to `tests/notify-boards.test.js`

`POST /notify/{topic}/board` (service token) → generate a board keypair, claim
the topic with it (so it's private), write `notify_board_config`, return
`{topic, board_pubkey, name}`. `POST/GET/DELETE /notify/{topic}/tokens` → mint /
list / revoke per §4.4.

- [ ] **Step 1: Write the failing test**
```js
test('service token: create board, mint token, list, publish, revoke', async () => {
    // POST /notify/ops-x1/board {name,compact_key,owner_uid} + x-service-token → 200 {board_pubkey}
    // POST /notify/ops-x1/tokens {label:'web1'} + x-service-token → 200 {token_id, token}
    // POST /notify/ops-x1 Bearer <token> Tags key=web1,state=ok → 200
    // GET  /notify/ops-x1/tokens → [{token_id,label}] (no raw token)
    // DELETE /notify/ops-x1/tokens/<id> → 200 ; publish again → 401
    // wrong/absent service token on create/mint/revoke → 401
});
```

- [ ] **Step 2: Run to verify it fails** — endpoints 404.

- [ ] **Step 3: Implement**
```js
function handleNotifyBoardCreate (req, res, cfg, topic, ip) {
    if (!serviceTokenOk(req)) { sendJson(res,401,{ok:false,code:401,message:'service token required'}); return true; }
    readJsonBody(req, function (body) {                       // small helper: parse JSON body or {}
        var store = getNotifyStore();
        var Boards = require('./notify-boards');
        var kp = Boards.boardKeypair();
        // claim the topic with the broker board-key (reuse the existing store.claim shape)
        store.claim(topic, { pubkey: kp.publicKeySpkiB64,
            pubkey_fingerprint: NotifyAuth.pubkeyFingerprint(kp.publicKeySpkiB64),
            publish_token_hash: NotifyAuth.hashPublishToken(require('crypto').randomBytes(16).toString('hex')),
            created_at: Date.now() });
        store.createBoard(topic, { name: body.name, compact_key: body.compact_key || 'key',
            board_privkey: kp.privateKeyPkcs8B64, board_pubkey: kp.publicKeySpkiB64, owner_uid: body.owner_uid });
        sendJson(res, 200, { ok:true, topic:topic, name: body.name || topic, board_pubkey: kp.publicKeySpkiB64 });
    });
    return true;
}
function handleNotifyTokens (req, res, cfg, topic, tokenId, ip) {
    if (!serviceTokenOk(req)) { sendJson(res,401,{ok:false,code:401,message:'service token required'}); return true; }
    var store = getNotifyStore();
    if (!store.getBoard(topic)) { sendJson(res,404,{ok:false,code:404,message:'not a board'}); return true; }
    if (req.method === 'POST') {
        readJsonBody(req, function (body) {
            var raw = NotifyAuth.generatePublishToken();
            var id = store.addPublishToken(topic, { token_hash: NotifyAuth.hashPublishToken(raw), label: body.label });
            sendJson(res, 200, { ok:true, token_id:id, token: raw, label: body.label || null, created_at: Date.now() });
        });
        return true;
    }
    if (req.method === 'GET') { sendJson(res, 200, { ok:true, tokens: store.listPublishTokens(topic) }); return true; }
    if (req.method === 'DELETE') { store.revokePublishToken(topic, tokenId); sendJson(res, 200, { ok:true }); return true; }
    sendJson(res, 405, {ok:false, code:405, message:'method not allowed'}); return true;
}
```
Dispatch (`handleNotifyRequest`): parse `tokens` and `tokens/{id}` subpaths and route to `handleNotifyTokens`.
Add helpers near the notify block: `serviceTokenOk(req)` = constant-time compare of `req.headers['x-service-token']` to `process.env.NOTIFY_SERVICE_TOKEN || process.env.REACH_SERVICE_TOKEN`; `readJsonBody(req, cb)` = `readRawBody` + `JSON.parse` (→ `{}` on error).

- [ ] **Step 4: Run to verify it passes** — full lifecycle test green; regression `notify-claim.test.js` green.

- [ ] **Step 5: Commit**

```bash
git add lib/server.js tests/notify-boards.test.js
git -c user.name=eric -c user.email=eric@tyo.com.au commit -m "feat(notify): board create + per-watcher token mint/list/revoke (service token)"
```

---

### Task 6: Watchdog sweep (DOWN / RECOVERED)

**Files:**
- Modify: `lib/server.js` (start a sweep timer where the broker sets up other intervals; RECOVERED already handled in Task 4's hook)
- Test: append to `tests/notify-boards.test.js`

- [ ] **Step 1: Write the failing test**
```js
test('watchdog fires DOWN when a heartbeat lapses, then RECOVERED on the next beat', async () => {
    // create board; publish key=web1 ttl=1 (expires_at = now + 2s); wait > 2s + a sweep;
    // GET /board → web1.down === true, and a DOWN message was delivered (assert via a subscriber or the row state);
    // publish key=web1 again → down false + a RECOVERED delivered.
    // Use a short sweep interval injected via an env/opt for the test (e.g. NOTIFY_WATCHDOG_MS=200).
});
```

- [ ] **Step 2: Run to verify it fails** — `down` never flips (no sweep).

- [ ] **Step 3: Implement the sweep**

Where the broker starts its periodic timers, add:
```js
var WATCHDOG_MS = parseInt(process.env.NOTIFY_WATCHDOG_MS || '20000', 10);
setInterval(function () {
    var store = getNotifyStore(); if (!store) return;
    var due = store.dueBoardKeys(Date.now());
    var Boards = require('./notify-boards');
    due.forEach(function (d) {
        store.setBoardDown(d.topic, d.key, 1);
        var down = Boards.synthDownMessage(d.topic, d.key, d.key);
        // compact the DOWN into the board row too, so /board reflects it
        store.upsertBoardState(d.topic, d.key, { msg: JSON.stringify(down), state: 'crit', expires_at: 0 });
        store.setBoardDown(d.topic, d.key, 1);
        routeProducedMessage(defaultRealm(), { from: 'notify', event: d.topic, message: down, contentType: 'application/json' });
    });
}, WATCHDOG_MS).unref();  // unref so it never keeps the process (or tests) alive
```
(RECOVERED is emitted by the Task-4 compaction hook when a message arrives for a
`down` key.)

- [ ] **Step 4: Run to verify it passes** — DOWN then RECOVERED observed.

- [ ] **Step 5: Commit**

```bash
git add lib/server.js tests/notify-boards.test.js
git -c user.name=eric -c user.email=eric@tyo.com.au commit -m "feat(notify): watchdog sweep — synthetic DOWN + RECOVERED from heartbeats"
```

---

### Task 7: Board read-ticket for the browser (sse-ticket via service token)

**Files:**
- Modify: `lib/server.js` (`handleNotifySseTicket` @4763 — accept a service-token path for boards)
- Test: append to `tests/notify-boards.test.js`

So the dashboard backend can mint a board SSE ticket (no device key), which the
browser uses for `EventSource(/sse?ticket=)`.

- [ ] **Step 1: Write the failing test** — `POST /notify/{board}/sse-ticket` with `x-service-token` (no proof) → 200 `{ticket}`; then `GET /sse?ticket=` opens.

- [ ] **Step 2: Run to verify it fails** — ticket endpoint 401 (only device-proof path today).

- [ ] **Step 3: Implement** — in `handleNotifySseTicket`, before the proof check: if the topic is a board (`store.getBoard(topic)`) and `serviceTokenOk(req)`, issue a ticket directly (reuse the existing ticket-issue path); else fall through to the current proof logic. Personal topics unchanged.

- [ ] **Step 4: Run to verify it passes** — ticketed board SSE works; `notify-claim.test.js` regression green.

- [ ] **Step 5: Commit**

```bash
git add lib/server.js tests/notify-boards.test.js
git -c user.name=eric -c user.email=eric@tyo.com.au commit -m "feat(notify): service-token board SSE tickets for the dashboard"
```

---

### Task 8: `tyo-notify-watch` producer script

**Files:**
- Create: `bin/tyo-notify-watch.sh`
- Test: `tests/notify-watch.test.js` (runs the script against a local httptest-style stub)

Dependency-free POSIX `sh`: read config (BOARD/KEY/TOKEN/SERVER/INTERVAL from env
or `/etc/tyo-notify-watch.conf`), gather load / mem% / disk%, POST each as a keyed
status message with `ttl`, at `state`-appropriate priority. Idempotent install
via `sh -s install` (systemd timer, cron fallback) and `sh -s uninstall`.

- [ ] **Step 1: Write the failing test** — start a tiny node http server capturing POSTs; run `SERVER=http://127.0.0.1:PORT BOARD=ops KEY=t1 TOKEN=x tyo-notify-watch.sh once`; assert it POSTed `/notify/ops` with `Authorization: Bearer x` and a `key=t1` + `ttl=` tag.

- [ ] **Step 2: Run to verify it fails** — script doesn't exist.

- [ ] **Step 3: Implement `bin/tyo-notify-watch.sh`**
```sh
#!/bin/sh
# tyo-notify-watch — agentless TYO Notify status producer. POSIX sh, curl only.
set -eu
CONF="${TYO_NOTIFY_WATCH_CONF:-/etc/tyo-notify-watch.conf}"
[ -f "$CONF" ] && . "$CONF"
SERVER="${SERVER:-https://freemq.tyo.com.au}"
INTERVAL="${INTERVAL:-60}"
TTL=$((INTERVAL * 2))
: "${BOARD:?BOARD required}"; : "${KEY:?KEY required}"; : "${TOKEN:?TOKEN required}"

post() { # $1=metric $2=value $3=state $4=text
  curl -fsS -m 10 -o /dev/null \
    -H "Authorization: Bearer $TOKEN" \
    -H "Tags: key=$KEY,label=$KEY,metric=$1,value=$2,state=$3,ttl=$TTL" \
    -H "Priority: $([ "$3" = ok ] && echo 1 || echo 5)" \
    -d "$4" "$SERVER/notify/$BOARD" || true
}

check_once() {
  DISK=$(df -P / | awk 'NR==2{gsub("%","",$5); print $5}')
  LOAD=$(awk '{print $1}' /proc/loadavg 2>/dev/null || echo 0)
  MEMP=$(awk '/MemTotal/{t=$2} /MemAvailable/{a=$2} END{ if(t>0) printf "%d", (t-a)*100/t; else print 0 }' /proc/meminfo 2>/dev/null || echo 0)
  ds=ok; [ "$DISK" -ge 80 ] 2>/dev/null && ds=warn; [ "$DISK" -ge 92 ] 2>/dev/null && ds=crit
  ms=ok; [ "$MEMP" -ge 85 ] 2>/dev/null && ms=warn; [ "$MEMP" -ge 95 ] 2>/dev/null && ms=crit
  # worst state is the heartbeat's state; each metric also posts its own reading
  post disk "${DISK}%" "$ds" "$KEY disk ${DISK}%"
  post mem  "${MEMP}%" "$ms" "$KEY mem ${MEMP}%"
  post load "$LOAD"    ok    "$KEY load $LOAD"
}

case "${1:-run}" in
  once) check_once ;;
  run)  while :; do check_once; sleep "$INTERVAL"; done ;;
  install)   . "${0%/*}/watch-install.inc" 2>/dev/null || true; install_watcher ;;
  uninstall) . "${0%/*}/watch-install.inc" 2>/dev/null || true; uninstall_watcher ;;
  *) echo "usage: $0 {once|run|install|uninstall}" >&2; exit 2 ;;
esac
```
(The `install`/`uninstall` systemd-timer/cron logic ships in the installer that
`get.tyonotify.com/watch` serves — hosting is store-backend's; keep the script's
`once`/`run` core here and testable.)

- [ ] **Step 4: Run to verify it passes** — the `once` POST is captured with the right headers.

- [ ] **Step 5: Commit**

```bash
git add bin/tyo-notify-watch.sh tests/notify-watch.test.js
git -c user.name=eric -c user.email=eric@tyo.com.au commit -m "feat(notify): tyo-notify-watch agentless producer (POSIX sh)"
```

---

### Task 9: Full suite + deploy checklist

**Files:** none (verification).

- [ ] **Step 1: Whole notify suite green**

Run: `for t in tests/notify*.test.js; do echo "== $t =="; node "$t" || exit 1; done`
Expected: all PASS (new board/watch tests + all existing notify tests — no regressions).

- [ ] **Step 2: Manual live smoke (staging first if available)**

Against a local broker (`startServer`-style) or a staging freemq: create a board,
mint a token, run `tyo-notify-watch.sh once` with `ttl=2`, confirm `/board` shows
the host, wait for the watchdog DOWN, publish again for RECOVERED.

- [ ] **Step 3: Deploy notes (do NOT auto-deploy)**

`freemq.js` loads `~/tyo-mq/lib/server.js`. Deploy = sync the changed `lib/*.js`
to `freemq:~/tyo-mq/lib/` and restart the broker (owner-coordinated — it's live
production; the TW VMs run the same code, see [[TW VM infra]]). New sqlite tables
are created on boot by `NotifyStore` (idempotent `CREATE TABLE IF NOT EXISTS`),
so no migration step. `NOTIFY_SERVICE_TOKEN` must be set in the broker env (or it
falls back to `REACH_SERVICE_TOKEN`). Hand store-backend the live service-token
value out-of-band.

---

## Self-review notes

- **Spec coverage:** compacted topics (T2/T4), `/board` (T4), watchdog DOWN/RECOVERED (T4 recover + T6 down), per-watcher tokens (T2/T3/T5), board-key ownership + service-token mgmt (T5), board SSE ticket for the dashboard (T7), status vocab (broker only needs `key`/`ttl`/`state` — extracted in T1/T4; full card vocab is client-side), producer (T8). All present.
- **No new device-key signing** anywhere for boards — every board path is service-token (T5/T6/T7); personal topics/claim/rotate untouched.
- **Type/name consistency:** store methods (`createBoard`/`getBoard`/`upsertBoardState`/`getBoardState`/`dueBoardKeys`/`setBoardDown`/`addPublishToken`/`listPublishTokens`/`revokePublishToken`/`publishTokenMatchesAny`) are used identically across T2–T7; `notify-boards.js` (`extractField`/`boardKeypair`/`synthDownMessage`/`synthRecoveredMessage`) across T1/T4/T6.
- **Deferred (v2, per spec):** phone/desktop board views; SSH-hub installer; the `get.tyonotify.com/watch` install-script hosting + the systemd/cron `install`/`uninstall` bodies (store-backend owns hosting; the script's testable core lands here).
- **Live-production caution:** all changes are additive (new tables, new subpaths, a widened publish gate that still accepts the legacy token). Regression tests (`notify-claim`, `notify-store`, `notify`) must stay green at every task.
