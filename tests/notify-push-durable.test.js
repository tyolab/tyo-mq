/**
 * TYO Notify — durable push registry.
 *
 * Regression for the "cron notifications went silent after a deploy" bug: the
 * notify push registry was in-memory only, so a broker restart wiped every
 * device's registration and no push ever arrived again (publish still 200'd).
 * These tests pin that a registration SURVIVES a simulated restart via the
 * SQLite backing store, and that unregister/TTL don't resurrect stale devices.
 *
 * Usage: node tests/notify-push-durable.test.js
 */

'use strict';

const assert = require('assert');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { test, run } = require('./runner');
const push = require('../lib/push');
const NotifyPushStore = require('../lib/notify-push-store');

function tmpDb() {
    // Unique per test so WAL files never collide between cases.
    return path.join(os.tmpdir(),
        'tyo-notify-push-' + process.pid + '-' + Math.floor(Math.random() * 1e9) + '.sqlite');
}

function cleanup(file) {
    for (const suffix of ['', '-wal', '-shm']) {
        try { fs.unlinkSync(file + suffix); } catch (e) {}
    }
}

const REALM = 'notify';
const TOPIC = 'cron-cac31e';
const EP = { transport: 'fcm', token: 'device-token-abc', app_id: 'notify', min_priority: 3 };

test('a registration survives a simulated broker restart', () => {
    const file = tmpDb();
    try {
        // First "process": register a device.
        const store1 = new NotifyPushStore({ filename: file });
        const reg1 = new push.TokenRegistry({ maxIdentities: 5000, ttlMs: 30 * 24 * 3600 * 1000, store: store1 });
        reg1.register(REALM, TOPIC, EP);
        assert.strictEqual(reg1.list(REALM, TOPIC).length, 1);
        store1.close();

        // Second "process" (restart): a fresh registry over the same file must
        // hydrate the endpoint — the bug was that it came up empty.
        const store2 = new NotifyPushStore({ filename: file });
        const reg2 = new push.TokenRegistry({ maxIdentities: 5000, ttlMs: 30 * 24 * 3600 * 1000, store: store2 });
        const eps = reg2.list(REALM, TOPIC);
        assert.strictEqual(eps.length, 1, 'endpoint should survive restart');
        assert.strictEqual(eps[0].token, EP.token);
        assert.strictEqual(eps[0].transport, 'fcm');
        assert.strictEqual(eps[0].min_priority, 3);
        store2.close();
    } finally {
        cleanup(file);
    }
});

test('unregister is durable — a removed device does not come back on restart', () => {
    const file = tmpDb();
    try {
        const store1 = new NotifyPushStore({ filename: file });
        const reg1 = new push.TokenRegistry({ ttlMs: 30 * 24 * 3600 * 1000, store: store1 });
        reg1.register(REALM, TOPIC, EP);
        const removed = reg1.unregister(REALM, TOPIC, { transport: 'fcm', token: EP.token });
        assert.strictEqual(removed, 1);
        store1.close();

        const store2 = new NotifyPushStore({ filename: file });
        const reg2 = new push.TokenRegistry({ ttlMs: 30 * 24 * 3600 * 1000, store: store2 });
        assert.strictEqual(reg2.list(REALM, TOPIC).length, 0,
            'unregistered device must not resurrect on restart');
        store2.close();
    } finally {
        cleanup(file);
    }
});

test('a stale (past-TTL) row is not hydrated', () => {
    const file = tmpDb();
    try {
        // Write a row directly with an ancient added_at, then hydrate with a
        // short TTL — it must be skipped (and swept from the store).
        const store1 = new NotifyPushStore({ filename: file });
        store1.put(REALM, TOPIC, Object.assign({}, EP, { added_at: 1000 })); // ~1970
        store1.close();

        const store2 = new NotifyPushStore({ filename: file });
        const reg2 = new push.TokenRegistry({ ttlMs: 60 * 1000, store: store2 });
        assert.strictEqual(reg2.list(REALM, TOPIC).length, 0,
            'a device older than the TTL must not be revived');
        assert.strictEqual(store2.all().length, 0, 'stale row should be swept on hydrate');
        store2.close();
    } finally {
        cleanup(file);
    }
});

test('evicting an over-cap identity also removes it from the store', () => {
    const file = tmpDb();
    try {
        // maxIdentities:2 — registering a 3rd topic evicts the least-recently
        // used one, which must be purged from the store too (not resurrected).
        const store1 = new NotifyPushStore({ filename: file });
        const reg1 = new push.TokenRegistry({ maxIdentities: 2, store: store1 });
        reg1.register(REALM, 'topic-a', { transport: 'fcm', token: 'tok-a' });
        reg1.register(REALM, 'topic-b', { transport: 'fcm', token: 'tok-b' });
        reg1.register(REALM, 'topic-c', { transport: 'fcm', token: 'tok-c' }); // evicts topic-a
        assert.strictEqual(reg1.list(REALM, 'topic-a').length, 0, 'topic-a evicted from memory');
        store1.close();

        const store2 = new NotifyPushStore({ filename: file });
        const reg2 = new push.TokenRegistry({ maxIdentities: 2, store: store2 });
        assert.strictEqual(reg2.list(REALM, 'topic-a').length, 0, 'evicted identity must not resurrect');
        assert.strictEqual(reg2.list(REALM, 'topic-c').length, 1);
        store2.close();
    } finally {
        cleanup(file);
    }
});

test('a store-less registry still works (in-memory only, no crash)', () => {
    const reg = new push.TokenRegistry();
    reg.register(REALM, TOPIC, EP);
    assert.strictEqual(reg.list(REALM, TOPIC).length, 1);
    assert.strictEqual(reg.store, null);
});

run();
