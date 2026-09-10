// tests/notify-boards.test.js
/**
 * TYO Notify Status Boards — board config, compacted state, per-watcher
 * publish token set (lib/notify-store.js).
 * Usage: node tests/notify-boards.test.js
 */

'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { test, run } = require('./runner');
const { startServer, delay } = require('./helpers');
const NotifyStore = require('../lib/notify-store');

function tmp() {
    return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'nb-')), 'n.sqlite');
}

// A flexible HTTP helper (modeled on tests/notify-claim.test.js's) that also
// supports a raw string body (the /notify path-form publish, where the body IS
// the message) and arbitrary methods (DELETE for token revoke).
function httpRequest(port, method, pathname, opts) {
    opts = opts || {};
    return new Promise((resolve) => {
        let payload;
        if (opts.raw !== undefined) payload = opts.raw;
        else payload = opts.body === undefined ? '' : JSON.stringify(opts.body);
        const headers = Object.assign({}, opts.headers || {});
        if (opts.raw === undefined && opts.body !== undefined && !headers['content-type'])
            headers['content-type'] = 'application/json';
        headers['content-length'] = Buffer.byteLength(payload);
        const req = http.request({ host: '127.0.0.1', port, path: pathname, method, headers, timeout: 4000 }, (res) => {
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

const SERVICE = 'svc-token-boards-e2e-0123456789';

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

// ── e2e: the real broker (startServer) — board lifecycle over HTTP ───────────

test('board lifecycle e2e: create (service token), mint, keyed publish, GET /board latest-per-key, list, revoke → 401', async () => {
    process.env.NOTIFY_SERVICE_TOKEN = SERVICE;
    const server = await startServer({ notify: { enabled: true }, notify_store: { filename: tmp() } });
    try {
        const board = 'ops-lifecycle';

        // create the board with the service token
        const created = await httpRequest(server.port, 'POST', `/notify/${board}/board`, {
            headers: { 'x-service-token': SERVICE }, body: { name: 'Fleet', compact_key: 'key', owner_uid: 'u1' }
        });
        assert.strictEqual(created.status, 200, JSON.stringify(created));
        assert.ok(created.json.board_pubkey, 'create returns the board public key');

        // wrong service token → 401; absent → 401
        const wrong = await httpRequest(server.port, 'POST', `/notify/${board}-x/board`, {
            headers: { 'x-service-token': 'nope' }, body: { name: 'X' }
        });
        assert.strictEqual(wrong.status, 401, JSON.stringify(wrong));
        const absent = await httpRequest(server.port, 'POST', `/notify/${board}-y/board`, { body: { name: 'Y' } });
        assert.strictEqual(absent.status, 401, JSON.stringify(absent));

        // mint a per-watcher publish token
        const minted = await httpRequest(server.port, 'POST', `/notify/${board}/tokens`, {
            headers: { 'x-service-token': SERVICE }, body: { label: 'web1' }
        });
        assert.strictEqual(minted.status, 200, JSON.stringify(minted));
        assert.ok(minted.json.token && minted.json.token_id, 'mint returns a raw token + id');
        const tok = minted.json.token;

        // mint without the service token → 401
        const mintNoTok = await httpRequest(server.port, 'POST', `/notify/${board}/tokens`, { body: { label: 'x' } });
        assert.strictEqual(mintNoTok.status, 401, JSON.stringify(mintNoTok));

        // publish keyed messages (Bearer <tok>) — two for web1, one for web2
        const p1 = await httpRequest(server.port, 'POST', `/notify/${board}`, {
            headers: { authorization: 'Bearer ' + tok, tags: 'key=web1,label=web1,state=ok' }, raw: 'web1 first'
        });
        assert.strictEqual(p1.status, 200, JSON.stringify(p1));
        const p2 = await httpRequest(server.port, 'POST', `/notify/${board}`, {
            headers: { authorization: 'Bearer ' + tok, tags: 'key=web1,label=web1,state=warn' }, raw: 'web1 second'
        });
        assert.strictEqual(p2.status, 200);
        const p3 = await httpRequest(server.port, 'POST', `/notify/${board}`, {
            headers: { authorization: 'Bearer ' + tok, tags: 'key=web2,label=web2,state=ok' }, raw: 'web2 first'
        });
        assert.strictEqual(p3.status, 200);

        // a keyless board publish → 400 (a board must not become a log)
        const noKey = await httpRequest(server.port, 'POST', `/notify/${board}`, {
            headers: { authorization: 'Bearer ' + tok, tags: 'state=ok' }, raw: 'no key here'
        });
        assert.strictEqual(noKey.status, 400, JSON.stringify(noKey));

        // GET /board — latest-per-key, 2 rows, web1 shows the LATEST update
        const view = await httpRequest(server.port, 'GET', `/notify/${board}/board`, { headers: { 'x-service-token': SERVICE } });
        assert.strictEqual(view.status, 200, JSON.stringify(view));
        assert.strictEqual(view.json.board.length, 2);
        const web1 = view.json.board.find(r => r.key === 'web1');
        assert.strictEqual(web1.state, 'warn', 'latest-per-key wins');
        assert.strictEqual(web1.message.message, 'web1 second');

        // GET /board without the service token → 401
        const viewNoTok = await httpRequest(server.port, 'GET', `/notify/${board}/board`);
        assert.strictEqual(viewNoTok.status, 401, JSON.stringify(viewNoTok));

        // list tokens — metadata only, no raw token leaked
        const list = await httpRequest(server.port, 'GET', `/notify/${board}/tokens`, { headers: { 'x-service-token': SERVICE } });
        assert.strictEqual(list.status, 200, JSON.stringify(list));
        assert.strictEqual(list.json.tokens.length, 1);
        assert.strictEqual(list.json.tokens[0].label, 'web1');
        assert.ok(!list.json.tokens[0].token, 'listing never carries the raw token');

        // revoke → the same token is now rejected on publish
        const del = await httpRequest(server.port, 'DELETE', `/notify/${board}/tokens/${minted.json.token_id}`, {
            headers: { 'x-service-token': SERVICE }
        });
        assert.strictEqual(del.status, 200, JSON.stringify(del));
        const afterRevoke = await httpRequest(server.port, 'POST', `/notify/${board}`, {
            headers: { authorization: 'Bearer ' + tok, tags: 'key=web1,state=ok' }, raw: 'should fail'
        });
        assert.strictEqual(afterRevoke.status, 401, JSON.stringify(afterRevoke));
    } finally {
        await server.close();
    }
});

test('watchdog fires DOWN on a lapsed heartbeat, then RECOVERED on the next beat', async () => {
    process.env.NOTIFY_SERVICE_TOKEN = SERVICE;
    const prev = process.env.NOTIFY_WATCHDOG_MS;
    process.env.NOTIFY_WATCHDOG_MS = '200';
    const server = await startServer({ notify: { enabled: true }, notify_store: { filename: tmp() } });
    try {
        const board = 'ops-watchdog';
        await httpRequest(server.port, 'POST', `/notify/${board}/board`, {
            headers: { 'x-service-token': SERVICE }, body: { name: 'W' }
        });
        const minted = await httpRequest(server.port, 'POST', `/notify/${board}/tokens`, {
            headers: { 'x-service-token': SERVICE }, body: { label: 'web1' }
        });
        const tok = minted.json.token;

        // ttl=1 → expires_at = now + 2s; let it lapse past a sweep (every 200ms)
        const beat = await httpRequest(server.port, 'POST', `/notify/${board}`, {
            headers: { authorization: 'Bearer ' + tok, tags: 'key=web1,label=web1,state=ok,ttl=1' }, raw: 'beat'
        });
        assert.strictEqual(beat.status, 200, JSON.stringify(beat));

        await delay(2700);
        const down = await httpRequest(server.port, 'GET', `/notify/${board}/board`, { headers: { 'x-service-token': SERVICE } });
        const web1 = down.json.board.find(r => r.key === 'web1');
        assert.strictEqual(web1.down, true, 'watchdog marked the key DOWN: ' + JSON.stringify(down.json));
        assert.strictEqual(web1.state, 'crit');

        // next beat clears down (RECOVERED emitted by the compaction hook)
        const beat2 = await httpRequest(server.port, 'POST', `/notify/${board}`, {
            headers: { authorization: 'Bearer ' + tok, tags: 'key=web1,label=web1,state=ok,ttl=1' }, raw: 'beat2'
        });
        assert.strictEqual(beat2.status, 200);
        const recov = await httpRequest(server.port, 'GET', `/notify/${board}/board`, { headers: { 'x-service-token': SERVICE } });
        const web1r = recov.json.board.find(r => r.key === 'web1');
        assert.strictEqual(web1r.down, false, 'next heartbeat cleared DOWN: ' + JSON.stringify(recov.json));
        assert.strictEqual(web1r.message.message, 'beat2');
    } finally {
        await server.close();
        if (prev === undefined) delete process.env.NOTIFY_WATCHDOG_MS;
        else process.env.NOTIFY_WATCHDOG_MS = prev;
    }
});

test('board sse-ticket via service token (no device proof) issues a ticket; wrong/absent token → 401', async () => {
    process.env.NOTIFY_SERVICE_TOKEN = SERVICE;
    const server = await startServer({ notify: { enabled: true }, notify_store: { filename: tmp() } });
    try {
        const board = 'ops-ticket';
        await httpRequest(server.port, 'POST', `/notify/${board}/board`, {
            headers: { 'x-service-token': SERVICE }, body: { name: 'T' }
        });

        const ok = await httpRequest(server.port, 'POST', `/notify/${board}/sse-ticket`, {
            headers: { 'x-service-token': SERVICE }, body: {}
        });
        assert.strictEqual(ok.status, 200, JSON.stringify(ok));
        assert.ok(ok.json.ticket, 'a board sse-ticket is issued with just the service token');

        const bad = await httpRequest(server.port, 'POST', `/notify/${board}/sse-ticket`, {
            headers: { 'x-service-token': 'nope' }, body: {}
        });
        assert.strictEqual(bad.status, 401, JSON.stringify(bad));

        const absent = await httpRequest(server.port, 'POST', `/notify/${board}/sse-ticket`, { body: {} });
        assert.strictEqual(absent.status, 401, JSON.stringify(absent));
    } finally {
        await server.close();
    }
});

run();
