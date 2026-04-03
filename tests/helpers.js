/**
 * Shared helpers for tyo-mq tests.
 * Starts an in-process server on a random port and exposes a Factory client.
 */

const http    = require('http');
const { Server }  = require('socket.io');
const TyoMQServer = require('../lib/server');
const Factory     = require('../lib/factory');

/**
 * Start a tyo-mq server on a random available port.
 * Returns { port, close } where close() shuts the server down.
 */
function startServer() {
    return new Promise((resolve, reject) => {
        const httpServer = http.createServer();
        const io = new Server(httpServer, {
            pingInterval: 5000,
            pingTimeout:  10000,
        });

        const mqServer = new TyoMQServer();
        mqServer.create(io);

        httpServer.listen(0, '127.0.0.1', () => {
            const port = httpServer.address().port;
            resolve({
                port,
                close: () => new Promise(res => {
                    io.close(() => httpServer.close(res));
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
