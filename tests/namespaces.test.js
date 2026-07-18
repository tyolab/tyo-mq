/**
 * Pluggable namespaces: operator modules attached from the `namespaces`
 * setting, sharing the contract the bundled /remote implements.
 *
 * Usage: node tests/namespaces.test.js
 */

'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { test, run } = require('./runner');
const Authorization = require('../lib/authorization');
const { startServer, delay } = require('./helpers');
const ioClient = require('socket.io-client');

const moduleDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tyo-mq-ns-'));

// An echo namespace exercising the whole contract: io, options, context
// (name, logger, live getOptions), and a returned api.
const echoModulePath = path.join(moduleDir, 'echo-namespace.js');
fs.writeFileSync(echoModulePath, `
'use strict';
module.exports = function attach(io, options, context) {
    var counters = { connections: 0, echoes: 0 };
    var nsp = io.of(context.name);
    nsp.on('connection', function (socket) {
        counters.connections++;
        socket.on('echo', function (data) {
            counters.echoes++;
            socket.emit('echo_reply', {
                data: data,
                namespace: context.name,
                prefix: (context.getOptions() || {}).prefix || options.prefix || 'echo'
            });
        });
    });
    return { counters: counters };
};
`);

const brokenModulePath = path.join(moduleDir, 'broken-namespace.js');
fs.writeFileSync(brokenModulePath, `
'use strict';
module.exports = function attach() { throw new Error('boom at attach'); };
`);

const notAFunctionPath = path.join(moduleDir, 'not-a-function.js');
fs.writeFileSync(notAFunctionPath, `module.exports = { hello: true };`);

function connectNamespace(port, name) {
    return new Promise((resolve, reject) => {
        const socket = ioClient('http://127.0.0.1:' + port + name, { transports: ['websocket'] });
        const timer = setTimeout(() => { socket.disconnect(); reject(new Error(name + ' connect timeout')); }, 5000);
        socket.on('connect', () => { clearTimeout(timer); resolve(socket); });
        socket.on('connect_error', err => { clearTimeout(timer); socket.disconnect(); reject(err); });
    });
}

function waitFor(socket, event, timeout) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(event + ' timeout')), timeout || 5000);
        socket.once(event, data => { clearTimeout(timer); resolve(data); });
    });
}

test('a configured namespace module attaches, serves clients, and exposes its api', async () => {
    const srv = await startServer({
        namespaces: {
            '/echo': { module: echoModulePath, options: { prefix: 'custom' } }
        }
    });

    try {
        const socket = await connectNamespace(srv.port, '/echo');
        const reply = waitFor(socket, 'echo_reply');
        socket.emit('echo', { n: 42 });
        const received = await reply;
        assert.deepStrictEqual(received.data, { n: 42 });
        assert.strictEqual(received.namespace, '/echo');
        assert.strictEqual(received.prefix, 'custom');
        socket.disconnect();

        // The returned api is reachable on the server object.
        assert.strictEqual(srv.server.namespaces['/echo'].counters.connections, 1);
        assert.strictEqual(srv.server.namespaces['/echo'].counters.echoes, 1);

        // The bundled /remote appears alongside it.
        assert.ok(srv.server.namespaces['/remote'], '/remote should be listed too');
    } finally {
        await srv.close();
    }
});

test('names are normalized and bare-string module config is accepted', async () => {
    const srv = await startServer({
        namespaces: {
            'plain': echoModulePath   // no leading slash, no options wrapper
        }
    });

    try {
        const socket = await connectNamespace(srv.port, '/plain');
        const reply = waitFor(socket, 'echo_reply');
        socket.emit('echo', 'hi');
        const received = await reply;
        assert.strictEqual(received.namespace, '/plain');
        assert.strictEqual(received.prefix, 'echo'); // default — no options block
        socket.disconnect();
        assert.ok(srv.server.namespaces['/plain']);
    } finally {
        await srv.close();
    }
});

test('a broken module is isolated: logged, skipped, broker unaffected', async () => {
    const srv = await startServer({
        namespaces: {
            '/broken': { module: brokenModulePath },
            '/notafn': { module: notAFunctionPath },
            '/nomodule': { options: {} },
            '/echo': { module: echoModulePath }
        }
    });

    try {
        assert.strictEqual(srv.server.namespaces['/broken'], undefined);
        assert.strictEqual(srv.server.namespaces['/notafn'], undefined);
        assert.strictEqual(srv.server.namespaces['/nomodule'], undefined);

        // The healthy namespace and the broker itself still work.
        const socket = await connectNamespace(srv.port, '/echo');
        const reply = waitFor(socket, 'echo_reply');
        socket.emit('echo', 'still alive');
        assert.strictEqual((await reply).data, 'still alive');
        socket.disconnect();
    } finally {
        await srv.close();
    }
});

test('reserved namespaces cannot be overridden by config', async () => {
    const srv = await startServer({
        namespaces: {
            '/remote': { module: echoModulePath },
            '/': { module: echoModulePath }
        }
    });

    try {
        // /remote must still be the bundled ticket namespace, not the echo
        // module: a ticketless auth attempt gets the real auth_error.
        const socket = await connectNamespace(srv.port, '/remote');
        const authError = waitFor(socket, 'auth_error');
        socket.emit('auth', { ticket: 'bogus' });
        assert.match((await authError).message, /Invalid or expired ticket/);
        socket.disconnect();
    } finally {
        await srv.close();
    }
});

test('a namespace added via settings reload attaches live', async () => {
    const srv = await startServer({});

    try {
        assert.strictEqual(srv.server.namespaces['/late'], undefined);

        srv.server.settings.merge({
            namespaces: { '/late': { module: echoModulePath, options: { prefix: 'hot' } } }
        });
        await delay(100);

        const socket = await connectNamespace(srv.port, '/late');
        const reply = waitFor(socket, 'echo_reply');
        socket.emit('echo', 'hot-attached');
        const received = await reply;
        assert.strictEqual(received.data, 'hot-attached');
        assert.strictEqual(received.prefix, 'hot');
        socket.disconnect();
    } finally {
        await srv.close();
    }
});

test('context.getOptions reflects settings changes without re-attach', async () => {
    const srv = await startServer({
        namespaces: { '/echo': { module: echoModulePath, options: { prefix: 'before' } } }
    });

    try {
        srv.server.settings.merge({
            namespaces: { '/echo': { options: { prefix: 'after' } } }
        });

        const socket = await connectNamespace(srv.port, '/echo');
        const reply = waitFor(socket, 'echo_reply');
        socket.emit('echo', 'x');
        assert.strictEqual((await reply).prefix, 'after');
        socket.disconnect();
    } finally {
        await srv.close();
    }
});

test('the get management command lists attached namespaces', async () => {
    const adminToken = 'ns-admin';
    const srv = await startServer({
        auth: {
            enabled: true,
            auto_admin_token: false,
            tokens: [{ token: adminToken, realm: '*', role: 'admin' }]
        },
        namespaces: { '/echo': { module: echoModulePath } }
    });

    try {
        const settings = await Authorization.authManagementCommand(adminToken, {
            command: 'get'
        }, {host: '127.0.0.1', port: srv.port, protocol: 'http'});

        assert.deepStrictEqual(settings.settings.namespaces['/remote'], { module: 'built-in' });
        assert.deepStrictEqual(settings.settings.namespaces['/echo'], { module: echoModulePath });
    } finally {
        await srv.close();
    }
});

process.on('exit', () => {
    try { fs.rmSync(moduleDir, { recursive: true, force: true }); } catch (err) { /* best effort */ }
});

run();
