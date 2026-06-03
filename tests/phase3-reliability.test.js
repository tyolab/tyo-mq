/**
 * Phase 3: delivery ACK, retry, and dead-letter queue behavior.
 *
 * Usage: node tests/phase3-reliability.test.js
 */

'use strict';

const assert = require('assert');
const ioClient = require('socket.io-client');
const Factory = require('../lib/factory');
const events = require('../lib/events');
const Storage = require('../lib/storage');
const { test, run } = require('./runner');
const { startServer, delay, waitFor } = require('./helpers');

function clientFor(port) {
    return new Factory({
        host: '127.0.0.1',
        port: port,
        protocol: 'http'
    });
}

function waitForNoMessage(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitUntil(fn, timeoutMs) {
    timeoutMs = timeoutMs || 4000;
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        const value = await fn();
        if (value)
            return value;
        await delay(50);
    }
    throw new Error('timeout waiting for condition');
}

function connectRaw(port) {
    const socket = ioClient(`http://127.0.0.1:${port}`, { transports: ['websocket'] });
    return waitFor(socket, 'connect').then(() => socket);
}

test('legacy durable consumer without ACK capability still replays once', async () => {
    const server = await startServer({storage: 'memory'});
    const client = clientFor(server.port);
    const producerName = 'phase3-legacy-producer';
    const consumerName = 'phase3-legacy-consumer';
    const eventName = 'phase3-legacy-event';
    const eventStr = events.toEventString(eventName);
    const consumerEvent = events.toConsumerEvent(eventStr, producerName);
    const consumeEvent = events.toConsumeEvent(consumerEvent);

    let producer;
    let legacySocket;
    let replaySocket;
    let checkSocket;
    try {
        producer = await client.createProducer(producerName);
        legacySocket = await connectRaw(server.port);
        legacySocket.emit('CONSUMER', {
            name: consumerName,
            id: consumerName,
            consumer_id: consumerName
        });
        legacySocket.emit('SUBSCRIBE', {
            event: eventStr,
            producer: producerName,
            consumer: consumerName,
            durable: true,
            consumer_id: consumerName
        });
        await delay(300);

        legacySocket.disconnect();
        await delay(300);
        producer.produce(eventName, 'legacy offline message');
        await delay(300);

        replaySocket = await connectRaw(server.port);
        const received = new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('legacy replay timeout')), 4000);
            replaySocket.on(consumeEvent, obj => {
                clearTimeout(timer);
                resolve(obj.message);
            });
        });
        replaySocket.emit('CONSUMER', {
            name: consumerName,
            id: consumerName,
            consumer_id: consumerName
        });
        replaySocket.emit('SUBSCRIBE', {
            event: eventStr,
            producer: producerName,
            consumer: consumerName,
            durable: true,
            consumer_id: consumerName
        });
        assert.strictEqual(await received, 'legacy offline message');

        replaySocket.disconnect();
        await delay(300);

        checkSocket = await connectRaw(server.port);
        let repeated = false;
        checkSocket.on(consumeEvent, () => {
            repeated = true;
        });
        checkSocket.emit('CONSUMER', {
            name: consumerName,
            id: consumerName,
            consumer_id: consumerName
        });
        checkSocket.emit('SUBSCRIBE', {
            event: eventStr,
            producer: producerName,
            consumer: consumerName,
            durable: true,
            consumer_id: consumerName
        });
        await waitForNoMessage(700);
        assert.strictEqual(repeated, false, 'legacy durable message should have been removed after replay');
    } finally {
        if (checkSocket) checkSocket.disconnect();
        if (replaySocket) replaySocket.disconnect();
        if (legacySocket) legacySocket.disconnect();
        if (producer) producer.disconnect();
        await server.close();
    }
});

test('current durable consumer without ACK option replays once without ACK', async () => {
    const server = await startServer({storage: 'memory'});
    const client = clientFor(server.port);
    const producerName = 'phase3-default-producer';
    const consumerName = 'phase3-default-consumer';
    const eventName = 'phase3-default-event';

    let producer;
    let firstConsumer;
    let secondConsumer;
    let thirdConsumer;
    try {
        producer = await client.createProducer(producerName);
        firstConsumer = await client.createConsumer(consumerName);
        firstConsumer.subscribe(producer.name, eventName, function () {}, {durable: true});
        await delay(300);

        firstConsumer.disconnect();
        await delay(300);
        producer.produce(eventName, 'default durable message');
        await delay(300);

        secondConsumer = await client.createConsumer(consumerName);
        const received = await new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('default durable replay timeout')), 4000);
            secondConsumer.subscribe(producer.name, eventName, (data, from, ack, raw) => {
                clearTimeout(timer);
                resolve({data, raw});
            }, {durable: true});
        });
        assert.strictEqual(received.data, 'default durable message');
        assert.strictEqual(received.raw.msgId, undefined);
        await delay(200);

        secondConsumer.disconnect();
        await delay(300);
        thirdConsumer = await client.createConsumer(consumerName);
        let repeated = false;
        thirdConsumer.subscribe(producer.name, eventName, () => {
            repeated = true;
        }, {durable: true});
        await waitForNoMessage(700);
        assert.strictEqual(repeated, false, 'default durable message should have been removed after replay');
    } finally {
        if (thirdConsumer) thirdConsumer.disconnect();
        if (secondConsumer) secondConsumer.disconnect();
        if (firstConsumer) firstConsumer.disconnect();
        if (producer) producer.disconnect();
        await server.close();
    }
});

test('durable consumer with explicit ACK auto-ACKs replayed message', async () => {
    const server = await startServer({storage: 'memory'});
    const client = clientFor(server.port);
    const producerName = 'phase3-auto-producer';
    const consumerName = 'phase3-auto-consumer';
    const eventName = 'phase3-auto-event';

    let producer;
    let firstConsumer;
    let secondConsumer;
    let thirdConsumer;
    try {
        producer = await client.createProducer(producerName);
        firstConsumer = await client.createConsumer(consumerName);
        firstConsumer.subscribe(producer.name, eventName, function () {}, {durable: true});
        await delay(300);

        firstConsumer.disconnect();
        await delay(300);
        producer.produce(eventName, 'auto ack message');
        await delay(300);

        secondConsumer = await client.createConsumer(consumerName);
        const received = await new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('auto ack replay timeout')), 4000);
            secondConsumer.subscribe(producer.name, eventName, (data, from, ack, raw) => {
                clearTimeout(timer);
                resolve({data, raw});
            }, {durable: true, ack: true});
        });
        assert.strictEqual(received.data, 'auto ack message');
        assert.ok(received.raw.msgId, 'explicit ACK delivery should carry msgId');
        await delay(200);

        secondConsumer.disconnect();
        await delay(300);
        thirdConsumer = await client.createConsumer(consumerName);
        let repeated = false;
        thirdConsumer.subscribe(producer.name, eventName, () => {
            repeated = true;
        }, {durable: true, ack: true});
        await waitForNoMessage(700);
        assert.strictEqual(repeated, false, 'auto-acked message should not replay again');
    } finally {
        if (thirdConsumer) thirdConsumer.disconnect();
        if (secondConsumer) secondConsumer.disconnect();
        if (firstConsumer) firstConsumer.disconnect();
        if (producer) producer.disconnect();
        await server.close();
    }
});

test('manual ACK retries after timeout and then clears message', async () => {
    const server = await startServer({storage: 'memory'});
    const client = clientFor(server.port);
    const producerName = 'phase3-retry-producer';
    const consumerName = 'phase3-retry-consumer';
    const eventName = 'phase3-retry-event';

    let producer;
    let firstConsumer;
    let secondConsumer;
    try {
        producer = await client.createProducer(producerName);
        firstConsumer = await client.createConsumer(consumerName);
        firstConsumer.subscribe(producer.name, eventName, function () {}, {durable: true});
        await delay(300);

        firstConsumer.disconnect();
        await delay(300);
        producer.produce(eventName, 'retry then ack');
        await delay(300);

        secondConsumer = await client.createConsumer(consumerName);
        let deliveries = 0;
        await new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('manual ack retry timeout')), 5000);
            secondConsumer.subscribe(producer.name, eventName, (data, from, ack, raw) => {
                deliveries++;
                assert.strictEqual(data, 'retry then ack');
                assert.ok(raw.msgId, 'replayed message should carry msgId');
                if (deliveries === 2) {
                    ack();
                    clearTimeout(timer);
                    resolve();
                }
            }, {
                durable: true,
                manual_ack: true,
                ack_timeout: '100ms',
                retry: {max_attempts: 3, delay: '50ms'}
            });
        });
        assert.strictEqual(deliveries, 2);
    } finally {
        if (secondConsumer) secondConsumer.disconnect();
        if (firstConsumer) firstConsumer.disconnect();
        if (producer) producer.disconnect();
        await server.close();
    }
});

test('unacked message moves to DLQ after max attempts', async () => {
    const server = await startServer({storage: 'memory'});
    const client = clientFor(server.port);
    const producerName = 'phase3-dlq-producer';
    const consumerName = 'phase3-dlq-consumer';
    const eventName = 'phase3-dlq-event';

    let producer;
    let firstConsumer;
    let secondConsumer;
    try {
        producer = await client.createProducer(producerName);
        firstConsumer = await client.createConsumer(consumerName);
        firstConsumer.subscribe(producer.name, eventName, function () {}, {durable: true});
        await delay(300);

        firstConsumer.disconnect();
        await delay(300);
        producer.produce(eventName, 'dead letter me');
        await delay(300);

        secondConsumer = await client.createConsumer(consumerName);
        let deliveries = 0;
        secondConsumer.subscribe(producer.name, eventName, () => {
            deliveries++;
        }, {
            durable: true,
            manual_ack: true,
            ack_timeout: '80ms',
            retry: {max_attempts: 2, delay: '40ms'}
        });

        const dlq = await waitUntil(async () => {
            const entries = await server.server.store.listDlq('default');
            return entries.length ? entries : null;
        }, 5000);

        assert.strictEqual(deliveries, 2);
        assert.strictEqual(dlq.length, 1);
        assert.strictEqual(dlq[0].message.message, 'dead letter me');
        assert.ok(/ack timeout/.test(dlq[0].reason));
    } finally {
        if (secondConsumer) secondConsumer.disconnect();
        if (firstConsumer) firstConsumer.disconnect();
        if (producer) producer.disconnect();
        await server.close();
    }
});

test('memory store exposes dead-letter queue entries', async () => {
    const store = Storage.createStore({storage: 'memory'});
    const id = await store.enqueue('realm-dlq', 'event-dlq', {
        consumer_id: 'consumer-dlq',
        payload: {message: 'store dlq'},
        producer: 'producer-dlq'
    });

    await store.deadLetter(id, 'test failure');
    const dlq = await store.listDlq('realm-dlq');
    assert.strictEqual(dlq.length, 1);
    assert.strictEqual(dlq[0].id, id);
    assert.deepStrictEqual(dlq[0].message, {message: 'store dlq'});
    assert.strictEqual(dlq[0].reason, 'test failure');

    await store.discardDlq(id);
    const afterDiscard = await store.listDlq('realm-dlq');
    assert.strictEqual(afterDiscard.length, 0);
});

run();
