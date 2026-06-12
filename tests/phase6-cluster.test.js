/**
 * Phase 6 (tier 1): cluster settings sync over Redis.
 *
 * Multiple tyo-mq nodes share one Redis. Managed settings (realms, keys,
 * tokens) written on any node propagate to every node, and signed manager
 * proofs cannot be replayed against a different node.
 *
 * The tests use an in-process fake Redis hub: every client created from the
 * hub shares the same keyspace and pub/sub channels, like one real server.
 *
 * Usage: node tests/phase6-cluster.test.js
 */

'use strict';

const assert = require('assert');
const ioClient = require('socket.io-client');
const adminSignature = require('../lib/admin-signature');
const Authorization = require('../lib/authorization');
const { test, run } = require('./runner');
const { startServer, delay, waitFor } = require('./helpers');

const ADMIN_TOKEN = 'phase6-admin-token';

// ── fake redis hub ────────────────────────────────────────────────────────────

function FakeRedisHub() {
    this.values = {};
    this.expirations = {};
    this.subscribers = {};
}

FakeRedisHub.prototype.createClient = function () {
    return new FakeHubClient(this);
};

function FakeHubClient(hub) {
    this.hub = hub;
}

FakeHubClient.prototype._expired = function (key) {
    return this.hub.expirations[key] && this.hub.expirations[key] <= Date.now();
};

FakeHubClient.prototype.sendCommand = function (args) {
    const hub = this.hub;
    const cmd = String(args[0]).toUpperCase();
    const key = args[1];

    if (cmd === 'SET') {
        const value = args[2];
        let nx = false;
        let pxMs = null;
        for (let i = 3; i < args.length; i++) {
            const flag = String(args[i]).toUpperCase();
            if (flag === 'NX') nx = true;
            if (flag === 'PX') pxMs = Number(args[++i]);
        }
        const exists = hub.values[key] !== undefined && !this._expired(key);
        if (nx && exists)
            return Promise.resolve(null);
        hub.values[key] = value;
        delete hub.expirations[key];
        if (pxMs !== null)
            hub.expirations[key] = Date.now() + pxMs;
        return Promise.resolve('OK');
    }
    if (cmd === 'GET') {
        if (this._expired(key)) {
            delete hub.values[key];
            return Promise.resolve(null);
        }
        return Promise.resolve(hub.values[key] !== undefined ? hub.values[key] : null);
    }
    if (cmd === 'INCR') {
        const next = (Number(hub.values[key]) || 0) + 1;
        hub.values[key] = String(next);
        return Promise.resolve(next);
    }
    if (cmd === 'PUBLISH') {
        const listeners = (hub.subscribers[key] || []).slice();
        const message = args[2];
        setImmediate(function () {
            listeners.forEach(function (listener) {
                listener(message, key);
            });
        });
        return Promise.resolve(listeners.length);
    }
    if (cmd === 'DEL') {
        delete hub.values[key];
        delete hub.expirations[key];
        return Promise.resolve(1);
    }
    return Promise.reject(new Error('Unsupported fake redis command: ' + cmd));
};

FakeHubClient.prototype.subscribe = function (channel, listener) {
    this.hub.subscribers[channel] = this.hub.subscribers[channel] || [];
    this.hub.subscribers[channel].push(listener);
    return Promise.resolve();
};

FakeHubClient.prototype.duplicate = function () {
    return new FakeHubClient(this.hub);
};

FakeHubClient.prototype.quit = function () {
    return Promise.resolve();
};

// ── helpers ───────────────────────────────────────────────────────────────────

const RELAY_TOKEN = 'phase6-relay-both-token';

function clusterNode(hub, prefix) {
    return startServer({
        auth: {
            enabled: true,
            tokens: [
                { token: ADMIN_TOKEN, realm: '*', role: 'admin' },
                { token: RELAY_TOKEN, realm: 'phase6-relay-realm', role: 'both' }
            ]
        },
        cluster: {
            enabled: true,
            prefix: prefix,
            client: hub.createClient(),
            subscriber: hub.createClient()
        }
    });
}

function relayFactory(port) {
    const Factory = require('../lib/factory');
    return new Factory({
        host: '127.0.0.1',
        port: port,
        protocol: 'http',
        auth: { token: RELAY_TOKEN }
    });
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

function emitAck(socket, event, payload) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('timeout waiting for ' + event + ' ack')), 3000);
        socket.emit(event, payload, function (response) {
            clearTimeout(timer);
            resolve(response);
        });
    });
}

// ── tests ─────────────────────────────────────────────────────────────────────

test('management settings changes on one node propagate to peer nodes', async () => {
    const hub = new FakeRedisHub();
    const nodeA = await clusterNode(hub, 'p6-propagate');
    const nodeB = await clusterNode(hub, 'p6-propagate');
    const optionsA = { host: '127.0.0.1', port: nodeA.port, protocol: 'http' };

    let socket;
    try {
        await delay(300); // let both nodes join the cluster

        await Authorization.authManagementCommand(ADMIN_TOKEN, {
            command: 'add_realm',
            realm: 'cluster-realm',
            required: true
        }, optionsA);
        await Authorization.authManagementCommand(ADMIN_TOKEN, {
            command: 'set_realm_key',
            realm: 'cluster-realm',
            key: 'cluster-psk'
        }, optionsA);
        await delay(400); // propagation

        // Node B must now enforce and accept the key set through node A.
        socket = await connect(nodeB.port);
        const withKey = await authenticate(socket, { realm: 'cluster-realm', role: 'consumer', key: 'cluster-psk' });
        assert.strictEqual(withKey.ok, true, JSON.stringify(withKey));
        assert.deepStrictEqual(withKey.info, { realm: 'cluster-realm', role: 'consumer' });
        socket.disconnect();

        socket = await connect(nodeB.port);
        const withoutKey = await authenticate(socket, { realm: 'cluster-realm', role: 'consumer' });
        assert.strictEqual(withoutKey.ok, false, 'node B must require the synced key');
        assert.strictEqual(withoutKey.fail.code, 401);
    } finally {
        if (socket) socket.disconnect();
        await nodeA.close();
        await nodeB.close();
    }
});

test('authorization token approved on one node authenticates on a peer node', async () => {
    const hub = new FakeRedisHub();
    const nodeA = await clusterNode(hub, 'p6-approve');
    const nodeB = await clusterNode(hub, 'p6-approve');
    const optionsA = { host: '127.0.0.1', port: nodeA.port, protocol: 'http' };

    let socket;
    try {
        await delay(300);

        const submitted = await Authorization.submitAuthorizationRequest({
            realm: 'cluster-approve-realm',
            role: 'producer',
            client_id: 'cluster-client-1',
            client_name: 'Cluster Client',
            client_token: 'cluster-approved-token'
        }, optionsA);
        await Authorization.decideAuthorizationRequest(ADMIN_TOKEN, {
            request_id: submitted.request_id,
            approved: true,
            role: 'producer'
        }, optionsA);
        await delay(400);

        socket = await connect(nodeB.port);
        const granted = await authenticate(socket, { token: 'cluster-approved-token' });
        assert.strictEqual(granted.ok, true, JSON.stringify(granted));
        assert.deepStrictEqual(granted.info, { realm: 'cluster-approve-realm', role: 'producer' });
    } finally {
        if (socket) socket.disconnect();
        await nodeA.close();
        await nodeB.close();
    }
});

test('manager proof cannot be replayed against a peer node', async () => {
    const hub = new FakeRedisHub();
    const nodeA = await clusterNode(hub, 'p6-replay');
    const nodeB = await clusterNode(hub, 'p6-replay');

    let socketA;
    let socketB;
    try {
        await delay(300);

        // One signed payload, sent verbatim to both nodes.
        const body = { command: 'get' };
        const payload = {
            body: body,
            proof: adminSignature.createAdminProof(ADMIN_TOKEN, 'AUTH_MANAGEMENT_COMMAND', body)
        };

        socketA = await connect(nodeA.port);
        const first = await emitAck(socketA, 'AUTH_MANAGEMENT_COMMAND', payload);
        assert.strictEqual(first.ok, true, JSON.stringify(first));

        socketB = await connect(nodeB.port);
        const replayed = await emitAck(socketB, 'AUTH_MANAGEMENT_COMMAND', payload);
        assert.strictEqual(replayed.ok, false, 'replayed proof must be rejected cluster-wide');
        assert.strictEqual(replayed.code, 401);
    } finally {
        if (socketA) socketA.disconnect();
        if (socketB) socketB.disconnect();
        await nodeA.close();
        await nodeB.close();
    }
});

test('a node joining later adopts the settings already in the cluster', async () => {
    const hub = new FakeRedisHub();
    const nodeA = await clusterNode(hub, 'p6-late-join');
    const optionsA = { host: '127.0.0.1', port: nodeA.port, protocol: 'http' };

    let nodeC;
    let socket;
    try {
        await delay(300);

        await Authorization.authManagementCommand(ADMIN_TOKEN, {
            command: 'add_realm',
            realm: 'late-join-realm',
            required: true
        }, optionsA);
        await Authorization.authManagementCommand(ADMIN_TOKEN, {
            command: 'set_realm_key',
            realm: 'late-join-realm',
            key: 'late-join-psk'
        }, optionsA);
        await delay(200);

        nodeC = await clusterNode(hub, 'p6-late-join');
        await delay(400); // bootstrap from redis

        // The late joiner must ENFORCE the synced key, not merely accept it —
        // an unsynced node would let a key-less consumer straight in.
        socket = await connect(nodeC.port);
        const withoutKey = await authenticate(socket, { realm: 'late-join-realm', role: 'consumer' });
        assert.strictEqual(withoutKey.ok, false, 'late joiner must require the synced key');
        assert.strictEqual(withoutKey.fail.code, 401);
        socket.disconnect();

        socket = await connect(nodeC.port);
        const granted = await authenticate(socket, { realm: 'late-join-realm', role: 'consumer', key: 'late-join-psk' });
        assert.strictEqual(granted.ok, true, JSON.stringify(granted));
        assert.deepStrictEqual(granted.info, { realm: 'late-join-realm', role: 'consumer' });
    } finally {
        if (socket) socket.disconnect();
        if (nodeC) await nodeC.close();
        await nodeA.close();
    }
});

test('authorization request submitted on one node is decided from a peer node', async () => {
    const hub = new FakeRedisHub();
    const nodeA = await clusterNode(hub, 'p6-authreq');
    const nodeB = await clusterNode(hub, 'p6-authreq');
    const optionsB = { host: '127.0.0.1', port: nodeB.port, protocol: 'http' };

    let requesterSocket;
    let clientSocket;
    try {
        await delay(300);

        // Requester connects to node A and keeps the socket open for the
        // approval notification.
        requesterSocket = await connect(nodeA.port);
        const approvedPromise = waitFor(requesterSocket, 'AUTHORIZATION_APPROVED', 6000);
        const submitted = await emitAck(requesterSocket, 'AUTHORIZATION_REQUEST', {
            realm: 'cross-node-auth-realm',
            role: 'consumer',
            client_id: 'cross-node-client',
            client_name: 'Cross Node Client',
            client_token: 'cross-node-client-token'
        });
        assert.strictEqual(submitted.ok, true, JSON.stringify(submitted));
        await delay(300);

        // A manager polling node B sees the request submitted via node A...
        const next = await Authorization.nextAuthorizationRequest(ADMIN_TOKEN, {}, optionsB);
        assert.ok(next.request, 'peer node must see the pending request');
        assert.strictEqual(next.request.request_id, submitted.request_id);
        assert.strictEqual(next.request.realm, 'cross-node-auth-realm');

        // ...and decides it there.
        const decision = await Authorization.decideAuthorizationRequest(ADMIN_TOKEN, {
            request_id: submitted.request_id,
            approved: true,
            role: 'consumer'
        }, optionsB);
        assert.strictEqual(decision.request.status, 'approved');

        // The requester, connected to node A, still gets the notification.
        const approved = await approvedPromise;
        assert.strictEqual(approved.request_id, submitted.request_id);
        assert.strictEqual(approved.realm, 'cross-node-auth-realm');

        // The approved token authenticates against node A too (settings sync).
        await delay(300);
        clientSocket = await connect(nodeA.port);
        const granted = await authenticate(clientSocket, { token: 'cross-node-client-token' });
        assert.strictEqual(granted.ok, true, JSON.stringify(granted));
        assert.deepStrictEqual(granted.info, { realm: 'cross-node-auth-realm', role: 'consumer' });
    } finally {
        if (requesterSocket) requesterSocket.disconnect();
        if (clientSocket) clientSocket.disconnect();
        await nodeA.close();
        await nodeB.close();
    }
});

test('live message from a producer on one node reaches a consumer on a peer node', async () => {
    const hub = new FakeRedisHub();
    const nodeA = await clusterNode(hub, 'p6-relay');
    const nodeB = await clusterNode(hub, 'p6-relay');

    let producer;
    let consumer;
    let topicConsumer;
    try {
        await delay(300);

        producer = await relayFactory(nodeA.port).createProducer('relay-producer');
        consumer = await relayFactory(nodeB.port).createConsumer('relay-consumer');
        topicConsumer = await relayFactory(nodeB.port).createConsumer('relay-topic-consumer');

        const received = [];
        consumer.subscribe(producer.name, 'cross-node-event', function (message) {
            received.push(message);
        });
        const topicReceived = [];
        topicConsumer.subscribe('org/relay/+/cmd', function (message) {
            topicReceived.push(message);
        }, { mode: 'topic' });
        await delay(400);

        producer.produce('cross-node-event', 'over-the-wire');
        producer.produce('org/relay/m1/cmd', 'topic-over-the-wire');
        await delay(900);

        assert.deepStrictEqual(received, ['over-the-wire'],
            'consumer on peer node must receive exactly one copy');
        assert.deepStrictEqual(topicReceived, ['topic-over-the-wire'],
            'topic subscriber on peer node must receive exactly one copy');
    } finally {
        if (producer) producer.disconnect();
        if (consumer) consumer.disconnect();
        if (topicConsumer) topicConsumer.disconnect();
        await nodeA.close();
        await nodeB.close();
    }
});

test('realm broadcast reaches subscribers connected to peer nodes', async () => {
    const hub = new FakeRedisHub();
    const nodeA = await clusterNode(hub, 'p6-relay-bcast');
    const nodeB = await clusterNode(hub, 'p6-relay-bcast');

    let producer;
    let consumer;
    try {
        await delay(300);

        producer = await relayFactory(nodeA.port).createProducer('relay-bcast-producer');
        consumer = await relayFactory(nodeB.port).createConsumer('relay-bcast-consumer');

        const received = [];
        consumer.subscribe(producer.name, 'bcast-event', function (message) {
            received.push(message);
        });
        await delay(400);

        producer.produce('bcast-event', 'realm-wide', { broadcast: 'realm' });
        await delay(900);

        assert.deepStrictEqual(received, ['realm-wide'],
            'broadcast must reach the peer node exactly once');
    } finally {
        if (producer) producer.disconnect();
        if (consumer) consumer.disconnect();
        await nodeA.close();
        await nodeB.close();
    }
});

run();
