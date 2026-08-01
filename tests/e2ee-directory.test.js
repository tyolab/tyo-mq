/**
 * The broker-hosted E2EE public-key directory (KEY_PUBLISH / KEY_LOOKUP) and
 * the per-realm `e2ee` policy — see E2EE.md "Key discovery + the public-key
 * directory" and "Policy (per realm)".
 *
 * Usage: node tests/e2ee-directory.test.js
 */

'use strict';

const assert = require('assert');
const { test, run } = require('./runner');
const { startServer, delay } = require('./helpers');
const Factory = require('tyo-mq-client').Factory;
const Constants = require('tyo-mq-protocol').constants;

function clientOpts(port) {
    return { host: '127.0.0.1', port: port, protocol: 'http' };
}

test('a published key is discoverable by another client via KEY_LOOKUP', async () => {
    const srv = await startServer({});
    try {
        const dev = await new Factory(clientOpts(srv.port)).createConsumer('dev-consumer');
        const op = await new Factory(clientOpts(srv.port)).createProducer('op-console');
        await delay(200);

        const published = await dev.publishKey({ key_id: 'dev-1-enc', alg: 'ecdh-es-p256-a256gcm', public_key: 'BASE64-PUBKEY' });
        assert.strictEqual(published.ok, true);

        const found = await op.lookupKey('dev-consumer');
        assert.strictEqual(found.length, 1);
        assert.strictEqual(found[0].key_id, 'dev-1-enc');
        assert.strictEqual(found[0].alg, 'ecdh-es-p256-a256gcm');
        assert.strictEqual(found[0].public_key, 'BASE64-PUBKEY');

        // Republishing under the same key_id upserts rather than duplicating.
        await dev.publishKey({ key_id: 'dev-1-enc', alg: 'ecdh-es-p256-a256gcm', public_key: 'ROTATED-PUBKEY' });
        const rotated = await op.lookupKey('dev-consumer');
        assert.strictEqual(rotated.length, 1);
        assert.strictEqual(rotated[0].public_key, 'ROTATED-PUBKEY');

        // A never-published identity resolves to an empty list, not an error.
        const missing = await op.lookupKey('nobody-here');
        assert.deepStrictEqual(missing, []);

        dev.disconnect();
        op.disconnect();
    } finally {
        await srv.close();
    }
});

test('KEY_PUBLISH is rejected for an identity this connection never registered', async () => {
    const srv = await startServer({});
    try {
        const op = await new Factory(clientOpts(srv.port)).createProducer('op-console');
        await delay(200);

        await assert.rejects(
            () => op.publishKey({ identity: 'someone-else', key_id: 'k1', public_key: 'X' }),
            /not registered/
        );

        op.disconnect();
    } finally {
        await srv.close();
    }
});

test('the directory is scoped per realm — a key published in one realm is invisible in another', async () => {
    const srv = await startServer({
        auth: { enabled: true, realms: { 'realm-a': { required: false }, 'realm-b': { required: false } } }
    });
    try {
        const inA = await new Factory(Object.assign(clientOpts(srv.port), { auth: { realm: 'realm-a' } })).createConsumer('dev-consumer');
        const inB = await new Factory(Object.assign(clientOpts(srv.port), { auth: { realm: 'realm-b' } })).createProducer('op-console');
        await delay(200);

        await inA.publishKey({ key_id: 'k1', public_key: 'PUB-A' });
        const lookedUpFromB = await inB.lookupKey('dev-consumer');
        assert.deepStrictEqual(lookedUpFromB, [], 'a key published in realm-a must not be visible from realm-b');

        inA.disconnect();
        inB.disconnect();
    } finally {
        await srv.close();
    }
});

test('KEY_PUBLISH enforces size and per-identity caps', async () => {
    const srv = await startServer({});
    try {
        const dev = await new Factory(clientOpts(srv.port)).createConsumer('dev-consumer');
        await delay(200);

        // An oversized public key is rejected outright.
        await assert.rejects(
            () => dev.publishKey({ key_id: 'big', public_key: 'x'.repeat(Constants.E2EE_MAX_PUBLIC_KEY_LENGTH + 1) }),
            /public_key exceeds/
        );

        // An oversized key_id is rejected.
        await assert.rejects(
            () => dev.publishKey({ key_id: 'k'.repeat(Constants.E2EE_MAX_KEY_ID_LENGTH + 1), public_key: 'PUB' }),
            /key_id/
        );

        // The per-identity distinct-key_id cap: fill it, then one more fails...
        for (let i = 0; i < Constants.E2EE_MAX_KEYS_PER_IDENTITY; i++)
            await dev.publishKey({ key_id: 'k' + i, public_key: 'PUB' + i });
        await assert.rejects(
            () => dev.publishKey({ key_id: 'one-too-many', public_key: 'PUB' }),
            /published keys/
        );

        // ...but republishing (rotating) an existing key_id still succeeds.
        const rotated = await dev.publishKey({ key_id: 'k0', public_key: 'ROTATED' });
        assert.strictEqual(rotated.ok, true);
        const keys = await dev.lookupKey('dev-consumer');
        assert.strictEqual(keys.length, Constants.E2EE_MAX_KEYS_PER_IDENTITY);
        assert.strictEqual(keys.filter(k => k.key_id === 'k0')[0].public_key, 'ROTATED');

        dev.disconnect();
    } finally {
        await srv.close();
    }
});

test('a realm with e2ee: required rejects a cleartext PRODUCE', async () => {
    const srv = await startServer({
        auth: { realms: { default: { e2ee: 'required' } } }
    });
    try {
        const producer = await new Factory(clientOpts(srv.port)).createProducer('op-console');
        const consumer = await new Factory(clientOpts(srv.port)).createConsumer('dev-consumer');

        let delivered = false;
        consumer.subscribe(producer.name, 'cmd', function () { delivered = true; });
        await delay(200);

        const errPromise = new Promise((resolve) => producer.on('ERROR', resolve));
        producer.produce('cmd', { hello: 'world' });
        const err = await errPromise;
        assert.ok(/requires end-to-end encrypted/.test(err.message));

        await delay(300);
        assert.strictEqual(delivered, false, 'a cleartext message must never be delivered on a required-e2ee realm');

        producer.disconnect();
        consumer.disconnect();
    } finally {
        await srv.close();
    }
});

test('a realm with e2ee: opportunistic (default off) still accepts cleartext', async () => {
    const srv = await startServer({});
    try {
        const producer = await new Factory(clientOpts(srv.port)).createProducer('op-console');
        const consumer = await new Factory(clientOpts(srv.port)).createConsumer('dev-consumer');

        const got = new Promise((resolve) => {
            consumer.subscribe(producer.name, 'cmd', function (data) { resolve(data); });
        });
        await delay(200);
        producer.produce('cmd', { hello: 'world' });

        const data = await got;
        assert.deepStrictEqual(data, { hello: 'world' });

        producer.disconnect();
        consumer.disconnect();
    } finally {
        await srv.close();
    }
});

run();
