'use strict';
const assert = require('assert');
const crypto = require('crypto');
const http2 = require('http2');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { test, run } = require('./runner');
const push = require('../lib/push');

// ── helpers ────────────────────────────────────────────────────────────────

// A real EC P-256 keypair so the ES256 provider JWT the transport signs can be
// cryptographically VERIFIED (kid, iss, alg, signature) — not merely observed.
// The pkcs8 PEM has the same shape as an Apple .p8 key, which createPrivateKey
// accepts directly.
const EC = crypto.generateKeyPairSync('ec', {
    namedCurve: 'P-256',
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

const KEY_ID = 'YU4YDV365T';
const TEAM_ID = 'GR4ZBUUW77';
const TOPIC = 'au.com.tyo.hilia';

// Verify a provider JWT against the EC public key. Returns { header, payload,
// verified }. ieee-p1363 matches the raw r||s ES256 signature the transport
// produces.
function verifyJwt(jwt) {
    const parts = String(jwt).split('.');
    if (parts.length !== 3) return { verified: false };
    const header = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    const verified = crypto
        .createVerify('SHA256')
        .update(parts[0] + '.' + parts[1])
        .verify({ key: EC.publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(parts[2], 'base64url'));
    return { header, payload, verified };
}

// A plaintext HTTP/2 (h2c) mock APNs server. Records each request's headers +
// body and lets a per-call responder set the :status / reason.
function startFakeApns() {
    const state = { requests: [], responder: null };
    const server = http2.createServer();
    server.on('stream', (stream, headers) => {
        let body = '';
        stream.setEncoding('utf8');
        stream.on('data', (c) => { body += c; });
        stream.on('error', () => { /* client cancel/timeout — ignore */ });
        stream.on('end', () => {
            const rec = {
                path: headers[':path'],
                method: headers[':method'],
                authorization: headers['authorization'] || '',
                topic: headers['apns-topic'],
                pushType: headers['apns-push-type'],
                priority: headers['apns-priority'],
                expiration: headers['apns-expiration'],
                body,
            };
            state.requests.push(rec);
            const n = state.requests.length;
            if (state.responder) { try { state.responder(n, stream, rec); } catch (e) { /* noop */ } return; }
            try { stream.respond({ ':status': 200 }); stream.end(); } catch (e) { /* noop */ }
        });
    });
    return new Promise((resolve) => {
        server.listen(0, '127.0.0.1', () => {
            const port = server.address().port;
            resolve({
                state,
                authority: 'http://127.0.0.1:' + port,
                close: () => new Promise((r) => server.close(r)),
            });
        });
    });
}

function respondJson(stream, status, obj) {
    try {
        stream.respond({ ':status': status, 'content-type': 'application/json' });
        stream.end(obj ? JSON.stringify(obj) : '');
    } catch (e) { /* noop */ }
}

function makeTransport(fake, extra) {
    return new push.ApnsTransport(Object.assign({
        p8: EC.privateKey,
        keyId: KEY_ID, teamId: TEAM_ID, topic: TOPIC,
        productionHost: fake.authority,
        sandboxHost: fake.authority,
    }, extra || {}));
}

// A logger that records every level's calls, for the token-free-logging asserts.
function capturingLogger() {
    const calls = { warn: [], log: [], error: [], info: [], critical: [], output: [], debug: [], trace: [] };
    const mk = (lvl) => (...args) => { calls[lvl].push(args.map(String).join(' ')); };
    return {
        warn: mk('warn'), log: mk('log'), error: mk('error'), info: mk('info'),
        critical: mk('critical'), output: mk('output'), debug: mk('debug'), trace: mk('trace'),
        calls,
        all: () => Object.keys(calls).reduce((acc, k) => acc.concat(calls[k]), []),
    };
}

// ── config wiring ──────────────────────────────────────────────────────────

test('loadConfig(apns) without the .p8 + identifiers throws an actionable error', () => {
    assert.throws(
        () => push.loadConfig({ TYO_MQ_PUSH_TRANSPORT: 'apns' }),
        /TYO_MQ_PUSH_APNS_KEY/,
    );
});

test('loadConfig wires ApnsTransport from the APNs env vars', () => {
    const file = path.join(os.tmpdir(), 'apns-key-' + process.pid + '.p8');
    fs.writeFileSync(file, EC.privateKey);
    try {
        const cfg = push.loadConfig({
            TYO_MQ_PUSH_TRANSPORT: 'apns',
            TYO_MQ_PUSH_APNS_KEY: file,
            TYO_MQ_PUSH_APNS_KEY_ID: KEY_ID,
            TYO_MQ_PUSH_APNS_TEAM_ID: TEAM_ID,
            TYO_MQ_PUSH_APNS_TOPIC: TOPIC,
        });
        assert.strictEqual(cfg.transportName, 'apns');
        assert.ok(cfg.transport instanceof push.ApnsTransport);
        assert.strictEqual(cfg.transport.defaultEnv, 'production'); // default
    } finally { fs.unlinkSync(file); }
});

test('loadConfig rejects a non-EC key file', () => {
    const rsa = crypto.generateKeyPairSync('rsa', {
        modulusLength: 2048,
        privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
        publicKeyEncoding: { type: 'spki', format: 'pem' },
    });
    const file = path.join(os.tmpdir(), 'apns-rsa-' + process.pid + '.p8');
    fs.writeFileSync(file, rsa.privateKey);
    try {
        assert.throws(
            () => push.loadConfig({
                TYO_MQ_PUSH_TRANSPORT: 'apns',
                TYO_MQ_PUSH_APNS_KEY: file,
                TYO_MQ_PUSH_APNS_KEY_ID: KEY_ID,
                TYO_MQ_PUSH_APNS_TEAM_ID: TEAM_ID,
                TYO_MQ_PUSH_APNS_TOPIC: TOPIC,
            }),
            /EC/,
        );
    } finally { fs.unlinkSync(file); }
});

test('loadConfig rejects an invalid TYO_MQ_PUSH_APNS_ENV', () => {
    const file = path.join(os.tmpdir(), 'apns-key-env-' + process.pid + '.p8');
    fs.writeFileSync(file, EC.privateKey);
    try {
        assert.throws(
            () => push.loadConfig({
                TYO_MQ_PUSH_TRANSPORT: 'apns',
                TYO_MQ_PUSH_APNS_KEY: file,
                TYO_MQ_PUSH_APNS_KEY_ID: KEY_ID,
                TYO_MQ_PUSH_APNS_TEAM_ID: TEAM_ID,
                TYO_MQ_PUSH_APNS_TOPIC: TOPIC,
                TYO_MQ_PUSH_APNS_ENV: 'staging',
            }),
            /must be "production" or "sandbox"/,
        );
    } finally { fs.unlinkSync(file); }
});

// ── request shape ──────────────────────────────────────────────────────────

test('send() POSTs a contentless background wake with a verified ES256 provider JWT', async () => {
    const fake = await startFakeApns();
    try {
        const t = makeTransport(fake);
        const r = await t.send({ transport: 'apns', token: 'abc123deadbeef' });
        assert.deepStrictEqual(r, { ok: true });
        assert.strictEqual(fake.state.requests.length, 1);
        const req = fake.state.requests[0];
        assert.strictEqual(req.method, 'POST');
        assert.strictEqual(req.path, '/3/device/abc123deadbeef');
        assert.strictEqual(req.topic, TOPIC);
        assert.strictEqual(req.pushType, 'background');
        assert.strictEqual(req.priority, '5');
        assert.strictEqual(req.expiration, '0');
        assert.ok(/^bearer /.test(req.authorization), 'authorization must be a bearer token');
        // the provider JWT verifies against the EC public key
        const jwt = req.authorization.slice('bearer '.length);
        const v = verifyJwt(jwt);
        assert.strictEqual(v.verified, true, 'provider JWT must verify against the EC key');
        assert.strictEqual(v.header.alg, 'ES256');
        assert.strictEqual(v.header.kid, KEY_ID);
        assert.strictEqual(v.payload.iss, TEAM_ID);
        assert.ok(typeof v.payload.iat === 'number');
        // body is a contentless silent wake: {"aps":{"content-available":1}}
        const body = JSON.parse(req.body);
        assert.deepStrictEqual(body, { aps: { 'content-available': 1 } });
        assert.deepStrictEqual(Object.keys(body), ['aps']);
        assert.deepStrictEqual(Object.keys(body.aps), ['content-available']);
        // nothing forbidden / no alert or sound
        assert.strictEqual(body.aps.alert, undefined);
        assert.strictEqual(body.aps.sound, undefined);
        push.FORBIDDEN_WAKE_KEYS.forEach((k) => assert.ok(!(k in body) && !(k in body.aps), 'wake leaked ' + k));
    } finally { await fake.close(); }
});

// ── JWT caching ────────────────────────────────────────────────────────────

test('the provider JWT is signed ONCE and reused across many sends', async () => {
    const fake = await startFakeApns();
    try {
        const t = makeTransport(fake);
        await t.send({ transport: 'apns', token: 'tok-1' });
        await t.send({ transport: 'apns', token: 'tok-2' });
        await t.send({ transport: 'apns', token: 'tok-3' });
        assert.strictEqual(t._signCount, 1, 'one signing for three sends');
        assert.strictEqual(fake.state.requests.length, 3);
        const auths = fake.state.requests.map((r) => r.authorization);
        assert.ok(auths.every((a) => a === auths[0]), 'the same JWT is reused across sends');
    } finally { await fake.close(); }
});

test('the provider JWT is re-signed after the refresh interval elapses', async () => {
    const fake = await startFakeApns();
    try {
        const t = makeTransport(fake, { refreshMs: 40 * 60 * 1000 });
        await t.send({ transport: 'apns', token: 'tok-1' });
        assert.strictEqual(t._signCount, 1);
        // age the cached token past the refresh window
        t._jwt.mintedAtMs = Date.now() - (41 * 60 * 1000);
        await t.send({ transport: 'apns', token: 'tok-2' });
        assert.strictEqual(t._signCount, 2, 'a stale token is re-signed on the next send');
    } finally { await fake.close(); }
});

// ── env routing ────────────────────────────────────────────────────────────

test('an endpoint routes to the sandbox host or the production host by env', async () => {
    const prod = await startFakeApns();
    const sandbox = await startFakeApns();
    try {
        const t = new push.ApnsTransport({
            p8: EC.privateKey, keyId: KEY_ID, teamId: TEAM_ID, topic: TOPIC,
            defaultEnv: 'production',
            productionHost: prod.authority,
            sandboxHost: sandbox.authority,
        });
        await t.send({ transport: 'apns', token: 'sand-tok', env: 'sandbox' });
        await t.send({ transport: 'apns', token: 'prod-tok', env: 'production' });
        await t.send({ transport: 'apns', token: 'default-tok' }); // no env -> default (production)
        assert.strictEqual(sandbox.state.requests.length, 1, 'sandbox host got the sandbox endpoint');
        assert.strictEqual(sandbox.state.requests[0].path, '/3/device/sand-tok');
        assert.strictEqual(prod.state.requests.length, 2, 'production host got the production + default endpoints');
        assert.deepStrictEqual(prod.state.requests.map((r) => r.path).sort(),
            ['/3/device/default-tok', '/3/device/prod-tok']);
    } finally { await prod.close(); await sandbox.close(); }
});

// ── classification ─────────────────────────────────────────────────────────

test('410 Unregistered maps to { ok:false, gone:true } (prune the device token)', async () => {
    const fake = await startFakeApns();
    fake.state.responder = (n, stream) => respondJson(stream, 410, { reason: 'Unregistered' });
    try {
        const t = makeTransport(fake);
        const r = await t.send({ transport: 'apns', token: 'dead-token' });
        assert.deepStrictEqual(r, { ok: false, gone: true });
    } finally { await fake.close(); }
});

test('400 BadDeviceToken maps to { ok:false, gone:true }', async () => {
    const fake = await startFakeApns();
    fake.state.responder = (n, stream) => respondJson(stream, 400, { reason: 'BadDeviceToken' });
    try {
        const t = makeTransport(fake);
        const r = await t.send({ transport: 'apns', token: 'bogus-token' });
        assert.deepStrictEqual(r, { ok: false, gone: true });
    } finally { await fake.close(); }
});

test('400 DeviceTokenNotForTopic maps to { ok:false, gone:true }', async () => {
    const fake = await startFakeApns();
    fake.state.responder = (n, stream) => respondJson(stream, 400, { reason: 'DeviceTokenNotForTopic' });
    try {
        const t = makeTransport(fake);
        const r = await t.send({ transport: 'apns', token: 'wrong-topic-token' });
        assert.deepStrictEqual(r, { ok: false, gone: true });
    } finally { await fake.close(); }
});

test('403 ExpiredProviderToken maps to { ok:false } (NOT gone) and re-signs on the next send', async () => {
    const fake = await startFakeApns();
    fake.state.responder = (n, stream) => {
        if (n === 1) return respondJson(stream, 403, { reason: 'ExpiredProviderToken' });
        return respondJson(stream, 200, null);
    };
    const cap = capturingLogger();
    try {
        const t = makeTransport(fake, { logger: cap });
        const first = await t.send({ transport: 'apns', token: 'device-token-secret-xyz' });
        assert.deepStrictEqual(first, { ok: false }, 'expired provider token is transient, NOT gone');
        assert.strictEqual(t._signCount, 1);
        // a token-free auth warn was emitted
        assert.ok(cap.calls.warn.some((w) => /transport=apns/.test(w) && /reason=auth/.test(w)),
            'expected a token-free auth warn: ' + JSON.stringify(cap.calls.warn));
        // the next send re-signs (cached JWT was invalidated) and succeeds
        const second = await t.send({ transport: 'apns', token: 'device-token-secret-xyz' });
        assert.deepStrictEqual(second, { ok: true });
        assert.strictEqual(t._signCount, 2, 'the cached JWT was invalidated and re-signed');
    } finally { await fake.close(); }
});

test('403 InvalidProviderToken maps to { ok:false } and does NOT re-sign (creds bug, retain JWT)', async () => {
    const fake = await startFakeApns();
    fake.state.responder = (n, stream) => respondJson(stream, 403, { reason: 'InvalidProviderToken' });
    try {
        const t = makeTransport(fake);
        const r1 = await t.send({ transport: 'apns', token: 'tok-1' });
        const r2 = await t.send({ transport: 'apns', token: 'tok-2' });
        assert.deepStrictEqual(r1, { ok: false });
        assert.deepStrictEqual(r2, { ok: false });
        assert.strictEqual(t._signCount, 1, 'a non-expired provider-token error retains the cached JWT');
    } finally { await fake.close(); }
});

test('503 maps to { ok:false } (transient — token retained)', async () => {
    const fake = await startFakeApns();
    fake.state.responder = (n, stream) => respondJson(stream, 503, { reason: 'ServiceUnavailable' });
    try {
        const t = makeTransport(fake);
        const r = await t.send({ transport: 'apns', token: 'tok-1' });
        assert.deepStrictEqual(r, { ok: false });
    } finally { await fake.close(); }
});

test('an unreachable APNs host maps to { ok:false } (never throws)', async () => {
    const fake = await startFakeApns();
    await fake.close(); // port now dead
    const t = makeTransport(fake, { timeoutMs: 500 });
    const r = await t.send({ transport: 'apns', token: 'tok-1' });
    assert.deepStrictEqual(r, { ok: false });
});

// ── token-free logging ───────────────────────────────────────────────────────

test('no log line ever contains the device token, the provider JWT, or the key', async () => {
    const fake = await startFakeApns();
    fake.state.responder = (n, stream) => respondJson(stream, 403, { reason: 'BadEnvironmentKeyInToken' });
    const cap = capturingLogger();
    try {
        const t = makeTransport(fake, { logger: cap });
        await t.send({ transport: 'apns', token: 'DEVICE_TOKEN_MUST_NOT_LEAK' });
        const jwt = fake.state.requests[0].authorization.slice('bearer '.length);
        assert.ok(cap.calls.warn.some((w) => /transport=apns/.test(w) && /reason=auth/.test(w)),
            'expected a token-free auth warn');
        cap.all().forEach((line) => {
            assert.ok(line.indexOf('DEVICE_TOKEN_MUST_NOT_LEAK') < 0, 'log leaked the device token: ' + line);
            assert.ok(line.indexOf(jwt) < 0, 'log leaked the provider JWT: ' + line);
            assert.ok(line.indexOf('BEGIN') < 0, 'log leaked key material: ' + line);
        });
    } finally { await fake.close(); }
});

// ── OPT-IN real smoke (skipped in CI) ────────────────────────────────────────
// Signs with the REAL local .p8 and hits the APNs SANDBOX host with a dummy
// device token; APNs answers 400 BadDeviceToken, which our classifier maps to
// gone — proving the ES256 auth + HTTP/2 reachability end-to-end. Skipped when
// the .p8 is absent or APNS_REAL_SMOKE!=1 so CI stays green. Set APNS_REAL_SMOKE=1.
const REAL_P8 = path.join(os.homedir(), '.config', 'tyo-mq', 'hilia', 'AuthKey_' + KEY_ID + '.p8');
if (process.env.APNS_REAL_SMOKE === '1' && fs.existsSync(REAL_P8)) {
    test('[real smoke] signs with the local .p8 and reaches APNs sandbox', async () => {
        const t = new push.ApnsTransport({
            p8: REAL_P8, keyId: KEY_ID, teamId: TEAM_ID, topic: TOPIC, defaultEnv: 'sandbox',
        });
        const r = await t.send({ transport: 'apns', token: '0'.repeat(64), env: 'sandbox' });
        // A dummy token on a reachable, authenticated channel is rejected as gone
        // (400 BadDeviceToken). A transient {ok:false} would signal auth/reach trouble.
        assert.strictEqual(r.ok, false);
        assert.strictEqual(r.gone, true, 'expected APNs to reject the dummy token as gone: ' + JSON.stringify(r));
    });
} else {
    test('[real smoke] skipped (no .p8 or APNS_REAL_SMOKE!=1)', () => { /* intentional skip */ });
}

run();
