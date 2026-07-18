/**
 * Phase 1: authentication, roles, and realm isolation.
 *
 * Usage: node tests/phase1-auth-realms.test.js
 */

'use strict';

const assert = require('assert');
const childProcess = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const Authorization = require('../lib/authorization');
const Factory = require('../lib/factory');
const { test, run } = require('./runner');
const { startServer, delay, waitFor } = require('./helpers');

function base64Url(value) {
    return Buffer.from(value).toString('base64')
        .replace(/=/g, '')
        .replace(/\+/g, '-')
        .replace(/\//g, '_');
}

function createJwt(payload, secret) {
    const header = base64Url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
    const body = base64Url(JSON.stringify(payload));
    const signature = base64Url(crypto.createHmac('sha256', secret).update(`${header}.${body}`).digest());
    return `${header}.${body}.${signature}`;
}

function execFile(command, args, options) {
    return new Promise((resolve, reject) => {
        childProcess.execFile(command, args, options, (err, stdout, stderr) => {
            if (err) {
                err.stdout = stdout;
                err.stderr = stderr;
                reject(err);
                return;
            }
            resolve({stdout, stderr});
        });
    });
}

test('auth rejects unauthenticated protocol events', async () => {
    const authServer = await startServer({
        auth: {
            enabled: true,
            tokens: [
                { token: 'secret-acme-prod', realm: 'acme', role: 'producer' }
            ]
        }
    });
    const ioClient = require('socket.io-client');
    const socket = ioClient(`http://127.0.0.1:${authServer.port}`, { transports: ['websocket'] });

    try {
        await waitFor(socket, 'connect');
        const fail = waitFor(socket, 'AUTH_FAIL');
        socket.emit('PRODUCER', { name: 'unauthenticated-producer' });
        const response = await fail;
        assert.strictEqual(response.code, 401);
    } finally {
        socket.disconnect();
        await authServer.close();
    }
});

test('auth accepts configured opaque tokens and enforces roles', async () => {
    const authServer = await startServer({
        auth: {
            enabled: true,
            tokens: [
                { token: 'secret-acme-prod', realm: 'acme', role: 'producer' },
                { token: 'secret-acme-cons', realm: 'acme', role: 'consumer' }
            ]
        }
    });

    const producerClient = new Factory({
        host: '127.0.0.1',
        port: authServer.port,
        protocol: 'http',
        auth: { token: 'secret-acme-prod' }
    });
    const consumerClient = new Factory({
        host: '127.0.0.1',
        port: authServer.port,
        protocol: 'http',
        auth: { token: 'secret-acme-cons' }
    });
    const ioClient = require('socket.io-client');

    let producer;
    let consumer;
    let roleSocket;
    try {
        producer = await producerClient.createProducer('auth-producer');
        consumer = await consumerClient.createConsumer('auth-consumer');

        assert.deepStrictEqual(producer.authInfo, { realm: 'acme', role: 'producer' });
        assert.deepStrictEqual(consumer.authInfo, { realm: 'acme', role: 'consumer' });

        const received = await new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('timeout waiting for authenticated message')), 4000);
            consumer.subscribe(producer.name, 'auth-event', (data) => {
                clearTimeout(timer);
                resolve(data);
            });
            setTimeout(() => producer.produce('auth-event', 'authenticated'), 500);
        });
        assert.strictEqual(received, 'authenticated');

        roleSocket = ioClient(`http://127.0.0.1:${authServer.port}`, { transports: ['websocket'] });
        await waitFor(roleSocket, 'connect');
        roleSocket.emit('AUTHENTICATION', { token: 'secret-acme-cons' });
        await waitFor(roleSocket, 'AUTH_OK');
        const fail = waitFor(roleSocket, 'AUTH_FAIL');
        roleSocket.emit('PRODUCER', { name: 'not-allowed' });
        const response = await fail;
        assert.strictEqual(response.code, 403);
    } finally {
        if (producer) producer.disconnect();
        if (consumer) consumer.disconnect();
        if (roleSocket) roleSocket.disconnect();
        await authServer.close();
    }
});

test('realms isolate producers and consumers with the same names', async () => {
    const authServer = await startServer({
        auth: {
            enabled: true,
            tokens: [
                { token: 'secret-acme-both', realm: 'acme', role: 'both' },
                { token: 'secret-beta-both', realm: 'beta', role: 'both' }
            ]
        }
    });

    const acmeClient = new Factory({
        host: '127.0.0.1',
        port: authServer.port,
        protocol: 'http',
        auth: { token: 'secret-acme-both' }
    });
    const betaClient = new Factory({
        host: '127.0.0.1',
        port: authServer.port,
        protocol: 'http',
        auth: { token: 'secret-beta-both' }
    });

    let acmeProducer;
    let betaConsumer;
    try {
        acmeProducer = await acmeClient.createProducer('shared-producer');
        betaConsumer = await betaClient.createConsumer('shared-consumer');

        let leaked = false;
        betaConsumer.subscribe('shared-producer', 'realm-event', () => {
            leaked = true;
        });
        await delay(300);
        acmeProducer.produce('realm-event', 'must-not-cross');
        await delay(1000);

        assert.strictEqual(leaked, false, 'beta consumer should not receive acme producer messages');
    } finally {
        if (acmeProducer) acmeProducer.disconnect();
        if (betaConsumer) betaConsumer.disconnect();
        await authServer.close();
    }
});

test('superadmin realm can monitor messages across realms', async () => {
    const authServer = await startServer({
        auth: {
            enabled: true,
            tokens: [
                { token: 'secret-acme-both', realm: 'acme', role: 'both' },
                { token: 'secret-admin', realm: '*', role: 'admin' }
            ]
        }
    });

    const acmeClient = new Factory({
        host: '127.0.0.1',
        port: authServer.port,
        protocol: 'http',
        auth: { token: 'secret-acme-both' }
    });
    const adminClient = new Factory({
        host: '127.0.0.1',
        port: authServer.port,
        protocol: 'http',
        auth: { token: 'secret-admin' }
    });

    let acmeProducer;
    let adminConsumer;
    try {
        acmeProducer = await acmeClient.createProducer('admin-visible-producer');
        adminConsumer = await adminClient.createConsumer('admin-monitor');

        const received = await new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('timeout waiting for superadmin monitor message')), 4000);
            adminConsumer.subscribe(acmeProducer.name, 'admin-event', (data) => {
                clearTimeout(timer);
                resolve(data);
            });
            setTimeout(() => acmeProducer.produce('admin-event', 'visible-to-admin'), 500);
        });

        assert.strictEqual(received, 'visible-to-admin');
    } finally {
        if (acmeProducer) acmeProducer.disconnect();
        if (adminConsumer) adminConsumer.disconnect();
        await authServer.close();
    }
});

test('auth accepts HS256 JWT tokens with realm and role claims', async () => {
    const secret = 'jwt-test-secret';
    const token = createJwt({
        realm: 'jwt-realm',
        role: 'both',
        exp: Math.floor(Date.now() / 1000) + 60
    }, secret);
    const authServer = await startServer({
        auth: {
            enabled: true,
            jwt_secret: secret
        }
    });
    const client = new Factory({
        host: '127.0.0.1',
        port: authServer.port,
        protocol: 'http',
        auth: { token }
    });

    let producer;
    try {
        producer = await client.createProducer('jwt-producer');
        assert.deepStrictEqual(producer.authInfo, { realm: 'jwt-realm', role: 'both' });
    } finally {
        if (producer) producer.disconnect();
        await authServer.close();
    }
});

test('auth verifies a JWT against the realm manager_key (no global jwt_secret)', async () => {
    const managerKey = 'alpha-realm-manager-key';
    const token = createJwt({
        realm: 'alpha',
        role: 'both',
        exp: Math.floor(Date.now() / 1000) + 60
    }, managerKey);
    const authServer = await startServer({
        auth: {
            enabled: true,
            realms: { alpha: { required: true, manager_key: managerKey } }
        }
    });
    const ioClient = require('socket.io-client');
    const socket = ioClient(`http://127.0.0.1:${authServer.port}`, { transports: ['websocket'] });
    try {
        await waitFor(socket, 'connect');
        socket.emit('AUTHENTICATION', { token });
        const authOk = await waitFor(socket, 'AUTH_OK');
        assert.deepStrictEqual(authOk, { realm: 'alpha', role: 'both' });
    } finally {
        socket.disconnect();
        await authServer.close();
    }
});

test('auth rejects a JWT signed with the wrong realm key', async () => {
    const token = createJwt({
        realm: 'alpha',
        role: 'both',
        exp: Math.floor(Date.now() / 1000) + 60
    }, 'not-the-realm-key');
    const authServer = await startServer({
        auth: {
            enabled: true,
            realms: { alpha: { required: true, manager_key: 'alpha-realm-manager-key' } }
        }
    });
    const ioClient = require('socket.io-client');
    const socket = ioClient(`http://127.0.0.1:${authServer.port}`, { transports: ['websocket'] });
    try {
        await waitFor(socket, 'connect');
        socket.emit('AUTHENTICATION', { token });
        const fail = await waitFor(socket, 'AUTH_FAIL');
        assert.strictEqual(fail.code, 401);
    } finally {
        socket.disconnect();
        await authServer.close();
    }
});

test('auth rejects a realm JWT when the realm has no manager_key and no global secret', async () => {
    const token = createJwt({
        realm: 'alpha',
        role: 'both',
        exp: Math.floor(Date.now() / 1000) + 60
    }, 'some-secret');
    const authServer = await startServer({
        auth: {
            enabled: true,
            realms: { alpha: { required: true } }
        }
    });
    const ioClient = require('socket.io-client');
    const socket = ioClient(`http://127.0.0.1:${authServer.port}`, { transports: ['websocket'] });
    try {
        await waitFor(socket, 'connect');
        socket.emit('AUTHENTICATION', { token });
        const fail = await waitFor(socket, 'AUTH_FAIL');
        assert.strictEqual(fail.code, 401);
    } finally {
        socket.disconnect();
        await authServer.close();
    }
});

test('server generates missing admin token in .env and helper authenticates with it', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tyo-mq-auth-'));
    const envFile = path.join(tmpDir, '.env');
    const originalAdminToken = process.env.TYO_MQ_ADMIN_TOKEN;
    delete process.env.TYO_MQ_ADMIN_TOKEN;
    const authServer = await startServer({
        auth: {
            enabled: true,
            env_file: envFile
        }
    });

    try {
        const rawEnv = fs.readFileSync(envFile, 'utf8');
        assert.ok(/TYO_MQ_ADMIN_TOKEN=/.test(rawEnv), 'server should create TYO_MQ_ADMIN_TOKEN in .env');

        const result = await execFile(process.execPath, [
            'scripts/admin-auth.js',
            '-p', String(authServer.port),
            '--env-file', envFile
        ], {
            cwd: path.resolve(__dirname, '..'),
            timeout: 7000
        });

        assert.ok(result.stdout.includes('AUTH_OK'), result.stdout);
        assert.ok(result.stdout.includes('"realm":"*"'), result.stdout);
        assert.ok(result.stdout.includes('"role":"admin"'), result.stdout);
    } finally {
        await authServer.close();
        if (originalAdminToken === undefined)
            delete process.env.TYO_MQ_ADMIN_TOKEN;
        else
            process.env.TYO_MQ_ADMIN_TOKEN = originalAdminToken;
        fs.rmSync(tmpDir, {recursive: true, force: true});
    }
});

test('server accepts provided admin token when auto generation is disabled', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tyo-mq-auth-'));
    const envFile = path.join(tmpDir, '.env');
    const adminToken = 'provided-admin-token';
    const originalAdminToken = process.env.TYO_MQ_ADMIN_TOKEN;
    process.env.TYO_MQ_ADMIN_TOKEN = adminToken;

    const authServer = await startServer({
        auth: {
            enabled: true,
            env_file: envFile,
            auto_admin_token: false
        }
    });
    const ioClient = require('socket.io-client');
    const socket = ioClient(`http://127.0.0.1:${authServer.port}`, { transports: ['websocket'] });

    try {
        await waitFor(socket, 'connect');
        socket.emit('AUTHENTICATION', { token: adminToken });
        const authOk = await waitFor(socket, 'AUTH_OK');
        assert.deepStrictEqual(authOk, { realm: '*', role: 'admin' });
        assert.strictEqual(fs.existsSync(envFile), false, 'server should not create .env when token is already provided');
    } finally {
        socket.disconnect();
        await authServer.close();
        if (originalAdminToken === undefined)
            delete process.env.TYO_MQ_ADMIN_TOKEN;
        else
            process.env.TYO_MQ_ADMIN_TOKEN = originalAdminToken;
        fs.rmSync(tmpDir, {recursive: true, force: true});
    }
});

test('manager signs authorization approval without sending admin token', async () => {
    const adminToken = 'secret-admin';
    const clientToken = 'requested-client-token';
    const authServer = await startServer({
        auth: {
            enabled: true,
            tokens: [
                { token: adminToken, realm: '*', role: 'admin' }
            ]
        }
    });
    const options = {host: '127.0.0.1', port: authServer.port, protocol: 'http'};

    try {
        const submitted = await Authorization.submitAuthorizationRequest({
            realm: 'managed-realm',
            role: 'consumer',
            client_id: 'managed-client-1',
            client_name: 'Managed Client',
            client_token: clientToken,
            challenge_response: {challenge: 'ticket-123', response: 'approved-by-helpdesk'}
        }, options);
        assert.ok(submitted.request_id);

        const invalid = await Authorization.nextAuthorizationRequest('wrong-admin-token', {}, options)
            .then(() => null)
            .catch(err => err.response);
        assert.strictEqual(invalid.code, 401);

        const next = await Authorization.nextAuthorizationRequest(adminToken, {}, options);
        assert.strictEqual(next.request.request_id, submitted.request_id);
        assert.strictEqual(next.request.realm, 'managed-realm');
        assert.strictEqual(next.request.client_id, 'managed-client-1');
        assert.ok(!next.request.client_token, 'manager response should not expose raw client token');

        const decision = await Authorization.decideAuthorizationRequest(adminToken, {
            request_id: submitted.request_id,
            approved: true,
            role: 'consumer'
        }, options);
        assert.strictEqual(decision.request.status, 'approved');

        const client = new Factory({
            host: '127.0.0.1',
            port: authServer.port,
            protocol: 'http',
            auth: {token: clientToken}
        });
        const consumer = await client.createConsumer('managed-client-consumer');
        assert.deepStrictEqual(consumer.authInfo, {realm: 'managed-realm', role: 'consumer'});
        consumer.disconnect();
    } finally {
        await authServer.close();
    }
});

test('realm manager key approves only its own realm authorization requests', async () => {
    const adminToken = 'secret-admin';
    const alphaManagerKey = 'alpha-manager-key';
    const betaManagerKey = 'beta-manager-key';
    const alphaClientToken = 'alpha-requested-client-token';
    const betaClientToken = 'beta-requested-client-token';
    const authServer = await startServer({
        auth: {
            enabled: true,
            realms: {
                alpha: {
                    required: true,
                    manager_key: alphaManagerKey
                },
                beta: {
                    required: true,
                    manager_key: betaManagerKey
                }
            },
            tokens: [
                { token: adminToken, realm: '*', role: 'admin' }
            ]
        }
    });
    const options = {host: '127.0.0.1', port: authServer.port, protocol: 'http'};

    try {
        const alphaSubmitted = await Authorization.submitAuthorizationRequest({
            realm: 'alpha',
            role: 'consumer',
            client_id: 'alpha-client',
            client_name: 'Alpha Client',
            client_token: alphaClientToken
        }, options);
        const betaSubmitted = await Authorization.submitAuthorizationRequest({
            realm: 'beta',
            role: 'consumer',
            client_id: 'beta-client',
            client_name: 'Beta Client',
            client_token: betaClientToken
        }, options);

        const hidden = await Authorization.authManagementCommand(adminToken, {
            command: 'get'
        }, options);
        assert.strictEqual(hidden.settings.realms.alpha.manager_key, undefined);
        assert.strictEqual(hidden.settings.realms.alpha.manager_key_configured, true);

        const crossNext = await Authorization.nextAuthorizationRequest(alphaManagerKey, {
            realm: 'beta'
        }, options).then(() => null).catch(err => err.response);
        assert.strictEqual(crossNext.code, 401);

        const unscopedNext = await Authorization.nextAuthorizationRequest(alphaManagerKey, {}, options)
            .then(() => null)
            .catch(err => err.response);
        assert.strictEqual(unscopedNext.code, 401);

        const alphaNext = await Authorization.nextRealmAuthorizationRequest(alphaManagerKey, 'alpha', options);
        assert.strictEqual(alphaNext.request.request_id, alphaSubmitted.request_id);
        assert.strictEqual(alphaNext.request.realm, 'alpha');

        const crossDecision = await Authorization.decideRealmAuthorizationRequest(alphaManagerKey, {
            request_id: betaSubmitted.request_id,
            approved: true,
            role: 'consumer'
        }, options).then(() => null).catch(err => err.response);
        assert.strictEqual(crossDecision.code, 401);

        const management = await Authorization.authManagementCommand(alphaManagerKey, {
            command: 'get'
        }, options).then(() => null).catch(err => err.response);
        assert.strictEqual(management.code, 401);

        const alphaDecision = await Authorization.decideRealmAuthorizationRequest(alphaManagerKey, {
            request_id: alphaSubmitted.request_id,
            approved: true,
            role: 'consumer'
        }, options);
        assert.strictEqual(alphaDecision.request.status, 'approved');

        const client = new Factory({
            host: '127.0.0.1',
            port: authServer.port,
            protocol: 'http',
            auth: {token: alphaClientToken}
        });
        const consumer = await client.createConsumer('alpha-managed-client');
        assert.deepStrictEqual(consumer.authInfo, {realm: 'alpha', role: 'consumer'});
        consumer.disconnect();
    } finally {
        await authServer.close();
    }
});

test('approved authorization token persists to settings file when configured', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tyo-mq-settings-'));
    const settingsFile = path.join(tmpDir, 'settings.json');
    const adminToken = 'secret-admin';
    const clientToken = 'persistent-client-token';
    const authServer = await startServer({
        auth: {
            enabled: true,
            tokens: [
                { token: adminToken, realm: '*', role: 'admin' }
            ]
        }
    });
    const options = {host: '127.0.0.1', port: authServer.port, protocol: 'http'};

    try {
        authServer.server.loadSettings(settingsFile);

        const submitted = await Authorization.submitAuthorizationRequest({
            realm: 'managed-persist-realm',
            role: 'consumer',
            client_id: 'managed-client-persist',
            client_name: 'Managed Persistent Client',
            client_token: clientToken
        }, options);

        await Authorization.decideAuthorizationRequest(adminToken, {
            request_id: submitted.request_id,
            approved: true,
            role: 'both'
        }, options);

        const saved = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
        const persisted = saved.auth.tokens.find(token => token.token === clientToken);
        assert.ok(persisted, 'approved client token should be written to settings file');
        assert.strictEqual(persisted.realm, 'managed-persist-realm');
        assert.strictEqual(persisted.role, 'both');
        assert.strictEqual(persisted.client_id, 'managed-client-persist');
        assert.strictEqual(persisted.client_name, 'Managed Persistent Client');
        assert.ok(persisted.approved_at);
    } finally {
        await authServer.close();
        fs.rmSync(tmpDir, {recursive: true, force: true});
    }
});

test('manager revokes authorized token and persists settings file', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tyo-mq-settings-'));
    const settingsFile = path.join(tmpDir, 'settings.json');
    const adminToken = 'secret-admin';
    const clientToken = 'client-token-to-revoke';
    const authServer = await startServer({
        auth: {
            enabled: true,
            tokens: [
                { token: adminToken, realm: '*', role: 'admin' },
                {
                    token: clientToken,
                    realm: 'managed-revoke-realm',
                    role: 'both',
                    client_id: 'managed-client-revoke',
                    client_name: 'Managed Revoked Client'
                }
            ]
        }
    });
    const options = {host: '127.0.0.1', port: authServer.port, protocol: 'http'};
    const ioClient = require('socket.io-client');
    let socket;

    try {
        authServer.server.loadSettings(settingsFile);

        const response = await Authorization.authManagementCommand(adminToken, {
            command: 'revoke_token',
            realm: 'managed-revoke-realm',
            client_id: 'managed-client-revoke'
        }, options);

        assert.strictEqual(response.revoked.length, 1);
        assert.strictEqual(response.revoked[0].client_id, 'managed-client-revoke');
        assert.ok(!response.settings.tokens.some(token => token.client_id === 'managed-client-revoke'));

        const saved = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
        assert.ok(!saved.auth.tokens.some(token => token.token === clientToken));

        socket = ioClient(`http://127.0.0.1:${authServer.port}`, { transports: ['websocket'] });
        await waitFor(socket, 'connect');
        socket.emit('AUTHENTICATION', {token: clientToken});
        const fail = await waitFor(socket, 'AUTH_FAIL');
        assert.strictEqual(fail.code, 401);
    } finally {
        if (socket) socket.disconnect();
        await authServer.close();
        fs.rmSync(tmpDir, {recursive: true, force: true});
    }
});

test('same client authorization request keeps only the latest pending copy', async () => {
    const adminToken = 'secret-admin';
    const authServer = await startServer({
        auth: {
            enabled: true,
            tokens: [
                { token: adminToken, realm: '*', role: 'admin' }
            ]
        }
    });
    const options = {host: '127.0.0.1', port: authServer.port, protocol: 'http'};

    try {
        const first = await Authorization.submitAuthorizationRequest({
            realm: 'managed-realm',
            role: 'consumer',
            client_id: 'managed-client-2',
            client_name: 'Managed Client v1',
            client_token: 'first-client-token'
        }, options);
        const second = await Authorization.submitAuthorizationRequest({
            realm: 'managed-realm',
            role: 'producer',
            client_id: 'managed-client-2',
            client_name: 'Managed Client v2',
            client_token: 'second-client-token'
        }, options);

        assert.notStrictEqual(first.request_id, second.request_id);

        const next = await Authorization.nextAuthorizationRequest(adminToken, {}, options);
        assert.strictEqual(next.request.request_id, second.request_id);
        assert.strictEqual(next.request.client_name, 'Managed Client v2');
        assert.strictEqual(next.request.role, 'producer');

        const oldDecision = await Authorization.decideAuthorizationRequest(adminToken, {
            request_id: first.request_id,
            approved: true
        }, options).then(() => null).catch(err => err.response);
        assert.strictEqual(oldDecision.code, 404);
    } finally {
        await authServer.close();
    }
});

test('manager sends signed realm management commands to server', async () => {
    const adminToken = 'secret-admin';
    const authServer = await startServer({
        auth: {
            enabled: true,
            tokens: [
                { token: adminToken, realm: '*', role: 'admin' }
            ]
        }
    });
    const options = {host: '127.0.0.1', port: authServer.port, protocol: 'http'};

    try {
        const invalid = await Authorization.authManagementCommand('wrong-admin-token', {
            command: 'get'
        }, options).then(() => null).catch(err => err.response);
        assert.strictEqual(invalid.code, 401);

        const added = await Authorization.authManagementCommand(adminToken, {
            command: 'add_realm',
            realm: 'managed-command-realm',
            required: false
        }, options);
        assert.strictEqual(added.settings.realms['managed-command-realm'].required, false);

        const renamed = await Authorization.authManagementCommand(adminToken, {
            command: 'rename_realm',
            from: 'managed-command-realm',
            to: 'managed-command-renamed'
        }, options);
        assert.ok(!renamed.settings.realms['managed-command-realm']);
        assert.strictEqual(renamed.settings.realms['managed-command-renamed'].required, false);

        const enabled = await Authorization.authManagementCommand(adminToken, {
            command: 'set_realm_auth',
            realm: 'managed-command-renamed',
            required: true
        }, options);
        assert.strictEqual(enabled.settings.realms['managed-command-renamed'].required, true);
    } finally {
        await authServer.close();
    }
});

test('reload_settings re-reads the watched file from disk on demand', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tyo-mq-reload-'));
    const settingsFile = path.join(tmpDir, 'settings.json');
    const adminToken = 'secret-admin';
    const authServer = await startServer({
        auth: {
            enabled: true,
            tokens: [
                { token: adminToken, realm: '*', role: 'admin' }
            ]
        }
    });
    const options = {host: '127.0.0.1', port: authServer.port, protocol: 'http'};

    try {
        authServer.server.loadSettings(settingsFile);

        // Mutate the file directly, as if an operator edited it out-of-band.
        const current = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
        current.auth = current.auth || {};
        current.auth.realms = current.auth.realms || {};
        current.auth.realms['disk-edited-realm'] = { required: false };
        fs.writeFileSync(settingsFile, JSON.stringify(current, null, 2));

        // A forced reload pulls the on-disk change into the live settings.
        const reloaded = await Authorization.authManagementCommand(adminToken, {
            command: 'reload_settings'
        }, options);
        assert.ok(reloaded.settings.realms['disk-edited-realm'],
            'reload_settings should surface the realm added on disk');
        assert.strictEqual(reloaded.settings.realms['disk-edited-realm'].required, false);
    } finally {
        await authServer.close();
        fs.rmSync(tmpDir, {recursive: true, force: true});
    }
});

test('manager removes a realm and drops its scoped tokens', async () => {
    const adminToken = 'secret-admin';
    const authServer = await startServer({
        auth: {
            enabled: true,
            tokens: [
                { token: adminToken, realm: '*', role: 'admin' },
                { token: 'doomed-client-token', realm: 'doomed-realm', role: 'both' }
            ]
        }
    });
    const options = {host: '127.0.0.1', port: authServer.port, protocol: 'http'};

    try {
        await Authorization.authManagementCommand(adminToken, {
            command: 'add_realm',
            realm: 'doomed-realm',
            required: true
        }, options);

        // Removing a non-existent realm reports 404.
        const missing = await Authorization.authManagementCommand(adminToken, {
            command: 'remove_realm',
            realm: 'no-such-realm'
        }, options).then(() => null).catch(err => err.response);
        assert.strictEqual(missing.code, 404);

        // The structural 'default' and '*' realms cannot be removed.
        const guardedDefault = await Authorization.authManagementCommand(adminToken, {
            command: 'remove_realm',
            realm: 'default'
        }, options).then(() => null).catch(err => err.response);
        assert.strictEqual(guardedDefault.code, 400);

        // Removing the realm drops its config and any tokens scoped to it.
        const removed = await Authorization.authManagementCommand(adminToken, {
            command: 'remove_realm',
            realm: 'doomed-realm'
        }, options);
        assert.ok(!removed.settings.realms['doomed-realm']);
        assert.strictEqual(removed.removed_tokens, 1);
    } finally {
        await authServer.close();
    }
});

test('add_realm creates permanent and ephemeral (disposable) realm forms', async () => {
    const adminToken = 'secret-admin';
    const authServer = await startServer({
        auth: {
            enabled: true,
            tokens: [
                { token: adminToken, realm: '*', role: 'admin' }
            ]
        }
    });
    const options = {host: '127.0.0.1', port: authServer.port, protocol: 'http'};

    try {
        // The default form is permanent: no lifetime metadata at all.
        const permanent = await Authorization.authManagementCommand(adminToken, {
            command: 'add_realm',
            realm: 'permanent-realm'
        }, options);
        assert.strictEqual(permanent.settings.realms['permanent-realm'].ephemeral, undefined);
        assert.strictEqual(permanent.settings.realms['permanent-realm'].expires_at, undefined);

        // ephemeral: true tags the realm with an expiry (default TTL applies).
        const ephemeral = await Authorization.authManagementCommand(adminToken, {
            command: 'add_realm',
            realm: 'ephemeral-realm',
            ephemeral: true,
            ttl: '2h'
        }, options);
        assert.strictEqual(ephemeral.settings.realms['ephemeral-realm'].ephemeral, true);
        const expiresAt = ephemeral.settings.realms['ephemeral-realm'].expires_at;
        assert.ok(expiresAt > Date.now() + 60 * 60 * 1000, 'expiry should honour the 2h ttl');

        // 'temporary' is accepted as an input alias for ephemeral.
        const aliased = await Authorization.authManagementCommand(adminToken, {
            command: 'add_realm',
            realm: 'aliased-realm',
            temporary: true,
            ttl: '1h'
        }, options);
        assert.strictEqual(aliased.settings.realms['aliased-realm'].ephemeral, true);

        // A bare ttl implies the ephemeral form.
        const implied = await Authorization.authManagementCommand(adminToken, {
            command: 'add_realm',
            realm: 'implied-ephemeral-realm',
            ttl: '30m'
        }, options);
        assert.strictEqual(implied.settings.realms['implied-ephemeral-realm'].ephemeral, true);

        // Garbage TTLs are rejected outright.
        const invalid = await Authorization.authManagementCommand(adminToken, {
            command: 'add_realm',
            realm: 'bad-ttl-realm',
            ephemeral: true,
            ttl: 'soonish'
        }, options).then(() => null).catch(err => err.response);
        assert.strictEqual(invalid.code, 400);
    } finally {
        await authServer.close();
    }
});

test('expired ephemeral realms are disposed with tokens, sockets, and messages', async () => {
    const adminToken = 'secret-admin';
    const clientToken = 'ephemeral-realm-client';
    const authServer = await startServer({
        auth: {
            enabled: true,
            realms: {
                'ephemeral-realm': { required: true, ephemeral: true, expires_at: Date.now() + 400 }
            },
            tokens: [
                { token: adminToken, realm: '*', role: 'admin' },
                { token: clientToken, realm: 'ephemeral-realm', role: 'both' }
            ]
        }
    });
    const options = {host: '127.0.0.1', port: authServer.port, protocol: 'http'};
    const ioClient = require('socket.io-client');
    const socket = ioClient(`http://127.0.0.1:${authServer.port}`, { transports: ['websocket'] });

    try {
        await waitFor(socket, 'connect');
        socket.emit('AUTHENTICATION', { token: clientToken });
        await waitFor(socket, 'AUTH_OK');

        // Park a durable message in the realm so disposal has something to purge.
        await authServer.server.store.enqueue('ephemeral-realm', 'orders', {
            consumer: 'worker', payload: {n: 1}
        });

        // Not yet expired — the sweep must leave the realm alone.
        assert.strictEqual(authServer.server.sweepEphemeralRealms(), 0);

        await delay(500);
        const disconnected = waitFor(socket, 'disconnect');
        assert.strictEqual(authServer.server.sweepEphemeralRealms(), 1);
        await disconnected;

        const after = await Authorization.authManagementCommand(adminToken, {
            command: 'get'
        }, options);
        assert.ok(!after.settings.realms['ephemeral-realm'], 'realm config should be gone');
        assert.ok(!after.settings.tokens.some(t => t.realm === 'ephemeral-realm'),
            'realm-scoped tokens should be dropped');

        const remaining = await authServer.server.store.dequeue('ephemeral-realm', 'orders', 'worker');
        assert.strictEqual(remaining.length, 0, 'stored messages should be purged');
    } finally {
        socket.disconnect();
        await authServer.close();
    }
});

test('set_realm_lifetime converts realms between ephemeral and permanent', async () => {
    const adminToken = 'secret-admin';
    const authServer = await startServer({
        auth: {
            enabled: true,
            tokens: [
                { token: adminToken, realm: '*', role: 'admin' }
            ]
        }
    });
    const options = {host: '127.0.0.1', port: authServer.port, protocol: 'http'};

    try {
        await Authorization.authManagementCommand(adminToken, {
            command: 'add_realm',
            realm: 'flip-realm',
            ephemeral: true,
            ttl: '200ms'
        }, options);

        // Making it permanent clears the lifetime metadata: the sweep must
        // now leave it alone even after the old expiry has lapsed.
        const madePermanent = await Authorization.authManagementCommand(adminToken, {
            command: 'set_realm_lifetime',
            realm: 'flip-realm',
            ephemeral: false
        }, options);
        assert.strictEqual(madePermanent.settings.realms['flip-realm'].ephemeral, undefined);
        assert.strictEqual(madePermanent.settings.realms['flip-realm'].expires_at, undefined);
        await delay(300);
        assert.strictEqual(authServer.server.sweepEphemeralRealms(), 0);

        // And back to ephemeral: a fresh ttl re-arms disposal.
        await Authorization.authManagementCommand(adminToken, {
            command: 'set_realm_lifetime',
            realm: 'flip-realm',
            ephemeral: true,
            ttl: '150ms'
        }, options);
        await delay(250);
        assert.strictEqual(authServer.server.sweepEphemeralRealms(), 1);

        // The structural realms are not convertible.
        const guarded = await Authorization.authManagementCommand(adminToken, {
            command: 'set_realm_lifetime',
            realm: 'default',
            ephemeral: true
        }, options).then(() => null).catch(err => err.response);
        assert.strictEqual(guarded.code, 400);
    } finally {
        await authServer.close();
    }
});

test('expired ephemeral realms left over from a previous run are swept at startup', async () => {
    const adminToken = 'secret-admin';
    const authServer = await startServer({
        auth: {
            enabled: true,
            realms: {
                'stale-ephemeral-realm': { required: true, ephemeral: true, expires_at: Date.now() - 1000 },
                // Old-style 'temporary' tag (pre-rename settings file) must sweep too.
                'stale-legacy-realm':    { required: true, temporary: true, expires_at: Date.now() - 1000 },
                'live-ephemeral-realm':  { required: true, ephemeral: true, expires_at: Date.now() + 60000 }
            },
            tokens: [
                { token: adminToken, realm: '*', role: 'admin' }
            ]
        }
    });
    const options = {host: '127.0.0.1', port: authServer.port, protocol: 'http'};

    try {
        const settings = await Authorization.authManagementCommand(adminToken, {
            command: 'get'
        }, options);
        assert.ok(!settings.settings.realms['stale-ephemeral-realm'],
            'expired ephemeral realm should be disposed at startup');
        assert.ok(!settings.settings.realms['stale-legacy-realm'],
            'expired legacy temporary-tagged realm should be disposed at startup');
        assert.ok(settings.settings.realms['live-ephemeral-realm'],
            'unexpired ephemeral realm must survive startup');
        assert.strictEqual(settings.settings.realms['live-ephemeral-realm'].ephemeral, true);
    } finally {
        await authServer.close();
    }
});

test('manager sends signed persistence management commands to server', async () => {
    const adminToken = 'secret-admin';
    const authServer = await startServer({
        auth: {
            enabled: true,
            tokens: [
                { token: adminToken, realm: '*', role: 'admin' }
            ]
        }
    });
    const options = {host: '127.0.0.1', port: authServer.port, protocol: 'http'};

    try {
        const initial = await Authorization.authManagementCommand(adminToken, {
            command: 'get'
        }, options);
        assert.strictEqual(initial.settings.persistence.storage, 'memory');

        const memory = await Authorization.authManagementCommand(adminToken, {
            command: 'set_persistence',
            storage: 'memory',
            storage_options: {
                default_ttl: 12
            }
        }, options);
        assert.strictEqual(memory.settings.persistence.storage, 'memory');
        assert.strictEqual(memory.settings.persistence.storage_options.default_ttl, 12);

        const redis = await Authorization.authManagementCommand(adminToken, {
            command: 'set_persistence',
            storage: 'redis',
            storage_options: {
                url: 'redis://127.0.0.1:6379/0',
                prefix: 'phase-test',
                default_ttl: 34
            }
        }, options);
        assert.strictEqual(redis.settings.persistence.storage, 'redis');
        assert.strictEqual(redis.settings.persistence.storage_options.url, 'redis://127.0.0.1:6379/0');
        assert.strictEqual(redis.settings.persistence.storage_options.prefix, 'phase-test');
        assert.strictEqual(redis.settings.persistence.storage_options.default_ttl, 34);

        const invalid = await Authorization.authManagementCommand(adminToken, {
            command: 'set_persistence',
            storage: 'custom',
            storage_options: {}
        }, options).then(() => null).catch(err => err.response);
        assert.strictEqual(invalid.code, 400);
    } finally {
        await authServer.close();
    }
});

test('manager manages HTTP management tokens via signed commands', async () => {
    const adminToken = 'secret-admin';
    const authServer = await startServer({
        http_api: { enabled: true },
        auth: {
            enabled: true,
            tokens: [ { token: adminToken, realm: '*', role: 'admin' } ],
            management_tokens: [ { token: 'pre-existing-mgmt', realm_prefix: 'apps:legacy:' } ]
        }
    });
    const options = {host: '127.0.0.1', port: authServer.port, protocol: 'http'};

    try {
        // get masks management tokens: hash + prefix only, never the raw value.
        const got = await Authorization.authManagementCommand(adminToken, {command: 'get'}, options);
        assert.strictEqual(got.settings.management_tokens.length, 1);
        assert.strictEqual(got.settings.management_tokens[0].realm_prefix, 'apps:legacy:');
        assert.ok(got.settings.management_tokens[0].token_hash);
        assert.strictEqual(got.settings.management_tokens[0].token, undefined);

        const added = await Authorization.authManagementCommand(adminToken, {
            command: 'add_management_token',
            token: 'new-mgmt-token',
            realm_prefix: 'realm:prefix:'
        }, options);
        assert.strictEqual(added.settings.management_tokens.length, 2);

        // The added token authorizes POST /api/realms under its prefix.
        const create = await new Promise((resolve, reject) => {
            const req = require('http').request({
                host: '127.0.0.1', port: authServer.port, path: '/api/realms', method: 'POST',
                headers: {'content-type': 'application/json', 'authorization': 'Bearer new-mgmt-token'}
            }, (res) => {
                let chunks = '';
                res.on('data', c => { chunks += c; });
                res.on('end', () => resolve({status: res.statusCode, body: chunks}));
            });
            req.on('error', reject);
            req.end(JSON.stringify({realm: 'realm:prefix:ui-test', manager_key: 'mk-1'}));
        });
        assert.strictEqual(create.status, 200, create.body);

        const dup = await Authorization.authManagementCommand(adminToken, {
            command: 'add_management_token',
            token: 'new-mgmt-token',
            realm_prefix: 'apps:other:'
        }, options).then(() => null).catch(err => err.response);
        assert.strictEqual(dup.code, 409);

        const bad = await Authorization.authManagementCommand(adminToken, {
            command: 'add_management_token',
            token: 'x'
        }, options).then(() => null).catch(err => err.response);
        assert.strictEqual(bad.code, 400);

        const hash = added.settings.management_tokens
            .find(e => e.realm_prefix === 'realm:prefix:').token_hash;
        const revoked = await Authorization.authManagementCommand(adminToken, {
            command: 'revoke_management_token',
            token_hash: hash
        }, options);
        assert.strictEqual(revoked.settings.management_tokens.length, 1);
        assert.strictEqual(revoked.settings.management_tokens[0].realm_prefix, 'apps:legacy:');

        const missing = await Authorization.authManagementCommand(adminToken, {
            command: 'revoke_management_token',
            token_hash: 'deadbeef'
        }, options).then(() => null).catch(err => err.response);
        assert.strictEqual(missing.code, 404);
    } finally {
        await authServer.close();
    }
});

test('manager sets external auth via signed management command', async () => {
    const adminToken = 'secret-admin';
    const authServer = await startServer({
        auth: {
            enabled: true,
            tokens: [ { token: adminToken, realm: '*', role: 'admin' } ]
        }
    });
    const options = {host: '127.0.0.1', port: authServer.port, protocol: 'http'};

    try {
        const set = await Authorization.authManagementCommand(adminToken, {
            command: 'set_external_auth',
            auth_url: 'https://tyoman.example/api/v1/mq-auth',
            auth_secret: 'cb-secret'
        }, options);
        assert.strictEqual(set.settings.auth_url, 'https://tyoman.example/api/v1/mq-auth');
        assert.strictEqual(set.settings.auth_secret, '<configured>');

        // Omitting auth_secret keeps the current one (the UI cannot read it back).
        const keep = await Authorization.authManagementCommand(adminToken, {
            command: 'set_external_auth',
            auth_url: 'https://tyoman.example/api/v1/mq-auth'
        }, options);
        assert.strictEqual(keep.settings.auth_secret, '<configured>');

        const bad = await Authorization.authManagementCommand(adminToken, {
            command: 'set_external_auth',
            auth_url: 'not a url'
        }, options).then(() => null).catch(err => err.response);
        assert.strictEqual(bad.code, 400);

        // Explicit empty strings clear both.
        const cleared = await Authorization.authManagementCommand(adminToken, {
            command: 'set_external_auth',
            auth_url: '',
            auth_secret: ''
        }, options);
        assert.strictEqual(cleared.settings.auth_url, undefined);
        assert.strictEqual(cleared.settings.auth_secret, undefined);
    } finally {
        await authServer.close();
    }
});

// --- External auth (auth_url) as fallback for locally unknown tokens ---

/**
 * Start a stub external validator. `respond(req, body)` returns the object to
 * send back (or {status, json}). Records every request's headers + parsed body.
 */
function startAuthStub(respond) {
    return new Promise((resolve) => {
        const requests = [];
        const server = http.createServer((req, res) => {
            let raw = '';
            req.on('data', (chunk) => { raw += chunk; });
            req.on('end', () => {
                const body = raw ? JSON.parse(raw) : {};
                requests.push({ headers: req.headers, body });
                const out = respond(req, body) || {};
                res.writeHead(out.status || 200, { 'content-type': 'application/json' });
                res.end(JSON.stringify(out.json || out));
            });
        });
        server.listen(0, '127.0.0.1', () => {
            resolve({
                url: `http://127.0.0.1:${server.address().port}/mq-auth`,
                requests,
                close: () => new Promise(res => server.close(res)),
            });
        });
    });
}

test('static tokens keep working when auth_url is configured', async () => {
    // Local credentials must be checked before the external validator, so
    // enabling auth_url cannot break already-provisioned tokens.
    const stub = await startAuthStub(() => ({ ok: false }));
    const authServer = await startServer({
        auth: {
            enabled: true,
            auth_url: stub.url,
            tokens: [ { token: 'secret-acme-prod', realm: 'acme', role: 'producer' } ]
        }
    });
    const ioClient = require('socket.io-client');
    const socket = ioClient(`http://127.0.0.1:${authServer.port}`, { transports: ['websocket'] });

    try {
        await waitFor(socket, 'connect');
        socket.emit('AUTHENTICATION', { token: 'secret-acme-prod' });
        const ok = await waitFor(socket, 'AUTH_OK');
        assert.deepStrictEqual(ok, { realm: 'acme', role: 'producer' });
        assert.strictEqual(stub.requests.length, 0);
    } finally {
        socket.disconnect();
        await authServer.close();
        await stub.close();
    }
});

test('unknown tokens fall back to auth_url with secret header and realm', async () => {
    const stub = await startAuthStub((req, body) => (
        body.token === 'per-machine-tok'
            ? { realm: 'acme', role: 'both', ok: true }
            : { ok: false }
    ));
    const authServer = await startServer({
        auth: {
            enabled: true,
            auth_url: stub.url,
            auth_secret: 'cb-secret',
            tokens: [ { token: 'secret-acme-prod', realm: 'acme', role: 'producer' } ]
        }
    });
    const ioClient = require('socket.io-client');
    const socket = ioClient(`http://127.0.0.1:${authServer.port}`, { transports: ['websocket'] });

    try {
        await waitFor(socket, 'connect');
        socket.emit('AUTHENTICATION', { token: 'per-machine-tok', realm: 'acme' });
        const ok = await waitFor(socket, 'AUTH_OK');
        assert.deepStrictEqual(ok, { realm: 'acme', role: 'both' });
        assert.strictEqual(stub.requests.length, 1);
        assert.strictEqual(stub.requests[0].headers['x-mq-auth-secret'], 'cb-secret');
        assert.deepStrictEqual(stub.requests[0].body, { token: 'per-machine-tok', realm: 'acme' });
    } finally {
        socket.disconnect();
        await authServer.close();
        await stub.close();
    }
});

test('auth_url rejection fails authentication', async () => {
    const stub = await startAuthStub(() => ({ ok: false }));
    const authServer = await startServer({
        auth: { enabled: true, auth_url: stub.url }
    });
    const ioClient = require('socket.io-client');
    const socket = ioClient(`http://127.0.0.1:${authServer.port}`, { transports: ['websocket'] });

    try {
        await waitFor(socket, 'connect');
        socket.emit('AUTHENTICATION', { token: 'revoked-tok', realm: 'acme' });
        const fail = await waitFor(socket, 'AUTH_FAIL');
        assert.strictEqual(fail.code, 401);
        assert.strictEqual(stub.requests.length, 1);
    } finally {
        socket.disconnect();
        await authServer.close();
        await stub.close();
    }
});

test('jwt_secret failure falls through to static tokens', async () => {
    // A configured global jwt_secret must not shadow the static token list.
    const authServer = await startServer({
        auth: {
            enabled: true,
            jwt_secret: 'global-jwt-secret',
            tokens: [ { token: 'secret-acme-prod', realm: 'acme', role: 'producer' } ]
        }
    });
    const ioClient = require('socket.io-client');
    const socket = ioClient(`http://127.0.0.1:${authServer.port}`, { transports: ['websocket'] });

    try {
        await waitFor(socket, 'connect');
        socket.emit('AUTHENTICATION', { token: 'secret-acme-prod' });
        const ok = await waitFor(socket, 'AUTH_OK');
        assert.deepStrictEqual(ok, { realm: 'acme', role: 'producer' });
    } finally {
        socket.disconnect();
        await authServer.close();
    }
});

run();
