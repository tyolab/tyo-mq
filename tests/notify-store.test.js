// tests/notify-store.test.js
/**
 * TYO Notify private topics — SQLite claim store (lib/notify-store.js).
 * Usage: node tests/notify-store.test.js
 */

'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { test, run } = require('./runner');
const NotifyStore = require('../lib/notify-store');

function tmpFile() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tyo-mq-notify-store-'));
    return path.join(dir, 'notify.sqlite');
}

test('claim() creates a row and getClaim() returns it', () => {
    const store = new NotifyStore({ filename: tmpFile() });
    try {
        const row = store.claim('contact-tyo', {
            pubkey: 'pk-a', pubkey_fingerprint: 'fp-a',
            publish_token_hash: 'hash-a', created_at: 1000
        });
        assert.ok(row);
        assert.strictEqual(row.topic, 'contact-tyo');
        assert.strictEqual(row.pubkey, 'pk-a');

        const fetched = store.getClaim('contact-tyo');
        assert.strictEqual(fetched.pubkey_fingerprint, 'fp-a');
    } finally {
        store.close();
    }
});

test('getClaim() returns null for an unclaimed topic', () => {
    const store = new NotifyStore({ filename: tmpFile() });
    try {
        assert.strictEqual(store.getClaim('never-claimed'), null);
    } finally {
        store.close();
    }
});

test('claim() is first-claim-wins: a second claim on the same topic is rejected', () => {
    const store = new NotifyStore({ filename: tmpFile() });
    try {
        const first = store.claim('contact-tyo', {
            pubkey: 'pk-a', pubkey_fingerprint: 'fp-a',
            publish_token_hash: 'hash-a', created_at: 1000
        });
        assert.ok(first);

        const second = store.claim('contact-tyo', {
            pubkey: 'pk-b', pubkey_fingerprint: 'fp-b',
            publish_token_hash: 'hash-b', created_at: 2000
        });
        assert.strictEqual(second, null, 'second claim on an already-claimed topic must fail');

        // The original claim must be unchanged.
        assert.strictEqual(store.getClaim('contact-tyo').pubkey, 'pk-a');
    } finally {
        store.close();
    }
});

test('claims survive a reopen of the same file (durability)', () => {
    const file = tmpFile();
    const first = new NotifyStore({ filename: file });
    first.claim('contact-tyo', {
        pubkey: 'pk-a', pubkey_fingerprint: 'fp-a',
        publish_token_hash: 'hash-a', created_at: 1000
    });
    first.close();

    const second = new NotifyStore({ filename: file });
    try {
        const row = second.getClaim('contact-tyo');
        assert.ok(row, 'claim must survive reopening the store file');
        assert.strictEqual(row.pubkey, 'pk-a');
    } finally {
        second.close();
    }
});

run();
