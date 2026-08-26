'use strict';
/**
 * Guaranteed-once SEALED_SUBSCRIBE drain (opt-in ack mode).
 *
 * The recipient side uses a RAW socket.io client (not tyo-mq-client) so each
 * test controls ack behaviour precisely: answer, refuse, delay, or die
 * mid-drain. A raw socket registers via CONSUMER {name} — that is what puts
 * the identity into socket._tyoIdentities, which SEALED_SUBSCRIBE requires.
 *
 * Broker reads TYO_MQ_SEALED_REPLAY_ACK_TIMEOUT_MS at create() time; keep it
 * short here so timeout paths (mid-drain death) settle quickly.
 */
const assert = require('assert');
const { test, run } = require('./runner');
const { PrivateKey, ServerCertificate } = require('@signalapp/libsignal-client');
const { startServer, delay } = require('./helpers');
const Factory = require('tyo-mq-client').Factory;
const ioc = require('socket.io-client');

process.env.TYO_MQ_SEALED_REPLAY_ACK_TIMEOUT_MS = '500';

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
 * Raw socket.io recipient: connect and register as CONSUMER `name` so the
 * broker adds the identity to socket._tyoIdentities.
 */
function rawConsumer(port, name) {
    return new Promise((resolve, reject) => {
        const s = ioc('http://127.0.0.1:' + port, {
            transports: ['websocket'],
            forceNew: true,
            reconnection: false,
        });
        s.on('connect', () => {
            s.emit('CONSUMER', JSON.stringify({ name: name }));
            // CONSUMER is handled synchronously server-side; a short settle
            // delay mirrors the existing sealed-sender test pattern.
            setTimeout(() => resolve(s), 120);
        });
        s.on('connect_error', reject);
    });
}

/**
 * Seed bob's durable sealed inbox with n blobs (msg_id m1..mn):
 * register bob's UAK (unrestricted) via a Factory consumer, go offline,
 * then SEALED_DELIVER n messages from an anonymous Factory producer.
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

test('ack-mode drain acks each message and empties the inbox', async () => {
    const env = installSealedEnv();
    const srv = await startServer(sealedRealmOptions());
    try {
        await seedInbox(srv, 3);

        const bob = await rawConsumer(srv.port, 'bob');
        const got = [];
        const ackShapes = [];
        bob.on('SEALED_MESSAGE', (payload, ack) => {
            got.push(payload);
            ackShapes.push(typeof ack);
            if (typeof ack === 'function') ack({ ok: true });
        });

        const res = await sealedCall(bob, 'SEALED_SUBSCRIBE', { identity: 'bob', ack: true });
        assert.deepStrictEqual(res, { ok: true, replayed: 3, dead: 0, pending: 0, more: false });
        assert.deepStrictEqual(ackShapes, ['function', 'function', 'function']);   // server requested an ack each time
        assert.deepStrictEqual(got.map(p => p.msg_id), ['m1', 'm2', 'm3']);
        // payload gains queue_id (durable entry id) for client-side dedup
        got.forEach(p => assert.ok(typeof p.queue_id === 'string' && p.queue_id.length > 0));
        assert.ok(!('from' in got[0]) && !('sender' in got[0]));   // still no sender on the wire

        // re-drain: everything was acked, nothing left.
        const again = await sealedCall(bob, 'SEALED_SUBSCRIBE', { identity: 'bob', ack: true });
        assert.strictEqual(again.ok, true);
        assert.strictEqual(again.replayed, 0);
        assert.strictEqual(again.more, false);

        bob.disconnect();
    } finally { await srv.close(); env.restore(); }
});

test('mid-drain death loses nothing: unacked remainder survives in original order', async () => {
    const env = installSealedEnv();
    const srv = await startServer(sealedRealmOptions());
    try {
        await seedInbox(srv, 5);

        let bob = await rawConsumer(srv.port, 'bob');
        const first = [];
        let acked = 0;
        bob.on('SEALED_MESSAGE', (payload, ack) => {
            first.push(payload.msg_id);
            if (acked < 2) { acked++; if (typeof ack === 'function') ack({ ok: true }); }
            else bob.disconnect();   // die WITHOUT acking the 3rd
        });
        bob.emit('SEALED_SUBSCRIBE', { identity: 'bob', ack: true }, () => { /* socket dies; callback may never arrive */ });

        // wait past the ack timeout (500ms) so the drain settles server-side
        await delay(1200);
        assert.deepStrictEqual(first, ['m1', 'm2', 'm3']);   // m3 was delivered but never acked

        // exactly the 3 unacked entries remain, in ORIGINAL order (dequeue is non-destructive)
        const left = await srv.server.store.dequeue('default', 'sealed:bob', 'bob');
        assert.deepStrictEqual(left.map(e => e.message.msg_id), ['m3', 'm4', 'm5']);

        // reconnect + ack-drain re-delivers exactly those 3, in order
        bob = await rawConsumer(srv.port, 'bob');
        const second = [];
        bob.on('SEALED_MESSAGE', (p, ack) => { second.push(p.msg_id); ack({ ok: true }); });
        const res = await sealedCall(bob, 'SEALED_SUBSCRIBE', { identity: 'bob', ack: true });
        assert.strictEqual(res.ok, true);
        assert.strictEqual(res.replayed, 3);
        assert.strictEqual(res.more, false);
        assert.deepStrictEqual(second, ['m3', 'm4', 'm5']);

        bob.disconnect();
    } finally { await srv.close(); env.restore(); }
});

test('client-reported poison goes to the DLQ, not back to the queue', async () => {
    const env = installSealedEnv();
    const srv = await startServer(sealedRealmOptions());
    try {
        await seedInbox(srv, 3);

        const bob = await rawConsumer(srv.port, 'bob');
        const got = [];
        bob.on('SEALED_MESSAGE', (p, ack) => {
            got.push(p.msg_id);
            if (typeof ack !== 'function') return;
            if (p.msg_id === 'm2') ack({ ok: false, message: 'core refused' });
            else ack({ ok: true });
        });

        const res = await sealedCall(bob, 'SEALED_SUBSCRIBE', { identity: 'bob', ack: true });
        assert.deepStrictEqual(res, { ok: true, replayed: 2, dead: 1, pending: 0, more: false });
        assert.deepStrictEqual(got, ['m1', 'm2', 'm3']);

        // NOT re-delivered on re-drain...
        const again = await sealedCall(bob, 'SEALED_SUBSCRIBE', { identity: 'bob', ack: true });
        assert.strictEqual(again.replayed, 0);
        // ...and IS in the DLQ with the client's reason attached.
        const dlq = await srv.server.store.listDlq('default');
        assert.strictEqual(dlq.length, 1);
        assert.strictEqual(dlq[0].message.msg_id, 'm2');
        assert.ok(/client refused sealed blob: core refused/.test(dlq[0].reason), 'reason was: ' + dlq[0].reason);

        bob.disconnect();
    } finally { await srv.close(); env.restore(); }
});

test('no ack flag = legacy behaviour: acks on emit, payload unchanged', async () => {
    const env = installSealedEnv();
    const srv = await startServer(sealedRealmOptions());
    try {
        await seedInbox(srv, 2);

        const bob = await rawConsumer(srv.port, 'bob');
        const got = [];
        const ackShapes = [];
        bob.on('SEALED_MESSAGE', (p, ack) => {
            got.push(p);
            ackShapes.push(typeof ack);
            // never answer anything
        });

        const res = await sealedCall(bob, 'SEALED_SUBSCRIBE', { identity: 'bob' });
        assert.strictEqual(res.ok, true);
        assert.strictEqual(res.replayed, 2);
        assert.strictEqual(res.more, false);
        assert.ok(!('dead' in res) && !('pending' in res));   // legacy callback shape

        await delay(150);
        assert.deepStrictEqual(ackShapes, ['undefined', 'undefined']);   // server did NOT request acks
        assert.deepStrictEqual(got.map(p => p.msg_id), ['m1', 'm2']);
        got.forEach(p => assert.ok(!('queue_id' in p)));      // legacy payload byte-for-byte

        // inbox empty even though the client never answered anything
        const again = await sealedCall(bob, 'SEALED_SUBSCRIBE', { identity: 'bob' });
        assert.strictEqual(again.replayed, 0);
        assert.strictEqual(again.more, false);

        bob.disconnect();
    } finally { await srv.close(); env.restore(); }
});

test('concurrent ack-mode drain for the same identity is rejected with 409', async () => {
    const env = installSealedEnv();
    const srv = await startServer(sealedRealmOptions());
    try {
        await seedInbox(srv, 2);

        const bob = await rawConsumer(srv.port, 'bob');
        const got = [];
        let heldAck = null;
        bob.on('SEALED_MESSAGE', (p, ack) => {
            got.push(p.msg_id);
            if (got.length === 1) heldAck = ack;   // hold the first ack -> drain stays in flight
            else if (typeof ack === 'function') ack({ ok: true });
        });

        const firstDone = sealedCall(bob, 'SEALED_SUBSCRIBE', { identity: 'bob', ack: true });
        await delay(150);   // < ack timeout (500ms); first drain is now waiting on m1's ack

        const second = await sealedCall(bob, 'SEALED_SUBSCRIBE', { identity: 'bob', ack: true });
        assert.strictEqual(second.ok, false);
        assert.strictEqual(second.code, 409);

        heldAck({ ok: true });   // release; the first drain finishes normally
        const res = await firstDone;
        assert.strictEqual(res.ok, true);
        assert.strictEqual(res.replayed, 2);
        assert.deepStrictEqual(got, ['m1', 'm2']);

        // guard released: a fresh drain works again
        const again = await sealedCall(bob, 'SEALED_SUBSCRIBE', { identity: 'bob', ack: true });
        assert.strictEqual(again.ok, true);
        assert.strictEqual(again.replayed, 0);

        bob.disconnect();
    } finally { await srv.close(); env.restore(); }
});

run(); // executes the registered tests (repo runner); keep LAST
