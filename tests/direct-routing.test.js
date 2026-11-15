/**
 * Per-realm DIRECT ROUTING for `to`-addressed messages.
 *
 * Off (default): `to` is pass-through metadata and a PRODUCE fans out to every
 * subscriber of the event — on a chat realm every device sees every envelope's
 * to/from in the clear, and every offline device gets a durable copy + wake.
 * On (`direct_routing: true`, or `set_realm_routing {direct:true}`): the
 * message reaches ONLY the consumer named by `to` — live, durable, woken — and
 * is not recorded for HTTP-SSE catch-up. Traffic without `to` is unchanged.
 *
 * Usage: node tests/direct-routing.test.js
 */

'use strict';

const assert = require('assert');
const { test, run } = require('./runner');
const { startServer, delay } = require('./helpers');
const ioClient = require('socket.io-client');
const adminSignature = require('tyo-mq-protocol').adminSignature;

const ADMIN_TOKEN = 'direct-routing-admin-token';

function connect(port) {
    return new Promise((resolve, reject) => {
        const socket = ioClient(`http://127.0.0.1:${port}`, { transports: ['websocket'], reconnection: false });
        const timer = setTimeout(() => { socket.disconnect(); reject(new Error('connect timeout')); }, 5000);
        socket.on('connect', () => { clearTimeout(timer); resolve(socket); });
        socket.on('connect_error', err => { clearTimeout(timer); reject(err); });
    });
}
function countReceived(socket, consumeEvent) {
    const box = { n: 0, last: null };
    socket.on(consumeEvent, msg => { box.n++; box.last = msg; });
    return box;
}
function managementCommand(port, body) {
    const s = ioClient('http://127.0.0.1:' + port, { transports: ['websocket'], forceNew: true, reconnection: false });
    return new Promise((resolve, reject) => {
        s.on('connect_error', reject);
        s.on('connect', () => {
            const payload = { body, proof: adminSignature.createAdminProof(ADMIN_TOKEN, 'AUTH_MANAGEMENT_COMMAND', body) };
            s.emit('AUTH_MANAGEMENT_COMMAND', payload, (res) => { s.disconnect(); resolve(res); });
        });
    });
}
async function twoSubscribers(port) {
    const a = await connect(port), b = await connect(port);
    a.emit('CONSUMER', { name: 'chat-a' });
    b.emit('CONSUMER', { name: 'chat-b' });
    a.emit('SUBSCRIBE', { event: 'e2ee.inbox', producer: 'TYO-MQ-ALL', consumer: 'chat-a' });
    b.emit('SUBSCRIBE', { event: 'e2ee.inbox', producer: 'TYO-MQ-ALL', consumer: 'chat-b' });
    await delay(200);
    return { a, b, ga: countReceived(a, 'CONSUME-tyo-mq-all-e2ee.inbox'), gb: countReceived(b, 'CONSUME-tyo-mq-all-e2ee.inbox') };
}

test('OFF (default): a `to` message fans out to every subscriber of the event', async () => {
    const srv = await startServer();
    const producer = await connect(srv.port);
    const { a, b, ga, gb } = await twoSubscribers(srv.port);
    try {
        producer.emit('PRODUCER', { name: 'chat-p' });
        producer.emit('PRODUCE', { event: 'e2ee.inbox', message: { enc: true }, from: 'chat-p', to: 'chat-a' });
        await delay(300);
        assert.strictEqual(ga.n, 1); assert.strictEqual(gb.n, 1, 'pre-existing behaviour: everyone gets it');
    } finally { producer.disconnect(); a.disconnect(); b.disconnect(); await srv.close(); }
});

test('ON: a `to` message reaches only its addressee; messages without `to` still fan out', async () => {
    const srv = await startServer({ auth: { realms: { default: { direct_routing: true } } } });
    const producer = await connect(srv.port);
    const { a, b, ga, gb } = await twoSubscribers(srv.port);
    try {
        producer.emit('PRODUCER', { name: 'chat-p' });
        producer.emit('PRODUCE', { event: 'e2ee.inbox', message: { enc: true, n: 1 }, from: 'chat-p', to: 'chat-a' });
        await delay(300);
        assert.strictEqual(ga.n, 1, 'addressee receives');
        assert.strictEqual(gb.n, 0, 'bystander receives nothing — not even the envelope');
        assert.strictEqual(ga.last.to, 'chat-a');

        producer.emit('PRODUCE', { event: 'e2ee.inbox', message: { n: 2 }, from: 'chat-p' });
        await delay(300);
        assert.strictEqual(ga.n, 2); assert.strictEqual(gb.n, 1, 'no `to` → unchanged fan-out');

        producer.emit('PRODUCE', { event: 'e2ee.inbox', message: { n: 3 }, from: 'chat-p', to: 'chat-nobody' });
        await delay(300);
        assert.strictEqual(ga.n, 2); assert.strictEqual(gb.n, 1, 'an unknown addressee reaches no one');
    } finally { producer.disconnect(); a.disconnect(); b.disconnect(); await srv.close(); }
});

test('ON: a guaranteed `to` message to an OFFLINE addressee is enqueued for it alone and replayed on its return; the bystander never sees it', async () => {
    const srv = await startServer({ auth: { realms: { default: { direct_routing: true } } } });
    const producer = await connect(srv.port);
    let { a, b, ga, gb } = await twoSubscribers(srv.port);
    try {
        b.disconnect();                       // chat-b goes offline, subscription retained
        await delay(150);
        producer.emit('PRODUCER', { name: 'chat-p' });
        producer.emit('PRODUCE', { event: 'e2ee.inbox', message: { enc: true, body: 'for-b' }, from: 'chat-p', to: 'chat-b', guaranteed: true });
        producer.emit('PRODUCE', { event: 'e2ee.inbox', message: { enc: true, body: 'for-a' }, from: 'chat-p', to: 'chat-a', guaranteed: true });
        await delay(300);
        assert.strictEqual(ga.n, 1, 'a gets only its own'); assert.strictEqual(ga.last.message.body, 'for-a');

        b = await connect(srv.port);
        gb = countReceived(b, 'CONSUME-tyo-mq-all-e2ee.inbox');
        b.emit('CONSUMER', { name: 'chat-b' });
        b.emit('SUBSCRIBE', { event: 'e2ee.inbox', producer: 'TYO-MQ-ALL', consumer: 'chat-b' });
        await delay(400);
        assert.strictEqual(gb.n, 1, 'b gets exactly the message addressed to it, replayed');
        assert.strictEqual(gb.last.message.body, 'for-b');
        assert.strictEqual(ga.n, 1, "a never received b's message, live or replayed");
    } finally { producer.disconnect(); a.disconnect(); b.disconnect(); await srv.close(); }
});

test('ON: the HTTP-SSE history copy is not recorded for a direct message (it is for a broadcast one)', async () => {
    const srv = await startServer({ auth: { realms: { default: { direct_routing: true } } }, http_publish: { enabled: true } });
    const producer = await connect(srv.port);
    const { a, b } = await twoSubscribers(srv.port);
    try {
        producer.emit('PRODUCER', { name: 'chat-p' });
        producer.emit('PRODUCE', { event: 'e2ee.inbox', message: { enc: true }, from: 'chat-p', to: 'chat-a', guaranteed: true });
        producer.emit('PRODUCE', { event: 'e2ee.inbox', message: { n: 'bcast' }, from: 'chat-p', guaranteed: true });
        await delay(400);
        const history = await srv.server.store.dequeue('default', 'e2ee.inbox', '__http_sse__');
        assert.strictEqual(history.length, 1, 'only the broadcast is in SSE history');
        assert.strictEqual(history[0].message.to, undefined);
    } finally { producer.disconnect(); a.disconnect(); b.disconnect(); await srv.close(); }
});

test('set_realm_routing: a signed management command turns direct routing on and off live; bad input is refused', async () => {
    const srv = await startServer({ auth: { enabled: true, tokens: [{ token: ADMIN_TOKEN, realm: '*', role: 'admin' }], realms: { default: { required: false } } } });
    const producer = await connect(srv.port);
    const { a, b, ga, gb } = await twoSubscribers(srv.port);
    try {
        producer.emit('PRODUCER', { name: 'chat-p' });
        const bad = await managementCommand(srv.port, { command: 'set_realm_routing', realm: 'default', direct: 'yes' });
        assert.strictEqual(bad.ok, false); assert.strictEqual(bad.code, 400);

        const on = await managementCommand(srv.port, { command: 'set_realm_routing', realm: 'default', direct: true });
        assert.strictEqual(on.ok, true);
        producer.emit('PRODUCE', { event: 'e2ee.inbox', message: { n: 1 }, from: 'chat-p', to: 'chat-a' });
        await delay(300);
        assert.strictEqual(ga.n, 1); assert.strictEqual(gb.n, 0);

        const off = await managementCommand(srv.port, { command: 'set_realm_routing', realm: 'default', direct: false });
        assert.strictEqual(off.ok, true);
        producer.emit('PRODUCE', { event: 'e2ee.inbox', message: { n: 2 }, from: 'chat-p', to: 'chat-a' });
        await delay(300);
        assert.strictEqual(ga.n, 2); assert.strictEqual(gb.n, 1, 'off again: fan-out restored');
    } finally { producer.disconnect(); a.disconnect(); b.disconnect(); await srv.close(); }
});

run();
