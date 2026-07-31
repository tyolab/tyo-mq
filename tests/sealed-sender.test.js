'use strict';
const assert = require('assert');
const { test, run } = require('./runner');
const { PrivateKey, ServerCertificate, SenderCertificate } = require('@signalapp/libsignal-client');
const sealed = require('../lib/sealed-sender');

// Build an in-test CA: root -> server cert, and a client identity key.
function makeCfgAndRoot() {
    const root = PrivateKey.generate();
    const serverKey = PrivateKey.generate();
    const serverCert = ServerCertificate.new(1, serverKey.getPublicKey(), root);
    const env = {
        TYO_MQ_SEALED_SERVER_CERT: Buffer.from(serverCert.serialize()).toString('base64'),
        TYO_MQ_SEALED_SERVER_KEY: Buffer.from(serverKey.serialize()).toString('base64'),
    };
    return { cfg: sealed.loadConfig(env), rootPub: root.getPublicKey() };
}

test('loadConfig is null when unconfigured, non-null when set', () => {
    assert.strictEqual(sealed.loadConfig({}), null);
    assert.ok(sealed.isConfigured(makeCfgAndRoot().cfg));
});

test('issueSenderCert mints a cert that validates against the root and carries the identity', () => {
    const { cfg, rootPub } = makeCfgAndRoot();
    const clientKey = PrivateKey.generate();
    const { senderCert, serverCert } = sealed.issueSenderCert(
        cfg, 'alice', clientKey.getPublicKey().serialize(), 1, 24 * 3600 * 1000, Date.now());
    assert.ok(senderCert.length > 0 && serverCert.length > 0);
    const parsed = SenderCertificate.deserialize(senderCert);
    assert.strictEqual(parsed.senderUuid(), 'alice');
    assert.strictEqual(parsed.validate(rootPub, Date.now()), true);
    assert.strictEqual(parsed.validate(rootPub, parsed.expiration() + 1), false); // expired -> invalid
});

test('uakEqual is length-safe and correct', () => {
    assert.strictEqual(sealed.uakEqual(Buffer.alloc(16, 1), Buffer.alloc(16, 1)), true);
    assert.strictEqual(sealed.uakEqual(Buffer.alloc(16, 1), Buffer.alloc(16, 2)), false);
    assert.strictEqual(sealed.uakEqual(Buffer.alloc(16), Buffer.alloc(15)), false);
});

test('a sender cert does NOT validate against a different (foreign) root', () => {
    const { cfg } = makeCfgAndRoot();              // our CA
    const foreignRoot = PrivateKey.generate();     // an unrelated root
    const clientKey = PrivateKey.generate();
    const { senderCert } = sealed.issueSenderCert(
        cfg, 'alice', clientKey.getPublicKey().serialize(), 1, 24 * 3600 * 1000, Date.now());
    const parsed = SenderCertificate.deserialize(senderCert);
    assert.strictEqual(parsed.validate(foreignRoot.getPublicKey(), Date.now()), false);
});

run(); // executes the registered tests (repo runner); keep LAST
