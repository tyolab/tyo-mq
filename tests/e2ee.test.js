/**
 * End-to-end encrypted payloads — reference crypto + cross-implementation
 * conformance. Proves the Node reference (lib/e2ee.js) and WebCrypto (the
 * browser path) interop both ways, and pins the wire bytes with committed
 * vectors so every language port stays conformant.
 *
 * Usage: node tests/e2ee.test.js   (E2EE_UPDATE=1 regenerates the vectors)
 */

'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { test, run } = require('./runner');
const e2ee = require('../lib/e2ee');

const subtle = globalThis.crypto.subtle;
const VECTORS = path.join(__dirname, 'e2ee-vectors.json');

// Fixed inputs → deterministic vectors.
const recipientPriv = Buffer.from(Array.from({ length: 32 }, (_, i) => i + 1)); // 1..32
const recipientPub = e2ee.publicKeyFromPrivate(recipientPriv);
const ephemeralPriv = Buffer.from(Array.from({ length: 32 }, (_, i) => i + 33)); // 33..64
const iv = Buffer.from(Array.from({ length: 12 }, (_, i) => 0xa0 + i));
const ROUTING = { event: 'command', to: 'dev-1', from: 'op-console', kid: 'dev-1-enc' };
const PLAINTEXT = '{"cmd":"whoami","shell":"bash"}';

function b64url(buf) { return Buffer.from(buf).toString('base64url'); }

// ── WebCrypto helpers (the browser path) ─────────────────────────────────────
async function wcImportPriv(privRaw, pubRaw) {
    return subtle.importKey('jwk', {
        kty: 'EC', crv: 'P-256',
        d: b64url(privRaw), x: b64url(pubRaw.subarray(1, 33)), y: b64url(pubRaw.subarray(33, 65)), ext: true,
    }, { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
}
function wcImportPub(pubRaw) {
    return subtle.importKey('raw', pubRaw, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
}
async function wcAesKey(sharedBits, kid, usage) {
    const hk = await subtle.importKey('raw', new Uint8Array(sharedBits), 'HKDF', false, ['deriveBits']);
    const info = Buffer.from('tyo-mq-e2ee-v1:' + e2ee.ALG + ':' + (kid || ''), 'utf8');
    const keyBits = await subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info }, hk, 256);
    return subtle.importKey('raw', keyBits, { name: 'AES-GCM' }, false, [usage]);
}
async function wcOpen(privRaw, pubRaw, enc, event, to, from, message) {
    const priv = await wcImportPriv(privRaw, pubRaw);
    const epk = await wcImportPub(Buffer.from(enc.epk, 'base64'));
    const shared = await subtle.deriveBits({ name: 'ECDH', public: epk }, priv, 256);
    const key = await wcAesKey(shared, enc.kid, 'decrypt');
    const pt = await subtle.decrypt(
        { name: 'AES-GCM', iv: Buffer.from(enc.iv, 'base64'), additionalData: e2ee.aad(event, to, from), tagLength: 128 },
        key, Buffer.from(message, 'base64'),
    );
    return Buffer.from(pt);
}
async function wcSeal(recipientPubRaw, event, to, from, plaintext, kid) {
    const eph = await subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
    const epk = Buffer.from(await subtle.exportKey('raw', eph.publicKey));
    const shared = await subtle.deriveBits({ name: 'ECDH', public: await wcImportPub(recipientPubRaw) }, eph.privateKey, 256);
    const key = await wcAesKey(shared, kid, 'encrypt');
    const nonce = crypto.randomBytes(12);
    const box = Buffer.from(await subtle.encrypt(
        { name: 'AES-GCM', iv: nonce, additionalData: e2ee.aad(event, to, from), tagLength: 128 },
        key, Buffer.from(plaintext, 'utf8'),
    ));
    return { enc: { v: 1, alg: e2ee.ALG, epk: epk.toString('base64'), iv: nonce.toString('base64'), kid: kid || '' }, message: box.toString('base64') };
}

// ── Node reference ───────────────────────────────────────────────────────────

test('node seal → node open round-trips', () => {
    const { enc, message } = e2ee.seal(recipientPub, ROUTING.event, ROUTING.to, ROUTING.from, PLAINTEXT, { kid: ROUTING.kid });
    const pt = e2ee.open(recipientPriv, enc, ROUTING.event, ROUTING.to, ROUTING.from, message);
    assert.strictEqual(pt.toString('utf8'), PLAINTEXT);
});

test('tampering the ciphertext fails the GCM tag', () => {
    const { enc, message } = e2ee.seal(recipientPub, ROUTING.event, ROUTING.to, ROUTING.from, PLAINTEXT, { kid: ROUTING.kid });
    const box = Buffer.from(message, 'base64');
    box[0] ^= 0x01;
    assert.throws(() => e2ee.open(recipientPriv, enc, ROUTING.event, ROUTING.to, ROUTING.from, box.toString('base64')));
});

test('routing is bound via AAD — a swapped "to" fails to open', () => {
    const { enc, message } = e2ee.seal(recipientPub, ROUTING.event, ROUTING.to, ROUTING.from, PLAINTEXT, { kid: ROUTING.kid });
    assert.throws(() => e2ee.open(recipientPriv, enc, ROUTING.event, 'dev-2', ROUTING.from, message));
});

test('a different recipient key cannot open it', () => {
    const other = e2ee.generateKeyPair();
    const { enc, message } = e2ee.seal(recipientPub, ROUTING.event, ROUTING.to, ROUTING.from, PLAINTEXT, { kid: ROUTING.kid });
    assert.throws(() => e2ee.open(other.privateKey, enc, ROUTING.event, ROUTING.to, ROUTING.from, message));
});

// ── Cross-implementation interop (server-crypto ↔ browser WebCrypto) ─────────

test('WebCrypto opens a Node-sealed message', async () => {
    const { enc, message } = e2ee.seal(recipientPub, ROUTING.event, ROUTING.to, ROUTING.from, PLAINTEXT, { kid: ROUTING.kid });
    const pt = await wcOpen(recipientPriv, recipientPub, enc, ROUTING.event, ROUTING.to, ROUTING.from, message);
    assert.strictEqual(pt.toString('utf8'), PLAINTEXT);
});

test('Node opens a WebCrypto-sealed message', async () => {
    const { enc, message } = await wcSeal(recipientPub, ROUTING.event, ROUTING.to, ROUTING.from, PLAINTEXT, ROUTING.kid);
    const pt = e2ee.open(recipientPriv, enc, ROUTING.event, ROUTING.to, ROUTING.from, message);
    assert.strictEqual(pt.toString('utf8'), PLAINTEXT);
});

// ── Committed conformance vectors ────────────────────────────────────────────

test('deterministic vectors match (and every impl opens them)', async () => {
    const built = e2ee.seal(recipientPub, ROUTING.event, ROUTING.to, ROUTING.from, PLAINTEXT, {
        kid: ROUTING.kid, ephemeralPriv, iv,
    });
    const vec = {
        suite: e2ee.ALG,
        recipient_private_b64: recipientPriv.toString('base64'),
        recipient_public_b64: recipientPub.toString('base64'),
        routing: { event: ROUTING.event, to: ROUTING.to, from: ROUTING.from, kid: ROUTING.kid },
        plaintext_utf8: PLAINTEXT,
        enc: built.enc,
        message_b64: built.message,
    };

    if (!fs.existsSync(VECTORS) || process.env.E2EE_UPDATE === '1') {
        fs.writeFileSync(VECTORS, JSON.stringify(vec, null, 2) + '\n');
        console.log('     wrote', VECTORS);
        return;
    }

    const golden = JSON.parse(fs.readFileSync(VECTORS, 'utf8'));
    // Deterministic bytes must match exactly (any drift breaks another language).
    assert.strictEqual(built.enc.epk, golden.enc.epk, 'ephemeral pubkey drifted');
    assert.strictEqual(built.message, golden.message_b64, 'ciphertext drifted');
    // Both impls must open the committed message to the committed plaintext.
    const nodePt = e2ee.open(recipientPriv, golden.enc, ROUTING.event, ROUTING.to, ROUTING.from, golden.message_b64);
    assert.strictEqual(nodePt.toString('utf8'), golden.plaintext_utf8);
    const wcPt = await wcOpen(recipientPriv, recipientPub, golden.enc, ROUTING.event, ROUTING.to, ROUTING.from, golden.message_b64);
    assert.strictEqual(wcPt.toString('utf8'), golden.plaintext_utf8);
});

run();
