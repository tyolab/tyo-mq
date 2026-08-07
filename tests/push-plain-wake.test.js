'use strict';
// Feature B: fire a contentless push WAKE when a plain (non-sealed) GUARANTEED
// pub/sub message is durably enqueued for an OFFLINE consumer. Mirrors the
// sealed-wake contract (best-effort, async, contentless, coalesced, no-op when
// push is unconfigured / the identity has no registered endpoint) but on the
// ordinary produce -> generateMessage -> deliverToSubscription durable path.
const assert = require('assert');
const { test, run } = require('./runner');
const push = require('../lib/push');
const { startServer, delay } = require('./helpers');
const Factory = require('tyo-mq-client').Factory;

function installPushEnv() {
    const prev = process.env.TYO_MQ_PUSH_TRANSPORT;
    process.env.TYO_MQ_PUSH_TRANSPORT = 'null';
    return { restore: () => { if (prev === undefined) delete process.env.TYO_MQ_PUSH_TRANSPORT; else process.env.TYO_MQ_PUSH_TRANSPORT = prev; } };
}

function clientOpts(port) {
    return { host: '127.0.0.1', port: port, protocol: 'http' };
}

function call(client, event, payload) {
    return new Promise((resolve) => client.socket.emit(event, payload, resolve));
}

// The keys a wake payload must NEVER carry — contentless proof.
const LEAKY_KEYS = ['sender', 'from', 'content', 'message', 'event', 'blob', 'msg_id', 'msgId', 'to', 'identity', 'realm', 'consumer'];

// ── plain guaranteed -> offline consumer -> wake fires ───────────────────────

test('plain guaranteed pub/sub to an OFFLINE consumer fires exactly ONE contentless wake', async () => {
    const penv = installPushEnv();
    const srv = await startServer();
    try {
        const nt = srv.server._push.config.transport;
        assert.ok(nt, 'null transport should be configured');

        const carol = await new Factory(clientOpts(srv.port)).createConsumer('carol');
        await delay(150);
        // subscribe (non-durable) — the GUARANTEED flag on the produce is what
        // drives the durable enqueue for the offline consumer.
        carol.subscribe('pubber', 'relay.new_request', function () {}, { durable: false });
        const reg = await call(carol, 'PUSH_REGISTER', { identity: 'carol', transport: 'null', token: 'tok-carol', app_id: 'ops' });
        assert.strictEqual(reg.ok, true);
        assert.strictEqual(reg.count, 1);
        await delay(80);
        carol.disconnect();
        await delay(150);

        const pubber = await new Factory(clientOpts(srv.port)).createProducer('pubber');
        await delay(150);
        pubber.produce('relay.new_request', { ticket: 42 }, { guaranteed: true });
        await delay(200);

        assert.strictEqual(nt.sent.length, 1, 'exactly one wake for the offline consumer');
        assert.strictEqual(nt.sent[0].token, 'tok-carol');
        const payload = nt.sent[0].payload;
        assert.strictEqual(payload.type, 'wake');
        LEAKY_KEYS.forEach((k) => assert.ok(!(k in payload), 'wake leaked ' + k));
        // and the message really is durably queued for carol
        const queued = srv.server.store.messages.filter((m) => m.consumer === 'carol' || (m.event && m.event.indexOf('relay.new_request') >= 0));
        assert.ok(queued.length >= 1, 'the guaranteed message should be durably queued');
    } finally { await srv.close(); penv.restore(); }
});

// ── online consumer -> NO wake (delivered live) ──────────────────────────────

test('plain guaranteed to an ONLINE consumer delivers live and fires NO wake', async () => {
    const penv = installPushEnv();
    const srv = await startServer();
    try {
        const nt = srv.server._push.config.transport;
        const carol = await new Factory(clientOpts(srv.port)).createConsumer('carol');
        const received = [];
        await delay(150);
        carol.subscribe('pubber', 'relay.new_request', function (data) { received.push(data); }, { durable: false });
        await call(carol, 'PUSH_REGISTER', { identity: 'carol', transport: 'null', token: 'tok-online' });
        await delay(80);

        const pubber = await new Factory(clientOpts(srv.port)).createProducer('pubber');
        await delay(150);
        pubber.produce('relay.new_request', { ticket: 7 }, { guaranteed: true });
        await delay(200);

        assert.strictEqual(received.length, 1, 'message delivered live');
        assert.strictEqual(nt.sent.length, 0, 'no wake for an online consumer');
    } finally { await srv.close(); penv.restore(); }
});

// ── non-guaranteed message -> NO wake (never durably queued) ─────────────────

test('a NON-guaranteed message to an offline consumer is not queued and fires NO wake', async () => {
    const penv = installPushEnv();
    const srv = await startServer();
    try {
        const nt = srv.server._push.config.transport;
        const carol = await new Factory(clientOpts(srv.port)).createConsumer('carol');
        await delay(150);
        carol.subscribe('pubber', 'relay.new_request', function () {}, { durable: false });
        await call(carol, 'PUSH_REGISTER', { identity: 'carol', transport: 'null', token: 'tok-carol' });
        await delay(80);
        carol.disconnect();
        await delay(150);

        const pubber = await new Factory(clientOpts(srv.port)).createProducer('pubber');
        await delay(150);
        pubber.produce('relay.new_request', { ticket: 1 });   // no guaranteed flag
        await delay(200);

        assert.strictEqual(nt.sent.length, 0, 'a fire-and-forget message must not wake');
        assert.strictEqual(srv.server._push.registry.count('default', 'carol'), 1, 'endpoint untouched');
    } finally { await srv.close(); penv.restore(); }
});

// ── coalescing: 3 guaranteed within the window -> ONE wake ───────────────────

test('coalescing: 3 guaranteed messages to one offline consumer within the window -> ONE wake', async () => {
    const penv = installPushEnv();
    const srv = await startServer();
    try {
        const nt = srv.server._push.config.transport;
        const carol = await new Factory(clientOpts(srv.port)).createConsumer('carol');
        await delay(150);
        carol.subscribe('pubber', 'relay.new_request', function () {}, { durable: false });
        await call(carol, 'PUSH_REGISTER', { identity: 'carol', transport: 'null', token: 'tok-coalesce' });
        await delay(80);
        carol.disconnect();
        await delay(150);

        const pubber = await new Factory(clientOpts(srv.port)).createProducer('pubber');
        await delay(150);
        for (let i = 0; i < 3; i++)
            pubber.produce('relay.new_request', { n: i }, { guaranteed: true });
        await delay(250);

        assert.strictEqual(nt.sent.length, 1, 'coalesced to a single wake');
    } finally { await srv.close(); penv.restore(); }
});

// ── two offline consumers -> one wake EACH ───────────────────────────────────

test('fan-out to TWO offline consumers fires one wake each (independently coalesced)', async () => {
    const penv = installPushEnv();
    const srv = await startServer();
    try {
        const nt = srv.server._push.config.transport;
        // both subscribe to the SAME event from the same producer, under the
        // ALL-publishers wildcard is not needed — a shared producer/event is enough.
        const c1 = await new Factory(clientOpts(srv.port)).createConsumer('op1');
        const c2 = await new Factory(clientOpts(srv.port)).createConsumer('op2');
        await delay(150);
        c1.subscribe('pubber', 'relay.new_request', function () {}, { durable: false });
        c2.subscribe('pubber', 'relay.new_request', function () {}, { durable: false });
        await call(c1, 'PUSH_REGISTER', { identity: 'op1', transport: 'null', token: 'tok-op1' });
        await call(c2, 'PUSH_REGISTER', { identity: 'op2', transport: 'null', token: 'tok-op2' });
        await delay(80);
        c1.disconnect();
        c2.disconnect();
        await delay(150);

        const pubber = await new Factory(clientOpts(srv.port)).createProducer('pubber');
        await delay(150);
        pubber.produce('relay.new_request', { ticket: 99 }, { guaranteed: true });
        await delay(250);

        const tokens = nt.sent.map((s) => s.token).sort();
        assert.deepStrictEqual(tokens, ['tok-op1', 'tok-op2'], 'one wake per offline consumer');
    } finally { await srv.close(); penv.restore(); }
});

// ── push OFF -> no-op (delivery still queues) ────────────────────────────────

test('push unconfigured: no wake, no error, and the guaranteed message still queues', async () => {
    const prev = process.env.TYO_MQ_PUSH_TRANSPORT;
    delete process.env.TYO_MQ_PUSH_TRANSPORT;
    const srv = await startServer();
    try {
        assert.strictEqual(srv.server._push.config, null, 'push should be disabled');
        const carol = await new Factory(clientOpts(srv.port)).createConsumer('carol');
        await delay(150);
        carol.subscribe('pubber', 'relay.new_request', function () {}, { durable: true });
        await delay(80);
        carol.disconnect();
        await delay(150);

        const pubber = await new Factory(clientOpts(srv.port)).createProducer('pubber');
        await delay(150);
        pubber.produce('relay.new_request', { ticket: 5 }, { guaranteed: true });
        await delay(200);

        const queued = srv.server.store.messages.filter((m) => m.consumer === 'carol');
        assert.ok(queued.length >= 1, 'message still durably queued with push off');
    } finally { await srv.close(); if (prev === undefined) delete process.env.TYO_MQ_PUSH_TRANSPORT; else process.env.TYO_MQ_PUSH_TRANSPORT = prev; }
});

// ── configured but NO registered token for the identity -> no-op ─────────────

test('push configured but no registered endpoint for the identity: no wake, no error, still queues', async () => {
    const penv = installPushEnv();
    const srv = await startServer();
    try {
        const nt = srv.server._push.config.transport;
        const carol = await new Factory(clientOpts(srv.port)).createConsumer('carol');
        await delay(150);
        // NOTE: deliberately no PUSH_REGISTER
        carol.subscribe('pubber', 'relay.new_request', function () {}, { durable: true });
        await delay(80);
        carol.disconnect();
        await delay(150);

        const pubber = await new Factory(clientOpts(srv.port)).createProducer('pubber');
        await delay(150);
        pubber.produce('relay.new_request', { ticket: 6 }, { guaranteed: true });
        await delay(200);

        assert.strictEqual(nt.sent.length, 0, 'no wake when the identity has no endpoint');
        const queued = srv.server.store.messages.filter((m) => m.consumer === 'carol');
        assert.ok(queued.length >= 1, 'message still durably queued');
    } finally { await srv.close(); penv.restore(); }
});

// ── wake never breaks delivery (fireWake throws) ─────────────────────────────

test('a throwing wake path never breaks the durable enqueue or the reconnect drain', async () => {
    const penv = installPushEnv();
    const origFireWake = push.fireWake;
    // force the wake to throw synchronously — the enqueue must be unaffected.
    push.fireWake = function () { throw new Error('boom: wake exploded'); };
    const srv = await startServer();
    try {
        let carol = await new Factory(clientOpts(srv.port)).createConsumer('carol');
        await delay(150);
        carol.subscribe('pubber', 'relay.new_request', function () {}, { durable: true });
        await call(carol, 'PUSH_REGISTER', { identity: 'carol', transport: 'null', token: 'tok-carol' });
        await delay(80);
        carol.disconnect();
        await delay(150);

        const pubber = await new Factory(clientOpts(srv.port)).createProducer('pubber');
        await delay(150);
        pubber.produce('relay.new_request', { ticket: 'survive' }, { guaranteed: true });
        await delay(200);

        // the message is still durably queued despite the exploding wake
        const queued = srv.server.store.messages.filter((m) => m.consumer === 'carol');
        assert.ok(queued.length >= 1, 'enqueue survived the throwing wake');

        // ...and it drains to carol on reconnect
        push.fireWake = origFireWake;   // restore before reconnect so replay path is clean
        carol = await new Factory(clientOpts(srv.port)).createConsumer('carol');
        const received = [];
        await new Promise((resolve) => {
            carol.subscribe('pubber', 'relay.new_request', function (data) { received.push(data); resolve(); }, { durable: true });
            setTimeout(resolve, 2000);
        });
        await delay(100);
        assert.strictEqual(received.length, 1, 'the message drained on reconnect');
    } finally { push.fireWake = origFireWake; await srv.close(); penv.restore(); }
});

run();
