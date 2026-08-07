/**
 * P4b-1: authenticated HTTP publish endpoint — POST /pub/:realm/:event.
 *
 * The endpoint is OFF by default; it is enabled per-instance with
 * `http_publish: { enabled: true }` (or the TYO_MQ_HTTP_PUBLISH_ENABLED=1 env
 * var). A publish injects into the SAME routing a socket PRODUCE uses, so a
 * socket consumer receives it identically and `?guaranteed=1` durably enqueues
 * for an offline consumer.
 *
 * Usage: node tests/http-publish.test.js
 */

'use strict';

const assert = require('assert');
const http = require('http');
const { test, run } = require('./runner');
const Factory = require('tyo-mq-client').Factory;
const { startServer, delay } = require('./helpers');

// ── HTTP helper ─────────────────────────────────────────────────────────────
function httpRequest(port, method, pathname, opts) {
    opts = opts || {};
    return new Promise((resolve) => {
        const payload = opts.body === undefined
            ? ''
            : (Buffer.isBuffer(opts.body) ? opts.body
                : (typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body)));
        const headers = Object.assign({}, opts.headers || {});
        if (payload.length !== undefined)
            headers['content-length'] = Buffer.byteLength(payload);
        const req = http.request({
            host: '127.0.0.1',
            port: port,
            path: pathname,
            method: method,
            headers: headers,
            timeout: 3000
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

function bearer(token) {
    return { 'authorization': 'Bearer ' + token };
}

const AUTH = {
    enabled: true,
    tokens: [
        { token: 'pub-acme', realm: 'acme', role: 'producer' },
        { token: 'sub-acme', realm: 'acme', role: 'consumer' },
        { token: 'pub-other', realm: 'other', role: 'producer' }
    ]
};

function consumerFactory(port, token) {
    return new Factory({ host: '127.0.0.1', port: port, protocol: 'http', auth: { token: token } });
}

// ── feature flag: OFF by default ─────────────────────────────────────────────
test('POST /pub is 404 when the feature flag is off (default)', async () => {
    const server = await startServer({ auth: AUTH });
    try {
        const res = await httpRequest(server.port, 'POST', '/pub/acme/notify', {
            headers: Object.assign({ 'content-type': 'application/json' }, bearer('pub-acme')),
            body: { hello: 'world' }
        });
        assert.strictEqual(res.status, 404, 'endpoint must not exist when disabled: ' + JSON.stringify(res));
    } finally {
        await server.close();
    }
});

// ── publish → live socket subscriber ─────────────────────────────────────────
test('POST /pub delivers to a live socket subscriber with content-type preserved', async () => {
    const server = await startServer({ auth: AUTH, http_publish: { enabled: true } });
    const client = consumerFactory(server.port, 'sub-acme');
    let consumer;
    try {
        consumer = await client.createConsumer('http-pub-consumer');
        const received = [];
        // 3-arg form (event, cb, options) subscribes to the event from ANY
        // producer — the HTTP publisher's synthetic producer name is unknown.
        consumer.subscribe('notify', function (message, from, ack, obj) {
            received.push({ message: message, from: from, obj: obj });
        }, {});
        await delay(300);

        const res = await httpRequest(server.port, 'POST', '/pub/acme/notify', {
            headers: Object.assign({ 'content-type': 'application/json' }, bearer('pub-acme')),
            body: { hello: 'world', n: 42 }
        });
        assert.strictEqual(res.status, 202, 'expected 202: ' + JSON.stringify(res));
        assert.strictEqual(res.json.ok, true);
        assert.ok(res.json.msg_id, 'response carries a msg_id');

        await delay(500);
        assert.strictEqual(received.length, 1, 'consumer received exactly one message: ' + JSON.stringify(received));
        assert.deepStrictEqual(received[0].message, { hello: 'world', n: 42 }, 'payload delivered intact');
        assert.strictEqual(received[0].obj.event, 'notify', 'event name preserved');
        assert.strictEqual(received[0].obj.content_type, 'application/json', 'content-type echoed to subscriber');
    } finally {
        if (consumer) consumer.disconnect();
        await server.close();
    }
});

// ── ?event= form ─────────────────────────────────────────────────────────────
test('POST /pub/:realm with ?event= delivers to a live subscriber', async () => {
    const server = await startServer({ auth: AUTH, http_publish: { enabled: true } });
    const client = consumerFactory(server.port, 'sub-acme');
    let consumer;
    try {
        consumer = await client.createConsumer('http-pub-query-consumer');
        const received = [];
        consumer.subscribe('alerts', function (message) { received.push(message); }, {});
        await delay(300);

        const res = await httpRequest(server.port, 'POST', '/pub/acme?event=alerts', {
            headers: Object.assign({ 'content-type': 'text/plain' }, bearer('pub-acme')),
            body: 'plain-text-body'
        });
        assert.strictEqual(res.status, 202, JSON.stringify(res));

        await delay(500);
        assert.strictEqual(received.length, 1, JSON.stringify(received));
        assert.strictEqual(received[0], 'plain-text-body');
    } finally {
        if (consumer) consumer.disconnect();
        await server.close();
    }
});

// ── auth ─────────────────────────────────────────────────────────────────────
test('POST /pub without a token is 401', async () => {
    const server = await startServer({ auth: AUTH, http_publish: { enabled: true } });
    try {
        const res = await httpRequest(server.port, 'POST', '/pub/acme/notify', {
            headers: { 'content-type': 'application/json' },
            body: { x: 1 }
        });
        assert.strictEqual(res.status, 401, JSON.stringify(res));
    } finally {
        await server.close();
    }
});

test('POST /pub with an invalid token is 401', async () => {
    const server = await startServer({ auth: AUTH, http_publish: { enabled: true } });
    try {
        const res = await httpRequest(server.port, 'POST', '/pub/acme/notify', {
            headers: Object.assign({ 'content-type': 'application/json' }, bearer('not-a-real-token')),
            body: { x: 1 }
        });
        assert.strictEqual(res.status, 401, JSON.stringify(res));
    } finally {
        await server.close();
    }
});

test('POST /pub with a valid token for another realm is 403', async () => {
    const server = await startServer({ auth: AUTH, http_publish: { enabled: true } });
    try {
        // pub-other is a valid token, but scoped to realm 'other' — publishing to
        // realm 'acme' must be forbidden.
        const res = await httpRequest(server.port, 'POST', '/pub/acme/notify', {
            headers: Object.assign({ 'content-type': 'application/json' }, bearer('pub-other')),
            body: { x: 1 }
        });
        assert.strictEqual(res.status, 403, JSON.stringify(res));
    } finally {
        await server.close();
    }
});

// ── guaranteed → offline durable consumer ────────────────────────────────────
test('POST /pub?guaranteed=1 durably enqueues for an offline consumer', async () => {
    const server = await startServer({ auth: AUTH, http_publish: { enabled: true } });
    const client = consumerFactory(server.port, 'sub-acme');
    let firstConsumer;
    let secondConsumer;
    try {
        firstConsumer = await client.createConsumer('http-durable-consumer');
        firstConsumer.subscribe('jobs', function () {}, { durable: true });
        await delay(300);

        firstConsumer.disconnect();
        await delay(500);

        const res = await httpRequest(server.port, 'POST', '/pub/acme/jobs?guaranteed=1', {
            headers: Object.assign({ 'content-type': 'application/json' }, bearer('pub-acme')),
            body: { task: 'offline-work' }
        });
        assert.strictEqual(res.status, 202, JSON.stringify(res));
        await delay(300);

        secondConsumer = await client.createConsumer('http-durable-consumer');
        const received = await new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('timeout waiting for durable replay')), 4000);
            secondConsumer.subscribe('jobs', (data) => {
                clearTimeout(timer);
                resolve(data);
            }, { durable: true });
        });
        assert.deepStrictEqual(received, { task: 'offline-work' });
    } finally {
        if (secondConsumer) secondConsumer.disconnect();
        if (firstConsumer) firstConsumer.disconnect();
        await server.close();
    }
});

// ── body-size cap ────────────────────────────────────────────────────────────
test('POST /pub with an oversize body is 413 and nothing is published', async () => {
    const server = await startServer({ auth: AUTH, http_publish: { enabled: true } });
    const client = consumerFactory(server.port, 'sub-acme');
    let consumer;
    try {
        consumer = await client.createConsumer('http-oversize-consumer');
        const received = [];
        consumer.subscribe('big', function (message) { received.push(message); }, {});
        await delay(300);

        // 128 KiB > the 64 KiB cap.
        const huge = 'x'.repeat(128 * 1024);
        const res = await httpRequest(server.port, 'POST', '/pub/acme/big', {
            headers: Object.assign({ 'content-type': 'text/plain' }, bearer('pub-acme')),
            body: huge
        });
        assert.strictEqual(res.status, 413, JSON.stringify({ status: res.status }));

        await delay(400);
        assert.strictEqual(received.length, 0, 'oversize publish must not deliver anything');
    } finally {
        if (consumer) consumer.disconnect();
        await server.close();
    }
});

// ── method / route ───────────────────────────────────────────────────────────
test('GET /pub is 405 (method not allowed)', async () => {
    const server = await startServer({ auth: AUTH, http_publish: { enabled: true } });
    try {
        const res = await httpRequest(server.port, 'GET', '/pub/acme/notify', {
            headers: bearer('pub-acme')
        });
        assert.strictEqual(res.status, 405, JSON.stringify(res));
    } finally {
        await server.close();
    }
});

test('POST /pub with a missing event is 400', async () => {
    const server = await startServer({ auth: AUTH, http_publish: { enabled: true } });
    try {
        // /pub/:realm with no ?event= and no event segment.
        const res = await httpRequest(server.port, 'POST', '/pub/acme', {
            headers: Object.assign({ 'content-type': 'application/json' }, bearer('pub-acme')),
            body: { x: 1 }
        });
        assert.strictEqual(res.status, 400, JSON.stringify(res));
    } finally {
        await server.close();
    }
});

run();
