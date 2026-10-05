// tests/chat-ticket-store.test.js
/**
 * One-shot attachment-capability ticket store for the anonymous secure-chat tier.
 *
 * The broker issues a short-lived, opaque, ONE-SHOT ticket to an authenticated
 * (anonymous) chat socket; the store backend later calls the broker's
 * verify-ticket endpoint to redeem it exactly once. The store is the security
 * core of that contract, so it is unit-tested in isolation here (no server):
 *
 *   - opaque + unguessable tickets, kept hashed at rest
 *   - op-match (upload|download) and, for download, ref-match
 *   - consume ONLY on a valid redemption — a wrong-op/wrong-ref probe can never
 *     burn a legitimate ticket, and a redeemed ticket never verifies twice
 *   - TTL <= 120s (hard-capped at 900s)
 *   - a per-session mint cap on uploads; downloads uncapped
 *
 * Usage: node tests/chat-ticket-store.test.js
 */

'use strict';

const assert = require('assert');
const { test, run } = require('./runner');
const ChatTicketStore = require('../lib/chat-ticket-store');

const T0 = 1_000_000_000_000; // a fixed "now" so TTL math is deterministic

test('an upload ticket verifies once with op-match, then is consumed (one-shot)', () => {
    const store = new ChatTicketStore();
    const ticket = store.issue('sess-A', 'upload', undefined, T0);
    assert.strictEqual(typeof ticket, 'string');
    assert.strictEqual(store.verify(ticket, 'upload', undefined, T0), true, 'first redeem is valid');
    assert.strictEqual(store.verify(ticket, 'upload', undefined, T0), false, 'second redeem is dead (consumed)');
});

test('a download ticket is bound to its ref: op-match AND ref-match', () => {
    const store = new ChatTicketStore();
    const ticket = store.issue('sess-A', 'download', 'blob/abc123', T0);
    assert.strictEqual(store.verify(ticket, 'download', 'blob/abc123', T0), true, 'matching ref redeems');
    assert.strictEqual(store.verify(ticket, 'download', 'blob/abc123', T0), false, 'and is then consumed');
});

test('a wrong-ref probe returns false and does NOT consume the ticket', () => {
    const store = new ChatTicketStore();
    const ticket = store.issue('sess-A', 'download', 'blob/real', T0);
    assert.strictEqual(store.verify(ticket, 'download', 'blob/attacker', T0), false, 'wrong ref is rejected');
    // The legitimate holder can still redeem it — the probe must not have burned it.
    assert.strictEqual(store.verify(ticket, 'download', 'blob/real', T0), true, 'legit ref still redeems after a wrong-ref probe');
});

test('op mismatch returns false and does NOT consume the ticket', () => {
    const store = new ChatTicketStore();
    const up = store.issue('sess-A', 'upload', undefined, T0);
    assert.strictEqual(store.verify(up, 'download', 'anything', T0), false, 'upload ticket presented as download is rejected');
    assert.strictEqual(store.verify(up, 'upload', undefined, T0), true, 'upload ticket still redeems as upload');

    const dn = store.issue('sess-A', 'download', 'blob/x', T0);
    assert.strictEqual(store.verify(dn, 'upload', undefined, T0), false, 'download ticket presented as upload is rejected');
    assert.strictEqual(store.verify(dn, 'download', 'blob/x', T0), true, 'download ticket still redeems as download');
});

test('an unknown / never-issued ticket is uniformly false', () => {
    const store = new ChatTicketStore();
    assert.strictEqual(store.verify('deadbeef'.repeat(8), 'upload', undefined, T0), false);
    assert.strictEqual(store.verify('', 'upload', undefined, T0), false);
    assert.strictEqual(store.verify(null, 'download', 'r', T0), false);
});

test('a ticket expires at its TTL (default <= 120s)', () => {
    const store = new ChatTicketStore({ ttlMs: 120_000 });
    const ticket = store.issue('sess-A', 'upload', undefined, T0);
    assert.strictEqual(store.verify(ticket, 'upload', undefined, T0 + 119_000), true, 'valid just before TTL');
    const ticket2 = store.issue('sess-A', 'upload', undefined, T0);
    assert.strictEqual(store.verify(ticket2, 'upload', undefined, T0 + 120_001), false, 'dead just after TTL');
});

test('TTL is hard-capped at 900s even if a larger ttl is configured', () => {
    const store = new ChatTicketStore({ ttlMs: 10 * 60 * 60 * 1000 }); // 10h requested
    const ticket = store.issue('sess-A', 'upload', undefined, T0);
    assert.strictEqual(store.verify(ticket, 'upload', undefined, T0 + 899_000), true, 'valid just under the 900s cap');
    const ticket2 = store.issue('sess-A', 'upload', undefined, T0);
    assert.strictEqual(store.verify(ticket2, 'upload', undefined, T0 + 901_000), false, 'dead past the 900s cap');
});

test('issue validates op and ref shape', () => {
    const store = new ChatTicketStore();
    assert.throws(() => store.issue('sess-A', 'delete', undefined, T0), /op/i, 'invalid op rejected');
    assert.throws(() => store.issue('sess-A', 'download', undefined, T0), /ref/i, 'download without a ref rejected');
    assert.throws(() => store.issue('sess-A', 'download', '', T0), /ref/i, 'download with an empty ref rejected');
    assert.throws(() => store.issue('sess-A', 'upload', 'blob/x', T0), /ref/i, 'upload with a ref rejected (store generates it)');
    assert.throws(() => store.issue('', 'upload', undefined, T0), /session/i, 'missing session rejected');
});

test('tickets are opaque, high-entropy and distinct (not derivable from the session)', () => {
    const store = new ChatTicketStore();
    const a = store.issue('sess-A', 'upload', undefined, T0);
    const b = store.issue('sess-A', 'upload', undefined, T0);
    assert.notStrictEqual(a, b, 'two issues differ');
    assert.ok(a.length >= 32, 'ticket carries real entropy');
    assert.strictEqual(a.indexOf('sess-A'), -1, 'ticket does not embed the session id');
});

test('the raw ticket is NOT stored verbatim (kept hashed at rest)', () => {
    const store = new ChatTicketStore();
    const ticket = store.issue('sess-A', 'upload', undefined, T0);
    // Serialising the store must not reveal a live capability token.
    const dump = JSON.stringify(Array.from(store._tickets ? store._tickets.keys() : []));
    assert.strictEqual(dump.indexOf(ticket), -1, 'raw ticket is not a key in the store');
});

test('per-session UPLOAD cap: uploads are throttled, downloads are not', () => {
    const store = new ChatTicketStore({ uploadCapPerWindow: 3, windowMs: 3_600_000 });
    assert.ok(store.issue('sess-A', 'upload', undefined, T0));
    assert.ok(store.issue('sess-A', 'upload', undefined, T0));
    assert.ok(store.issue('sess-A', 'upload', undefined, T0));
    assert.throws(() => store.issue('sess-A', 'upload', undefined, T0), /cap|limit/i, '4th upload in-window is capped');

    // A different session is unaffected by sess-A's cap.
    assert.ok(store.issue('sess-B', 'upload', undefined, T0), 'other session unaffected');

    // Downloads are not throttled by the upload cap.
    for (let i = 0; i < 20; i++)
        assert.ok(store.issue('sess-A', 'download', 'blob/' + i, T0), 'downloads uncapped');
});

test('the upload cap resets after its window elapses', () => {
    const store = new ChatTicketStore({ uploadCapPerWindow: 2, windowMs: 3_600_000 });
    store.issue('sess-A', 'upload', undefined, T0);
    store.issue('sess-A', 'upload', undefined, T0);
    assert.throws(() => store.issue('sess-A', 'upload', undefined, T0 + 1000), /cap|limit/i, 'still capped inside the window');
    assert.ok(store.issue('sess-A', 'upload', undefined, T0 + 3_600_001), 'allowed once the window rolls over');
});

test('expired tickets are swept so the store stays bounded', () => {
    const store = new ChatTicketStore({ ttlMs: 60_000 });
    for (let i = 0; i < 50; i++) store.issue('sess-' + i, 'download', 'blob/' + i, T0);
    assert.ok(store.size() >= 50, 'tickets are held while live');
    // Any operation well past expiry should drive a sweep to zero.
    store.verify('x'.repeat(64), 'upload', undefined, T0 + 61_000);
    assert.strictEqual(store.size(T0 + 61_000), 0, 'expired tickets are gone');
});

run();
