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
// Multi-project FCM: the transport routes each send to the Firebase project that
// owns the token's app, keyed by endpoint.app_id, signing with THAT project's
// service account and caching its OAuth token independently. These tests use a
// DISTINCT RSA keypair per project so the fake token endpoint can prove WHICH
// service account signed the JWT-bearer assertion (not just observe it).

function genKeypair() {
    return crypto.generateKeyPairSync('rsa', {
        modulusLength: 2048,
        publicKeyEncoding: { type: 'spki', format: 'pem' },
        privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
}

// A named project: its own keypair, project_id and client_email.
function makeProject(name, tokenUrl) {
    const kp = genKeypair();
    return {
        name,
        keypair: kp,
        project_id: name + '-project',
        client_email: 'fcm-broker@' + name + '.iam.gserviceaccount.com',
        sa: {
            type: 'service_account',
            project_id: name + '-project',
            client_email: 'fcm-broker@' + name + '.iam.gserviceaccount.com',
            private_key: kp.privateKey,
            token_uri: tokenUrl,
        },
    };
}

// Fake Google shared by all projects. The token endpoint tries EACH registered
// project's public key to identify which SA signed the assertion; it records the
// verified issuer so a test can assert routing. Send endpoint records path+auth.
function startFakeGoogle(projects) {
    const state = {
        tokenRequests: [],       // { iss, verifiedProject, projectId }
        sendRequests: [],        // { auth, path, body }
        tokenCountByProject: {}, // project.name -> count
        sendResponder: null,
    };
    const server = http.createServer((req, res) => {
        let raw = '';
        req.on('data', (c) => { raw += c; });
        req.on('end', () => {
            if (req.url === '/token') {
                const params = new URLSearchParams(raw);
                const assertion = params.get('assertion') || '';
                const parts = assertion.split('.');
                const claims = parts.length === 3
                    ? JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'))
                    : null;
                // Identify which project's key verifies the signature.
                let verifiedProject = null;
                for (const p of projects) {
                    const ok = parts.length === 3 && crypto
                        .createVerify('RSA-SHA256')
                        .update(parts[0] + '.' + parts[1])
                        .verify(p.keypair.publicKey, Buffer.from(parts[2], 'base64url'));
                    if (ok) { verifiedProject = p; break; }
                }
                state.tokenRequests.push({
                    iss: claims && claims.iss,
                    verifiedProject: verifiedProject && verifiedProject.name,
                    projectId: verifiedProject && verifiedProject.project_id,
                });
                if (verifiedProject) {
                    state.tokenCountByProject[verifiedProject.name] =
                        (state.tokenCountByProject[verifiedProject.name] || 0) + 1;
                }
                res.writeHead(200, { 'content-type': 'application/json' });
                res.end(JSON.stringify({
                    // Token value carries the verified project so the send-side
                    // Bearer header reveals which project's token was used.
                    access_token: 'tok-' + (verifiedProject ? verifiedProject.name : 'unknown') +
                        '-' + state.tokenRequests.length,
                    token_type: 'Bearer',
                    expires_in: 3600,
                }));
                return;
            }
            if (/^\/v1\/projects\/[^/]+\/messages:send$/.test(req.url)) {
                state.sendRequests.push({
                    auth: req.headers.authorization || '',
                    path: req.url,
                    body: raw ? JSON.parse(raw) : null,
                });
                if (state.sendResponder)
                    return state.sendResponder(state.sendRequests.length, res);
                res.writeHead(200, { 'content-type': 'application/json' });
                res.end(JSON.stringify({ name: 'projects/x/messages/fake' }));
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

function tmp(name, obj) {
    const file = path.join(os.tmpdir(), name + '-' + process.pid + '-' + Math.random().toString(36).slice(2) + '.json');
    fs.writeFileSync(file, JSON.stringify(obj));
    return file;
}

// ── per-app_id routing (the core feature) ──────────────────────────────────

test('send routes each app_id to its own project SA + project_id, default for the rest', async () => {
    const dflt = makeProject('hilia', null);
    const operator = makeProject('operator', null);
    const fake = await startFakeGoogle([dflt, operator]);
    dflt.sa.token_uri = fake.base + '/token';
    operator.sa.token_uri = fake.base + '/token';
    try {
        const t = new push.FcmTransport({
            serviceAccount: dflt.sa,
            projects: { operator: operator.sa },
            fcmBaseUrl: fake.base,
        });
        // app_id 'operator' -> operator project
        const r1 = await t.send({ transport: 'fcm', app_id: 'operator', token: 'op-device-1' });
        assert.deepStrictEqual(r1, { ok: true });
        // app_id 'hilia' -> default project (explicit but unmapped)
        const r2 = await t.send({ transport: 'fcm', app_id: 'hilia', token: 'hilia-device-1' });
        assert.deepStrictEqual(r2, { ok: true });
        // no app_id -> default project
        const r3 = await t.send({ transport: 'fcm', token: 'noapp-device-1' });
        assert.deepStrictEqual(r3, { ok: true });

        // The operator send signed with the operator SA and POSTed to the operator
        // project id + used the operator project's Bearer token.
        const opSend = fake.state.sendRequests[0];
        assert.strictEqual(opSend.path, '/v1/projects/operator-project/messages:send');
        assert.ok(/^Bearer tok-operator-/.test(opSend.auth), 'operator send used operator token: ' + opSend.auth);
        // The two default sends POSTed to the default project id + default token.
        assert.strictEqual(fake.state.sendRequests[1].path, '/v1/projects/hilia-project/messages:send');
        assert.ok(/^Bearer tok-hilia-/.test(fake.state.sendRequests[1].auth));
        assert.strictEqual(fake.state.sendRequests[2].path, '/v1/projects/hilia-project/messages:send');
        assert.ok(/^Bearer tok-hilia-/.test(fake.state.sendRequests[2].auth));

        // JWT-bearer assertions verified against the RIGHT project keys.
        const opTok = fake.state.tokenRequests.find((r) => r.verifiedProject === 'operator');
        assert.ok(opTok, 'operator SA must have signed a token assertion');
        assert.strictEqual(opTok.iss, 'fcm-broker@operator.iam.gserviceaccount.com');
        const hiliaTok = fake.state.tokenRequests.find((r) => r.verifiedProject === 'hilia');
        assert.ok(hiliaTok, 'default (hilia) SA must have signed a token assertion');
        assert.strictEqual(hiliaTok.iss, 'fcm-broker@hilia.iam.gserviceaccount.com');
    } finally { await fake.close(); }
});

// ── per-project token cache ─────────────────────────────────────────────────

test('each project caches its OWN OAuth token (per-project fetch counts)', async () => {
    const dflt = makeProject('hilia', null);
    const operator = makeProject('operator', null);
    const fake = await startFakeGoogle([dflt, operator]);
    dflt.sa.token_uri = fake.base + '/token';
    operator.sa.token_uri = fake.base + '/token';
    try {
        const t = new push.FcmTransport({
            serviceAccount: dflt.sa,
            projects: { operator: operator.sa },
            fcmBaseUrl: fake.base,
        });
        // Two sends to operator, two to default.
        await t.send({ transport: 'fcm', app_id: 'operator', token: 'op-1' });
        await t.send({ transport: 'fcm', app_id: 'operator', token: 'op-2' });
        await t.send({ transport: 'fcm', app_id: 'hilia', token: 'h-1' });
        await t.send({ transport: 'fcm', token: 'h-2' });
        // Each project minted exactly one token (reused across its own sends).
        assert.strictEqual(fake.state.tokenCountByProject.operator, 1, 'operator token reused');
        assert.strictEqual(fake.state.tokenCountByProject.hilia, 1, 'default token reused');
        assert.strictEqual(fake.state.tokenRequests.length, 2, 'exactly two distinct token mints');
        assert.strictEqual(fake.state.sendRequests.length, 4);
    } finally { await fake.close(); }
});

// ── config: TYO_MQ_PUSH_FCM_PROJECTS wiring ─────────────────────────────────

test('loadConfig wires the default + per-app_id projects from env', async () => {
    const dflt = makeProject('hilia', null);
    const operator = makeProject('operator', null);
    const fake = await startFakeGoogle([dflt, operator]);
    dflt.sa.token_uri = fake.base + '/token';
    operator.sa.token_uri = fake.base + '/token';
    const dfltFile = tmp('fcm-default', dflt.sa);
    const opFile = tmp('fcm-operator', operator.sa);
    try {
        const cfg = push.loadConfig({
            TYO_MQ_PUSH_TRANSPORT: 'fcm',
            TYO_MQ_PUSH_FCM_CREDENTIALS: dfltFile,
            TYO_MQ_PUSH_FCM_PROJECTS: JSON.stringify({ operator: opFile }),
        });
        assert.ok(cfg.transport instanceof push.FcmTransport);
        // Point it at the fake and confirm routing works end to end.
        cfg.transport._fcmBaseUrl = fake.base;
        const r = await cfg.transport.send({ transport: 'fcm', app_id: 'operator', token: 'op-1' });
        assert.deepStrictEqual(r, { ok: true });
        assert.strictEqual(fake.state.sendRequests[0].path, '/v1/projects/operator-project/messages:send');
    } finally {
        await fake.close();
        fs.unlinkSync(dfltFile); fs.unlinkSync(opFile);
    }
});

test('a map-only config (no default) still loads and routes mapped app_ids', async () => {
    const operator = makeProject('operator', null);
    const fake = await startFakeGoogle([operator]);
    operator.sa.token_uri = fake.base + '/token';
    const opFile = tmp('fcm-operator-only', operator.sa);
    try {
        const cfg = push.loadConfig({
            TYO_MQ_PUSH_TRANSPORT: 'fcm',
            TYO_MQ_PUSH_FCM_PROJECTS: JSON.stringify({ operator: opFile }),
        });
        assert.ok(cfg.transport instanceof push.FcmTransport);
        cfg.transport._fcmBaseUrl = fake.base;
        const r = await cfg.transport.send({ transport: 'fcm', app_id: 'operator', token: 'op-1' });
        assert.deepStrictEqual(r, { ok: true });
        assert.strictEqual(fake.state.sendRequests[0].path, '/v1/projects/operator-project/messages:send');
    } finally { await fake.close(); fs.unlinkSync(opFile); }
});

// ── fail-loud config validation ─────────────────────────────────────────────

test('unparseable TYO_MQ_PUSH_FCM_PROJECTS throws at config load', () => {
    const dflt = makeProject('hilia', 'https://oauth2.googleapis.com/token');
    const dfltFile = tmp('fcm-default-bad', dflt.sa);
    try {
        assert.throws(
            () => push.loadConfig({
                TYO_MQ_PUSH_TRANSPORT: 'fcm',
                TYO_MQ_PUSH_FCM_CREDENTIALS: dfltFile,
                TYO_MQ_PUSH_FCM_PROJECTS: '{not json',
            }),
            /TYO_MQ_PUSH_FCM_PROJECTS/,
        );
    } finally { fs.unlinkSync(dfltFile); }
});

test('a non-object TYO_MQ_PUSH_FCM_PROJECTS throws at config load', () => {
    const dflt = makeProject('hilia', 'https://oauth2.googleapis.com/token');
    const dfltFile = tmp('fcm-default-arr', dflt.sa);
    try {
        assert.throws(
            () => push.loadConfig({
                TYO_MQ_PUSH_TRANSPORT: 'fcm',
                TYO_MQ_PUSH_FCM_CREDENTIALS: dfltFile,
                TYO_MQ_PUSH_FCM_PROJECTS: '["operator"]',
            }),
            /TYO_MQ_PUSH_FCM_PROJECTS/,
        );
    } finally { fs.unlinkSync(dfltFile); }
});

test('a mapped path that is missing throws at config load', () => {
    const dflt = makeProject('hilia', 'https://oauth2.googleapis.com/token');
    const dfltFile = tmp('fcm-default-miss', dflt.sa);
    try {
        assert.throws(
            () => push.loadConfig({
                TYO_MQ_PUSH_TRANSPORT: 'fcm',
                TYO_MQ_PUSH_FCM_CREDENTIALS: dfltFile,
                TYO_MQ_PUSH_FCM_PROJECTS: JSON.stringify({ operator: '/no/such/file/here.json' }),
            }),
            /TYO_MQ_PUSH_FCM_PROJECTS\[operator\]/,
        );
    } finally { fs.unlinkSync(dfltFile); }
});

test('a mapped SA missing required fields throws at config load', () => {
    const dflt = makeProject('hilia', 'https://oauth2.googleapis.com/token');
    const dfltFile = tmp('fcm-default-badsa', dflt.sa);
    const badFile = tmp('fcm-operator-bad', { type: 'service_account', project_id: 'p' }); // no email/key
    try {
        assert.throws(
            () => push.loadConfig({
                TYO_MQ_PUSH_TRANSPORT: 'fcm',
                TYO_MQ_PUSH_FCM_CREDENTIALS: dfltFile,
                TYO_MQ_PUSH_FCM_PROJECTS: JSON.stringify({ operator: badFile }),
            }),
            /client_email|private_key/,
        );
    } finally { fs.unlinkSync(dfltFile); fs.unlinkSync(badFile); }
});

test('neither TYO_MQ_PUSH_FCM_CREDENTIALS nor TYO_MQ_PUSH_FCM_PROJECTS -> throws', () => {
    assert.throws(
        () => push.loadConfig({ TYO_MQ_PUSH_TRANSPORT: 'fcm' }),
        /TYO_MQ_PUSH_FCM_CREDENTIALS/,
    );
});

// ── no-default + unmapped app_id at send: skip, no crash ─────────────────────

test('map-only config: an unmapped app_id at send returns { ok:false } + token-free warn', async () => {
    const operator = makeProject('operator', null);
    const fake = await startFakeGoogle([operator]);
    operator.sa.token_uri = fake.base + '/token';
    const cap = capturingLogger();
    try {
        const t = new push.FcmTransport({
            projects: { operator: operator.sa },
            fcmBaseUrl: fake.base,
            logger: cap,
        });
        // app_id has no mapping and there is no default project.
        const r = await t.send({ transport: 'fcm', app_id: 'unknown-app', token: 'secret-device-token-abc' });
        assert.deepStrictEqual(r, { ok: false }); // NOT gone — retain, do not prune
        // Never reached the network.
        assert.strictEqual(fake.state.tokenRequests.length, 0);
        assert.strictEqual(fake.state.sendRequests.length, 0);
        // A token-free no-project warn was emitted...
        assert.ok(cap.calls.warn.some((w) => /transport=fcm/.test(w) && /reason=no-project/.test(w)),
            'expected a no-project warn: ' + JSON.stringify(cap.calls.warn));
        // ...and NO log line leaks the device token.
        cap.all().forEach((line) => {
            assert.ok(line.indexOf('secret-device-token-abc') < 0, 'log leaked the device token: ' + line);
        });
    } finally { await fake.close(); }
});

test('map-only config: a mapped app_id still sends fine (only the unmapped one skips)', async () => {
    const operator = makeProject('operator', null);
    const fake = await startFakeGoogle([operator]);
    operator.sa.token_uri = fake.base + '/token';
    try {
        const t = new push.FcmTransport({
            projects: { operator: operator.sa },
            fcmBaseUrl: fake.base,
        });
        const ok = await t.send({ transport: 'fcm', app_id: 'operator', token: 'op-1' });
        assert.deepStrictEqual(ok, { ok: true });
        const skip = await t.send({ transport: 'fcm', app_id: 'nope', token: 'x' });
        assert.deepStrictEqual(skip, { ok: false });
        assert.strictEqual(fake.state.sendRequests.length, 1);
    } finally { await fake.close(); }
});

// ── prototype-pollution-safe app_id lookup ──────────────────────────────────

test('a prototype-key app_id ("__proto__") falls through to the default project', async () => {
    const dflt = makeProject('hilia', null);
    const fake = await startFakeGoogle([dflt]);
    dflt.sa.token_uri = fake.base + '/token';
    try {
        const t = new push.FcmTransport({ serviceAccount: dflt.sa, fcmBaseUrl: fake.base });
        const r = await t.send({ transport: 'fcm', app_id: '__proto__', token: 'x' });
        assert.deepStrictEqual(r, { ok: true });
        assert.strictEqual(fake.state.sendRequests[0].path, '/v1/projects/hilia-project/messages:send');
    } finally { await fake.close(); }
});

run();
