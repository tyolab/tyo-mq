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

test('a successful push refreshes the stored timestamp, so an actively-pushed device survives the idle TTL across a restart', () => {
    const file = tmpDb();
    try {
        const DAY = 24 * 3600 * 1000, TTL = 30 * DAY;
        const store1 = new NotifyPushStore({ filename: file });
        const reg1 = new push.TokenRegistry({ ttlMs: TTL, store: store1 });
        const registeredAt = Date.now() - 40 * DAY;           // registered 40 days ago…
        reg1.register(REALM, TOPIC, Object.assign({}, EP, { now: registeredAt }));
        reg1.markOk(REALM, TOPIC, EP, Date.now() - 1 * DAY); // …but pushed to yesterday
        store1.close();

        // Restart: hydration must keep it (last proof of life is 1 day old, not 40).
        const store2 = new NotifyPushStore({ filename: file });
        const reg2 = new push.TokenRegistry({ ttlMs: TTL, store: store2 });
        assert.strictEqual(reg2.list(REALM, TOPIC).length, 1, 'actively-pushed device survives the restart');
        store2.close();

        // Control: a device registered 40 days ago with NO successful push is dropped.
        const file2 = tmpDb();
        try {
            const s3 = new NotifyPushStore({ filename: file2 });
            const r3 = new push.TokenRegistry({ ttlMs: TTL, store: s3 });
            r3.register(REALM, 'dead-topic', Object.assign({}, EP, { now: registeredAt }));
            s3.close();
            const s4 = new NotifyPushStore({ filename: file2 });
            const r4 = new push.TokenRegistry({ ttlMs: TTL, store: s4 });
            assert.strictEqual(r4.list(REALM, 'dead-topic').length, 0, 'never-pushed stale device is still pruned');
            s4.close();
        } finally { cleanup(file2); }
    } finally { cleanup(file); }
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

test('registry idle TTL (1.12.2): parseRegistryTtlMs accepts ms/s/m/h/d and 0 = never; default is a year; a sweep logs what it pruned with the topics', () => {
    const push = require('../lib/push');
    const D = push.NOTIFY_REGISTRY_TTL_DEFAULT_MS;
    assert.strictEqual(D, 365 * 24 * 3600 * 1000);
    assert.strictEqual(push.parseRegistryTtlMs(undefined, D), D);
    assert.strictEqual(push.parseRegistryTtlMs('', D), D);
    assert.strictEqual(push.parseRegistryTtlMs('90d', D), 90 * 86400000);
    assert.strictEqual(push.parseRegistryTtlMs('12h', D), 12 * 3600000);
    assert.strictEqual(push.parseRegistryTtlMs('30m', D), 30 * 60000);
    assert.strictEqual(push.parseRegistryTtlMs('45s', D), 45000);
    assert.strictEqual(push.parseRegistryTtlMs(5000, D), 5000);
    assert.strictEqual(push.parseRegistryTtlMs(0, D), 0);
    assert.strictEqual(push.parseRegistryTtlMs('0', D), 0);
    assert.strictEqual(push.parseRegistryTtlMs('soon', D), D, 'garbage → default');
    assert.strictEqual(push.parseRegistryTtlMs(-1, D), D);

    const warns = [];
    const reg = new push.TokenRegistry({ maxIdentities: 10, ttlMs: 1000, logger: { warn: (l) => warns.push(l), log() {}, info() {} } });
    reg.register('notify', 'contact-mail', { transport: 'fcm', token: 'a', now: 1000 });
    reg.register('notify', 'busy-topic', { transport: 'fcm', token: 'b', now: 1000 });
    reg.register('notify', 'fresh', { transport: 'fcm', token: 'c', now: 2500 });   // the sweep at t=2500 prunes the two idle since t=1000
    assert.strictEqual(reg.count('notify', 'contact-mail'), 0, 'pruned');
    assert.strictEqual(reg.count('notify', 'fresh'), 1);
    assert.strictEqual(warns.length, 1, JSON.stringify(warns));
    assert.ok(/idle-pruned 2 registration\(s\) in realm 'notify'/.test(warns[0]) && /contact-mail/.test(warns[0]) && /busy-topic/.test(warns[0]), warns[0]);
    const never = new push.TokenRegistry({ maxIdentities: 10, ttlMs: 0, logger: { warn: (l) => warns.push(l) } });
    never.register('notify', 'rare', { transport: 'fcm', token: 'd', now: 1 });
    never.register('notify', 'other', { transport: 'fcm', token: 'e', now: 10 * D });
    assert.strictEqual(never.count('notify', 'rare'), 1, 'ttl 0 never prunes');
});

run();
