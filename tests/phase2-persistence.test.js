/**
 * Phase 2: durable queue behavior.
 *
 * Usage: node tests/phase2-persistence.test.js
 */

'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Factory = require('../lib/factory');
const Storage = require('../lib/storage');
const { test, run } = require('./runner');
const { startServer, delay } = require('./helpers');

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

function FakeRedisClient() {
    this.values = {};
    this.expirations = {};
    this.sortedSets = {};
}

FakeRedisClient.prototype._expired = function (key) {
    return this.expirations[key] && this.expirations[key] <= Date.now();
};

FakeRedisClient.prototype.sendCommand = function (args) {
    const cmd = String(args[0]).toUpperCase();
    const key = args[1];

    if (cmd === 'SET') {
        this.values[key] = args[2];
        return Promise.resolve('OK');
    }
    if (cmd === 'PEXPIREAT') {
        this.expirations[key] = Number(args[2]);
        return Promise.resolve(1);
    }
    if (cmd === 'ZADD') {
        this.sortedSets[key] = this.sortedSets[key] || {};
        this.sortedSets[key][args[3]] = Number(args[2]);
        return Promise.resolve(1);
    }
    if (cmd === 'ZRANGE') {
        const set = this.sortedSets[key] || {};
        return Promise.resolve(Object.keys(set).sort((a, b) => set[a] - set[b]));
    }
    if (cmd === 'GET') {
        if (this._expired(key)) {
            delete this.values[key];
            return Promise.resolve(null);
        }
        return Promise.resolve(this.values[key] || null);
    }
    if (cmd === 'ZREM') {
        if (this.sortedSets[key])
            delete this.sortedSets[key][args[2]];
        return Promise.resolve(1);
    }
    if (cmd === 'DEL') {
        delete this.values[key];
        delete this.expirations[key];
        return Promise.resolve(1);
    }
    return Promise.reject(new Error('Unsupported fake redis command: ' + cmd));
};

test('redis store uses redis commands for queue, dequeue, ttl, and ack', async () => {
    const client = new FakeRedisClient();
    const store = Storage.createStore({
        storage: 'redis',
        storage_options: {
            client,
            default_ttl: 60,
            prefix: 'test-queue'
        }
    });

    const msgId = await store.enqueue('realm-r', 'event-r', {
        consumer_id: 'consumer-r',
        payload: {message: 'redis queued'},
        producer: 'producer-r'
    });

    const messages = await store.dequeue('realm-r', 'event-r', 'consumer-r');
    assert.strictEqual(messages.length, 1);
    assert.deepStrictEqual(messages[0].message, {message: 'redis queued'});

    await store.ack(msgId);
    const afterAck = await store.dequeue('realm-r', 'event-r', 'consumer-r');
    assert.strictEqual(afterAck.length, 0);

    await store.enqueue('realm-r', 'event-r', {
        consumer_id: 'consumer-r',
        payload: 'expired',
        ttl: 0
    });
    const afterExpiry = await store.dequeue('realm-r', 'event-r', 'consumer-r');
    assert.strictEqual(afterExpiry.length, 0);
});

test('sqlite store persists queued messages across store instances', async () => {
    try {
        require('node:sqlite');
    } catch (err) {
        console.log('  -  sqlite store skipped: node:sqlite unavailable');
        return;
    }

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tyo-mq-sqlite-'));
    const filename = path.join(tmpDir, 'queue.sqlite');
    let first;
    let second;

    try {
        first = Storage.createStore({storage: 'sqlite', storage_options: {filename, default_ttl: 60}});
        const msgId = await first.enqueue('realm-a', 'event-a', {
            consumer_id: 'consumer-a',
            payload: {message: 'persisted'},
            producer: 'producer-a'
        });
        first.close();
        first = null;

        second = Storage.createStore({storage: 'sqlite', storage_options: {filename, default_ttl: 60}});
        const messages = await second.dequeue('realm-a', 'event-a', 'consumer-a');
        assert.strictEqual(messages.length, 1);
        assert.deepStrictEqual(messages[0].message, {message: 'persisted'});

        await second.ack(msgId);
        const afterAck = await second.dequeue('realm-a', 'event-a', 'consumer-a');
        assert.strictEqual(afterAck.length, 0);
    } finally {
        if (first) first.close();
        if (second) second.close();
        fs.rmSync(tmpDir, {recursive: true, force: true});
    }
});

test('durable subscription replays message published while consumer is offline', async () => {
    const server = await startServer({storage: 'memory'});
    const client = clientFor(server.port);
    const producerName = 'phase2-producer-durable';
    const consumerName = 'phase2-consumer-durable';
    const eventName = 'phase2-durable-event';

    let producer;
    let firstConsumer;
    let secondConsumer;
    try {
        producer = await client.createProducer(producerName);
        firstConsumer = await client.createConsumer(consumerName);
        firstConsumer.subscribe(producer.name, eventName, function () {}, {durable: true});
        await delay(300);

        firstConsumer.disconnect();
        await delay(500);

        producer.produce(eventName, 'offline durable message');
        await delay(300);

        secondConsumer = await client.createConsumer(consumerName);
        const received = await new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('timeout waiting for durable replay')), 4000);
            secondConsumer.subscribe(producer.name, eventName, (data) => {
                clearTimeout(timer);
                resolve(data);
            }, {durable: true});
        });

        assert.strictEqual(received, 'offline durable message');
    } finally {
        if (secondConsumer) secondConsumer.disconnect();
        if (firstConsumer) firstConsumer.disconnect();
        if (producer) producer.disconnect();
        await server.close();
    }
});

test('event-only durable subscription replays messages from any producer', async () => {
    const server = await startServer({storage: 'memory'});
    const client = clientFor(server.port);
    const producerName = 'phase2-producer-any';
    const consumerName = 'phase2-consumer-any';
    const eventName = 'phase2-any-event';

    let producer;
    let firstConsumer;
    let secondConsumer;
    try {
        producer = await client.createProducer(producerName);
        firstConsumer = await client.createConsumer(consumerName);
        firstConsumer.subscribe(eventName, function () {}, {durable: true});
        await delay(300);

        firstConsumer.disconnect();
        await delay(500);

        producer.produce(eventName, 'event-only durable message');
        await delay(300);

        secondConsumer = await client.createConsumer(consumerName);
        const received = await new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('timeout waiting for event-only durable replay')), 4000);
            secondConsumer.subscribe(eventName, (data) => {
                clearTimeout(timer);
                resolve(data);
            }, {durable: true});
        });

        assert.strictEqual(received, 'event-only durable message');
    } finally {
        if (secondConsumer) secondConsumer.disconnect();
        if (firstConsumer) firstConsumer.disconnect();
        if (producer) producer.disconnect();
        await server.close();
    }
});

test('non-durable subscription does not replay offline messages', async () => {
    const server = await startServer({storage: 'memory'});
    const client = clientFor(server.port);
    const producerName = 'phase2-producer-volatile';
    const consumerName = 'phase2-consumer-volatile';
    const eventName = 'phase2-volatile-event';

    let producer;
    let firstConsumer;
    let secondConsumer;
    let received = false;
    try {
        producer = await client.createProducer(producerName);
        firstConsumer = await client.createConsumer(consumerName);
        firstConsumer.subscribe(producer.name, eventName, function () {});
        await delay(300);

        firstConsumer.disconnect();
        await delay(500);

        producer.produce(eventName, 'lost volatile message');
        await delay(300);

        secondConsumer = await client.createConsumer(consumerName);
        secondConsumer.subscribe(producer.name, eventName, () => {
            received = true;
        });
        await waitForNoMessage(1000);

        assert.strictEqual(received, false);
    } finally {
        if (secondConsumer) secondConsumer.disconnect();
        if (firstConsumer) firstConsumer.disconnect();
        if (producer) producer.disconnect();
        await server.close();
    }
});

test('producer guaranteed message replays for offline non-durable subscription', async () => {
    const server = await startServer({storage: 'memory'});
    const client = clientFor(server.port);
    const producerName = 'phase2-producer-guaranteed';
    const consumerName = 'phase2-consumer-guaranteed';
    const eventName = 'phase2-guaranteed-event';

    let producer;
    let firstConsumer;
    let secondConsumer;
    try {
        producer = await client.createProducer(producerName);
        firstConsumer = await client.createConsumer(consumerName);
        firstConsumer.subscribe(producer.name, eventName, function () {});
        await delay(300);

        firstConsumer.disconnect();
        await delay(500);

        producer.produce(eventName, 'guaranteed offline message', {guaranteed: true});
        await delay(300);

        secondConsumer = await client.createConsumer(consumerName);
        const received = await new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('timeout waiting for guaranteed replay')), 4000);
            secondConsumer.subscribe(producer.name, eventName, (data) => {
                clearTimeout(timer);
                resolve(data);
            });
        });

        assert.strictEqual(received, 'guaranteed offline message');
    } finally {
        if (secondConsumer) secondConsumer.disconnect();
        if (firstConsumer) firstConsumer.disconnect();
        if (producer) producer.disconnect();
        await server.close();
    }
});

test('durable messages expire according to producer ttl', async () => {
    const server = await startServer({storage: 'memory', storage_options: {default_ttl: 60}});
    const client = clientFor(server.port);
    const producerName = 'phase2-producer-ttl';
    const consumerName = 'phase2-consumer-ttl';
    const eventName = 'phase2-ttl-event';

    let producer;
    let firstConsumer;
    let secondConsumer;
    let received = false;
    try {
        producer = await client.createProducer(producerName);
        firstConsumer = await client.createConsumer(consumerName);
        firstConsumer.subscribe(producer.name, eventName, function () {}, {durable: true});
        await delay(300);

        firstConsumer.disconnect();
        await delay(500);

        producer.produce(eventName, 'expired durable message', {ttl: 1});
        await delay(1300);

        secondConsumer = await client.createConsumer(consumerName);
        secondConsumer.subscribe(producer.name, eventName, () => {
            received = true;
        }, {durable: true});
        await waitForNoMessage(1000);

        assert.strictEqual(received, false);
    } finally {
        if (secondConsumer) secondConsumer.disconnect();
        if (firstConsumer) firstConsumer.disconnect();
        if (producer) producer.disconnect();
        await server.close();
    }
});

test('durable messages expire according to producer default ttl', async () => {
    const server = await startServer({storage: 'memory', storage_options: {default_ttl: 60}});
    const client = clientFor(server.port);
    const producerName = 'phase2-producer-default-ttl';
    const consumerName = 'phase2-consumer-default-ttl';
    const eventName = 'phase2-default-ttl-event';

    let producer;
    let firstConsumer;
    let secondConsumer;
    let received = false;
    try {
        producer = await client.createProducer(producerName, {default_ttl: 1});
        firstConsumer = await client.createConsumer(consumerName);
        firstConsumer.subscribe(producer.name, eventName, function () {}, {durable: true});
        await delay(300);

        firstConsumer.disconnect();
        await delay(500);

        producer.produce(eventName, 'expired producer default ttl message');
        await delay(1300);

        secondConsumer = await client.createConsumer(consumerName);
        secondConsumer.subscribe(producer.name, eventName, () => {
            received = true;
        }, {durable: true});
        await waitForNoMessage(1000);

        assert.strictEqual(received, false);
    } finally {
        if (secondConsumer) secondConsumer.disconnect();
        if (firstConsumer) firstConsumer.disconnect();
        if (producer) producer.disconnect();
        await server.close();
    }
});

run();
