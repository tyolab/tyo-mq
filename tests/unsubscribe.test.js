/**
 * UNSUBSCRIBE — the object form that mirrors SUBSCRIBE.
 *
 * Before 1.5.0 the handler keyed its delete by socket.id while SUBSCRIBE stored
 * by consumer NAME, so for every named consumer UNSUBSCRIBE was a silent no-op
 * (nothing removed, no ack, no log) and every ended subscription leaked toward
 * the realm cap. These tests pin the fixed behaviour end-to-end over raw
 * socket.io: delivery stops, the entry does not come back on reconnect, a
 * sibling event from the same producer survives, the limiter slot is freed,
 * and the ack says what happened.
 *
 * Usage: node tests/unsubscribe.test.js
 */

'use strict';

const assert = require('assert');
const { test, run } = require('./runner');
const { startServer, delay, waitFor } = require('./helpers');
const ioClient = require('socket.io-client');

function connect(port) {
    return new Promise((resolve, reject) => {
        const socket = ioClient(`http://127.0.0.1:${port}`, { transports: ['websocket'], reconnection: false });
        socket.captured = [];
        socket.onAny((event, data) => socket.captured.push({ event, data }));
        const timer = setTimeout(() => { socket.disconnect(); reject(new Error('connect timeout')); }, 5000);
        socket.on('connect', () => { clearTimeout(timer); resolve(socket); });
        socket.on('connect_error', err => { clearTimeout(timer); reject(err); });
    });
}

function emitAck(socket, event, payload) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(event + ' ack timeout')), 3000);
        socket.emit(event, payload, res => { clearTimeout(timer); resolve(res); });
    });
}

function countReceived(socket, consumeEvent) {
    const box = { n: 0, last: null };
    socket.on(consumeEvent, msg => { box.n++; box.last = msg; });
    return box;
}

test('object-form UNSUBSCRIBE stops delivery and acks ok; a second call says not_subscribed', async () => {
    const srv = await startServer();
    const producer = await connect(srv.port);
    const consumer = await connect(srv.port);
    try {
        producer.emit('PRODUCER', { name: 'p1' });
        consumer.emit('CONSUMER', { name: 'c1' });
        consumer.emit('SUBSCRIBE', { event: 'tick', producer: 'p1', consumer: 'c1' });
        await delay(200);

        const got = countReceived(consumer, 'CONSUME-p1-tick');
        producer.emit('PRODUCE', { event: 'tick', message: { i: 1 }, from: 'p1' });
        await delay(200);
        assert.strictEqual(got.n, 1, 'subscribed: the first message arrives');

        const ack = await emitAck(consumer, 'UNSUBSCRIBE', { event: 'tick', producer: 'p1', consumer: 'c1' });
        assert.strictEqual(ack.ok, true);
        assert.strictEqual(ack.removed, 1);
        assert.strictEqual(ack.event, 'p1-tick');

        producer.emit('PRODUCE', { event: 'tick', message: { i: 2 }, from: 'p1' });
        await delay(300);
        assert.strictEqual(got.n, 1, 'unsubscribed: nothing more arrives');

        const again = await emitAck(consumer, 'UNSUBSCRIBE', { event: 'tick', producer: 'p1', consumer: 'c1' });
        assert.strictEqual(again.ok, false);
        assert.strictEqual(again.reason, 'not_subscribed');
    } finally {
        producer.disconnect(); consumer.disconnect();
        await srv.close();
    }
});

test('an unsubscribed topic does NOT come back when the named consumer reconnects (and a subscribed one does)', async () => {
    const srv = await startServer();
    const producer = await connect(srv.port);
    let consumer = await connect(srv.port);
    try {
        producer.emit('PRODUCER', { name: 'p2' });
        consumer.emit('CONSUMER', { name: 'c2' });
        consumer.emit('SUBSCRIBE', { event: 'keep', producer: 'p2', consumer: 'c2' });
        consumer.emit('SUBSCRIBE', { event: 'drop', producer: 'p2', consumer: 'c2' });
        await delay(200);
        const ack = await emitAck(consumer, 'UNSUBSCRIBE', { event: 'drop', producer: 'p2', consumer: 'c2' });
        assert.strictEqual(ack.ok, true);

        // Reconnect under the same name WITHOUT re-subscribing: the broker's
        // reconnect path restores whatever it still holds for 'c2'.
        consumer.disconnect();
        await delay(100);
        consumer = await connect(srv.port);
        consumer.emit('CONSUMER', { name: 'c2' });
        await delay(200);

        const kept = countReceived(consumer, 'CONSUME-p2-keep');
        const dropped = countReceived(consumer, 'CONSUME-p2-drop');
        producer.emit('PRODUCE', { event: 'keep', message: { k: 1 }, from: 'p2' });
        producer.emit('PRODUCE', { event: 'drop', message: { d: 1 }, from: 'p2' });
        await delay(300);
        assert.strictEqual(kept.n, 1, 'the surviving subscription is restored on reconnect (control)');
        assert.strictEqual(dropped.n, 0, 'the unsubscribed one stays gone');
    } finally {
        producer.disconnect(); consumer.disconnect();
        await srv.close();
    }
});

test('unsubscribing one event keeps a sibling event from the same producer routed', async () => {
    const srv = await startServer();
    const producer = await connect(srv.port);
    const consumer = await connect(srv.port);
    try {
        producer.emit('PRODUCER', { name: 'p3' });
        consumer.emit('CONSUMER', { name: 'c3' });
        consumer.emit('SUBSCRIBE', { event: 'a', producer: 'p3', consumer: 'c3' });
        consumer.emit('SUBSCRIBE', { event: 'b', producer: 'p3', consumer: 'c3' });
        await delay(200);

        const a = countReceived(consumer, 'CONSUME-p3-a');
        const b = countReceived(consumer, 'CONSUME-p3-b');
        const ack = await emitAck(consumer, 'UNSUBSCRIBE', { event: 'a', producer: 'p3', consumer: 'c3' });
        assert.strictEqual(ack.ok, true);

        producer.emit('PRODUCE', { event: 'a', message: {}, from: 'p3' });
        producer.emit('PRODUCE', { event: 'b', message: {}, from: 'p3' });
        await delay(300);
        assert.strictEqual(a.n, 0, "'a' is gone");
        assert.strictEqual(b.n, 1, "'b' from the same producer still routes — the consumer→producer link survived");
    } finally {
        producer.disconnect(); consumer.disconnect();
        await srv.close();
    }
});

test("Hilia's shape: two events from the wildcard producer '*'; unsubscribing one leaves the other delivering AND restorable across a reconnect", async () => {
    // e2ee.inbox and hilia-link-<id>-up are both subscribed from TYO-MQ-ALL.
    // A naive UNSUBSCRIBE that dropped '*' from the consumer's subscribeTos
    // on releasing the link topic would silently kill inbox delivery after
    // the next re-identify — worse than the leak being fixed.
    const srv = await startServer();
    const producer = await connect(srv.port);
    let consumer = await connect(srv.port);
    try {
        producer.emit('PRODUCER', { name: 'chat-peer' });
        consumer.emit('CONSUMER', { name: 'chat-self' });
        consumer.emit('SUBSCRIBE', { event: 'e2ee.inbox', producer: 'TYO-MQ-ALL', consumer: 'chat-self' });
        consumer.emit('SUBSCRIBE', { event: 'hilia-link-abc-up', producer: 'TYO-MQ-ALL', consumer: 'chat-self', mode: 'topic' });
        await delay(200);

        const inboxEvent = 'CONSUME-tyo-mq-all-e2ee.inbox';
        const linkEvent = 'CONSUME-tyo-mq-all-hilia-link-abc-up';
        let inbox = countReceived(consumer, inboxEvent);
        let link = countReceived(consumer, linkEvent);
        producer.emit('PRODUCE', { event: 'e2ee.inbox', message: { n: 1 }, from: 'chat-peer' });
        producer.emit('PRODUCE', { event: 'hilia-link-abc-up', message: { n: 1 }, from: 'chat-peer' });
        await delay(300);
        assert.strictEqual(inbox.n, 1); assert.strictEqual(link.n, 1);

        // Release the link topic (the extra fields the Java client sends ride along harmlessly).
        const ack = await emitAck(consumer, 'UNSUBSCRIBE', { event: 'hilia-link-abc-up', producer: 'TYO-MQ-ALL', consumer: 'chat-self', consumer_id: 'chat-self', mode: 'topic' });
        assert.strictEqual(ack.ok, true);

        producer.emit('PRODUCE', { event: 'e2ee.inbox', message: { n: 2 }, from: 'chat-peer' });
        producer.emit('PRODUCE', { event: 'hilia-link-abc-up', message: { n: 2 }, from: 'chat-peer' });
        await delay(300);
        assert.strictEqual(inbox.n, 2, 'inbox still delivers on the live socket');
        assert.strictEqual(link.n, 1, 'link topic is released');

        // Re-identify on a fresh socket WITHOUT re-subscribing: the broker's
        // restore must still carry the wildcard link for the inbox.
        consumer.disconnect();
        await delay(100);
        consumer = await connect(srv.port);
        consumer.emit('CONSUMER', { name: 'chat-self' });
        await delay(200);
        inbox = countReceived(consumer, inboxEvent);
        link = countReceived(consumer, linkEvent);
        producer.emit('PRODUCE', { event: 'e2ee.inbox', message: { n: 3 }, from: 'chat-peer' });
        producer.emit('PRODUCE', { event: 'hilia-link-abc-up', message: { n: 3 }, from: 'chat-peer' });
        await delay(300);
        assert.strictEqual(inbox.n, 1, 'inbox is restored after reconnect — the wildcard link survived the unsubscribe');
        assert.strictEqual(link.n, 0, 'the released topic stays released after reconnect');
    } finally {
        producer.disconnect(); consumer.disconnect();
        await srv.close();
    }
});

test('UNSUBSCRIBE frees the limiter slot (max_subscriptions_per_socket)', async () => {
    const srv = await startServer({ limits: { max_subscriptions_per_socket: 1 } });
    const producer = await connect(srv.port);
    const consumer = await connect(srv.port);
    try {
        producer.emit('PRODUCER', { name: 'p4' });
        consumer.emit('CONSUMER', { name: 'c4' });
        consumer.emit('SUBSCRIBE', { event: 'one', producer: 'p4', consumer: 'c4' });
        await delay(200);

        const limited = waitFor(consumer, 'RATE_LIMITED');
        consumer.emit('SUBSCRIBE', { event: 'two', producer: 'p4', consumer: 'c4' });
        const notice = await limited;
        assert.strictEqual(notice.reason, 'max_subscriptions_per_socket');

        const ack = await emitAck(consumer, 'UNSUBSCRIBE', { event: 'one', producer: 'p4', consumer: 'c4' });
        assert.strictEqual(ack.ok, true);

        consumer.emit('SUBSCRIBE', { event: 'two', producer: 'p4', consumer: 'c4' });
        await delay(200);
        const two = countReceived(consumer, 'CONSUME-p4-two');
        producer.emit('PRODUCE', { event: 'two', message: {}, from: 'p4' });
        await delay(300);
        assert.strictEqual(two.n, 1, 'the freed slot admits a new subscription');
    } finally {
        producer.disconnect(); consumer.disconnect();
        await srv.close();
    }
});

test('malformed and legacy string forms ack honestly and never throw', async () => {
    const srv = await startServer();
    const consumer = await connect(srv.port);
    try {
        consumer.emit('CONSUMER', { name: 'c5' });
        await delay(100);
        const bad = await emitAck(consumer, 'UNSUBSCRIBE', { producer: 'p5' });
        assert.strictEqual(bad.ok, false);
        assert.strictEqual(bad.reason, 'bad_request');

        // Legacy: a raw eventStr keyed by socket id — only ever matched
        // unnamed consumers, so for a named one it reports not_subscribed.
        const legacy = await emitAck(consumer, 'UNSUBSCRIBE', 'p5-tick');
        assert.strictEqual(legacy.ok, false);
        assert.strictEqual(legacy.reason, 'not_subscribed');

        // JSON-encoded object form is accepted like SUBSCRIBE's.
        consumer.emit('SUBSCRIBE', { event: 'tick', producer: 'p5', consumer: 'c5' });
        await delay(100);
        const viaJson = await emitAck(consumer, 'UNSUBSCRIBE', JSON.stringify({ event: 'tick', producer: 'p5', consumer: 'c5' }));
        assert.strictEqual(viaJson.ok, true);
    } finally {
        consumer.disconnect();
        await srv.close();
    }
});

test('SUBSCRIPTIONS diagnostic shows the live routing table for the realm and reflects an UNSUBSCRIBE', async () => {
    const srv = await startServer();
    const consumer = await connect(srv.port);
    try {
        consumer.emit('CONSUMER', { name: 'chat-diag' });
        consumer.emit('SUBSCRIBE', { event: 'e2ee.inbox', producer: 'TYO-MQ-ALL', consumer: 'chat-diag' });
        consumer.emit('SUBSCRIBE', { event: 'hilia-link-xyz-up', producer: 'TYO-MQ-ALL', consumer: 'chat-diag', mode: 'topic' });
        await delay(200);

        let diag = await emitAck(consumer, 'SUBSCRIPTIONS', { consumer: 'chat-diag' });
        assert.strictEqual(diag.ok, true);
        assert.strictEqual(diag.count, 2);
        const me = diag.consumers['chat-diag'];
        assert.strictEqual(me.online, true);
        assert.deepStrictEqual(me.linked_producers, ['TYO-MQ-ALL']);
        const events = me.subscriptions.map(s => s.event).sort();
        assert.deepStrictEqual(events, ['tyo-mq-all-e2ee.inbox', 'tyo-mq-all-hilia-link-xyz-up']);
        const link = me.subscriptions.find(s => s.event === 'tyo-mq-all-hilia-link-xyz-up');
        assert.strictEqual(link.mode, 'topic');
        assert.strictEqual(link.topic_pattern, 'hilia-link-xyz-up');

        // Filter by event substring.
        diag = await emitAck(consumer, 'SUBSCRIPTIONS', { event: 'hilia-link' });
        assert.strictEqual(diag.count, 1);

        await emitAck(consumer, 'UNSUBSCRIBE', { event: 'hilia-link-xyz-up', producer: 'TYO-MQ-ALL', consumer: 'chat-diag' });
        diag = await emitAck(consumer, 'SUBSCRIPTIONS', {});
        assert.strictEqual(diag.count, 1);
        assert.deepStrictEqual(diag.consumers['chat-diag'].subscriptions.map(s => s.event), ['tyo-mq-all-e2ee.inbox']);
        assert.deepStrictEqual(diag.consumers['chat-diag'].linked_producers, ['TYO-MQ-ALL'], 'wildcard link kept for the inbox');

        // Never anything but metadata.
        assert.ok(!JSON.stringify(diag).includes('message'));
    } finally {
        consumer.disconnect();
        await srv.close();
    }
});

run();
