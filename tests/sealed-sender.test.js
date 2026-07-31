'use strict';
const assert = require('assert');
const { test, run } = require('./runner');
const { PrivateKey, ServerCertificate, SenderCertificate } = require('@signalapp/libsignal-client');
const sealed = require('../lib/sealed-sender');
const { startServer, delay } = require('./helpers');
const Factory = require('../lib/factory');

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

// ── SEALED_CERT_REQUEST broker-boot tests ──────────────────────────────────
// Realm uses e2ee: 'required' (not 'off') for forward-compatibility with the
// later gate that scopes sealed commands behind getRealmE2eePolicy(realm) !==
// 'off' — mirrors the realm shape used in tests/e2ee-directory.test.js.

function clientOpts(port, auth) {
    return { host: '127.0.0.1', port: port, protocol: 'http', auth: auth };
}

function sealedRealmOptions() {
    return { auth: { realms: { default: { e2ee: 'required' } } } };
}

function installSealedEnv() {
    const root = PrivateKey.generate();
    const serverKey = PrivateKey.generate();
    const serverCert = ServerCertificate.new(1, serverKey.getPublicKey(), root);
    const prev = { c: process.env.TYO_MQ_SEALED_SERVER_CERT, k: process.env.TYO_MQ_SEALED_SERVER_KEY };
    process.env.TYO_MQ_SEALED_SERVER_CERT = Buffer.from(serverCert.serialize()).toString('base64');
    process.env.TYO_MQ_SEALED_SERVER_KEY = Buffer.from(serverKey.serialize()).toString('base64');
    return {
        rootPub: root.getPublicKey(),
        restore: () => {
            process.env.TYO_MQ_SEALED_SERVER_CERT = prev.c;
            process.env.TYO_MQ_SEALED_SERVER_KEY = prev.k;
        },
    };
}

function sealedCall(client, event, payload) {
    return new Promise((resolve) => client.socket.emit(event, payload, resolve));
}

test('SEALED_CERT_REQUEST issues a cert for an owned identity, refuses unowned, and refuses when unconfigured', async () => {
    const env = installSealedEnv();
    const srv = await startServer(sealedRealmOptions());
    try {
        const alice = await new Factory(clientOpts(srv.port)).createConsumer('alice');
        await delay(150);

        const ok = await sealedCall(alice, 'SEALED_CERT_REQUEST', {
            identity: 'alice',
            identity_key: Buffer.from(PrivateKey.generate().getPublicKey().serialize()).toString('base64'),
            device_id: 1,
        });
        assert.strictEqual(ok.ok, true);
        const parsed = SenderCertificate.deserialize(Buffer.from(ok.sender_cert, 'base64'));
        assert.strictEqual(parsed.senderUuid(), 'alice');
        assert.strictEqual(parsed.validate(env.rootPub, Date.now()), true);

        const bad = await sealedCall(alice, 'SEALED_CERT_REQUEST', { identity: 'mallory', identity_key: 'AAAA' });
        assert.strictEqual(bad.ok, false);
        assert.strictEqual(bad.code, 403);

        alice.disconnect();
    } finally {
        await srv.close();
        env.restore();
    }
});

test('SEALED_CERT_REQUEST returns 501 when the broker has no sealed config', async () => {
    const prev = { c: process.env.TYO_MQ_SEALED_SERVER_CERT, k: process.env.TYO_MQ_SEALED_SERVER_KEY };
    delete process.env.TYO_MQ_SEALED_SERVER_CERT;
    delete process.env.TYO_MQ_SEALED_SERVER_KEY;
    const srv = await startServer(sealedRealmOptions());
    try {
        const alice = await new Factory(clientOpts(srv.port)).createConsumer('alice');
        await delay(150);

        const res = await sealedCall(alice, 'SEALED_CERT_REQUEST', { identity: 'alice', identity_key: 'AAAA' });
        assert.strictEqual(res.ok, false);
        assert.strictEqual(res.code, 501);

        alice.disconnect();
    } finally {
        await srv.close();
        process.env.TYO_MQ_SEALED_SERVER_CERT = prev.c;
        process.env.TYO_MQ_SEALED_SERVER_KEY = prev.k;
    }
});

test('SEALED_UAK_SET stores per-realm and validates mode + uak length', async () => {
    const env = installSealedEnv();
    const srv = await startServer(sealedRealmOptions());
    try {
        const bob = await new Factory(clientOpts(srv.port)).createConsumer('bob');
        await delay(150);
        const u16 = Buffer.alloc(16, 7).toString('base64');
        const ok = await sealedCall(bob, 'SEALED_UAK_SET', { identity: 'bob', uak: u16, mode: 'require-uak' });
        assert.strictEqual(ok.ok, true);
        assert.strictEqual(ok.mode, 'require-uak');

        const short = await sealedCall(bob, 'SEALED_UAK_SET', { identity: 'bob', uak: Buffer.alloc(10).toString('base64'), mode: 'require-uak' });
        assert.strictEqual(short.ok, false);
        assert.strictEqual(short.code, 400);

        const unrestricted = await sealedCall(bob, 'SEALED_UAK_SET', { identity: 'bob', mode: 'unrestricted' });
        assert.strictEqual(unrestricted.ok, true);
        assert.strictEqual(unrestricted.mode, 'unrestricted');

        const unowned = await sealedCall(bob, 'SEALED_UAK_SET', { identity: 'carol', uak: u16, mode: 'require-uak' });
        assert.strictEqual(unowned.ok, false);
        assert.strictEqual(unowned.code, 403);

        // mode omitted -> defaults to require-uak (needs a valid uak)
        const defaulted = await sealedCall(bob, 'SEALED_UAK_SET', { identity: 'bob', uak: u16 });
        assert.strictEqual(defaulted.ok, true);
        assert.strictEqual(defaulted.mode, 'require-uak');

        // explicit-but-unrecognized mode -> 400 (no silent coercion)
        const bogus = await sealedCall(bob, 'SEALED_UAK_SET', { identity: 'bob', uak: u16, mode: 'bogus' });
        assert.strictEqual(bogus.ok, false);
        assert.strictEqual(bogus.code, 400);

        bob.disconnect();
    } finally {
        await srv.close();
        env.restore();
    }
});

run(); // executes the registered tests (repo runner); keep LAST
