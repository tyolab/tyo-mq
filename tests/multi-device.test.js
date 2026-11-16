/**
 * Multi-device Phase 1 (broker) — built against the frozen Phase 0 vectors in
 * tests/vectors/multi-device/ (secure-chat feat/multi-device-p0 @5ac3846):
 *   - per-device prekey bundles: PREKEY_PUBLISH/TAKE `device` (absent = 1)
 *   - DEVICES_PUBLISH / DEVICES_FETCH: phone-signed device list, seq increases,
 *     XEdDSA over "tyo-devlist-v1\n" || record with the device-1 identity key
 *   - identity binding: the account's token may register `<account>.<N>`, N in 2..5
 *   - SEALED_CERT_REQUEST minted only for the socket bound as that device's name
 *   - stale-devices signal on SEALED_DELIVER via `devices_seq`
 *
 * Usage: node tests/multi-device.test.js
 */

'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const ioClient = require('socket.io-client');
const { PrivateKey, ServerCertificate } = require('@signalapp/libsignal-client');
const { test, run } = require('./runner');
const { startServer, delay } = require('./helpers');

const V = (f) => JSON.parse(fs.readFileSync(path.join(__dirname, 'vectors', 'multi-device', f), 'utf8'));
const DL = V('device_list.json');
const BUNDLE = V('bundle.json');
const ACCOUNT = BUNDLE.publishDevice1.identity;            // chat-0123456789abcdef
const D2 = BUNDLE.consumerNames['2'];                       // chat-0123456789abcdef.2
const wireOf = (x) => (typeof x === 'string' ? JSON.parse(x) : x);

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
function nextEvent(socket, ev) { return new Promise(r => socket.once(ev, r)); }
function installSealedEnv() {
    const root = PrivateKey.generate(), serverKey = PrivateKey.generate();
    const serverCert = ServerCertificate.new(1, serverKey.getPublicKey(), root);
    const prev = { c: process.env.TYO_MQ_SEALED_SERVER_CERT, k: process.env.TYO_MQ_SEALED_SERVER_KEY };
    process.env.TYO_MQ_SEALED_SERVER_CERT = Buffer.from(serverCert.serialize()).toString('base64');
    process.env.TYO_MQ_SEALED_SERVER_KEY = Buffer.from(serverKey.serialize()).toString('base64');
    const put = (k, v) => { if (v === undefined) delete process.env[k]; else process.env[k] = v; };
    return { restore: () => { put('TYO_MQ_SEALED_SERVER_CERT', prev.c); put('TYO_MQ_SEALED_SERVER_KEY', prev.k); } };
}
// Token-bound broker: an injected validator maps tokens to identity claims (static
// tokens carry realm/role only; the identity claim is what JWTs/validators supply).
const TOKENS = {
    't-acct':  { realm: 'default', role: 'both', identity: ACCOUNT, sub: 'u1' },
    't-other': { realm: 'default', role: 'both', identity: 'chat-ffffffffffffffff', sub: 'u2' },
};
function boundAuth(extra) {
    return Object.assign({ auth: { enabled: true, realms: { default: { required: true, e2ee: 'required' } } } }, extra || {});
}
async function boot(extra) {
    const srv = await startServer(boundAuth(extra));
    srv.server.settings.merge({ auth: { validator: (token) => TOKENS[token] || null } });
    return srv;
}
async function authed(port, token) {
    const s = await connect(port);
    const ok = nextEvent(s, 'AUTH_OK'); const fail = nextEvent(s, 'AUTH_FAIL');
    s.emit('AUTHENTICATION', { token, realm: 'default' });
    const r = await Promise.race([ok.then(() => 'ok'), fail.then(f => 'fail:' + JSON.stringify(f))]);
    assert.strictEqual(r, 'ok', 'auth ' + token);
    return s;
}
function register(s, name) { s.emit('CONSUMER', { name, id: name + '-inst', consumer_id: name }); return delay(120); }
// The device-list vector is signed by ITS OWN test identity key (DL.identityKey),
// which differs from the bundle vector's; pass it where a list will be verified.
async function publishDevice1Bundle(s, identityKey) {
    const r = await emitAck(s, 'PREKEY_PUBLISH', Object.assign({}, BUNDLE.publishDevice1, { identity: ACCOUNT }, identityKey ? { identity_key: identityKey } : {}));
    assert.strictEqual(r.ok, true, JSON.stringify(r));
}

test('identity binding: the account token may register device names .2..5 but not .6, another account, or a stranger', async () => {
    const srv = await boot();
    try {
        const s = await authed(srv.port, 't-acct');
        const errors = []; s.on('ERROR', e => errors.push(e));
        await register(s, ACCOUNT); await register(s, D2); await register(s, ACCOUNT + '.5');
        assert.strictEqual(errors.length, 0, 'device names accepted: ' + JSON.stringify(errors));
        await register(s, ACCOUNT + '.6'); await register(s, 'chat-ffffffffffffffff.2');
        assert.strictEqual(errors.filter(e => e.code === 403).length, 2, '.6 and another account refused');
        s.disconnect();
    } finally { await srv.close(); }
});

test('per-device bundles: device 2 publishes without overwriting device 1; TAKE selects by device (absent = 1); devices:null before any list', async () => {
    const srv = await boot();
    try {
        const phone = await authed(srv.port, 't-acct'); await register(phone, ACCOUNT);
        const browser = await authed(srv.port, 't-acct'); await register(browser, D2);
        await publishDevice1Bundle(phone, DL.identityKey);
        const r2 = await emitAck(browser, 'PREKEY_PUBLISH', BUNDLE.publishDevice2);     // identity=account, device=2
        assert.strictEqual(r2.ok, true, JSON.stringify(r2));
        // a stranger socket may not publish device 2 for this account
        const other = await authed(srv.port, 't-other'); await register(other, 'chat-ffffffffffffffff');
        const bad = await emitAck(other, 'PREKEY_PUBLISH', BUNDLE.publishDevice2);
        assert.strictEqual(bad.ok, false); assert.strictEqual(bad.code, 403);

        const t1 = await emitAck(other, 'PREKEY_TAKE', BUNDLE.takeDevice1);
        const t2 = await emitAck(other, 'PREKEY_TAKE', BUNDLE.takeDevice2);
        const tAbsent = await emitAck(other, 'PREKEY_TAKE', { identity: ACCOUNT });
        assert.strictEqual(t1.found, true); assert.strictEqual(t1.registration_id, 4001); assert.strictEqual(t1.device, 1);
        assert.strictEqual(t2.found, true); assert.strictEqual(t2.registration_id, 4002); assert.strictEqual(t2.device, 2);
        assert.strictEqual(tAbsent.registration_id, 4001, 'absent device means 1');
        assert.strictEqual(t1.devices, null); assert.strictEqual(t2.devices, null);
        const stats = await emitAck(other, 'PREKEY_STATS', {});
        assert.ok(stats.identities[ACCOUNT].has_bundle && stats.identities[D2].has_bundle, 'two directory entries');
        const t3 = await emitAck(other, 'PREKEY_TAKE', { identity: ACCOUNT, device: 3 });
        assert.strictEqual(t3.found, false);
        [phone, browser, other].forEach(s => s.disconnect());
    } finally { await srv.close(); }
});

test('device list: device 1 publishes the vector (verified, seq 7); fetch + TAKE carry it; canonical/signature/seq rules; only device 1 may publish; durable across restart', async () => {
    const file = path.join(os.tmpdir(), 'tyo-mq-test-md-' + process.pid + '-' + Math.random().toString(36).slice(2) + '.sqlite');
    const opts = { prekey_store: { filename: file } };
    let srv = await boot(opts);
    try {
        const phone = await authed(srv.port, 't-acct'); await register(phone, ACCOUNT);
        const browser = await authed(srv.port, 't-acct'); await register(browser, D2);
        const other = await authed(srv.port, 't-other'); await register(other, 'chat-ffffffffffffffff');

        // before the device-1 bundle exists the list cannot be verified
        const early = await emitAck(phone, 'DEVICES_PUBLISH', wireOf(DL.wire));
        assert.strictEqual(early.ok, false); assert.strictEqual(early.code, 409);
        await publishDevice1Bundle(phone, DL.identityKey);

        const pub = await emitAck(phone, 'DEVICES_PUBLISH', wireOf(DL.wire));
        assert.strictEqual(pub.ok, true, JSON.stringify(pub)); assert.strictEqual(pub.seq, 7);
        const again = await emitAck(phone, 'DEVICES_PUBLISH', wireOf(DL.wire));
        assert.strictEqual(again.ok, true); assert.strictEqual(again.unchanged, true, 'identical re-publish is idempotent');

        const fetched = await emitAck(other, 'DEVICES_FETCH', { account: ACCOUNT });
        assert.strictEqual(fetched.seq, 7); assert.strictEqual(fetched.devices.record, DL.record); assert.strictEqual(fetched.devices.sig, DL.sig);
        const viaDevName = await emitAck(other, 'DEVICES_FETCH', { account: D2 });
        assert.strictEqual(viaDevName.seq, 7, 'a device name resolves to its account');
        const none = await emitAck(other, 'DEVICES_FETCH', { account: 'chat-ffffffffffffffff' });
        assert.strictEqual(none.devices, null, 'never published → devices:null (clients read [1])');
        const take = await emitAck(other, 'PREKEY_TAKE', { identity: ACCOUNT });
        assert.strictEqual(take.devices.record, DL.record, 'TAKE carries the list');

        // negatives
        const nonCanon = await emitAck(phone, 'DEVICES_PUBLISH', { record: DL.negative.nonCanonicalRecord, sig: DL.sig });
        assert.strictEqual(nonCanon.ok, false); assert.strictEqual(nonCanon.code, 400);
        const otherKey = await emitAck(phone, 'DEVICES_PUBLISH', wireOf(DL.negative.signedByOtherKey.wire));
        assert.strictEqual(otherKey.ok, false); assert.strictEqual(otherKey.code, 403);
        const fromBrowser = await emitAck(browser, 'DEVICES_PUBLISH', wireOf(DL.seq8RemovingDevice2));
        assert.strictEqual(fromBrowser.ok, false); assert.strictEqual(fromBrowser.code, 403, 'only device 1 may publish');
        const fromStranger = await emitAck(other, 'DEVICES_PUBLISH', wireOf(DL.seq8RemovingDevice2));
        assert.strictEqual(fromStranger.code, 403);

        const seq8 = await emitAck(phone, 'DEVICES_PUBLISH', wireOf(DL.seq8RemovingDevice2));
        assert.strictEqual(seq8.ok, true); assert.strictEqual(seq8.seq, 8);
        const rollback = await emitAck(phone, 'DEVICES_PUBLISH', wireOf(DL.wire));            // seq 7 again
        assert.strictEqual(rollback.ok, false); assert.strictEqual(rollback.code, 409);
        [phone, browser, other].forEach(s => s.disconnect());

        // restart on the same store: list (and bundle) hydrate
        await srv.close();
        srv = await boot(opts);
        const probe = await authed(srv.port, 't-other'); await register(probe, 'chat-ffffffffffffffff');
        const after = await emitAck(probe, 'DEVICES_FETCH', { account: ACCOUNT });
        assert.strictEqual(after.seq, 8, 'device list survives a restart');
        assert.strictEqual(JSON.parse(after.devices.record).devices.length, 1, 'device 2 was removed at seq 8');
        probe.disconnect();
    } finally { await srv.close(); for (const sfx of ['', '-wal', '-shm']) { try { fs.unlinkSync(file + sfx); } catch (e) {} } }
});

test('sealed certs are minted per device: device_id 2 only for the socket registered as <account>.2', async () => {
    const env = installSealedEnv();
    const srv = await boot();
    try {
        const phone = await authed(srv.port, 't-acct'); await register(phone, ACCOUNT);
        const browser = await authed(srv.port, 't-acct'); await register(browser, D2);
        const ik = BUNDLE.publishDevice1.identity_key;
        const c1 = await emitAck(phone, 'SEALED_CERT_REQUEST', { identity: ACCOUNT, identity_key: ik, device_id: 1 });
        assert.strictEqual(c1.ok, true, JSON.stringify(c1));
        const c2bad = await emitAck(phone, 'SEALED_CERT_REQUEST', { identity: ACCOUNT, identity_key: ik, device_id: 2 });
        assert.strictEqual(c2bad.ok, false); assert.strictEqual(c2bad.code, 403, 'the phone socket is not device 2');
        const c2 = await emitAck(browser, 'SEALED_CERT_REQUEST', { identity: ACCOUNT, identity_key: ik, device_id: 2 });
        assert.strictEqual(c2.ok, true, JSON.stringify(c2));
        const c2byName = await emitAck(browser, 'SEALED_CERT_REQUEST', { identity: D2, identity_key: ik });
        assert.strictEqual(c2byName.ok, true, 'device name form implies device_id 2');
        const c1fromBrowser = await emitAck(browser, 'SEALED_CERT_REQUEST', { identity: ACCOUNT, identity_key: ik });
        assert.strictEqual(c1fromBrowser.code, 403, 'the browser socket is not device 1');
        phone.disconnect(); browser.disconnect();
    } finally { await srv.close(); env.restore(); }
});

test('stale-devices: a sealed send carrying devices_seq older than the stored list gets stale_devices + the list in its ack; current seq does not', async () => {
    const env = installSealedEnv();
    const srv = await boot();
    try {
        const phone = await authed(srv.port, 't-acct'); await register(phone, ACCOUNT);
        await publishDevice1Bundle(phone, DL.identityKey);
        assert.strictEqual((await emitAck(phone, 'DEVICES_PUBLISH', wireOf(DL.seq8RemovingDevice2))).seq, 8);
        const uak = Buffer.alloc(16, 5).toString('base64');
        phone.on('SEALED_MESSAGE', (p, ack) => { if (typeof ack === 'function') ack({ ok: true }); });
        assert.strictEqual((await emitAck(phone, 'SEALED_UAK_SET', { identity: ACCOUNT, uak, mode: 'require-uak' })).ok, true);

        const sender = await authed(srv.port, 't-other'); await register(sender, 'chat-ffffffffffffffff');
        const base = { to: { realm: 'default', identity: ACCOUNT }, uak, blob: Buffer.from('x').toString('base64') };
        const stale = await emitAck(sender, 'SEALED_DELIVER', Object.assign({ msg_id: 'm-1', devices_seq: 7 }, base));
        assert.strictEqual(stale.ok, true, JSON.stringify(stale));
        assert.strictEqual(stale.stale_devices, true); assert.strictEqual(stale.devices_seq, 8);
        assert.strictEqual(JSON.parse(stale.devices.record).seq, 8);
        const fresh = await emitAck(sender, 'SEALED_DELIVER', Object.assign({ msg_id: 'm-2', devices_seq: 8 }, base));
        assert.strictEqual(fresh.ok, true); assert.strictEqual(fresh.stale_devices, undefined);
        const noHint = await emitAck(sender, 'SEALED_DELIVER', Object.assign({ msg_id: 'm-3' }, base));
        assert.strictEqual(noHint.ok, true); assert.strictEqual(noHint.stale_devices, undefined, 'no hint → no signal (older clients unaffected)');
        phone.disconnect(); sender.disconnect();
    } finally { await srv.close(); env.restore(); }
});

run();
