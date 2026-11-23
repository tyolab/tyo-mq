'use strict';
/**
 * PRODUCE_CHUNK reassembly guards (1.12.3). Chunks are buffered until the last
 * one arrives; a connected client could previously open unlimited transfers with
 * an unchecked `total`/`index` and hold memory until it disconnected. Now:
 * malformed fields are refused (400), more than 8 concurrent transfers per
 * socket are refused (429), buffered bytes per socket are capped (413), idle
 * transfers are dropped after 60 s, a duplicate index is ignored. The happy
 * path (a real chunked round trip) is tests/large-message.test.js.
 *
 * Usage: node tests/produce-chunk-guards.test.js
 */
const assert = require('assert');
const ioc = require('socket.io-client');
const { test, run } = require('./runner');
const { startServer, delay, waitFor } = require('./helpers');

function capturingLogger() {
    const calls = { warn: [], info: [], log: [], error: [], critical: [], output: [], debug: [], trace: [] };
    const mk = (lvl) => (...a) => { calls[lvl].push(a.map(String).join(' ')); };
    return { calls, warn: mk('warn'), info: mk('info'), log: mk('log'), error: mk('error'), critical: mk('critical'), output: mk('output'), debug: mk('debug'), trace: mk('trace') };
}
async function producer(port) {
    const s = ioc('http://127.0.0.1:' + port, { transports: ['websocket'], forceNew: true, reconnection: false });
    await waitFor(s, 'connect');
    const errors = []; s.on('ERROR', e => errors.push(e));
    s.emit('PRODUCER', { name: 'chunker-' + Math.random().toString(36).slice(2, 7) });
    await delay(80);
    return { s, errors };
}
const chunk = (transferId, index, total, data) => ({ transferId, index, total, data });

test('malformed chunks are refused with a 400 ERROR and a warn line: bad total, out-of-range index, non-string data, oversize transferId', async () => {
    const srv = await startServer();
    const logger = capturingLogger(); srv.server.logger = logger;
    try {
        const { s, errors } = await producer(srv.port);
        s.emit('PRODUCE_CHUNK', chunk('t1', 0, 0, 'x'));                 // total 0
        s.emit('PRODUCE_CHUNK', chunk('t2', 0, 100000, 'x'));            // total absurd
        s.emit('PRODUCE_CHUNK', chunk('t3', 5, 2, 'x'));                 // index ≥ total
        s.emit('PRODUCE_CHUNK', chunk('t4', 0, 2, 12345));               // data not a string
        s.emit('PRODUCE_CHUNK', chunk('x'.repeat(65), 0, 2, 'x'));       // transferId too long
        await delay(300);
        assert.strictEqual(errors.length, 5, JSON.stringify(errors.map(e => e.code)));
        errors.forEach(e => { assert.strictEqual(e.code, 400); assert.ok(/malformed chunk/.test(e.message), e.message); });
        assert.strictEqual(logger.calls.warn.filter(l => /PRODUCE_CHUNK refused: malformed/.test(l)).length, 5);
        // A part over the socket.io frame cap (1 MB default on this test broker; 8 MB on
        // mq) never reaches the handler: socket.io closes the transport. Pin that so the
        // 1 MB per-part guard is understood as the layer BELOW the frame cap, not above it.
        const closed = waitFor(s, 'disconnect');
        s.emit('PRODUCE_CHUNK', chunk('t6', 0, 2, 'x'.repeat(1024 * 1024 + 1)));
        const reason = await Promise.race([closed, delay(2000).then(() => 'STILL_OPEN')]);
        assert.strictEqual(reason, 'transport close', 'oversize frame closes the transport at the socket.io layer');
    } finally { await srv.close(); }
});

test('at most 8 transfers in flight per socket; the 9th is refused 429; completing one frees a slot; a duplicate index is not double-counted', async () => {
    const srv = await startServer();
    const logger = capturingLogger(); srv.server.logger = logger;
    try {
        const { s, errors } = await producer(srv.port);
        for (let i = 0; i < 8; i++) s.emit('PRODUCE_CHUNK', chunk('open-' + i, 0, 2, '{"event":"g","a":'));
        s.emit('PRODUCE_CHUNK', chunk('open-8', 0, 2, '{"event":"g","a":'));
        await delay(250);
        assert.strictEqual(errors.length, 1, JSON.stringify(errors)); assert.strictEqual(errors[0].code, 429);
        assert.ok(/too many concurrent transfers/.test(errors[0].message), errors[0].message);
        // duplicate index on an open transfer: ignored, so it does NOT complete with a hole
        s.emit('PRODUCE_CHUNK', chunk('open-0', 0, 2, '{"event":"g","a":'));
        await delay(150);
        assert.ok(!logger.calls.warn.some(l => /failed to parse reassembled/.test(l)), 'a duplicate part must not complete the transfer with a hole');
        // complete open-0 properly → a slot frees → a new transfer is admitted
        s.emit('PRODUCE_CHUNK', chunk('open-0', 1, 2, '1}'));
        await delay(150);
        s.emit('PRODUCE_CHUNK', chunk('open-9', 0, 2, '{"event":"g","b":'));
        await delay(200);
        assert.strictEqual(errors.length, 1, 'no new refusal after a slot was freed: ' + JSON.stringify(errors));
        s.disconnect();
    } finally { await srv.close(); }
});

test('buffered bytes per socket are capped (413, transfer dropped) and a transfer idle for over 60 s is swept with a warn line', async () => {
    const srv = await startServer();
    const logger = capturingLogger(); srv.server.logger = logger;
    try {
        const { s, errors } = await producer(srv.port);
        // 32 MB cap: 67 parts of 500 KB on one transfer (total 80 so it never completes;
        // each frame stays under the test broker's 1 MB socket.io frame cap)
        const half = 'y'.repeat(500 * 1024);
        for (let i = 0; i < 67; i++) s.emit('PRODUCE_CHUNK', chunk('big', i, 80, half));
        await waitFor(s, 'ERROR').catch(() => {});
        await delay(400);
        const e413 = errors.filter(e => e.code === 413);
        assert.strictEqual(e413.length, 1, JSON.stringify(errors.map(e => e.code)));
        assert.ok(/too much data buffered/.test(e413[0].message), e413[0].message);
        assert.ok(logger.calls.warn.some(l => /pending bytes would exceed/.test(l)));

        s.disconnect();
    } finally { await srv.close(); }
});

test('a transfer idle for longer than the idle window is swept at the next chunk from that socket, with a warn line (window shortened via TYO_MQ_CHUNK_IDLE_MS for the test)', async () => {
    const prev = process.env.TYO_MQ_CHUNK_IDLE_MS;
    process.env.TYO_MQ_CHUNK_IDLE_MS = '300';
    const srv = await startServer();
    const logger = capturingLogger(); srv.server.logger = logger;
    try {
        const { s, errors } = await producer(srv.port);
        s.emit('PRODUCE_CHUNK', chunk('stale', 0, 3, 'abc'));
        await delay(600);                                   // > 300 ms idle
        s.emit('PRODUCE_CHUNK', chunk('fresh', 0, 3, 'abc'));
        await delay(200);
        assert.ok(logger.calls.warn.some(l => /dropped stale transfer \(1\/3 parts, idle \d+s/.test(l)), JSON.stringify(logger.calls.warn));
        assert.strictEqual(errors.length, 0, 'sweeping is silent toward the client: ' + JSON.stringify(errors));
        // the slot came back: 8 more transfers are admitted (fresh + 8 would be 9 without the sweep... fresh is 1, so 7 more then the 9th refused)
        for (let i = 0; i < 7; i++) s.emit('PRODUCE_CHUNK', chunk('more-' + i, 0, 3, 'abc'));
        s.emit('PRODUCE_CHUNK', chunk('ninth', 0, 3, 'abc'));
        await delay(250);
        assert.strictEqual(errors.filter(e => e.code === 429).length, 1, JSON.stringify(errors));
        s.disconnect();
    } finally { await srv.close(); if (prev === undefined) delete process.env.TYO_MQ_CHUNK_IDLE_MS; else process.env.TYO_MQ_CHUNK_IDLE_MS = prev; }
});

test('a reassembled message with no event is refused 400 and the broker stays up (it used to throw out of routing and kill the process)', async () => {
    const srv = await startServer();
    const logger = capturingLogger(); srv.server.logger = logger;
    try {
        const { s, errors } = await producer(srv.port);
        s.emit('PRODUCE_CHUNK', chunk('noev', 0, 2, '{"a":'));
        s.emit('PRODUCE_CHUNK', chunk('noev', 1, 2, '1}'));
        await delay(250);
        assert.strictEqual(errors.length, 1, JSON.stringify(errors)); assert.strictEqual(errors[0].code, 400);
        assert.ok(/event .*required/.test(errors[0].message), errors[0].message);
        assert.ok(logger.calls.warn.some(l => /PRODUCE refused: message has no event name/.test(l)));
        // same guard on a plain PRODUCE
        s.emit('PRODUCE', { message: 'no event here' });
        await delay(150);
        assert.strictEqual(errors.length, 2); assert.strictEqual(errors[1].code, 400);
        assert.strictEqual(s.connected, true, 'socket still up');
        // and a well-formed one still routes (no error)
        s.emit('PRODUCE', { event: 'guard.ok', message: 'hello' });
        await delay(150);
        assert.strictEqual(errors.length, 2, 'well-formed produce not refused');
        s.disconnect();
    } finally { await srv.close(); }
});

run();
