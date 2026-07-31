'use strict';

// All @signalapp/libsignal-client usage is isolated here so the rest of the
// broker stays free of the native dependency and this stays unit-testable.
// The Node binding is the same libsignal version (0.99.x) as the Rust chat
// core, so certs it mints are wire-compatible with the core's sealed_sender_decrypt.
const crypto = require('crypto');
const { PrivateKey, PublicKey, ServerCertificate, SenderCertificate } =
    require('@signalapp/libsignal-client');

// Load the broker's sealed-sender signing material from the environment.
// Contract: returns null (feature disabled) when BOTH vars are absent, OR
// THROWS synchronously when a var is present but malformed (bad base64 /
// corrupt protobuf make ServerCertificate.deserialize / PrivateKey.deserialize
// throw). It never returns a half-valid config, so a boot-time caller should
// wrap this call and emit an actionable error on throw.
// TYO_MQ_SEALED_SERVER_CERT = base64(ServerCertificate.serialize())
// TYO_MQ_SEALED_SERVER_KEY  = base64(server-cert PrivateKey.serialize())
function loadConfig(env) {
    env = env || process.env;
    const certB64 = env.TYO_MQ_SEALED_SERVER_CERT;
    const keyB64 = env.TYO_MQ_SEALED_SERVER_KEY;
    if (!certB64 || !keyB64) return null;
    return {
        serverCert: ServerCertificate.deserialize(Buffer.from(certB64, 'base64')),
        serverKey: PrivateKey.deserialize(Buffer.from(keyB64, 'base64')),
    };
}

function isConfigured(cfg) { return !!cfg; }

// Mint a sender certificate binding identity -> identity_key -> device.
// identityKeyBytes: Buffer/Uint8Array of the client's serialized public identity key.
// Returns { senderCert: Buffer, serverCert: Buffer } (both serialized).
function issueSenderCert(cfg, identity, identityKeyBytes, deviceId, ttlMs, nowMs) {
    const senderPub = PublicKey.deserialize(Buffer.from(identityKeyBytes));
    // TTL sanity is the caller's responsibility: a 0/negative ttlMs mints an
    // already-expired cert, an over-long one mints a long-lived sender cert.
    // This pure module does not police it.
    const expiration = nowMs + ttlMs;
    const cert = SenderCertificate.new(
        identity, null, deviceId, senderPub, expiration, cfg.serverCert, cfg.serverKey);
    return {
        senderCert: Buffer.from(cert.serialize()),
        serverCert: Buffer.from(cfg.serverCert.serialize()),
    };
}

// Constant-time UAK comparison. Both args are Buffers; false on length mismatch
// (timingSafeEqual throws on unequal length, so guard first).
function uakEqual(a, b) {
    if (!Buffer.isBuffer(a) || !Buffer.isBuffer(b) || a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
}

module.exports = { loadConfig, isConfigured, issueSenderCert, uakEqual };
