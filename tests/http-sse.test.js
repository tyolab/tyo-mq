/**
 * P4b-2: SSE subscribe — GET /sub/:realm/:event + POST /sub-ticket/:realm.
 *
 * HTTP clients (browsers via EventSource, curl, servers) receive published
 * messages over a long-lived text/event-stream connection. The surface is OFF
 * by default and gated behind the SAME feature flag as POST /pub
 * (http_publish: { enabled: true }). SSE sinks are live-only (no durable
 * catch-up, no acks — that is P4b-3) and are delivered to from the SAME
 * produced-message fan-out as the socket path, which stays byte-identical.
 *
 * Usage: node tests/http-sse.test.js
 */

'use strict';

const assert = require('assert');
const http = require('http');
const { test, run } = require('./runner');
const Factory = require('tyo-mq-client').Factory;
const { startServer, delay } = require('./helpers');

// ── plain JSON HTTP helper ───────────────────────────────────────────────────
function httpRequest(port, method, pathname, opts) {
    opts = opts || {};
    return new Promise((resolve) => {
        const payload = opts.body === undefined
            ? ''
            : (Buffer.isBuffer(opts.body) ? opts.body
                : (typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body)));
        const headers = Object.assign({}, opts.headers || {});
        headers['content-length'] = Buffer.byteLength(payload);
        const req = http.request({
            host: '127.0.0.1', port, path: pathname, method, headers, timeout: 3000
        }, (res) => {
            let data = '';
            res.setEncoding('utf8');
            res.on('data', (c) => { data += c; });
            res.on('end', () => {
                let json = null;
                try { json = data ? JSON.parse(data) : null; } catch (e) { /* leave null */ }
                resolve({ status: res.statusCode, body: data, json });
            });
        });
        req.on('timeout', () => { req.destroy(); resolve({ status: null, body: '', json: null }); });
        req.on('error', () => resolve({ status: null, body: '', json: null }));
        req.end(payload);
    });
}

// ── minimal SSE client ───────────────────────────────────────────────────────
// Opens GET /sub..., parses `id:`/`event:`/`data:` frames and `:` comments.
// Returns a handle with .messages, .comments, .status, .close().
function openSse(port, pathname, headers) {
    return new Promise((resolve) => {
        const req = http.request({
            host: '127.0.0.1', port, path: pathname, method: 'GET',
            headers: headers || {}, timeout: 8000
        }, (res) => {
            const handle = {
                status: res.statusCode,
                messages: [],   // [{ id, event, data }]
                comments: [],   // raw comment lines (': ...')
                res,
                close: () => { try { req.destroy(); } catch (e) {} }
            };
            let buf = '';
            res.setEncoding('utf8');
            res.on('data', (chunk) => {
                buf += chunk;
                let idx;
                while ((idx = buf.indexOf('\n\n')) >= 0) {
                    const frame = buf.slice(0, idx);
                    buf = buf.slice(idx + 2);
                    if (!frame) continue;
                    if (frame.startsWith(':')) { handle.comments.push(frame); continue; }
                    const rec = { id: null, event: null, data: null };
                    frame.split('\n').forEach((line) => {
                        if (line.startsWith('id:')) rec.id = line.slice(3).trim();
                        else if (line.startsWith('event:')) rec.event = line.slice(6).trim();
                        else if (line.startsWith('data:')) {
                            const raw = line.slice(5).trim();
                            try { rec.data = JSON.parse(raw); } catch (e) { rec.data = raw; }
                        }
                    });
                    handle.messages.push(rec);
                }
            });
            resolve(handle);
        });
        // Non-2xx responses still reach the response handler above (status set).
        req.on('error', () => resolve({ status: null, messages: [], comments: [], close: () => {} }));
        req.on('timeout', () => { req.destroy(); });
        req.end();
    });
}

// A non-streaming GET that just reads the (JSON) status for error paths.
function getStatus(port, pathname, headers) {
    return httpRequest(port, 'GET', pathname, { headers: headers || {} });
}

function bearer(token) { return { 'authorization': 'Bearer ' + token }; }

const AUTH = {
    enabled: true,
    tokens: [
        { token: 'pub-acme', realm: 'acme', role: 'producer' },
        { token: 'sub-acme', realm: 'acme', role: 'consumer' },
        { token: 'sub-other', realm: 'other', role: 'consumer' }
    ]
};

function consumerFactory(port, token) {
    return new Factory({ host: '127.0.0.1', port, protocol: 'http', auth: { token } });
}

async function publish(port, realm, event, body, extra) {
    return httpRequest(port, 'POST', '/pub/' + realm + '/' + event + (extra || ''), {
        headers: Object.assign({ 'content-type': 'application/json' }, bearer('pub-acme')),
        body
    });
}

// ── feature-off default ──────────────────────────────────────────────────────
test('GET /sub and POST /sub-ticket are 404 when the feature flag is off', async () => {
    const server = await startServer({ auth: AUTH });
    try {
        const sub = await getStatus(server.port, '/sub/acme/notify', bearer('sub-acme'));
        assert.strictEqual(sub.status, 404, 'GET /sub must 404 when disabled: ' + JSON.stringify(sub));
        const ticket = await httpRequest(server.port, 'POST', '/sub-ticket/acme', { headers: bearer('sub-acme') });
        assert.strictEqual(ticket.status, 404, 'POST /sub-ticket must 404 when disabled: ' + JSON.stringify(ticket));
    } finally {
        await server.close();
    }
});

// ── live delivery ────────────────────────────────────────────────────────────
test('SSE client receives a message published via POST /pub (correct shape)', async () => {
    const server = await startServer({ auth: AUTH, http_publish: { enabled: true } });
    let sse;
    try {
        sse = await openSse(server.port, '/sub/acme/notify', bearer('sub-acme'));
        assert.strictEqual(sse.status, 200, 'stream opened: ' + JSON.stringify({ status: sse.status }));
        await delay(200);

        const pub = await publish(server.port, 'acme', 'notify', { hello: 'world', n: 7 });
        assert.strictEqual(pub.status, 202, JSON.stringify(pub));

        await delay(400);
        assert.strictEqual(sse.messages.length, 1, 'exactly one SSE frame: ' + JSON.stringify(sse.messages));
        const m = sse.messages[0];
        assert.strictEqual(m.event, 'message', 'SSE event name is "message"');
        assert.ok(m.id, 'frame carries an id');
        assert.strictEqual(m.data.event, 'notify', 'data.event preserved');
        assert.deepStrictEqual(m.data.data, { hello: 'world', n: 7 }, 'payload intact');
        assert.strictEqual(m.data.content_type, 'application/json', 'content-type echoed');
        assert.ok(m.data.producer, 'producer present');
    } finally {
        if (sse) sse.close();
        await server.close();
    }
});

// ── socket path unaffected: both a socket consumer AND an SSE sink get it ─────
test('a socket consumer and an SSE sink both receive the same produced message', async () => {
    const server = await startServer({ auth: AUTH, http_publish: { enabled: true } });
    const client = consumerFactory(server.port, 'sub-acme');
    let consumer, sse;
    try {
        consumer = await client.createConsumer('sse-and-socket');
        const socketGot = [];
        consumer.subscribe('both', function (message, from, ack, obj) {
            socketGot.push({ message, obj });
        }, {});
        await delay(300);

        sse = await openSse(server.port, '/sub/acme/both', bearer('sub-acme'));
        assert.strictEqual(sse.status, 200);
        await delay(200);

        const pub = await publish(server.port, 'acme', 'both', { v: 1 });
        assert.strictEqual(pub.status, 202, JSON.stringify(pub));
        await delay(500);

        assert.strictEqual(socketGot.length, 1, 'socket consumer got it: ' + JSON.stringify(socketGot));
        assert.deepStrictEqual(socketGot[0].message, { v: 1 }, 'socket payload intact (unchanged path)');
        assert.strictEqual(socketGot[0].obj.content_type, 'application/json');
        assert.strictEqual(sse.messages.length, 1, 'SSE sink got it too');
        assert.deepStrictEqual(sse.messages[0].data.data, { v: 1 });
    } finally {
        if (consumer) consumer.disconnect();
        if (sse) sse.close();
        await server.close();
    }
});

// ── auth: no token/ticket → 401 ──────────────────────────────────────────────
test('GET /sub with no token or ticket is 401', async () => {
    const server = await startServer({ auth: AUTH, http_publish: { enabled: true } });
    try {
        const res = await getStatus(server.port, '/sub/acme/notify');
        assert.strictEqual(res.status, 401, JSON.stringify(res));
    } finally {
        await server.close();
    }
});

test('GET /sub with a raw token in the query string is 401 (tickets only there)', async () => {
    const server = await startServer({ auth: AUTH, http_publish: { enabled: true } });
    try {
        const res = await getStatus(server.port, '/sub/acme/notify?token=sub-acme');
        assert.strictEqual(res.status, 401, JSON.stringify(res));
    } finally {
        await server.close();
    }
});

// ── auth: Bearer for realm A subscribing realm B → 403 ───────────────────────
test('GET /sub with a Bearer token scoped to another realm is 403', async () => {
    const server = await startServer({ auth: AUTH, http_publish: { enabled: true } });
    try {
        // sub-other is valid but scoped to realm 'other'.
        const res = await getStatus(server.port, '/sub/acme/notify', bearer('sub-other'));
        assert.strictEqual(res.status, 403, JSON.stringify(res));
    } finally {
        await server.close();
    }
});

// ── ticket flow: issue → subscribe → single-use → expiry ─────────────────────
test('POST /sub-ticket then GET /sub?ticket= works; ticket is single-use', async () => {
    const server = await startServer({ auth: AUTH, http_publish: { enabled: true } });
    let sse;
    try {
        const issued = await httpRequest(server.port, 'POST', '/sub-ticket/acme', { headers: bearer('sub-acme') });
        assert.strictEqual(issued.status, 200, JSON.stringify(issued));
        assert.ok(issued.json.ticket, 'ticket returned');
        assert.ok(issued.json.expires_in > 0, 'expires_in returned');
        const ticket = issued.json.ticket;

        sse = await openSse(server.port, '/sub/acme/notify?ticket=' + ticket);
        assert.strictEqual(sse.status, 200, 'first use of ticket opens the stream: ' + JSON.stringify({ status: sse.status }));
        await delay(150);

        // Publish reaches the ticket-authed SSE client.
        await publish(server.port, 'acme', 'notify', { via: 'ticket' });
        await delay(400);
        assert.strictEqual(sse.messages.length, 1, 'ticket-authed client received the message');

        // Second use of the same ticket is rejected (single-use).
        const reuse = await getStatus(server.port, '/sub/acme/notify?ticket=' + ticket);
        assert.strictEqual(reuse.status, 401, 'second use of ticket must be 401: ' + JSON.stringify(reuse));
    } finally {
        if (sse) sse.close();
        await server.close();
    }
});

test('a ticket for realm A cannot be used to subscribe realm B (403)', async () => {
    const server = await startServer({ auth: AUTH, http_publish: { enabled: true } });
    try {
        const issued = await httpRequest(server.port, 'POST', '/sub-ticket/acme', { headers: bearer('sub-acme') });
        assert.strictEqual(issued.status, 200, JSON.stringify(issued));
        // Ticket is bound to acme; using it against 'other' is 403.
        const res = await getStatus(server.port, '/sub/other/notify?ticket=' + issued.json.ticket);
        assert.strictEqual(res.status, 403, JSON.stringify(res));
    } finally {
        await server.close();
    }
});

test('POST /sub-ticket without a valid token is 401', async () => {
    const server = await startServer({ auth: AUTH, http_publish: { enabled: true } });
    try {
        const res = await httpRequest(server.port, 'POST', '/sub-ticket/acme', { headers: bearer('nope') });
        assert.strictEqual(res.status, 401, JSON.stringify(res));
    } finally {
        await server.close();
    }
});

// ── cleanup: sink removed on disconnect (no leak) ────────────────────────────
test('SSE sink is removed after the client disconnects (no leak)', async () => {
    const server = await startServer({ auth: AUTH, http_publish: { enabled: true } });
    const baseline = server.server._sseSinkCount();
    let sse;
    try {
        sse = await openSse(server.port, '/sub/acme/notify', bearer('sub-acme'));
        assert.strictEqual(sse.status, 200);
        await delay(200);
        assert.strictEqual(server.server._sseSinkCount(), baseline + 1, 'one live sink registered');

        sse.close();
        await delay(500);
        assert.strictEqual(server.server._sseSinkCount(), baseline, 'sink reaped on disconnect');

        // Publishing again does not error / leak.
        const pub = await publish(server.port, 'acme', 'notify', { after: 'disconnect' });
        assert.strictEqual(pub.status, 202, JSON.stringify(pub));
    } finally {
        if (sse) sse.close();
        await server.close();
    }
});

// ── connection cap (per IP) ──────────────────────────────────────────────────
test('exceeding the per-IP SSE connection cap is rejected (429/503)', async () => {
    // The per-IP cap is 10; open 10 then assert the 11th is refused.
    const server = await startServer({ auth: AUTH, http_publish: { enabled: true } });
    const open = [];
    try {
        for (let i = 0; i < 10; i++) {
            const h = await openSse(server.port, '/sub/acme/cap' + i, bearer('sub-acme'));
            assert.strictEqual(h.status, 200, 'connection ' + i + ' should open: ' + JSON.stringify({ status: h.status }));
            open.push(h);
        }
        await delay(200);
        const over = await getStatus(server.port, '/sub/acme/capX', bearer('sub-acme'));
        assert.ok(over.status === 429 || over.status === 503, 'the 11th connection is capped: ' + JSON.stringify(over));
    } finally {
        open.forEach((h) => h.close());
        await server.close();
    }
});

// ── keep-alive comment ───────────────────────────────────────────────────────
test('an SSE stream opens with a comment (keep-alive channel established)', async () => {
    const server = await startServer({ auth: AUTH, http_publish: { enabled: true } });
    let sse;
    try {
        sse = await openSse(server.port, '/sub/acme/notify', bearer('sub-acme'));
        assert.strictEqual(sse.status, 200);
        await delay(200);
        // The stream primes with a `: ok` comment on open (the 25s keep-alive
        // uses the same comment channel — asserting the priming comment keeps the
        // test fast while proving comments flow).
        assert.ok(sse.comments.length >= 1, 'at least one comment received: ' + JSON.stringify(sse.comments));
    } finally {
        if (sse) sse.close();
        await server.close();
    }
});

// ── cluster relay reaches SSE sinks (FIX 1) ─────────────────────────────────
// A message produced on node A and cluster-relayed to node B must reach B's
// live SSE sinks, not just its socket subscribers. Multi-node is hard to spin
// up in the fixture, so this is a UNIT-LEVEL assertion: register a real SSE sink
// on this node, then invoke the relay-delivery path directly via the test hook
// and assert the sink receives the message (proving handleRelayedMessage hits
// the SSE fan-out hook).
test('a cluster-relayed message reaches a local SSE sink (relay path hits the hook)', async () => {
    const server = await startServer({ auth: AUTH, http_publish: { enabled: true } });
    let sse;
    try {
        sse = await openSse(server.port, '/sub/acme/relayed', bearer('sub-acme'));
        assert.strictEqual(sse.status, 200);
        await delay(200);

        // Simulate a message that ingested on a peer node and was relayed here.
        server.server._deliverRelayedMessage({
            realm: 'acme',
            event: 'relayed',
            message: { from: 'peer-node', k: 9 },
            producer: 'http:peer',
            contentType: 'application/json'
        });

        await delay(300);
        assert.strictEqual(sse.messages.length, 1, 'relayed message reached the SSE sink: ' + JSON.stringify(sse.messages));
        const m = sse.messages[0];
        assert.strictEqual(m.event, 'message');
        assert.strictEqual(m.data.event, 'relayed');
        assert.deepStrictEqual(m.data.data, { from: 'peer-node', k: 9 });
        assert.strictEqual(m.data.producer, 'http:peer');
        assert.strictEqual(m.data.content_type, 'application/json', 'content_type carried across the relay frame');
    } finally {
        if (sse) sse.close();
        await server.close();
    }
});

// ── backpressure: a slow (never-reading) consumer is dropped ─────────────────
// Open the SSE stream over a raw socket that we deliberately never read from.
// The kernel send buffer fills, res.write stops draining, the sink's pending
// byte count climbs past its bound, and the broker drops the sink rather than
// buffer unboundedly. We push far more than the 1 MiB bound to guarantee the
// buffers stall regardless of the loopback socket buffer size.
const net = require('net');
test('a slow SSE consumer that never reads is dropped past its pending bound', async () => {
    const server = await startServer({ auth: AUTH, http_publish: { enabled: true } });
    const baseline = server.server._sseSinkCount();
    let sock;
    try {
        sock = net.connect(server.port, '127.0.0.1');
        await new Promise((resolve) => sock.on('connect', resolve));
        // Raw SSE GET. We never call read()/resume() → data queues in the kernel.
        sock.write(
            'GET /sub/acme/slow HTTP/1.1\r\n' +
            'Host: 127.0.0.1\r\n' +
            'Authorization: Bearer sub-acme\r\n' +
            'Accept: text/event-stream\r\n\r\n'
        );
        sock.pause(); // never drain the incoming stream
        await delay(300);
        assert.strictEqual(server.server._sseSinkCount(), baseline + 1, 'slow sink registered');

        // Push ~7 MiB of frames (≈120 × ~60 KiB) — well past the 1 MiB bound and
        // any loopback buffer, so pending must cross the bound and drop the sink.
        const big = 'y'.repeat(60 * 1024);
        for (let batch = 0; batch < 12; batch++) {
            const burst = [];
            for (let i = 0; i < 10; i++)
                burst.push(publish(server.port, 'acme', 'slow', { blob: big }));
            await Promise.all(burst);
        }

        // The sink is reaped back to baseline (dropped, not buffered forever).
        let dropped = false;
        for (let i = 0; i < 40; i++) {
            if (server.server._sseSinkCount() === baseline) { dropped = true; break; }
            await delay(100);
        }
        assert.ok(dropped, 'slow sink was dropped (pending bound enforced), count back to baseline');
    } finally {
        if (sock) sock.destroy();
        await server.close();
    }
});

// ── P4b-3: resume / durable catch-up ─────────────────────────────────────────

// resume delivers the gap: publish 1-3 guaranteed, connect with Last-Event-ID
// = id-of-1 → receive 2 and 3 (in order), then a live 4.
test('SSE resume via Last-Event-ID replays the durable gap, then streams live', async () => {
    const server = await startServer({ auth: AUTH, http_publish: { enabled: true } });
    let sse;
    try {
        const p1 = await publish(server.port, 'acme', 'resume', { n: 1 }, '?guaranteed=1');
        await publish(server.port, 'acme', 'resume', { n: 2 }, '?guaranteed=1');
        await publish(server.port, 'acme', 'resume', { n: 3 }, '?guaranteed=1');
        assert.strictEqual(p1.status, 202, JSON.stringify(p1));
        const id1 = p1.json.msg_id;
        assert.ok(id1, 'publish returns the resumable msg_id');

        sse = await openSse(server.port, '/sub/acme/resume',
            Object.assign({ 'last-event-id': id1 }, bearer('sub-acme')));
        assert.strictEqual(sse.status, 200, JSON.stringify({ status: sse.status }));
        await delay(300);
        assert.deepStrictEqual(sse.messages.map((m) => m.data.data.n), [2, 3],
            'the gap after id-of-1 is replayed in order: ' + JSON.stringify(sse.messages));

        await publish(server.port, 'acme', 'resume', { n: 4 }, '?guaranteed=1');
        await delay(300);
        assert.deepStrictEqual(sse.messages.map((m) => m.data.data.n), [2, 3, 4],
            'a message published after resume is streamed live after the replay');
    } finally {
        if (sse) sse.close();
        await server.close();
    }
});

// ?since=<msg_id> is accepted as an alternative to the Last-Event-ID header.
test('SSE resume via ?since=<msg_id> replays the durable gap', async () => {
    const server = await startServer({ auth: AUTH, http_publish: { enabled: true } });
    let sse;
    try {
        const p1 = await publish(server.port, 'acme', 'since', { n: 1 }, '?guaranteed=1');
        await publish(server.port, 'acme', 'since', { n: 2 }, '?guaranteed=1');
        await publish(server.port, 'acme', 'since', { n: 3 }, '?guaranteed=1');
        const id1 = p1.json.msg_id;

        sse = await openSse(server.port, '/sub/acme/since?since=' + encodeURIComponent(id1), bearer('sub-acme'));
        assert.strictEqual(sse.status, 200);
        await delay(300);
        assert.deepStrictEqual(sse.messages.map((m) => m.data.data.n), [2, 3],
            '?since replays the same gap as Last-Event-ID: ' + JSON.stringify(sse.messages));
    } finally {
        if (sse) sse.close();
        await server.close();
    }
});

// no dupe at boundary: a message published concurrently with the replay appears
// exactly once (either replayed OR live, never both).
test('SSE resume: a message racing the replay boundary appears exactly once', async () => {
    const server = await startServer({ auth: AUTH, http_publish: { enabled: true } });
    let sse;
    try {
        const p1 = await publish(server.port, 'acme', 'race', { n: 1 }, '?guaranteed=1');
        await publish(server.port, 'acme', 'race', { n: 2 }, '?guaranteed=1');
        const id1 = p1.json.msg_id;

        sse = await openSse(server.port, '/sub/acme/race',
            Object.assign({ 'last-event-id': id1 }, bearer('sub-acme')));
        assert.strictEqual(sse.status, 200);
        // Publish n:3 concurrently with the (async) replay — it may land in the
        // snapshot, the live buffer, or both; dedup must collapse it to one.
        await publish(server.port, 'acme', 'race', { n: 3 }, '?guaranteed=1');
        await delay(500);

        const ns = sse.messages.map((m) => m.data.data.n);
        assert.deepStrictEqual(ns, [2, 3],
            'boundary message delivered exactly once, in order: ' + JSON.stringify(sse.messages));
    } finally {
        if (sse) sse.close();
        await server.close();
    }
});

// no resume header → live-only (unchanged P4b-2 behaviour): existing history is
// NOT replayed; only messages published after connect arrive.
test('SSE without a resume header does not replay history (live-only, P4b-2)', async () => {
    const server = await startServer({ auth: AUTH, http_publish: { enabled: true } });
    let sse;
    try {
        await publish(server.port, 'acme', 'lo', { n: 1 }, '?guaranteed=1');
        await publish(server.port, 'acme', 'lo', { n: 2 }, '?guaranteed=1');

        sse = await openSse(server.port, '/sub/acme/lo', bearer('sub-acme'));
        assert.strictEqual(sse.status, 200);
        await delay(300);
        assert.strictEqual(sse.messages.length, 0,
            'no history replayed without a resume point: ' + JSON.stringify(sse.messages));

        await publish(server.port, 'acme', 'lo', { n: 3 }, '?guaranteed=1');
        await delay(300);
        assert.deepStrictEqual(sse.messages.map((m) => m.data.data.n), [3],
            'only the live message is delivered');
    } finally {
        if (sse) sse.close();
        await server.close();
    }
});

// non-destructive: an SSE resume-replay reads only the reserved SSE-history
// consumer; a real durable consumer's queued rows are untouched (not consumed).
test('SSE resume-replay is non-destructive: durable consumer rows survive', async () => {
    const server = await startServer({ auth: AUTH, http_publish: { enabled: true } });
    let sse;
    try {
        // Simulate a real durable consumer's pending queue (its OWN consumer key).
        await server.server.store.enqueue('acme', 'nd', { id: 'real-1', consumer_id: 'worker', payload: { r: 1 }, producer: 'p' });
        await server.server.store.enqueue('acme', 'nd', { id: 'real-2', consumer_id: 'worker', payload: { r: 2 }, producer: 'p' });

        // SSE-history rows arrive via guaranteed publishes.
        const p1 = await publish(server.port, 'acme', 'nd', { n: 1 }, '?guaranteed=1');
        await publish(server.port, 'acme', 'nd', { n: 2 }, '?guaranteed=1');

        sse = await openSse(server.port, '/sub/acme/nd',
            Object.assign({ 'last-event-id': p1.json.msg_id }, bearer('sub-acme')));
        assert.strictEqual(sse.status, 200);
        await delay(300);
        assert.deepStrictEqual(sse.messages.map((m) => m.data.data.n), [2],
            'the SSE gap was replayed: ' + JSON.stringify(sse.messages));

        // The durable consumer's rows are still there (replay did not dequeue/ack).
        const rows = await server.server.store.dequeue('acme', 'nd', 'worker');
        assert.strictEqual(rows.length, 2,
            'durable consumer rows intact after SSE replay: ' + JSON.stringify(rows));
        assert.deepStrictEqual(rows.map((r) => r.message), [{ r: 1 }, { r: 2 }],
            'durable consumer payloads untouched');
    } finally {
        if (sse) sse.close();
        await server.close();
    }
});

// bounded: a far-behind resume replays at most the cap (1000) and signals
// truncation, keeping the newest rather than doing unbounded work.
test('SSE catch-up replay is bounded (far-behind resume is capped + truncation signalled)', async () => {
    const server = await startServer({ auth: AUTH, http_publish: { enabled: true } });
    let sse;
    try {
        // Seed 1100 SSE-history rows (reserved consumer) to overrun the 1000 cap.
        for (let i = 0; i < 1100; i++) {
            await server.server.store.enqueue('acme', 'big', {
                id: 'h-' + i, consumer_id: '__http_sse__',
                payload: { event: 'big', data: { i: i }, producer: 'x' }
            });
        }
        // Unknown resume id → replay the whole available window (capped).
        sse = await openSse(server.port, '/sub/acme/big',
            Object.assign({ 'last-event-id': 'no-such-id' }, bearer('sub-acme')));
        assert.strictEqual(sse.status, 200);
        await delay(1000);

        assert.strictEqual(sse.messages.length, SSE_REPLAY_CAP,
            'replay capped at ' + SSE_REPLAY_CAP + ': got ' + sse.messages.length);
        assert.strictEqual(sse.messages[sse.messages.length - 1].data.data.i, 1099,
            'newest message kept (tail within the cap)');
        assert.strictEqual(sse.messages[0].data.data.i, 100,
            'oldest-beyond-cap dropped (kept the newest 1000)');
        assert.ok(sse.comments.some((c) => /truncat/i.test(c)),
            'truncation is signalled with a comment: ' + JSON.stringify(sse.comments));
    } finally {
        if (sse) sse.close();
        await server.close();
    }
});

const SSE_REPLAY_CAP = 1000;

run();
