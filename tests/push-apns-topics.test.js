'use strict';
const assert = require('assert');
const crypto = require('crypto');
const http2 = require('http2');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { test, run } = require('./runner');
const push = require('../lib/push');

const EC = crypto.generateKeyPairSync('ec', {
    namedCurve: 'P-256',
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});
const KEY_ID = 'YU4YDV365T';
const TEAM_ID = 'GR4ZBUUW77';
const DEFAULT_TOPIC = 'au.com.tyo.hilia';
const NOTIFY_TOPIC = 'au.com.tyo.notify';

// h2c mock APNs: records apns-topic + path per request.
function startFakeApns() {
    const state = { requests: [] };
    const server = http2.createServer();
    server.on('stream', (stream, headers) => {
        let body = '';
        stream.setEncoding('utf8');
        stream.on('data', (c) => { body += c; });
        stream.on('error', () => {});
        stream.on('end', () => {
            state.requests.push({ path: headers[':path'], topic: headers['apns-topic'], body });
            try { stream.respond({ ':status': 200 }); stream.end(); } catch (e) {}
        });
    });
    return new Promise((resolve) => {
        server.listen(0, '127.0.0.1', () => {
            resolve({
                state,
                authority: 'http://127.0.0.1:' + server.address().port,
                close: () => new Promise((r) => server.close(r)),
            });
        });
    });
}

function makeTransport(fake, extra) {
    return new push.ApnsTransport(Object.assign({
        p8: EC.privateKey, keyId: KEY_ID, teamId: TEAM_ID, topic: DEFAULT_TOPIC,
        productionHost: fake.authority, sandboxHost: fake.authority,
    }, extra || {}));
}

test('send routes each app_id to its own apns-topic, default for the rest', async () => {
    const fake = await startFakeApns();
    try {
        const t = makeTransport(fake, { topics: { notify: NOTIFY_TOPIC } });
        await t.send({ transport: 'apns', app_id: 'notify', token: 'notify-dev-1' });
        await t.send({ transport: 'apns', app_id: 'hilia', token: 'hilia-dev-1' }); // unmapped -> default
        await t.send({ transport: 'apns', token: 'noapp-dev-1' });                   // no app_id -> default
        assert.strictEqual(fake.state.requests.length, 3);
        const byPath = {};
        fake.state.requests.forEach((r) => { byPath[r.path] = r.topic; });
        assert.strictEqual(byPath['/3/device/notify-dev-1'], NOTIFY_TOPIC);
        assert.strictEqual(byPath['/3/device/hilia-dev-1'], DEFAULT_TOPIC);
        assert.strictEqual(byPath['/3/device/noapp-dev-1'], DEFAULT_TOPIC);
    } finally { await fake.close(); }
});

test('a prototype-key app_id ("__proto__") falls through to the default topic', async () => {
    const fake = await startFakeApns();
    try {
        const t = makeTransport(fake, { topics: { notify: NOTIFY_TOPIC } });
        await t.send({ transport: 'apns', app_id: '__proto__', token: 'x' });
        assert.strictEqual(fake.state.requests[0].topic, DEFAULT_TOPIC);
    } finally { await fake.close(); }
});

test('a map-only transport (no default topic) skips an unmapped app_id, sends a mapped one', async () => {
    const fake = await startFakeApns();
    try {
        const t = new push.ApnsTransport({
            p8: EC.privateKey, keyId: KEY_ID, teamId: TEAM_ID,
            topics: { notify: NOTIFY_TOPIC },
            productionHost: fake.authority, sandboxHost: fake.authority,
        });
        const ok = await t.send({ transport: 'apns', app_id: 'notify', token: 'n-1' });
        assert.deepStrictEqual(ok, { ok: true });
        const skip = await t.send({ transport: 'apns', app_id: 'nope', token: 'y' });
        assert.deepStrictEqual(skip, { ok: false }); // NOT gone — retain, do not prune
        assert.strictEqual(fake.state.requests.length, 1);
    } finally { await fake.close(); }
});

test('loadConfig wires the default topic + per-app_id topics from env', () => {
    const file = path.join(os.tmpdir(), 'apns-key-topics-' + process.pid + '.p8');
    fs.writeFileSync(file, EC.privateKey);
    try {
        const cfg = push.loadConfig({
            TYO_MQ_PUSH_TRANSPORT: 'apns',
            TYO_MQ_PUSH_APNS_KEY: file,
            TYO_MQ_PUSH_APNS_KEY_ID: KEY_ID,
            TYO_MQ_PUSH_APNS_TEAM_ID: TEAM_ID,
            TYO_MQ_PUSH_APNS_TOPIC: DEFAULT_TOPIC,
            TYO_MQ_PUSH_APNS_TOPICS: JSON.stringify({ notify: NOTIFY_TOPIC }),
        });
        assert.ok(cfg.transport instanceof push.ApnsTransport);
        assert.strictEqual(cfg.transport._topicFor('notify'), NOTIFY_TOPIC);
        assert.strictEqual(cfg.transport._topicFor('other'), DEFAULT_TOPIC);
    } finally { fs.unlinkSync(file); }
});

test('unparseable TYO_MQ_PUSH_APNS_TOPICS throws at config load', () => {
    const file = path.join(os.tmpdir(), 'apns-key-badtopics-' + process.pid + '.p8');
    fs.writeFileSync(file, EC.privateKey);
    try {
        assert.throws(() => push.loadConfig({
            TYO_MQ_PUSH_TRANSPORT: 'apns',
            TYO_MQ_PUSH_APNS_KEY: file,
            TYO_MQ_PUSH_APNS_KEY_ID: KEY_ID,
            TYO_MQ_PUSH_APNS_TEAM_ID: TEAM_ID,
            TYO_MQ_PUSH_APNS_TOPIC: DEFAULT_TOPIC,
            TYO_MQ_PUSH_APNS_TOPICS: '{not json',
        }), /TYO_MQ_PUSH_APNS_TOPICS/);
    } finally { fs.unlinkSync(file); }
});

run();
