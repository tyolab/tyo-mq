/**
 * Rate limits and quotas (opt-in `limits` settings block).
 *
 * Usage: node tests/limits.test.js
 */

'use strict';

const assert = require('assert');
const http = require('http');
const { test, run } = require('./runner');
const Limits = require('../lib/limits');
const { startServer, delay, waitFor } = require('./helpers');
const ioClient = require('socket.io-client');

function connect(port) {
    return new Promise((resolve, reject) => {
        const socket = ioClient(`http://127.0.0.1:${port}`, { transports: ['websocket'], reconnection: false });
        // Capture from creation — connection-time RATE_LIMITED can arrive
        // before a test gets a chance to attach listeners.
        socket.captured = [];
        socket.onAny((event, data) => socket.captured.push({ event, data }));
        const timer = setTimeout(() => { socket.disconnect(); reject(new Error('connect timeout')); }, 5000);
        socket.on('connect', () => { clearTimeout(timer); resolve(socket); });
        socket.on('connect_error', err => { clearTimeout(timer); reject(err); });
    });
}

function postJson(port, path, body, headers) {
    return new Promise((resolve, reject) => {
        const payload = JSON.stringify(body);
        const req = http.request({
            host: '127.0.0.1', port, path, method: 'POST',
            headers: Object.assign({'content-type': 'application/json', 'content-length': Buffer.byteLength(payload)}, headers || {})
        }, res => {
            let raw = '';
            res.on('data', c => { raw += c; });
            res.on('end', () => resolve({status: res.statusCode, body: raw ? JSON.parse(raw) : {}}));
        });
        req.on('error', reject);
        req.end(payload);
    });
}

// ── unit: the limiter itself ──────────────────────────────────────────────

test('token buckets enforce rate and burst, and refill over time', async () => {
    const limits = new Limits(() => ({ messages_per_second: 1000, message_burst: 2 }));

    assert.strictEqual(limits.produceAllowed('s1', 'default', 10).ok, true);
    assert.strictEqual(limits.produceAllowed('s1', 'default', 10).ok, true);
    const third = limits.produceAllowed('s1', 'default', 10);
    assert.strictEqual(third.ok, false);
    assert.strictEqual(third.reason, 'messages_per_second');
    assert.ok(third.retry_after >= 1);

    // Independent sockets have independent buckets.
    assert.strictEqual(limits.produceAllowed('s2', 'default', 10).ok, true);

    // 1000/s refills the bucket almost immediately.
    await delay(30);
    assert.strictEqual(limits.produceAllowed('s1', 'default', 10).ok, true);
});

test('per-realm overrides beat globals; absent values mean unlimited', () => {
    const limits = new Limits(() => ({
        messages_per_second: 1,
        realms: { 'org:vip': { messages_per_second: 500 } }
    }));

    assert.strictEqual(limits.value('default', 'messages_per_second'), 1);
    assert.strictEqual(limits.value('org:vip', 'messages_per_second'), 500);
    assert.strictEqual(limits.value('default', 'bytes_per_second'), Infinity);
    assert.strictEqual(limits.value('default', 'max_queued_per_realm'), Infinity);

    // No config at all -> everything unlimited, checks are no-ops.
    const off = new Limits(() => null);
    assert.strictEqual(off.enabled(), false);
    assert.strictEqual(off.produceAllowed('s', 'r', 1e9).ok, true);
    assert.strictEqual(off.connectionAllowed('1.2.3.4').ok, true);
});

test('byte budget limits large payloads independently of message count', () => {
    const limits = new Limits(() => ({ bytes_per_second: 100, bytes_burst: 100 }));

    assert.strictEqual(limits.produceAllowed('s1', 'default', 60).ok, true);
    const second = limits.produceAllowed('s1', 'default', 60);
    assert.strictEqual(second.ok, false);
    assert.strictEqual(second.reason, 'bytes_per_second');
});

test('connection accounting: concurrent cap and release', () => {
    const limits = new Limits(() => ({ max_connections_per_ip: 2 }));

    assert.strictEqual(limits.connectionAllowed('9.9.9.9').ok, true);
    assert.strictEqual(limits.connectionAllowed('9.9.9.9').ok, true);
    const third = limits.connectionAllowed('9.9.9.9');
    assert.strictEqual(third.ok, false);
    assert.strictEqual(third.reason, 'max_connections_per_ip');

    // Other IPs are unaffected; releasing frees a slot.
    assert.strictEqual(limits.connectionAllowed('8.8.8.8').ok, true);
    limits.releaseConnection('9.9.9.9');
    assert.strictEqual(limits.connectionAllowed('9.9.9.9').ok, true);
});

test('realm creation bucket limits per IP per hour', () => {
    const limits = new Limits(() => ({ realms_per_hour_per_ip: 2 }));
    assert.strictEqual(limits.realmCreationAllowed('1.1.1.1').ok, true);
    assert.strictEqual(limits.realmCreationAllowed('1.1.1.1').ok, true);
    const third = limits.realmCreationAllowed('1.1.1.1');
    assert.strictEqual(third.ok, false);
    assert.strictEqual(third.reason, 'realms_per_hour_per_ip');
    assert.strictEqual(limits.realmCreationAllowed('2.2.2.2').ok, true);
});

// ── end-to-end: the server enforcing them ─────────────────────────────────

test('message flood is limited: burst delivered, excess dropped with RATE_LIMITED', async () => {
    const srv = await startServer({
        limits: { messages_per_second: 1, message_burst: 2 }
    });

    const producerSock = await connect(srv.port);
    const consumerSock = await connect(srv.port);
    try {
        producerSock.emit('PRODUCER', { name: 'flood-p' });
        consumerSock.emit('CONSUMER', { name: 'flood-c' });
        consumerSock.emit('SUBSCRIBE', { event: 'tick', producer: 'flood-p', consumer: 'flood-c' });
        await delay(200);

        let received = 0;
        consumerSock.on('CONSUME-flood-p-tick', () => { received++; });
        const limited = waitFor(producerSock, 'RATE_LIMITED');

        for (let i = 0; i < 6; i++)
            producerSock.emit('PRODUCE', { event: 'tick', message: { i }, from: 'flood-p' });

        const notice = await limited;
        assert.strictEqual(notice.code, 429);
        assert.strictEqual(notice.reason, 'messages_per_second');
        assert.ok(notice.retry_after >= 1);

        await delay(600);
        assert.strictEqual(received, 2, 'only the burst should be delivered');
    } finally {
        producerSock.disconnect();
        consumerSock.disconnect();
        await srv.close();
    }
});

test('per-realm override lifts the global limit for that realm', async () => {
    const srv = await startServer({
        limits: {
            messages_per_second: 1,
            message_burst: 1,
            realms: { 'default': { messages_per_second: 1000, message_burst: 1000 } }
        }
    });

    const producerSock = await connect(srv.port);
    const consumerSock = await connect(srv.port);
    try {
        producerSock.emit('PRODUCER', { name: 'vip-p' });
        consumerSock.emit('CONSUMER', { name: 'vip-c' });
        consumerSock.emit('SUBSCRIBE', { event: 'tick', producer: 'vip-p', consumer: 'vip-c' });
        await delay(200);

        let received = 0;
        consumerSock.on('CONSUME-vip-p-tick', () => { received++; });
        for (let i = 0; i < 5; i++)
            producerSock.emit('PRODUCE', { event: 'tick', message: { i }, from: 'vip-p' });

        await delay(500);
        assert.strictEqual(received, 5, 'override should allow the full batch');
    } finally {
        producerSock.disconnect();
        consumerSock.disconnect();
        await srv.close();
    }
});

test('per-IP concurrent connection cap disconnects the excess socket', async () => {
    const srv = await startServer({
        limits: { max_connections_per_ip: 2 }
    });

    const first = await connect(srv.port);
    const second = await connect(srv.port);
    const third = await connect(srv.port);
    try {
        await waitFor(third, 'disconnect'); // server drops it ~100ms after the notice
        const notice = third.captured.filter(e => e.event === 'RATE_LIMITED')[0];
        assert.ok(notice, 'RATE_LIMITED must arrive before the disconnect');
        assert.strictEqual(notice.data.reason, 'max_connections_per_ip');

        // Releasing a slot lets a new connection in.
        first.disconnect();
        await delay(200);
        const fourth = await connect(srv.port);
        fourth.emit('PING', {}, () => {});
        await delay(100);
        assert.strictEqual(fourth.connected, true);
        fourth.disconnect();
    } finally {
        first.disconnect();
        second.disconnect();
        third.disconnect();
        await srv.close();
    }
});

test('subscription and registration quotas reject the excess', async () => {
    const srv = await startServer({
        limits: { max_subscriptions_per_socket: 2, max_registrations_per_realm: 3 }
    });

    const consumerSock = await connect(srv.port);
    try {
        consumerSock.emit('CONSUMER', { name: 'quota-c' });
        consumerSock.emit('SUBSCRIBE', { event: 'a', producer: 'p', consumer: 'quota-c' });
        consumerSock.emit('SUBSCRIBE', { event: 'b', producer: 'p', consumer: 'quota-c' });
        const limited = waitFor(consumerSock, 'RATE_LIMITED');
        consumerSock.emit('SUBSCRIBE', { event: 'c', producer: 'p', consumer: 'quota-c' });
        assert.strictEqual((await limited).reason, 'max_subscriptions_per_socket');

        // Realm-wide registration cap of 3: the consumer above is already
        // one registration, so two producers fit and the third is refused.
        const extras = [];
        for (let i = 0; i < 3; i++) {
            const sock = await connect(srv.port);
            extras.push(sock);
            sock.emit('PRODUCER', { name: 'quota-p' + i });
        }
        await delay(300);
        const regNotice = extras[2].captured.filter(e => e.event === 'RATE_LIMITED')[0];
        assert.ok(regNotice, 'third producer registration must be limited');
        assert.strictEqual(regNotice.data.reason, 'max_registrations_per_realm');
        assert.strictEqual(extras[0].captured.filter(e => e.event === 'RATE_LIMITED').length, 0,
            'earlier registrations must be unaffected');

        extras.forEach(sock => sock.disconnect());
    } finally {
        consumerSock.disconnect();
        await srv.close();
    }
});

test('durable queue depth is capped per realm', async () => {
    const srv = await startServer({
        limits: { max_queued_per_realm: 2 }
    });

    const producerSock = await connect(srv.port);
    const consumerSock = await connect(srv.port);
    try {
        producerSock.emit('PRODUCER', { name: 'queue-p' });
        consumerSock.emit('CONSUMER', { name: 'queue-c' });
        consumerSock.emit('SUBSCRIBE', { event: 'job', producer: 'queue-p', consumer: 'queue-c', durable: true });
        await delay(200);
        consumerSock.disconnect(); // go offline so messages queue
        await delay(200);

        for (let i = 0; i < 5; i++)
            producerSock.emit('PRODUCE', { event: 'job', message: { i }, from: 'queue-p' });
        await delay(500);

        const queued = await srv.server.store.countQueued('default');
        assert.strictEqual(queued, 2, 'queue must stop at the cap');
    } finally {
        producerSock.disconnect();
        await srv.close();
    }
});

test('POST /api/realms is rate limited per IP', async () => {
    const srv = await startServer({
        auth: {
            enabled: true,
            auto_admin_token: false,
            tokens: [{ token: 'limits-admin', realm: '*', role: 'admin' }],
            management_tokens: [{ token: 'mgmt-tok', realm_prefix: 'play:' }]
        },
        http_api: { enabled: true },
        limits: { realms_per_hour_per_ip: 2 }
    });

    try {
        const headers = { authorization: 'Bearer mgmt-tok' };
        const first = await postJson(srv.port, '/api/realms', { realm: 'play:one', manager_key: 'k1' }, headers);
        assert.strictEqual(first.status, 200);
        const second = await postJson(srv.port, '/api/realms', { realm: 'play:two', manager_key: 'k2' }, headers);
        assert.strictEqual(second.status, 200);
        const third = await postJson(srv.port, '/api/realms', { realm: 'play:three', manager_key: 'k3' }, headers);
        assert.strictEqual(third.status, 429);
        assert.ok(third.body.retry_after >= 1);
    } finally {
        await srv.close();
    }
});

test('pending authorization requests are capped', async () => {
    const srv = await startServer({
        auth: {
            enabled: true,
            auto_admin_token: false,
            tokens: [{ token: 'limits-admin', realm: '*', role: 'admin' }]
        },
        limits: { max_pending_authorization_requests: 2 }
    });

    const sock = await connect(srv.port);
    try {
        for (let i = 0; i < 2; i++) {
            const ok = waitFor(sock, 'AUTHORIZATION_REQUEST_OK');
            sock.emit('AUTHORIZATION_REQUEST', {
                realm: 'org:x', client_id: 'client-' + i, client_name: 'C' + i, client_token: 'tok-' + i
            });
            await ok;
        }

        const fail = waitFor(sock, 'AUTHORIZATION_REQUEST_FAIL');
        sock.emit('AUTHORIZATION_REQUEST', {
            realm: 'org:x', client_id: 'client-extra', client_name: 'Extra', client_token: 'tok-extra'
        });
        assert.strictEqual((await fail).code, 429);
    } finally {
        sock.disconnect();
        await srv.close();
    }
});

test('without a limits block, floods pass untouched (inert by default)', async () => {
    const srv = await startServer({});

    const producerSock = await connect(srv.port);
    const consumerSock = await connect(srv.port);
    try {
        producerSock.emit('PRODUCER', { name: 'free-p' });
        consumerSock.emit('CONSUMER', { name: 'free-c' });
        consumerSock.emit('SUBSCRIBE', { event: 'tick', producer: 'free-p', consumer: 'free-c' });
        await delay(200);

        let received = 0;
        consumerSock.on('CONSUME-free-p-tick', () => { received++; });
        for (let i = 0; i < 20; i++)
            producerSock.emit('PRODUCE', { event: 'tick', message: { i }, from: 'free-p' });

        await delay(500);
        assert.strictEqual(received, 20);
    } finally {
        producerSock.disconnect();
        consumerSock.disconnect();
        await srv.close();
    }
});

run();
