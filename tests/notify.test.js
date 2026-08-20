/**
 * TYO Notify N1 — public ntfy-style publish (PUT|POST /notify/{topic}).
 *
 * OFF by default; enabled per-instance with `notify: { enabled: true }` (or
 * TYO_MQ_NOTIFY=1). Publish is PUBLIC (no token) but confined to the reserved
 * `notify` realm; it injects into the SAME routing a socket PRODUCE uses, so a
 * socket subscriber on the notify realm receives the ntfy-shaped message.
 *
 * Usage: node tests/notify.test.js
 */

'use strict';

const assert = require('assert');
const http = require('http');
const { test, run } = require('./runner');
const Factory = require('tyo-mq-client').Factory;
const { startServer, delay } = require('./helpers');

function httpRequest(port, method, pathname, opts) {
    opts = opts || {};
    return new Promise((resolve) => {
        const payload = opts.body === undefined
            ? ''
            : (Buffer.isBuffer(opts.body) ? opts.body
                : (typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body)));
        const headers = Object.assign({}, opts.headers || {});
        headers['content-length'] = Buffer.byteLength(payload);
        const req = http.request({
            host: '127.0.0.1', port, path: pathname, method, headers, timeout: 3000
        }, (res) => {
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

// A consumer must be realm-bound (socket subscription needs a realm); publish
// stays public. Auth here only scopes the *subscriber* to the notify realm.
const AUTH = {
    enabled: true,
    tokens: [{ token: 'sub-notify', realm: 'notify', role: 'consumer' }]
};
function consumerFactory(port) {
    return new Factory({ host: '127.0.0.1', port, protocol: 'http', auth: { token: 'sub-notify' } });
}

// ── feature flag ──────────────────────────────────────────────────────────────
test('POST /notify/{topic} is 404 when the feature flag is off (default)', async () => {
    const server = await startServer({});
    try {
        const res = await httpRequest(server.port, 'POST', '/notify/alerts', { body: 'hi' });
        assert.strictEqual(res.status, 404, JSON.stringify(res));
    } finally {
        await server.close();
    }
});

// ── PUT publish → socket subscriber ───────────────────────────────────────────
test('PUT /notify/{topic} delivers an ntfy-shaped message to a socket subscriber', async () => {
    const server = await startServer({ auth: AUTH, notify: { enabled: true } });
    const client = consumerFactory(server.port);
    let consumer;
    try {
        consumer = await client.createConsumer('notify-put');
        const received = [];
        consumer.subscribe('alerts', function (message, from, ack, obj) {
            received.push({ message, obj });
        }, {});
        await delay(300);

        const res = await httpRequest(server.port, 'PUT', '/notify/alerts', {
            headers: { title: 'Backup', priority: 'high', tags: 'floppy_disk,white_check_mark' },
            body: 'Backup finished'
        });
        assert.strictEqual(res.status, 200, 'expected 200: ' + JSON.stringify(res));
        assert.strictEqual(res.json.message, 'Backup finished');
        assert.strictEqual(res.json.title, 'Backup');
        assert.strictEqual(res.json.priority, 4);
        assert.strictEqual(res.json.event, 'message');
        assert.ok(res.json.id, 'response carries a message id');

        await delay(500);
        assert.strictEqual(received.length, 1, 'subscriber got exactly one: ' + JSON.stringify(received));
        assert.strictEqual(received[0].message.message, 'Backup finished', 'body delivered');
        assert.strictEqual(received[0].message.title, 'Backup', 'title delivered');
        assert.deepStrictEqual(received[0].message.tags, ['floppy_disk', 'white_check_mark']);
        assert.strictEqual(received[0].obj.event, 'alerts', 'topic is the event name');
    } finally {
        if (consumer) consumer.disconnect();
        await server.close();
    }
});

// ── POST path form ────────────────────────────────────────────────────────────
test('POST /notify/{topic} (path form) delivers the raw body as the message', async () => {
    const server = await startServer({ auth: AUTH, notify: { enabled: true } });
    const client = consumerFactory(server.port);
    let consumer;
    try {
        consumer = await client.createConsumer('notify-post');
        const received = [];
        consumer.subscribe('ci', function (message) { received.push(message); }, {});
        await delay(300);

        const res = await httpRequest(server.port, 'POST', '/notify/ci', { body: 'Deploy finished' });
        assert.strictEqual(res.status, 200, JSON.stringify(res));

        await delay(400);
        assert.strictEqual(received.length, 1, JSON.stringify(received));
        assert.strictEqual(received[0].message, 'Deploy finished');
    } finally {
        if (consumer) consumer.disconnect();
        await server.close();
    }
});

// ── JSON publish form ─────────────────────────────────────────────────────────
test('POST /notify (JSON body) publishes with the topic from the body', async () => {
    const server = await startServer({ auth: AUTH, notify: { enabled: true } });
    const client = consumerFactory(server.port);
    let consumer;
    try {
        consumer = await client.createConsumer('notify-json');
        const received = [];
        consumer.subscribe('shop', function (message) { received.push(message); }, {});
        await delay(300);

        const res = await httpRequest(server.port, 'POST', '/notify', {
            headers: { 'content-type': 'application/json' },
            body: { topic: 'shop', message: 'New order', title: 'Order' }
        });
        assert.strictEqual(res.status, 200, JSON.stringify(res));
        assert.strictEqual(res.json.title, 'Order');

        await delay(400);
        assert.strictEqual(received.length, 1, JSON.stringify(received));
        assert.strictEqual(received[0].message, 'New order');
        assert.strictEqual(received[0].title, 'Order');
    } finally {
        if (consumer) consumer.disconnect();
        await server.close();
    }
});

// ── method + validation guards ────────────────────────────────────────────────
test('GET /notify/{topic} is 405 in N1 (subscribe arrives in N2)', async () => {
    const server = await startServer({ notify: { enabled: true } });
    try {
        const res = await httpRequest(server.port, 'GET', '/notify/alerts', {});
        assert.strictEqual(res.status, 405, JSON.stringify(res));
    } finally {
        await server.close();
    }
});

test('PUT /notify with an invalid topic is 400', async () => {
    const server = await startServer({ notify: { enabled: true } });
    try {
        const res = await httpRequest(server.port, 'PUT', '/notify/has%20space', { body: 'x' });
        assert.strictEqual(res.status, 400, JSON.stringify(res));
    } finally {
        await server.close();
    }
});

test('POST /notify with no topic in the JSON body is 400', async () => {
    const server = await startServer({ notify: { enabled: true } });
    try {
        const res = await httpRequest(server.port, 'POST', '/notify', {
            headers: { 'content-type': 'application/json' },
            body: { message: 'no topic here' }
        });
        assert.strictEqual(res.status, 400, JSON.stringify(res));
    } finally {
        await server.close();
    }
});

run();
