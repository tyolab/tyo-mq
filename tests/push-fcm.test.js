'use strict';
const assert = require('assert');
const crypto = require('crypto');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { test, run } = require('./runner');
const push = require('../lib/push');

// ── helpers ────────────────────────────────────────────────────────────────

// A real RSA keypair so the JWT-bearer assertion the transport signs can be
// VERIFIED (not just observed) by the fake token endpoint.
const KEYPAIR = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

function serviceAccount(tokenUrl) {
    return {
        type: 'service_account',
        project_id: 'proj-under-test',
        client_email: 'fcm-broker@proj-under-test.iam.gserviceaccount.com',
        private_key: KEYPAIR.privateKey,
        token_uri: tokenUrl,
    };
}

// Fake Google: serves BOTH the OAuth token endpoint (POST /token) and the FCM
// v1 send endpoint (POST /v1/projects/<id>/messages:send). Records requests
// and lets a test script per-call send responses.
function startFakeGoogle() {
    const state = {
        tokenRequests: [],       // { grant_type, assertion, claims, verified }
        sendRequests: [],        // { auth, body, path }
        sendResponder: null,     // (req#, res) -> void  (default 200 {name})
        tokenLifetimeSec: 3600,
    };
    const server = http.createServer((req, res) => {
        let raw = '';
        req.on('data', (c) => { raw += c; });
        req.on('end', () => {
            if (req.url === '/token') {
                const params = new URLSearchParams(raw);
                const assertion = params.get('assertion') || '';
                const parts = assertion.split('.');
                let claims = null, verified = false;
                if (parts.length === 3) {
                    claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
                    verified = crypto
                        .createVerify('RSA-SHA256')
                        .update(parts[0] + '.' + parts[1])
                        .verify(KEYPAIR.publicKey, Buffer.from(parts[2], 'base64url'));
                }
                state.tokenRequests.push({
                    grant_type: params.get('grant_type'),
                    assertion, claims, verified,
                });
                res.writeHead(200, { 'content-type': 'application/json' });
                res.end(JSON.stringify({
                    access_token: 'fake-access-token-' + state.tokenRequests.length,
                    token_type: 'Bearer',
                    expires_in: state.tokenLifetimeSec,
                }));
                return;
            }
            if (/^\/v1\/projects\/[^/]+\/messages:send$/.test(req.url)) {
                const record = {
                    auth: req.headers.authorization || '',
                    path: req.url,
                    body: raw ? JSON.parse(raw) : null,
                };
                state.sendRequests.push(record);
                if (state.sendResponder)
                    return state.sendResponder(state.sendRequests.length, res);
                res.writeHead(200, { 'content-type': 'application/json' });
                res.end(JSON.stringify({ name: 'projects/proj-under-test/messages/fake' }));
                return;
            }
            res.writeHead(500);
            res.end('unexpected path ' + req.url);
        });
    });
    return new Promise((resolve) => {
        server.listen(0, '127.0.0.1', () => {
            const port = server.address().port;
            resolve({
                state,
                base: 'http://127.0.0.1:' + port,
                close: () => new Promise((r) => server.close(r)),
            });
        });
    });
}

function makeTransport(fake, extra) {
    return new push.FcmTransport(Object.assign({
        serviceAccount: serviceAccount(fake.base + '/token'),
        fcmBaseUrl: fake.base,   // TEST-ONLY override (prod default: https://fcm.googleapis.com)
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

test('createTransport(fcm) without a credentials file throws an actionable error', () => {
    assert.throws(
        () => push.loadConfig({ TYO_MQ_PUSH_TRANSPORT: 'fcm' }),
        /TYO_MQ_PUSH_FCM_CREDENTIALS/,
    );
});

test('loadConfig wires FcmTransport from TYO_MQ_PUSH_FCM_CREDENTIALS', () => {
    const file = path.join(os.tmpdir(), 'fcm-key-' + process.pid + '.json');
    fs.writeFileSync(file, JSON.stringify(serviceAccount('https://oauth2.googleapis.com/token')));
    try {
        const cfg = push.loadConfig({
            TYO_MQ_PUSH_TRANSPORT: 'fcm',
            TYO_MQ_PUSH_FCM_CREDENTIALS: file,
        });
        assert.strictEqual(cfg.transportName, 'fcm');
        assert.ok(cfg.transport instanceof push.FcmTransport);
    } finally { fs.unlinkSync(file); }
});

test('loadConfig rejects a credentials file missing required fields', () => {
    const file = path.join(os.tmpdir(), 'fcm-bad-key-' + process.pid + '.json');
    fs.writeFileSync(file, JSON.stringify({ type: 'service_account', project_id: 'p' })); // no key/email
    try {
        assert.throws(
            () => push.loadConfig({ TYO_MQ_PUSH_TRANSPORT: 'fcm', TYO_MQ_PUSH_FCM_CREDENTIALS: file }),
            /client_email|private_key/,
        );
    } finally { fs.unlinkSync(file); }
});

test('loadConfig rejects a credentials file that is not a service_account', () => {
    const file = path.join(os.tmpdir(), 'fcm-wrong-type-' + process.pid + '.json');
    fs.writeFileSync(file, JSON.stringify({ type: 'authorized_user', client_email: 'x', private_key: 'y', project_id: 'p' }));
    try {
        assert.throws(
            () => push.loadConfig({ TYO_MQ_PUSH_TRANSPORT: 'fcm', TYO_MQ_PUSH_FCM_CREDENTIALS: file }),
            /service_account/,
        );
    } finally { fs.unlinkSync(file); }
});

// ── OAuth JWT-bearer flow ──────────────────────────────────────────────────

test('send() mints an OAuth token via a signed JWT-bearer assertion', async () => {
    const fake = await startFakeGoogle();
    try {
        const t = makeTransport(fake);
        const r = await t.send({ transport: 'fcm', token: 'device-token-1' });
        assert.deepStrictEqual(r, { ok: true });
        assert.strictEqual(fake.state.tokenRequests.length, 1);
        const tok = fake.state.tokenRequests[0];
        assert.strictEqual(tok.grant_type, 'urn:ietf:params:oauth:grant-type:jwt-bearer');
        assert.strictEqual(tok.verified, true, 'assertion must verify against the SA public key');
        assert.strictEqual(tok.claims.iss, 'fcm-broker@proj-under-test.iam.gserviceaccount.com');
        assert.strictEqual(tok.claims.scope, 'https://www.googleapis.com/auth/firebase.messaging');
        assert.ok(tok.claims.exp > tok.claims.iat, 'exp must be after iat');
    } finally { await fake.close(); }
});

test('the access token is cached across sends (one token request for two sends)', async () => {
    const fake = await startFakeGoogle();
    try {
        const t = makeTransport(fake);
        await t.send({ transport: 'fcm', token: 'device-token-1' });
        await t.send({ transport: 'fcm', token: 'device-token-2' });
        assert.strictEqual(fake.state.tokenRequests.length, 1);
        assert.strictEqual(fake.state.sendRequests.length, 2);
    } finally { await fake.close(); }
});

test('an expired access token is re-minted on the next send', async () => {
    const fake = await startFakeGoogle();
    fake.state.tokenLifetimeSec = 1; // expires (inside the refresh margin) immediately
    try {
        const t = makeTransport(fake);
        await t.send({ transport: 'fcm', token: 'device-token-1' });
        await t.send({ transport: 'fcm', token: 'device-token-2' });
        assert.strictEqual(fake.state.tokenRequests.length, 2);
    } finally { await fake.close(); }
});

// ── send shape ─────────────────────────────────────────────────────────────

test('the wake is a data-only high-priority message to the SA project', async () => {
    const fake = await startFakeGoogle();
    try {
        const t = makeTransport(fake);
        await t.send({ transport: 'fcm', token: 'device-token-1' });
        const sent = fake.state.sendRequests[0];
        assert.strictEqual(sent.path, '/v1/projects/proj-under-test/messages:send');
        assert.strictEqual(sent.auth, 'Bearer fake-access-token-1');
        const msg = sent.body.message;
        assert.strictEqual(msg.token, 'device-token-1');
        assert.strictEqual(msg.android.priority, 'HIGH');
        assert.strictEqual(msg.notification, undefined, 'wake must be data-only (no notification)');
        // Contentless payload, FCM data values must be strings.
        assert.deepStrictEqual(msg.data, { type: 'wake', v: '1' });
        Object.values(msg.data).forEach((v) => assert.strictEqual(typeof v, 'string'));
    } finally { await fake.close(); }
});

// ── result contract (matches fireWake's expectations) ──────────────────────

test('404 UNREGISTERED maps to { ok:false, gone:true } so the token is pruned', async () => {
    const fake = await startFakeGoogle();
    fake.state.sendResponder = (n, res) => {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { status: 'NOT_FOUND', message: 'Requested entity was not found.' } }));
    };
    try {
        const t = makeTransport(fake);
        const r = await t.send({ transport: 'fcm', token: 'dead-token' });
        assert.deepStrictEqual(r, { ok: false, gone: true });
    } finally { await fake.close(); }
});

test('400 INVALID_ARGUMENT (bad device token) maps to { ok:false, gone:true }', async () => {
    const fake = await startFakeGoogle();
    fake.state.sendResponder = (n, res) => {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: {
            status: 'INVALID_ARGUMENT',
            message: 'The registration token is not a valid FCM registration token',
            details: [{ '@type': 'type.googleapis.com/google.firebase.fcm.v1.FcmError', errorCode: 'INVALID_ARGUMENT' }],
        } }));
    };
    try {
        const t = makeTransport(fake);
        const r = await t.send({ transport: 'fcm', token: 'bogus-token' });
        assert.deepStrictEqual(r, { ok: false, gone: true });
    } finally { await fake.close(); }
});

test('401 (bad broker creds) maps to { ok:false } NOT gone, and warns token-free', async () => {
    const fake = await startFakeGoogle();
    fake.state.sendResponder = (n, res) => {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { status: 'UNAUTHENTICATED', message: 'Request had invalid authentication credentials.' } }));
    };
    const cap = capturingLogger();
    try {
        const t = makeTransport(fake, { logger: cap });
        const r = await t.send({ transport: 'fcm', token: 'device-token-secret-xyz' });
        assert.deepStrictEqual(r, { ok: false });   // NOT gone — do not prune the device token
        // a token-free auth warn was emitted...
        assert.ok(cap.calls.warn.some((w) => /transport=fcm/.test(w) && /reason=auth/.test(w)),
            'expected a token-free auth warn: ' + JSON.stringify(cap.calls.warn));
        // ...and NO log line at any level leaks the device token or the access token.
        cap.all().forEach((line) => {
            assert.ok(line.indexOf('device-token-secret-xyz') < 0, 'log leaked the device token: ' + line);
            assert.ok(!/fake-access-token/.test(line), 'log leaked the access token: ' + line);
        });
    } finally { await fake.close(); }
});

test('403 (permission denied) maps to { ok:false } NOT gone', async () => {
    const fake = await startFakeGoogle();
    fake.state.sendResponder = (n, res) => {
        res.writeHead(403, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { status: 'PERMISSION_DENIED', message: 'The caller does not have permission' } }));
    };
    try {
        const t = makeTransport(fake);
        const r = await t.send({ transport: 'fcm', token: 'device-token-1' });
        assert.deepStrictEqual(r, { ok: false });
    } finally { await fake.close(); }
});

test('5xx maps to { ok:false } (transient — token retained)', async () => {
    const fake = await startFakeGoogle();
    fake.state.sendResponder = (n, res) => { res.writeHead(503); res.end(); };
    try {
        const t = makeTransport(fake);
        const r = await t.send({ transport: 'fcm', token: 'device-token-1' });
        assert.deepStrictEqual(r, { ok: false });
    } finally { await fake.close(); }
});

test('an unreachable FCM endpoint maps to { ok:false } (never throws)', async () => {
    const fake = await startFakeGoogle();
    await fake.close(); // port now dead
    const t = makeTransport(fake, { timeoutMs: 500 });
    const r = await t.send({ transport: 'fcm', token: 'device-token-1' });
    assert.deepStrictEqual(r, { ok: false });
});

// ── OPT-IN real smoke (skipped in CI) ───────────────────────────────────────
// Exercises the REAL Google OAuth + FCM v1 endpoints with the local
// service-account credentials, if present. Uses a deliberately-bogus device
// token so nothing is ever delivered; a real send returns 404/400 (invalid
// token) which our classifier maps to gone — proving auth + API reachability
// end-to-end. Skipped entirely when the credentials file is absent so CI (and
// any machine without the creds) stays green. Set FCM_REAL_SMOKE=1 to run.
const REAL_CRED = path.join(os.homedir(), '.config', 'tyo-mq', 'fcm-service-account.json');
if (process.env.FCM_REAL_SMOKE === '1' && fs.existsSync(REAL_CRED)) {
    test('[real smoke] mints a token and reaches FCM v1 with the local creds', async () => {
        const sa = JSON.parse(fs.readFileSync(REAL_CRED, 'utf8'));
        const t = new push.FcmTransport({ serviceAccount: sa });
        const r = await t.send({ transport: 'fcm', token: 'DUMMY_INVALID_TOKEN_FOR_VALIDATION' });
        // Reaching FCM with a bogus token yields gone (404/400 invalid token).
        // A transient {ok:false} (no gone) would signal an auth/API problem.
        assert.strictEqual(r.ok, false);
        assert.strictEqual(r.gone, true, 'expected FCM to reject the bogus token as gone (auth+API OK): ' + JSON.stringify(r));
    });
} else {
    test('[real smoke] skipped (no creds file or FCM_REAL_SMOKE!=1)', () => { /* intentional skip */ });
}

run();
