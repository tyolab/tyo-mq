'use strict';
const assert = require('assert');
const { test, run } = require('./runner');
const { PrivateKey, ServerCertificate } = require('@signalapp/libsignal-client');
const push = require('../lib/push');
const { startServer, delay } = require('./helpers');
const Factory = require('tyo-mq-client').Factory;

// ── env helpers ────────────────────────────────────────────────────────────
function installSealedEnv() {
    const root = PrivateKey.generate();
    const serverKey = PrivateKey.generate();
    const serverCert = ServerCertificate.new(1, serverKey.getPublicKey(), root);
    const prev = { c: process.env.TYO_MQ_SEALED_SERVER_CERT, k: process.env.TYO_MQ_SEALED_SERVER_KEY };
    process.env.TYO_MQ_SEALED_SERVER_CERT = Buffer.from(serverCert.serialize()).toString('base64');
    process.env.TYO_MQ_SEALED_SERVER_KEY = Buffer.from(serverKey.serialize()).toString('base64');
    return {
        restore: () => {
            process.env.TYO_MQ_SEALED_SERVER_CERT = prev.c;
            process.env.TYO_MQ_SEALED_SERVER_KEY = prev.k;
        },
    };
}

function installPushEnv() {
    const prev = process.env.TYO_MQ_PUSH_TRANSPORT;
    process.env.TYO_MQ_PUSH_TRANSPORT = 'null';
    return { restore: () => { if (prev === undefined) delete process.env.TYO_MQ_PUSH_TRANSPORT; else process.env.TYO_MQ_PUSH_TRANSPORT = prev; } };
}

function clientOpts(port, auth) {
    return { host: '127.0.0.1', port: port, protocol: 'http', auth: auth };
}

function sealedRealmOptions(extra) {
    return Object.assign({ auth: { realms: { default: { e2ee: 'required' } } } }, extra || {});
}

function call(client, event, payload) {
    return new Promise((resolve) => client.socket.emit(event, payload, resolve));
}

// ── pure-module unit tests (no server) ──────────────────────────────────────

test('buildWakePayload is contentless and assertContentless rejects metadata leaks', () => {
    const p = push.buildWakePayload();
    push.FORBIDDEN_WAKE_KEYS.forEach((k) => assert.ok(!(k in p), 'wake payload must not contain ' + k));
    assert.strictEqual(p.type, 'wake');
    // asserting a leaked key throws
    assert.throws(() => push.assertContentless({ sender: 'alice' }), /forbidden key/);
    assert.throws(() => push.assertContentless({ msg_id: 'm1' }), /forbidden key/);
    assert.throws(() => push.assertContentless({ blob: 'xxx' }), /forbidden key/);
});

test('loadConfig: null when unset, NullTransport when TYO_MQ_PUSH_TRANSPORT=null, throws on unknown', () => {
    assert.strictEqual(push.loadConfig({}), null);
    assert.strictEqual(push.isConfigured(null), false);
    const cfg = push.loadConfig({ TYO_MQ_PUSH_TRANSPORT: 'null' });
    assert.ok(push.isConfigured(cfg));
    assert.strictEqual(cfg.transportName, 'null');
    assert.ok(cfg.transport instanceof push.NullTransport);
    assert.throws(() => push.loadConfig({ TYO_MQ_PUSH_TRANSPORT: 'bogus' }), /unknown push transport/);
    // reserved-but-unwired transports throw a clear "not implemented"
    assert.throws(() => push.loadConfig({ TYO_MQ_PUSH_TRANSPORT: 'fcm' }), /not implemented/);
});

test('TokenRegistry dedupes by (transport,token), caps per identity, and prunes', () => {
    const reg = new push.TokenRegistry({ maxPerIdentity: 3 });
    reg.register('r', 'bob', { transport: 'null', token: 't1', now: 1 });
    reg.register('r', 'bob', { transport: 'null', token: 't1', now: 2 });   // dedupe
    assert.strictEqual(reg.count('r', 'bob'), 1);
    reg.register('r', 'bob', { transport: 'null', token: 't2', now: 3 });
    reg.register('r', 'bob', { transport: 'null', token: 't3', now: 4 });
    reg.register('r', 'bob', { transport: 'null', token: 't4', now: 5 });   // over cap -> evict oldest (t1)
    const toks = reg.list('r', 'bob').map((e) => e.token);
    assert.deepStrictEqual(toks, ['t2', 't3', 't4']);
    // isolation across identities/realms
    assert.strictEqual(reg.count('r', 'carol'), 0);
    assert.strictEqual(reg.count('other', 'bob'), 0);
    // prune removes a single endpoint
    assert.strictEqual(reg.prune('r', 'bob', { transport: 'null', token: 't3' }), 1);
    assert.deepStrictEqual(reg.list('r', 'bob').map((e) => e.token), ['t2', 't4']);
    // prototype-key identities do not reach Object.prototype
    assert.strictEqual(reg.count('r', '__proto__'), 0);
});

test('TokenRegistry coalesceOk allows one per window then blocks', () => {
    const reg = new push.TokenRegistry();
    assert.strictEqual(reg.coalesceOk('r', 'bob', 1000, 30000), true);
    assert.strictEqual(reg.coalesceOk('r', 'bob', 1500, 30000), false);   // within window
    assert.strictEqual(reg.coalesceOk('r', 'bob', 40000, 30000), true);   // window elapsed
    assert.strictEqual(reg.coalesceOk('r', 'carol', 1500, 30000), true);  // independent identity
});

test('fireWake is a no-op when unconfigured, sends contentless when configured, coalesces, and prunes gone', async () => {
    const reg = new push.TokenRegistry();
    reg.register('r', 'bob', { transport: 'null', token: 't1' });
    // unconfigured -> no-op
    const off = await push.fireWake(null, reg, 'r', 'bob', { now: 1 });
    assert.strictEqual(off.sent, 0);
    assert.strictEqual(off.skipped, 'unconfigured');

    const cfg = push.loadConfig({ TYO_MQ_PUSH_TRANSPORT: 'null' });
    const nt = cfg.transport;
    const r1 = await push.fireWake(cfg, reg, 'r', 'bob', { now: 1000, coalesceWindowMs: 30000 });
    assert.strictEqual(r1.sent, 1);
    assert.strictEqual(nt.sent.length, 1);
    push.FORBIDDEN_WAKE_KEYS.forEach((k) => assert.ok(!(k in nt.sent[0].payload)));
    // within window -> coalesced
    const r2 = await push.fireWake(cfg, reg, 'r', 'bob', { now: 1200, coalesceWindowMs: 30000 });
    assert.strictEqual(r2.skipped, 'coalesced');
    assert.strictEqual(nt.sent.length, 1);
    // gone token -> pruned on next window
    nt.markGone('t1');
    await push.fireWake(cfg, reg, 'r', 'bob', { now: 60000, coalesceWindowMs: 30000 });
    assert.strictEqual(reg.count('r', 'bob'), 0);
});

// ── integration tests (broker) ──────────────────────────────────────────────

test('wake fires ONCE (contentless) on offline sealed enqueue', async () => {
    const env = installSealedEnv();
    const penv = installPushEnv();
    const srv = await startServer(sealedRealmOptions());
    try {
        const nt = srv.server._push.config.transport;
        assert.ok(nt, 'null transport should be configured');
        const uak = Buffer.alloc(16, 5);
        const bob = await new Factory(clientOpts(srv.port)).createConsumer('bob');
        await delay(150);
        await call(bob, 'SEALED_UAK_SET', { identity: 'bob', uak: uak.toString('base64'), mode: 'require-uak' });
        const reg = await call(bob, 'PUSH_REGISTER', { identity: 'bob', transport: 'null', token: 'tok-bob', app_id: 'chat' });
        assert.strictEqual(reg.ok, true);
        assert.strictEqual(reg.count, 1);
        bob.disconnect();
        await delay(150);

        const anon = await new Factory(clientOpts(srv.port)).createProducer();
        await delay(150);
        const q = await call(anon, 'SEALED_DELIVER', { to: { realm: 'default', identity: 'bob' }, uak: uak.toString('base64'), blob: Buffer.from('x').toString('base64'), msg_id: 'q1' });
        assert.strictEqual(q.ok, true);
        assert.strictEqual(q.delivered, 'queued');
        await delay(80);

        assert.strictEqual(nt.sent.length, 1);
        assert.strictEqual(nt.sent[0].token, 'tok-bob');
        const payload = nt.sent[0].payload;
        // contentless: no sender/content/msg-id
        ['sender', 'from', 'content', 'blob', 'msg_id', 'msgId', 'to', 'identity', 'realm'].forEach((k) => assert.ok(!(k in payload), 'wake leaked ' + k));
    } finally { await srv.close(); penv.restore(); env.restore(); }
});

test('online recipient -> NO wake (live socket path unchanged)', async () => {
    const env = installSealedEnv();
    const penv = installPushEnv();
    const srv = await startServer(sealedRealmOptions());
    try {
        const nt = srv.server._push.config.transport;
        const uak = Buffer.alloc(16, 6);
        const bob = await new Factory(clientOpts(srv.port)).createConsumer('bob');
        const received = [];
        bob.socket.on('SEALED_MESSAGE', (p) => received.push(p));
        await delay(150);
        await call(bob, 'SEALED_UAK_SET', { identity: 'bob', uak: uak.toString('base64'), mode: 'require-uak' });
        await call(bob, 'PUSH_REGISTER', { identity: 'bob', transport: 'null', token: 'tok-online' });

        const anon = await new Factory(clientOpts(srv.port)).createProducer();
        await delay(150);
        const d = await call(anon, 'SEALED_DELIVER', { to: { realm: 'default', identity: 'bob' }, uak: uak.toString('base64'), blob: Buffer.from('y').toString('base64'), msg_id: 'o1' });
        assert.strictEqual(d.delivered, 'online');
        await delay(100);
        assert.strictEqual(received.length, 1);
        assert.strictEqual(nt.sent.length, 0, 'no wake for an online recipient');
    } finally { await srv.close(); penv.restore(); env.restore(); }
});

test('coalescing: 5 offline messages within the window -> exactly ONE wake', async () => {
    const env = installSealedEnv();
    const penv = installPushEnv();
    const srv = await startServer(sealedRealmOptions());
    try {
        const nt = srv.server._push.config.transport;
        const uak = Buffer.alloc(16, 7);
        const bob = await new Factory(clientOpts(srv.port)).createConsumer('bob');
        await delay(150);
        await call(bob, 'SEALED_UAK_SET', { identity: 'bob', uak: uak.toString('base64'), mode: 'require-uak' });
        await call(bob, 'PUSH_REGISTER', { identity: 'bob', transport: 'null', token: 'tok-coalesce' });
        bob.disconnect();
        await delay(150);

        const anon = await new Factory(clientOpts(srv.port)).createProducer();
        await delay(150);
        const to = { realm: 'default', identity: 'bob' };
        for (let i = 0; i < 5; i++)
            await call(anon, 'SEALED_DELIVER', { to, uak: uak.toString('base64'), blob: Buffer.from('m' + i).toString('base64'), msg_id: 'c' + i });
        await delay(100);
        assert.strictEqual(nt.sent.length, 1, 'coalesced to a single wake');
    } finally { await srv.close(); penv.restore(); env.restore(); }
});

test('gone pruning: transport gone:true removes the endpoint from the registry', async () => {
    const env = installSealedEnv();
    const penv = installPushEnv();
    const srv = await startServer(sealedRealmOptions());
    try {
        const nt = srv.server._push.config.transport;
        nt.markGone('tok-dead');
        const uak = Buffer.alloc(16, 8);
        const bob = await new Factory(clientOpts(srv.port)).createConsumer('bob');
        await delay(150);
        await call(bob, 'SEALED_UAK_SET', { identity: 'bob', uak: uak.toString('base64'), mode: 'require-uak' });
        await call(bob, 'PUSH_REGISTER', { identity: 'bob', transport: 'null', token: 'tok-dead' });
        assert.strictEqual(srv.server._push.registry.count('default', 'bob'), 1);
        bob.disconnect();
        await delay(150);

        const anon = await new Factory(clientOpts(srv.port)).createProducer();
        await delay(150);
        await call(anon, 'SEALED_DELIVER', { to: { realm: 'default', identity: 'bob' }, uak: uak.toString('base64'), blob: Buffer.from('z').toString('base64'), msg_id: 'g1' });
        await delay(100);
        assert.strictEqual(srv.server._push.registry.count('default', 'bob'), 0, 'gone endpoint pruned');
    } finally { await srv.close(); penv.restore(); env.restore(); }
});

test('auth binding: PUSH_REGISTER under an unowned identity is rejected; owned is stored', async () => {
    const env = installSealedEnv();
    const penv = installPushEnv();
    const srv = await startServer(sealedRealmOptions());
    try {
        const bob = await new Factory(clientOpts(srv.port)).createConsumer('bob');
        await delay(150);
        // unowned identity -> 403
        const bad = await call(bob, 'PUSH_REGISTER', { identity: 'carol', transport: 'null', token: 'tok-attacker' });
        assert.strictEqual(bad.ok, false);
        assert.strictEqual(bad.code, 403);
        assert.strictEqual(srv.server._push.registry.count('default', 'carol'), 0);
        // owned identity -> stored
        const good = await call(bob, 'PUSH_REGISTER', { identity: 'bob', transport: 'null', token: 'tok-bob' });
        assert.strictEqual(good.ok, true);
        assert.strictEqual(srv.server._push.registry.count('default', 'bob'), 1);
        // unknown transport -> 400
        const badT = await call(bob, 'PUSH_REGISTER', { identity: 'bob', transport: 'telepathy', token: 'x' });
        assert.strictEqual(badT.ok, false);
        assert.strictEqual(badT.code, 400);
        // over-long token -> 400
        const badTok = await call(bob, 'PUSH_REGISTER', { identity: 'bob', transport: 'null', token: 'A'.repeat(push.PUSH_MAX_TOKEN_LENGTH + 1) });
        assert.strictEqual(badTok.ok, false);
        assert.strictEqual(badTok.code, 400);
        // PUSH_UNREGISTER removes the owned endpoint
        const un = await call(bob, 'PUSH_UNREGISTER', { identity: 'bob', transport: 'null', token: 'tok-bob' });
        assert.strictEqual(un.ok, true);
        assert.strictEqual(un.removed, 1);
        assert.strictEqual(srv.server._push.registry.count('default', 'bob'), 0);
    } finally { await srv.close(); penv.restore(); env.restore(); }
});

test('durable sealed inbox survives idle eviction and carries a multi-day TTL', async () => {
    const env = installSealedEnv();
    // push not required here — this is the durable-inbox decoupling. Aggressive
    // idle-eviction TTL so a manual sweep actually evicts the offline consumer.
    const srv = await startServer(sealedRealmOptions({ idle_eviction: { ttl_ms: 1, interval_ms: 999999 } }));
    try {
        const uak = Buffer.alloc(16, 9);
        let bob = await new Factory(clientOpts(srv.port)).createConsumer('bob');
        await delay(150);
        await call(bob, 'SEALED_UAK_SET', { identity: 'bob', uak: uak.toString('base64'), mode: 'require-uak' });
        bob.disconnect();
        await delay(150);

        const anon = await new Factory(clientOpts(srv.port)).createProducer();
        await delay(150);
        const q = await call(anon, 'SEALED_DELIVER', { to: { realm: 'default', identity: 'bob' }, uak: uak.toString('base64'), blob: Buffer.from('durable').toString('base64'), msg_id: 'd1' });
        assert.strictEqual(q.delivered, 'queued');

        // TTL is days, not the generic 24h store default.
        const stored = srv.server.store.messages.filter((m) => m.event === 'sealed:bob');
        assert.strictEqual(stored.length, 1);
        assert.ok(stored[0].expires_at > Date.now() + 2 * 24 * 3600 * 1000, 'sealed inbox TTL should be multiple days');

        // Idle-eviction reaps bob's (offline) consumer registration...
        const removed = srv.server.sweepIdleRegistrations();
        assert.ok(removed >= 1, 'the offline consumer registration should be evicted');
        // ...but the durable message is still there and drains on reconnect.
        bob = await new Factory(clientOpts(srv.port)).createConsumer('bob');
        const received = [];
        bob.socket.on('SEALED_MESSAGE', (p) => received.push(p));
        await delay(150);
        const sub = await call(bob, 'SEALED_SUBSCRIBE', { identity: 'bob' });
        assert.strictEqual(sub.ok, true);
        assert.strictEqual(sub.replayed, 1);
        await delay(100);
        assert.strictEqual(received.length, 1);
        assert.strictEqual(received[0].msg_id, 'd1');
    } finally { await srv.close(); env.restore(); }
});

test('feature-off: with push unconfigured, PUSH_REGISTER is 501 and offline delivery still queues', async () => {
    const env = installSealedEnv();
    // deliberately DO NOT set TYO_MQ_PUSH_TRANSPORT
    const prev = process.env.TYO_MQ_PUSH_TRANSPORT;
    delete process.env.TYO_MQ_PUSH_TRANSPORT;
    const srv = await startServer(sealedRealmOptions());
    try {
        assert.strictEqual(srv.server._push.config, null, 'push should be disabled');
        const uak = Buffer.alloc(16, 3);
        const bob = await new Factory(clientOpts(srv.port)).createConsumer('bob');
        await delay(150);
        await call(bob, 'SEALED_UAK_SET', { identity: 'bob', uak: uak.toString('base64'), mode: 'require-uak' });
        const reg = await call(bob, 'PUSH_REGISTER', { identity: 'bob', transport: 'null', token: 'tok' });
        assert.strictEqual(reg.ok, false);
        assert.strictEqual(reg.code, 501);
        bob.disconnect();
        await delay(150);

        const anon = await new Factory(clientOpts(srv.port)).createProducer();
        await delay(150);
        const q = await call(anon, 'SEALED_DELIVER', { to: { realm: 'default', identity: 'bob' }, uak: uak.toString('base64'), blob: Buffer.from('w').toString('base64'), msg_id: 'f1' });
        assert.strictEqual(q.ok, true);
        assert.strictEqual(q.delivered, 'queued');
    } finally { await srv.close(); if (prev === undefined) delete process.env.TYO_MQ_PUSH_TRANSPORT; else process.env.TYO_MQ_PUSH_TRANSPORT = prev; env.restore(); }
});

run();
