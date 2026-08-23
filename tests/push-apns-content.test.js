'use strict';
const assert = require('assert');
const crypto = require('crypto');
const http2 = require('http2');
const { test, run } = require('./runner');
const push = require('../lib/push');

const EC = crypto.generateKeyPairSync('ec', {
    namedCurve: 'P-256',
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});
const KEY_ID = 'YU4YDV365T', TEAM_ID = 'GR4ZBUUW77', TOPIC = 'au.com.tyo.notify';

function startFakeApns() {
    const state = { requests: [] };
    const server = http2.createServer();
    server.on('stream', (stream, headers) => {
        let body = '';
        stream.setEncoding('utf8');
        stream.on('data', (c) => { body += c; });
        stream.on('error', () => {});
        stream.on('end', () => {
            state.requests.push({
                path: headers[':path'], topic: headers['apns-topic'],
                pushType: headers['apns-push-type'], priority: headers['apns-priority'], body,
            });
            try { stream.respond({ ':status': 200 }); stream.end(); } catch (e) {}
        });
    });
    return new Promise((resolve) => {
        server.listen(0, '127.0.0.1', () => resolve({
            state, authority: 'http://127.0.0.1:' + server.address().port,
            close: () => new Promise((r) => server.close(r)),
        }));
    });
}
function makeTransport(fake) {
    return new push.ApnsTransport({
        p8: EC.privateKey, keyId: KEY_ID, teamId: TEAM_ID, topic: TOPIC,
        productionHost: fake.authority, sandboxHost: fake.authority,
    });
}

test('a CONTENT payload sends an APNs alert with title + body', async () => {
    const fake = await startFakeApns();
    try {
        const t = makeTransport(fake);
        const payload = push.buildNotifyPayload(
            { topic: 'deploys', id: '42', title: 'Deploy succeeded', message: 'v2.4.1 is live', priority: 4 },
            'content');
        const r = await t.send({ transport: 'apns', token: 'dev-1', payload: payload });
        assert.deepStrictEqual(r, { ok: true });
        const req = fake.state.requests[0];
        assert.strictEqual(req.pushType, 'alert');
        assert.strictEqual(req.priority, '10');
        const b = JSON.parse(req.body);
        assert.strictEqual(b.aps.alert.title, 'Deploy succeeded');
        assert.strictEqual(b.aps.alert.body, 'v2.4.1 is live');
        assert.strictEqual(b.aps.sound, 'default');
        assert.strictEqual(b.aps['mutable-content'], 1);
        // custom keys let the NSE / app record to history without a fetch
        assert.strictEqual(b.topic, 'deploys');
        assert.strictEqual(b.id, '42');
    } finally { await fake.close(); }
});

test('a CONTENT payload with no title falls back to the topic as the alert title', async () => {
    const fake = await startFakeApns();
    try {
        const t = makeTransport(fake);
        const payload = push.buildNotifyPayload({ topic: 'orders', message: 'New order #4821' }, 'content');
        await t.send({ transport: 'apns', token: 'dev-1', payload: payload });
        const b = JSON.parse(fake.state.requests[0].body);
        assert.strictEqual(b.aps.alert.title, 'orders');
        assert.strictEqual(b.aps.alert.body, 'New order #4821');
    } finally { await fake.close(); }
});

test('a WAKE payload stays a contentless silent background push', async () => {
    const fake = await startFakeApns();
    try {
        const t = makeTransport(fake);
        const payload = push.buildNotifyPayload({ topic: 'deploys', id: '42' }, 'wake');
        await t.send({ transport: 'apns', token: 'dev-1', payload: payload });
        const req = fake.state.requests[0];
        assert.strictEqual(req.pushType, 'background');
        assert.strictEqual(req.priority, '5');
        assert.deepStrictEqual(JSON.parse(req.body), { aps: { 'content-available': 1 } });
    } finally { await fake.close(); }
});

run();
