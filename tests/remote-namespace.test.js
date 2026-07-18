/**
 * /remote namespace streaming tests.
 *
 * Usage: node tests/remote-namespace.test.js
 */

'use strict';

const assert = require('assert');
const { test, run } = require('./runner');
const TyoMQServer = require('../lib/server');
const ioClient = require('socket.io-client');

const PORT = 17360;
const noop = () => {};

const server = new TyoMQServer({ port: PORT });
server.logger = { critical: noop, error: noop, warn: noop, output: noop, log: noop, info: noop, debug: noop, trace: noop };
server.start(PORT);

function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function connectRemote(ticket, role, sessionId, port) {
    port = port || PORT;
    return new Promise((resolve, reject) => {
        const socket = ioClient('http://127.0.0.1:' + port + '/remote', { transports: ['websocket'] });
        let done = false;
        const timer = setTimeout(() => {
            if (done) return;
            done = true;
            socket.disconnect();
            reject(new Error('timeout'));
        }, 5000);

        function finish(err, data) {
            if (done) return;
            done = true;
            clearTimeout(timer);
            if (err) {
                socket.disconnect();
                reject(err);
                return;
            }
            resolve({ socket, data });
        }

        socket.on('connect', () => {
            socket.emit('auth', { ticket, role, session_id: sessionId });
        });
        socket.on('auth_ok', data => finish(null, data));
        socket.on('auth_error', err => finish(new Error(err && err.message ? err.message : 'auth failed')));
        socket.on('connect_error', finish);
    });
}

function connectMain(port) {
    port = port || PORT;
    return new Promise((resolve, reject) => {
        const socket = ioClient('http://127.0.0.1:' + port, { transports: ['websocket'] });
        const timer = setTimeout(() => {
            socket.disconnect();
            reject(new Error('main namespace timeout'));
        }, 5000);

        socket.on('connect', () => {
            clearTimeout(timer);
            resolve(socket);
        });
        socket.on('connect_error', err => {
            clearTimeout(timer);
            socket.disconnect();
            reject(err);
        });
    });
}

function waitFor(socket, event, timeout) {
    timeout = timeout || 5000;
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(event + ' timeout')), timeout);
        socket.once(event, data => {
            clearTimeout(timer);
            resolve(data);
        });
    });
}

function emitAck(socket, event, payload) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(event + ' timeout')), 5000);
        socket.emit(event, payload, response => {
            clearTimeout(timer);
            if (!response || response.ok === false) {
                const err = new Error((response && response.message) || (event + ' failed'));
                err.response = response;
                reject(err);
                return;
            }
            resolve(response);
        });
    });
}

test('issue ticket and agent can authenticate on /remote', async () => {
    const sessionId = 'sess-' + Date.now();
    const ticket = server.remote.issueTicket({
        session_id: sessionId,
        realm: 'test',
        machine_id: 'host-1',
        role: 'agent'
    });
    assert.ok(ticket && ticket.length === 32, 'ticket should be 32-char hex');

    const { socket, data } = await connectRemote(ticket, 'agent', sessionId);
    assert.strictEqual(data.session_id, sessionId);
    assert.strictEqual(data.role, 'agent');
    socket.disconnect();
});

test('expired / wrong ticket is rejected', async () => {
    await assert.rejects(
        () => connectRemote('deadbeef0000000000000000deadbeef', 'viewer', 'sess-x'),
        /Invalid or expired ticket/
    );
});

test('frame relay: agent frame arrives at viewer as binary Buffer', async () => {
    const sessionId = 'sess-frame-' + Date.now();
    const agentTicket = server.remote.issueTicket({ session_id: sessionId, realm: 'test', machine_id: 'host-1', role: 'agent' });
    const viewerTicket = server.remote.issueTicket({ session_id: sessionId, realm: 'test', machine_id: 'host-1', role: 'viewer' });

    const { socket: agentSock } = await connectRemote(agentTicket, 'agent', sessionId);
    const { socket: viewerSock } = await connectRemote(viewerTicket, 'viewer', sessionId);

    const fakeJpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
    const fakeB64 = fakeJpeg.toString('base64');

    const received = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('frame timeout')), 4000);
        viewerSock.on('frame', data => {
            clearTimeout(timer);
            resolve(data);
        });
        agentSock.emit('frame', { session_id: sessionId, frame: fakeB64 });
    });

    assert.ok(Buffer.isBuffer(received) || received instanceof Uint8Array, 'viewer should receive binary');
    const buf = Buffer.isBuffer(received) ? received : Buffer.from(received);
    assert.deepStrictEqual(buf.subarray(0, 4), fakeJpeg.subarray(0, 4), 'JPEG magic bytes must match');

    agentSock.disconnect();
    viewerSock.disconnect();
});

test('input relay: viewer input.mouse arrives at agent', async () => {
    const sessionId = 'sess-input-' + Date.now();
    const agentTicket = server.remote.issueTicket({ session_id: sessionId, realm: 'test', machine_id: 'host-1', role: 'agent' });
    const viewerTicket = server.remote.issueTicket({ session_id: sessionId, realm: 'test', machine_id: 'host-1', role: 'viewer' });

    const { socket: agentSock } = await connectRemote(agentTicket, 'agent', sessionId);
    const { socket: viewerSock } = await connectRemote(viewerTicket, 'viewer', sessionId);

    const received = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('input timeout')), 4000);
        agentSock.on('input.mouse', data => {
            clearTimeout(timer);
            resolve(data);
        });
        viewerSock.emit('input.mouse', { session_id: sessionId, x: 100, y: 200, button: 'left', type: 'click' });
    });

    assert.strictEqual(received.x, 100);
    assert.strictEqual(received.y, 200);
    assert.strictEqual(received.button, 'left');

    agentSock.disconnect();
    viewerSock.disconnect();
});

test('input relay: viewer input.keyboard arrives at agent', async () => {
    const sessionId = 'sess-keyboard-' + Date.now();
    const agentTicket = server.remote.issueTicket({ session_id: sessionId, realm: 'test', machine_id: 'host-1', role: 'agent' });
    const viewerTicket = server.remote.issueTicket({ session_id: sessionId, realm: 'test', machine_id: 'host-1', role: 'viewer' });

    const { socket: agentSock } = await connectRemote(agentTicket, 'agent', sessionId);
    const { socket: viewerSock } = await connectRemote(viewerTicket, 'viewer', sessionId);

    const received = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('keyboard input timeout')), 4000);
        agentSock.on('input.keyboard', data => {
            clearTimeout(timer);
            resolve(data);
        });
        viewerSock.emit('input.keyboard', { session_id: sessionId, key: 'A', code: 'KeyA', type: 'keydown' });
    });

    assert.strictEqual(received.key, 'A');
    assert.strictEqual(received.code, 'KeyA');
    assert.strictEqual(received.type, 'keydown');

    agentSock.disconnect();
    viewerSock.disconnect();
});

// Emit `event` (expected NOT to arrive), then a control event that IS
// relayed on the same connection; per-connection ordering means once the
// control arrives, the earlier event would have arrived too if it were
// going to.
async function assertNotRelayed(senderSock, receiverSock, event, payload, controlEvent, controlPayload) {
    let leaked = false;
    receiverSock.on(event, () => { leaked = true; });
    const control = new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('control event timeout')), 4000);
        receiverSock.once(controlEvent, () => { clearTimeout(timer); resolve(); });
    });
    senderSock.emit(event, payload);
    senderSock.emit(controlEvent, controlPayload);
    await control;
    assert.strictEqual(leaked, false, `'${event}' must not be relayed`);
}

async function startSessionPair(sessionId, srv) {
    srv = srv || server;
    const port = srv === server ? PORT : srv._testPort;
    const agentTicket = srv.remote.issueTicket({ session_id: sessionId, realm: 'test', machine_id: 'h1', role: 'agent' });
    const viewerTicket = srv.remote.issueTicket({ session_id: sessionId, realm: 'test', machine_id: 'h1', role: 'viewer' });
    const { socket: agentSock } = await connectRemote(agentTicket, 'agent', sessionId, port);
    const { socket: viewerSock } = await connectRemote(viewerTicket, 'viewer', sessionId, port);
    return { agentSock, viewerSock };
}

test('WebRTC signaling: ready/offer/answer relay in their directions', async () => {
    const sessionId = 'sess-rtc-' + Date.now();
    const { agentSock, viewerSock } = await startSessionPair(sessionId);

    // viewer → agent: rtc.ready starts the handshake
    const readyAtAgent = waitFor(agentSock, 'rtc.ready');
    viewerSock.emit('rtc.ready', { viewer: 'v1' });
    assert.deepStrictEqual(await readyAtAgent, { viewer: 'v1' });

    // agent → viewers: the SDP offer
    const offerAtViewer = waitFor(viewerSock, 'rtc.offer');
    agentSock.emit('rtc.offer', { sdp: 'v=0 fake-offer', type: 'offer' });
    assert.strictEqual((await offerAtViewer).sdp, 'v=0 fake-offer');

    // viewer → agent: the SDP answer
    const answerAtAgent = waitFor(agentSock, 'rtc.answer');
    viewerSock.emit('rtc.answer', { sdp: 'v=0 fake-answer', type: 'answer' });
    assert.strictEqual((await answerAtAgent).sdp, 'v=0 fake-answer');

    agentSock.disconnect();
    viewerSock.disconnect();
});

test('WebRTC signaling: rtc.ice routes to the opposite role from both sides', async () => {
    const sessionId = 'sess-ice-' + Date.now();
    const { agentSock, viewerSock } = await startSessionPair(sessionId);

    const iceAtAgent = waitFor(agentSock, 'rtc.ice');
    viewerSock.emit('rtc.ice', { candidate: 'from-viewer' });
    assert.strictEqual((await iceAtAgent).candidate, 'from-viewer');

    const iceAtViewer = waitFor(viewerSock, 'rtc.ice');
    agentSock.emit('rtc.ice', { candidate: 'from-agent' });
    assert.strictEqual((await iceAtViewer).candidate, 'from-agent');

    agentSock.disconnect();
    viewerSock.disconnect();
});

test('control events: input.sas and remote.setmonitor relay viewer → agent', async () => {
    const sessionId = 'sess-ctl-' + Date.now();
    const { agentSock, viewerSock } = await startSessionPair(sessionId);

    const sasAtAgent = waitFor(agentSock, 'input.sas');
    viewerSock.emit('input.sas', {});
    assert.deepStrictEqual(await sasAtAgent, {});

    const monitorAtAgent = waitFor(agentSock, 'remote.setmonitor');
    viewerSock.emit('remote.setmonitor', { monitor: 2 });
    assert.strictEqual((await monitorAtAgent).monitor, 2);

    agentSock.disconnect();
    viewerSock.disconnect();
});

test('role guards: a viewer-sent rtc.offer is dropped, not caught-all', async () => {
    const sessionId = 'sess-guard-' + Date.now();
    const { agentSock, viewerSock } = await startSessionPair(sessionId);

    // rtc.offer has an explicit from:'agent' rule — a viewer emitting it
    // must be dropped entirely (the catch-all must not resurrect it).
    await assertNotRelayed(viewerSock, agentSock,
        'rtc.offer', { sdp: 'forged' },
        'rtc.ready', {});

    agentSock.disconnect();
    viewerSock.disconnect();
});

test('catch-all: unlisted events relay to the opposite role in both directions', async () => {
    const sessionId = 'sess-any-' + Date.now();
    const { agentSock, viewerSock } = await startSessionPair(sessionId);

    const clipboardAtAgent = waitFor(agentSock, 'clipboard.set');
    viewerSock.emit('clipboard.set', { text: 'hello' });
    assert.strictEqual((await clipboardAtAgent).text, 'hello');

    const statsAtViewer = waitFor(viewerSock, 'agent.stats');
    agentSock.emit('agent.stats', { fps: 30 });
    assert.strictEqual((await statsAtViewer).fps, 30);

    agentSock.disconnect();
    viewerSock.disconnect();
});

test('catch-all: multi-arg payloads relay; ack callbacks are stripped', async () => {
    const sessionId = 'sess-args-' + Date.now();
    const { agentSock, viewerSock } = await startSessionPair(sessionId);

    const received = new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('multi-arg timeout')), 4000);
        agentSock.on('custom.multi', (a, b) => { clearTimeout(timer); resolve([a, b]); });
    });
    viewerSock.emit('custom.multi', { a: 1 }, { b: 2 }, () => {}); // ack never fires — relay doesn't ack
    assert.deepStrictEqual(await received, [{ a: 1 }, { b: 2 }]);

    agentSock.disconnect();
    viewerSock.disconnect();
});

test('reserved events are never relayed (auth_ok cannot be forged)', async () => {
    const sessionId = 'sess-reserved-' + Date.now();
    const { agentSock, viewerSock } = await startSessionPair(sessionId);

    await assertNotRelayed(viewerSock, agentSock,
        'auth_ok', { session_id: 'spoofed', role: 'admin' },
        'rtc.ready', {});

    agentSock.disconnect();
    viewerSock.disconnect();
});

test('relay config: allow-list mode and per-event disable via options', async () => {
    const strictPort = PORT + 2;
    const strictServer = new TyoMQServer({
        port: strictPort,
        remote: {
            relay_unlisted: 'off',
            relay: {
                'custom.allowed': { from: 'viewer', to: 'agent' },
                'input.sas': { enabled: false }
            }
        }
    });
    strictServer.logger = { critical: noop, error: noop, warn: noop, output: noop, log: noop, info: noop, debug: noop, trace: noop };
    strictServer.start(strictPort);
    strictServer._testPort = strictPort;

    const sessionId = 'sess-strict-' + Date.now();
    const { agentSock, viewerSock } = await startSessionPair(sessionId, strictServer);

    // The configured custom event relays…
    const allowedAtAgent = waitFor(agentSock, 'custom.allowed');
    viewerSock.emit('custom.allowed', { ok: true });
    assert.strictEqual((await allowedAtAgent).ok, true);

    // …an unlisted one does not (allow-list mode)…
    await assertNotRelayed(viewerSock, agentSock,
        'custom.unlisted', {},
        'custom.allowed', {});

    // …and a disabled built-in does not either.
    await assertNotRelayed(viewerSock, agentSock,
        'input.sas', {},
        'custom.allowed', {});

    agentSock.disconnect();
    viewerSock.disconnect();
});

test('relay config hot-reloads from settings within a second', async () => {
    const sessionId = 'sess-reload-' + Date.now();
    const { agentSock, viewerSock } = await startSessionPair(sessionId);

    // Disable input.mouse at runtime…
    server.settings.merge({ remote: { relay: { 'input.mouse': { enabled: false } } } });
    await delay(1100); // relay table cache TTL

    await assertNotRelayed(viewerSock, agentSock,
        'input.mouse', { x: 1, y: 1 },
        'rtc.ready', {});

    // …and re-enable it (settings are deep-merged, so the earlier
    // enabled:false must be overridden explicitly).
    server.settings.merge({ remote: { relay: { 'input.mouse': { from: 'viewer', to: 'agent', enabled: true } } } });
    await delay(1100);

    const mouseAtAgent = waitFor(agentSock, 'input.mouse');
    viewerSock.emit('input.mouse', { x: 5, y: 6 });
    assert.strictEqual((await mouseAtAgent).x, 5);

    agentSock.disconnect();
    viewerSock.disconnect();
});

test('authenticated main namespace can request a remote ticket', async () => {
    const mainSock = await connectMain();
    try {
        const response = await emitAck(mainSock, 'REMOTE_TICKET_REQUEST', {
            session_id: 'sess-main-' + Date.now(),
            machine_id: 'host-main',
            role: 'viewer'
        });

        assert.strictEqual(response.ok, true);
        assert.strictEqual(response.role, 'viewer');
        assert.strictEqual(response.expires_in, 60);
        assert.ok(response.ticket);

        const { socket: remoteSock, data } = await connectRemote(response.ticket, 'viewer', response.session_id);
        assert.strictEqual(data.session_id, response.session_id);
        assert.strictEqual(data.role, 'viewer');
        remoteSock.disconnect();
    }
    finally {
        mainSock.disconnect();
    }
});

test('auth-enabled main namespace issues remote tickets only after authentication', async () => {
    const authPort = PORT + 1;
    const authServer = new TyoMQServer({
        port: authPort,
        auth: {
            enabled: true,
            tokens: [
                {token: 'remote-agent-token', realm: 'remote-realm', role: 'both'}
            ]
        }
    });
    authServer.logger = { critical: noop, error: noop, warn: noop, output: noop, log: noop, info: noop, debug: noop, trace: noop };
    authServer.start(authPort);

    const mainSock = await connectMain(authPort);
    try {
        const failPromise = waitFor(mainSock, 'AUTH_FAIL');
        mainSock.emit('REMOTE_TICKET_REQUEST', {session_id: 'preauth'});
        const fail = await failPromise;
        assert.strictEqual(fail.code, 401);

        mainSock.emit('AUTHENTICATION', {token: 'remote-agent-token'});
        const ok = await waitFor(mainSock, 'AUTH_OK');
        assert.deepStrictEqual(ok, {realm: 'remote-realm', role: 'both'});

        const response = await emitAck(mainSock, 'REMOTE_TICKET_REQUEST', {
            session_id: 'sess-auth-' + Date.now(),
            machine_id: 'auth-host',
            role: 'agent'
        });

        assert.strictEqual(response.ok, true);
        assert.strictEqual(response.role, 'agent');
        assert.ok(response.ticket);

        const { socket: remoteSock, data } = await connectRemote(response.ticket, 'agent', response.session_id, authPort);
        assert.strictEqual(data.session_id, response.session_id);
        assert.strictEqual(data.role, 'agent');
        remoteSock.disconnect();
    }
    finally {
        mainSock.disconnect();
    }
});

test('getSession returns live session state', async () => {
    const sessionId = 'sess-introspect-' + Date.now();
    const agentTicket = server.remote.issueTicket({ session_id: sessionId, realm: 'test', machine_id: 'h1', role: 'agent' });
    const { socket: agentSock } = await connectRemote(agentTicket, 'agent', sessionId);

    const info = server.remote.getSession(sessionId);
    assert.ok(info, 'session should exist');
    assert.strictEqual(info.agent_connected, true);
    assert.strictEqual(info.viewer_count, 0);

    agentSock.disconnect();
    await delay(200);
    const after = server.remote.getSession(sessionId);
    assert.strictEqual(after, null, 'session should be cleaned up after last socket disconnects');
});

run();
