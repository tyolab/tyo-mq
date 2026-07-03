/**
 * Phase 5 (revised): opt-in HTTP observability surface.
 *
 * Enabled with `http_api: { enabled: true }` at startup, served on the SAME
 * port as the socket server. Read-only:
 *   GET /health                      liveness (no auth)
 *   GET /api/metrics                 Prometheus text (Bearer admin token when auth on)
 *   GET /api/stats                   realm/producer/consumer state (Bearer admin)
 *   GET /api/realms/{realm}/dlq      dead-letter queue contents (Bearer admin)
 *
 * Disabled (the default) means behavior is unchanged: no HTTP endpoint exists.
 *
 * Usage: node tests/phase5-http-api.test.js
 */

'use strict';

const assert = require('assert');
const http = require('http');
const { test, run } = require('./runner');
const { startServer, makeFactory, delay } = require('./helpers');

function httpGet(port, pathname, headers) {
    return new Promise((resolve) => {
        const req = http.get({
            host: '127.0.0.1',
            port: port,
            path: pathname,
            headers: headers || {},
            timeout: 1500
        }, (res) => {
            let body = '';
            res.setEncoding('utf8');
            res.on('data', (chunk) => { body += chunk; });
            res.on('end', () => resolve({ status: res.statusCode, body }));
        });
        req.on('timeout', () => { req.destroy(); resolve({ status: null, body: '' }); });
        req.on('error', () => resolve({ status: null, body: '' }));
    });
}

function httpPost(port, pathname, body, headers) {
    return new Promise((resolve) => {
        const payload = body === undefined
            ? ''
            : (typeof body === 'string' ? body : JSON.stringify(body));
        const req = http.request({
            host: '127.0.0.1',
            port: port,
            path: pathname,
            method: 'POST',
            headers: Object.assign({
                'content-type': 'application/json',
                'content-length': Buffer.byteLength(payload)
            }, headers || {}),
            timeout: 1500
        }, (res) => {
            let data = '';
            res.setEncoding('utf8');
            res.on('data', (chunk) => { data += chunk; });
            res.on('end', () => resolve({ status: res.statusCode, body: data }));
        });
        req.on('timeout', () => { req.destroy(); resolve({ status: null, body: '' }); });
        req.on('error', () => resolve({ status: null, body: '' }));
        req.end(payload);
    });
}

test('http api is disabled by default', async () => {
    const server = await startServer({});
    try {
        const health = await httpGet(server.port, '/health');
        assert.notStrictEqual(health.status, 200, 'no /health endpoint without http_api.enabled');
        const metrics = await httpGet(server.port, '/api/metrics');
        assert.notStrictEqual(metrics.status, 200, 'no /api/metrics endpoint without http_api.enabled');
    } finally {
        await server.close();
    }
});

test('health endpoint responds when http api is enabled', async () => {
    const server = await startServer({ http_api: { enabled: true } });
    try {
        const response = await httpGet(server.port, '/health');
        assert.strictEqual(response.status, 200);
        const body = JSON.parse(response.body);
        assert.strictEqual(body.status, 'ok');
        assert.ok(body.version, 'health should report the server version');
        assert.ok(body.uptime_seconds >= 0);
    } finally {
        await server.close();
    }
});

test('metrics report produced and delivered counters in prometheus format', async () => {
    const server = await startServer({ http_api: { enabled: true } });
    const client = makeFactory(server.port);

    let producer;
    let consumer;
    try {
        producer = await client.createProducer('metrics-producer');
        consumer = await client.createConsumer('metrics-consumer');

        await new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('timeout waiting for metrics message')), 4000);
            consumer.subscribe(producer.name, 'metrics-event', () => {
                clearTimeout(timer);
                resolve();
            });
            setTimeout(() => producer.produce('metrics-event', 'count-me'), 400);
        });
        await delay(200);

        const response = await httpGet(server.port, '/api/metrics');
        assert.strictEqual(response.status, 200);
        assert.ok(/tyo_mq_messages_produced_total\{[^}]*event="metrics-event"[^}]*\} 1/.test(response.body),
            'produced counter missing: ' + response.body);
        assert.ok(/tyo_mq_messages_delivered_total\{/.test(response.body),
            'delivered counter missing: ' + response.body);
        assert.ok(/tyo_mq_connections_total \d+/.test(response.body),
            'connections counter missing: ' + response.body);
    } finally {
        if (producer) producer.disconnect();
        if (consumer) consumer.disconnect();
        await server.close();
    }
});

test('metrics and stats require a bearer admin token when auth is enabled', async () => {
    const adminToken = 'http-api-admin-token';
    const server = await startServer({
        http_api: { enabled: true },
        auth: {
            enabled: true,
            tokens: [
                { token: adminToken, realm: '*', role: 'admin' }
            ]
        }
    });

    try {
        const denied = await httpGet(server.port, '/api/metrics');
        assert.strictEqual(denied.status, 401);

        const wrong = await httpGet(server.port, '/api/metrics', { authorization: 'Bearer wrong-token' });
        assert.strictEqual(wrong.status, 401);

        const granted = await httpGet(server.port, '/api/metrics', { authorization: 'Bearer ' + adminToken });
        assert.strictEqual(granted.status, 200);

        const statsDenied = await httpGet(server.port, '/api/stats');
        assert.strictEqual(statsDenied.status, 401);

        const statsGranted = await httpGet(server.port, '/api/stats', { authorization: 'Bearer ' + adminToken });
        assert.strictEqual(statsGranted.status, 200);

        // Health stays public — load balancers don't carry tokens.
        const health = await httpGet(server.port, '/health');
        assert.strictEqual(health.status, 200);
    } finally {
        await server.close();
    }
});

test('stats endpoint reports realm producer and consumer state', async () => {
    const server = await startServer({ http_api: { enabled: true } });
    const client = makeFactory(server.port);

    let producer;
    let consumer;
    try {
        producer = await client.createProducer('stats-producer');
        consumer = await client.createConsumer('stats-consumer');
        consumer.subscribe(producer.name, 'stats-event', function () {});
        await delay(400);

        const response = await httpGet(server.port, '/api/stats');
        assert.strictEqual(response.status, 200);
        const body = JSON.parse(response.body);
        const realm = body.realms.default;
        assert.ok(realm, 'default realm should be present: ' + response.body);
        assert.ok(realm.producers.online >= 1, 'producer should be online: ' + response.body);
        assert.ok(realm.consumers.online >= 1, 'consumer should be online: ' + response.body);
        assert.ok(realm.subscriptions >= 1, 'subscription should be counted: ' + response.body);
        assert.ok(body.connections_current >= 2, 'live connection count expected: ' + response.body);
    } finally {
        if (producer) producer.disconnect();
        if (consumer) consumer.disconnect();
        await server.close();
    }
});

test('dlq endpoint lists dead-lettered messages for a realm', async () => {
    const server = await startServer({ http_api: { enabled: true }, storage: 'memory' });
    try {
        const msgId = await server.server.store.enqueue('dlq-realm', 'dlq-event', {
            consumer_id: 'dlq-consumer',
            payload: { message: 'poison' },
            producer: 'dlq-producer'
        });
        await server.server.store.deadLetter(msgId, 'test reason');

        const response = await httpGet(server.port, '/api/realms/dlq-realm/dlq');
        assert.strictEqual(response.status, 200);
        const body = JSON.parse(response.body);
        assert.strictEqual(body.realm, 'dlq-realm');
        assert.strictEqual(body.entries.length, 1);
        assert.strictEqual(body.entries[0].id, msgId);
        assert.strictEqual(body.entries[0].reason, 'test reason');

        const other = await httpGet(server.port, '/api/realms/other-realm/dlq');
        assert.strictEqual(JSON.parse(other.body).entries.length, 0);
    } finally {
        await server.close();
    }
});

test('stats management command returns realm state over the signed channel', async () => {
    const Authorization = require('../lib/authorization');
    const Factory = require('../lib/factory');
    const adminToken = 'p5-stats-admin';
    const server = await startServer({
        auth: {
            enabled: true,
            tokens: [
                { token: adminToken, realm: '*', role: 'admin' },
                { token: 'p5-stats-both', realm: 'p5-stats-realm', role: 'both' }
            ]
        }
    });
    const options = { host: '127.0.0.1', port: server.port, protocol: 'http' };
    const client = new Factory({
        host: '127.0.0.1', port: server.port, protocol: 'http',
        auth: { token: 'p5-stats-both' }
    });

    let producer;
    let consumer;
    try {
        producer = await client.createProducer('p5-stats-producer');
        consumer = await client.createConsumer('p5-stats-consumer');
        consumer.subscribe(producer.name, 'p5-stats-event', function () {});
        await delay(400);

        const response = await Authorization.authManagementCommand(adminToken, {
            command: 'stats'
        }, options);
        const realm = response.stats.realms['p5-stats-realm'];
        assert.ok(realm, 'stats must include the realm: ' + JSON.stringify(response.stats));
        assert.ok(realm.producers.online >= 1, JSON.stringify(realm));
        assert.ok(realm.consumers.online >= 1, JSON.stringify(realm));
        assert.ok(realm.subscriptions >= 1, JSON.stringify(realm));
    } finally {
        if (producer) producer.disconnect();
        if (consumer) consumer.disconnect();
        await server.close();
    }
});

test('dlq management commands list, replay, and discard messages', async () => {
    const Authorization = require('../lib/authorization');
    const adminToken = 'p5-dlq-admin';
    const server = await startServer({
        storage: 'memory',
        auth: {
            enabled: true,
            tokens: [
                { token: adminToken, realm: '*', role: 'admin' }
            ]
        }
    });
    const options = { host: '127.0.0.1', port: server.port, protocol: 'http' };
    const store = server.server.store;

    try {
        const replayId = await store.enqueue('p5-dlq-realm', 'p5-dlq-event', {
            consumer_id: 'p5-dlq-consumer',
            payload: { message: 'replay-me' },
            producer: 'p5-dlq-producer'
        });
        await store.deadLetter(replayId, 'poison');
        const discardId = await store.enqueue('p5-dlq-realm', 'p5-dlq-event', {
            consumer_id: 'p5-dlq-consumer',
            payload: { message: 'discard-me' },
            producer: 'p5-dlq-producer'
        });
        await store.deadLetter(discardId, 'hopeless');

        const listed = await Authorization.authManagementCommand(adminToken, {
            command: 'dlq_list',
            realm: 'p5-dlq-realm'
        }, options);
        assert.strictEqual(listed.entries.length, 2, JSON.stringify(listed));

        // Replay re-enqueues the message for its consumer and removes it
        // from the DLQ.
        const replayed = await Authorization.authManagementCommand(adminToken, {
            command: 'dlq_replay',
            realm: 'p5-dlq-realm',
            msg_id: replayId
        }, options);
        assert.strictEqual(replayed.ok, true, JSON.stringify(replayed));
        assert.ok(replayed.new_msg_id, 'replay should produce a new queued message id');

        const requeued = await store.dequeue('p5-dlq-realm', 'p5-dlq-event', 'p5-dlq-consumer');
        assert.strictEqual(requeued.length, 1);
        assert.deepStrictEqual(requeued[0].message, { message: 'replay-me' });

        const discarded = await Authorization.authManagementCommand(adminToken, {
            command: 'dlq_discard',
            realm: 'p5-dlq-realm',
            msg_id: discardId
        }, options);
        assert.strictEqual(discarded.ok, true, JSON.stringify(discarded));

        const after = await Authorization.authManagementCommand(adminToken, {
            command: 'dlq_list',
            realm: 'p5-dlq-realm'
        }, options);
        assert.strictEqual(after.entries.length, 0, JSON.stringify(after));

        const missing = await Authorization.authManagementCommand(adminToken, {
            command: 'dlq_replay',
            realm: 'p5-dlq-realm',
            msg_id: 'no-such-id'
        }, options).then(() => null).catch(err => err.response);
        assert.strictEqual(missing.code, 404);
    } finally {
        await server.close();
    }
});

test('create-realm endpoint is not served when no management token is configured', async () => {
    const server = await startServer({
        http_api: { enabled: true },
        auth: { enabled: true, tokens: [{ token: 'admin-tok', realm: '*', role: 'admin' }] }
    });
    try {
        const res = await httpPost(server.port, '/api/realms',
            { realm: 'realm:prefix:acme', manager_key: 'k' },
            { authorization: 'Bearer admin-tok' });
        assert.strictEqual(res.status, 404, 'no management_tokens => endpoint disabled: ' + res.body);
    } finally {
        await server.close();
    }
});

test('create-realm endpoint does not exist when http_api is disabled', async () => {
    const server = await startServer({
        auth: {
            enabled: true,
            management_tokens: [{ token: 'mgmt-tok', realm_prefix: 'realm:prefix:' }]
        }
    });
    try {
        const res = await httpPost(server.port, '/api/realms',
            { realm: 'realm:prefix:acme', manager_key: 'k' },
            { authorization: 'Bearer mgmt-tok' });
        assert.notStrictEqual(res.status, 200, 'no http_api => no endpoint');
        assert.notStrictEqual(res.status, 404, 'no http_api => handler never reached (bare 403)');
    } finally {
        await server.close();
    }
});

test('create-realm requires a valid management bearer token', async () => {
    const mgmtToken = 'mgmt-secret-token';
    const server = await startServer({
        http_api: { enabled: true },
        auth: {
            enabled: true,
            tokens: [{ token: 'admin-tok', realm: '*', role: 'admin' }],
            management_tokens: [{ token: mgmtToken, realm_prefix: 'realm:prefix:' }]
        }
    });
    try {
        const noAuth = await httpPost(server.port, '/api/realms',
            { realm: 'realm:prefix:acme', manager_key: 'k' });
        assert.strictEqual(noAuth.status, 401, 'no bearer => 401: ' + noAuth.body);

        const wrong = await httpPost(server.port, '/api/realms',
            { realm: 'realm:prefix:acme', manager_key: 'k' },
            { authorization: 'Bearer nope' });
        assert.strictEqual(wrong.status, 401, 'wrong token => 401: ' + wrong.body);

        // The global admin token is NOT accepted on this endpoint.
        const admin = await httpPost(server.port, '/api/realms',
            { realm: 'realm:prefix:acme', manager_key: 'k' },
            { authorization: 'Bearer admin-tok' });
        assert.strictEqual(admin.status, 401, 'admin token not accepted here => 401: ' + admin.body);
    } finally {
        await server.close();
    }
});

test('create-realm creates an in-prefix realm and stores its manager_key', async () => {
    const mgmtToken = 'mgmt-create-token';
    const server = await startServer({
        http_api: { enabled: true },
        auth: {
            enabled: true,
            management_tokens: [{ token: mgmtToken, realm_prefix: 'realm:prefix:' }]
        }
    });
    const auth = { authorization: 'Bearer ' + mgmtToken };
    try {
        const created = await httpPost(server.port, '/api/realms',
            { realm: 'realm:prefix:acme', manager_key: 'key-one' }, auth);
        assert.strictEqual(created.status, 200, created.body);
        const body = JSON.parse(created.body);
        assert.strictEqual(body.ok, true);
        assert.strictEqual(body.realm, 'realm:prefix:acme');
        assert.strictEqual(body.created, true);
        assert.strictEqual(body.manager_key_configured, true);
        assert.ok(!('manager_key' in body), 'manager_key must never be echoed');

        const realms = server.server.settings.get('auth').realms || {};
        assert.strictEqual(realms['realm:prefix:acme'].manager_key, 'key-one');
        assert.strictEqual(realms['realm:prefix:acme'].required, true);

        const rotated = await httpPost(server.port, '/api/realms',
            { realm: 'realm:prefix:acme', manager_key: 'key-two' }, auth);
        assert.strictEqual(rotated.status, 200, rotated.body);
        assert.strictEqual(JSON.parse(rotated.body).created, false);
        const realmsAfter = server.server.settings.get('auth').realms || {};
        assert.strictEqual(realmsAfter['realm:prefix:acme'].manager_key, 'key-two');
    } finally {
        await server.close();
    }
});

test('create-realm rejects realms outside the token prefix and reserved realms', async () => {
    const mgmtToken = 'mgmt-prefix-token';
    const server = await startServer({
        http_api: { enabled: true },
        auth: {
            enabled: true,
            management_tokens: [{ token: mgmtToken, realm_prefix: 'realm:prefix:' }]
        }
    });
    const auth = { authorization: 'Bearer ' + mgmtToken };
    try {
        const cases = ['org:evil', 'realm:prefix:', '*', 'default', 'apps:other:x'];
        for (const realm of cases) {
            const res = await httpPost(server.port, '/api/realms',
                { realm: realm, manager_key: 'k' }, auth);
            assert.strictEqual(res.status, 403, 'realm "' + realm + '" must be 403: ' + res.body);
        }
        const realms = server.server.settings.get('auth').realms || {};
        assert.ok(!realms['org:evil'] && !realms['apps:other:x'], 'no rejected realm should exist');
    } finally {
        await server.close();
    }
});

test('create-realm validates the request body', async () => {
    const mgmtToken = 'mgmt-body-token';
    const server = await startServer({
        http_api: { enabled: true },
        auth: {
            enabled: true,
            management_tokens: [{ token: mgmtToken, realm_prefix: 'realm:prefix:' }]
        }
    });
    const auth = { authorization: 'Bearer ' + mgmtToken };
    try {
        const noRealm = await httpPost(server.port, '/api/realms', { manager_key: 'k' }, auth);
        assert.strictEqual(noRealm.status, 400, noRealm.body);

        const noKey = await httpPost(server.port, '/api/realms', { realm: 'realm:prefix:acme' }, auth);
        assert.strictEqual(noKey.status, 400, noKey.body);

        const badJson = await httpPost(server.port, '/api/realms', 'not-json{', auth);
        assert.strictEqual(badJson.status, 400, badJson.body);
    } finally {
        await server.close();
    }
});

test('create-realm persists the new realm to the settings file', async () => {
    const os = require('os');
    const path = require('path');
    const fs = require('fs');
    const mgmtToken = 'mgmt-persist-token';
    const settingsPath = path.join(os.tmpdir(), 'tyo-mq-mgmt-' + process.pid + '-' + Date.now() + '.json');
    const server = await startServer({
        http_api: { enabled: true },
        auth: {
            enabled: true,
            management_tokens: [{ token: mgmtToken, realm_prefix: 'realm:prefix:' }]
        }
    });
    server.server.loadSettings(settingsPath);
    const auth = { authorization: 'Bearer ' + mgmtToken };
    try {
        const res = await httpPost(server.port, '/api/realms',
            { realm: 'realm:prefix:persist', manager_key: 'persist-key' }, auth);
        assert.strictEqual(res.status, 200, res.body);
        const onDisk = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
        assert.strictEqual(onDisk.auth.realms['realm:prefix:persist'].manager_key, 'persist-key');
    } finally {
        await server.close();
        try { require('fs').unlinkSync(settingsPath); } catch (e) { /* ignore */ }
    }
});

test('create-realm rejects an over-limit request body with 400', async () => {
    const mgmtToken = 'mgmt-oversize-token';
    const server = await startServer({
        http_api: { enabled: true },
        auth: {
            enabled: true,
            management_tokens: [{ token: mgmtToken, realm_prefix: 'realm:prefix:' }]
        }
    });
    const auth = { authorization: 'Bearer ' + mgmtToken };
    try {
        // A >64KB body must be rejected with a deliverable 400 (not a torn-down
        // connection), proving the over-limit branch no longer destroys the socket.
        const huge = JSON.stringify({ realm: 'realm:prefix:big', manager_key: 'x'.repeat(70 * 1024) });
        const res = await httpPost(server.port, '/api/realms', huge, auth);
        assert.strictEqual(res.status, 400, 'over-limit body must yield a 400: ' + res.body);
    } finally {
        await server.close();
    }
});

run();
