/**
 * Offline JWKS validator mode for prefix-scoped external validators.
 *
 * A jwks entry {realm_prefix, jwks_url, iss, aud} in auth.external_validators
 * verifies RS256 tokens OFFLINE against the issuer's JWKS instead of the live
 * HTTP callback. Covers the claim contract, kid rotation with refetch
 * cooldown, fail-closed fetch semantics, the set_external_auth admin surface,
 * and regressions for every pre-existing auth vector.
 *
 * Usage: node tests/jwks-validator.test.js
 */

'use strict';

const assert = require('assert');
const crypto = require('crypto');
const http = require('http');
const Authorization = require('tyo-mq-client').Authorization;
const ioClient = require('socket.io-client');
const { test, run } = require('./runner');
const { startServer, waitFor } = require('./helpers');
const { createJwksValidator } = require('../lib/jwks');

const ISS = 'https://id.test.example';
const AUD = 'tyo-mq';
const PREFIX = 'apps:testjwks:';
const REALM = PREFIX + 'chat';

function base64Url(value) {
    return Buffer.from(value).toString('base64')
        .replace(/=/g, '')
        .replace(/\+/g, '-')
        .replace(/\//g, '_');
}

function makeKeyPair() {
    return crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
}

function jwkOf(publicKey, kid) {
    return Object.assign({}, publicKey.export({ format: 'jwk' }), {
        kid, alg: 'RS256', use: 'sig'
    });
}

/** Mint an RS256 compact JWT signed with `privateKey`. */
function mint(privateKey, kid, payload, headerOverride) {
    const header = Object.assign({ alg: 'RS256', typ: 'JWT', kid }, headerOverride || {});
    const h = base64Url(JSON.stringify(header));
    const p = base64Url(JSON.stringify(payload));
    const sig = crypto.sign('RSA-SHA256', Buffer.from(`${h}.${p}`), privateKey);
    return `${h}.${p}.${base64Url(sig)}`;
}

/** Mint an HS256 compact JWT (legacy realm-JWT shape). */
function mintHs256(payload, secret) {
    const h = base64Url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
    const p = base64Url(JSON.stringify(payload));
    const sig = base64Url(crypto.createHmac('sha256', secret).update(`${h}.${p}`).digest());
    return `${h}.${p}.${sig}`;
}

/** Standard valid claim set; override/delete via `overrides`. */
function claims(overrides, nowSec) {
    nowSec = nowSec || Math.floor(Date.now() / 1000);
    const payload = Object.assign({
        iss: ISS,
        aud: AUD,
        sub: 'u1',
        realm: REALM,
        role: 'both',
        identity: 'chat-u1',
        iat: nowSec,
        exp: nowSec + 600
    }, overrides || {});
    Object.keys(payload).forEach((key) => {
        if (payload[key] === undefined)
            delete payload[key];
    });
    return payload;
}

/** In-test JWKS endpoint. Counts fetches; keys and failure mode swappable. */
function startJwksStub(initialKeys) {
    return new Promise((resolve) => {
        let keys = initialKeys;
        let mode = 'ok';
        let fetches = 0;
        const server = http.createServer((req, res) => {
            fetches++;
            res.on('error', () => {});
            req.socket.on('error', () => {});
            if (mode === 'error') {
                res.writeHead(500, { 'content-type': 'text/plain' });
                res.end('boom');
                return;
            }
            if (mode === 'huge') {
                // > 64KB of valid JSON.
                res.writeHead(200, { 'content-type': 'application/json' });
                res.end('{"keys":[' + '"x",'.repeat(40000) + '"x"]}');
                return;
            }
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ keys }));
        });
        server.listen(0, '127.0.0.1', () => resolve({
            url: `http://127.0.0.1:${server.address().port}/jwks.json`,
            get fetches() { return fetches; },
            setKeys: (next) => { keys = next; },
            setMode: (next) => { mode = next; },
            close: () => new Promise(r => server.close(r)),
        }));
    });
}

/** Connect, send AUTHENTICATION, resolve {ok} or {fail}. */
async function authenticate(port, message) {
    const socket = ioClient(`http://127.0.0.1:${port}`, { transports: ['websocket'] });
    try {
        await waitFor(socket, 'connect');
        socket.emit('AUTHENTICATION', message);
        return await Promise.race([
            waitFor(socket, 'AUTH_OK').then(ok => ({ ok })),
            waitFor(socket, 'AUTH_FAIL').then(fail => ({ fail })),
        ]);
    } finally {
        socket.disconnect();
    }
}

function bootBroker(jwksUrl, extraAuth) {
    return startServer({
        auth: Object.assign({
            enabled: true,
            external_validators: [
                { realm_prefix: PREFIX, jwks_url: jwksUrl, iss: ISS, aud: AUD }
            ]
        }, extraAuth || {})
    });
}

const noopLogger = { warn: () => {}, error: () => {}, info: () => {}, log: () => {} };

function makeValidator(jwksUrl, logger) {
    return createJwksValidator(
        { realm_prefix: PREFIX, jwks_url: jwksUrl, iss: ISS, aud: AUD },
        { logger: logger || noopLogger }
    );
}

// ── End-to-end through the broker ────────────────────────────────────────────

test('valid jwks token authenticates with the token realm/role (with and without desired realm)', async () => {
    const { privateKey, publicKey } = makeKeyPair();
    const stub = await startJwksStub([jwkOf(publicKey, 'k1')]);
    const broker = await bootBroker(stub.url);
    try {
        const token = mint(privateKey, 'k1', claims());

        // Explicit desired realm.
        const withRealm = await authenticate(broker.port, { token, realm: REALM });
        assert.deepStrictEqual(withRealm.ok, { realm: REALM, role: 'both' });

        // No realm in the AUTHENTICATION message — the RS256 token's own
        // (unverified) realm claim must serve as the validator hint.
        const withoutRealm = await authenticate(broker.port, { token });
        assert.deepStrictEqual(withoutRealm.ok, { realm: REALM, role: 'both' });
    } finally {
        await broker.close();
        await stub.close();
    }
});

test('jwks rejections: signature, iss, aud, exp, nbf, lifetime, claim contract', async () => {
    const { privateKey, publicKey } = makeKeyPair();
    const other = makeKeyPair();
    const stub = await startJwksStub([jwkOf(publicKey, 'k1')]);
    const broker = await bootBroker(stub.url);
    const nowSec = Math.floor(Date.now() / 1000);
    try {
        const bad = [
            // Signed by a different key claiming a known kid.
            mint(other.privateKey, 'k1', claims()),
            // Wrong issuer / audience.
            mint(privateKey, 'k1', claims({ iss: 'https://evil.example' })),
            mint(privateKey, 'k1', claims({ aud: 'other-service' })),
            mint(privateKey, 'k1', claims({ aud: ['other', 'services'] })),
            // Expired beyond skew / not yet valid beyond skew.
            mint(privateKey, 'k1', claims({ iat: nowSec - 720, exp: nowSec - 120 })),
            mint(privateKey, 'k1', claims({ nbf: nowSec + 120 })),
            // exp REQUIRED.
            mint(privateKey, 'k1', claims({ exp: undefined })),
            // Lifetime over the 3600s cap.
            mint(privateKey, 'k1', claims({ exp: nowSec + 7200 })),
            // Lifetime cap with missing iat (exp - now > cap).
            mint(privateKey, 'k1', claims({ iat: undefined, exp: nowSec + 7200 })),
            // Realm outside the validator's prefix.
            mint(privateKey, 'k1', claims({ realm: 'apps:other:chat' })),
            // Missing / invalid contract claims.
            mint(privateKey, 'k1', claims({ realm: undefined })),
            mint(privateKey, 'k1', claims({ role: undefined })),
            mint(privateKey, 'k1', claims({ role: 'admin' })),
            mint(privateKey, 'k1', claims({ sub: undefined })),
            // RS256 without kid.
            mint(privateKey, undefined, claims()),
        ];
        for (const token of bad) {
            const res = await authenticate(broker.port, { token, realm: REALM });
            assert.ok(res.fail, 'expected AUTH_FAIL for token: ' + token.slice(0, 40));
            assert.strictEqual(res.fail.code, 401);
        }

        // aud array CONTAINING the expected audience is accepted.
        const audArray = mint(privateKey, 'k1', claims({ aud: ['other', AUD] }));
        const okArray = await authenticate(broker.port, { token: audArray, realm: REALM });
        assert.deepStrictEqual(okArray.ok, { realm: REALM, role: 'both' });
    } finally {
        await broker.close();
        await stub.close();
    }
});

test('HS256 token is rejected by a jwks entry', async () => {
    const { publicKey } = makeKeyPair();
    const stub = await startJwksStub([jwkOf(publicKey, 'k1')]);
    const broker = await bootBroker(stub.url);
    try {
        const token = mintHs256(claims(), 'some-shared-secret');
        const res = await authenticate(broker.port, { token, realm: REALM });
        assert.ok(res.fail);
        assert.strictEqual(res.fail.code, 401);
    } finally {
        await broker.close();
        await stub.close();
    }
});

test('unknown-kid tokens trigger at most one JWKS fetch per cooldown (broker path)', async () => {
    const { privateKey, publicKey } = makeKeyPair();
    const stub = await startJwksStub([jwkOf(publicKey, 'k1')]);
    const broker = await bootBroker(stub.url);
    try {
        const badKid = mint(privateKey, 'nope', claims());
        const first = await authenticate(broker.port, { token: badKid, realm: REALM });
        assert.ok(first.fail);
        assert.strictEqual(stub.fetches, 1);
        const second = await authenticate(broker.port, { token: badKid, realm: REALM });
        assert.ok(second.fail);
        assert.strictEqual(stub.fetches, 1, 'refetch cooldown must throttle back-to-back unknown kids');
    } finally {
        await broker.close();
        await stub.close();
    }
});

// ── lib/jwks.js unit behavior (deterministic time via verify(token, nowMs)) ──

test('verify returns realm/role/sub/identity; identity omitted when absent', async () => {
    const { privateKey, publicKey } = makeKeyPair();
    const stub = await startJwksStub([jwkOf(publicKey, 'k1')]);
    try {
        const validator = makeValidator(stub.url);
        const full = await validator.verify(mint(privateKey, 'k1', claims()));
        assert.deepStrictEqual(full, { realm: REALM, role: 'both', sub: 'u1', identity: 'chat-u1' });

        const bare = await validator.verify(mint(privateKey, 'k1', claims({ identity: undefined })));
        assert.deepStrictEqual(bare, { realm: REALM, role: 'both', sub: 'u1' });
    } finally {
        await stub.close();
    }
});

test('kid rotation: one refetch accepts the new kid; cooldown throttles; still-missing kid rejected', async () => {
    const kp1 = makeKeyPair();
    const kp2 = makeKeyPair();
    const stub = await startJwksStub([jwkOf(kp1.publicKey, 'k1')]);
    try {
        const validator = makeValidator(stub.url);
        const t0 = Date.now();
        const secAt = (ms) => Math.floor(ms / 1000);

        const ok1 = await validator.verify(mint(kp1.privateKey, 'k1', claims(null, secAt(t0))), t0);
        assert.strictEqual(ok1.realm, REALM);
        assert.strictEqual(stub.fetches, 1);

        // Rotate: JWKS now serves both keys; a new-kid token past the cooldown
        // triggers exactly one refetch and is accepted.
        stub.setKeys([jwkOf(kp1.publicKey, 'k1'), jwkOf(kp2.publicKey, 'k2')]);
        const t1 = t0 + 61000;
        const ok2 = await validator.verify(mint(kp2.privateKey, 'k2', claims(null, secAt(t1))), t1);
        assert.strictEqual(ok2.realm, REALM);
        assert.strictEqual(stub.fetches, 2);

        // Unknown kid inside the cooldown window: no fetch, rejected.
        const t2 = t1 + 10000;
        const miss1 = await validator.verify(mint(kp1.privateKey, 'k3', claims(null, secAt(t2))), t2);
        assert.strictEqual(miss1, null);
        assert.strictEqual(stub.fetches, 2);

        // Unknown kid past the cooldown: refetches, still missing → rejected.
        const t3 = t1 + 61000;
        const miss2 = await validator.verify(mint(kp1.privateKey, 'k3', claims(null, secAt(t3))), t3);
        assert.strictEqual(miss2, null);
        assert.strictEqual(stub.fetches, 3);
    } finally {
        await stub.close();
    }
});

test('fetch failure fails closed, retains the cache, and warns without logging the token', async () => {
    const kp1 = makeKeyPair();
    const stub = await startJwksStub([jwkOf(kp1.publicKey, 'k1')]);
    try {
        const warnings = [];
        const validator = makeValidator(stub.url, {
            warn: (msg) => warnings.push(String(msg)),
            error: () => {}, info: () => {}, log: () => {}
        });
        const t0 = Date.now();
        const secAt = (ms) => Math.floor(ms / 1000);
        const ok = await validator.verify(mint(kp1.privateKey, 'k1', claims(null, secAt(t0))), t0);
        assert.strictEqual(ok.realm, REALM);

        // Endpoint breaks; an unknown kid forces a refetch which fails →
        // token rejected (fail closed), warning logged, cache retained.
        stub.setMode('error');
        const t1 = t0 + 61000;
        const badKidToken = mint(kp1.privateKey, 'k2', claims(null, secAt(t1)));
        const rejected = await validator.verify(badKidToken, t1);
        assert.strictEqual(rejected, null);
        assert.ok(warnings.length >= 1, 'fetch failure must be logged at warn');
        assert.ok(warnings.every(w => !w.includes(badKidToken)), 'log lines must never contain tokens');

        // Cached kid still verifies from the retained cache.
        const stillOk = await validator.verify(mint(kp1.privateKey, 'k1', claims(null, secAt(t1))), t1);
        assert.strictEqual(stillOk.realm, REALM);
    } finally {
        await stub.close();
    }
});

test('oversize JWKS response and non-loopback http are rejected (fail closed)', async () => {
    const kp1 = makeKeyPair();
    const stub = await startJwksStub([jwkOf(kp1.publicKey, 'k1')]);
    try {
        stub.setMode('huge');
        const validator = makeValidator(stub.url);
        const res = await validator.verify(mint(kp1.privateKey, 'k1', claims()));
        assert.strictEqual(res, null);

        // http:// to a non-loopback host must never be fetched.
        const insecure = makeValidator('http://id.example.com/jwks.json');
        const res2 = await insecure.verify(mint(kp1.privateKey, 'k1', claims()));
        assert.strictEqual(res2, null);
    } finally {
        await stub.close();
    }
});

test('max token lifetime is env-overridable via TYO_MQ_JWKS_MAX_TTL_SECONDS', async () => {
    const kp1 = makeKeyPair();
    const stub = await startJwksStub([jwkOf(kp1.publicKey, 'k1')]);
    try {
        process.env.TYO_MQ_JWKS_MAX_TTL_SECONDS = '60';
        const validator = makeValidator(stub.url);
        const nowSec = Math.floor(Date.now() / 1000);
        const long = await validator.verify(mint(kp1.privateKey, 'k1', claims({ exp: nowSec + 120 })));
        assert.strictEqual(long, null);
        const short = await validator.verify(mint(kp1.privateKey, 'k1', claims({ exp: nowSec + 30 })));
        assert.strictEqual(short.realm, REALM);
    } finally {
        delete process.env.TYO_MQ_JWKS_MAX_TTL_SECONDS;
        await stub.close();
    }
});

test('30s clock skew is allowed on exp and nbf', async () => {
    const kp1 = makeKeyPair();
    const stub = await startJwksStub([jwkOf(kp1.publicKey, 'k1')]);
    try {
        const validator = makeValidator(stub.url);
        const nowSec = Math.floor(Date.now() / 1000);
        const justExpired = await validator.verify(
            mint(kp1.privateKey, 'k1', claims({ iat: nowSec - 610, exp: nowSec - 10 })));
        assert.strictEqual(justExpired.realm, REALM);
        const almostValid = await validator.verify(
            mint(kp1.privateKey, 'k1', claims({ nbf: nowSec + 10 })));
        assert.strictEqual(almostValid.realm, REALM);
    } finally {
        await stub.close();
    }
});

// ── Admin surface ────────────────────────────────────────────────────────────

test('set_external_auth accepts, validates, echoes, and clears jwks entries', async () => {
    const adminToken = 'secret-admin';
    const { privateKey, publicKey } = makeKeyPair();
    const stub = await startJwksStub([jwkOf(publicKey, 'k1')]);
    const broker = await startServer({
        auth: {
            enabled: true,
            tokens: [ { token: adminToken, realm: '*', role: 'admin' } ]
        }
    });
    const options = { host: '127.0.0.1', port: broker.port, protocol: 'http' };
    const command = (body) => Authorization.authManagementCommand(adminToken, body, options);
    const commandErr = (body) => command(body).then(() => null).catch(err => err.response);

    try {
        // Set: echoed with iss/aud, never any cached keys.
        const set = await command({
            command: 'set_external_auth',
            realm_prefix: PREFIX,
            jwks_url: stub.url,
            iss: ISS,
            aud: AUD
        });
        assert.deepStrictEqual(set.settings.external_validators, [{
            realm_prefix: PREFIX,
            auth_url: null,
            auth_secret_configured: false,
            jwks_url: stub.url,
            iss: ISS,
            aud: AUD
        }]);

        // The freshly configured entry validates tokens end-to-end.
        const token = mint(privateKey, 'k1', claims());
        const ok = await authenticate(broker.port, { token, realm: REALM });
        assert.deepStrictEqual(ok.ok, { realm: REALM, role: 'both' });

        // jwks_url + auth_url in one entry → 400.
        const both = await commandErr({
            command: 'set_external_auth', realm_prefix: PREFIX,
            jwks_url: stub.url, auth_url: 'https://cb.example/auth', iss: ISS, aud: AUD
        });
        assert.strictEqual(both.code, 400);

        // Missing iss/aud → 400.
        const noIss = await commandErr({
            command: 'set_external_auth', realm_prefix: PREFIX, jwks_url: stub.url, aud: AUD
        });
        assert.strictEqual(noIss.code, 400);
        const noAud = await commandErr({
            command: 'set_external_auth', realm_prefix: PREFIX, jwks_url: stub.url, iss: ISS
        });
        assert.strictEqual(noAud.code, 400);

        // http:// only for loopback; anything else → 400.
        const insecure = await commandErr({
            command: 'set_external_auth', realm_prefix: PREFIX,
            jwks_url: 'http://id.example.com/jwks.json', iss: ISS, aud: AUD
        });
        assert.strictEqual(insecure.code, 400);
        const invalid = await commandErr({
            command: 'set_external_auth', realm_prefix: PREFIX,
            jwks_url: 'not a url', iss: ISS, aud: AUD
        });
        assert.strictEqual(invalid.code, 400);

        // jwks fields are prefix-scoped only.
        const realmScoped = await commandErr({
            command: 'set_external_auth', realm: 'org:acme',
            jwks_url: stub.url, iss: ISS, aud: AUD
        });
        assert.strictEqual(realmScoped.code, 400);
        const globalScoped = await commandErr({
            command: 'set_external_auth', jwks_url: stub.url, iss: ISS, aud: AUD
        });
        assert.strictEqual(globalScoped.code, 400);

        // Clearing removes the entry and disables validation.
        const cleared = await command({
            command: 'set_external_auth', realm_prefix: PREFIX, jwks_url: ''
        });
        assert.deepStrictEqual(cleared.settings.external_validators, []);
        const rejected = await authenticate(broker.port, { token, realm: REALM });
        assert.ok(rejected.fail);
    } finally {
        await broker.close();
        await stub.close();
    }
});

// ── Regression: every pre-existing auth vector is unaffected ─────────────────

test('static tokens, HS256 realm JWTs, and callback validators coexist with jwks entries', async () => {
    const { privateKey, publicKey } = makeKeyPair();
    const stub = await startJwksStub([jwkOf(publicKey, 'k1')]);
    const callbackRequests = [];
    const callbackStub = await new Promise((resolve) => {
        const server = http.createServer((req, res) => {
            let raw = '';
            req.on('data', c => { raw += c; });
            req.on('end', () => {
                const body = raw ? JSON.parse(raw) : {};
                callbackRequests.push({ headers: req.headers, body });
                res.writeHead(200, { 'content-type': 'application/json' });
                res.end(JSON.stringify(body.token === 'cb-tok'
                    ? { realm: body.realm, role: 'consumer' }
                    : { ok: false }));
            });
        });
        server.listen(0, '127.0.0.1', () => resolve({
            url: `http://127.0.0.1:${server.address().port}/mq-auth`,
            close: () => new Promise(r => server.close(r)),
        }));
    });
    const broker = await startServer({
        auth: {
            enabled: true,
            tokens: [ { token: 'static-tok', realm: 'acme', role: 'producer' } ],
            realms: { 'org:hs': { required: true, manager_key: 'hs-manager-key' } },
            external_validators: [
                { realm_prefix: PREFIX, jwks_url: stub.url, iss: ISS, aud: AUD },
                { realm_prefix: 'apps:cb:', auth_url: callbackStub.url, auth_secret: 'cb-secret' }
            ]
        }
    });
    try {
        // Static token.
        const staticOk = await authenticate(broker.port, { token: 'static-tok' });
        assert.deepStrictEqual(staticOk.ok, { realm: 'acme', role: 'producer' });

        // HS256 realm JWT against the realm manager key (peek gate intact).
        const nowSec = Math.floor(Date.now() / 1000);
        const hsToken = mintHs256({ realm: 'org:hs', role: 'both', exp: nowSec + 600 }, 'hs-manager-key');
        const hsOk = await authenticate(broker.port, { token: hsToken });
        assert.deepStrictEqual(hsOk.ok, { realm: 'org:hs', role: 'both' });

        // Live-callback prefix validator still consulted, with its secret.
        const cbOk = await authenticate(broker.port, { token: 'cb-tok', realm: 'apps:cb:x' });
        assert.deepStrictEqual(cbOk.ok, { realm: 'apps:cb:x', role: 'consumer' });
        assert.strictEqual(callbackRequests.length, 1);
        assert.strictEqual(callbackRequests[0].headers['x-mq-auth-secret'], 'cb-secret');

        // jwks entry works alongside both.
        const jwksOk = await authenticate(broker.port, {
            token: mint(privateKey, 'k1', claims()), realm: REALM
        });
        assert.deepStrictEqual(jwksOk.ok, { realm: REALM, role: 'both' });

        // The jwks token must never hit the callback validator.
        assert.strictEqual(callbackRequests.length, 1);
    } finally {
        await broker.close();
        await stub.close();
        await callbackStub.close();
    }
});

run();

test('lifetime cap cannot be defeated by far-future or non-finite time claims', async () => {
    const { privateKey, publicKey } = makeKeyPair();
    const stub = await startJwksStub([jwkOf(publicKey, 'k1')]);
    try {
        const validator = makeValidator(stub.url);
        const nowSec = Math.floor(Date.now() / 1000);

        // Control: a normal token is accepted.
        assert.ok(await validator.verify(mint(privateKey, 'k1', claims())));

        // Far-future iat sliding the exp-iat window past the cap: rejected.
        assert.strictEqual(await validator.verify(mint(privateKey, 'k1', claims({
            iat: nowSec + 1e9, exp: nowSec + 1e9 + 600
        }))), null);

        // Non-finite time claims (1e999 JSON-parses to Infinity): rejected,
        // not NaN-compared into an eternal token.
        assert.strictEqual(await validator.verify(mint(privateKey, 'k1', claims({
            iat: Infinity, exp: Infinity
        }))), null);
        assert.strictEqual(await validator.verify(mint(privateKey, 'k1', claims({
            exp: Infinity
        }))), null);
        assert.strictEqual(await validator.verify(mint(privateKey, 'k1', claims({
            nbf: Infinity
        }))), null);

        // Slightly-future iat within skew still fine (clock drift).
        assert.ok(await validator.verify(mint(privateKey, 'k1', claims({
            iat: nowSec + 10, exp: nowSec + 10 + 600
        }))));
    } finally {
        await stub.close();
    }
});
