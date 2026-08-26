/**
 * TYO Notify private topics — unit tests for lib/notify-auth.js.
 * Pure functions, no server. Usage: node tests/notify-auth-unit.test.js
 */

'use strict';

const assert = require('assert');
const crypto = require('crypto');
const { test, run } = require('./runner');
const A = require('../lib/notify-auth');

function genKeyPair() {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const pubkey = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
    return { pubkey, privateKey };
}

function signProof(privateKey, action, body, timestamp, nonce) {
    const base = A.signatureBase(action, body, timestamp, nonce);
    const signature = crypto.sign('sha256', Buffer.from(base), privateKey).toString('base64');
    return { timestamp: timestamp, nonce: nonce, signature: signature };
}

test('isReservedTopic rejects _ and system: prefixes, allows everything else', () => {
    assert.ok(A.isReservedTopic('_internal'));
    assert.ok(A.isReservedTopic('system:takedown'));
    assert.ok(!A.isReservedTopic('contact-tyo'));
    assert.ok(!A.isReservedTopic('alerts'));
});

test('verifyProof accepts a valid, fresh, correctly-bound signature', () => {
    const { pubkey, privateKey } = genKeyPair();
    const now = Date.now();
    const body = { topic: 'contact-tyo' };
    const proof = signProof(privateKey, 'json', body, now, 'nonce-1');
    assert.ok(A.verifyProof(pubkey, 'json', body, proof));
});

test('verifyProof rejects a signature for a different action', () => {
    const { pubkey, privateKey } = genKeyPair();
    const now = Date.now();
    const body = { topic: 'contact-tyo' };
    const proof = signProof(privateKey, 'json', body, now, 'nonce-1');
    assert.ok(!A.verifyProof(pubkey, 'raw', body, proof));
});

test('verifyProof rejects a signature bound to a different topic', () => {
    const { pubkey, privateKey } = genKeyPair();
    const now = Date.now();
    const proof = signProof(privateKey, 'json', { topic: 'topic-a' }, now, 'nonce-1');
    assert.ok(!A.verifyProof(pubkey, 'json', { topic: 'topic-b' }, proof));
});

test('verifyProof rejects a stale timestamp outside the freshness window', () => {
    const { pubkey, privateKey } = genKeyPair();
    const stale = Date.now() - (A.SIGNATURE_MAX_AGE_MS + 5000);
    const body = { topic: 'contact-tyo' };
    const proof = signProof(privateKey, 'json', body, stale, 'nonce-1');
    assert.ok(!A.verifyProof(pubkey, 'json', body, proof));
});

test('verifyProof rejects a signature from the wrong key', () => {
    const { privateKey } = genKeyPair();
    const other = genKeyPair();
    const now = Date.now();
    const body = { topic: 'contact-tyo' };
    const proof = signProof(privateKey, 'json', body, now, 'nonce-1');
    assert.ok(!A.verifyProof(other.pubkey, 'json', body, proof));
});

test('verifyProof rejects malformed pubkey/signature without throwing', () => {
    const now = Date.now();
    assert.ok(!A.verifyProof('not-a-key', 'json', { topic: 't' }, { timestamp: now, nonce: 'n', signature: 'x' }));
});

test('NonceSeen accepts a nonce once, rejects replay, allows a different nonce', () => {
    const seen = new A.NonceSeen();
    const now = Date.now();
    assert.ok(seen.checkAndRecord('topic-a', 'n1', now));
    assert.ok(!seen.checkAndRecord('topic-a', 'n1', now), 'replay must be rejected');
    assert.ok(seen.checkAndRecord('topic-a', 'n2', now), 'a different nonce is fine');
    assert.ok(seen.checkAndRecord('topic-b', 'n1', now), 'same nonce, different topic, is fine');
});

test('generatePublishToken/hashPublishToken/publishTokenMatches round-trip', () => {
    const token = A.generatePublishToken();
    assert.strictEqual(token.length, 64, '256-bit token, hex-encoded');
    const hash = A.hashPublishToken(token);
    assert.ok(A.publishTokenMatches(token, hash));
    assert.ok(!A.publishTokenMatches('wrong-token', hash));
});

test('pubkeyFingerprint is stable and differs across keys', () => {
    const a = genKeyPair();
    const b = genKeyPair();
    assert.strictEqual(A.pubkeyFingerprint(a.pubkey), A.pubkeyFingerprint(a.pubkey));
    assert.notStrictEqual(A.pubkeyFingerprint(a.pubkey), A.pubkeyFingerprint(b.pubkey));
});

run();
