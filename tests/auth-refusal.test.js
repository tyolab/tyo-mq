'use strict';
/**
 * Refusals must say why — in the ack AND in the log.
 *
 * Field incident (2026-10-27): an iPhone whose reconnected socket never
 * re-authenticated had eight SEALED_DELIVER calls refused with the bare ack
 * {401, "not authorized for SEALED_DELIVER"} while the broker journal showed
 * nothing for the whole window — authorize() refusals and a null token
 * verdict ("Invalid authentication token", e.g. an EXPIRED JWT) wrote no log
 * line at all. These tests pin that:
 *  - a refused guarded event acks with the real cause (401 "authentication
 *    required" vs 403 "role … not allowed") and the same cause reaches the
 *    log, rate-limited per socket so a flood cannot drown the journal;
 *  - an expired JWKS token is named as such by the validator and the
 *    AUTHENTICATION failure is logged, without the token ever being logged.
 *
 * Usage: node tests/auth-refusal.test.js
 */
const assert = require('assert');
const http = require('http');
const crypto = require('crypto');
const { test, run } = require('./runner');
const { startServer, delay, waitFor } = require('./helpers');
const { createJwksValidator } = require('../lib/jwks');
const ioc = require('socket.io-client');

function capturingLogger() {
    const calls = { warn: [], info: [], log: [], error: [], critical: [], output: [], debug: [], trace: [] };
    const mk = (lvl) => (...a) => { calls[lvl].push(a.map(String).join(' ')); };
    return { calls, warn: mk('warn'), info: mk('info'), log: mk('log'), error: mk('error'), critical: mk('critical'), output: mk('output'), debug: mk('debug'), trace: mk('trace') };
}
function connect(port) {
    const s = ioc('http://127.0.0.1:' + port, { transports: ['websocket'], forceNew: true, reconnection: false });
    return waitFor(s, 'connect').then(() => s);
}
function ackOf(s, event, payload) {
    return new Promise((resolve) => s.emit(event, payload, resolve));
}
function nextAuthFail(s) {
    return new Promise((resolve) => s.once('AUTH_FAIL', resolve));
}
function authenticate(s, payload) {
    return new Promise((resolve) => {
        const done = (v) => { s.off('AUTH_OK'); s.off('AUTH_FAIL'); resolve(v); };
        s.once('AUTH_OK', (i) => done({ ok: true, info: i }));
        s.once('AUTH_FAIL', (f) => done({ ok: false, fail: f }));
        s.emit('AUTHENTICATION', payload);
    });
}

test('an unauthenticated socket gets the cause in the ack (401 authentication required), an AUTH_FAIL, and ONE log line per window', async () => {
    const srv = await startServer({ auth: { enabled: true, tokens: [{ token: 't-admin', realm: '*', role: 'admin' }], realms: { locked: { required: true } } } });
    const logger = capturingLogger();
    srv.server.logger = logger;
    try {
        const s = await connect(srv.port);
        // Declare the locked realm without authenticating, as a reconnected client might.
        const failP = nextAuthFail(s);
        const ack = await ackOf(s, 'PREKEY_STATS', { realm: 'locked' });
        const fail = await failP;
        assert.strictEqual(ack.ok, false);
        assert.strictEqual(ack.code, 401);
        assert.ok(ack.message.startsWith('not authorized for PREKEY_STATS'), ack.message);
        assert.ok(/authentication required/.test(ack.message), 'ack names the cause: ' + ack.message);
        assert.strictEqual(fail.code, 401);
        assert.ok(/Authentication required before PREKEY_STATS/.test(fail.message));

        const refusals = () => logger.calls.warn.filter((l) => /^Refused PREKEY_STATS/.test(l));
        assert.strictEqual(refusals().length, 1, 'logged once: ' + JSON.stringify(logger.calls.warn));
        assert.ok(/authentication required \(code 401\)/.test(refusals()[0]) && /unauthenticated socket/.test(refusals()[0]), refusals()[0]);

        // Flood: 5 more inside the window → acks keep coming, the log does not grow.
        for (let i = 0; i < 5; i++) assert.strictEqual((await ackOf(s, 'PREKEY_STATS', {})).code, 401);
        assert.strictEqual(refusals().length, 1, 'rate-limited per socket');
        s.disconnect();
    } finally { await srv.close(); }
});

test('a consumer-only token on a producer-only event gets 403 "role not allowed" and a log line naming the role', async () => {
    const srv = await startServer({ auth: { enabled: true, tokens: [
        { token: 't-admin', realm: '*', role: 'admin' },
        { token: 't-consumer', realm: 'default', role: 'consumer' },
    ] } });
    const logger = capturingLogger();
    srv.server.logger = logger;
    try {
        const s = await connect(srv.port);
        const a = await authenticate(s, { token: 't-consumer' });
        assert.strictEqual(a.ok, true, JSON.stringify(a));
        const failP = nextAuthFail(s);
        s.emit('PRODUCER', { name: 'rogue-producer' });   // fire-and-forget producer-only event
        const fail = await failP;
        assert.strictEqual(fail.code, 403);
        assert.ok(/Role 'consumer' is not allowed to send PRODUCER/.test(fail.message), fail.message);
        await delay(50);
        const line = logger.calls.warn.find((l) => /^Refused PRODUCER/.test(l));
        assert.ok(line, JSON.stringify(logger.calls.warn));
        assert.ok(/role 'consumer' not allowed \(code 403\)/.test(line) && /realm='default'/.test(line), line);
        s.disconnect();
    } finally { await srv.close(); }
});

// ── expired JWKS token: validator names the reason; AUTHENTICATION logs the refusal ──

const ISS = 'https://id.refusal.test', AUD = 'tyo-mq', PREFIX = 'apps:refusal:', REALM = PREFIX + 'chat';
function b64u(v) { return Buffer.from(v).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_'); }
function mint(privateKey, kid, payload) {
    const h = b64u(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid })), p = b64u(JSON.stringify(payload));
    return `${h}.${p}.${b64u(crypto.sign('RSA-SHA256', Buffer.from(`${h}.${p}`), privateKey))}`;
}
function jwksStub(jwks) {
    const server = http.createServer((req, res) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ keys: jwks })); });
    return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({
        url: 'http://127.0.0.1:' + server.address().port + '/.well-known/jwks.json',
        close: () => new Promise((r) => server.close(r)),
    })));
}

test('an expired JWKS token: the validator logs "token rejected (expired)" and the broker logs the AUTHENTICATION refusal — never the token', async () => {
    const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    const jwk = Object.assign({}, publicKey.export({ format: 'jwk' }), { kid: 'k1', alg: 'RS256', use: 'sig' });
    const stub = await jwksStub([jwk]);
    const nowSec = Math.floor(Date.now() / 1000);
    const expired = mint(privateKey, 'k1', { iss: ISS, aud: AUD, realm: REALM, role: 'both', sub: 'u1', iat: nowSec - 7200, exp: nowSec - 3600 });
    const fresh = mint(privateKey, 'k1', { iss: ISS, aud: AUD, realm: REALM, role: 'both', sub: 'u1', iat: nowSec, exp: nowSec + 600 });
    try {
        // Unit: the validator itself.
        const vlog = capturingLogger();
        const v = createJwksValidator({ realm_prefix: PREFIX, jwks_url: stub.url, iss: ISS, aud: AUD }, { logger: vlog });
        assert.strictEqual(await v.verify(expired, Date.now()), null);
        assert.ok(vlog.calls.warn.some((l) => /JWKS: token rejected \(expired\)/.test(l)), JSON.stringify(vlog.calls.warn));
        assert.ok(!vlog.calls.warn.some((l) => l.includes(expired.split('.')[2])), 'the token is never logged');
        assert.strictEqual(await v.verify(expired, Date.now()), null);
        assert.strictEqual(vlog.calls.warn.filter((l) => /\(expired\)/.test(l)).length, 1, 'one line per reason per cooldown');
        assert.ok((await v.verify(fresh, Date.now())) && (await v.verify(fresh, Date.now())).realm === REALM);

        // Through the broker.
        const srv = await startServer({ auth: { enabled: true, tokens: [{ token: 't-admin', realm: '*', role: 'admin' }],
            external_validators: [{ realm_prefix: PREFIX, jwks_url: stub.url, iss: ISS, aud: AUD }] } });
        const logger = capturingLogger();
        srv.server.logger = logger;
        try {
            const s = await connect(srv.port);
            const r = await authenticate(s, { token: expired, realm: REALM });
            assert.strictEqual(r.ok, false);
            assert.strictEqual(r.fail.code, 401);
            assert.strictEqual(r.fail.message, 'Invalid authentication token');
            assert.ok(logger.calls.warn.some((l) => /JWKS: token rejected \(expired\)/.test(l)), JSON.stringify(logger.calls.warn));
            assert.ok(logger.calls.warn.some((l) => /AUTHENTICATION: token rejected — socket=/.test(l) && /realm='apps:refusal:chat'/.test(l)), JSON.stringify(logger.calls.warn));
            assert.ok(!logger.calls.warn.some((l) => l.includes(expired.split('.')[1])), 'the token never reaches the log');
            // And the now-unauthenticated socket's next guarded call says so.
            const ack = await ackOf(s, 'PREKEY_STATS', {});
            assert.strictEqual(ack.code, 401);
            assert.ok(/authentication required/.test(ack.message));
            s.disconnect();
        } finally { await srv.close(); }
    } finally { await stub.close(); }
});

run();
