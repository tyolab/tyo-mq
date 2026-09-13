/**
 * Signal prekey directory (secure-chat): PREKEY_PUBLISH / PREKEY_TAKE with
 * atomic one-time-prekey consumption. See lib/server.js prekey handlers.
 *
 * Usage: node tests/e2ee-prekeys.test.js
 */

'use strict';

const assert = require('assert');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { test, run } = require('./runner');
const { startServer, delay } = require('./helpers');
const Factory = require('tyo-mq-client').Factory;

function tmpPrekeyDb() {
    return path.join(os.tmpdir(),
        'tyo-prekeys-e2e-' + process.pid + '-' + Math.floor(Math.random() * 1e9) + '.sqlite');
}
function cleanupDb(file) {
    for (const suffix of ['', '-wal', '-shm']) {
        try { fs.unlinkSync(file + suffix); } catch (e) {}
    }
}

function clientOpts(port, auth) {
    return { host: '127.0.0.1', port: port, protocol: 'http', auth: auth };
}

// PREKEY_STATS has no tyo-mq-client wrapper (it's an operator diagnostic that
// the raw secure-chat clients call over the socket protocol), so drive it
// through the client's underlying socket, the same one publishPrekeys uses.
function statPrekeys(client, identity) {
    return new Promise((resolve, reject) => {
        client.socket.emit('PREKEY_STATS', identity ? { identity: identity } : {}, function (resp) {
            if (resp && resp.ok) resolve(resp);
            else reject(new Error((resp && resp.message) || 'PREKEY_STATS failed'));
        });
    });
}

function bundle(overrides) {
    return Object.assign({
        identity_key: 'IDENT-PUB',
        registration_id: 4242,
        device_id: 1,
        signed_prekey_id: 7,
        signed_prekey: 'SIGNED-PUB',
        signed_prekey_sig: 'SIGNED-SIG',
        kyber_prekey_id: 9,           // PQXDH: signed Kyber prekey
        kyber_prekey: 'KYBER-PUB',
        kyber_prekey_sig: 'KYBER-SIG',
        one_time_prekeys: [{ id: 1, key: 'OTP-1' }, { id: 2, key: 'OTP-2' }, { id: 3, key: 'OTP-3' }],
    }, overrides);
}

test('publish a bundle; a peer takes it and consumes one-time prekeys one at a time', async () => {
    const srv = await startServer({});
    try {
        const alice = await new Factory(clientOpts(srv.port)).createConsumer('alice');
        const bob = await new Factory(clientOpts(srv.port)).createProducer('bob');
        await delay(150);

        const pub = await alice.publishPrekeys(bundle());
        assert.strictEqual(pub.ok, true);
        assert.strictEqual(pub.one_time_available, 3);

        // Bob starts a session: takes Alice's bundle, consuming OTP-1.
        const b1 = await bob.takePrekeys('alice');
        assert.strictEqual(b1.found, true);
        assert.strictEqual(b1.identity_key, 'IDENT-PUB');
        assert.strictEqual(b1.signed_prekey, 'SIGNED-PUB');
        assert.strictEqual(b1.signed_prekey_id, 7);
        assert.strictEqual(b1.kyber_prekey, 'KYBER-PUB');       // PQXDH carried through
        assert.strictEqual(b1.kyber_prekey_sig, 'KYBER-SIG');
        assert.strictEqual(b1.kyber_prekey_id, 9);
        assert.strictEqual(b1.registration_id, 4242);
        assert.strictEqual(b1.one_time_prekey, 'OTP-1');
        assert.strictEqual(b1.one_time_prekey_id, 1);           // id travels with the key
        assert.strictEqual(b1.one_time_remaining, 2);

        // A second take consumes a DIFFERENT one-time prekey (never reused).
        const b2 = await bob.takePrekeys('alice');
        assert.strictEqual(b2.one_time_prekey, 'OTP-2');
        assert.strictEqual(b2.one_time_prekey_id, 2);
        const b3 = await bob.takePrekeys('alice');
        assert.strictEqual(b3.one_time_prekey, 'OTP-3');

        // Pool exhausted: static bundle still returned, but no one-time prekey
        // (X3DH degrades safely).
        const b4 = await bob.takePrekeys('alice');
        assert.strictEqual(b4.found, true);
        assert.strictEqual(b4.identity_key, 'IDENT-PUB');
        assert.strictEqual(b4.one_time_prekey, null);
        assert.strictEqual(b4.one_time_prekey_id, null);
        assert.strictEqual(b4.kyber_prekey, 'KYBER-PUB');       // static PQXDH part still served
        assert.strictEqual(b4.one_time_remaining, 0);

        alice.disconnect();
        bob.disconnect();
    } finally {
        await srv.close();
    }
});

test('republishing replenishes the one-time pool and rotates the signed prekey', async () => {
    const srv = await startServer({});
    try {
        const alice = await new Factory(clientOpts(srv.port)).createConsumer('alice');
        const bob = await new Factory(clientOpts(srv.port)).createProducer('bob');
        await delay(150);

        await alice.publishPrekeys(bundle({ one_time_prekeys: [{ id: 1, key: 'OTP-1' }] }));
        await bob.takePrekeys('alice'); // consumes OTP-1 → pool empty

        // Replenish + rotate the signed prekey.
        const pub = await alice.publishPrekeys(bundle({ signed_prekey: 'SIGNED-PUB-v2', one_time_prekeys: [{ id: 9, key: 'OTP-9' }] }));
        assert.strictEqual(pub.one_time_available, 1);

        const b = await bob.takePrekeys('alice');
        assert.strictEqual(b.signed_prekey, 'SIGNED-PUB-v2');
        assert.strictEqual(b.one_time_prekey, 'OTP-9');

        alice.disconnect();
        bob.disconnect();
    } finally {
        await srv.close();
    }
});

test('PREKEY_PUBLISH is rejected for an identity this connection never registered', async () => {
    const srv = await startServer({});
    try {
        const bob = await new Factory(clientOpts(srv.port)).createProducer('bob');
        await delay(150);
        await assert.rejects(
            () => bob.publishPrekeys(bundle({ identity: 'someone-else' })),
            /not registered/
        );
        bob.disconnect();
    } finally {
        await srv.close();
    }
});

test('taking a bundle for an unknown identity returns null', async () => {
    const srv = await startServer({});
    try {
        const bob = await new Factory(clientOpts(srv.port)).createProducer('bob');
        await delay(150);
        const b = await bob.takePrekeys('nobody');
        assert.strictEqual(b, null);
        bob.disconnect();
    } finally {
        await srv.close();
    }
});

test('the prekey directory is realm-isolated', async () => {
    const srv = await startServer({
        auth: { enabled: true, realms: { 'realm-a': { required: false }, 'realm-b': { required: false } } }
    });
    try {
        const inA = await new Factory(clientOpts(srv.port, { realm: 'realm-a' })).createConsumer('alice');
        const inB = await new Factory(clientOpts(srv.port, { realm: 'realm-b' })).createProducer('bob');
        await delay(150);

        await inA.publishPrekeys(bundle());
        const fromB = await inB.takePrekeys('alice');
        assert.strictEqual(fromB, null, "a bundle published in realm-a must not be takeable from realm-b");

        inA.disconnect();
        inB.disconnect();
    } finally {
        await srv.close();
    }
});

test('a bundle without the Kyber prekey is rejected (PQXDH required)', async () => {
    const srv = await startServer({});
    try {
        const alice = await new Factory(clientOpts(srv.port)).createConsumer('alice');
        await delay(150);
        const noKyber = bundle();
        delete noKyber.kyber_prekey;
        delete noKyber.kyber_prekey_sig;
        await assert.rejects(() => alice.publishPrekeys(noKyber), /kyber_prekey/);
        alice.disconnect();
    } finally {
        await srv.close();
    }
});

test('a published bundle survives a broker restart (durable directory)', async () => {
    // The core regression: without the durable store the directory is node-local
    // in-memory, so a restart wipes alice's bundle and bob's next take gets
    // found:false → the accepter's first send fails with NoSession. With the
    // prekey_store wired, the bundle (and the consume) survive the restart.
    const file = tmpPrekeyDb();
    const opts = { prekey_store: { filename: file } };
    try {
        // First process: alice publishes, bob takes one (consumes OTP-1).
        const srv1 = await startServer(opts);
        assert.ok(srv1.server._prekeyStore, 'durable prekey store should be enabled by prekey_store setting');
        const alice1 = await new Factory(clientOpts(srv1.port)).createConsumer('alice');
        const bob1 = await new Factory(clientOpts(srv1.port)).createProducer('bob');
        await delay(150);
        await alice1.publishPrekeys(bundle());
        const t1 = await bob1.takePrekeys('alice');
        assert.strictEqual(t1.one_time_prekey_id, 1); // OTP-1 consumed
        alice1.disconnect();
        bob1.disconnect();
        await delay(50);
        if (srv1.server._prekeyStore) srv1.server._prekeyStore.close();
        await srv1.close();

        // Restart: a fresh broker over the same file hydrates alice's bundle.
        const srv2 = await startServer(opts);
        const bob2 = await new Factory(clientOpts(srv2.port)).createProducer('bob');
        await delay(150);
        const t2 = await bob2.takePrekeys('alice');
        assert.strictEqual(t2.found, true, 'alice bundle must survive the restart');
        assert.strictEqual(t2.identity_key, 'IDENT-PUB');
        assert.strictEqual(t2.signed_prekey, 'SIGNED-PUB');
        assert.strictEqual(t2.kyber_prekey, 'KYBER-PUB');
        // OTP-1 was consumed pre-restart and must NOT resurrect; next is OTP-2.
        assert.strictEqual(t2.one_time_prekey_id, 2, 'consumed OTK must not resurrect after restart');
        assert.strictEqual(t2.one_time_remaining, 1);
        bob2.disconnect();
        await delay(50);
        if (srv2.server._prekeyStore) srv2.server._prekeyStore.close();
        await srv2.close();
    } finally {
        cleanupDb(file);
    }
});

test('a drained-pool bundle still serves signed-prekey-only after a restart', async () => {
    // A long-lived account whose one-time pool is exhausted must still be
    // reachable by a fresh contact after a restart — X3DH completes on the
    // signed prekey alone (one_time_prekey null, all signed material present).
    const file = tmpPrekeyDb();
    const opts = { prekey_store: { filename: file } };
    try {
        const srv1 = await startServer(opts);
        const alice1 = await new Factory(clientOpts(srv1.port)).createConsumer('alice');
        const bob1 = await new Factory(clientOpts(srv1.port)).createProducer('bob');
        await delay(150);
        await alice1.publishPrekeys(bundle({ one_time_prekeys: [{ id: 1, key: 'OTP-1' }] }));
        await bob1.takePrekeys('alice'); // drains the single OTK
        alice1.disconnect();
        bob1.disconnect();
        await delay(50);
        if (srv1.server._prekeyStore) srv1.server._prekeyStore.close();
        await srv1.close();

        const srv2 = await startServer(opts);
        const bob2 = await new Factory(clientOpts(srv2.port)).createProducer('bob');
        await delay(150);
        const t = await bob2.takePrekeys('alice');
        assert.strictEqual(t.found, true, 'drained bundle still served after restart');
        assert.strictEqual(t.one_time_prekey, null, 'no OTK left — signed-prekey-only');
        assert.strictEqual(t.signed_prekey, 'SIGNED-PUB');
        assert.strictEqual(t.signed_prekey_sig, 'SIGNED-SIG');
        bob2.disconnect();
        await delay(50);
        if (srv2.server._prekeyStore) srv2.server._prekeyStore.close();
        await srv2.close();
    } finally {
        cleanupDb(file);
    }
});

test('PREKEY_STATS reports public directory metadata (counts, pool depth) and NO key material', async () => {
    const srv = await startServer({});
    try {
        const alice = await new Factory(clientOpts(srv.port)).createConsumer('alice');
        const carol = await new Factory(clientOpts(srv.port)).createConsumer('carol');
        const bob = await new Factory(clientOpts(srv.port)).createProducer('bob');
        await delay(150);

        await alice.publishPrekeys(bundle()); // 3 one-time prekeys
        await carol.publishPrekeys(bundle({ one_time_prekeys: [] })); // signed-prekey-only
        await bob.takePrekeys('alice'); // consume one of alice's OTKs → pool 2

        // Whole-realm view: two accounts have bundles, with the right pool depths.
        const all = await statPrekeys(bob);
        assert.strictEqual(all.ok, true);
        assert.strictEqual(all.count, 2);
        assert.strictEqual(all.identities.alice.has_bundle, true);
        assert.strictEqual(all.identities.alice.pool_size, 2, 'one OTK was consumed');
        assert.ok(all.identities.alice.updated_at, 'updated_at present');
        assert.strictEqual(all.identities.carol.has_bundle, true);
        assert.strictEqual(all.identities.carol.pool_size, 0, 'signed-prekey-only account');

        // No key material may appear anywhere in the response.
        const blob = JSON.stringify(all);
        ['IDENT-PUB', 'SIGNED-PUB', 'SIGNED-SIG', 'KYBER-PUB', 'KYBER-SIG', 'OTP-1', 'OTP-2', 'OTP-3']
            .forEach(secret => assert.strictEqual(blob.indexOf(secret), -1,
                'PREKEY_STATS must not leak key material: ' + secret));

        // Single-identity view for a known and an unknown account.
        const oneA = await statPrekeys(bob, 'alice');
        assert.strictEqual(oneA.count, 1);
        assert.strictEqual(oneA.identities.alice.pool_size, 2);
        const none = await statPrekeys(bob, 'nobody');
        assert.strictEqual(none.count, 0);
        assert.strictEqual(none.identities.nobody.has_bundle, false);
        assert.strictEqual(none.identities.nobody.pool_size, 0);

        alice.disconnect();
        carol.disconnect();
        bob.disconnect();
    } finally {
        await srv.close();
    }
});

test('PREKEY_STATS is realm-isolated (never reports another realm\'s accounts)', async () => {
    const srv = await startServer({
        auth: { enabled: true, realms: { 'realm-a': { required: false }, 'realm-b': { required: false } } }
    });
    try {
        const inA = await new Factory(clientOpts(srv.port, { realm: 'realm-a' })).createConsumer('alice');
        const inB = await new Factory(clientOpts(srv.port, { realm: 'realm-b' })).createProducer('bob');
        await delay(150);

        await inA.publishPrekeys(bundle());
        const fromB = await statPrekeys(inB);
        assert.strictEqual(fromB.count, 0, "realm-b must not see realm-a's alice");
        assert.strictEqual(fromB.identities.alice, undefined);

        inA.disconnect();
        inB.disconnect();
    } finally {
        await srv.close();
    }
});

run();
