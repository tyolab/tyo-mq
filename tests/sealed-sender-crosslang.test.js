'use strict';
// Cross-language sealed-sender compatibility proof.
//
// The broker mints libsignal SenderCertificates in Node via
// @signalapp/libsignal-client (0.99.2). The whole sealed-sender feature's
// correctness rests on those Node-minted certs being ACCEPTED BY THE RUST
// CHAT CORE (secure-chat's tyo-chat-core crate uses the Rust
// libsignal-protocol crate at the SAME libsignal version, 0.99.x) — i.e. the
// wire format has to round-trip across the Node <-> Rust boundary, not just
// work within one language's bindings.
//
// This file does two things:
//   1. A FULL sealedSenderEncryptMessage -> sealedSenderDecryptMessage
//      round-trip entirely in Node (proves the Node binding's own encrypt/
//      decrypt pair, plaintext, sender identity and device id all survive).
//      This in-memory round-trip — not the fixture file below — is the
//      automated, CI-enforced proof; the assertions above never read the
//      fixture back.
//   2. Writes tests/fixtures/sealed-crosslang.json containing the base64 of
//      the CA root PUBLIC key and a serialized SenderCertificate, so the
//      exact bytes a Node broker would hand to a client can be replayed
//      against the Rust core. This file is regenerated with fresh random
//      keys on every run, is gitignored, and its sender_cert expires 24h
//      after it's minted — it is a convenience export for a manual,
//      already-performed Rust cross-language check (see below), not a
//      tracked artifact and not a test dependency.
//
// REAL RUST CROSS-LANGUAGE CONFIRMATION — RESULT: PASS (2026-08-01)
// ---------------------------------------------------------------
// A throwaway `#[test]` was added to secure-chat's `tyo-chat-core` crate at
// crates/tyo-chat-core/tests/zzz_crosslang_throwaway.rs (NOT committed —
// deleted immediately after the run; `git status` in secure-chat showed no
// changes afterward) that hardcoded this file's root_pub_b64 /
// sender_cert_b64 fixture values (see tests/fixtures/sealed-crosslang.json)
// and ran, using the crate's own `libsignal_protocol` (sig) dependency the
// same way crates/tyo-chat-core/src/core.rs does it:
//
//   let root = sig::PublicKey::try_from(&root_bytes[..])?;
//   let cert = sig::SenderCertificate::deserialize(&cert_bytes)?;
//   let ok = cert.validate(&root, sig::Timestamp::from_epoch_millis(now_ms))?;
//   assert!(ok);
//   assert_eq!(cert.sender_uuid()?, "alice");
//
// Built and run with:
//   PROTOC=<scratchpad>/protoc/bin/protoc \
//     cargo test -p tyo-chat-core --test zzz_crosslang_throwaway -- --nocapture
// Output: `test node_minted_sender_cert_validates_in_rust ... ok` — PASSED.
// The Node-minted SenderCertificate (minted via @signalapp/libsignal-client
// 0.99.2) deserialized cleanly in Rust (libsignal-protocol tag v0.99.1, the
// version pinned in secure-chat/crates/tyo-chat-core/Cargo.toml — a patch
// version behind the Node binding but the same wire-format generation),
// validated against the Node-generated root public key, and reported
// sender_uuid == "alice". This is the direct proof that Node-minted certs
// are wire-compatible with the Rust chat core.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { test, run } = require('./runner');
const {
    PrivateKey, IdentityKeyPair, ServerCertificate, SenderCertificate,
    ProtocolAddress, SessionStore, IdentityKeyStore, PreKeyStore, SignedPreKeyStore,
    KyberPreKeyStore, PreKeyRecord, SignedPreKeyRecord, KyberPreKeyRecord, KEMKeyPair,
    PreKeyBundle, processPreKeyBundle, sealedSenderEncryptMessage, sealedSenderDecryptMessage,
    IdentityChange,
} = require('@signalapp/libsignal-client');
const sealed = require('../lib/sealed-sender');

// ── Minimal in-memory store implementations (test-only scaffolding; the
// package itself does not ship these, unlike some other libsignal bindings). ──

class MemSessionStore extends SessionStore {
    constructor() { super(); this.m = new Map(); }
    async saveSession(name, record) { this.m.set(name.toString(), record); }
    async getSession(name) { return this.m.get(name.toString()) || null; }
    async getExistingSessions(addrs) { return addrs.map((a) => this.m.get(a.toString())).filter(Boolean); }
}

class MemIdentityStore extends IdentityKeyStore {
    constructor(idKeyPair, regId) { super(); this.idKeyPair = idKeyPair; this.regId = regId; this.m = new Map(); }
    async getIdentityKey() { return this.idKeyPair.privateKey; }
    async getLocalRegistrationId() { return this.regId; }
    async saveIdentity(name, key) { this.m.set(name.toString(), key); return IdentityChange.NewOrUnchanged; }
    async isTrustedIdentity() { return true; }
    async getIdentity(name) { return this.m.get(name.toString()) || null; }
}

class MemPreKeyStore extends PreKeyStore {
    constructor() { super(); this.m = new Map(); }
    async savePreKey(id, record) { this.m.set(id, record); }
    async getPreKey(id) { return this.m.get(id); }
    async removePreKey(id) { this.m.delete(id); }
}

class MemSignedPreKeyStore extends SignedPreKeyStore {
    constructor() { super(); this.m = new Map(); }
    async saveSignedPreKey(id, record) { this.m.set(id, record); }
    async getSignedPreKey(id) { return this.m.get(id); }
}

class MemKyberPreKeyStore extends KyberPreKeyStore {
    constructor() { super(); this.m = new Map(); }
    async saveKyberPreKey(id, record) { this.m.set(id, record); }
    async getKyberPreKey(id) { return this.m.get(id); }
    async markKyberPreKeyUsed() {}
}

test('full sealedSenderEncryptMessage -> sealedSenderDecryptMessage round-trip; writes cross-lang fixture', async () => {
    // ── CA + broker-minted sender cert (same path as lib/sealed-sender.js) ──
    const root = PrivateKey.generate();
    const serverKey = PrivateKey.generate();
    const serverCert = ServerCertificate.new(1, serverKey.getPublicKey(), root);
    const cfg = { serverCert, serverKey };

    const aliceIdKeyPair = IdentityKeyPair.generate();
    const now = Date.now();
    const { senderCert } = sealed.issueSenderCert(
        cfg, 'alice', aliceIdKeyPair.publicKey.serialize(), 1, 24 * 3600 * 1000, now);
    const cert = SenderCertificate.deserialize(senderCert);

    // Core cross-format concern: the cert deserializes and validates against
    // the root, and carries the identity that was minted.
    assert.strictEqual(cert.validate(root.getPublicKey(), now), true);
    assert.strictEqual(cert.senderUuid(), 'alice');

    // ── bob's prekey bundle material (recipient side) ──
    const bobIdKeyPair = IdentityKeyPair.generate();
    const bobRegId = 1234;
    const bobSignedPreKeyId = 1;
    const bobSignedPreKeyPair = PrivateKey.generate();
    const spkSig = bobIdKeyPair.privateKey.sign(bobSignedPreKeyPair.getPublicKey().serialize());
    const bobSignedPreKeyRecord = SignedPreKeyRecord.new(
        bobSignedPreKeyId, Date.now(), bobSignedPreKeyPair.getPublicKey(), bobSignedPreKeyPair, spkSig);

    const bobPreKeyId = 1;
    const bobPreKeyPair = PrivateKey.generate();
    const bobPreKeyRecord = PreKeyRecord.new(bobPreKeyId, bobPreKeyPair.getPublicKey(), bobPreKeyPair);

    const bobKyberKeyPair = KEMKeyPair.generate();
    const kyberSig = bobIdKeyPair.privateKey.sign(bobKyberKeyPair.getPublicKey().serialize());
    const bobKyberPreKeyRecord = KyberPreKeyRecord.new(1, Date.now(), bobKyberKeyPair, kyberSig);

    const bundle = PreKeyBundle.new(
        bobRegId, 1, bobPreKeyId, bobPreKeyPair.getPublicKey(),
        bobSignedPreKeyId, bobSignedPreKeyPair.getPublicKey(), spkSig,
        bobIdKeyPair.publicKey, 1, bobKyberKeyPair.getPublicKey(), kyberSig);

    const aliceAddress = ProtocolAddress.new('alice', 1);
    const bobAddress = ProtocolAddress.new('bob', 1);

    // ── alice (sender) establishes a session with bob and encrypts ──
    const aliceSession = new MemSessionStore();
    const aliceIdentity = new MemIdentityStore(aliceIdKeyPair, 999);
    await processPreKeyBundle(bundle, bobAddress, aliceAddress, aliceSession, aliceIdentity);

    const plaintext = Buffer.from('hello sealed cross-lang');
    const ciphertext = await sealedSenderEncryptMessage(plaintext, bobAddress, cert, aliceSession, aliceIdentity);

    // ── bob (recipient) decrypts, sealed-sender style: no address on the wire ──
    const bobSession = new MemSessionStore();
    const bobIdentity = new MemIdentityStore(bobIdKeyPair, bobRegId);
    const bobPreKeyStore = new MemPreKeyStore();
    await bobPreKeyStore.savePreKey(bobPreKeyId, bobPreKeyRecord);
    const bobSignedPreKeyStore = new MemSignedPreKeyStore();
    await bobSignedPreKeyStore.saveSignedPreKey(bobSignedPreKeyId, bobSignedPreKeyRecord);
    const bobKyberPreKeyStore = new MemKyberPreKeyStore();
    await bobKyberPreKeyStore.saveKyberPreKey(1, bobKyberPreKeyRecord);

    const result = await sealedSenderDecryptMessage(
        ciphertext, root.getPublicKey(), Date.now(), null, 'bob', 1,
        bobSession, bobIdentity, bobPreKeyStore, bobSignedPreKeyStore, bobKyberPreKeyStore);

    assert.strictEqual(Buffer.from(result.message()).toString(), 'hello sealed cross-lang');
    assert.strictEqual(result.senderUuid(), 'alice');
    assert.strictEqual(result.deviceId(), 1);

    // ── write the fixture Rust (or any other language) can replay ──
    const fixture = {
        root_pub_b64: Buffer.from(root.getPublicKey().serialize()).toString('base64'),
        sender_cert_b64: Buffer.from(cert.serialize()).toString('base64'),
    };
    const fixturePath = path.join(__dirname, 'fixtures', 'sealed-crosslang.json');
    fs.mkdirSync(path.dirname(fixturePath), { recursive: true });
    fs.writeFileSync(fixturePath, JSON.stringify(fixture, null, 2) + '\n');
});

run(); // executes the registered tests (repo runner); keep LAST
