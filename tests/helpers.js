/**
 * Shared helpers for tyo-mq tests.
 * Starts an in-process server on a random port and exposes a Factory client.
 */

const http    = require('http');
const path    = require('path');
const os      = require('os');
const fs      = require('fs');
const { Server }  = require('socket.io');
const TyoMQServer = require('../lib/server');
const Factory     = require('tyo-mq-client').Factory;

/**
 * Start a tyo-mq server on a random available port.
 * Returns { port, close } where close() shuts the server down.
 */
function startServer(options) {
    return new Promise((resolve, reject) => {
        const httpServer = http.createServer();
        const io = new Server(httpServer, {
            pingInterval: 5000,
            pingTimeout:  10000,
        });

        // The chat push registry is durable by default (tyo-mq.push.sqlite in
        // the cwd when push is configured). Tests must never share that file —
        // stale endpoints from an earlier test would be hydrated and woken —
        // so give every test broker its own temp store unless the test chose one.
        const opts = Object.assign({}, options || {});
        let pushStoreFile = null;
        if (opts.push_store === undefined) {
            pushStoreFile = path.join(os.tmpdir(), 'tyo-mq-test-push-' + process.pid + '-' + Math.random().toString(36).slice(2) + '.sqlite');
            opts.push_store = { filename: pushStoreFile };
        }
        const mqServer = new TyoMQServer(opts);
        const noop = () => {};
        mqServer.logger = { critical: noop, error: noop, warn: noop, output: noop, log: noop, info: noop, debug: noop, trace: noop };
        mqServer.create(io);

        httpServer.listen(0, '127.0.0.1', () => {
            const port = httpServer.address().port;
            resolve({
                port,
                server: mqServer,
                close: () => new Promise(res => {
                    io.close(() => httpServer.close(() => {
                        if (pushStoreFile)
                            for (const suffix of ['', '-wal', '-shm']) { try { fs.unlinkSync(pushStoreFile + suffix); } catch (e) {} }
                        res();
                    }));
                }),
            });
        });

        httpServer.on('error', reject);
    });
}

/**
 * Create a Factory client pointed at the given port.
 */
function makeFactory(port) {
    return new Factory({ host: '127.0.0.1', port, protocol: 'http' });
}

/**
 * Return a Promise that resolves after `ms` milliseconds.
 */
function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Return a Promise that resolves with `value` when `emitter` emits `event`,
 * or rejects after `timeoutMs` milliseconds.
 */
function waitFor(emitter, event, timeoutMs = 3000) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`Timed out waiting for '${event}'`)), timeoutMs);
        emitter.once(event, (value) => {
            clearTimeout(timer);
            resolve(value);
        });
    });
}

module.exports = { startServer, makeFactory, delay, waitFor };
