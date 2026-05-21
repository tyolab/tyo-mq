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
const os = require('os');
const path = require('path');
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

run();
