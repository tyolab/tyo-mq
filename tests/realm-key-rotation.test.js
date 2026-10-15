'use strict';
/**
 * Realm secrets: pre-shared keys HASHED at rest, and rotation WITH OVERLAP for
 * both the pre-shared key and the realm manager key.
 *
 * Why (2026-10-15): the realm `key` was stored raw in the settings file / auth
 * store, so a leaked dump or an operator's scroll-back handed out a working
 * credential; and replacing either secret was a flag day — the old value
 * stopped working the instant the new one landed. These tests pin:
 *  - a raw key never reaches disk (store rows carry key_hash only), including
 *    rows that ALREADY held a raw key before this change (one-way migration);
 *  - the presented key is checked against the hash (right key in, wrong key
 *    out, no key out);
 *  - set_realm_key {key, grace} keeps the previous key working until the
 *    window lapses, a rotation without grace drops it, and an expired window
 *    is dead;
 *  - the same for set_realm_manager_key, proven through realm-scoped proofs;
 *  - the manager `get` view never exposes a hash or a previous secret.
 *
 * Usage: node tests/realm-key-rotation.test.js
 */
const assert = require('assert');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { test, run } = require('./runner');
const { startServer, delay } = require('./helpers');
const ioc = require('socket.io-client');
const adminSignature = require('tyo-mq-protocol').adminSignature;
const RealmKeys = require('../lib/realm-keys');
const AuthStore = require('../lib/auth-store');

const ADMIN_TOKEN = 'rotation-admin-token';

function tmpDb() {
    return path.join(os.tmpdir(), 'tyo-auth-rotation-' + process.pid + '-' + Math.floor(Math.random() * 1e9) + '.sqlite');
}
function cleanup(file) {
    for (const suffix of ['', '-wal', '-shm']) { try { fs.unlinkSync(file + suffix); } catch (e) {} }
}
function serverOptions(storeFile, realms) {
    return {
        http_api: { enabled: true },   // POST /api/realms is opt-in; without it the harness http server has no request listener
        auth: {
            enabled: true,
            tokens: [{ token: ADMIN_TOKEN, realm: '*', role: 'admin' }],
            realms: realms || {},
        },
        auth_store: { filename: storeFile },
    };
}
// Raw-socket AUTHENTICATION: resolves 'ok' | 'fail'.
function authenticate(port, payload) {
    const s = ioc('http://127.0.0.1:' + port, { transports: ['websocket'], forceNew: true, reconnection: false });
    return new Promise((resolve, reject) => {
        const done = (v) => { s.disconnect(); resolve(v); };
        s.on('connect_error', reject);
        s.on('AUTH_OK', () => done('ok'));
        s.on('AUTH_FAIL', () => done('fail'));
        s.on('connect', () => s.emit('AUTHENTICATION', payload));
    });
}
// One signed management command; `secret` is the admin token (global) or a
// realm's manager key (realm-scoped).
function command(port, body, secret) {
    const s = ioc('http://127.0.0.1:' + port, { transports: ['websocket'], forceNew: true, reconnection: false });
    return new Promise((resolve, reject) => {
        s.on('connect_error', reject);
        s.on('connect', () => {
            const payload = { body, proof: adminSignature.createAdminProof(secret || ADMIN_TOKEN, 'AUTH_MANAGEMENT_COMMAND', body) };
            s.emit('AUTH_MANAGEMENT_COMMAND', payload, (res) => { s.disconnect(); resolve(res); });
        });
    });
}
function storedRealm(file, name) {
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(file, { readOnly: true });
    const row = db.prepare("SELECT json_extract(config,'$.key') AS key, json_extract(config,'$.key_hash') AS key_hash, json_extract(config,'$.previous_key_hash') AS prev FROM realms WHERE name = ?").get(name);
    db.close();
    return row;
}

// ── unit ───────────────────────────────────────────────────────────────────

test('realm-keys: hashing is domain-separated, prefixed, constant-time compared, and never matches a wrong/empty key', () => {
    const h = RealmKeys.hashRealmKey('alpha-psk-1');
    assert.ok(RealmKeys.isRealmKeyHash(h));
    assert.ok(h.startsWith('sha256:') && h.length === 7 + 64);
    assert.notStrictEqual(h, 'sha256:' + require('crypto').createHash('sha256').update('alpha-psk-1').digest('hex'), 'domain-separated');
    assert.strictEqual(RealmKeys.realmKeyMatches('alpha-psk-1', h), true);
    assert.strictEqual(RealmKeys.realmKeyMatches('alpha-psk-2', h), false);
    assert.strictEqual(RealmKeys.realmKeyMatches('', h), false);
    assert.strictEqual(RealmKeys.realmKeyMatches('alpha-psk-1', 'alpha-psk-1'), false, 'a raw stored value never matches');
});

test('realm-keys: normalizeRealmConfig hashes a raw key one-way and drops expired previous_* only', () => {
    const rc = { required: true, key: 'raw', previous_key_hash: 'sha256:' + 'a'.repeat(64), previous_key_until: new Date(Date.now() - 1000).toISOString(),
        manager_key: 'mk', previous_manager_key: 'old-mk', previous_manager_until: new Date(Date.now() + 60000).toISOString() };
    assert.strictEqual(RealmKeys.normalizeRealmConfig(rc), true);
    assert.strictEqual(rc.key, undefined);
    assert.ok(RealmKeys.isRealmKeyHash(rc.key_hash));
    assert.strictEqual(rc.previous_key_hash, undefined, 'expired previous PSK dropped');
    assert.strictEqual(rc.previous_manager_key, 'old-mk', 'live previous manager key kept');
    assert.strictEqual(RealmKeys.normalizeRealmConfig(rc), false, 'idempotent');
    assert.strictEqual(RealmKeys.clampGraceMs(999 * 24 * 3600 * 1000), RealmKeys.MAX_GRACE_MS);
    assert.strictEqual(RealmKeys.clampGraceMs(0), null);
});

// ── integration ────────────────────────────────────────────────────────────

test('a configured raw key is stored hashed, never raw; right key in, wrong key out, no key out', async () => {
    const file = tmpDb();
    const srv = await startServer(serverOptions(file, { alpha: { required: true, key: 'alpha-psk-1' } }));
    try {
        await delay(100);
        const live = srv.server.authOptions.realms.alpha;
        assert.strictEqual(live.key, undefined, 'raw key gone from memory');
        assert.ok(RealmKeys.isRealmKeyHash(live.key_hash));
        const row = storedRealm(file, 'alpha');
        assert.strictEqual(row.key, null, 'raw key never reaches disk');
        assert.ok(RealmKeys.isRealmKeyHash(row.key_hash));

        assert.strictEqual(await authenticate(srv.port, { realm: 'alpha', role: 'consumer', key: 'alpha-psk-1' }), 'ok');
        assert.strictEqual(await authenticate(srv.port, { realm: 'alpha', role: 'consumer', key: 'alpha-psk-X' }), 'fail');
        assert.strictEqual(await authenticate(srv.port, { realm: 'alpha', role: 'consumer' }), 'fail');
    } finally { await srv.close(); cleanup(file); }
});

test('a store row that already held a RAW key is migrated one-way on boot and still opens the realm', async () => {
    const file = tmpDb();
    const seed = new AuthStore({ filename: file });
    seed.sync({ realms: { gamma: { required: true, key: 'raw-gamma' } }, tokens: [], management_tokens: [] });
    try { seed.close(); } catch (e) {}
    assert.strictEqual(storedRealm(file, 'gamma').key, 'raw-gamma', 'precondition: raw on disk');

    const srv = await startServer(serverOptions(file));
    try {
        await delay(150);
        const row = storedRealm(file, 'gamma');
        assert.strictEqual(row.key, null, 'migrated: raw key removed from the row');
        assert.ok(RealmKeys.isRealmKeyHash(row.key_hash));
        assert.strictEqual(await authenticate(srv.port, { realm: 'gamma', role: 'consumer', key: 'raw-gamma' }), 'ok');
    } finally { await srv.close(); cleanup(file); }
});

test('set_realm_key with grace: old + new both open the realm; without grace the old one dies; an expired window is dead', async () => {
    const file = tmpDb();
    const srv = await startServer(serverOptions(file, { alpha: { required: true, key: 'k1' } }));
    try {
        const r1 = await command(srv.port, { command: 'set_realm_key', realm: 'alpha', key: 'k2', grace: '1h' });
        assert.strictEqual(r1.ok, true, JSON.stringify(r1));
        assert.strictEqual(await authenticate(srv.port, { realm: 'alpha', role: 'consumer', key: 'k1' }), 'ok', 'previous key accepted inside grace');
        assert.strictEqual(await authenticate(srv.port, { realm: 'alpha', role: 'consumer', key: 'k2' }), 'ok');
        assert.strictEqual(await authenticate(srv.port, { realm: 'alpha', role: 'consumer', key: 'kX' }), 'fail');
        const row = storedRealm(file, 'alpha');
        assert.ok(RealmKeys.isRealmKeyHash(row.prev), 'previous key persisted as a hash');

        const r2 = await command(srv.port, { command: 'set_realm_key', realm: 'alpha', key: 'k3' });
        assert.strictEqual(r2.ok, true);
        assert.strictEqual(await authenticate(srv.port, { realm: 'alpha', role: 'consumer', key: 'k1' }), 'fail', 'two rotations back is gone');
        assert.strictEqual(await authenticate(srv.port, { realm: 'alpha', role: 'consumer', key: 'k2' }), 'fail', 'no grace → previous dropped');
        assert.strictEqual(await authenticate(srv.port, { realm: 'alpha', role: 'consumer', key: 'k3' }), 'ok');

        const r3 = await command(srv.port, { command: 'set_realm_key', realm: 'alpha', key: 'k4', grace: '1s' });
        assert.strictEqual(r3.ok, true);
        assert.strictEqual(await authenticate(srv.port, { realm: 'alpha', role: 'consumer', key: 'k3' }), 'ok');
        await delay(1300);
        assert.strictEqual(await authenticate(srv.port, { realm: 'alpha', role: 'consumer', key: 'k3' }), 'fail', 'grace lapsed');
        assert.strictEqual(await authenticate(srv.port, { realm: 'alpha', role: 'consumer', key: 'k4' }), 'ok');

        const bad = await command(srv.port, { command: 'set_realm_key', realm: 'alpha', key: 'k5', grace: 'soon' });
        assert.strictEqual(bad.ok, false);
        assert.strictEqual(bad.code, 400);

        // clearing with require_key:true → token-less consumers always refused
        const clr = await command(srv.port, { command: 'set_realm_key', realm: 'alpha', require_key: true });
        assert.strictEqual(clr.ok, true);
        assert.strictEqual(await authenticate(srv.port, { realm: 'alpha', role: 'consumer', key: 'k4' }), 'fail');
        assert.strictEqual(storedRealm(file, 'alpha').key_hash, null);
    } finally { await srv.close(); cleanup(file); }
});

test('set_realm_manager_key with grace: proofs signed with the previous key verify until the window lapses or the next rotation', async () => {
    const file = tmpDb();
    const srv = await startServer(serverOptions(file, { beta: { required: true, manager_key: 'mk-1' } }));
    try {
        const scoped = (secret) => command(srv.port, { command: 'set_realm_e2ee', realm: 'beta', e2ee: 'opportunistic' }, secret);
        assert.strictEqual((await scoped('mk-1')).ok, true, 'realm-scoped proof with the current key');
        assert.strictEqual((await scoped('mk-X')).ok, false);

        const rot = await command(srv.port, { command: 'set_realm_manager_key', realm: 'beta', manager_key: 'mk-2', grace: '1h' });
        assert.strictEqual(rot.ok, true, JSON.stringify(rot));
        assert.strictEqual((await scoped('mk-1')).ok, true, 'previous manager key still verifies inside grace');
        assert.strictEqual((await scoped('mk-2')).ok, true);

        const rot2 = await command(srv.port, { command: 'set_realm_manager_key', realm: 'beta', manager_key: 'mk-3' });
        assert.strictEqual(rot2.ok, true);
        assert.strictEqual((await scoped('mk-1')).ok, false);
        assert.strictEqual((await scoped('mk-2')).ok, false, 'no grace → previous dropped');
        assert.strictEqual((await scoped('mk-3')).ok, true);

        const rot3 = await command(srv.port, { command: 'set_realm_manager_key', realm: 'beta', manager_key: 'mk-4', grace: '1s' });
        assert.strictEqual(rot3.ok, true);
        assert.strictEqual((await scoped('mk-3')).ok, true);
        await delay(1300);
        assert.strictEqual((await scoped('mk-3')).ok, false, 'grace lapsed');
        assert.strictEqual((await scoped('mk-4')).ok, true);
    } finally { await srv.close(); cleanup(file); }
});

// Per-realm JWTs are HS256-signed with the realm's manager key (tyoman-api
// mints its users' tokens that way), so a graceful rotation must keep tokens
// minted with the PREVIOUS key alive until the window lapses — otherwise every
// in-flight user token dies at rotation, which is the flag day being removed.
function createJwt(payload, secret) {
    const b64 = (v) => Buffer.from(v).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
    const header = b64(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
    const body = b64(JSON.stringify(payload));
    const sig = require('crypto').createHmac('sha256', secret).update(header + '.' + body).digest();
    return header + '.' + body + '.' + b64(sig);
}

test('per-realm JWTs signed with the previous manager key keep verifying inside the rotation grace window', async () => {
    const file = tmpDb();
    const srv = await startServer(serverOptions(file, { beta: { required: true, manager_key: 'mk-1' } }));
    try {
        const tokenWith = (secret) => createJwt({ realm: 'beta', role: 'both', exp: Math.floor(Date.now() / 1000) + 60 }, secret);
        assert.strictEqual(await authenticate(srv.port, { token: tokenWith('mk-1') }), 'ok');
        assert.strictEqual(await authenticate(srv.port, { token: tokenWith('mk-X') }), 'fail');

        assert.strictEqual((await command(srv.port, { command: 'set_realm_manager_key', realm: 'beta', manager_key: 'mk-2', grace: '1h' })).ok, true);
        assert.strictEqual(await authenticate(srv.port, { token: tokenWith('mk-1') }), 'ok', 'token minted with the previous key survives the rotation');
        assert.strictEqual(await authenticate(srv.port, { token: tokenWith('mk-2') }), 'ok');

        assert.strictEqual((await command(srv.port, { command: 'set_realm_manager_key', realm: 'beta', manager_key: 'mk-3' })).ok, true);
        assert.strictEqual(await authenticate(srv.port, { token: tokenWith('mk-1') }), 'fail');
        assert.strictEqual(await authenticate(srv.port, { token: tokenWith('mk-2') }), 'fail', 'no grace → previous dropped');
        assert.strictEqual(await authenticate(srv.port, { token: tokenWith('mk-3') }), 'ok');
    } finally { await srv.close(); cleanup(file); }
});

test('set_realm_push is realm-scoped: a realm manager key may set its own realm\'s push policy, and only its own', async () => {
    const file = tmpDb();
    const srv = await startServer(serverOptions(file, { beta: { required: true, manager_key: 'mk-beta' }, other: { required: true, manager_key: 'mk-other' } }));
    try {
        const own = await command(srv.port, { command: 'set_realm_push', realm: 'beta', default_wake: 'alert', alert: { title: 'Beta', body: 'New message' } }, 'mk-beta');
        assert.strictEqual(own.ok, true, JSON.stringify(own));
        assert.strictEqual(srv.server.authOptions.realms.beta.push.default_wake, 'alert');
        assert.strictEqual(srv.server.authOptions.realms.beta.push.alert.title, 'Beta');

        const foreign = await command(srv.port, { command: 'set_realm_push', realm: 'other', default_wake: 'alert' }, 'mk-beta');
        assert.strictEqual(foreign.ok, false, 'a realm manager key cannot touch another realm');
        assert.strictEqual(srv.server.authOptions.realms.other.push, undefined);
    } finally { await srv.close(); cleanup(file); }
});

// ── management tokens hashed at rest ───────────────────────────────────────

function postRealm(port, bearer, body) {
    return new Promise((resolve, reject) => {
        const req = require('http').request({
            host: '127.0.0.1', port, path: '/api/realms', method: 'POST',
            headers: { 'content-type': 'application/json', 'authorization': 'Bearer ' + bearer },
        }, (res) => { let c = ''; res.on('data', (d) => { c += d; }); res.on('end', () => resolve({ status: res.statusCode, body: c })); });
        req.on('error', reject);
        req.end(JSON.stringify(body));
    });
}
function storedManagementTokens(file) {
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(file, { readOnly: true });
    const rows = db.prepare('SELECT token AS key, entry FROM management_tokens').all().map((r) => ({ key: r.key, entry: JSON.parse(r.entry) }));
    db.close();
    return rows;
}
const sha256 = (s) => require('crypto').createHash('sha256').update(s).digest('hex');

test('a management token is stored only as token_hash, still authorises POST /api/realms, and get shows the hash only', async () => {
    const file = tmpDb();
    const srv = await startServer(serverOptions(file));
    try {
        const added = await command(srv.port, { command: 'add_management_token', token: 'mgmt-raw-1', realm_prefix: 'apps:hilia:' });
        assert.strictEqual(added.ok, true, JSON.stringify(added));
        await delay(100);
        const rows = storedManagementTokens(file);
        assert.strictEqual(rows.length, 1);
        assert.strictEqual(rows[0].key, sha256('mgmt-raw-1'), 'row keyed by the hash');
        assert.strictEqual(rows[0].entry.token, undefined, 'raw bearer never reaches disk');
        assert.strictEqual(rows[0].entry.token_hash, sha256('mgmt-raw-1'));
        assert.strictEqual(JSON.stringify(srv.server.authOptions.management_tokens).indexOf('mgmt-raw-1'), -1, 'raw bearer not held in memory either');

        const ok = await postRealm(srv.port, 'mgmt-raw-1', { realm: 'apps:hilia:rooms', manager_key: 'mk-rooms' });
        assert.strictEqual(ok.status, 200, ok.body);
        const outside = await postRealm(srv.port, 'mgmt-raw-1', { realm: 'apps:other:x', manager_key: 'mk' });
        assert.strictEqual(outside.status, 403);
        const wrong = await postRealm(srv.port, 'mgmt-raw-X', { realm: 'apps:hilia:rooms2', manager_key: 'mk' });
        assert.strictEqual(wrong.status, 401);

        const got = await command(srv.port, { command: 'get' });
        assert.strictEqual(got.settings.management_tokens.length, 1);
        assert.strictEqual(got.settings.management_tokens[0].token_hash, sha256('mgmt-raw-1'));
        assert.strictEqual(got.settings.management_tokens[0].token, undefined);

        // revoke by the hash the operator sees
        const rev = await command(srv.port, { command: 'revoke_management_token', token_hash: sha256('mgmt-raw-1') });
        assert.strictEqual(rev.ok, true);
        // With no management tokens left the endpoint hides itself (404); with
        // others still configured a revoked bearer gets 401. Either way: refused.
        const afterRevoke = (await postRealm(srv.port, 'mgmt-raw-1', { realm: 'apps:hilia:rooms3', manager_key: 'mk' })).status;
        assert.ok(afterRevoke === 401 || afterRevoke === 404, 'revoked bearer refused, got ' + afterRevoke);
    } finally { await srv.close(); cleanup(file); }
});

test('a management token already stored RAW is migrated to token_hash on boot and keeps working', async () => {
    const file = tmpDb();
    const seed = new AuthStore({ filename: file });
    seed.sync({ realms: {}, tokens: [], management_tokens: [{ token: 'legacy-mgmt', realm_prefix: 'apps:legacy:' }] });
    try { seed.close(); } catch (e) {}
    assert.ok(storedManagementTokens(file).some((r) => r.entry.token === 'legacy-mgmt'), 'precondition: raw on disk');

    const srv = await startServer(serverOptions(file));
    try {
        await delay(150);
        const rows = storedManagementTokens(file);
        assert.ok(!rows.some((r) => r.entry.token !== undefined), 'no raw bearer left on disk');
        assert.ok(rows.some((r) => r.entry.token_hash === sha256('legacy-mgmt') && r.entry.realm_prefix === 'apps:legacy:'), 'migrated entry present');
        const ok = await postRealm(srv.port, 'legacy-mgmt', { realm: 'apps:legacy:r1', manager_key: 'mk' });
        assert.strictEqual(ok.status, 200, ok.body);
    } finally { await srv.close(); cleanup(file); }
});

test('the manager view (get) exposes neither a key hash nor a previous secret', async () => {
    const file = tmpDb();
    const srv = await startServer(serverOptions(file, { alpha: { required: true, key: 'k1', manager_key: 'mk-1' } }));
    try {
        await command(srv.port, { command: 'set_realm_key', realm: 'alpha', key: 'k2', grace: '1h' });
        await command(srv.port, { command: 'set_realm_manager_key', realm: 'alpha', manager_key: 'mk-2', grace: '1h' });
        const res = await command(srv.port, { command: 'get' });
        assert.strictEqual(res.ok, true);
        const view = res.settings.realms.alpha;
        assert.strictEqual(view.key_configured, true);
        assert.strictEqual(view.previous_key_configured, true);
        assert.strictEqual(view.manager_key_configured, true);
        assert.strictEqual(view.previous_manager_key_configured, true);
        ['key', 'key_hash', 'previous_key_hash', 'manager_key', 'previous_manager_key'].forEach((k) =>
            assert.ok(!(k in view), 'manager view leaked ' + k));
        assert.ok(view.previous_key_until && view.previous_manager_until, 'the (non-secret) deadlines are visible');
    } finally { await srv.close(); cleanup(file); }
});

run();
