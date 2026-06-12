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

run();
