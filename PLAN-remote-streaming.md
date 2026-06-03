# tyo-mq `/remote` Binary Streaming Namespace — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Add a `/remote` Socket.io namespace to tyo-mq that streams binary JPEG frames from an agent to browser viewers, with input events flowing back, all authenticated via one-time session tickets.

**Architecture:** Authenticated agents (on the main `/` namespace) request a session ticket with `REMOTE_TICKET_REQUEST`; the ticket is handed to viewers out-of-band (via the management REST API). Both agent and viewer connect to `/remote`, authenticate with their ticket, and join a session room. Frames arrive from the agent as base64 JSON, the server decodes them to `Buffer` and re-emits true binary to viewers. Input events travel viewer → server → agent room.

**Tech Stack:** Node.js, Socket.io 4.x (already a dependency), in-memory ticket/session Map, no new npm packages.

---

## File Map

| Action | Path | Responsibility |
|--------|------|---------------|
| Create | `lib/remote-namespace.js` | `/remote` namespace: auth, rooms, frame routing, input routing |
| Modify | `lib/server.js` | Attach namespace after `io` is created; add `REMOTE_TICKET_REQUEST` handler in main namespace |
| Create | `tests/remote-namespace.test.js` | Integration tests: ticket issue, agent connect, viewer connect, frame relay, input relay |

---

## Task 1: `lib/remote-namespace.js` — Namespace Core

**Files:**
- Create: `lib/remote-namespace.js`

- [x] **Step 1: Write failing test — ticket issue and agent connect**

Create `tests/remote-namespace.test.js`:

```js
'use strict';

const assert  = require('assert');
const { test, run } = require('./runner');
const TyoMQServer = require('../lib/server');
const { io: ioc } = require('socket.io-client');

const PORT = 17360;
const noop = () => {};

const server = new TyoMQServer({ port: PORT });
server.logger = { critical: noop, error: noop, warn: noop, output: noop, log: noop, info: noop, debug: noop, trace: noop };
server.start(PORT);

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

function connectRemote(ticket, role, sessionId) {
    return new Promise((resolve, reject) => {
        const socket = ioc('http://127.0.0.1:' + PORT + '/remote', { transports: ['websocket'] });
        socket.on('connect', () => {
            socket.emit('auth', { ticket, role, session_id: sessionId });
        });
        socket.on('auth_ok', (data) => resolve({ socket, data }));
        socket.on('auth_error', (err) => reject(new Error(err.message)));
        socket.on('connect_error', reject);
        setTimeout(() => reject(new Error('timeout')), 5000);
    });
}

test('issue ticket and agent can authenticate on /remote', async () => {
    const sessionId = 'sess-' + Date.now();
    const ticket = server.remote.issueTicket({ session_id: sessionId, realm: 'test', machine_id: 'host-1', role: 'agent' });
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
    const agentTicket  = server.remote.issueTicket({ session_id: sessionId, realm: 'test', machine_id: 'host-1', role: 'agent' });
    const viewerTicket = server.remote.issueTicket({ session_id: sessionId, realm: 'test', machine_id: 'host-1', role: 'viewer' });

    const { socket: agentSock }  = await connectRemote(agentTicket,  'agent',  sessionId);
    const { socket: viewerSock } = await connectRemote(viewerTicket, 'viewer', sessionId);

    const fakeJpeg   = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]); // JPEG magic
    const fakeB64    = fakeJpeg.toString('base64');

    const received = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('frame timeout')), 4000);
        viewerSock.on('frame', (data) => {
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
    const agentTicket  = server.remote.issueTicket({ session_id: sessionId, realm: 'test', machine_id: 'host-1', role: 'agent' });
    const viewerTicket = server.remote.issueTicket({ session_id: sessionId, realm: 'test', machine_id: 'host-1', role: 'viewer' });

    const { socket: agentSock }  = await connectRemote(agentTicket,  'agent',  sessionId);
    const { socket: viewerSock } = await connectRemote(viewerTicket, 'viewer', sessionId);

    const received = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('input timeout')), 4000);
        agentSock.on('input.mouse', (data) => { clearTimeout(timer); resolve(data); });
        viewerSock.emit('input.mouse', { session_id: sessionId, x: 100, y: 200, button: 'left', type: 'click' });
    });

    assert.strictEqual(received.x, 100);
    assert.strictEqual(received.y, 200);
    assert.strictEqual(received.button, 'left');

    agentSock.disconnect();
    viewerSock.disconnect();
});

run().then(() => process.exit(0)).catch(() => process.exit(1));
```

- [x] **Step 2: Run tests to confirm they all fail**

```bash
cd /data/tyolab/node/tyo-mq
node tests/remote-namespace.test.js
```
Expected: `TypeError: server.remote is undefined` (or similar — namespace not attached yet).

- [x] **Step 3: Implement `lib/remote-namespace.js`**

```js
'use strict';

const crypto = require('crypto');

/**
 * Attaches the /remote Socket.io namespace for binary frame streaming.
 *
 * Returns a `remote` object with:
 *   - issueTicket(params) → ticket string
 *   - sessions Map (for introspection/tests)
 */
module.exports = function attachRemoteNamespace(io) {
    // ticket → {session_id, realm, machine_id, role, expires}
    const tickets = new Map();
    // session_id → {agent: socket.id|null, viewers: Set<socket.id>}
    const sessions = new Map();

    function issueTicket({ session_id, realm, machine_id, role }) {
        const ticket = crypto.randomBytes(16).toString('hex');
        tickets.set(ticket, {
            session_id,
            realm,
            machine_id,
            role,
            expires: Date.now() + 60_000,
        });
        setTimeout(() => tickets.delete(ticket), 65_000);
        return ticket;
    }

    const nsp = io.of('/remote');

    nsp.on('connection', function (socket) {
        socket.remoteSession = null;

        socket.on('auth', function (data) {
            const entry = tickets.get(data && data.ticket);
            if (!entry || Date.now() > entry.expires) {
                socket.emit('auth_error', { message: 'Invalid or expired ticket' });
                socket.disconnect(true);
                return;
            }
            tickets.delete(data.ticket); // one-time use

            const sid = entry.session_id;
            socket.remoteSession = { session_id: sid, realm: entry.realm, role: entry.role };

            if (!sessions.has(sid)) {
                sessions.set(sid, { agent: null, viewers: new Set() });
            }
            const session = sessions.get(sid);

            if (entry.role === 'agent') {
                session.agent = socket.id;
                socket.join('session:' + sid + ':agent');
            } else {
                session.viewers.add(socket.id);
                socket.join('session:' + sid + ':viewers');
            }

            socket.emit('auth_ok', { session_id: sid, role: entry.role });
        });

        // Agent → viewers: base64 JPEG frame
        socket.on('frame', function (data) {
            if (!socket.remoteSession || socket.remoteSession.role !== 'agent') return;
            if (!data || !data.frame) return;
            const sid = socket.remoteSession.session_id;
            const buf = Buffer.from(data.frame, 'base64');
            nsp.to('session:' + sid + ':viewers').emit('frame', buf);
        });

        // Viewer → agent: mouse input
        socket.on('input.mouse', function (data) {
            if (!socket.remoteSession || socket.remoteSession.role !== 'viewer') return;
            const sid = socket.remoteSession.session_id;
            nsp.to('session:' + sid + ':agent').emit('input.mouse', data);
        });

        // Viewer → agent: keyboard input
        socket.on('input.keyboard', function (data) {
            if (!socket.remoteSession || socket.remoteSession.role !== 'viewer') return;
            const sid = socket.remoteSession.session_id;
            nsp.to('session:' + sid + ':agent').emit('input.keyboard', data);
        });

        socket.on('disconnect', function () {
            if (!socket.remoteSession) return;
            const sid = socket.remoteSession.session_id;
            const session = sessions.get(sid);
            if (!session) return;
            if (socket.remoteSession.role === 'agent') {
                session.agent = null;
            } else {
                session.viewers.delete(socket.id);
            }
            if (!session.agent && session.viewers.size === 0) {
                sessions.delete(sid);
            }
        });
    });

    return { issueTicket, sessions };
};
```

- [x] **Step 4: Run tests — expect failure still (server.remote not wired)**

```bash
node tests/remote-namespace.test.js
```
Expected: still fails — `server.remote` not exposed yet.

- [x] **Step 5: Commit namespace module**

```bash
git add lib/remote-namespace.js tests/remote-namespace.test.js
git commit -m "feat(remote): add /remote Socket.io namespace for binary frame streaming"
```

---

## Task 2: Wire Namespace into Server

**Files:**
- Modify: `lib/server.js`

- [x] **Step 1: Locate where `io` is created and the main connection handler**

The variable `io` is created at line ~48 of `lib/server.js`:
```js
var io = require('socket.io')(app, ioOptions);
```
And the main handler is at line ~1013:
```js
io.sockets.on('connection', function(socket) {
```

- [x] **Step 2: Attach the `/remote` namespace after `io` is created**

In `lib/server.js`, immediately after the line `var io = require('socket.io')(app, ioOptions);`, add:

```js
    var attachRemoteNamespace = require('./remote-namespace');
    var remoteNsp = attachRemoteNamespace(io);
```

- [x] **Step 3: Expose `remote` on the server instance**

In the `Server` constructor, after `this.store = ...`, add:

```js
    Object.defineProperty(this, 'remote', {
        get: function () { return remoteNsp; },
        enumerable: true,
    });
```

- [x] **Step 4: Add `REMOTE_TICKET_REQUEST` handler in the authenticated socket section**

Inside `io.sockets.on('connection', ...)`, locate the block that handles authenticated events (after `AUTHENTICATION` succeeds, where other commands like `PRODUCE` / `CONSUMER` are handled). Add:

```js
                socket.on('REMOTE_TICKET_REQUEST', function (message) {
                    if (!socket.tyoAuth || !socket.tyoAuth.realm) {
                        socket.emit('ERROR', { code: 401, message: 'Not authenticated' });
                        return;
                    }
                    var data = {};
                    try { data = (typeof message === 'string') ? JSON.parse(message) : message; } catch (e) {}
                    var session_id = data.session_id || crypto.randomBytes(8).toString('hex');
                    var machine_id = data.machine_id || socket.tyoAuth.client_id || socket.id;
                    var role       = data.role || 'agent';

                    var ticket = remoteNsp.issueTicket({
                        session_id,
                        realm:      socket.tyoAuth.realm,
                        machine_id,
                        role,
                    });
                    socket.emit('REMOTE_TICKET', { session_id, ticket, expires_in: 60 });
                    server.logger.info('REMOTE_TICKET issued', 'session=' + session_id + ' role=' + role);
                });
```

- [x] **Step 5: Run all tests**

```bash
node tests/remote-namespace.test.js
node tests/server.test.js
node tests/phase1-auth-realms.test.js
node tests/phase2-persistence.test.js
```
Expected: all pass.

- [x] **Step 6: Commit**

```bash
git add lib/server.js
git commit -m "feat(remote): wire /remote namespace into server, add REMOTE_TICKET_REQUEST handler"
```

---

## Task 3: Session Introspection Endpoint (optional but useful for tyoman REST API)

**Files:**
- Modify: `lib/remote-namespace.js` (add `getSession`, `listSessions`)

- [x] **Step 1: Add introspection methods to the returned object**

At the bottom of `attachRemoteNamespace`, change the return to:

```js
    function getSession(session_id) {
        const s = sessions.get(session_id);
        if (!s) return null;
        return { session_id, agent_connected: !!s.agent, viewer_count: s.viewers.size };
    }

    function listSessions() {
        const result = [];
        for (const [sid, s] of sessions) {
            result.push({ session_id: sid, agent_connected: !!s.agent, viewer_count: s.viewers.size });
        }
        return result;
    }

    return { issueTicket, sessions, getSession, listSessions };
```

- [x] **Step 2: Add test for introspection**

Append to `tests/remote-namespace.test.js` before `run()`:

```js
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
```

- [x] **Step 3: Run tests**

```bash
node tests/remote-namespace.test.js
```
Expected: all pass including introspection test.

- [x] **Step 4: Commit**

```bash
git add lib/remote-namespace.js tests/remote-namespace.test.js
git commit -m "feat(remote): add getSession/listSessions introspection to remote namespace"
```

---

## Self-Review

**Spec coverage:**
- ✅ `/remote` namespace created with Socket.io
- ✅ One-time session tickets issued on authenticated main namespace
- ✅ Agent connects with ticket, joins agent room
- ✅ Viewer connects with ticket, joins viewer room
- ✅ Agent sends base64 JPEG → server decodes → sends binary Buffer to viewers
- ✅ Viewer sends `input.mouse` → forwarded to agent room
- ✅ Viewer sends `input.keyboard` → forwarded to agent room
- ✅ Session cleaned up when all sockets disconnect
- ✅ Introspection for REST API layer

**Placeholder scan:** None found — all steps contain complete code.

**Type consistency:** `session_id` string used consistently throughout. `role: 'agent'|'viewer'` consistent. `issueTicket` params consistent between Task 1 test and Task 2 `REMOTE_TICKET_REQUEST` handler.
