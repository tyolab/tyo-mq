/**
 * TYO Notify N3 — phone push (register + content/wake/off delivery).
 *
 * Uses the recording NullTransport (TYO_MQ_PUSH_TRANSPORT=null) to assert what
 * a registered device would receive. Usage: node tests/notify-push.test.js
 */

'use strict';

const assert = require('assert');
const http = require('http');
const { test, run } = require('./runner');
const push = require('../lib/push');
const { startServer, delay } = require('./helpers');

function httpRequest(port, method, pathname, opts) {
    opts = opts || {};
    return new Promise((resolve) => {
        const payload = opts.body === undefined
            ? ''
            : (Buffer.isBuffer(opts.body) ? opts.body
                : (typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body)));
        const headers = Object.assign({}, opts.headers || {});
        headers['content-length'] = Buffer.byteLength(payload);
        const req = http.request({ host: '127.0.0.1', port, path: pathname, method, headers, timeout: 3000 }, (res) => {
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

// Start a server whose push transport is the recording NullTransport.
async function startWithNullPush() {
    const prev = process.env.TYO_MQ_PUSH_TRANSPORT;
    process.env.TYO_MQ_PUSH_TRANSPORT = 'null';
    const srv = await startServer({ notify: { enabled: true } });
    srv._restore = () => {
        if (prev === undefined) delete process.env.TYO_MQ_PUSH_TRANSPORT;
        else process.env.TYO_MQ_PUSH_TRANSPORT = prev;
    };
    srv.nt = push.transportFor(srv.server._push.config, 'null');
    return srv;
}

async function registerDevice(srv, topic, ep) {
    return httpRequest(srv.port, 'POST', '/notify/' + topic + '/register', {
        headers: { 'content-type': 'application/json' },
        body: Object.assign({ transport: 'null', token: 'tok-1', app_id: 'demo' }, ep || {})
    });
}

test('push=content delivers a content-ful payload to a registered device', async () => {
    const srv = await startWithNullPush();
    try {
        assert.strictEqual((await registerDevice(srv, 'dev1')).status, 200);
        const r = await httpRequest(srv.port, 'PUT', '/notify/dev1', {
            headers: { 'x-tyo-push': 'content', title: 'Hi', tags: 'tada' },
            body: 'hello phone'
        });
        assert.strictEqual(r.status, 200, JSON.stringify(r));
        await delay(200);
        assert.strictEqual(srv.nt.sent.length, 1, JSON.stringify(srv.nt.sent));
        const p = srv.nt.sent[0].payload;
        assert.strictEqual(p.type, 'notify');
        assert.strictEqual(p.topic, 'dev1');
        assert.strictEqual(p.message, 'hello phone');
        assert.strictEqual(p.title, 'Hi');
        assert.strictEqual(p.tags, 'tada');
    } finally {
        srv._restore();
        await srv.close();
    }
});

test('default push is a contentless wake (no message/title)', async () => {
    const srv = await startWithNullPush();
    try {
        await registerDevice(srv, 'dev2');
        await httpRequest(srv.port, 'POST', '/notify/dev2', { headers: { title: 'secret' }, body: 'secret body' });
        await delay(200);
        assert.strictEqual(srv.nt.sent.length, 1, JSON.stringify(srv.nt.sent));
        const p = srv.nt.sent[0].payload;
        assert.strictEqual(p.type, 'notify');
        assert.strictEqual(p.topic, 'dev2');
        assert.strictEqual(p.wake, '1');
        assert.ok(!('message' in p), 'wake must not carry the message');
        assert.ok(!('title' in p), 'wake must not carry the title');
    } finally {
        srv._restore();
        await srv.close();
    }
});

test('push=off delivers nothing to the phone', async () => {
    const srv = await startWithNullPush();
    try {
        await registerDevice(srv, 'dev3');
        await httpRequest(srv.port, 'PUT', '/notify/dev3?push=off', { body: 'quiet' });
        await delay(200);
        assert.strictEqual(srv.nt.sent.length, 0, JSON.stringify(srv.nt.sent));
    } finally {
        srv._restore();
        await srv.close();
    }
});

test('unregister stops phone delivery', async () => {
    const srv = await startWithNullPush();
    try {
        await registerDevice(srv, 'dev4');
        const u = await httpRequest(srv.port, 'POST', '/notify/dev4/unregister', {
            headers: { 'content-type': 'application/json' },
            body: { transport: 'null', token: 'tok-1' }
        });
        assert.strictEqual(u.status, 200, JSON.stringify(u));
        assert.strictEqual(u.json.removed, 1);
        await httpRequest(srv.port, 'PUT', '/notify/dev4', { headers: { 'x-tyo-push': 'content' }, body: 'after' });
        await delay(200);
        assert.strictEqual(srv.nt.sent.length, 0, JSON.stringify(srv.nt.sent));
    } finally {
        srv._restore();
        await srv.close();
    }
});

test('register with a transport this broker does not run is 503', async () => {
    const srv = await startWithNullPush();
    try {
        const r = await httpRequest(srv.port, 'POST', '/notify/dev5/register', {
            headers: { 'content-type': 'application/json' },
            body: { transport: 'fcm', token: 'x' }
        });
        assert.strictEqual(r.status, 503, JSON.stringify(r));
    } finally {
        srv._restore();
        await srv.close();
    }
});

test('notify registry: global identity cap (LRU) + TTL eviction', async () => {
    const reg = new push.TokenRegistry({ maxIdentities: 2, ttlMs: 1000 });
    reg.register('r', 'a', { transport: 'null', token: 't', now: 1 });
    reg.register('r', 'b', { transport: 'null', token: 't', now: 2 });
    reg.register('r', 'c', { transport: 'null', token: 't', now: 3 }); // over cap → evict LRU 'a'
    assert.strictEqual(reg.count('r', 'a'), 0, 'least-recently-used identity evicted');
    assert.strictEqual(reg.count('r', 'c'), 1);
    // A much later registration sweeps identities idle past the TTL.
    reg.register('r', 'd', { transport: 'null', token: 't', now: 5000 });
    assert.strictEqual(reg.count('r', 'b'), 0, 'TTL-expired identity swept');
    assert.strictEqual(reg.count('r', 'd'), 1);
});

test('UnifiedPush registration is refused by default (reflector guard) with 403', async () => {
    const prev = process.env.TYO_MQ_PUSH_TRANSPORT;
    process.env.TYO_MQ_PUSH_TRANSPORT = 'unifiedpush';
    const srv = await startServer({ notify: { enabled: true } }); // no unifiedpush opt-in
    try {
        const r = await httpRequest(srv.port, 'POST', '/notify/dev7/register', {
            headers: { 'content-type': 'application/json' },
            body: { transport: 'unifiedpush', endpoint: 'https://example.com/up/abc' }
        });
        assert.strictEqual(r.status, 403, JSON.stringify(r));
    } finally {
        if (prev === undefined) delete process.env.TYO_MQ_PUSH_TRANSPORT;
        else process.env.TYO_MQ_PUSH_TRANSPORT = prev;
        await srv.close();
    }
});

test('with UnifiedPush opted in, an internal-address endpoint is 400 (SSRF)', async () => {
    const prev = process.env.TYO_MQ_PUSH_TRANSPORT;
    process.env.TYO_MQ_PUSH_TRANSPORT = 'unifiedpush';
    const srv = await startServer({ notify: { enabled: true, unifiedpush: true } });
    try {
        const bad = await httpRequest(srv.port, 'POST', '/notify/dev6/register', {
            headers: { 'content-type': 'application/json' },
            body: { transport: 'unifiedpush', endpoint: 'http://169.254.169.254/latest/meta-data/' }
        });
        assert.strictEqual(bad.status, 400, JSON.stringify(bad));
    } finally {
        if (prev === undefined) delete process.env.TYO_MQ_PUSH_TRANSPORT;
        else process.env.TYO_MQ_PUSH_TRANSPORT = prev;
        await srv.close();
    }
});

test('deliverNotifyPush skips endpoints whose min_priority exceeds the message priority', async () => {
    const cfg = push.loadConfig({ TYO_MQ_PUSH_TRANSPORT: 'null' });
    const registry = new push.TokenRegistry({});
    // Two devices on the same topic: one wants only priority>=4, one takes all.
    registry.register('notify', 'alerts', { transport: 'null', token: 'high-only', min_priority: 4 });
    registry.register('notify', 'alerts', { transport: 'null', token: 'take-all', min_priority: 1 });

    // A low-priority message (priority 2) reaches only the take-all device.
    const low = await push.deliverNotifyPush(cfg, registry, 'notify', 'alerts',
        { topic: 'alerts', message: 'fyi', priority: 2 }, 'content');
    assert.strictEqual(low.sent, 1);

    // A high-priority message (priority 5) reaches both.
    const high = await push.deliverNotifyPush(cfg, registry, 'notify', 'alerts',
        { topic: 'alerts', message: 'urgent', priority: 5 }, 'content');
    assert.strictEqual(high.sent, 2);

    // A message with no priority defaults to 3 -> reaches take-all, not high-only.
    const dflt = await push.deliverNotifyPush(cfg, registry, 'notify', 'alerts',
        { topic: 'alerts', message: 'noprio' }, 'content');
    assert.strictEqual(dflt.sent, 1);
});

test('TokenRegistry.register persists min_priority (create and update)', () => {
    const registry = new push.TokenRegistry({});
    const created = registry.register('notify', 'alerts', { transport: 'null', token: 't1', min_priority: 4 });
    assert.strictEqual(created.min_priority, 4);
    // A re-register updates it in place.
    const updated = registry.register('notify', 'alerts', { transport: 'null', token: 't1', min_priority: 2 });
    assert.strictEqual(updated.min_priority, 2);
    // Absent min_priority defaults to null (no filtering).
    const nofilter = registry.register('notify', 'alerts', { transport: 'null', token: 't2' });
    assert.strictEqual(nofilter.min_priority, null);
});

// ── actions in content-mode push (spec 2026-08-28 §2) ──────────────────────

test('content push carries actions JSON when they fit', async () => {
    const srv = await startWithNullPush();
    try {
        assert.strictEqual((await registerDevice(srv, 'act-fit')).status, 200);
        const pub = await httpRequest(srv.port, 'POST', '/notify', {
            headers: { 'content-type': 'application/json' },
            body: {
                topic: 'act-fit', message: 'approve?', push: 'content',
                actions: [
                    { action: 'http', label: 'Approve', url: 'https://e.x/notify/replies', method: 'POST', body: 'approve' },
                    { action: 'view', label: 'Details', url: 'https://e.x/details' }
                ]
            }
        });
        assert.strictEqual(pub.status, 200, JSON.stringify(pub));
        await delay(200);
        assert.strictEqual(srv.nt.sent.length, 1, JSON.stringify(srv.nt.sent));
        const p = srv.nt.sent[0].payload;
        assert.strictEqual(p.message, 'approve?', 'still content mode');
        assert.strictEqual(typeof p.actions, 'string', 'actions ride as a JSON string (FCM data is string-valued)');
        const actions = JSON.parse(p.actions);
        assert.strictEqual(actions.length, 2);
        assert.strictEqual(actions[0].label, 'Approve');
        assert.strictEqual(actions[0].method, 'POST');
        assert.strictEqual(actions[1].action, 'view');
    } finally {
        srv._restore();
        await srv.close();
    }
});

test('content push downgrades to wake when actions would overflow the payload', async () => {
    const srv = await startWithNullPush();
    try {
        assert.strictEqual((await registerDevice(srv, 'act-big')).status, 200);
        // 3 valid actions with ~900B bodies + a ~800B message: fits the 4KB
        // HTTP publish body, but the built content payload (message + actions
        // JSON) sails past NOTIFY_PUSH_TOTAL_MAX = 3500.
        const bigActions = Array.from({ length: 3 }, (_, i) => ({
            action: 'http', label: 'Choice ' + i, url: 'https://e.x/notify/replies',
            method: 'POST', body: 'x'.repeat(900)
        }));
        const pub = await httpRequest(srv.port, 'POST', '/notify', {
            headers: { 'content-type': 'application/json' },
            body: { topic: 'act-big', message: 'm'.repeat(800), push: 'content', actions: bigActions }
        });
        assert.strictEqual(pub.status, 200, JSON.stringify(pub));
        await delay(200);
        assert.strictEqual(srv.nt.sent.length, 1, JSON.stringify(srv.nt.sent));
        const p = srv.nt.sent[0].payload;
        // Fidelity over content: NEVER a content payload with dropped actions.
        assert.strictEqual(p.wake, '1', 'oversized actions downgrade the push to a wake: ' + JSON.stringify(p).slice(0, 200));
        assert.ok(!('message' in p), 'wake carries no message');
        assert.ok(!('actions' in p), 'wake carries no actions (the app fetches the full message)');
        assert.ok(JSON.stringify(p).length <= 3500, 'sent payload stays under the FCM headroom cap');
    } finally {
        srv._restore();
        await srv.close();
    }
});

run();
