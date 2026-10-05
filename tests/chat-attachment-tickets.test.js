/**
 * secure-chat anonymous tier — attachment-capability tickets, end to end.
 *
 * The broker mints a one-shot ticket to an authenticated chat socket
 * (CHAT_TICKET_REQUEST) and the store backend redeems it exactly once over the
 * service-token-gated POST /chat/attachments/verify-ticket. These tests drive
 * both surfaces against a live broker and assert the canonical contract pinned
 * with store-backend (2026-10-05):
 *
 *   - issue over an authenticated socket; upload has no ref, download is ref-bound
 *   - verify is service-token gated (401 on bad/absent token)
 *   - 200 {valid:bool} is the ONLY ticket outcome; a true consumes the one-shot,
 *     a false (unknown/expired/consumed/op-mismatch/ref-mismatch) is uniform and
 *     never burns a live ticket
 *   - non-200 is reserved for faults: 401 token, 400 malformed, 404 unprovisioned,
 *     405 non-POST
 *   - a per-session UPLOAD cap on the broker
 *
 * Usage: node tests/chat-attachment-tickets.test.js
 */

'use strict';

const assert = require('assert');
const http = require('http');
const { test, run } = require('./runner');
const Factory = require('tyo-mq-client').Factory;
const { startServer, delay } = require('./helpers');

const TOKEN = 'chat-broker-service-token-test-value';

function clientOpts(port) {
    return { host: '127.0.0.1', port: port, protocol: 'http' };
}

// Request/response over the socket: the broker acks via the emit callback.
function emitCall(client, event, payload) {
    return new Promise((resolve) => client.socket.emit(event, payload, resolve));
}

function httpRequest(port, method, pathname, opts) {
    opts = opts || {};
    return new Promise((resolve) => {
        const payload = opts.body === undefined ? ''
            : (typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body));
        const headers = Object.assign({}, opts.headers || {});
        headers['content-length'] = Buffer.byteLength(payload);
        const req = http.request({ host: '127.0.0.1', port, path: pathname, method, headers, timeout: 3000 }, (res) => {
            let data = '';
            res.setEncoding('utf8');
            res.on('data', (c) => { data += c; });
            res.on('end', () => {
                let json = null;
                try { json = data ? JSON.parse(data) : null; } catch (e) { /* leave null */ }
                resolve({ status: res.statusCode, body: data, json });
            });
        });
        req.on('timeout', () => { req.destroy(); resolve({ status: null, body: '', json: null }); });
        req.on('error', () => resolve({ status: null, body: '', json: null }));
        req.end(payload);
    });
}

function svc(extra) {
    return Object.assign({ 'x-service-token': TOKEN, 'content-type': 'application/json' }, extra || {});
}

function chatEnabled(extra) {
    return { chat: Object.assign({ service_token: TOKEN }, extra || {}) };
}

test('upload: issue over the socket, verify once (valid:true), then consumed (valid:false)', async () => {
    const srv = await startServer(chatEnabled());
    try {
        const alice = await new Factory(clientOpts(srv.port)).createConsumer('alice');
        await delay(120);

        const issued = await emitCall(alice, 'CHAT_TICKET_REQUEST', { op: 'upload' });
        assert.strictEqual(issued.ok, true, 'ticket issued');
        assert.strictEqual(typeof issued.ticket, 'string');
        assert.ok(issued.expires_in > 0 && issued.expires_in <= 120, 'TTL <= 120s advertised');

        const v1 = await httpRequest(srv.port, 'POST', '/chat/attachments/verify-ticket',
            { headers: svc(), body: { ticket: issued.ticket, op: 'upload' } });
        assert.strictEqual(v1.status, 200);
        assert.deepStrictEqual(v1.json, { valid: true }, 'first redeem is valid');

        const v2 = await httpRequest(srv.port, 'POST', '/chat/attachments/verify-ticket',
            { headers: svc(), body: { ticket: issued.ticket, op: 'upload' } });
        assert.strictEqual(v2.status, 200);
        assert.deepStrictEqual(v2.json, { valid: false }, 'one-shot is consumed');

        alice.disconnect();
    } finally { await srv.close(); }
});

test('download: ticket is ref-bound; a wrong-ref verify is false and does NOT consume it', async () => {
    const srv = await startServer(chatEnabled());
    try {
        const alice = await new Factory(clientOpts(srv.port)).createConsumer('alice');
        await delay(120);

        const issued = await emitCall(alice, 'CHAT_TICKET_REQUEST', { op: 'download', ref: 'blob/real' });
        assert.strictEqual(issued.ok, true);

        const wrong = await httpRequest(srv.port, 'POST', '/chat/attachments/verify-ticket',
            { headers: svc(), body: { ticket: issued.ticket, op: 'download', ref: 'blob/attacker' } });
        assert.deepStrictEqual(wrong.json, { valid: false }, 'wrong ref rejected');

        const right = await httpRequest(srv.port, 'POST', '/chat/attachments/verify-ticket',
            { headers: svc(), body: { ticket: issued.ticket, op: 'download', ref: 'blob/real' } });
        assert.deepStrictEqual(right.json, { valid: true }, 'legit ref still redeems after the probe');

        alice.disconnect();
    } finally { await srv.close(); }
});

test('op mismatch is a uniform valid:false and does NOT consume the ticket', async () => {
    const srv = await startServer(chatEnabled());
    try {
        const alice = await new Factory(clientOpts(srv.port)).createConsumer('alice');
        await delay(120);

        const issued = await emitCall(alice, 'CHAT_TICKET_REQUEST', { op: 'upload' });
        const asDownload = await httpRequest(srv.port, 'POST', '/chat/attachments/verify-ticket',
            { headers: svc(), body: { ticket: issued.ticket, op: 'download', ref: 'blob/x' } });
        assert.deepStrictEqual(asDownload.json, { valid: false }, 'upload ticket presented as download → false');

        const asUpload = await httpRequest(srv.port, 'POST', '/chat/attachments/verify-ticket',
            { headers: svc(), body: { ticket: issued.ticket, op: 'upload' } });
        assert.deepStrictEqual(asUpload.json, { valid: true }, 'still redeemable as upload (probe did not burn it)');

        alice.disconnect();
    } finally { await srv.close(); }
});

test('verify is service-token gated: bad token and absent token both → 401', async () => {
    const srv = await startServer(chatEnabled());
    try {
        const alice = await new Factory(clientOpts(srv.port)).createConsumer('alice');
        await delay(120);
        const issued = await emitCall(alice, 'CHAT_TICKET_REQUEST', { op: 'upload' });

        const badTok = await httpRequest(srv.port, 'POST', '/chat/attachments/verify-ticket',
            { headers: svc({ 'x-service-token': 'wrong-token-of-same-length-aaaaaaaaaaa' }), body: { ticket: issued.ticket, op: 'upload' } });
        assert.strictEqual(badTok.status, 401, 'wrong token is 401');

        const noTok = await httpRequest(srv.port, 'POST', '/chat/attachments/verify-ticket',
            { headers: { 'content-type': 'application/json' }, body: { ticket: issued.ticket, op: 'upload' } });
        assert.strictEqual(noTok.status, 401, 'absent token is 401');

        // The ticket must survive the rejected probes — still redeemable with the real token.
        const ok = await httpRequest(srv.port, 'POST', '/chat/attachments/verify-ticket',
            { headers: svc(), body: { ticket: issued.ticket, op: 'upload' } });
        assert.deepStrictEqual(ok.json, { valid: true });

        alice.disconnect();
    } finally { await srv.close(); }
});

test('malformed verify bodies → 400 (missing op; download without ref)', async () => {
    const srv = await startServer(chatEnabled());
    try {
        const noOp = await httpRequest(srv.port, 'POST', '/chat/attachments/verify-ticket',
            { headers: svc(), body: { ticket: 'anything' } });
        assert.strictEqual(noOp.status, 400, 'missing op is 400');

        const dlNoRef = await httpRequest(srv.port, 'POST', '/chat/attachments/verify-ticket',
            { headers: svc(), body: { ticket: 'anything', op: 'download' } });
        assert.strictEqual(dlNoRef.status, 400, 'download verify without a ref is 400');
    } finally { await srv.close(); }
});

test('feature unprovisioned: verify → 404 and socket issue → {ok:false, 404}', async () => {
    const srv = await startServer({}); // no chat config at all
    try {
        const verify = await httpRequest(srv.port, 'POST', '/chat/attachments/verify-ticket',
            { headers: { 'x-service-token': TOKEN, 'content-type': 'application/json' }, body: { ticket: 't', op: 'upload' } });
        assert.strictEqual(verify.status, 404, 'no token provisioned → endpoint does not exist');

        const alice = await new Factory(clientOpts(srv.port)).createConsumer('alice');
        await delay(120);
        const issue = await emitCall(alice, 'CHAT_TICKET_REQUEST', { op: 'upload' });
        assert.strictEqual(issue.ok, false);
        assert.strictEqual(issue.code, 404, 'socket issue also reports not-enabled');
        alice.disconnect();
    } finally { await srv.close(); }
});

test('non-POST to the verify endpoint → 405', async () => {
    const srv = await startServer(chatEnabled());
    try {
        const r = await httpRequest(srv.port, 'GET', '/chat/attachments/verify-ticket', { headers: svc() });
        assert.strictEqual(r.status, 405);
    } finally { await srv.close(); }
});

test('socket issue validates op/ref: bad op → 400, download without ref → 400', async () => {
    const srv = await startServer(chatEnabled());
    try {
        const alice = await new Factory(clientOpts(srv.port)).createConsumer('alice');
        await delay(120);

        const badOp = await emitCall(alice, 'CHAT_TICKET_REQUEST', { op: 'delete' });
        assert.strictEqual(badOp.ok, false);
        assert.strictEqual(badOp.code, 400);

        const dlNoRef = await emitCall(alice, 'CHAT_TICKET_REQUEST', { op: 'download' });
        assert.strictEqual(dlNoRef.ok, false);
        assert.strictEqual(dlNoRef.code, 400);

        alice.disconnect();
    } finally { await srv.close(); }
});

test('per-session UPLOAD cap: issuance is throttled on the broker (429 past the cap)', async () => {
    const srv = await startServer(chatEnabled({ upload_cap_per_window: 2 }));
    try {
        const alice = await new Factory(clientOpts(srv.port)).createConsumer('alice');
        await delay(120);

        assert.strictEqual((await emitCall(alice, 'CHAT_TICKET_REQUEST', { op: 'upload' })).ok, true);
        assert.strictEqual((await emitCall(alice, 'CHAT_TICKET_REQUEST', { op: 'upload' })).ok, true);
        const third = await emitCall(alice, 'CHAT_TICKET_REQUEST', { op: 'upload' });
        assert.strictEqual(third.ok, false);
        assert.strictEqual(third.code, 429, 'third upload in-window is capped');

        // Downloads are not throttled by the upload cap.
        const dl = await emitCall(alice, 'CHAT_TICKET_REQUEST', { op: 'download', ref: 'blob/y' });
        assert.strictEqual(dl.ok, true, 'downloads remain available');

        alice.disconnect();
    } finally { await srv.close(); }
});

run();
