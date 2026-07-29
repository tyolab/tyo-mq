/**
 * Signal prekey directory (secure-chat): PREKEY_PUBLISH / PREKEY_TAKE with
 * atomic one-time-prekey consumption. See lib/server.js prekey handlers.
 *
 * Usage: node tests/e2ee-prekeys.test.js
 */

'use strict';

const assert = require('assert');
const { test, run } = require('./runner');
const { startServer, delay } = require('./helpers');
const Factory = require('../lib/factory');

function clientOpts(port, auth) {
    return { host: '127.0.0.1', port: port, protocol: 'http', auth: auth };
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

run();
