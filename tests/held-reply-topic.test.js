/**
 * The Hilia "held -up reply" contract (2026-11-16): the phone subscribes to a
 * raw per-link topic DURABLE with manual ack; the browser produces replies as
 * `guaranteed: true, ttl: 600, wake: "silent"`. While the phone is away the
 * broker must hold the frame, fire ONE contentless SILENT wake keyed by the
 * phone's consumer name, replay the frame on the next SUBSCRIBE, keep it until
 * ACKed, and never replay it after the ttl.
 *
 * Usage: node tests/held-reply-topic.test.js
 */

'use strict';

const assert = require('assert');
const { test, run } = require('./runner');
const { startServer, delay } = require('./helpers');
const ioClient = require('socket.io-client');

function installPushEnv() {
    const prev = process.env.TYO_MQ_PUSH_TRANSPORT;
    process.env.TYO_MQ_PUSH_TRANSPORT = 'null';
    return { restore() { if (prev === undefined) delete process.env.TYO_MQ_PUSH_TRANSPORT; else process.env.TYO_MQ_PUSH_TRANSPORT = prev; } };
}
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
const TOPIC = 'hilia-link-abc123-up';
const EVENT = 'CONSUME-tyo-mq-all-' + TOPIC;

async function armPhone(port) {
    const phone = await connect(port);
    phone.emit('CONSUMER', { name: 'chat-1' });
    phone.emit('SUBSCRIBE', { event: TOPIC, producer: 'TYO-MQ-ALL', consumer: 'chat-1', consumer_id: 'chat-1', durable: true, manual_ack: true, mode: 'topic' });
    await delay(150);
    const reg = await emitAck(phone, 'PUSH_REGISTER', { identity: 'chat-1', transport: 'null', token: 'tok-phone', app_id: 'hilia' });
    assert.strictEqual(reg.ok, true, JSON.stringify(reg));
    return phone;
}

test('phone away: a guaranteed/ttl/wake:silent -up frame is held, wakes the phone silently once, is replayed on re-SUBSCRIBE and stays until ACKed', async () => {
    const env = installPushEnv();
    const srv = await startServer({ auth: { realms: { default: { push: { default_wake: 'alert', alert: { title: 'Hilia', body: 'New message' } } } } } });
    try {
        const nt = srv.server._push.config.transport;
        let phone = await armPhone(srv.port);
        phone.disconnect();                       // Doze: socket gone, subscription + registration retained
        await delay(150);

        const browser = await connect(srv.port);
        browser.emit('PRODUCER', { name: 'hilia-link-abc123' });
        await delay(100);
        browser.emit('PRODUCE', { event: TOPIC, message: { enc: true, sealed: 'bytes-1' }, from: 'hilia-link-abc123', guaranteed: true, ttl: 600, wake: 'silent' });
        await delay(400);

        assert.strictEqual(nt.sent.length, 1, 'exactly one wake for the dozing phone');
        assert.strictEqual(nt.sent[0].token, 'tok-phone', 'keyed by the phone\'s consumer name');
        assert.strictEqual(nt.sent[0].alert, undefined, 'wake:"silent" → no alert copy despite the realm default being alert');
        assert.ok(!('message' in nt.sent[0].payload) && !('sealed' in nt.sent[0].payload), 'contentless');

        // Phone wakes, re-identifies and re-SUBSCRIBEs: the held frame is replayed with a msgId.
        phone = await connect(srv.port);
        const got = [];
        phone.on(EVENT, m => got.push(m));
        phone.emit('CONSUMER', { name: 'chat-1' });
        phone.emit('SUBSCRIBE', { event: TOPIC, producer: 'TYO-MQ-ALL', consumer: 'chat-1', consumer_id: 'chat-1', durable: true, manual_ack: true, mode: 'topic' });
        await delay(500);
        assert.strictEqual(got.length, 1, 'held frame replayed');
        assert.strictEqual(got[0].message.sealed, 'bytes-1');
        assert.ok(got[0].msgId || got[0].msg_id, 'replay carries a msgId for the manual ACK');

        // Not ACKed → comes back again on the next re-SUBSCRIBE; ACKed → gone.
        phone.disconnect(); await delay(100);
        phone = await connect(srv.port);
        const again = [];
        phone.on(EVENT, m => again.push(m));
        phone.emit('CONSUMER', { name: 'chat-1' });
        phone.emit('SUBSCRIBE', { event: TOPIC, producer: 'TYO-MQ-ALL', consumer: 'chat-1', consumer_id: 'chat-1', durable: true, manual_ack: true, mode: 'topic' });
        await delay(500);
        assert.strictEqual(again.length, 1, 'un-ACKed frame is redelivered (at-most-once is the phone\'s digest guard)');
        const ack = await emitAck(phone, 'ACK', { msgId: again[0].msgId || again[0].msg_id });
        assert.strictEqual(ack.ok, true, JSON.stringify(ack));
        phone.disconnect(); await delay(100);
        phone = await connect(srv.port);
        const third = [];
        phone.on(EVENT, m => third.push(m));
        phone.emit('CONSUMER', { name: 'chat-1' });
        phone.emit('SUBSCRIBE', { event: TOPIC, producer: 'TYO-MQ-ALL', consumer: 'chat-1', consumer_id: 'chat-1', durable: true, manual_ack: true, mode: 'topic' });
        await delay(400);
        assert.strictEqual(third.length, 0, 'ACKed frame is not replayed');
        assert.strictEqual(nt.sent.length, 1, 'no further wakes while the phone was online for the replays');
        phone.disconnect(); browser.disconnect();
    } finally { await srv.close(); env.restore(); }
});

test('ttl: a held -up frame past its ttl is not replayed', async () => {
    const env = installPushEnv();
    const srv = await startServer();
    try {
        let phone = await armPhone(srv.port);
        phone.disconnect(); await delay(150);
        const browser = await connect(srv.port);
        browser.emit('PRODUCER', { name: 'hilia-link-abc123' });
        await delay(100);
        browser.emit('PRODUCE', { event: TOPIC, message: { enc: true, sealed: 'stale' }, from: 'hilia-link-abc123', guaranteed: true, ttl: 1, wake: 'silent' });
        await delay(1400);
        phone = await connect(srv.port);
        const got = [];
        phone.on(EVENT, m => got.push(m));
        phone.emit('CONSUMER', { name: 'chat-1' });
        phone.emit('SUBSCRIBE', { event: TOPIC, producer: 'TYO-MQ-ALL', consumer: 'chat-1', consumer_id: 'chat-1', durable: true, manual_ack: true, mode: 'topic' });
        await delay(400);
        assert.strictEqual(got.length, 0, 'expired frame is dropped, never replayed as a stale reply');
        phone.disconnect(); browser.disconnect();
    } finally { await srv.close(); env.restore(); }
});

run();
