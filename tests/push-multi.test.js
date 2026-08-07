'use strict';
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { test, run } = require('./runner');
const push = require('../lib/push');

// ── helpers ────────────────────────────────────────────────────────────────
// Real keypairs so createTransport's own credential validation (RSA SA for
// fcm, EC .p8 for apns) accepts the generated test files, mirroring
// push-fcm.test.js / push-apns.test.js.

const RSA = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});
const EC = crypto.generateKeyPairSync('ec', {
    namedCurve: 'P-256',
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

const APNS_KEY_ID = 'YU4YDV365T';
const APNS_TEAM_ID = 'GR4ZBUUW77';
const APNS_TOPIC = 'au.com.tyo.hilia';

// Write the fcm SA JSON + apns .p8 to temp files and return { env, cleanup }
// with the env vars a full fcm,apns,unifiedpush config needs.
function multiEnv(transportsCsv) {
    const saFile = path.join(os.tmpdir(), 'push-multi-fcm-' + process.pid + '-' + Math.random().toString(36).slice(2) + '.json');
    const p8File = path.join(os.tmpdir(), 'push-multi-apns-' + process.pid + '-' + Math.random().toString(36).slice(2) + '.p8');
    fs.writeFileSync(saFile, JSON.stringify({
        type: 'service_account',
        project_id: 'proj-under-test',
        client_email: 'fcm-broker@proj-under-test.iam.gserviceaccount.com',
        private_key: RSA.privateKey,
        token_uri: 'https://oauth2.googleapis.com/token',
    }));
    fs.writeFileSync(p8File, EC.privateKey);
    return {
        env: {
            TYO_MQ_PUSH_TRANSPORT: transportsCsv,
            TYO_MQ_PUSH_FCM_CREDENTIALS: saFile,
            TYO_MQ_PUSH_APNS_KEY: p8File,
            TYO_MQ_PUSH_APNS_KEY_ID: APNS_KEY_ID,
            TYO_MQ_PUSH_APNS_TEAM_ID: APNS_TEAM_ID,
            TYO_MQ_PUSH_APNS_TOPIC: APNS_TOPIC,
        },
        cleanup: () => { try { fs.unlinkSync(saFile); } catch (e) {} try { fs.unlinkSync(p8File); } catch (e) {} },
    };
}

// ── multi-transport loads ───────────────────────────────────────────────────

test('loadConfig builds ALL of fcm,apns,unifiedpush from a comma-separated list', () => {
    const m = multiEnv('fcm,apns,unifiedpush');
    try {
        const cfg = push.loadConfig(m.env);
        assert.ok(push.isConfigured(cfg), 'multi-transport config must be configured');
        assert.deepStrictEqual(cfg.transportNames, ['fcm', 'apns', 'unifiedpush']);
        // each name resolves to the right transport instance
        assert.ok(push.transportFor(cfg, 'fcm') instanceof push.FcmTransport);
        assert.ok(push.transportFor(cfg, 'apns') instanceof push.ApnsTransport);
        assert.ok(push.transportFor(cfg, 'unifiedpush') instanceof push.UnifiedPushTransport);
        // a name not in the map -> null (prototype-pollution-safe lookup)
        assert.strictEqual(push.transportFor(cfg, 'null'), null);
        assert.strictEqual(push.transportFor(cfg, '__proto__'), null);
        assert.strictEqual(push.transportFor(cfg, 'hasOwnProperty'), null);
    } finally { m.cleanup(); }
});

test('loadConfig tolerates whitespace and empty entries in the list', () => {
    const m = multiEnv('  fcm , , apns ,unifiedpush,');
    try {
        const cfg = push.loadConfig(m.env);
        assert.deepStrictEqual(cfg.transportNames, ['fcm', 'apns', 'unifiedpush']);
        assert.ok(push.transportFor(cfg, 'apns') instanceof push.ApnsTransport);
    } finally { m.cleanup(); }
});

test('multi-transport allowLocal reflects the unifiedpush transport', () => {
    const on = multiEnv('fcm,unifiedpush');
    on.env.TYO_MQ_PUSH_ALLOW_LOCAL = '1';
    try {
        const cfg = push.loadConfig(on.env);
        assert.strictEqual(cfg.allowLocal, true, 'unifiedpush allowLocal should surface on the config');
    } finally { on.cleanup(); }
    const off = multiEnv('fcm,unifiedpush');   // no ALLOW_LOCAL
    try {
        const cfg = push.loadConfig(off.env);
        assert.strictEqual(cfg.allowLocal, false);
    } finally { off.cleanup(); }
    // no unifiedpush at all -> allowLocal false
    const noUp = multiEnv('fcm,apns');
    noUp.env.TYO_MQ_PUSH_ALLOW_LOCAL = '1';
    try {
        const cfg = push.loadConfig(noUp.env);
        assert.strictEqual(cfg.allowLocal, false, 'allowLocal must be false when no unifiedpush transport is present');
    } finally { noUp.cleanup(); }
});

// ── routing ──────────────────────────────────────────────────────────────────

test('fireWake routes each endpoint to its matching transport in a multi-transport config', async () => {
    // Injected mock transports keyed by name (NullTransport records send()).
    const up = new push.NullTransport();
    const fcm = new push.NullTransport();
    const cfg = {
        transports: { unifiedpush: up, fcm: fcm },
        transportNames: ['unifiedpush', 'fcm'],
        allowLocal: false,
    };
    assert.ok(push.isConfigured(cfg));

    const reg = new push.TokenRegistry();
    reg.register('r', 'bob', { transport: 'unifiedpush', token: 'https://up.example/wake' });
    reg.register('r', 'bob', { transport: 'fcm', token: 'fcm-device-token' });

    const res = await push.fireWake(cfg, reg, 'r', 'bob', { now: 1000, coalesceWindowMs: 30000 });
    assert.strictEqual(res.sent, 2);
    // the unifiedpush endpoint went ONLY through the unifiedpush transport
    assert.strictEqual(up.sent.length, 1);
    assert.strictEqual(up.sent[0].token, 'https://up.example/wake');
    assert.strictEqual(up.sent[0].transport, 'unifiedpush');
    // the fcm endpoint went ONLY through the fcm transport
    assert.strictEqual(fcm.sent.length, 1);
    assert.strictEqual(fcm.sent[0].token, 'fcm-device-token');
    assert.strictEqual(fcm.sent[0].transport, 'fcm');
});

test('fireWake does NOT wake an endpoint whose transport is not configured', async () => {
    const fcm = new push.NullTransport();
    const cfg = { transports: { fcm: fcm }, transportNames: ['fcm'], allowLocal: false };
    const reg = new push.TokenRegistry();
    reg.register('r', 'bob', { transport: 'fcm', token: 'fcm-tok' });
    reg.register('r', 'bob', { transport: 'apns', token: 'apns-tok' });   // no apns transport
    const res = await push.fireWake(cfg, reg, 'r', 'bob', { now: 1000, coalesceWindowMs: 30000 });
    assert.strictEqual(res.sent, 2);   // endpoints attempted
    assert.strictEqual(fcm.sent.length, 1, 'only the fcm endpoint was delivered');
    assert.strictEqual(fcm.sent[0].token, 'fcm-tok');
});

// ── single-transport unchanged (backward-compat) ─────────────────────────────

test('single-transport unifiedpush still loads exactly as before', () => {
    const cfg = push.loadConfig({ TYO_MQ_PUSH_TRANSPORT: 'unifiedpush', TYO_MQ_PUSH_ALLOW_LOCAL: '1' });
    assert.ok(push.isConfigured(cfg));
    assert.deepStrictEqual(cfg.transportNames, ['unifiedpush']);
    assert.ok(push.transportFor(cfg, 'unifiedpush') instanceof push.UnifiedPushTransport);
    assert.strictEqual(cfg.allowLocal, true);
    // backward-compat single-transport aliases still present
    assert.strictEqual(cfg.transportName, 'unifiedpush');
    assert.ok(cfg.transport instanceof push.UnifiedPushTransport);
});

test('single-transport null still loads exactly as before', () => {
    const cfg = push.loadConfig({ TYO_MQ_PUSH_TRANSPORT: 'null' });
    assert.ok(push.isConfigured(cfg));
    assert.deepStrictEqual(cfg.transportNames, ['null']);
    assert.ok(push.transportFor(cfg, 'null') instanceof push.NullTransport);
    assert.strictEqual(push.transportFor(cfg, 'fcm'), null);
    assert.strictEqual(cfg.allowLocal, false);
});

test('unset TYO_MQ_PUSH_TRANSPORT -> null (feature OFF)', () => {
    assert.strictEqual(push.loadConfig({}), null);
    assert.strictEqual(push.loadConfig({ TYO_MQ_PUSH_TRANSPORT: '' }), null);
    assert.strictEqual(push.loadConfig({ TYO_MQ_PUSH_TRANSPORT: '  , ,' }), null);
    assert.strictEqual(push.isConfigured(null), false);
    assert.strictEqual(push.isConfigured({ transports: {} }), false);
});

// ── fail-loud ─────────────────────────────────────────────────────────────────

test('an unknown name anywhere in the list throws (fail loud)', () => {
    assert.throws(
        () => push.loadConfig({ TYO_MQ_PUSH_TRANSPORT: 'unifiedpush,bogus' }),
        /unknown push transport/,
    );
    assert.throws(
        () => push.loadConfig({ TYO_MQ_PUSH_TRANSPORT: 'bogus,null' }),
        /unknown push transport/,
    );
});

test('a listed transport with missing credentials throws (fail loud)', () => {
    // fcm requested but no TYO_MQ_PUSH_FCM_CREDENTIALS
    assert.throws(
        () => push.loadConfig({ TYO_MQ_PUSH_TRANSPORT: 'unifiedpush,fcm' }),
        /TYO_MQ_PUSH_FCM_CREDENTIALS/,
    );
    // apns requested but no .p8 / identifiers
    assert.throws(
        () => push.loadConfig({ TYO_MQ_PUSH_TRANSPORT: 'unifiedpush,apns' }),
        /TYO_MQ_PUSH_APNS_KEY/,
    );
});

run();
