'use strict';
/**
 * Chat/sealed push-wake registry — durable backing store.
 *
 * Field finding (Hilia iOS, 2026-10-15): the PUSH_REGISTER registry was
 * in-memory only, so every broker restart dropped every registered endpoint.
 * A backgrounded phone's socket.io reconnect does not re-send PUSH_REGISTER,
 * so it stayed unpushable until the user next opened the app — three deploys
 * that day each silently switched iOS notifications off for everyone. These
 * tests pin that a registration SURVIVES a simulated restart (a sealed message
 * to the offline identity wakes the SAME token on the new broker without any
 * re-registration), that PUSH_UNREGISTER and a `gone` prune remove the row,
 * and that a push-less broker creates no file.
 *
 * Usage: node tests/push-registry-durable.test.js
 */
const assert = require('assert');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { test, run } = require('./runner');
const { PrivateKey, ServerCertificate } = require('@signalapp/libsignal-client');
const { startServer, delay } = require('./helpers');
const Factory = require('tyo-mq-client').Factory;

function tmpDb() {
    return path.join(os.tmpdir(), 'tyo-push-reg-' + process.pid + '-' + Math.floor(Math.random() * 1e9) + '.sqlite');
}
function cleanup(file) {
    for (const suffix of ['', '-wal', '-shm']) { try { fs.unlinkSync(file + suffix); } catch (e) {} }
}
function installSealedEnv() {
    const root = PrivateKey.generate();
    const serverKey = PrivateKey.generate();
    const serverCert = ServerCertificate.new(1, serverKey.getPublicKey(), root);
    const prev = { c: process.env.TYO_MQ_SEALED_SERVER_CERT, k: process.env.TYO_MQ_SEALED_SERVER_KEY };
    process.env.TYO_MQ_SEALED_SERVER_CERT = Buffer.from(serverCert.serialize()).toString('base64');
    process.env.TYO_MQ_SEALED_SERVER_KEY = Buffer.from(serverKey.serialize()).toString('base64');
    const put = (k, v) => { if (v === undefined) delete process.env[k]; else process.env[k] = v; };
    return { restore: () => { put('TYO_MQ_SEALED_SERVER_CERT', prev.c); put('TYO_MQ_SEALED_SERVER_KEY', prev.k); } };
}
function installPushEnv(on) {
    const prev = process.env.TYO_MQ_PUSH_TRANSPORT;
    if (on) process.env.TYO_MQ_PUSH_TRANSPORT = 'null'; else delete process.env.TYO_MQ_PUSH_TRANSPORT;
    return { restore: () => { if (prev === undefined) delete process.env.TYO_MQ_PUSH_TRANSPORT; else process.env.TYO_MQ_PUSH_TRANSPORT = prev; } };
}
function clientOpts(port) { return { host: '127.0.0.1', port: port, protocol: 'http' }; }
function serverOptions(file) {
    return { auth: { realms: { default: { e2ee: 'required' } } }, push_store: { filename: file } };
}
function call(client, event, payload) {
    return new Promise((resolve) => client.socket.emit(event, payload, resolve));
}
function storedEndpoints(file) {
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(file, { readOnly: true });
    const rows = db.prepare('SELECT realm, identity, transport, token FROM notify_push_endpoints').all();
    db.close();
    return rows;
}

test('a PUSH_REGISTER survives a broker restart: the SAME token is woken on the new broker with no re-registration', async () => {
    const env = installSealedEnv(), penv = installPushEnv(true);
    const file = tmpDb();
    const uak = Buffer.alloc(16, 3);
    try {
        // broker #1: bob registers UAK + push endpoint
        const srv1 = await startServer(serverOptions(file));
        assert.ok(srv1.server._push.store, 'push store created when push is configured');
        const bob1 = await new Factory(clientOpts(srv1.port)).createConsumer('bob');
        await delay(150);
        await call(bob1, 'SEALED_UAK_SET', { identity: 'bob', uak: uak.toString('base64'), mode: 'require-uak' });
        const reg = await call(bob1, 'PUSH_REGISTER', { identity: 'bob', transport: 'null', token: 'tok-survives', app_id: 'chat' });
        assert.strictEqual(reg.ok, true);
        await delay(100);
        assert.deepStrictEqual(storedEndpoints(file).map((r) => r.token), ['tok-survives'], 'written through to disk');
        bob1.disconnect();
        await srv1.close();

        // broker #2: same file, bob NEVER reconnects — a sealed message must still wake tok-survives
        const srv2 = await startServer(serverOptions(file));
        const nt = srv2.server._push.config.transport;
        assert.strictEqual(srv2.server._push.registry.count('default', 'bob'), 1, 'hydrated on boot');
        const anon = await new Factory(clientOpts(srv2.port)).createProducer();
        await delay(150);
        const q = await call(anon, 'SEALED_DELIVER', { to: { realm: 'default', identity: 'bob' }, uak: uak.toString('base64'), blob: Buffer.from('x').toString('base64'), msg_id: 'r1' });
        assert.strictEqual(q.delivered, 'queued');
        await delay(80);
        assert.strictEqual(nt.sent.length, 1, 'the wake fired on the restarted broker');
        assert.strictEqual(nt.sent[0].token, 'tok-survives');
        anon.disconnect();
        await srv2.close();
    } finally { penv.restore(); env.restore(); cleanup(file); }
});

test('PUSH_UNREGISTER and a gone-prune remove the row, so a dead token does not resurrect on restart', async () => {
    const env = installSealedEnv(), penv = installPushEnv(true);
    const file = tmpDb();
    const uak = Buffer.alloc(16, 4);
    try {
        const srv = await startServer(serverOptions(file));
        const nt = srv.server._push.config.transport;
        const bob = await new Factory(clientOpts(srv.port)).createConsumer('bob');
        await delay(150);
        await call(bob, 'SEALED_UAK_SET', { identity: 'bob', uak: uak.toString('base64'), mode: 'require-uak' });
        await call(bob, 'PUSH_REGISTER', { identity: 'bob', transport: 'null', token: 'tok-a' });
        await call(bob, 'PUSH_REGISTER', { identity: 'bob', transport: 'null', token: 'tok-b' });
        await delay(100);
        assert.strictEqual(storedEndpoints(file).length, 2);

        const un = await call(bob, 'PUSH_UNREGISTER', { identity: 'bob', transport: 'null', token: 'tok-a' });
        assert.strictEqual(un.ok, true);
        await delay(100);
        assert.deepStrictEqual(storedEndpoints(file).map((r) => r.token), ['tok-b'], 'unregister removes the row');

        // gone-prune: the transport reports tok-b dead on the next wake
        nt.markGone('tok-b');
        bob.disconnect();
        await delay(150);
        const anon = await new Factory(clientOpts(srv.port)).createProducer();
        await delay(150);
        await call(anon, 'SEALED_DELIVER', { to: { realm: 'default', identity: 'bob' }, uak: uak.toString('base64'), blob: Buffer.from('y').toString('base64'), msg_id: 'g1' });
        await delay(150);
        assert.strictEqual(storedEndpoints(file).length, 0, 'gone endpoint pruned from disk');
        anon.disconnect();
        await srv.close();
    } finally { penv.restore(); env.restore(); cleanup(file); }
});

test('with push unconfigured no store file is created', async () => {
    const env = installSealedEnv(), penv = installPushEnv(false);
    const file = tmpDb();
    try {
        const srv = await startServer(serverOptions(file));
        assert.strictEqual(srv.server._push.store, null);
        assert.ok(!fs.existsSync(file), 'no file for a push-less broker');
        await srv.close();
    } finally { penv.restore(); env.restore(); cleanup(file); }
});

run();
