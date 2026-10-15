'use strict';
/**
 * Push wake KINDS, coalesce reset, and the online lost-ack requeue.
 *
 * Field findings (Hilia, 2026-10-15):
 *  - APNs silent background wakes are throttled by Apple (a few per hour), so
 *    chat wakes to an iPhone need to be ALERT pushes — but receipts / key
 *    exchange / caps ride the same inbox and would then show phantom "New
 *    message" alerts. The broker cannot tell them apart (ciphertext), so the
 *    SENDER says per message: wake: "alert" | "silent" | false. A hint-less
 *    message gets the REALM default (push.default_wake), and the alert copy is
 *    realm config, never message content.
 *  - A 30 s per-identity coalesce window silently ate the second wake to a
 *    device killed inside the window ("queued, never pushed"). The window is
 *    now reset whenever the identity re-registers, so each offline episode
 *    gets its own wake.
 *  - The online branch emitted SEALED_MESSAGE with no ack: a send inside the
 *    ~15 s pingTimeout window after a kill was acked 'online' to the sender and
 *    LOST. For ack-capable recipients it now emits with an ack and durably
 *    requeues + wakes on timeout; older clients keep fire-and-forget.
 *
 * Usage: node tests/push-wake-kinds.test.js
 */
const assert = require('assert');
const crypto = require('crypto');
const http2 = require('http2');
const { test, run } = require('./runner');
const { PrivateKey, ServerCertificate } = require('@signalapp/libsignal-client');
const push = require('../lib/push');
const { startServer, delay } = require('./helpers');
const Factory = require('tyo-mq-client').Factory;
const ioc = require('socket.io-client');

// ── env helpers (same shape as push-wake.test.js) ──────────────────────────

function installSealedEnv() {
    const root = PrivateKey.generate();
    const serverKey = PrivateKey.generate();
    const serverCert = ServerCertificate.new(1, serverKey.getPublicKey(), root);
    const prev = { c: process.env.TYO_MQ_SEALED_SERVER_CERT, k: process.env.TYO_MQ_SEALED_SERVER_KEY };
    process.env.TYO_MQ_SEALED_SERVER_CERT = Buffer.from(serverCert.serialize()).toString('base64');
    process.env.TYO_MQ_SEALED_SERVER_KEY = Buffer.from(serverKey.serialize()).toString('base64');
    // Restore by DELETING when the var was unset: assigning `undefined` to
    // process.env stores the string "undefined", which the next sealed-less
    // test's broker would then try to parse as a certificate.
    const put = (k, v) => { if (v === undefined) delete process.env[k]; else process.env[k] = v; };
    return { restore: () => { put('TYO_MQ_SEALED_SERVER_CERT', prev.c); put('TYO_MQ_SEALED_SERVER_KEY', prev.k); } };
}
function installPushEnv() {
    const prev = process.env.TYO_MQ_PUSH_TRANSPORT;
    process.env.TYO_MQ_PUSH_TRANSPORT = 'null';
    return { restore: () => { if (prev === undefined) delete process.env.TYO_MQ_PUSH_TRANSPORT; else process.env.TYO_MQ_PUSH_TRANSPORT = prev; } };
}
function installAckTimeout(ms) {
    const prev = process.env.TYO_MQ_SEALED_REPLAY_ACK_TIMEOUT_MS;
    process.env.TYO_MQ_SEALED_REPLAY_ACK_TIMEOUT_MS = String(ms);
    return { restore: () => { if (prev === undefined) delete process.env.TYO_MQ_SEALED_REPLAY_ACK_TIMEOUT_MS; else process.env.TYO_MQ_SEALED_REPLAY_ACK_TIMEOUT_MS = prev; } };
}
function clientOpts(port) { return { host: '127.0.0.1', port: port, protocol: 'http' }; }
function realmOptions(pushCfg) {
    const realm = { e2ee: 'required' };
    if (pushCfg) realm.push = pushCfg;
    return { auth: { realms: { default: realm } } };
}
function call(client, event, payload) {
    return new Promise((resolve) => client.socket.emit(event, payload, resolve));
}
function sockCall(sock, event, payload) {
    return new Promise((resolve) => sock.emit(event, payload, resolve));
}
const HILIA_ALERT = { title: 'Hilia', body: 'New message', collapse_id: 'hilia-chat', extra: { hilia: 'wake' } };

// Register bob with a UAK + a null-transport push endpoint, then take him offline.
async function offlineBob(srv, uak) {
    const bob = await new Factory(clientOpts(srv.port)).createConsumer('bob');
    await delay(150);
    await call(bob, 'SEALED_UAK_SET', { identity: 'bob', uak: uak.toString('base64'), mode: 'require-uak' });
    const reg = await call(bob, 'PUSH_REGISTER', { identity: 'bob', transport: 'null', token: 'tok-bob', app_id: 'chat' });
    assert.strictEqual(reg.ok, true);
    bob.disconnect();
    await delay(150);
}
async function sealedSend(srv, uak, extra) {
    const anon = await new Factory(clientOpts(srv.port)).createProducer();
    await delay(150);
    const res = await call(anon, 'SEALED_DELIVER', Object.assign({
        to: { realm: 'default', identity: 'bob' },
        uak: uak.toString('base64'),
        blob: Buffer.from('x').toString('base64'),
        msg_id: 'm-' + Math.random().toString(36).slice(2, 8),
    }, extra || {}));
    anon.disconnect();
    return res;
}

// ── unit: payload + alert copy + APNs frame ────────────────────────────────

test('buildWakePayload: silent stays exactly as before; alert adds only `kind`, both contentless', () => {
    assert.deepStrictEqual(push.buildWakePayload(), { type: 'wake', v: 1 });
    assert.deepStrictEqual(push.buildWakePayload('silent'), { type: 'wake', v: 1 });
    assert.deepStrictEqual(push.buildWakePayload('alert'), { type: 'wake', v: 1, kind: 'alert' });
    push.FORBIDDEN_WAKE_KEYS.forEach((k) => assert.ok(!(k in push.buildWakePayload('alert'))));
});

test('normalizeWakeAlert: bounded, generic, strips aps/forbidden/marker keys from extra, defaults ids to the realm', () => {
    const a = push.normalizeWakeAlert({
        title: 'T'.repeat(500), body: 'B'.repeat(500),
        extra: { hilia: 'wake', aps: { alert: 'x' }, from: 'alice', type: 'nope', kind: 'nope', n: 42, obj: { a: 1 }, long: 'L'.repeat(200) },
    }, 'apps:hilia:chat');
    assert.strictEqual(a.title.length, 128);
    assert.strictEqual(a.body.length, 128);
    assert.strictEqual(a.collapse_id, 'apps:hilia:chat');
    assert.strictEqual(a.thread_id, 'apps:hilia:chat');
    assert.deepStrictEqual(Object.keys(a.extra).sort(), ['hilia', 'long', 'n']);
    assert.strictEqual(a.extra.n, '42');
    assert.strictEqual(a.extra.long.length, 64);
    // defaults
    const d = push.normalizeWakeAlert(undefined, 'r');
    assert.deepStrictEqual(d, { title: 'New message', body: '', collapse_id: 'r', thread_id: 'r', extra: {} });
    // idempotent
    assert.deepStrictEqual(push.normalizeWakeAlert(a, 'apps:hilia:chat'), a);
});

test('buildApnsFrame: an alert-kind wake is a visible generic alert that still wakes; silent is unchanged', () => {
    const f = push.buildApnsFrame(push.buildWakePayload('alert'), push.normalizeWakeAlert(HILIA_ALERT, 'apps:hilia:chat'));
    assert.strictEqual(f.pushType, 'alert');
    assert.strictEqual(f.priority, '10');
    assert.strictEqual(f.collapseId, 'hilia-chat');
    const b = JSON.parse(f.body.toString('utf8'));
    assert.deepStrictEqual(b.aps.alert, { title: 'Hilia', body: 'New message' });
    assert.strictEqual(b.aps.sound, 'default');
    assert.strictEqual(b.aps['mutable-content'], 1);
    assert.strictEqual(b.aps['content-available'], 1);
    assert.strictEqual(b.aps['thread-id'], 'apps:hilia:chat');
    assert.strictEqual(b.hilia, 'wake', 'realm extra marker merged at top level');
    assert.strictEqual(b.type, 'wake');
    assert.strictEqual(b.kind, 'alert');
    push.FORBIDDEN_WAKE_KEYS.forEach((k) => assert.ok(!(k in b), 'alert frame leaked ' + k));

    const s = push.buildApnsFrame(push.buildWakePayload('silent'));
    assert.strictEqual(s.pushType, 'background');
    assert.strictEqual(s.priority, '5');
    assert.strictEqual(s.collapseId, undefined);
    assert.deepStrictEqual(JSON.parse(s.body.toString('utf8')), { aps: { 'content-available': 1 } });
});

test('ApnsTransport.send: an alert wake carries apns-push-type alert, priority 10 and apns-collapse-id on the wire', async () => {
    const EC = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256',
        publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
    const state = { requests: [] };
    const server = http2.createServer();
    server.on('stream', (stream, headers) => {
        let body = '';
        stream.setEncoding('utf8');
        stream.on('data', (c) => { body += c; });
        stream.on('error', () => {});
        stream.on('end', () => {
            state.requests.push({ pushType: headers['apns-push-type'], priority: headers['apns-priority'], collapseId: headers['apns-collapse-id'], body });
            try { stream.respond({ ':status': 200 }); stream.end(); } catch (e) {}
        });
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const authority = 'http://127.0.0.1:' + server.address().port;
    try {
        const t = new push.ApnsTransport({ p8: EC.privateKey, keyId: 'K1', teamId: 'T1', topic: 'au.com.tyo.hilia', productionHost: authority, sandboxHost: authority });
        const r = await t.send({ transport: 'apns', token: 'dev-1', payload: push.buildWakePayload('alert'), alert: push.normalizeWakeAlert(HILIA_ALERT, 'apps:hilia:chat') });
        assert.deepStrictEqual(r, { ok: true });
        const req = state.requests[0];
        assert.strictEqual(req.pushType, 'alert');
        assert.strictEqual(req.priority, '10');
        assert.strictEqual(req.collapseId, 'hilia-chat');
        assert.strictEqual(JSON.parse(req.body).aps.alert.title, 'Hilia');
        // and a silent wake has no collapse id header
        await t.send({ transport: 'apns', token: 'dev-1', payload: push.buildWakePayload() });
        assert.strictEqual(state.requests[1].pushType, 'background');
        assert.strictEqual(state.requests[1].collapseId, undefined);
    } finally { await new Promise((r) => server.close(r)); }
});

test('TokenRegistry.resetCoalesce lets the next wake through inside the window', () => {
    const reg = new push.TokenRegistry();
    assert.strictEqual(reg.coalesceOk('r', 'bob', 1000, 10000), true);
    assert.strictEqual(reg.coalesceOk('r', 'bob', 2000, 10000), false);
    reg.resetCoalesce('r', 'bob');
    assert.strictEqual(reg.coalesceOk('r', 'bob', 2100, 10000), true);
    reg.resetCoalesce('r', 'nobody'); // unknown is a no-op
});

test('fireWake: kind:false is skipped as suppressed; alert passes kind + realm copy to the transport; skips are logged at debug', async () => {
    const reg = new push.TokenRegistry();
    reg.register('r', 'bob', { transport: 'null', token: 't1' });
    const cfg = push.loadConfig({ TYO_MQ_PUSH_TRANSPORT: 'null' });
    const nt = cfg.transport;
    const debug = [];
    const logger = { debug: (m) => debug.push(String(m)), warn: () => {} };
    const off = await push.fireWake(cfg, reg, 'r', 'bob', { now: 1000, kind: false, logger });
    assert.strictEqual(off.skipped, 'suppressed');
    assert.strictEqual(nt.sent.length, 0);
    const a = await push.fireWake(cfg, reg, 'r', 'bob', { now: 1000, kind: 'alert', alert: HILIA_ALERT, logger });
    assert.strictEqual(a.sent, 1);
    assert.strictEqual(nt.sent[0].payload.kind, 'alert');
    assert.strictEqual(nt.sent[0].alert.title, 'Hilia');
    assert.strictEqual(nt.sent[0].alert.collapse_id, 'hilia-chat');
    const c = await push.fireWake(cfg, reg, 'r', 'bob', { now: 1500, kind: 'alert', alert: HILIA_ALERT, logger, coalesceWindowMs: 10000 });
    assert.strictEqual(c.skipped, 'coalesced');
    assert.ok(debug.some((m) => m.indexOf('reason=suppressed') >= 0) && debug.some((m) => m.indexOf('reason=coalesced') >= 0), 'every skip is observable at debug');
    assert.ok(debug.every((m) => m.indexOf('t1') < 0), 'debug never carries the token');
});

// ── integration: per-message hint + realm default ──────────────────────────

test('no hint + no realm config → silent wake (today\'s behaviour, unchanged)', async () => {
    const env = installSealedEnv(), penv = installPushEnv();
    const srv = await startServer(realmOptions());
    try {
        const nt = srv.server._push.config.transport;
        const uak = Buffer.alloc(16, 1);
        await offlineBob(srv, uak);
        const q = await sealedSend(srv, uak);
        assert.strictEqual(q.delivered, 'queued');
        await delay(80);
        assert.strictEqual(nt.sent.length, 1);
        assert.strictEqual(nt.sent[0].payload.kind, undefined, 'silent carries no kind');
        assert.strictEqual(nt.sent[0].alert, undefined);
    } finally { await srv.close(); penv.restore(); env.restore(); }
});

test('realm default_wake: "alert" → hint-less messages get an alert wake with the realm\'s copy', async () => {
    const env = installSealedEnv(), penv = installPushEnv();
    const srv = await startServer(realmOptions({ default_wake: 'alert', alert: HILIA_ALERT }));
    try {
        const nt = srv.server._push.config.transport;
        const uak = Buffer.alloc(16, 2);
        await offlineBob(srv, uak);
        await sealedSend(srv, uak);
        await delay(80);
        assert.strictEqual(nt.sent.length, 1);
        assert.strictEqual(nt.sent[0].payload.kind, 'alert');
        assert.deepStrictEqual(nt.sent[0].alert, { title: 'Hilia', body: 'New message', collapse_id: 'hilia-chat', thread_id: 'default', extra: { hilia: 'wake' } });
        push.FORBIDDEN_WAKE_KEYS.forEach((k) => assert.ok(!(k in nt.sent[0].payload)));
    } finally { await srv.close(); penv.restore(); env.restore(); }
});

test('per-message hint overrides the realm default in both directions, and wake:false sends nothing but still queues', async () => {
    const env = installSealedEnv(), penv = installPushEnv();
    const srv = await startServer(realmOptions({ default_wake: 'alert', alert: HILIA_ALERT }));
    try {
        const nt = srv.server._push.config.transport;
        const reg = srv.server._push.registry;
        const uak = Buffer.alloc(16, 3);
        await offlineBob(srv, uak);

        // wake:false → queued, no push at all (a receipt)
        const r0 = await sealedSend(srv, uak, { wake: false });
        assert.strictEqual(r0.delivered, 'queued');
        await delay(80);
        assert.strictEqual(nt.sent.length, 0, 'wake:false must not push');

        // "silent" on an alert-default realm → silent
        reg.resetCoalesce('default', 'bob');
        await sealedSend(srv, uak, { wake: 'silent' });
        await delay(80);
        assert.strictEqual(nt.sent.length, 1);
        assert.strictEqual(nt.sent[0].payload.kind, undefined);

        // "alert" explicitly → alert
        reg.resetCoalesce('default', 'bob');
        await sealedSend(srv, uak, { wake: 'alert' });
        await delay(80);
        assert.strictEqual(nt.sent.length, 2);
        assert.strictEqual(nt.sent[1].payload.kind, 'alert');

        // all three were durably queued regardless of the hint
        const bob = await new Factory(clientOpts(srv.port)).createConsumer('bob');
        await delay(150);
        const drained = await call(bob, 'SEALED_SUBSCRIBE', { identity: 'bob' });
        assert.strictEqual(drained.ok, true);
        bob.disconnect();
    } finally { await srv.close(); penv.restore(); env.restore(); }
});

test('plain pub/sub honours options.wake:false (queued, no wake) and the realm default otherwise', async () => {
    const penv = installPushEnv();
    const srv = await startServer({ auth: { realms: { default: { push: { default_wake: 'alert', alert: { title: 'Ops' } } } } } });
    try {
        const nt = srv.server._push.config.transport;
        const carol = await new Factory(clientOpts(srv.port)).createConsumer('carol');
        await delay(150);
        carol.subscribe('pubber', 'relay.new_request', function () {}, { durable: false });
        await call(carol, 'PUSH_REGISTER', { identity: 'carol', transport: 'null', token: 'tok-carol', app_id: 'ops' });
        await delay(80);
        carol.disconnect();
        await delay(150);

        const pubber = await new Factory(clientOpts(srv.port)).createProducer('pubber');
        await delay(150);
        // `wake` is a top-level PRODUCE message field (like `guaranteed`); the
        // Node client forwards only the options it knows, so emit the wire shape.
        pubber.socket.emit('PRODUCE', { event: 'relay.new_request', message: { ticket: 1 }, from: 'pubber', guaranteed: true, wake: false });
        await delay(200);
        assert.strictEqual(nt.sent.length, 0, 'wake:false must not push');
        pubber.produce('relay.new_request', { ticket: 2 }, { guaranteed: true });
        await delay(200);
        assert.strictEqual(nt.sent.length, 1);
        assert.strictEqual(nt.sent[0].payload.kind, 'alert', 'realm default applies to the plain path too');
        assert.strictEqual(nt.sent[0].alert.title, 'Ops');
        pubber.disconnect();
    } finally { await srv.close(); penv.restore(); }
});

// ── integration: coalesce reset on re-registration ─────────────────────────

test('coalesce reset: a device that came back and died again inside the window gets a fresh wake', async () => {
    const env = installSealedEnv(), penv = installPushEnv();
    const srv = await startServer(realmOptions());
    try {
        const nt = srv.server._push.config.transport;
        const uak = Buffer.alloc(16, 4);
        await offlineBob(srv, uak);
        await sealedSend(srv, uak);
        await delay(80);
        assert.strictEqual(nt.sent.length, 1);

        // bob comes back (re-registers), then goes away again — all inside 10 s
        const bob = await new Factory(clientOpts(srv.port)).createConsumer('bob');
        await delay(150);
        bob.disconnect();
        await delay(150);

        await sealedSend(srv, uak);
        await delay(80);
        assert.strictEqual(nt.sent.length, 2, 'the second offline episode gets its own wake');
    } finally { await srv.close(); penv.restore(); env.restore(); }
});

// ── integration: online lost-ack requeue ───────────────────────────────────

// Raw socket.io recipient so the test controls acking precisely.
function rawRecipient(port, name, opts) {
    const received = [];
    const s = ioc('http://127.0.0.1:' + port, { transports: ['websocket'], forceNew: true, reconnection: false });
    s.on('SEALED_MESSAGE', function (p, ack) {
        received.push(p);
        if (opts.ack && typeof ack === 'function') ack({ ok: true });
        // opts.ack === false: never ack (a killed phone looks exactly like this)
    });
    return new Promise((resolve, reject) => {
        s.on('connect', () => {
            s.emit('CONSUMER', JSON.stringify({ name: name, id: name + '-inst', consumer_id: name }));
            setTimeout(() => resolve({ socket: s, received }), 120);
        });
        s.on('connect_error', reject);
    });
}

test('online delivery to an ack-capable recipient that never acks is requeued + woken; the sender still sees online', async () => {
    const env = installSealedEnv(), penv = installPushEnv(), tenv = installAckTimeout(300);
    const srv = await startServer(realmOptions());
    try {
        const nt = srv.server._push.config.transport;
        const uak = Buffer.alloc(16, 5);
        const bob = await rawRecipient(srv.port, 'bob', { ack: false });
        await sockCall(bob.socket, 'SEALED_UAK_SET', { identity: 'bob', uak: uak.toString('base64'), mode: 'require-uak' });
        await sockCall(bob.socket, 'PUSH_REGISTER', { identity: 'bob', transport: 'null', token: 'tok-bob' });
        // declares ack capability (an empty guaranteed-once drain)
        const sub = await sockCall(bob.socket, 'SEALED_SUBSCRIBE', { identity: 'bob', ack: true });
        assert.strictEqual(sub.ok, true);

        const res = await sealedSend(srv, uak);
        assert.strictEqual(res.delivered, 'online', 'sender is answered immediately');
        await delay(100);
        assert.strictEqual(bob.received.length, 1, 'the frame was emitted to the live socket');
        assert.strictEqual(nt.sent.length, 0, 'no wake yet — ack still pending');

        await delay(500); // past the 300 ms ack timeout
        assert.strictEqual(nt.sent.length, 1, 'lost ack → wake fired');
        // and the message is durably queued: a fresh ack-mode drain replays it
        const bob2 = await rawRecipient(srv.port, 'bob', { ack: true });
        const drained = await sockCall(bob2.socket, 'SEALED_SUBSCRIBE', { identity: 'bob', ack: true });
        assert.strictEqual(drained.replayed, 1, 'lost-ack frame was requeued and replayed');
        assert.strictEqual(bob2.received.length, 1);
        bob2.socket.disconnect();
        bob.socket.disconnect();
    } finally { await srv.close(); tenv.restore(); penv.restore(); env.restore(); }
});

test('online delivery to a recipient that DID ack is not requeued; one that never declared ack capability is left fire-and-forget', async () => {
    const env = installSealedEnv(), penv = installPushEnv(), tenv = installAckTimeout(300);
    const srv = await startServer(realmOptions());
    try {
        const nt = srv.server._push.config.transport;
        const uak = Buffer.alloc(16, 6);
        // capable + acks
        const bob = await rawRecipient(srv.port, 'bob', { ack: true });
        await sockCall(bob.socket, 'SEALED_UAK_SET', { identity: 'bob', uak: uak.toString('base64'), mode: 'require-uak' });
        await sockCall(bob.socket, 'PUSH_REGISTER', { identity: 'bob', transport: 'null', token: 'tok-bob' });
        await sockCall(bob.socket, 'SEALED_SUBSCRIBE', { identity: 'bob', ack: true });
        await sealedSend(srv, uak);
        await delay(600);
        assert.strictEqual(bob.received.length, 1);
        assert.strictEqual(nt.sent.length, 0, 'acked → nothing requeued, nothing woken');
        bob.socket.disconnect();
        await delay(150);

        // never declared ack capability, never acks (an older client)
        const old = await rawRecipient(srv.port, 'bob', { ack: false });
        await sockCall(old.socket, 'SEALED_UAK_SET', { identity: 'bob', uak: uak.toString('base64'), mode: 'require-uak' });
        await sockCall(old.socket, 'PUSH_REGISTER', { identity: 'bob', transport: 'null', token: 'tok-bob' });
        await sealedSend(srv, uak);
        await delay(600);
        assert.strictEqual(old.received.length, 1);
        assert.strictEqual(nt.sent.length, 0, 'fire-and-forget for a non-capable recipient: no timeout requeue');
        old.socket.disconnect();
    } finally { await srv.close(); tenv.restore(); penv.restore(); env.restore(); }
});

// ── set_realm_push management command ──────────────────────────────────────

const adminSignature = require('tyo-mq-protocol').adminSignature;
const ADMIN_TOKEN = 'wake-kinds-admin-token';

function managementCommand(port, body) {
    const s = ioc('http://127.0.0.1:' + port, { transports: ['websocket'], forceNew: true, reconnection: false });
    return new Promise((resolve, reject) => {
        s.on('connect_error', reject);
        s.on('connect', () => {
            const payload = { body, proof: adminSignature.createAdminProof(ADMIN_TOKEN, 'AUTH_MANAGEMENT_COMMAND', body) };
            s.emit('AUTH_MANAGEMENT_COMMAND', payload, (res) => { s.disconnect(); resolve(res); });
        });
    });
}

test('set_realm_push: a signed management command sets (and clears) the realm default + alert copy, live, no restart', async () => {
    const env = installSealedEnv(), penv = installPushEnv();
    const srv = await startServer({
        auth: {
            enabled: true,
            tokens: [{ token: ADMIN_TOKEN, realm: '*', role: 'admin' }],
            // open realm: clients need no token, so the existing helpers work
            realms: { default: { required: false, e2ee: 'required' } },
        },
    });
    try {
        const nt = srv.server._push.config.transport;
        const reg = srv.server._push.registry;
        const uak = Buffer.alloc(16, 8);

        const bad = await managementCommand(srv.port, { command: 'set_realm_push', realm: 'default', default_wake: 'loud' });
        assert.strictEqual(bad.ok, false);
        assert.strictEqual(bad.code, 400);

        const set = await managementCommand(srv.port, { command: 'set_realm_push', realm: 'default', default_wake: 'alert', alert: Object.assign({ title: 'T'.repeat(300) }, HILIA_ALERT, { title: undefined }) });
        assert.strictEqual(set.ok, true, JSON.stringify(set));

        await offlineBob(srv, uak);
        await sealedSend(srv, uak);
        await delay(80);
        assert.strictEqual(nt.sent.length, 1);
        assert.strictEqual(nt.sent[0].payload.kind, 'alert', 'realm default now alert — no restart');
        assert.strictEqual(nt.sent[0].alert.collapse_id, 'hilia-chat');
        assert.deepStrictEqual(nt.sent[0].alert.extra, { hilia: 'wake' });

        // clearing: silent + no copy removes the block → back to silent
        const clear = await managementCommand(srv.port, { command: 'set_realm_push', realm: 'default', default_wake: 'silent' });
        assert.strictEqual(clear.ok, true);
        reg.resetCoalesce('default', 'bob');
        await sealedSend(srv, uak);
        await delay(80);
        assert.strictEqual(nt.sent.length, 2);
        assert.strictEqual(nt.sent[1].payload.kind, undefined);
        assert.strictEqual(nt.sent[1].alert, undefined);

        // an unsigned / wrongly-signed command is refused
        const forged = await new Promise((resolve) => {
            const s = ioc('http://127.0.0.1:' + srv.port, { transports: ['websocket'], forceNew: true, reconnection: false });
            s.on('connect', () => {
                const body = { command: 'set_realm_push', realm: 'default', default_wake: 'alert' };
                s.emit('AUTH_MANAGEMENT_COMMAND', { body, proof: adminSignature.createAdminProof('not-the-admin', 'AUTH_MANAGEMENT_COMMAND', body) }, (r) => { s.disconnect(); resolve(r); });
            });
        });
        assert.strictEqual(forged.ok, false);
    } finally { await srv.close(); penv.restore(); env.restore(); }
});

run();
