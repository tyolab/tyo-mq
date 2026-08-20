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

test('register a UnifiedPush endpoint pointing at an internal address is 400 (SSRF)', async () => {
    const prev = process.env.TYO_MQ_PUSH_TRANSPORT;
    process.env.TYO_MQ_PUSH_TRANSPORT = 'unifiedpush';
    const srv = await startServer({ notify: { enabled: true } });
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

run();
