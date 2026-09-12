/**
 * Signal prekey directory — durable backing store.
 *
 * Regression for the "first contact to a long-lived account fails with
 * NoSession after a broker restart" bug: the prekey directory was in-memory /
 * node-local only, so a restart wiped every published bundle. A long-lived
 * account only publishes at registration (replenishPrekeys not yet landed), so
 * after one restart a fresh peer's PREKEY_TAKE got `found:false` and the
 * accepter's first send threw NoSession. These tests pin that a published
 * bundle SURVIVES a simulated restart via the SQLite backing store, that a
 * consumed one-time prekey does not resurrect, and that a signed-prekey-only
 * bundle (empty pool) survives intact.
 *
 * Usage: node tests/prekey-durable.test.js
 */

'use strict';

const assert = require('assert');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { test, run } = require('./runner');
const PrekeyStore = require('../lib/prekey-store');

function tmpDb() {
    // Unique per test so WAL files never collide between cases.
    return path.join(os.tmpdir(),
        'tyo-prekeys-' + process.pid + '-' + Math.floor(Math.random() * 1e9) + '.sqlite');
}

function cleanup(file) {
    for (const suffix of ['', '-wal', '-shm']) {
        try { fs.unlinkSync(file + suffix); } catch (e) {}
    }
}

const REALM = 'default';
const IDENTITY = 'chat-3';

function bundleWith(oneTime) {
    return {
        identity_key: 'IDK-pub',
        registration_id: 42,
        device_id: 1,
        signed_prekey_id: 7,
        signed_prekey: 'SIGNED-PUB',
        signed_prekey_sig: 'SIGNED-SIG',
        kyber_prekey_id: 9,
        kyber_prekey: 'KYBER-PUB',
        kyber_prekey_sig: 'KYBER-SIG',
        updated_at: '2026-09-11T00:00:00.000Z',
        one_time: oneTime
    };
}

// Find the stored copy of one account after a "restart" (fresh store, same file).
function reload(file, realm, identity) {
    const store = new PrekeyStore({ filename: file });
    const found = store.allBundles().find(b => b.realm === realm && b.identity === identity);
    store.close();
    return found;
}

test('a published bundle survives a simulated broker restart', () => {
    const file = tmpDb();
    try {
        const store1 = new PrekeyStore({ filename: file });
        store1.putBundle(REALM, IDENTITY, bundleWith([{ id: 1, key: 'OTP-1' }, { id: 2, key: 'OTP-2' }]));
        store1.close();

        // Restart: a fresh store over the same file must still hold the bundle —
        // the bug was that the directory came up empty and PREKEY_TAKE 404'd.
        const found = reload(file, REALM, IDENTITY);
        assert.ok(found, 'bundle should survive restart');
        assert.strictEqual(found.bundle.identity_key, 'IDK-pub');
        assert.strictEqual(found.bundle.signed_prekey, 'SIGNED-PUB');
        assert.strictEqual(found.bundle.kyber_prekey, 'KYBER-PUB');
        assert.strictEqual(found.bundle.registration_id, 42);
        assert.strictEqual(found.bundle.one_time.length, 2);
        assert.deepStrictEqual(found.bundle.one_time.map(o => o.id).sort(), [1, 2]);
    } finally {
        cleanup(file);
    }
});

test('a consumed one-time prekey does not resurrect on restart', () => {
    const file = tmpDb();
    try {
        const store1 = new PrekeyStore({ filename: file });
        store1.putBundle(REALM, IDENTITY, bundleWith([{ id: 1, key: 'OTP-1' }, { id: 2, key: 'OTP-2' }]));
        // PREKEY_TAKE shifts OTK id=1 out of memory; mirror that consume to disk.
        store1.consumeOneTime(REALM, IDENTITY, 1);
        store1.close();

        const found = reload(file, REALM, IDENTITY);
        assert.ok(found, 'bundle still present');
        assert.strictEqual(found.bundle.one_time.length, 1, 'only the unconsumed OTK remains');
        assert.strictEqual(found.bundle.one_time[0].id, 2);
    } finally {
        cleanup(file);
    }
});

test('a signed-prekey-only bundle (drained pool) survives intact', () => {
    const file = tmpDb();
    try {
        // The empty-pool case is exactly what makes persistence necessary: a
        // long-lived account whose one-time pool is exhausted must still serve
        // a usable signed-prekey-only bundle after a restart (X3DH completes on
        // the signed prekey alone).
        const store1 = new PrekeyStore({ filename: file });
        store1.putBundle(REALM, IDENTITY, bundleWith([]));
        store1.close();

        const found = reload(file, REALM, IDENTITY);
        assert.ok(found, 'signed-prekey-only bundle should survive');
        assert.strictEqual(found.bundle.one_time.length, 0);
        assert.strictEqual(found.bundle.signed_prekey, 'SIGNED-PUB');
        assert.strictEqual(found.bundle.signed_prekey_sig, 'SIGNED-SIG');
    } finally {
        cleanup(file);
    }
});

test('republishing replaces static material and rewrites the pool', () => {
    const file = tmpDb();
    try {
        const store1 = new PrekeyStore({ filename: file });
        store1.putBundle(REALM, IDENTITY, bundleWith([{ id: 1, key: 'OTP-1' }]));
        // A rotation: new signed prekey + a fresh (single) pool that replaces
        // the old rows — no stale OTK id=1 must linger.
        const rotated = bundleWith([{ id: 9, key: 'OTP-9' }]);
        rotated.signed_prekey = 'SIGNED-PUB-2';
        store1.putBundle(REALM, IDENTITY, rotated);
        store1.close();

        const found = reload(file, REALM, IDENTITY);
        assert.strictEqual(found.bundle.signed_prekey, 'SIGNED-PUB-2');
        assert.strictEqual(found.bundle.one_time.length, 1);
        assert.strictEqual(found.bundle.one_time[0].id, 9, 'old pool rows must be gone');
    } finally {
        cleanup(file);
    }
});

test('delBundle is durable — a removed account does not come back on restart', () => {
    const file = tmpDb();
    try {
        const store1 = new PrekeyStore({ filename: file });
        store1.putBundle(REALM, IDENTITY, bundleWith([{ id: 1, key: 'OTP-1' }]));
        store1.delBundle(REALM, IDENTITY);
        store1.close();

        assert.strictEqual(reload(file, REALM, IDENTITY), undefined,
            'deleted account must not resurrect');
    } finally {
        cleanup(file);
    }
});

test('two accounts in different realms are isolated', () => {
    const file = tmpDb();
    try {
        const store1 = new PrekeyStore({ filename: file });
        store1.putBundle('realm-a', 'alice', bundleWith([{ id: 1, key: 'A-1' }]));
        store1.putBundle('realm-b', 'bob', bundleWith([{ id: 2, key: 'B-1' }]));
        store1.close();

        const store2 = new PrekeyStore({ filename: file });
        const all = store2.allBundles();
        store2.close();
        assert.strictEqual(all.length, 2);
        const alice = all.find(b => b.realm === 'realm-a' && b.identity === 'alice');
        const bob = all.find(b => b.realm === 'realm-b' && b.identity === 'bob');
        assert.ok(alice && bob, 'both accounts present under their own realms');
        assert.strictEqual(alice.bundle.one_time[0].key, 'A-1');
        assert.strictEqual(bob.bundle.one_time[0].key, 'B-1');
    } finally {
        cleanup(file);
    }
});

test('isSupported reflects node:sqlite availability', () => {
    assert.strictEqual(typeof PrekeyStore.isSupported(), 'boolean');
});

run();
