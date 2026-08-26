/**
 * Per-recipient inbound cap for sealed store-and-forward (#41) +
 * event/consumer-scoped countQueued on all storage backends.
 *
 * Storage level: countQueued(realm[, event[, consumer]]) filters correctly on
 * memory and sqlite; Redis gains countQueued for the most-specific form
 * (realm+event+consumer → ZCARD of the index key) and reports `null` for the
 * realm-wide form it cannot compute cheaply (the server skips that check).
 *
 * Behaviour: SEALED_DELIVER to an offline recipient at the
 * max_queued_per_recipient cap → {ok:false, code:507, 'recipient inbox full'}
 * + tyo_mq_rate_limited_total{reason="max_queued_per_recipient"}; a DIFFERENT
 * identity in the same realm still queues; the realm-wide cap stays the outer
 * bound.
 *
 * Usage: node tests/sealed-recipient-cap.test.js
 */

'use strict';

const assert = require('assert');
const os = require('os');
const path = require('path');
const fs = require('fs');
const http = require('http');
const { test, run } = require('./runner');
const { PrivateKey, ServerCertificate } = require('@signalapp/libsignal-client');
const { startServer, delay } = require('./helpers');
const Factory = require('tyo-mq-client').Factory;

const MemoryStore = require('../lib/storage/memory');
const SQLiteStore = require('../lib/storage/sqlite');
const RedisStore = require('../lib/storage/redis');

// ── storage-level: countQueued scoping ─────────────────────────────────────

async function seedStore(store) {
    // realm r1: 2 for sealed:bob/bob, 1 for sealed:carol/carol, 1 plain job/c1
    await store.enqueue('r1', 'sealed:bob', { consumer_id: 'bob', payload: { n: 1 } });
    await store.enqueue('r1', 'sealed:bob', { consumer_id: 'bob', payload: { n: 2 } });
    await store.enqueue('r1', 'sealed:carol', { consumer_id: 'carol', payload: { n: 3 } });
    await store.enqueue('r1', 'job', { consumer_id: 'c1', payload: { n: 4 } });
    // realm r2: 1 for sealed:bob/bob (must not leak into r1 counts)
    await store.enqueue('r2', 'sealed:bob', { consumer_id: 'bob', payload: { n: 5 } });
}

async function assertScopedCounts(store) {
    assert.strictEqual(await store.countQueued('r1'), 4, 'realm-wide count');
    assert.strictEqual(await store.countQueued('r2'), 1, 'other realm count');
    assert.strictEqual(await store.countQueued('r1', 'sealed:bob'), 2, 'event-scoped count');
    assert.strictEqual(await store.countQueued('r1', 'sealed:carol'), 1, 'event-scoped count (carol)');
    assert.strictEqual(await store.countQueued('r1', 'sealed:bob', 'bob'), 2, 'event+consumer count');
    assert.strictEqual(await store.countQueued('r1', 'sealed:bob', 'nobody'), 0, 'wrong consumer counts zero');
    assert.strictEqual(await store.countQueued('r1', null, 'bob'), 2, 'consumer-only count');
}

test('MemoryStore.countQueued supports optional event/consumer scoping', async () => {
    const store = new MemoryStore({ default_ttl: 60 });
    await seedStore(store);
    await assertScopedCounts(store);
});

test('SQLiteStore.countQueued supports optional event/consumer scoping', async () => {
    const file = path.join(os.tmpdir(), 'tyo-mq-recipient-cap-' + process.pid + '.sqlite');
    const store = new SQLiteStore({ filename: file, default_ttl: 60 });
    try {
        await seedStore(store);
        await assertScopedCounts(store);
    } finally {
        store.close();
        try { fs.unlinkSync(file); } catch (e) { /* ignore */ }
    }
});

test('RedisStore.countQueued: ZCARD for realm+event+consumer, null for realm-wide', async () => {
    const sent = [];
    const stubClient = {
        sendCommand: (args) => {
            sent.push(args);
            if (args[0] === 'ZCARD')
                return Promise.resolve(7);
            return Promise.resolve('OK');
        },
    };
    const store = new RedisStore({ client: stubClient, prefix: 'test:queue' });

    assert.strictEqual(typeof store.countQueued, 'function', 'RedisStore must implement countQueued');

    // Most-specific form → single ZCARD of the exact index key.
    const scoped = await store.countQueued('r1', 'sealed:bob', 'bob');
    assert.strictEqual(scoped, 7);
    assert.strictEqual(sent.length, 1, 'exactly one command for the scoped count');
    assert.strictEqual(sent[0][0], 'ZCARD');
    assert.strictEqual(sent[0][1], store._indexKey('r1', 'sealed:bob', 'bob'));

    // Unscoped / partially-scoped forms cannot be computed cheaply → null,
    // and NO Redis traffic (the server treats null as "skip that check").
    sent.length = 0;
    assert.strictEqual(await store.countQueued('r1'), null, 'realm-wide count is null on Redis');
    assert.strictEqual(await store.countQueued('r1', 'sealed:bob'), null, 'event-only count is null on Redis');
    assert.strictEqual(sent.length, 0, 'no commands issued for uncountable forms');
});

// ── behaviour: SEALED_DELIVER offline path enforcement ─────────────────────

function clientOpts(port) {
    return { host: '127.0.0.1', port: port, protocol: 'http' };
}

function installSealedEnv() {
    const root = PrivateKey.generate();
    const serverKey = PrivateKey.generate();
    const serverCert = ServerCertificate.new(1, serverKey.getPublicKey(), root);
    const prev = { c: process.env.TYO_MQ_SEALED_SERVER_CERT, k: process.env.TYO_MQ_SEALED_SERVER_KEY };
    process.env.TYO_MQ_SEALED_SERVER_CERT = Buffer.from(serverCert.serialize()).toString('base64');
    process.env.TYO_MQ_SEALED_SERVER_KEY = Buffer.from(serverKey.serialize()).toString('base64');
    return {
        restore: () => {
            process.env.TYO_MQ_SEALED_SERVER_CERT = prev.c;
            process.env.TYO_MQ_SEALED_SERVER_KEY = prev.k;
        },
    };
}

function sealedCall(client, event, payload) {
    return new Promise((resolve) => client.socket.emit(event, payload, resolve));
}

function httpGet(port, pathname) {
    return new Promise((resolve) => {
        const req = http.get({ host: '127.0.0.1', port, path: pathname, timeout: 1500 }, (res) => {
            let body = '';
            res.setEncoding('utf8');
            res.on('data', (chunk) => { body += chunk; });
            res.on('end', () => resolve({ status: res.statusCode, body }));
        });
        req.on('timeout', () => { req.destroy(); resolve({ status: null, body: '' }); });
        req.on('error', () => resolve({ status: null, body: '' }));
    });
}

// Register an identity in unrestricted mode, then disconnect it (offline).
async function provisionOfflineIdentity(port, identity) {
    const sock = await new Factory(clientOpts(port)).createConsumer(identity);
    await delay(150);
    const set = await sealedCall(sock, 'SEALED_UAK_SET', { identity, mode: 'unrestricted' });
    assert.strictEqual(set.ok, true);
    sock.disconnect();
    await delay(150);
}

function deliver(anon, identity, msgId) {
    return sealedCall(anon, 'SEALED_DELIVER', {
        to: { realm: 'default', identity },
        blob: Buffer.from('x-' + msgId).toString('base64'),
        msg_id: msgId,
    });
}

test('offline SEALED_DELIVER is capped per recipient (507 recipient inbox full), other identities unaffected, metric increments', async () => {
    const env = installSealedEnv();
    const srv = await startServer({
        auth: { realms: { default: { e2ee: 'required' } } },
        limits: { enabled: true, max_queued_per_recipient: 3 },
        http_api: { enabled: true, metrics_auth: false },
    });
    try {
        await provisionOfflineIdentity(srv.port, 'bob');
        await provisionOfflineIdentity(srv.port, 'carol');

        const anon = await new Factory(clientOpts(srv.port)).createProducer();
        await delay(150);

        // Fill bob's inbox to the cap.
        for (let i = 1; i <= 3; i++) {
            const q = await deliver(anon, 'bob', 'b' + i);
            assert.strictEqual(q.ok, true, 'message ' + i + ' queues');
            assert.strictEqual(q.delivered, 'queued');
        }

        // 4th → refused with the per-recipient error.
        const overflow = await deliver(anon, 'bob', 'b4');
        assert.strictEqual(overflow.ok, false);
        assert.strictEqual(overflow.code, 507);
        assert.strictEqual(overflow.message, 'recipient inbox full');

        // A DIFFERENT identity in the same realm still queues fine.
        const other = await deliver(anon, 'carol', 'c1');
        assert.strictEqual(other.ok, true, 'carol must not be starved by bob\'s full inbox');
        assert.strictEqual(other.delivered, 'queued');

        // bob stays refused (cap is not consumed by the refusal).
        const again = await deliver(anon, 'bob', 'b5');
        assert.strictEqual(again.ok, false);
        assert.strictEqual(again.code, 507);

        // Store agrees: bob at cap, carol at 1.
        assert.strictEqual(await srv.server.store.countQueued('default', 'sealed:bob', 'bob'), 3);
        assert.strictEqual(await srv.server.store.countQueued('default', 'sealed:carol', 'carol'), 1);

        // Metric: two refusals recorded with the per-recipient reason.
        const metrics = await httpGet(srv.port, '/api/metrics');
        assert.strictEqual(metrics.status, 200);
        assert.ok(/tyo_mq_rate_limited_total\{[^}]*reason="max_queued_per_recipient"[^}]*\} 2/.test(metrics.body),
            'expected tyo_mq_rate_limited_total{reason="max_queued_per_recipient"} 2 in:\n' + metrics.body);
    } finally { await srv.close(); env.restore(); }
});

test('realm-wide cap stays the outer bound (507 recipient queue full before the recipient check)', async () => {
    const env = installSealedEnv();
    const srv = await startServer({
        auth: { realms: { default: { e2ee: 'required' } } },
        limits: { enabled: true, max_queued_per_realm: 1, max_queued_per_recipient: 100 },
    });
    try {
        await provisionOfflineIdentity(srv.port, 'bob');
        await provisionOfflineIdentity(srv.port, 'carol');

        const anon = await new Factory(clientOpts(srv.port)).createProducer();
        await delay(150);

        const first = await deliver(anon, 'bob', 'r1');
        assert.strictEqual(first.ok, true);

        // Realm is full: even a fresh identity is refused with the REALM error.
        const second = await deliver(anon, 'carol', 'r2');
        assert.strictEqual(second.ok, false);
        assert.strictEqual(second.code, 507);
        assert.strictEqual(second.message, 'recipient queue full');
    } finally { await srv.close(); env.restore(); }
});

test('max_queued_per_recipient defaults to 1000 when limits are enabled; explicit 0 disables', () => {
    const Limits = require('../lib/limits');
    const on = new Limits(() => ({ enabled: true }));
    assert.strictEqual(on.value('default', 'max_queued_per_recipient'), 1000);
    // Explicit 0/negative → unlimited, mirroring every other limit key.
    const off = new Limits(() => ({ enabled: true, max_queued_per_recipient: 0 }));
    assert.strictEqual(off.value('default', 'max_queued_per_recipient'), Infinity);
    // Per-realm override wins.
    const override = new Limits(() => ({ enabled: true, realms: { vip: { max_queued_per_recipient: 5 } } }));
    assert.strictEqual(override.value('vip', 'max_queued_per_recipient'), 5);
    assert.strictEqual(override.value('default', 'max_queued_per_recipient'), 1000);
    // Limits disabled entirely → unlimited.
    const disabled = new Limits(() => null);
    assert.strictEqual(disabled.value('default', 'max_queued_per_recipient'), Infinity);
});

run();
