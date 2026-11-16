/**
 * APNs per-app provider keys (TYO_MQ_PUSH_APNS_KEYS / opts.keys).
 *
 * One broker pushes to several iOS apps (Hilia chat + TYO Notify on
 * mq.tyo.com.au). An APNs auth key may be restricted to one app's topic, so an
 * app_id can carry its own key: the provider JWT's `kid` must be that key's id
 * and the signature must verify with that key, while other app_ids keep using
 * the default key. Mirrors push-apns-topics.test.js's mock APNs.
 *
 * Usage: node tests/push-apns-keys.test.js
 */

'use strict';
const assert = require('assert');
const crypto = require('crypto');
const http2 = require('http2');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { test, run } = require('./runner');
const push = require('../lib/push');

function ecPair() {
    return crypto.generateKeyPairSync('ec', { namedCurve: 'P-256',
        publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
}
const DEFAULT = Object.assign(ecPair(), { keyId: 'L3DGSCDML3', topic: 'au.com.tyo.hilia' });
const NOTIFY = Object.assign(ecPair(), { keyId: '557ZR8PR4V', topic: 'au.com.tyo.notify' });
const TEAM_ID = 'GR4ZBUUW77';

function startFakeApns() {
    const state = { requests: [] };
    const server = http2.createServer();
    server.on('stream', (stream, headers) => {
        let body = '';
        stream.setEncoding('utf8');
        stream.on('data', (c) => { body += c; });
        stream.on('error', () => {});
        stream.on('end', () => {
            state.requests.push({ path: headers[':path'], topic: headers['apns-topic'], auth: headers['authorization'] || '', body });
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
function jwtOf(req) {
    const tok = req.auth.replace(/^bearer\s+/i, '');
    const [h, p, sig] = tok.split('.');
    const header = JSON.parse(Buffer.from(h, 'base64url').toString());
    const verifies = (pub) => crypto.createVerify('SHA256').update(h + '.' + p).verify({ key: pub, dsaEncoding: 'ieee-p1363' }, Buffer.from(sig, 'base64url'));
    return { kid: header.kid, verifies };
}

test('each app_id signs its provider JWT with its own key (kid + signature), others use the default; caches are per key', async () => {
    const fake = await startFakeApns();
    try {
        const t = new push.ApnsTransport({
            p8: DEFAULT.privateKey, keyId: DEFAULT.keyId, teamId: TEAM_ID, topic: DEFAULT.topic,
            topics: { notify: NOTIFY.topic },
            keys: { notify: { p8: NOTIFY.privateKey, keyId: NOTIFY.keyId } },
            productionHost: fake.authority, sandboxHost: fake.authority,
        });
        assert.strictEqual((await t.send({ token: 'dev-hilia', payload: { a: '1' } })).ok, true);
        assert.strictEqual((await t.send({ token: 'dev-notify', app_id: 'notify', payload: { a: '2' } })).ok, true);
        assert.strictEqual((await t.send({ token: 'dev-notify-2', app_id: 'notify', payload: { a: '3' } })).ok, true);
        await new Promise(r => setTimeout(r, 50));
        const [hilia, notify1, notify2] = fake.state.requests;

        assert.strictEqual(hilia.topic, DEFAULT.topic);
        const j0 = jwtOf(hilia);
        assert.strictEqual(j0.kid, DEFAULT.keyId);
        assert.ok(j0.verifies(DEFAULT.publicKey), 'default-app JWT verifies with the default key');
        assert.ok(!j0.verifies(NOTIFY.publicKey));

        assert.strictEqual(notify1.topic, NOTIFY.topic);
        const j1 = jwtOf(notify1);
        assert.strictEqual(j1.kid, NOTIFY.keyId);
        assert.ok(j1.verifies(NOTIFY.publicKey), 'notify JWT verifies with the notify key');
        assert.ok(!j1.verifies(DEFAULT.publicKey));

        assert.strictEqual(jwtOf(notify2).kid, NOTIFY.keyId);
        assert.strictEqual(t._signCount, 2, 'one signature per key, the second notify send reused its cache');

        t._dropProviderToken('notify');
        assert.strictEqual((await t.send({ token: 'dev-notify-3', app_id: 'notify', payload: { a: '4' } })).ok, true);
        assert.strictEqual(t._signCount, 3, 'dropping the notify token re-signs only that key');
    } finally { await fake.close(); }
});

test('env: TYO_MQ_PUSH_APNS_KEYS loads per-app keys from files; malformed input fails loud at boot', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tyo-mq-apns-keys-'));
    const dflt = path.join(dir, 'default.p8'), notify = path.join(dir, 'notify.p8');
    fs.writeFileSync(dflt, DEFAULT.privateKey); fs.writeFileSync(notify, NOTIFY.privateKey);
    try {
        const base = { TYO_MQ_PUSH_APNS_KEY: dflt, TYO_MQ_PUSH_APNS_KEY_ID: DEFAULT.keyId, TYO_MQ_PUSH_APNS_TEAM_ID: TEAM_ID, TYO_MQ_PUSH_APNS_TOPIC: DEFAULT.topic };
        const t = push.createTransport('apns', Object.assign({}, base, {
            TYO_MQ_PUSH_APNS_TOPICS: JSON.stringify({ notify: NOTIFY.topic }),
            TYO_MQ_PUSH_APNS_KEYS: JSON.stringify({ notify: { key: notify, key_id: NOTIFY.keyId } }),
        }));
        assert.strictEqual(t._keyFor('notify').keyId, NOTIFY.keyId);
        assert.strictEqual(t._keyFor('other'), t, 'unmapped app_id → default key');
        assert.strictEqual(t._topicFor('notify'), NOTIFY.topic);

        assert.throws(() => push.createTransport('apns', Object.assign({}, base, { TYO_MQ_PUSH_APNS_KEYS: '[1]' })), /JSON object/);
        assert.throws(() => push.createTransport('apns', Object.assign({}, base, { TYO_MQ_PUSH_APNS_KEYS: JSON.stringify({ notify: { key: notify } }) })), /requires key \(path\) and key_id/);
        assert.throws(() => push.createTransport('apns', Object.assign({}, base, { TYO_MQ_PUSH_APNS_KEYS: JSON.stringify({ notify: { key: path.join(dir, 'missing.p8'), key_id: 'X' } }) })), /unreadable/);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

run();
