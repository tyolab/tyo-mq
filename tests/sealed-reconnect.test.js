'use strict';
/**
 * Sealed online delivery survives a recipient RECONNECT.
 *
 * Field bug (Hilia, secure-chat over mq.tyo.com.au): a sealed message is
 * "delivered online" per the broker's ack, yet never reaches the recipient's
 * client, and nothing is durably queued. Root cause: when a client reconnects
 * (new socket) while its previous socket still looks connected server-side
 * (half-open / not yet reaped), the duplicate-consumer guard REJECTS the
 * newcomer and leaves the identity → socket mapping pinned to the DEAD socket.
 * The next SEALED_DELIVER then emits to that dead socket (reported 'online')
 * and is silently lost.
 *
 * A reconnecting client is distinguished from a genuinely-different second
 * instance by the stable, instance-unique id it presents (the Java client's
 * per-instance UUID, resent on every reconnect). Same id + same name =>
 * reconnect => displace the stale socket. Different id + same name =>
 * misconfiguration => still rejected.
 *
 * Recipients use a RAW socket.io client so the test controls the identification
 * id precisely (the Factory client always sends id = name).
 */
const assert = require('assert');
const { test, run } = require('./runner');
const { PrivateKey, ServerCertificate } = require('@signalapp/libsignal-client');
const { startServer, delay } = require('./helpers');
const Factory = require('tyo-mq-client').Factory;
const ioc = require('socket.io-client');

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
 * Raw socket.io recipient registering CONSUMER {name, id}. `id` is the stable,
 * instance-unique identity id (analogue of the Java client's per-instance
 * UUID). Captures SEALED_MESSAGE frames into `received`.
 */
function rawConsumer(port, name, id) {
    const received = [];
    const s = ioc('http://127.0.0.1:' + port, {
        transports: ['websocket'],
        forceNew: true,
        reconnection: false,
    });
    s.on('SEALED_MESSAGE', function (p) { received.push(p); });
    return new Promise((resolve, reject) => {
        s.on('connect', () => {
            s.emit('CONSUMER', JSON.stringify({ name: name, id: id, consumer_id: name }));
            setTimeout(() => resolve({ socket: s, received: received }), 120);
        });
        s.on('connect_error', reject);
    });
}

test('reconnect (same instance id) displaces the stale socket; sealed delivery reaches the new socket', async () => {
    const env = installSealedEnv();
    const srv = await startServer(sealedRealmOptions());
    try {
        // First connection — the "old" socket that will linger.
        const a = await rawConsumer(srv.port, 'bob', 'bob-instance-1');
        const set = await sealedCall(a.socket, 'SEALED_UAK_SET', { identity: 'bob', mode: 'unrestricted' });
        assert.strictEqual(set.ok, true);

        // Same instance reconnects on a NEW socket, presenting the SAME id while
        // the old socket is still connected server-side.
        const b = await rawConsumer(srv.port, 'bob', 'bob-instance-1');
        await delay(120);

        // The old socket is displaced (disconnected); the new one is live.
        assert.strictEqual(a.socket.connected, false, 'old socket must be displaced on reconnect');
        assert.strictEqual(b.socket.connected, true, 'reconnected socket must stay connected');

        // A sealed delivery now reaches the NEW socket, reported online.
        const anon = await new Factory(clientOpts(srv.port)).createProducer();
        await delay(120);
        const okDeliver = await sealedCall(anon.socket, 'SEALED_DELIVER', {
            to: { realm: 'default', identity: 'bob' },
            blob: Buffer.from('sealed-after-reconnect').toString('base64'),
            msg_id: 'r1',
        });
        assert.strictEqual(okDeliver.ok, true);
        assert.strictEqual(okDeliver.delivered, 'online');
        await delay(120);

        assert.strictEqual(b.received.length, 1, 'reconnected socket must receive the sealed message');
        assert.strictEqual(b.received[0].msg_id, 'r1');
        assert.strictEqual(a.received.length, 0, 'displaced socket must receive nothing');

        b.socket.disconnect();
        anon.disconnect();
    } finally { await srv.close(); env.restore(); }
});

test('a genuinely different instance (different id) with the same name is still rejected', async () => {
    const env = installSealedEnv();
    const srv = await startServer(sealedRealmOptions());
    try {
        const a = await rawConsumer(srv.port, 'bob', 'bob-instance-1');
        const set = await sealedCall(a.socket, 'SEALED_UAK_SET', { identity: 'bob', mode: 'unrestricted' });
        assert.strictEqual(set.ok, true);

        // Second, DIFFERENT instance claims the same name — misconfiguration.
        const errors = [];
        const b = await rawConsumer(srv.port, 'bob', 'bob-instance-2');
        b.socket.on('ERROR', (m) => errors.push(m));
        await delay(150);

        assert.strictEqual(a.socket.connected, true, 'the established consumer must be preserved');
        assert.strictEqual(b.socket.connected, false, 'the duplicate newcomer must be disconnected');

        // Delivery still reaches the original consumer A.
        const anon = await new Factory(clientOpts(srv.port)).createProducer();
        await delay(120);
        const okDeliver = await sealedCall(anon.socket, 'SEALED_DELIVER', {
            to: { realm: 'default', identity: 'bob' },
            blob: Buffer.from('to-original').toString('base64'),
            msg_id: 'd1',
        });
        assert.strictEqual(okDeliver.ok, true);
        assert.strictEqual(okDeliver.delivered, 'online');
        await delay(120);
        assert.strictEqual(a.received.length, 1, 'original consumer keeps receiving');
        assert.strictEqual(a.received[0].msg_id, 'd1');

        a.socket.disconnect();
        anon.disconnect();
    } finally { await srv.close(); env.restore(); }
});

run();
