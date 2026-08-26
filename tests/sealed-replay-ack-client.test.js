'use strict';
/**
 * Guaranteed-once sealed drain driven by the REAL JS client (tyo-mq-client
 * Subscriber): `sealedSubscribe(identity)` sends {identity, ack:true} and the
 * SEALED_MESSAGE listener answers the broker's per-message ack from the
 * `onSealedMessage` handler's outcome (resolve -> {ok:true}, throw/reject ->
 * {ok:false, message}).
 *
 * CLIENT RESOLUTION: this test requires the SIBLING CHECKOUT directly
 * (`/data/tyolab/node/tyo-mq-client`) instead of `require('tyo-mq-client')`.
 * The broker repo's node_modules/tyo-mq-client is a plain npm install (a
 * copy, not a symlink), so it goes stale the moment the sibling repo's
 * lib/subscriber.js changes; requiring the checkout guarantees this test
 * exercises the MODIFIED client. A direct require was chosen over `npm link`
 * because it is hermetic to this file — it leaves node_modules untouched for
 * every other test (which intentionally keep passing against the published
 * client surface).
 */
const assert = require('assert');
const { test, run } = require('./runner');
const { PrivateKey, ServerCertificate } = require('@signalapp/libsignal-client');
const { startServer, delay } = require('./helpers');
const Factory = require('/data/tyolab/node/tyo-mq-client').Factory;

function clientOpts(port) {
    return { host: '127.0.0.1', port: port, protocol: 'http' };
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
        restore: () => {
            process.env.TYO_MQ_SEALED_SERVER_CERT = prev.c;
            process.env.TYO_MQ_SEALED_SERVER_KEY = prev.k;
        },
    };
}

function sealedCall(sock, event, payload) {
    return new Promise((resolve) => sock.emit(event, payload, resolve));
}

/**
 * Seed bob's durable sealed inbox with n blobs (msg_id m1..mn): register
 * bob's UAK (unrestricted) via a consumer, go offline, then SEALED_DELIVER
 * n messages from an anonymous producer. (Same seeding pattern as
 * tests/sealed-replay-ack.test.js.)
 */
async function seedInbox(srv, n) {
    const bob = await new Factory(clientOpts(srv.port)).createConsumer('bob');
    await delay(150);
    const set = await sealedCall(bob.socket, 'SEALED_UAK_SET', { identity: 'bob', mode: 'unrestricted' });
    assert.strictEqual(set.ok, true);
    bob.disconnect();
    await delay(150);

    const anon = await new Factory(clientOpts(srv.port)).createProducer();   // ANONYMOUS-<uuid>
    await delay(150);
    for (let i = 1; i <= n; i++) {
        const q = await sealedCall(anon.socket, 'SEALED_DELIVER', {
            to: { realm: 'default', identity: 'bob' },
            blob: Buffer.from('blob-' + i).toString('base64'),
            msg_id: 'm' + i,
        });
        assert.strictEqual(q.ok, true, 'seed deliver ' + i + ' failed: ' + JSON.stringify(q));
        assert.strictEqual(q.delivered, 'queued');
    }
    anon.disconnect();
}

test('subscriber-driven ack drain: onSealedMessage receives all blobs, inbox empties', async () => {
    const env = installSealedEnv();
    const srv = await startServer(sealedRealmOptions());
    try {
        await seedInbox(srv, 3);

        const bob = await new Factory(clientOpts(srv.port)).createConsumer('bob');
        await delay(150);
        const got = [];
        // async handler: resolving the Promise must translate to {ok:true}
        bob.onSealedMessage = (blob, msgId) => {
            got.push({ blob, msgId });
            return Promise.resolve();
        };

        const res = await bob.sealedSubscribe('bob');
        assert.deepStrictEqual(res, { ok: true, replayed: 3, dead: 0, pending: 0, more: false });
        assert.deepStrictEqual(got.map(g => g.msgId), ['m1', 'm2', 'm3']);
        assert.deepStrictEqual(
            got.map(g => Buffer.from(g.blob, 'base64').toString()),
            ['blob-1', 'blob-2', 'blob-3']);

        // inbox is empty: a re-drain replays nothing...
        const again = await bob.sealedSubscribe('bob');
        assert.strictEqual(again.ok, true);
        assert.strictEqual(again.replayed, 0);
        assert.strictEqual(again.more, false);
        // ...and the durable store agrees.
        const left = await srv.server.store.dequeue('default', 'sealed:bob', 'bob');
        assert.deepStrictEqual(left, []);

        bob.disconnect();
    } finally { await srv.close(); env.restore(); }
});

test('subscriber handler that throws routes exactly that message to the DLQ', async () => {
    const env = installSealedEnv();
    const srv = await startServer(sealedRealmOptions());
    try {
        await seedInbox(srv, 3);

        const bob = await new Factory(clientOpts(srv.port)).createConsumer('bob');
        await delay(150);
        const got = [];
        // sync handler: a throw must translate to {ok:false, message}
        bob.onSealedMessage = (blob, msgId) => {
            got.push(msgId);
            if (msgId === 'm2') throw new Error('core refused');
        };

        const res = await bob.sealedSubscribe('bob');
        assert.deepStrictEqual(res, { ok: true, replayed: 2, dead: 1, pending: 0, more: false });
        assert.deepStrictEqual(got, ['m1', 'm2', 'm3']);

        // m2 is NOT requeued...
        const again = await bob.sealedSubscribe('bob');
        assert.strictEqual(again.replayed, 0);
        const left = await srv.server.store.dequeue('default', 'sealed:bob', 'bob');
        assert.deepStrictEqual(left, []);
        // ...it is in the DLQ, with the handler's reason attached.
        const dlq = await srv.server.store.listDlq('default');
        assert.strictEqual(dlq.length, 1);
        assert.strictEqual(dlq[0].message.msg_id, 'm2');
        assert.ok(/client refused sealed blob: core refused/.test(dlq[0].reason), 'reason was: ' + dlq[0].reason);

        bob.disconnect();
    } finally { await srv.close(); env.restore(); }
});

run(); // executes the registered tests (repo runner); keep LAST
