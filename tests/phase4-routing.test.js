/**
 * Phase 4: routing — topic wildcards, consumer groups, broadcast.
 *
 * All Phase 4 features are opt-in:
 *  - topic mode via subscribe(pattern, handler, { mode: 'topic' })
 *  - consumer groups via subscribe(..., { group: 'name' })
 *  - broadcast via produce(event, data, { broadcast: 'realm' | 'group' })
 * Legacy producer/event routing is unchanged when none are used.
 *
 * Usage: node tests/phase4-routing.test.js
 */

'use strict';

const assert = require('assert');
const { test, run } = require('./runner');
const { startServer, makeFactory, delay } = require('./helpers');

test('topic subscription with + wildcard matches a single level', async () => {
    const server = await startServer({});
    const client = makeFactory(server.port);

    let producer;
    let consumer;
    try {
        producer = await client.createProducer('phase4-fleet');
        consumer = await client.createConsumer('phase4-topic-consumer');

        const received = [];
        consumer.subscribe('org/acme/machine/+/cmd', function (message, from, ack, obj) {
            received.push({ message: message, topic: obj.event });
        }, { mode: 'topic' });
        await delay(300);

        producer.produce('org/acme/machine/m-01/cmd', 'restart');
        producer.produce('org/acme/machine/m-01/status', 'ignored-wrong-leaf');
        producer.produce('org/acme/machine/a/b/cmd', 'ignored-too-deep');
        producer.produce('org/acme/machine/m-02/cmd', 'reboot');
        await delay(800);

        assert.strictEqual(received.length, 2, JSON.stringify(received));
        assert.strictEqual(received[0].message, 'restart');
        assert.strictEqual(received[0].topic, 'org/acme/machine/m-01/cmd');
        assert.strictEqual(received[1].message, 'reboot');
        assert.strictEqual(received[1].topic, 'org/acme/machine/m-02/cmd');
    } finally {
        if (producer) producer.disconnect();
        if (consumer) consumer.disconnect();
        await server.close();
    }
});

test('topic subscription with # wildcard matches multiple levels', async () => {
    const server = await startServer({});
    const client = makeFactory(server.port);

    let producer;
    let consumer;
    try {
        producer = await client.createProducer('phase4-fleet-hash');
        consumer = await client.createConsumer('phase4-hash-consumer');

        const received = [];
        consumer.subscribe('org/acme/#', function (message, from, ack, obj) {
            received.push(obj.event);
        }, { mode: 'topic' });
        await delay(300);

        producer.produce('org/acme/alert', 'one-level');
        producer.produce('org/acme/machine/m-01/cmd', 'deep');
        producer.produce('org/beta/alert', 'other-org-ignored');
        await delay(800);

        assert.deepStrictEqual(received, ['org/acme/alert', 'org/acme/machine/m-01/cmd']);
    } finally {
        if (producer) producer.disconnect();
        if (consumer) consumer.disconnect();
        await server.close();
    }
});

test('legacy producer/event subscriptions coexist with topic subscriptions', async () => {
    const server = await startServer({});
    const client = makeFactory(server.port);

    let producer;
    let legacyConsumer;
    let topicConsumer;
    try {
        producer = await client.createProducer('phase4-coexist-producer');
        legacyConsumer = await client.createConsumer('phase4-legacy-consumer');
        topicConsumer = await client.createConsumer('phase4-topic-coexist-consumer');

        const legacyReceived = [];
        legacyConsumer.subscribe(producer.name, 'org/acme/m1/cmd', function (message) {
            legacyReceived.push(message);
        });

        const topicReceived = [];
        topicConsumer.subscribe('org/acme/+/cmd', function (message) {
            topicReceived.push(message);
        }, { mode: 'topic' });
        await delay(300);

        producer.produce('org/acme/m1/cmd', 'both-should-get-this');
        await delay(800);

        assert.deepStrictEqual(legacyReceived, ['both-should-get-this']);
        assert.deepStrictEqual(topicReceived, ['both-should-get-this']);
    } finally {
        if (producer) producer.disconnect();
        if (legacyConsumer) legacyConsumer.disconnect();
        if (topicConsumer) topicConsumer.disconnect();
        await server.close();
    }
});

test('durable topic subscription replays messages produced while offline', async () => {
    const server = await startServer({ storage: 'memory' });
    const client = makeFactory(server.port);

    let producer;
    let firstConsumer;
    let secondConsumer;
    try {
        producer = await client.createProducer('phase4-durable-producer');
        firstConsumer = await client.createConsumer('phase4-durable-topic-consumer');
        firstConsumer.subscribe('org/acme/+/cmd', function () {}, {
            mode: 'topic',
            durable: true
        });
        await delay(300);

        firstConsumer.disconnect();
        await delay(500);

        producer.produce('org/acme/m-09/cmd', 'offline topic message');
        await delay(300);

        secondConsumer = await client.createConsumer('phase4-durable-topic-consumer');
        const received = await new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('timeout waiting for durable topic replay')), 4000);
            secondConsumer.subscribe('org/acme/+/cmd', (data) => {
                clearTimeout(timer);
                resolve(data);
            }, { mode: 'topic', durable: true });
        });

        assert.strictEqual(received, 'offline topic message');
    } finally {
        if (secondConsumer) secondConsumer.disconnect();
        if (firstConsumer) firstConsumer.disconnect();
        if (producer) producer.disconnect();
        await server.close();
    }
});

test('consumer group delivers each message to exactly one member', async () => {
    const server = await startServer({});
    const client = makeFactory(server.port);

    let producer;
    let workerA;
    let workerB;
    let observer;
    try {
        producer = await client.createProducer('phase4-group-producer');
        workerA = await client.createConsumer('phase4-worker-a');
        workerB = await client.createConsumer('phase4-worker-b');
        observer = await client.createConsumer('phase4-observer');

        const receivedA = [];
        const receivedB = [];
        const receivedObserver = [];

        workerA.subscribe(producer.name, 'group-task', function (message) {
            receivedA.push(message);
        }, { group: 'phase4-workers' });
        workerB.subscribe(producer.name, 'group-task', function (message) {
            receivedB.push(message);
        }, { group: 'phase4-workers' });
        observer.subscribe(producer.name, 'group-task', function (message) {
            receivedObserver.push(message);
        });
        await delay(400);

        for (let i = 1; i <= 4; i++)
            producer.produce('group-task', 'task-' + i);
        await delay(1000);

        const total = receivedA.length + receivedB.length;
        assert.strictEqual(total, 4, 'group total: A=' + JSON.stringify(receivedA) + ' B=' + JSON.stringify(receivedB));
        assert.ok(receivedA.length > 0, 'worker A should receive at least one message');
        assert.ok(receivedB.length > 0, 'worker B should receive at least one message');

        const all = receivedA.concat(receivedB).sort();
        assert.deepStrictEqual(all, ['task-1', 'task-2', 'task-3', 'task-4'], 'no duplicates within the group');

        assert.deepStrictEqual(receivedObserver, ['task-1', 'task-2', 'task-3', 'task-4'],
            'ungrouped subscriber still receives every message');
    } finally {
        if (producer) producer.disconnect();
        if (workerA) workerA.disconnect();
        if (workerB) workerB.disconnect();
        if (observer) observer.disconnect();
        await server.close();
    }
});

test('produce with broadcast: realm reaches realm members without a matching subscription', async () => {
    const server = await startServer({
        auth: {
            enabled: true,
            tokens: [
                { token: 'phase4-acme-both', realm: 'phase4-acme', role: 'both' },
                { token: 'phase4-beta-both', realm: 'phase4-beta', role: 'both' }
            ]
        }
    });
    const ioClient = require('socket.io-client');
    const { waitFor } = require('./helpers');

    // Raw realm member: authenticated and registered as a consumer, but with
    // NO subscription — only a realm broadcast can reach it.
    async function rawRealmListener(token, name) {
        const socket = ioClient(`http://127.0.0.1:${server.port}`, { transports: ['websocket'] });
        await waitFor(socket, 'connect');
        socket.emit('AUTHENTICATION', { token });
        await waitFor(socket, 'AUTH_OK');
        socket.emit('CONSUMER', { name });
        const received = [];
        socket.on('CONSUME-realm-news', function (obj) {
            received.push(obj && obj.message);
        });
        return { socket, received };
    }

    const acmeClient = makeFactory(server.port);
    acmeClient.auth = { token: 'phase4-acme-both' };

    let producer;
    let subscribedConsumer;
    let acmeRaw;
    let betaRaw;
    try {
        producer = await acmeClient.createProducer('phase4-broadcast-producer');
        subscribedConsumer = await acmeClient.createConsumer('phase4-broadcast-consumer');
        acmeRaw = await rawRealmListener('phase4-acme-both', 'phase4-raw-acme');
        betaRaw = await rawRealmListener('phase4-beta-both', 'phase4-raw-beta');

        const receivedSubscribed = [];
        subscribedConsumer.subscribe(producer.name, 'realm-news', function (message) {
            receivedSubscribed.push(message);
        });
        await delay(400);

        // A normal produce must NOT reach unsubscribed realm members.
        producer.produce('realm-news', 'normal-message');
        await delay(600);
        assert.deepStrictEqual(acmeRaw.received, [], 'normal produce must not reach unsubscribed members');

        producer.produce('realm-news', 'hello-realm', { broadcast: 'realm' });
        await delay(800);

        assert.deepStrictEqual(acmeRaw.received, ['hello-realm'], 'broadcast reaches unsubscribed realm members');
        assert.deepStrictEqual(betaRaw.received, [], 'broadcast must not cross realms');
        assert.deepStrictEqual(receivedSubscribed, ['normal-message', 'hello-realm'],
            'subscribed consumers receive both normal and broadcast messages');
    } finally {
        if (producer) producer.disconnect();
        if (subscribedConsumer) subscribedConsumer.disconnect();
        if (acmeRaw) acmeRaw.socket.disconnect();
        if (betaRaw) betaRaw.socket.disconnect();
        await server.close();
    }
});

test('produce with broadcast: group reaches every group member only', async () => {
    const server = await startServer({});
    const client = makeFactory(server.port);

    let producer;
    let memberA;
    let memberB;
    let outsider;
    try {
        producer = await client.createProducer('phase4-gb-producer');
        memberA = await client.createConsumer('phase4-gb-member-a');
        memberB = await client.createConsumer('phase4-gb-member-b');
        outsider = await client.createConsumer('phase4-gb-outsider');

        const receivedA = [];
        const receivedB = [];
        const receivedOutsider = [];

        memberA.subscribe(producer.name, 'gb-task', function (message) {
            receivedA.push(message);
        }, { group: 'phase4-gb-workers' });
        memberB.subscribe(producer.name, 'gb-task', function (message) {
            receivedB.push(message);
        }, { group: 'phase4-gb-workers' });
        outsider.subscribe(producer.name, 'gb-task', function (message) {
            receivedOutsider.push(message);
        });
        await delay(400);

        producer.produce('gb-task', 'all-hands', { broadcast: 'group', group: 'phase4-gb-workers' });
        await delay(800);

        assert.deepStrictEqual(receivedA, ['all-hands'], 'group member A receives the broadcast');
        assert.deepStrictEqual(receivedB, ['all-hands'], 'group member B receives the broadcast');
        assert.deepStrictEqual(receivedOutsider, [], 'non-members do not receive a group broadcast');
    } finally {
        if (producer) producer.disconnect();
        if (memberA) memberA.disconnect();
        if (memberB) memberB.disconnect();
        if (outsider) outsider.disconnect();
        await server.close();
    }
});

run();
