/**
 * Error-tolerant persistence: when storage is 'redis' with a configured
 * fallback, an unreachable Redis at startup must fall back to disk (sqlite)
 * instead of leaving the broker with broken durability. See
 * lib/storage/index.js createStoreAsync + lib/storage/redis.js probe().
 *
 * Usage: node tests/storage-fallback.test.js
 */

'use strict';

const assert = require('assert');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { test, run } = require('./runner');
const Storage = require('../lib/storage');

// A port with nothing listening → Redis is unreachable.
const DEAD_REDIS = 'redis://127.0.0.1:6390';

function tmpSqlite(name) {
    return path.join(os.tmpdir(), 'tyo-mq-fallback-' + name + '-' + process.pid + '.sqlite');
}

test('redis unreachable at startup falls back to sqlite and stays durable', async () => {
    const file = tmpSqlite('a');
    const res = await Storage.createStoreAsync({
        storage: 'redis',
        storage_options: {
            url: DEAD_REDIS,
            connect_timeout: 400,
            probe_timeout: 800,
            fallback: 'sqlite',
            fallback_filename: file,
            default_ttl: 60,
        },
    });

    assert.strictEqual(res.fellBack, true, 'must report it fell back');
    assert.strictEqual(res.backend, 'sqlite');
    assert.ok(res.error, 'carries the probe failure for logging');

    // The fallback store is a real, working durable queue.
    const id = await res.store.enqueue('realm1', 'evt', { consumer_id: 'c1', payload: { hi: 1 }, producer: 'p1' });
    assert.ok(id, 'enqueue returns a message id');
    const msgs = await res.store.dequeue('realm1', 'evt', 'c1');
    assert.strictEqual(msgs.length, 1);
    assert.deepStrictEqual(msgs[0].message, { hi: 1 });

    if (res.store.close) await res.store.close();
    try { fs.unlinkSync(file); } catch (e) { /* ignore */ }
});

test('non-redis storage resolves synchronously with no probe', async () => {
    const res = await Storage.createStoreAsync({ storage: 'memory' });
    assert.strictEqual(res.fellBack, false);
    assert.strictEqual(res.backend, 'memory');
    const id = await res.store.enqueue('r', 'e', { consumer_id: 'c', payload: { a: 1 }, producer: 'p' });
    assert.ok(id);
});

test('redis WITHOUT a fallback constructs crash-safe (error handler attached)', async () => {
    // No fallback ⇒ current behaviour: a RedisStore is returned. Constructing
    // it must not throw and its 'error' events must not crash the process even
    // when the server is dead — the broker treats Redis as best-effort.
    const res = await Storage.createStoreAsync({
        storage: 'redis',
        storage_options: { url: DEAD_REDIS, connect_timeout: 300 },
    });
    assert.strictEqual(res.backend, 'redis');
    assert.strictEqual(res.fellBack, false);
    if (res.store.close) await res.store.close();
});

run();
