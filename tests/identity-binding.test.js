/**
 * Connection identity binding — a token carrying an `identity` claim restricts
 * the names the connection may register (CONSUMER/PRODUCER) to exactly that
 * identity. Everything downstream (KEY_PUBLISH, prekeys, sealed flows) already
 * authorizes against the registered-name set, so restricting registration
 * transitively restricts it all. Tokens WITHOUT an identity claim are
 * unchanged (legacy behavior).
 *
 * Fast auth vector: `auth.validator` function injected post-boot via
 * settings.merge (the constructor's JSON clone strips functions, merge's
 * clone passes them through) — validateToken honors it first. One end-to-end
 * test uses a real RS256 jwks token minted with the jwks-validator helpers.
 *
 * Usage: node tests/identity-binding.test.js
 */

'use strict';

const assert = require('assert');
const crypto = require('crypto');
const http = require('http');
const ioClient = require('socket.io-client');
const { test, run } = require('./runner');
const { startServer, waitFor } = require('./helpers');

const REALM = 'apps:bind:chat';
const BOUND_IDENTITY = 'chat-u1';

// Tokens the injected auth.validator recognizes.
const TOKENS = {
    'bound-tok': { realm: REALM, role: 'both', identity: BOUND_IDENTITY, sub: 'u1' },
    'free-tok':  { realm: REALM, role: 'both' },
};

/** Boot an auth-enabled broker whose validator maps TOKENS. */
async function bootBoundBroker() {
    const srv = await startServer({ auth: { enabled: true } });
    // Functions cannot travel through the constructor (Settings JSON-clones
    // the initial object) but merge() passes non-objects through untouched.
    srv.server.settings.merge({
        auth: { validator: (token) => TOKENS[token] || null }
    });
    return srv;
}

/** Connect a raw socket.io client and authenticate; keeps the socket open. */
async function connectAndAuth(port, message) {
    const socket = ioClient(`http://127.0.0.1:${port}`, { transports: ['websocket'] });
    await waitFor(socket, 'connect');
    socket.emit('AUTHENTICATION', message);
    const result = await Promise.race([
        waitFor(socket, 'AUTH_OK').then(ok => ({ ok })),
        waitFor(socket, 'AUTH_FAIL').then(fail => ({ fail })),
    ]);
    return { socket, ...result };
}

/** Emit an event that answers through a socket.io ack callback. */
function emitAck(socket, event, payload, timeoutMs = 3000) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(
            () => reject(new Error(`Timed out waiting for ${event} ack`)), timeoutMs);
        socket.emit(event, payload, (res) => {
            clearTimeout(timer);
            resolve(res);
        });
    });
}

/** KEY_PUBLISH for `identity` — {ok:true} iff the identity is registered. */
function publishKeyAs(socket, identity) {
    return emitAck(socket, 'KEY_PUBLISH', {
        identity, key_id: 'k-' + identity, public_key: 'PUB-' + identity
    });
}

// ── Fast vector: injected auth.validator ─────────────────────────────────────

test('bound CONSUMER: AUTH_OK shape unchanged; registering the token identity works end-to-end', async () => {
    const srv = await bootBoundBroker();
    const infoLines = [];
    const baseLogger = srv.server.logger;
    srv.server.logger = Object.assign({}, baseLogger, {
        info: (msg) => infoLines.push(String(msg))
    });
    let socket;
    try {
        const auth = await connectAndAuth(srv.port, { token: 'bound-tok' });
        socket = auth.socket;
        // AUTH_OK payload must be byte-for-byte the legacy {realm, role} —
        // the binding must not leak into the response shape.
        assert.deepStrictEqual(auth.ok, { realm: REALM, role: 'both' });

        // The auth log line carries the token's sub for auditing — never the token.
        assert.ok(infoLines.some(l => l.includes("sub='u1'")),
            'auth log line must include the token sub');
        assert.ok(infoLines.every(l => !l.includes('bound-tok')),
            'log lines must never contain the token');

        socket.emit('CONSUMER', { name: BOUND_IDENTITY });
        // Registration has no ack; KEY_PUBLISH succeeding proves the identity
        // landed in the connection's registered-name set.
        const published = await publishKeyAs(socket, BOUND_IDENTITY);
        assert.strictEqual(published.ok, true);
    } finally {
        if (socket) socket.disconnect();
        await srv.close();
    }
});

test('bound CONSUMER: a different name is rejected 403 and stays unregistered', async () => {
    const srv = await bootBoundBroker();
    let socket;
    try {
        const auth = await connectAndAuth(srv.port, { token: 'bound-tok' });
        socket = auth.socket;
        assert.ok(auth.ok);

        const errPromise = waitFor(socket, 'ERROR');
        socket.emit('CONSUMER', { name: 'intruder' });
        const err = await errPromise;
        assert.strictEqual(err.code, 403);
        assert.strictEqual(err.message, "identity not authorized by this connection's token");

        // The refused name must not have been registered: KEY_PUBLISH still 403s.
        const denied = await publishKeyAs(socket, 'intruder');
        assert.strictEqual(denied.ok, false);
        assert.strictEqual(denied.code, 403);

        // And the bound identity itself was never registered either (the
        // rejected CONSUMER must not have registered anything as a side effect).
        const alsoDenied = await publishKeyAs(socket, BOUND_IDENTITY);
        assert.strictEqual(alsoDenied.ok, false);
        assert.strictEqual(alsoDenied.code, 403);

        // The realm has no consumer entry for the refused name.
        assert.ok(socket.connected, 'a binding refusal must not disconnect the socket');
    } finally {
        if (socket) socket.disconnect();
        await srv.close();
    }
});

test('bound PRODUCER: registering the token identity works end-to-end', async () => {
    const srv = await bootBoundBroker();
    let socket;
    try {
        const auth = await connectAndAuth(srv.port, { token: 'bound-tok' });
        socket = auth.socket;
        assert.deepStrictEqual(auth.ok, { realm: REALM, role: 'both' });

        socket.emit('PRODUCER', { name: BOUND_IDENTITY });
        const published = await publishKeyAs(socket, BOUND_IDENTITY);
        assert.strictEqual(published.ok, true);
    } finally {
        if (socket) socket.disconnect();
        await srv.close();
    }
});

test('bound PRODUCER: a different name is rejected 403 and stays unregistered', async () => {
    const srv = await bootBoundBroker();
    let socket;
    try {
        const auth = await connectAndAuth(srv.port, { token: 'bound-tok' });
        socket = auth.socket;
        assert.ok(auth.ok);

        const errPromise = waitFor(socket, 'ERROR');
        socket.emit('PRODUCER', { name: 'rogue-producer' });
        const err = await errPromise;
        assert.strictEqual(err.code, 403);
        assert.strictEqual(err.message, "identity not authorized by this connection's token");

        const denied = await publishKeyAs(socket, 'rogue-producer');
        assert.strictEqual(denied.ok, false);
        assert.strictEqual(denied.code, 403);
        assert.ok(socket.connected);
    } finally {
        if (socket) socket.disconnect();
        await srv.close();
    }
});

test('unbound token (no identity claim): registration is unrestricted (legacy unchanged)', async () => {
    const srv = await bootBoundBroker();
    let socket;
    try {
        const auth = await connectAndAuth(srv.port, { token: 'free-tok' });
        socket = auth.socket;
        assert.deepStrictEqual(auth.ok, { realm: REALM, role: 'both' });

        socket.emit('CONSUMER', { name: 'any-consumer-name' });
        socket.emit('PRODUCER', { name: 'any-producer-name' });
        const first = await publishKeyAs(socket, 'any-consumer-name');
        assert.strictEqual(first.ok, true);
        const second = await publishKeyAs(socket, 'any-producer-name');
        assert.strictEqual(second.ok, true);
    } finally {
        if (socket) socket.disconnect();
        await srv.close();
    }
});

// ── End-to-end: a real RS256 jwks token binds the connection ─────────────────
// Helpers mirror tests/jwks-validator.test.js (minting + in-test JWKS server).

const JWKS_ISS = 'https://id.test.example';
const JWKS_AUD = 'tyo-mq';
const JWKS_PREFIX = 'apps:bindjwks:';
const JWKS_REALM = JWKS_PREFIX + 'chat';

function base64Url(value) {
    return Buffer.from(value).toString('base64')
        .replace(/=/g, '')
        .replace(/\+/g, '-')
        .replace(/\//g, '_');
}

function mint(privateKey, kid, payload) {
    const h = base64Url(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid }));
    const p = base64Url(JSON.stringify(payload));
    const sig = crypto.sign('RSA-SHA256', Buffer.from(`${h}.${p}`), privateKey);
    return `${h}.${p}.${base64Url(sig)}`;
}

function startJwksStub(keys) {
    return new Promise((resolve) => {
        const server = http.createServer((req, res) => {
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ keys }));
        });
        server.listen(0, '127.0.0.1', () => resolve({
            url: `http://127.0.0.1:${server.address().port}/jwks.json`,
            close: () => new Promise(r => server.close(r)),
        }));
    });
}

test('jwks token with an identity claim binds the connection end-to-end', async () => {
    const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    const jwk = Object.assign({}, publicKey.export({ format: 'jwk' }),
        { kid: 'k1', alg: 'RS256', use: 'sig' });
    const stub = await startJwksStub([jwk]);
    const srv = await startServer({
        auth: {
            enabled: true,
            external_validators: [
                { realm_prefix: JWKS_PREFIX, jwks_url: stub.url, iss: JWKS_ISS, aud: JWKS_AUD }
            ]
        }
    });
    const nowSec = Math.floor(Date.now() / 1000);
    const token = mint(privateKey, 'k1', {
        iss: JWKS_ISS, aud: JWKS_AUD, sub: 'u9', realm: JWKS_REALM, role: 'both',
        identity: 'chat-u9', iat: nowSec, exp: nowSec + 600
    });
    let bound, other;
    try {
        // Bound name registers and is fully usable.
        const authA = await connectAndAuth(srv.port, { token, realm: JWKS_REALM });
        bound = authA.socket;
        assert.deepStrictEqual(authA.ok, { realm: JWKS_REALM, role: 'both' });
        bound.emit('CONSUMER', { name: 'chat-u9' });
        const published = await publishKeyAs(bound, 'chat-u9');
        assert.strictEqual(published.ok, true);

        // A second connection with the same token cannot register another name.
        const authB = await connectAndAuth(srv.port, { token, realm: JWKS_REALM });
        other = authB.socket;
        assert.ok(authB.ok);
        const errPromise = waitFor(other, 'ERROR');
        other.emit('CONSUMER', { name: 'someone-else' });
        const err = await errPromise;
        assert.strictEqual(err.code, 403);
        assert.strictEqual(err.message, "identity not authorized by this connection's token");
        const denied = await publishKeyAs(other, 'someone-else');
        assert.strictEqual(denied.ok, false);
        assert.strictEqual(denied.code, 403);
    } finally {
        if (bound) bound.disconnect();
        if (other) other.disconnect();
        await srv.close();
        await stub.close();
    }
});

run();
