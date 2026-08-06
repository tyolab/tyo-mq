'use strict';
const assert = require('assert');
const http = require('http');
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

// Configure the broker for the UnifiedPush transport. allowLocal enables the
// dev flag so an http://127.0.0.1 test-sink endpoint is accepted (the
// http-in-test decision: we use an http loopback sink under the dev flag rather
// than standing up a self-signed https server).
function installUnifiedPushEnv(allowLocal) {
    const prevT = process.env.TYO_MQ_PUSH_TRANSPORT;
    const prevL = process.env.TYO_MQ_PUSH_ALLOW_LOCAL;
    process.env.TYO_MQ_PUSH_TRANSPORT = 'unifiedpush';
    if (allowLocal) process.env.TYO_MQ_PUSH_ALLOW_LOCAL = '1';
    else delete process.env.TYO_MQ_PUSH_ALLOW_LOCAL;
    return {
        restore: () => {
            if (prevT === undefined) delete process.env.TYO_MQ_PUSH_TRANSPORT; else process.env.TYO_MQ_PUSH_TRANSPORT = prevT;
            if (prevL === undefined) delete process.env.TYO_MQ_PUSH_ALLOW_LOCAL; else process.env.TYO_MQ_PUSH_ALLOW_LOCAL = prevL;
        },
    };
}

// A local HTTP endpoint that records the wake POSTs it receives. status()
// controls the response code; hang keeps the request open (timeout test).
function startPushSink(opts) {
    opts = Object.assign({ status: 200 }, opts || {});
    const received = [];
    const sockets = new Set();
    const srv = http.createServer((req, res) => {
        let body = '';
        req.on('data', (c) => { body += c; });
        req.on('end', () => {
            received.push({ method: req.method, url: req.url, headers: req.headers, body });
            if (opts.hang) return;            // never respond -> client times out
            res.statusCode = opts.status;
            res.end('ok');
        });
    });
    srv.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
    return new Promise((resolve) => {
        srv.listen(0, '127.0.0.1', () => {
            const port = srv.address().port;
            resolve({
                port,
                url: (path) => `http://127.0.0.1:${port}${path || '/wake'}`,
                received,
                setStatus: (s) => { opts.status = s; },
                close: () => new Promise((r) => { sockets.forEach((s) => s.destroy()); srv.close(r); }),
            });
        });
    });
}

// A logger that records every level's calls, for token-free-logging assertions.
function capturingLogger() {
    const calls = { warn: [], log: [], error: [], info: [], critical: [], output: [], debug: [], trace: [] };
    const mk = (lvl) => (...args) => { calls[lvl].push(args.map(String).join(' ')); };
    return {
        warn: mk('warn'), log: mk('log'), error: mk('error'), info: mk('info'),
        critical: mk('critical'), output: mk('output'), debug: mk('debug'), trace: mk('trace'),
        calls,
        all: () => Object.keys(calls).reduce((acc, k) => acc.concat(calls[k]), []),
    };
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
    // fcm is wired (P2) but demands its credentials file up front (see push-fcm.test.js)
    assert.throws(() => push.loadConfig({ TYO_MQ_PUSH_TRANSPORT: 'fcm' }), /TYO_MQ_PUSH_FCM_CREDENTIALS/);
    // apns is wired (P3) but demands its .p8 + identifiers up front (see push-apns.test.js)
    assert.throws(() => push.loadConfig({ TYO_MQ_PUSH_TRANSPORT: 'apns' }), /TYO_MQ_PUSH_APNS_KEY/);
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

// ── P4a: SSRF guard unit tests (pure, no server) ────────────────────────────

test('isSafePushUrl: rejects private/loopback/link-local/metadata + credentials + http, accepts public https', async () => {
    const rej = async (url, opts) => {
        const r = await push.isSafePushUrl(url, opts || {});
        assert.strictEqual(r.ok, false, 'should reject ' + url + ' (' + (r.reason || 'ok') + ')');
    };
    const acc = async (url, opts) => {
        const r = await push.isSafePushUrl(url, opts || {});
        assert.strictEqual(r.ok, true, 'should accept ' + url + ' (reason=' + r.reason + ')');
    };
    // metadata / private / loopback / link-local (literal IPs -> no DNS)
    await rej('http://169.254.169.254/latest/meta-data/');
    await rej('https://169.254.169.254/x');
    await rej('https://127.0.0.1/x');
    await rej('https://10.0.0.5/x');
    await rej('https://192.168.1.1/x');
    await rej('https://172.16.5.5/x');
    await rej('https://[::1]/x');
    await rej('https://[fc00::1]/x');
    await rej('https://[fe80::1]/x');
    await rej('https://0.0.0.0/x');
    // IPv6->IPv4 translation/embedding forms that smuggle a blocked v4 must be
    // decoded and rejected (fail-open guard hardening). All embed 169.254.169.254.
    await rej('https://[64:ff9b::a9fe:a9fe]/x');   // NAT64 well-known prefix (RFC 6052)
    await rej('https://[2002:a9fe:a9fe::]/x');     // 6to4 (RFC 3056) — inside 2000::/3
    await rej('https://[::a9fe:a9fe]/x');          // IPv4-compatible (deprecated)
    await rej('https://[64:ff9b::7f00:1]/x');      // NAT64 embedding 127.0.0.1
    // fail-CLOSED default: a range we do not explicitly vet is blocked, not ok.
    await rej('https://[fec0::1]/x');              // deprecated site-local
    await rej('https://[100::1]/x');               // discard-only 100::/64 (not global-unicast)
    // scheme + credentials
    await rej('http://example.com/x');                       // http to public host forbidden
    await rej('ftp://example.com/x');                        // non-http(s) scheme
    await rej('https://user:pass@1.1.1.1/x');                // credentials in URL
    await rej('not a url');
    await rej('A'.repeat(push.PUSH_MAX_TOKEN_LENGTH + 1));   // over length bound
    // acceptable public targets (literal public IP -> deterministic, no DNS)
    await acc('https://1.1.1.1/wake');
    await acc('https://172.32.0.1/x');                       // just outside 172.16/12
    await acc('https://[2606:4700:4700::1111]/x');           // genuine global-unicast IPv6
    await acc('https://[2002:0808:0808::]/x');               // 6to4 wrapping 8.8.8.8 (public v4)
    // dev flag opts INTO loopback only
    await acc('http://127.0.0.1:8080/wake', { allowLocal: true });
    await acc('https://127.0.0.1/x', { allowLocal: true });
    await rej('http://example.com/x', { allowLocal: true }); // still not a public http target
});

test('isSafePushUrl: DNS-rebind — a public host resolving to a private address is rejected (send-time re-check)', async () => {
    const toPrivate = async () => [{ address: '10.1.2.3', family: 4 }];
    const toPublic = async () => [{ address: '93.184.216.34', family: 4 }];
    const bad = await push.isSafePushUrl('https://rebind.example/x', { dnsLookup: toPrivate });
    assert.strictEqual(bad.ok, false);
    assert.strictEqual(bad.reason, 'blocked-address');
    const good = await push.isSafePushUrl('https://good.example/x', { dnsLookup: toPublic });
    assert.strictEqual(good.ok, true);
    // send-time re-check: transport.send refuses (unsafe) without connecting
    const t = new push.UnifiedPushTransport({ dnsLookup: toPrivate });
    const res = await t.send({ token: 'https://rebind.example/x', payload: push.buildWakePayload() });
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.unsafe, true);
});

// ── P4a: UnifiedPushTransport HTTP behaviour (real local sink) ───────────────

test('UnifiedPushTransport.send: 2xx -> ok, 404/410 -> gone, 500 -> transient (retain), timeout -> not gone', async () => {
    const t = new push.UnifiedPushTransport({ allowLocal: true, timeoutMs: 300 });
    const sink = await startPushSink({ status: 200 });
    try {
        let r = await t.send({ token: sink.url(), payload: push.buildWakePayload() });
        assert.deepStrictEqual(r, { ok: true });
        assert.strictEqual(sink.received.length, 1);
        assert.strictEqual(sink.received[0].method, 'POST');
        assert.deepStrictEqual(JSON.parse(sink.received[0].body), { type: 'wake', v: 1 });

        sink.setStatus(410);
        r = await t.send({ token: sink.url(), payload: push.buildWakePayload() });
        assert.deepStrictEqual(r, { ok: false, gone: true });

        sink.setStatus(404);
        r = await t.send({ token: sink.url(), payload: push.buildWakePayload() });
        assert.deepStrictEqual(r, { ok: false, gone: true });

        sink.setStatus(500);
        r = await t.send({ token: sink.url(), payload: push.buildWakePayload() });
        assert.deepStrictEqual(r, { ok: false });     // transient: no gone flag
    } finally { await sink.close(); }

    // timeout -> {ok:false} (retain), not gone
    const hung = await startPushSink({ hang: true });
    try {
        const r = await t.send({ token: hung.url(), payload: push.buildWakePayload() });
        assert.strictEqual(r.ok, false);
        assert.ok(!r.gone, 'a timeout must not prune (transient)');
    } finally { await hung.close(); }
});

// ── P4a: end-to-end wake POST through the broker ─────────────────────────────

test('unifiedpush e2e: offline sealed enqueue -> exactly ONE contentless POST to the endpoint', async () => {
    const env = installSealedEnv();
    const penv = installUnifiedPushEnv(true);
    const sink = await startPushSink({ status: 200 });
    const srv = await startServer(sealedRealmOptions());
    try {
        assert.strictEqual(srv.server._push.config.transportName, 'unifiedpush');
        const uak = Buffer.alloc(16, 11);
        const bob = await new Factory(clientOpts(srv.port)).createConsumer('bob');
        await delay(150);
        await call(bob, 'SEALED_UAK_SET', { identity: 'bob', uak: uak.toString('base64'), mode: 'require-uak' });
        const reg = await call(bob, 'PUSH_REGISTER', { identity: 'bob', transport: 'unifiedpush', token: sink.url(), app_id: 'chat' });
        assert.strictEqual(reg.ok, true, 'endpoint should register: ' + JSON.stringify(reg));
        assert.strictEqual(reg.count, 1);
        bob.disconnect();
        await delay(150);

        const anon = await new Factory(clientOpts(srv.port)).createProducer();
        await delay(150);
        const q = await call(anon, 'SEALED_DELIVER', { to: { realm: 'default', identity: 'bob' }, uak: uak.toString('base64'), blob: Buffer.from('x').toString('base64'), msg_id: 'u1' });
        assert.strictEqual(q.delivered, 'queued');
        await delay(200);

        assert.strictEqual(sink.received.length, 1, 'exactly one wake POST');
        assert.strictEqual(sink.received[0].method, 'POST');
        const payload = JSON.parse(sink.received[0].body);
        assert.deepStrictEqual(payload, { type: 'wake', v: 1 });
        ['sender', 'from', 'content', 'blob', 'msg_id', 'msgId', 'to', 'identity', 'realm', 'uak'].forEach(
            (k) => assert.ok(!(k in payload), 'wake leaked ' + k));
    } finally { await srv.close(); await sink.close(); penv.restore(); env.restore(); }
});

// ── P4a: SSRF guard enforced at registration ─────────────────────────────────

test('unifiedpush SSRF: PUSH_REGISTER rejects private/loopback/http URLs and stores none; a public https target is accepted', async () => {
    const env = installSealedEnv();
    const penv = installUnifiedPushEnv(false);   // allowLocal OFF: loopback must be rejected too
    const srv = await startServer(sealedRealmOptions());
    try {
        const bob = await new Factory(clientOpts(srv.port)).createConsumer('bob');
        await delay(150);
        const unsafe = [
            'http://169.254.169.254/latest/meta-data/',
            'https://127.0.0.1/hook',
            'https://10.0.0.5/hook',
            'https://192.168.1.1/hook',
            'http://example.com/hook',      // http to public host
            'https://[::1]/hook',
            'https://[fc00::1]/hook',
            'https://[64:ff9b::a9fe:a9fe]/hook',   // NAT64 -> 169.254.169.254
            'https://[2002:a9fe:a9fe::]/hook',     // 6to4 -> 169.254.169.254
            'https://[::a9fe:a9fe]/hook',          // IPv4-compatible -> 169.254.169.254
        ];
        for (const url of unsafe) {
            const r = await call(bob, 'PUSH_REGISTER', { identity: 'bob', transport: 'unifiedpush', token: url });
            assert.strictEqual(r.ok, false, 'should reject ' + url);
            assert.strictEqual(r.code, 400, 'should be 400 for ' + url);
        }
        assert.strictEqual(srv.server._push.registry.count('default', 'bob'), 0, 'no unsafe endpoint stored');
        // a public https target (literal IP -> no DNS in the test) is accepted
        const ok = await call(bob, 'PUSH_REGISTER', { identity: 'bob', transport: 'unifiedpush', token: 'https://1.1.1.1/wake' });
        assert.strictEqual(ok.ok, true, 'public https should register: ' + JSON.stringify(ok));
        assert.strictEqual(srv.server._push.registry.count('default', 'bob'), 1);
    } finally { await srv.close(); penv.restore(); env.restore(); }
});

// ── P4a: gone pruning via a real 410 ─────────────────────────────────────────

test('unifiedpush gone pruning: a 410 from the endpoint prunes it from the registry', async () => {
    const env = installSealedEnv();
    const penv = installUnifiedPushEnv(true);
    const sink = await startPushSink({ status: 410 });
    const srv = await startServer(sealedRealmOptions());
    try {
        const uak = Buffer.alloc(16, 12);
        const bob = await new Factory(clientOpts(srv.port)).createConsumer('bob');
        await delay(150);
        await call(bob, 'SEALED_UAK_SET', { identity: 'bob', uak: uak.toString('base64'), mode: 'require-uak' });
        await call(bob, 'PUSH_REGISTER', { identity: 'bob', transport: 'unifiedpush', token: sink.url() });
        assert.strictEqual(srv.server._push.registry.count('default', 'bob'), 1);
        bob.disconnect();
        await delay(150);

        const anon = await new Factory(clientOpts(srv.port)).createProducer();
        await delay(150);
        await call(anon, 'SEALED_DELIVER', { to: { realm: 'default', identity: 'bob' }, uak: uak.toString('base64'), blob: Buffer.from('z').toString('base64'), msg_id: 'gp1' });
        await delay(200);
        assert.strictEqual(srv.server._push.registry.count('default', 'bob'), 0, 'gone endpoint pruned');
    } finally { await srv.close(); await sink.close(); penv.restore(); env.restore(); }
});

// ── P4a: transient failure does NOT prune ────────────────────────────────────

test('unifiedpush transient: a 500 from the endpoint retains it in the registry', async () => {
    const env = installSealedEnv();
    const penv = installUnifiedPushEnv(true);
    const sink = await startPushSink({ status: 500 });
    const srv = await startServer(sealedRealmOptions());
    try {
        const uak = Buffer.alloc(16, 13);
        const bob = await new Factory(clientOpts(srv.port)).createConsumer('bob');
        await delay(150);
        await call(bob, 'SEALED_UAK_SET', { identity: 'bob', uak: uak.toString('base64'), mode: 'require-uak' });
        await call(bob, 'PUSH_REGISTER', { identity: 'bob', transport: 'unifiedpush', token: sink.url() });
        bob.disconnect();
        await delay(150);

        const anon = await new Factory(clientOpts(srv.port)).createProducer();
        await delay(150);
        await call(anon, 'SEALED_DELIVER', { to: { realm: 'default', identity: 'bob' }, uak: uak.toString('base64'), blob: Buffer.from('z').toString('base64'), msg_id: 'tr1' });
        await delay(200);
        assert.strictEqual(sink.received.length, 1, 'the wake was attempted');
        assert.strictEqual(srv.server._push.registry.count('default', 'bob'), 1, 'transient failure must retain the endpoint');
    } finally { await srv.close(); await sink.close(); penv.restore(); env.restore(); }
});

// ── P4a: failure metric is token-free (carry-forward #1) ─────────────────────

test('unifiedpush failure metric: a gone path logs a token-free warning that never contains the endpoint URL', async () => {
    const env = installSealedEnv();
    const penv = installUnifiedPushEnv(true);
    const sink = await startPushSink({ status: 410 });
    const srv = await startServer(sealedRealmOptions());
    const cap = capturingLogger();
    try {
        const uak = Buffer.alloc(16, 14);
        const bob = await new Factory(clientOpts(srv.port)).createConsumer('bob');
        await delay(150);
        await call(bob, 'SEALED_UAK_SET', { identity: 'bob', uak: uak.toString('base64'), mode: 'require-uak' });
        await call(bob, 'PUSH_REGISTER', { identity: 'bob', transport: 'unifiedpush', token: sink.url() });
        bob.disconnect();
        await delay(150);
        // swap in a capturing logger for the wake path
        srv.server.logger = cap;

        const anon = await new Factory(clientOpts(srv.port)).createProducer();
        await delay(150);
        await call(anon, 'SEALED_DELIVER', { to: { realm: 'default', identity: 'bob' }, uak: uak.toString('base64'), blob: Buffer.from('z').toString('base64'), msg_id: 'fm1' });
        await delay(200);

        const warns = cap.calls.warn;
        assert.ok(warns.some((w) => /push wake failed/.test(w) && /reason=gone/.test(w) && /transport=unifiedpush/.test(w)),
            'expected a token-free "push wake failed" warn: ' + JSON.stringify(warns));
        // no captured log at ANY level may contain the endpoint URL or host:port
        const hostPort = '127.0.0.1:' + sink.port;
        cap.all().forEach((line) => {
            assert.ok(line.indexOf(sink.url()) < 0, 'a log line leaked the endpoint URL: ' + line);
            assert.ok(line.indexOf(hostPort) < 0, 'a log line leaked the endpoint host:port: ' + line);
        });
    } finally { await srv.close(); await sink.close(); penv.restore(); env.restore(); }
});

run();
