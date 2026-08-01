/**
 * End-to-end encrypted payloads through a live broker: a producer encrypts to a
 * consumer's key, the broker relays only ciphertext, and the consumer's handler
 * receives the transparently-decrypted plaintext.
 *
 * Usage: node tests/e2ee-roundtrip.test.js
 */

'use strict';

const assert = require('assert');
const { test, run } = require('./runner');
const { startServer, delay } = require('./helpers');
const Factory = require('tyo-mq-client').Factory;
const e2ee = require('tyo-mq-client/lib/e2ee');

const dev = e2ee.generateKeyPair(); // the consumer device's encryption keypair

function resolver() {
    return {
        publicKey: function (identity) {
            return identity === 'dev-consumer' ? { kid: 'dev-1-enc', alg: e2ee.ALG, publicKey: dev.publicKey } : null;
        },
        privateKey: function (kid) {
            return kid === 'dev-1-enc' ? dev.privateKey : null;
        },
    };
}

function clientOpts(port, e2eeCfg) {
    return { host: '127.0.0.1', port: port, protocol: 'http', e2ee: e2eeCfg };
}

test('an encrypted produce is delivered decrypted; the wire carries only ciphertext', async () => {
    const srv = await startServer({});
    try {
        const cfg = { resolver: resolver(), policy: 'strict' };
        const producer = await new Factory(clientOpts(srv.port, cfg)).createProducer('op-console');
        const consumer = await new Factory(clientOpts(srv.port, cfg)).createConsumer('dev-consumer');

        const got = new Promise(function (resolve) {
            consumer.subscribe(producer.name, 'cmd', function (data, from, ack, obj) {
                resolve({ data: data, obj: obj });
            });
        });
        await delay(300);
        producer.produce('cmd', { shell: 'bash', command: 'whoami' }, { encryptTo: 'dev-consumer' });

        const r = await got;
        // The application handler receives PLAINTEXT — decryption is transparent.
        assert.deepStrictEqual(r.data, { shell: 'bash', command: 'whoami' });
        // The delivered envelope proves broker-blindness: enc metadata present, and
        // the raw payload the broker relayed is an opaque base64 ciphertext string.
        assert.ok(r.obj.enc && r.obj.enc.alg === e2ee.ALG, 'delivered message must carry enc metadata');
        assert.strictEqual(typeof r.obj.message, 'string');
        assert.ok(!/whoami/.test(r.obj.message), 'the relayed ciphertext must not contain the plaintext');

        producer.disconnect();
        consumer.disconnect();
    } finally {
        await srv.close();
    }
});

test('a consumer without the private key drops the ciphertext (never sees plaintext)', async () => {
    const srv = await startServer({});
    try {
        const producer = await new Factory(clientOpts(srv.port, { resolver: resolver() })).createProducer('op-console');
        // This consumer's resolver has no private key for the kid → cannot decrypt.
        const blindCfg = { resolver: { privateKey: function () { return null; }, publicKey: function () { return null; } } };
        const consumer = await new Factory(clientOpts(srv.port, blindCfg)).createConsumer('dev-consumer');

        let delivered = false;
        consumer.subscribe(producer.name, 'cmd', function () { delivered = true; });
        await delay(300);
        producer.produce('cmd', { secret: 'top' }, { encryptTo: 'dev-consumer' });
        await delay(400);

        assert.strictEqual(delivered, false, 'an undecryptable message must never reach the handler');

        producer.disconnect();
        consumer.disconnect();
    } finally {
        await srv.close();
    }
});

test('strict policy throws when the recipient has no key; opportunistic sends cleartext', async () => {
    const srv = await startServer({});
    try {
        const strict = await new Factory(clientOpts(srv.port, { resolver: resolver(), policy: 'strict' })).createProducer('op-1');
        assert.throws(function () { strict.produce('cmd', { x: 1 }, { encryptTo: 'unknown-device' }); });

        const opp = await new Factory(clientOpts(srv.port, { resolver: resolver(), policy: 'opportunistic' })).createProducer('op-2');
        // No key for the recipient + opportunistic ⇒ sends cleartext, does not throw.
        assert.doesNotThrow(function () { opp.produce('cmd', { x: 1 }, { encryptTo: 'unknown-device' }); });

        strict.disconnect();
        opp.disconnect();
    } finally {
        await srv.close();
    }
});

run();
