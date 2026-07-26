'use strict';

/**
 * End-to-end encrypted payloads — reference implementation (see E2EE.md).
 *
 * Suite `ecdh-es-p256-a256gcm` (ECIES): ephemeral-static ECDH on P-256 →
 * HKDF-SHA256 → AES-256-GCM. Forward-secret per message; the sender needs only
 * the recipient's static public key. Broker-blind: only routing metadata and
 * ciphertext cross the wire.
 *
 * This is the byte-for-byte contract every tyo-mq client language implements;
 * conformance is pinned by tests/e2ee-vectors.json.
 */

const crypto = require('crypto');

const ALG = 'ecdh-es-p256-a256gcm';
const CURVE = 'prime256v1'; // NIST P-256 / secp256r1
const INFO_PREFIX = 'tyo-mq-e2ee-v1:';
const TAG_BYTES = 16; // AES-GCM tag, appended to the ciphertext (WebCrypto layout)
const IV_BYTES = 12;

function toBuf(x) {
    if (Buffer.isBuffer(x)) return x;
    if (x instanceof Uint8Array) return Buffer.from(x);
    if (typeof x === 'string') return Buffer.from(x, 'base64');
    return Buffer.from(x);
}

// aad binds a ciphertext to its cleartext routing so a sealed payload can't be
// cut-and-pasted onto a different envelope. Bytes: event "\n" to "\n" from.
function aad(event, to, from) {
    return Buffer.from((event || '') + '\n' + (to || '') + '\n' + (from || ''), 'utf8');
}

// deriveKey turns the ECDH shared X-coordinate into the AES key. HKDF-SHA256,
// empty salt, info = "tyo-mq-e2ee-v1:<alg>:<kid>".
function deriveKey(sharedX, kid) {
    const info = Buffer.from(INFO_PREFIX + ALG + ':' + (kid || ''), 'utf8');
    return Buffer.from(crypto.hkdfSync('sha256', toBuf(sharedX), Buffer.alloc(0), info, 32));
}

// seal encrypts plaintext to a recipient's static public key (65-byte
// uncompressed P-256 point, Buffer or base64). Returns { enc, message } where
// enc = {v,alg,epk,iv,kid} and message = base64(ciphertext||tag).
// opts.ephemeralPriv / opts.iv make it deterministic for vector generation.
function seal(recipientPub, event, to, from, plaintext, opts) {
    opts = opts || {};
    const eph = crypto.createECDH(CURVE);
    if (opts.ephemeralPriv) eph.setPrivateKey(toBuf(opts.ephemeralPriv));
    else eph.generateKeys();
    const epk = eph.getPublicKey(); // 65-byte uncompressed
    const sharedX = eph.computeSecret(toBuf(recipientPub));
    const kid = opts.kid || '';
    const key = deriveKey(sharedX, kid);
    const iv = opts.iv ? toBuf(opts.iv) : crypto.randomBytes(IV_BYTES);

    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(aad(event, to, from));
    const ct = Buffer.concat([cipher.update(toBuf2(plaintext)), cipher.final()]);
    const box = Buffer.concat([ct, cipher.getAuthTag()]);

    return {
        enc: { v: 1, alg: ALG, epk: epk.toString('base64'), iv: iv.toString('base64'), kid: kid },
        message: box.toString('base64'),
    };
}

// open reverses seal with the recipient's private key (32-byte scalar, Buffer or
// base64). Returns the plaintext Buffer; throws on a bad tag / AAD / key.
function open(myPriv, enc, event, to, from, message) {
    if (!enc || enc.alg !== ALG) throw new Error('e2ee: unsupported alg ' + (enc && enc.alg));
    const ecdh = crypto.createECDH(CURVE);
    ecdh.setPrivateKey(toBuf(myPriv));
    const sharedX = ecdh.computeSecret(Buffer.from(enc.epk, 'base64'));
    const key = deriveKey(sharedX, enc.kid || '');

    const box = Buffer.from(message, 'base64');
    const ct = box.subarray(0, box.length - TAG_BYTES);
    const tag = box.subarray(box.length - TAG_BYTES);

    const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(enc.iv, 'base64'));
    decipher.setAAD(aad(event, to, from));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]);
}

// generateKeyPair returns a fresh P-256 keypair as raw Buffers
// { privateKey (32B), publicKey (65B uncompressed) }.
function generateKeyPair() {
    const e = crypto.createECDH(CURVE);
    e.generateKeys();
    return { privateKey: e.getPrivateKey(), publicKey: e.getPublicKey() };
}

// publicKeyFromPrivate derives the uncompressed public point from a raw scalar.
function publicKeyFromPrivate(priv) {
    const e = crypto.createECDH(CURVE);
    e.setPrivateKey(toBuf(priv));
    return e.getPublicKey();
}

// plaintext may be a Buffer/Uint8Array or a string (treated as UTF-8, NOT base64).
function toBuf2(x) {
    if (Buffer.isBuffer(x)) return x;
    if (x instanceof Uint8Array) return Buffer.from(x);
    if (typeof x === 'string') return Buffer.from(x, 'utf8');
    return Buffer.from(x);
}

module.exports = { ALG, CURVE, seal, open, deriveKey, aad, generateKeyPair, publicKeyFromPrivate };
