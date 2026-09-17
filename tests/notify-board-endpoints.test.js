// tests/notify-board-endpoints.test.js
/**
 * TYO Notify service-surface endpoints added for the store/public-directory:
 *   POST   /notify/{topic}/verify-token   — verify a publish token (no publish)
 *   POST   /notify/{topic}/push           — board push (un)register (service token)
 *   DELETE /notify/{topic}/push
 *   POST   /notify/directory/activity     — per-topic last-published-at
 * Usage: node tests/notify-board-endpoints.test.js
 */

'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { test, run } = require('./runner');
const { startServer, delay } = require('./helpers');
const notifyAuth = require('../lib/notify-auth');

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

function genKeyPair() {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    return { pubkey: publicKey.export({ type: 'spki', format: 'der' }).toString('base64'), privateKey };
}
function claimBody(privateKey, topic, extra) {
    const now = Date.now();
    const nonce = crypto.randomBytes(8).toString('hex');
    const body = Object.assign({ topic: topic }, extra);
    const base = notifyAuth.signatureBase('claim', body, now, nonce);
    const signature = crypto.sign('sha256', Buffer.from(base), privateKey).toString('base64');
    return Object.assign({}, body, { timestamp: now, nonce: nonce, signature: signature });
}
function tmp() {
    return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'nbe-')), 'n.sqlite');
}

const SERVICE = 'svc-token-endpoints-0123456789abcdef';

// ── verify-token ─────────────────────────────────────────────────────────────
test('verify-token: valid token → {valid:true}, wrong → {valid:false}, gates on service token + POST', async () => {
    process.env.NOTIFY_SERVICE_TOKEN = SERVICE;
    const server = await startServer({ notify: { enabled: true }, notify_store: { filename: tmp() } });
    try {
        const topic = 'contact-verify';
        const { pubkey, privateKey } = genKeyPair();
        const claim = await httpRequest(server.port, 'POST', `/notify/${topic}/claim`, {
            body: claimBody(privateKey, topic, { pubkey, transport: 'null', token: 'dev-token' })
        });
        assert.strictEqual(claim.status, 200, JSON.stringify(claim));
        const tok = claim.json.publish_token;
        assert.ok(tok, 'claim returned a publish token');

        const good = await httpRequest(server.port, 'POST', `/notify/${topic}/verify-token`, {
            headers: { 'x-service-token': SERVICE }, body: { token: tok }
        });
        assert.strictEqual(good.status, 200, JSON.stringify(good));
        assert.strictEqual(good.json.valid, true, 'correct token verifies');

        const bad = await httpRequest(server.port, 'POST', `/notify/${topic}/verify-token`, {
            headers: { 'x-service-token': SERVICE }, body: { token: 'not-the-token' }
        });
        assert.strictEqual(bad.status, 200, JSON.stringify(bad));
        assert.strictEqual(bad.json.valid, false, 'wrong token does not verify');

        // an unclaimed topic → valid:false (no leak of existence)
        const unclaimed = await httpRequest(server.port, 'POST', `/notify/never-claimed/verify-token`, {
            headers: { 'x-service-token': SERVICE }, body: { token: tok }
        });
        assert.strictEqual(unclaimed.status, 200, JSON.stringify(unclaimed));
        assert.strictEqual(unclaimed.json.valid, false);

        // no service token → 401; GET → 405
        const noTok = await httpRequest(server.port, 'POST', `/notify/${topic}/verify-token`, { body: { token: tok } });
        assert.strictEqual(noTok.status, 401, JSON.stringify(noTok));
        const wrongMethod = await httpRequest(server.port, 'GET', `/notify/${topic}/verify-token`, {
            headers: { 'x-service-token': SERVICE }
        });
        assert.strictEqual(wrongMethod.status, 405, JSON.stringify(wrongMethod));
    } finally {
        await server.close();
    }
});

// ── board push (un)register ──────────────────────────────────────────────────
test('board push: register + idempotent re-register + DELETE; 404 off a board; 401 without service token', async () => {
    process.env.NOTIFY_SERVICE_TOKEN = SERVICE;
    const prevTransport = process.env.TYO_MQ_PUSH_TRANSPORT;
    process.env.TYO_MQ_PUSH_TRANSPORT = 'null';
    const server = await startServer({ notify: { enabled: true }, notify_store: { filename: tmp() } });
    try {
        const board = 'ops-push';
        await httpRequest(server.port, 'POST', `/notify/${board}/board`, {
            headers: { 'x-service-token': SERVICE }, body: { name: 'Fleet' }
        });

        const reg = await httpRequest(server.port, 'POST', `/notify/${board}/push`, {
            headers: { 'x-service-token': SERVICE }, body: { transport: 'null', token: 'dev-ep-1', app_id: 'au.com.tyo.notify', min_priority: 5 }
        });
        assert.strictEqual(reg.status, 200, JSON.stringify(reg));
        assert.strictEqual(reg.json.ok, true);

        // idempotent: a second identical register is still 200 (upsert)
        const reg2 = await httpRequest(server.port, 'POST', `/notify/${board}/push`, {
            headers: { 'x-service-token': SERVICE }, body: { transport: 'null', token: 'dev-ep-1', min_priority: 5 }
        });
        assert.strictEqual(reg2.status, 200, JSON.stringify(reg2));

        // DELETE the same endpoint → removed
        const del = await httpRequest(server.port, 'DELETE', `/notify/${board}/push`, {
            headers: { 'x-service-token': SERVICE }, body: { transport: 'null', token: 'dev-ep-1' }
        });
        assert.strictEqual(del.status, 200, JSON.stringify(del));
        assert.strictEqual(del.json.removed, true);

        // DELETE again → 200 removed:false (idempotent)
        const del2 = await httpRequest(server.port, 'DELETE', `/notify/${board}/push`, {
            headers: { 'x-service-token': SERVICE }, body: { transport: 'null', token: 'dev-ep-1' }
        });
        assert.strictEqual(del2.status, 200, JSON.stringify(del2));
        assert.strictEqual(del2.json.removed, false);

        // a plain (non-board) topic → 404
        const notBoard = await httpRequest(server.port, 'POST', `/notify/plain-topic/push`, {
            headers: { 'x-service-token': SERVICE }, body: { transport: 'null', token: 'ep' }
        });
        assert.strictEqual(notBoard.status, 404, JSON.stringify(notBoard));

        // no service token → 401
        const noTok = await httpRequest(server.port, 'POST', `/notify/${board}/push`, {
            body: { transport: 'null', token: 'ep' }
        });
        assert.strictEqual(noTok.status, 401, JSON.stringify(noTok));

        // missing transport/token → 400
        const bad = await httpRequest(server.port, 'POST', `/notify/${board}/push`, {
            headers: { 'x-service-token': SERVICE }, body: { transport: 'null' }
        });
        assert.strictEqual(bad.status, 400, JSON.stringify(bad));
    } finally {
        await server.close();
        if (prevTransport === undefined) delete process.env.TYO_MQ_PUSH_TRANSPORT;
        else process.env.TYO_MQ_PUSH_TRANSPORT = prevTransport;
    }
});

test('board push: 503 when no push transport is configured', async () => {
    process.env.NOTIFY_SERVICE_TOKEN = SERVICE;
    const prevTransport = process.env.TYO_MQ_PUSH_TRANSPORT;
    delete process.env.TYO_MQ_PUSH_TRANSPORT;
    const server = await startServer({ notify: { enabled: true }, notify_store: { filename: tmp() } });
    try {
        const board = 'ops-push-noconf';
        await httpRequest(server.port, 'POST', `/notify/${board}/board`, {
            headers: { 'x-service-token': SERVICE }, body: { name: 'F' }
        });
        const reg = await httpRequest(server.port, 'POST', `/notify/${board}/push`, {
            headers: { 'x-service-token': SERVICE }, body: { transport: 'null', token: 'ep' }
        });
        assert.strictEqual(reg.status, 503, JSON.stringify(reg));
    } finally {
        await server.close();
        if (prevTransport === undefined) delete process.env.TYO_MQ_PUSH_TRANSPORT;
        else process.env.TYO_MQ_PUSH_TRANSPORT = prevTransport;
    }
});

// ── directory/activity ───────────────────────────────────────────────────────
test('directory/activity: reports last-published-at for published topics; omits unseen; gates', async () => {
    process.env.NOTIFY_SERVICE_TOKEN = SERVICE;
    const server = await startServer({ notify: { enabled: true }, notify_store: { filename: tmp() } });
    try {
        const before = Date.now();
        // publish to two public (unclaimed) topics
        await httpRequest(server.port, 'POST', `/notify/alpha`, { raw: 'hello alpha' });
        await httpRequest(server.port, 'POST', `/notify/beta`, { raw: 'hello beta' });
        const after = Date.now();

        const q = await httpRequest(server.port, 'POST', `/notify/directory/activity`, {
            headers: { 'x-service-token': SERVICE }, body: { topics: ['alpha', 'beta', 'gamma-never'] }
        });
        assert.strictEqual(q.status, 200, JSON.stringify(q));
        const act = q.json.activity;
        assert.ok(typeof act.alpha === 'number', 'alpha has an activity ts');
        assert.ok(typeof act.beta === 'number', 'beta has an activity ts');
        assert.ok(act.alpha >= before && act.alpha <= after, 'alpha ts within the publish window');
        assert.ok(!('gamma-never' in act), 'unseen topic is omitted, not null/0');

        // no service token → 401; GET → 405; overlong list → 400
        const noTok = await httpRequest(server.port, 'POST', `/notify/directory/activity`, { body: { topics: ['alpha'] } });
        assert.strictEqual(noTok.status, 401, JSON.stringify(noTok));
        const wrongMethod = await httpRequest(server.port, 'GET', `/notify/directory/activity`, { headers: { 'x-service-token': SERVICE } });
        assert.strictEqual(wrongMethod.status, 405, JSON.stringify(wrongMethod));

        const tooMany = [];
        for (let i = 0; i < 501; i++) tooMany.push('t' + i);
        const over = await httpRequest(server.port, 'POST', `/notify/directory/activity`, {
            headers: { 'x-service-token': SERVICE }, body: { topics: tooMany }
        });
        assert.strictEqual(over.status, 400, JSON.stringify(over));
    } finally {
        await server.close();
    }
});

run();
