/**
 * NonceCache — the manager-proof replay cache must reject a replay inside the
 * acceptance window and forget nonces after it, so it stays bounded instead of
 * growing by one entry per manager command for the life of the process.
 *
 * Usage: node tests/nonce-cache.test.js
 */

'use strict';

const assert = require('assert');
const { test, run } = require('./runner');
const NonceCache = require('../lib/nonce-cache');

// Deterministic clock: no sleeping in tests.
function clock(start) {
    let t = start;
    const now = () => t;
    now.advance = (ms) => { t += ms; };
    return now;
}

test('a nonce is remembered (replay rejected) within the retention window', () => {
    const now = clock(1000000);
    const cache = new NonceCache({ maxAgeMs: 1000, now });
    assert.strictEqual(cache.has('n1'), false, 'unseen nonce');
    cache.add('n1');
    assert.strictEqual(cache.has('n1'), true, 'immediately after use');
    now.advance(1999); // retention is 2 * maxAgeMs = 2000
    assert.strictEqual(cache.has('n1'), true, 'still inside the window');
});

test('a nonce is forgotten once it can no longer be replayed', () => {
    const now = clock(1000000);
    const cache = new NonceCache({ maxAgeMs: 1000, now });
    cache.add('n1');
    now.advance(2000); // exactly retention → expired
    assert.strictEqual(cache.has('n1'), false, 'expired at the retention boundary');
    assert.strictEqual(cache.size(), 0, 'pruned from memory');
});

test('retention covers the full ±maxAge window verifyAdminProof accepts', () => {
    // verifyAdminProof accepts |now - timestamp| <= maxAgeMs, i.e. a proof
    // stamped up to maxAgeMs in the FUTURE is valid for 2 * maxAgeMs of wall
    // time. The cache must outlive that, not just maxAgeMs.
    const cache = new NonceCache({ maxAgeMs: 1000, now: clock(0) });
    assert.strictEqual(cache.retainMs, 2000);
});

test('size stays bounded under sustained use', () => {
    const now = clock(0);
    const cache = new NonceCache({ maxAgeMs: 1000, now }); // retention 2000ms
    for (let i = 0; i < 1000; i++) {
        cache.add('nonce-' + i);
        now.advance(10); // 1000 commands over 10s
    }
    // Only the last 2000ms worth (≈200 entries) can still be replayed.
    const live = cache.size();
    assert.ok(live <= 201 && live >= 190, 'expected ~200 live entries, got ' + live);
    assert.strictEqual(cache.has('nonce-999'), true, 'newest still remembered');
    assert.strictEqual(cache.has('nonce-0'), false, 'oldest forgotten');
});

test('defaults match the broker contract: 5 min max age, Date.now clock', () => {
    const cache = new NonceCache();
    assert.strictEqual(cache.maxAgeMs, 5 * 60 * 1000);
    assert.strictEqual(cache.retainMs, 10 * 60 * 1000);
    assert.strictEqual(cache.now, Date.now);
});

run();
