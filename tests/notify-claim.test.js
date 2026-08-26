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
const notifyAuth = require('../lib/notify-auth');
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
    const base = notifyAuth.signatureBase('claim', body, now, nonce);
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

test('claim succeeds but push_registered is false when no push transport is configured', async () => {
    const server = await startServer({ notify: { enabled: true }, notify_store: { filename: tmpNotifyStoreFile() } });
    try {
        const { pubkey, privateKey } = genKeyPair();
        const res = await httpRequest(server.port, 'POST', '/notify/contact-tyo/claim', {
            body: claimBody(privateKey, 'contact-tyo', { pubkey, transport: 'null', token: 'dev-token' })
        });
        assert.strictEqual(res.status, 200, JSON.stringify(res));
        assert.strictEqual(res.json.push_registered, false, 'topic ownership still succeeds even though push delivery is not wired up');
    } finally {
        await server.close();
    }
});

test('claim reports push_registered:true once the transport is actually configured', async () => {
    const prevTransport = process.env.TYO_MQ_PUSH_TRANSPORT;
    process.env.TYO_MQ_PUSH_TRANSPORT = 'null';
    const server = await startServer({ notify: { enabled: true }, notify_store: { filename: tmpNotifyStoreFile() } });
    try {
        const { pubkey, privateKey } = genKeyPair();
        const res = await httpRequest(server.port, 'POST', '/notify/contact-tyo/claim', {
            body: claimBody(privateKey, 'contact-tyo', { pubkey, transport: 'null', token: 'dev-token' })
        });
        assert.strictEqual(res.status, 200, JSON.stringify(res));
        assert.strictEqual(res.json.push_registered, true);
    } finally {
        await server.close();
        if (prevTransport === undefined) delete process.env.TYO_MQ_PUSH_TRANSPORT;
        else process.env.TYO_MQ_PUSH_TRANSPORT = prevTransport;
    }
});

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

run();
