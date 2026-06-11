/**
 * Phase 1 (revised roles): connection authorization rules.
 *
 * - `manager` is a per-realm administration role; manager connections always
 *   require manual authorization (no auto-grant, no pre-shared key).
 * - `consumer` / `both` connect with the realm's pre-shared key; connections
 *   without a realm, or to a realm that does not require a key, are allowed
 *   automatically.
 * - `producer` / `both` must be accepted into the realm unless the realm is
 *   configured with require_acceptance: false.
 *
 * Usage: node tests/phase1-roles-authorization.test.js
 */

'use strict';

const assert = require('assert');
const ioClient = require('socket.io-client');
const Authorization = require('../lib/authorization');
const Factory = require('../lib/factory');
const { test, run } = require('./runner');
const { startServer, delay, waitFor } = require('./helpers');

const ADMIN_TOKEN = 'roles-test-admin-token';

function adminAuth(extra) {
    return Object.assign({
        enabled: true,
        tokens: [
            { token: ADMIN_TOKEN, realm: '*', role: 'admin' }
        ]
    }, extra || {});
}

function connect(port) {
    const socket = ioClient(`http://127.0.0.1:${port}`, { transports: ['websocket'] });
    return waitFor(socket, 'connect').then(() => socket);
}

function authenticate(socket, payload) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('authentication timeout')), 3000);
        function cleanup() {
            clearTimeout(timer);
            socket.off('AUTH_OK', onOk);
            socket.off('AUTH_FAIL', onFail);
        }
        function onOk(info) { cleanup(); resolve({ ok: true, info: info }); }
        function onFail(fail) { cleanup(); resolve({ ok: false, fail: fail }); }
        socket.once('AUTH_OK', onOk);
        socket.once('AUTH_FAIL', onFail);
        socket.emit('AUTHENTICATION', payload);
    });
}

test('manager role always requires manual authorization', async () => {
    const authServer = await startServer({
        auth: adminAuth({
            realms: {
                openrealm: { required: false }
            }
        })
    });
    const options = { host: '127.0.0.1', port: authServer.port, protocol: 'http' };
    let socket;
    let managerSocket;

    try {
        // Even an open realm must not auto-grant the manager role.
        socket = await connect(authServer.port);
        const denied = await authenticate(socket, { realm: 'openrealm', role: 'manager' });
        assert.strictEqual(denied.ok, false);
        assert.strictEqual(denied.fail.code, 401);

        // The manual authorization flow is the only way in.
        const submitted = await Authorization.submitAuthorizationRequest({
            realm: 'openrealm',
            role: 'manager',
            client_id: 'manager-client-1',
            client_name: 'Realm Manager',
            client_token: 'manager-client-token'
        }, options);

        const next = await Authorization.nextAuthorizationRequest(ADMIN_TOKEN, {}, options);
        assert.strictEqual(next.request.request_id, submitted.request_id);
        assert.strictEqual(next.request.role, 'manager');

        await Authorization.decideAuthorizationRequest(ADMIN_TOKEN, {
            request_id: submitted.request_id,
            approved: true,
            role: 'manager'
        }, options);

        managerSocket = await connect(authServer.port);
        const granted = await authenticate(managerSocket, { token: 'manager-client-token' });
        assert.strictEqual(granted.ok, true);
        assert.deepStrictEqual(granted.info, { realm: 'openrealm', role: 'manager' });

        // A manager can act inside its realm (e.g. register a producer).
        const failed = waitFor(managerSocket, 'AUTH_FAIL', 800).then(() => true).catch(() => false);
        managerSocket.emit('PRODUCER', { name: 'manager-producer' });
        assert.strictEqual(await failed, false, 'manager should be allowed to send PRODUCER');
    } finally {
        if (socket) socket.disconnect();
        if (managerSocket) managerSocket.disconnect();
        await authServer.close();
    }
});

test('consumer connects automatically without a realm or realm key', async () => {
    const authServer = await startServer({ auth: adminAuth() });
    let noRealmSocket;
    let realmSocket;

    try {
        noRealmSocket = await connect(authServer.port);
        const noRealm = await authenticate(noRealmSocket, { role: 'consumer' });
        assert.strictEqual(noRealm.ok, true);
        assert.deepStrictEqual(noRealm.info, { realm: 'default', role: 'consumer' });

        realmSocket = await connect(authServer.port);
        const keyless = await authenticate(realmSocket, { realm: 'keyless-realm', role: 'consumer' });
        assert.strictEqual(keyless.ok, true);
        assert.deepStrictEqual(keyless.info, { realm: 'keyless-realm', role: 'consumer' });
    } finally {
        if (noRealmSocket) noRealmSocket.disconnect();
        if (realmSocket) realmSocket.disconnect();
        await authServer.close();
    }
});

test('consumer must present the realm pre-shared key when one is required', async () => {
    const authServer = await startServer({
        auth: adminAuth({
            realms: {
                locked: { key: 'locked-psk' },
                relaxed: { key: 'unused-psk', require_key: false }
            }
        })
    });

    let socket;
    try {
        socket = await connect(authServer.port);
        const missing = await authenticate(socket, { realm: 'locked', role: 'consumer' });
        assert.strictEqual(missing.ok, false);
        assert.strictEqual(missing.fail.code, 401);
        socket.disconnect();

        socket = await connect(authServer.port);
        const wrong = await authenticate(socket, { realm: 'locked', role: 'consumer', key: 'wrong-psk' });
        assert.strictEqual(wrong.ok, false);
        assert.strictEqual(wrong.fail.code, 401);
        socket.disconnect();

        socket = await connect(authServer.port);
        const right = await authenticate(socket, { realm: 'locked', role: 'consumer', key: 'locked-psk' });
        assert.strictEqual(right.ok, true);
        assert.deepStrictEqual(right.info, { realm: 'locked', role: 'consumer' });
        socket.disconnect();

        // require_key: false waives the key even when one is configured.
        socket = await connect(authServer.port);
        const waived = await authenticate(socket, { realm: 'relaxed', role: 'consumer' });
        assert.strictEqual(waived.ok, true);
        assert.deepStrictEqual(waived.info, { realm: 'relaxed', role: 'consumer' });
    } finally {
        if (socket) socket.disconnect();
        await authServer.close();
    }
});

test('producer must be accepted into the realm unless acceptance is waived', async () => {
    const authServer = await startServer({
        auth: adminAuth({
            realms: {
                org: {},
                openprod: { require_acceptance: false }
            }
        })
    });
    const options = { host: '127.0.0.1', port: authServer.port, protocol: 'http' };

    let socket;
    let producer;
    let consumer;
    try {
        socket = await connect(authServer.port);
        const denied = await authenticate(socket, { realm: 'org', role: 'producer' });
        assert.strictEqual(denied.ok, false);
        assert.strictEqual(denied.fail.code, 403);
        socket.disconnect();

        socket = await connect(authServer.port);
        const waived = await authenticate(socket, { realm: 'openprod', role: 'producer' });
        assert.strictEqual(waived.ok, true);
        assert.deepStrictEqual(waived.info, { realm: 'openprod', role: 'producer' });
        socket.disconnect();
        socket = null;

        // Acceptance flow: request → approve → produce end to end.
        const submitted = await Authorization.submitAuthorizationRequest({
            realm: 'org',
            role: 'producer',
            client_id: 'accepted-producer-1',
            client_name: 'Accepted Producer',
            client_token: 'accepted-producer-token'
        }, options);
        await Authorization.decideAuthorizationRequest(ADMIN_TOKEN, {
            request_id: submitted.request_id,
            approved: true,
            role: 'producer'
        }, options);

        const producerClient = new Factory({
            host: '127.0.0.1',
            port: authServer.port,
            protocol: 'http',
            auth: { token: 'accepted-producer-token' }
        });
        // The consumer joins the same realm with no key — automatically allowed.
        const consumerClient = new Factory({
            host: '127.0.0.1',
            port: authServer.port,
            protocol: 'http',
            auth: { realm: 'org', role: 'consumer' }
        });

        producer = await producerClient.createProducer('accepted-producer');
        consumer = await consumerClient.createConsumer('org-consumer');
        assert.deepStrictEqual(producer.authInfo, { realm: 'org', role: 'producer' });
        assert.deepStrictEqual(consumer.authInfo, { realm: 'org', role: 'consumer' });

        const received = await new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('timeout waiting for accepted producer message')), 4000);
            consumer.subscribe(producer.name, 'accepted-event', (data) => {
                clearTimeout(timer);
                resolve(data);
            });
            setTimeout(() => producer.produce('accepted-event', 'accepted-payload'), 500);
        });
        assert.strictEqual(received, 'accepted-payload');
    } finally {
        if (socket) socket.disconnect();
        if (producer) producer.disconnect();
        if (consumer) consumer.disconnect();
        await authServer.close();
    }
});

test('both role is subject to the key and acceptance rules together', async () => {
    const authServer = await startServer({
        auth: adminAuth({
            realms: {
                dual: { key: 'dual-psk' },
                dualopen: { key: 'dual-open-psk', require_acceptance: false }
            }
        })
    });

    let socket;
    try {
        // Key alone is not enough while acceptance is still required.
        socket = await connect(authServer.port);
        const needsAcceptance = await authenticate(socket, { realm: 'dual', role: 'both', key: 'dual-psk' });
        assert.strictEqual(needsAcceptance.ok, false);
        assert.strictEqual(needsAcceptance.fail.code, 403);
        socket.disconnect();

        // Acceptance waived, but the key is still enforced.
        socket = await connect(authServer.port);
        const missingKey = await authenticate(socket, { realm: 'dualopen', role: 'both' });
        assert.strictEqual(missingKey.ok, false);
        assert.strictEqual(missingKey.fail.code, 401);
        socket.disconnect();

        socket = await connect(authServer.port);
        const granted = await authenticate(socket, { realm: 'dualopen', role: 'both', key: 'dual-open-psk' });
        assert.strictEqual(granted.ok, true);
        assert.deepStrictEqual(granted.info, { realm: 'dualopen', role: 'both' });
    } finally {
        if (socket) socket.disconnect();
        await authServer.close();
    }
});

test('management commands maintain realm pre-shared key and acceptance', async () => {
    const authServer = await startServer({ auth: adminAuth() });
    const options = { host: '127.0.0.1', port: authServer.port, protocol: 'http' };

    let socket;
    try {
        await Authorization.authManagementCommand(ADMIN_TOKEN, {
            command: 'add_realm',
            realm: 'managed-roles-realm',
            required: true
        }, options);

        const keySet = await Authorization.authManagementCommand(ADMIN_TOKEN, {
            command: 'set_realm_key',
            realm: 'managed-roles-realm',
            key: 'managed-psk'
        }, options);
        assert.strictEqual(keySet.settings.realms['managed-roles-realm'].key, undefined,
            'raw pre-shared key must not be exposed in settings');
        assert.strictEqual(keySet.settings.realms['managed-roles-realm'].key_configured, true);

        socket = await connect(authServer.port);
        const withKey = await authenticate(socket, { realm: 'managed-roles-realm', role: 'consumer', key: 'managed-psk' });
        assert.strictEqual(withKey.ok, true);
        socket.disconnect();

        socket = await connect(authServer.port);
        const withoutKey = await authenticate(socket, { realm: 'managed-roles-realm', role: 'consumer' });
        assert.strictEqual(withoutKey.ok, false);
        assert.strictEqual(withoutKey.fail.code, 401);
        socket.disconnect();

        // Clearing the key opens consumer connections again.
        await Authorization.authManagementCommand(ADMIN_TOKEN, {
            command: 'set_realm_key',
            realm: 'managed-roles-realm',
            key: null
        }, options);

        socket = await connect(authServer.port);
        const keyCleared = await authenticate(socket, { realm: 'managed-roles-realm', role: 'consumer' });
        assert.strictEqual(keyCleared.ok, true);
        socket.disconnect();

        // Producers are blocked until acceptance is waived for the realm.
        socket = await connect(authServer.port);
        const producerDenied = await authenticate(socket, { realm: 'managed-roles-realm', role: 'producer' });
        assert.strictEqual(producerDenied.ok, false);
        assert.strictEqual(producerDenied.fail.code, 403);
        socket.disconnect();

        const acceptanceOff = await Authorization.authManagementCommand(ADMIN_TOKEN, {
            command: 'set_realm_acceptance',
            realm: 'managed-roles-realm',
            required: false
        }, options);
        assert.strictEqual(acceptanceOff.settings.realms['managed-roles-realm'].require_acceptance, false);

        socket = await connect(authServer.port);
        const producerAllowed = await authenticate(socket, { realm: 'managed-roles-realm', role: 'producer' });
        assert.strictEqual(producerAllowed.ok, true);
        assert.deepStrictEqual(producerAllowed.info, { realm: 'managed-roles-realm', role: 'producer' });
    } finally {
        if (socket) socket.disconnect();
        await authServer.close();
    }
});

run();
