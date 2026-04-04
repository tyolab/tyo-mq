/**
 * tyo-mq server tests
 *
 * Runs against a local tyo-mq server started on TEST_PORT.
 * Usage:  node tests/server.test.js
 */

'use strict';

const assert  = require('assert');
const { test, run } = require('./runner');

const TyoMQServer = require('../lib/server');
const Factory     = require('../lib/factory');

const TEST_PORT = 17353;

// ─── server bootstrap ────────────────────────────────────────────────────────

const server = new TyoMQServer({ port: TEST_PORT });
const noop = () => {};
server.logger = { critical: noop, error: noop, warn: noop, output: noop, log: noop, info: noop, debug: noop, trace: noop }; // silence during tests
server.start(TEST_PORT);

function mq() {
    return new Factory({ host: '127.0.0.1', port: TEST_PORT, protocol: 'http' });
}

function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// ─── tests ───────────────────────────────────────────────────────────────────

/**
 * Basic: producer sends a message, consumer receives it.
 */
test('producer → consumer basic messaging', async () => {
    const client = mq();
    const producer  = await client.createProducer('test-producer-basic');
    const consumer  = await client.createConsumer('test-consumer-basic');

    const received = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('timeout waiting for message')), 4000);
        consumer.subscribe(producer.name, 'test-event', (data) => {
            clearTimeout(timer);
            resolve(data);
        });
        setTimeout(() => producer.produce('test-event', 'hello'), 500);
    });

    assert.strictEqual(received, 'hello', `expected 'hello', got '${received}'`);

    consumer.disconnect();
    producer.disconnect();
});

/**
 * Two consumers with different names both receive their messages.
 */
test('two consumers with unique names both receive messages', async () => {
    const client = mq();
    const producer  = await client.createProducer('test-producer-two');
    const consumerA = await client.createConsumer('test-consumer-two-a');
    const consumerB = await client.createConsumer('test-consumer-two-b');

    const results = {};

    await new Promise((resolve, reject) => {
        let count = 0;
        const timer = setTimeout(() => reject(new Error('timeout')), 5000);
        const done = (name, data) => {
            results[name] = data;
            if (++count === 2) { clearTimeout(timer); resolve(); }
        };
        consumerA.subscribe(producer.name, 'test-event-two', data => done('a', data));
        consumerB.subscribe(producer.name, 'test-event-two', data => done('b', data));
        setTimeout(() => producer.produce('test-event-two', 'world'), 500);
    });

    assert.strictEqual(results.a, 'world');
    assert.strictEqual(results.b, 'world');

    consumerA.disconnect();
    consumerB.disconnect();
    producer.disconnect();
});

/**
 * Duplicate consumer name: second registration must be rejected with an ERROR
 * and the first consumer must keep receiving messages.
 */
test('duplicate consumer name is rejected and first consumer still works', async () => {
    const client = mq();
    const SHARED_NAME = 'test-consumer-duplicate';

    const producer    = await client.createProducer('test-producer-dup');
    const consumerOK  = await client.createConsumer(SHARED_NAME);
    await delay(300); // let first registration settle

    // Second client with the same name — should be rejected
    let errorReceived = null;
    let duplicateDisconnected = false;

    const consumerDup = await new Promise((resolve) => {
        client.createConsumer(SHARED_NAME).then(resolve);
    });

    // Listen for ERROR on the duplicate socket
    consumerDup.socket.on('ERROR', (msg) => { errorReceived = msg; });
    consumerDup.socket.on('disconnect', () => { duplicateDisconnected = true; });

    await delay(1000); // give server time to reject

    assert.ok(errorReceived, 'duplicate should receive an ERROR message');
    assert.ok(
        JSON.stringify(errorReceived).toLowerCase().includes('duplicate'),
        `error should mention "duplicate", got: ${JSON.stringify(errorReceived)}`
    );
    assert.ok(duplicateDisconnected, 'duplicate socket should be disconnected by server');

    // Original consumer must still receive messages
    const received = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('first consumer timed out after duplicate rejection')), 4000);
        consumerOK.subscribe(producer.name, 'test-event-dup', (data) => {
            clearTimeout(timer);
            resolve(data);
        });
        setTimeout(() => producer.produce('test-event-dup', 'still-alive'), 500);
    });

    assert.strictEqual(received, 'still-alive',
        'first consumer should still receive messages after duplicate was rejected');

    consumerOK.disconnect();
    producer.disconnect();
});

/**
 * PING / PONG: server responds to PING with a PONG payload containing the
 * original message fields plus `pong` and `timestamp`.
 */
test('PING returns PONG with timestamp', async () => {
    const io_client = require('socket.io-client');
    const socket = io_client(`http://127.0.0.1:${TEST_PORT}`, { transports: ['websocket'] });

    await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('connect timeout')), 3000);
        socket.on('connect', () => { clearTimeout(timer); resolve(); });
    });

    const response = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('PONG timeout')), 3000);
        socket.emit('PING', { app_id: 'test-app' }, (resp) => {
            clearTimeout(timer);
            resolve(typeof resp === 'string' ? JSON.parse(resp) : resp);
        });
    });

    assert.ok(response.pong === 'PONG', `expected pong='PONG', got: ${JSON.stringify(response)}`);
    assert.ok(response.timestamp, 'response should include a timestamp');
    assert.ok(response.app_id === 'test-app', 'response should echo app_id');

    socket.disconnect();
});

/**
 * Consumer reconnect: after disconnect + reconnect with re-registration,
 * the consumer receives messages again (server's consumerMeta.socket updated).
 */
test('consumer receives messages after reconnect and re-registration', async () => {
    const client = mq();
    const producer = await client.createProducer('test-producer-reconnect');
    let consumer   = await client.createConsumer('test-consumer-reconnect');

    // First message — confirm it works initially
    const first = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('first message timeout')), 4000);
        consumer.subscribe(producer.name, 'test-reconnect-event', data => {
            clearTimeout(timer);
            resolve(data);
        });
        setTimeout(() => producer.produce('test-reconnect-event', 'before-disconnect'), 400);
    });
    assert.strictEqual(first, 'before-disconnect');

    // Disconnect and reconnect
    consumer.disconnect();
    await delay(500);
    consumer = await client.createConsumer('test-consumer-reconnect');

    // Second message — must arrive after re-registration
    const second = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('second message timeout after reconnect')), 5000);
        consumer.subscribe(producer.name, 'test-reconnect-event', data => {
            clearTimeout(timer);
            resolve(data);
        });
        setTimeout(() => producer.produce('test-reconnect-event', 'after-reconnect'), 800);
    });
    assert.strictEqual(second, 'after-reconnect');

    consumer.disconnect();
    producer.disconnect();
});

// ─── run ─────────────────────────────────────────────────────────────────────

run();
