/**
 * Durable subscriptions — the plaintext pub/sub routing table survives a
 * broker restart, so a consumer that has NOT reconnected since the restart
 * still gets a `guaranteed` PRODUCE enqueued for it (and, when push is
 * configured, woken), and receives it on its next SUBSCRIBE replay.
 *
 * Before: the table was in-memory only; the 2026-11-11 loss (a plain inbox
 * message to a phone that had been off since a deploy vanished — no enqueue,
 * no wake, nothing to replay) is the first test here.
 *
 * Usage: node tests/subscription-durable.test.js
 */

'use strict';

const assert = require('assert');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { test, run } = require('./runner');
const { startServer, delay } = require('./helpers');
const ioClient = require('socket.io-client');

function tmp(name) {
    return path.join(os.tmpdir(), 'tyo-mq-test-' + name + '-' + process.pid + '-' + Math.random().toString(36).slice(2) + '.sqlite');
}
function rm(file) { for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(file + s); } catch (e) {} } }

function connect(port) {
    return new Promise((resolve, reject) => {
        const socket = ioClient(`http://127.0.0.1:${port}`, { transports: ['websocket'], reconnection: false });
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

// A broker whose message store AND subscription store both live in files we
// control, so a second broker can be started on the same state.
function startDurable(files, extra) {
    return startServer(Object.assign({
        storage: 'sqlite',
        storage_options: { filename: files.messages },
        subscription_store: { filename: files.subs },
    }, extra || {}));
}

test('a guaranteed PRODUCE to a consumer that has NOT reconnected since a broker restart is held and replayed on its next SUBSCRIBE', async () => {
    const files = { messages: tmp('msgs'), subs: tmp('subs') };
    let srv = await startDurable(files);
    let consumer = await connect(srv.port);
    try {
        consumer.emit('CONSUMER', { name: 'chat-phone' });
        consumer.emit('SUBSCRIBE', { event: 'e2ee.inbox', producer: 'TYO-MQ-ALL', consumer: 'chat-phone', consumer_id: 'chat-phone' });
        await delay(200);
        consumer.disconnect();
        await delay(100);

        // "Deploy": the broker restarts; chat-phone does not come back yet.
        await srv.close();
        srv = await startDurable(files);
        const diag0 = await (async () => {
            const probe = await connect(srv.port);
            probe.emit('CONSUMER', { name: 'probe' });
            await delay(100);
            const d = await emitAck(probe, 'SUBSCRIPTIONS', { consumer: 'chat-phone' });
            probe.disconnect();
            return d;
        })();
        assert.strictEqual(diag0.count, 1, 'the subscription was hydrated after the restart');
        assert.strictEqual(diag0.consumers['chat-phone'].online, false, 'hydrated as OFFLINE');
        assert.deepStrictEqual(diag0.consumers['chat-phone'].linked_producers, ['TYO-MQ-ALL']);

        // Someone sends to it while it is still away.
        const producer = await connect(srv.port);
        producer.emit('PRODUCER', { name: 'chat-sender' });
        await delay(100);
        producer.emit('PRODUCE', { event: 'e2ee.inbox', message: { enc: true, body: 'held-for-you' }, from: 'chat-sender', to: 'chat-phone', guaranteed: true });
        await delay(300);
        producer.disconnect();

        // Now the phone comes back and re-subscribes, as its client does on connect.
        consumer = await connect(srv.port);
        const got = countReceived(consumer, 'CONSUME-tyo-mq-all-e2ee.inbox');
        consumer.emit('CONSUMER', { name: 'chat-phone' });
        consumer.emit('SUBSCRIBE', { event: 'e2ee.inbox', producer: 'TYO-MQ-ALL', consumer: 'chat-phone', consumer_id: 'chat-phone' });
        await delay(400);
        assert.strictEqual(got.n, 1, 'the message held during the restart gap is replayed');
        assert.strictEqual(got.last.message.body, 'held-for-you');
    } finally {
        consumer.disconnect();
        await srv.close();
        rm(files.messages); rm(files.subs);
    }
});

test('an UNSUBSCRIBEd topic does not come back after a restart; the surviving one does', async () => {
    const files = { messages: tmp('msgs'), subs: tmp('subs') };
    let srv = await startDurable(files);
    let consumer = await connect(srv.port);
    try {
        consumer.emit('CONSUMER', { name: 'chat-x' });
        consumer.emit('SUBSCRIBE', { event: 'e2ee.inbox', producer: 'TYO-MQ-ALL', consumer: 'chat-x' });
        consumer.emit('SUBSCRIBE', { event: 'hilia-link-1-up', producer: 'TYO-MQ-ALL', consumer: 'chat-x', mode: 'topic' });
        await delay(200);
        const ack = await emitAck(consumer, 'UNSUBSCRIBE', { event: 'hilia-link-1-up', producer: 'TYO-MQ-ALL', consumer: 'chat-x' });
        assert.strictEqual(ack.ok, true);
        consumer.disconnect();
        await srv.close();

        srv = await startDurable(files);
        const probe = await connect(srv.port);
        probe.emit('CONSUMER', { name: 'probe' });
        await delay(100);
        const diag = await emitAck(probe, 'SUBSCRIPTIONS', { consumer: 'chat-x' });
        probe.disconnect();
        assert.deepStrictEqual(diag.consumers['chat-x'].subscriptions.map(s => s.event), ['tyo-mq-all-e2ee.inbox']);
    } finally {
        consumer.disconnect();
        await srv.close();
        rm(files.messages); rm(files.subs);
    }
});

test('anonymous (socket-id) consumers are not persisted; subscription_store:false disables the store', async () => {
    const files = { messages: tmp('msgs'), subs: tmp('subs') };
    let srv = await startDurable(files);
    let anon = await connect(srv.port);
    try {
        anon.emit('SUBSCRIBE', { event: 'tick', producer: 'p' });   // no consumer name → ANONYMOUS
        await delay(200);
        anon.disconnect();
        await srv.close();
        srv = await startDurable(files);
        const probe = await connect(srv.port);
        probe.emit('CONSUMER', { name: 'probe' });
        await delay(100);
        const diag = await emitAck(probe, 'SUBSCRIPTIONS', {});
        probe.disconnect();
        assert.strictEqual(diag.count, 0, 'nothing hydrated for an anonymous consumer');
        await srv.close();

        const off = await startServer({ subscription_store: false });
        assert.strictEqual(off.server._subscriptionStore, null);
        await off.close();
        srv = null;
    } finally {
        if (srv) await srv.close();
        rm(files.messages); rm(files.subs);
    }
});

run();
