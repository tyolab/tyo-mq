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

// ── SEALED_DELIVER ──────────────────────────────────────────────────────
// The sender connects ANONYMOUSLY (Factory.createProducer() with no name
// mints ANONYMOUS-<uuid> — see lib/subscriber.js, which Publisher extends).
// The default realm permits anonymous producers/consumers (isAnonymousAllowed
// falls back to `realmId === DEFAULT_REALM` since sealedRealmOptions() sets
// no allow_anonymous override), so no extra realm config is needed here.

test('SEALED_DELIVER authorises on UAK and delivers online with no sender', async () => {
    const env = installSealedEnv();
    const srv = await startServer(sealedRealmOptions());
    try {
        const bobFactory = new Factory(clientOpts(srv.port));
        const bob = await bobFactory.createConsumer('bob');
        // capture SEALED_MESSAGE on bob's socket:
        const received = [];
        bob.socket.on('SEALED_MESSAGE', function (p) { received.push(p); });
        await delay(150);
        const uak = Buffer.alloc(16, 9);
        const setRes = await sealedCall(bob, 'SEALED_UAK_SET', { identity: 'bob', uak: uak.toString('base64'), mode: 'require-uak' });
        assert.strictEqual(setRes.ok, true);

        // anonymous sender (no name):
        const anon = await new Factory(clientOpts(srv.port)).createProducer();   // ANONYMOUS-<uuid>
        await delay(150);
        const realmId = 'default';   // DEFAULT_REALM; both clients connect without an explicit realm.
        const okDeliver = await sealedCall(anon, 'SEALED_DELIVER', { to: { realm: realmId, identity: 'bob' }, uak: uak.toString('base64'), blob: Buffer.from('sealed-bytes').toString('base64'), msg_id: 'm1' });
        assert.strictEqual(okDeliver.ok, true);
        assert.strictEqual(okDeliver.delivered, 'online');
        await delay(100);
        assert.strictEqual(received.length, 1);
        assert.strictEqual(received[0].msg_id, 'm1');
        assert.ok(!('from' in received[0]) && !('sender' in received[0]));   // no sender on the wire

        // wrong UAK -> 403, nothing delivered:
        const badUak = Buffer.alloc(16, 1);
        const bad = await sealedCall(anon, 'SEALED_DELIVER', { to: { realm: realmId, identity: 'bob' }, uak: badUak.toString('base64'), blob: Buffer.from('x').toString('base64') });
        assert.strictEqual(bad.ok, false); assert.strictEqual(bad.code, 403);
        await delay(80);
        assert.strictEqual(received.length, 1);   // still only the first

        // unknown recipient -> 404:
        const unknown = await sealedCall(anon, 'SEALED_DELIVER', { to: { realm: realmId, identity: 'ghost' }, uak: uak.toString('base64'), blob: 'AAAA' });
        assert.strictEqual(unknown.ok, false); assert.strictEqual(unknown.code, 404);
    } finally { await srv.close(); env.restore(); }
});

test('SEALED_DELIVER in unrestricted mode delivers with no uak presented', async () => {
    const env = installSealedEnv();
    const srv = await startServer(sealedRealmOptions());
    try {
        const bob = await new Factory(clientOpts(srv.port)).createConsumer('bob');
        const received = [];
        bob.socket.on('SEALED_MESSAGE', function (p) { received.push(p); });
        await delay(150);
        const setRes = await sealedCall(bob, 'SEALED_UAK_SET', { identity: 'bob', mode: 'unrestricted' });
        assert.strictEqual(setRes.ok, true);
        assert.strictEqual(setRes.mode, 'unrestricted');

        const anon = await new Factory(clientOpts(srv.port)).createProducer();   // ANONYMOUS-<uuid>
        await delay(150);
        // No uak at all — unrestricted mode must skip the UAK check.
        const okDeliver = await sealedCall(anon, 'SEALED_DELIVER', { to: { realm: 'default', identity: 'bob' }, blob: Buffer.from('open-bytes').toString('base64'), msg_id: 'u1' });
        assert.strictEqual(okDeliver.ok, true);
        assert.strictEqual(okDeliver.delivered, 'online');
        await delay(100);
        assert.strictEqual(received.length, 1);
        assert.strictEqual(received[0].msg_id, 'u1');
        assert.ok(!('from' in received[0]) && !('sender' in received[0]));
    } finally { await srv.close(); env.restore(); }
});

test('SEALED_DELIVER routes cross-realm: anon sender on default reaches bob in acme', async () => {
    const env = installSealedEnv();
    // Two e2ee-enabled realms; required:false so a client may declare a realm
    // via auth.realm without presenting a token (mirrors tests/e2ee-directory.js).
    const srv = await startServer({ auth: { enabled: true, realms: {
        default: { required: false, e2ee: 'required' },
        acme: { required: false, e2ee: 'required' },
    } } });
    try {
        // Bob lives in realm 'acme'.
        const bob = await new Factory(clientOpts(srv.port, { realm: 'acme' })).createConsumer('bob');
        const received = [];
        bob.socket.on('SEALED_MESSAGE', function (p) { received.push(p); });
        await delay(150);
        const uak = Buffer.alloc(16, 5);
        const setRes = await sealedCall(bob, 'SEALED_UAK_SET', { identity: 'bob', uak: uak.toString('base64'), mode: 'require-uak' });
        assert.strictEqual(setRes.ok, true);

        // Anonymous sender stays on 'default'.
        const anon = await new Factory(clientOpts(srv.port, { realm: 'default' })).createProducer();
        await delay(150);
        const okDeliver = await sealedCall(anon, 'SEALED_DELIVER', { to: { realm: 'acme', identity: 'bob' }, uak: uak.toString('base64'), blob: Buffer.from('cross-realm').toString('base64'), msg_id: 'x1' });
        assert.strictEqual(okDeliver.ok, true);
        assert.strictEqual(okDeliver.delivered, 'online');
        await delay(100);
        assert.strictEqual(received.length, 1);
        assert.strictEqual(received[0].msg_id, 'x1');
        assert.ok(!('from' in received[0]) && !('sender' in received[0]));
    } finally { await srv.close(); env.restore(); }
});

test('SEALED_DELIVER rejects an over-large blob and prototype-key recipients', async () => {
    const env = installSealedEnv();
    const srv = await startServer(sealedRealmOptions());
    try {
        const anon = await new Factory(clientOpts(srv.port)).createProducer();
        await delay(150);

        // blob past the base64 length bound -> 400.
        const tooBig = 'A'.repeat(Math.ceil(65536 * 4 / 3) + 8);
        const big = await sealedCall(anon, 'SEALED_DELIVER', { to: { realm: 'default', identity: 'nobody' }, uak: Buffer.alloc(16).toString('base64'), blob: tooBig });
        assert.strictEqual(big.ok, false); assert.strictEqual(big.code, 400);

        // prototype-key identity must not resolve to an inherited value -> 404.
        const proto = await sealedCall(anon, 'SEALED_DELIVER', { to: { realm: 'default', identity: '__proto__' }, uak: Buffer.alloc(16).toString('base64'), blob: 'AAAA' });
        assert.strictEqual(proto.ok, false); assert.strictEqual(proto.code, 404);

        // prototype-key realm likewise -> 404.
        const protoRealm = await sealedCall(anon, 'SEALED_DELIVER', { to: { realm: '__proto__', identity: 'bob' }, uak: Buffer.alloc(16).toString('base64'), blob: 'AAAA' });
        assert.strictEqual(protoRealm.ok, false); assert.strictEqual(protoRealm.code, 404);
    } finally { await srv.close(); env.restore(); }
});

test('SEALED_DELIVER queues for an offline recipient; SEALED_SUBSCRIBE replays once', async () => {
    const env = installSealedEnv();
    const srv = await startServer(sealedRealmOptions());
    try {
        // bob registers + sets UAK, then DISCONNECTS (goes offline).
        const uak = Buffer.alloc(16, 5);
        let bob = await new Factory(clientOpts(srv.port)).createConsumer('bob');
        await delay(150);
        await sealedCall(bob, 'SEALED_UAK_SET', { identity: 'bob', uak: uak.toString('base64'), mode: 'require-uak' });
        bob.disconnect();
        await delay(150);

        // anon sender delivers while bob is offline -> queued.
        const anon = await new Factory(clientOpts(srv.port)).createProducer();
        await delay(150);
        const q = await sealedCall(anon, 'SEALED_DELIVER', { to: { realm: 'default', identity: 'bob' }, uak: uak.toString('base64'), blob: Buffer.from('offline-bytes').toString('base64'), msg_id: 'q1' });
        assert.strictEqual(q.ok, true); assert.strictEqual(q.delivered, 'queued');

        // bob reconnects, registers, subscribes -> receives the queued message.
        bob = await new Factory(clientOpts(srv.port)).createConsumer('bob');
        const received = [];
        bob.socket.on('SEALED_MESSAGE', function (p) { received.push(p); });
        await delay(150);
        const sub = await sealedCall(bob, 'SEALED_SUBSCRIBE', { identity: 'bob' });
        assert.strictEqual(sub.ok, true);
        await delay(120);
        assert.strictEqual(received.length, 1);
        assert.strictEqual(received[0].msg_id, 'q1');
        assert.ok(!('from' in received[0]) && !('sender' in received[0]));

        // a second SEALED_SUBSCRIBE replays nothing (already acked).
        const sub2 = await sealedCall(bob, 'SEALED_SUBSCRIBE', { identity: 'bob' });
        assert.strictEqual(sub2.ok, true);
        assert.strictEqual(sub2.replayed, 0);
        assert.strictEqual(sub2.more, false);
    } finally { await srv.close(); env.restore(); }
});

test('SEALED_DELIVER offline enqueue is bounded by max_queued_per_realm (507 when full)', async () => {
    const env = installSealedEnv();
    // cap the default realm's durable queue at 1 message.
    const srv = await startServer({
        auth: { realms: { default: { e2ee: 'required' } } },
        limits: { enabled: true, max_queued_per_realm: 1 },
    });
    try {
        const uak = Buffer.alloc(16, 5);
        const bob = await new Factory(clientOpts(srv.port)).createConsumer('bob');
        await delay(150);
        await sealedCall(bob, 'SEALED_UAK_SET', { identity: 'bob', uak: uak.toString('base64'), mode: 'require-uak' });
        bob.disconnect();
        await delay(150);

        const anon = await new Factory(clientOpts(srv.port)).createProducer();
        await delay(150);
        const to = { realm: 'default', identity: 'bob' };
        // first offline message fills the queue to the cap.
        const q1 = await sealedCall(anon, 'SEALED_DELIVER', { to, uak: uak.toString('base64'), blob: Buffer.from('a').toString('base64'), msg_id: 'c1' });
        assert.strictEqual(q1.ok, true); assert.strictEqual(q1.delivered, 'queued');
        // second is refused: recipient queue full -> 507.
        const q2 = await sealedCall(anon, 'SEALED_DELIVER', { to, uak: uak.toString('base64'), blob: Buffer.from('b').toString('base64'), msg_id: 'c2' });
        assert.strictEqual(q2.ok, false); assert.strictEqual(q2.code, 507);
    } finally { await srv.close(); env.restore(); }
});

run(); // executes the registered tests (repo runner); keep LAST
