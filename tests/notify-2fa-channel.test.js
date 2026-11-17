/**
 * TYO Notify as a code-delivery channel (TYO ID 2FA, 2026-11-15 contract):
 *   1. owner-minted publisher tokens  — POST/GET/DELETE /notify/{topic}/publishers
 *   2. message expiry                 — X-Tyo-Expires / `expires`, ring drops expired
 *   3. delivery result                — X-Tyo-Delivery: wait → `delivery` in the response
 *
 * Usage: node tests/notify-2fa-channel.test.js
 */

'use strict';

const assert = require('assert');
const crypto = require('crypto');
const http = require('http');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { test, run } = require('./runner');
const { startServer, delay } = require('./helpers');
const notifyAuth = require('../lib/notify-auth');
const push = require('../lib/push');

function httpRequest(port, method, p, opts) {
    opts = opts || {};
    return new Promise((resolve) => {
        const payload = opts.body === undefined ? null : (typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body));
        const headers = Object.assign({}, opts.headers || {});
        if (payload !== null && !headers['content-type'] && typeof opts.body !== 'string') headers['content-type'] = 'application/json';
        if (payload !== null) headers['content-length'] = Buffer.byteLength(payload);
        const req = http.request({ host: '127.0.0.1', port, path: p, method, headers, timeout: 8000 }, (res) => {
            let data = '';
            res.on('data', c => { data += c; });
            res.on('end', () => { let json = null; try { json = data ? JSON.parse(data) : null; } catch (e) {} resolve({ status: res.statusCode, body: data, json }); });
        });
        req.on('timeout', () => { req.destroy(); resolve({ status: null, body: '', json: null }); });
        req.on('error', () => resolve({ status: null, body: '', json: null }));
        if (payload !== null) req.write(payload);
        req.end();
    });
}
function genKeyPair() {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    return { pubkey: publicKey.export({ type: 'spki', format: 'der' }).toString('base64'), privateKey };
}
function signed(privateKey, action, body) {
    const now = Date.now(), nonce = crypto.randomBytes(8).toString('hex');
    const base = notifyAuth.signatureBase(action, body, now, nonce);
    const signature = crypto.sign('sha256', Buffer.from(base), privateKey).toString('base64');
    return { timestamp: now, nonce, signature };
}
function proofHeaders(privateKey, action, body) {
    const p = signed(privateKey, action, body);
    return { 'x-tyo-notify-timestamp': String(p.timestamp), 'x-tyo-notify-nonce': p.nonce, 'x-tyo-notify-signature': p.signature };
}
async function startNotify() {
    const prev = process.env.TYO_MQ_PUSH_TRANSPORT;
    process.env.TYO_MQ_PUSH_TRANSPORT = 'null';
    const storeFile = path.join(os.tmpdir(), 'tyo-mq-test-notify-' + process.pid + '-' + Math.random().toString(36).slice(2) + '.sqlite');
    const srv = await startServer({ notify: { enabled: true }, notify_store: { filename: storeFile } });
    srv.nt = push.transportFor(srv.server._push.config, 'null');
    srv.finish = async () => {
        await srv.close();
        if (prev === undefined) delete process.env.TYO_MQ_PUSH_TRANSPORT; else process.env.TYO_MQ_PUSH_TRANSPORT = prev;
        for (const sfx of ['', '-wal', '-shm']) { try { fs.unlinkSync(storeFile + sfx); } catch (e) {} }
    };
    return srv;
}
async function claim(srv, topic) {
    const kp = genKeyPair();
    const body = { topic, pubkey: kp.pubkey, transport: 'null', token: 'tok-' + topic, app_id: 'demo' };
    const r = await httpRequest(srv.port, 'POST', '/notify/' + topic + '/claim', { body: Object.assign({}, body, signed(kp.privateKey, 'claim', body)) });
    assert.strictEqual(r.status, 200, 'claim: ' + r.body);
    return kp;
}

test('publishers: the owner mints a labelled token, lists it, publishes with it, revokes it; strangers and bad signatures are refused', async () => {
    const srv = await startNotify();
    try {
        const kp = await claim(srv, 'u1');
        // Unclaimed topic → 404; wrong key → 401
        assert.strictEqual((await httpRequest(srv.port, 'POST', '/notify/nobody/publishers', { body: Object.assign({ label: 'x' }, signed(kp.privateKey, 'publishers', { topic: 'nobody', label: 'x' })) })).status, 404);
        const stranger = genKeyPair();
        assert.strictEqual((await httpRequest(srv.port, 'POST', '/notify/u1/publishers', { body: Object.assign({ label: 'tyo-id' }, signed(stranger.privateKey, 'publishers', { topic: 'u1', label: 'tyo-id' })) })).status, 401);

        const mint = await httpRequest(srv.port, 'POST', '/notify/u1/publishers', { body: Object.assign({ label: 'tyo-id' }, signed(kp.privateKey, 'publishers', { topic: 'u1', label: 'tyo-id' })) });
        assert.strictEqual(mint.status, 200, mint.body);
        assert.ok(mint.json.token && mint.json.token_id); assert.strictEqual(mint.json.label, 'tyo-id');

        const list = await httpRequest(srv.port, 'GET', '/notify/u1/publishers', { headers: proofHeaders(kp.privateKey, 'publishers-list', { topic: 'u1' }) });
        assert.strictEqual(list.status, 200, list.body);
        assert.deepStrictEqual(list.json.publishers.map(t => [t.token_id, t.label]), [[mint.json.token_id, 'tyo-id']]);
        assert.ok(!JSON.stringify(list.json).includes(mint.json.token), 'raw token is never listed');

        // Publishing: without a token → 401; with id's token → 200
        assert.strictEqual((await httpRequest(srv.port, 'PUT', '/notify/u1', { body: '123456' })).status, 401);
        const pub = await httpRequest(srv.port, 'PUT', '/notify/u1', { headers: { authorization: 'Bearer ' + mint.json.token, title: 'TYO ID code' }, body: '123456 — expires in 5 min' });
        assert.strictEqual(pub.status, 200, pub.body);

        // Revoke (owner-signed) → the token stops working
        const rev = await httpRequest(srv.port, 'DELETE', '/notify/u1/publishers/' + mint.json.token_id, { headers: proofHeaders(kp.privateKey, 'publishers-revoke', { topic: 'u1', token_id: mint.json.token_id }) });
        assert.strictEqual(rev.status, 200); assert.strictEqual(rev.json.revoked, true);
        assert.strictEqual((await httpRequest(srv.port, 'PUT', '/notify/u1', { headers: { authorization: 'Bearer ' + mint.json.token }, body: 'again' })).status, 401);
    } finally { await srv.finish(); }
});

test('expires: carried on the message and the push payload; the ring never replays an expired message; bad values are 400', async () => {
    const srv = await startNotify();
    try {
        await httpRequest(srv.port, 'POST', '/notify/e1/register', { body: { transport: 'null', token: 'tok-e1', app_id: 'demo' } });
        const before = Math.floor(Date.now() / 1000);
        // A 3 s window: with a 1 s expiry the first poll could land after expiry
        // under full-suite load (flaked twice on 2026-11-17). The "expired" poll
        // waits for the ABSOLUTE expiry the broker returned, not a fixed sleep.
        const r = await httpRequest(srv.port, 'PUT', '/notify/e1', { headers: { 'x-tyo-expires': '3', 'x-tyo-push': 'content' }, body: '654321' });
        assert.strictEqual(r.status, 200, r.body);
        assert.ok(r.json.expires >= before + 3 && r.json.expires <= before + 4, 'expires is absolute unix seconds: ' + r.json.expires);
        await delay(150);
        assert.strictEqual(String(srv.nt.sent[0].payload.expires), String(r.json.expires), 'push payload carries expires');

        let since = await httpRequest(srv.port, 'GET', '/notify/e1/json?since=all&poll=1');
        assert.strictEqual(since.status, 200, 'since: ' + since.status + ' ' + since.body);
        assert.ok(Date.now() / 1000 >= r.json.expires || since.body.includes('654321'), 'still valid → replayed; got: ' + since.body);
        await delay(Math.max(0, (r.json.expires + 1) * 1000 - Date.now()) + 100);
        since = await httpRequest(srv.port, 'GET', '/notify/e1/json?since=all&poll=1');
        assert.ok(!since.body.includes('654321'), 'expired → not replayed');

        // Absolute form, JSON-body form
        const abs = Math.floor(Date.now() / 1000) + 300;
        const j = await httpRequest(srv.port, 'POST', '/notify', { body: { topic: 'e1', message: 'abs', expires: abs } });
        assert.strictEqual(j.status, 200, j.body); assert.strictEqual(j.json.expires, abs);

        for (const bad of ['-5', 'abc', '0', String(8 * 24 * 3600), String(Math.floor(Date.now() / 1000) - 10)])
            assert.strictEqual((await httpRequest(srv.port, 'PUT', '/notify/e1', { headers: { 'x-tyo-expires': bad }, body: 'x' })).status, 400, 'expires=' + bad);
    } finally { await srv.finish(); }
});

test('delivery: X-Tyo-Delivery: wait reports sse/push results; default path response is unchanged', async () => {
    const srv = await startNotify();
    try {
        // No device yet → skipped no-endpoints; default (no wait) carries no `delivery`
        let r = await httpRequest(srv.port, 'PUT', '/notify/d1', { body: 'plain' });
        assert.strictEqual(r.status, 200); assert.strictEqual(r.json.delivery, undefined);
        r = await httpRequest(srv.port, 'PUT', '/notify/d1', { headers: { 'x-tyo-delivery': 'wait' }, body: 'nobody home' });
        assert.strictEqual(r.status, 200, r.body);
        assert.deepStrictEqual(r.json.delivery, { sse: 0, push: { targeted: 0, accepted: 0, failed: [], skipped: 'no-endpoints' } });

        // One healthy device → accepted 1
        await httpRequest(srv.port, 'POST', '/notify/d1/register', { body: { transport: 'null', token: 'ok-dev', app_id: 'demo' } });
        r = await httpRequest(srv.port, 'PUT', '/notify/d1', { headers: { 'x-tyo-delivery': 'wait', 'x-tyo-push': 'content' }, body: '111222' });
        assert.strictEqual(r.status, 200, r.body);
        assert.deepStrictEqual(r.json.delivery, { sse: 0, push: { targeted: 1, accepted: 1, failed: [] } });

        // A device the transport reports GONE → failed[gone], pruned; accepted stays 1 for the healthy one
        await httpRequest(srv.port, 'POST', '/notify/d1/register', { body: { transport: 'null', token: 'dead-dev', app_id: 'demo' } });
        srv.nt._gone.add('dead-dev');
        r = await httpRequest(srv.port, 'PUT', '/notify/d1', { headers: { 'x-tyo-delivery': 'wait' }, body: '333444' });
        assert.strictEqual(r.json.delivery.push.targeted, 2);
        assert.strictEqual(r.json.delivery.push.accepted, 1);
        assert.deepStrictEqual(r.json.delivery.push.failed, [{ transport: 'null', reason: 'gone' }]);
        r = await httpRequest(srv.port, 'PUT', '/notify/d1', { headers: { 'x-tyo-delivery': 'wait' }, body: 'after prune' });
        assert.strictEqual(r.json.delivery.push.targeted, 1, 'gone endpoint was pruned');

        // push=off → skipped off
        r = await httpRequest(srv.port, 'PUT', '/notify/d1', { headers: { 'x-tyo-delivery': 'wait', 'x-tyo-push': 'off' }, body: 'quiet' });
        assert.deepStrictEqual(r.json.delivery.push, { targeted: 0, accepted: 0, failed: [], skipped: 'off' });
    } finally { await srv.finish(); }
});

test('sender: a display name rides on the message and the push payload (both modes), bounded to 64 chars; absent when not given', async () => {
    const srv = await startNotify();
    try {
        await httpRequest(srv.port, 'POST', '/notify/s1/register', { body: { transport: 'null', token: 'tok-s1', app_id: 'demo' } });
        let r = await httpRequest(srv.port, 'PUT', '/notify/s1', { headers: { 'x-tyo-sender': 'TYO ID', 'x-tyo-push': 'content', title: 'TYO ID code' }, body: '123456 is your sign-in code' });
        assert.strictEqual(r.status, 200, r.body); assert.strictEqual(r.json.sender, 'TYO ID');
        r = await httpRequest(srv.port, 'POST', '/notify', { body: { topic: 's1', message: 'appointment confirmed', sender: "Queensland Children's Hospital", push: 'wake' } });
        assert.strictEqual(r.status, 200, r.body); assert.strictEqual(r.json.sender, "Queensland Children's Hospital");
        r = await httpRequest(srv.port, 'PUT', '/notify/s1', { headers: { 'x-tyo-sender': 'x'.repeat(200) }, body: 'long' });
        assert.strictEqual(r.json.sender.length, 64);
        r = await httpRequest(srv.port, 'PUT', '/notify/s1', { body: 'plain' });
        assert.strictEqual(r.json.sender, undefined);
        await delay(200);
        const sent = srv.nt.sent;
        assert.strictEqual(sent[0].payload.sender, 'TYO ID', 'content push carries sender');
        assert.strictEqual(sent[1].payload.sender, "Queensland Children's Hospital", 'wake push carries sender too');
        assert.strictEqual(sent[1].payload.wake, '1');
        const since = await httpRequest(srv.port, 'GET', '/notify/s1/json?since=all&poll=1');
        assert.ok(since.body.includes('"sender":"TYO ID"'), 'ring/catch-up carries sender');
    } finally { await srv.finish(); }
});

run();
