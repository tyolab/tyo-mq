// tests/notify-watch.test.js
/**
 * tyo-notify-watch — agentless POSIX-sh status producer (bin/tyo-notify-watch.sh).
 * Starts a tiny stub http server that captures POSTs, then runs the script's
 * `once` mode against it as a child process and inspects what was received.
 * Usage: node tests/notify-watch.test.js
 */

'use strict';

const assert = require('assert');
const http = require('http');
const path = require('path');
const { execFile } = require('child_process');
const { test, run } = require('./runner');

const SCRIPT = path.join(__dirname, '..', 'bin', 'tyo-notify-watch.sh');

function startCaptureServer() {
    return new Promise((resolve) => {
        const requests = [];
        const server = http.createServer((req, res) => {
            let body = '';
            req.setEncoding('utf8');
            req.on('data', (c) => { body += c; });
            req.on('end', () => {
                requests.push({ method: req.method, url: req.url, headers: req.headers, body: body });
                res.writeHead(200, { 'content-type': 'text/plain' });
                res.end('ok');
            });
        });
        server.listen(0, '127.0.0.1', () => {
            resolve({
                port: server.port || server.address().port,
                requests: requests,
                close: () => new Promise((res) => server.close(res))
            });
        });
    });
}

function runOnce(env) {
    return new Promise((resolve) => {
        execFile('sh', [SCRIPT, 'once'], {
            timeout: 15000,
            env: Object.assign({}, process.env, env)
        }, (err, stdout, stderr) => {
            resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout, stderr });
        });
    });
}

test('once posts disk/mem/load to /notify/{BOARD} with Authorization + Tags headers', async () => {
    const stub = await startCaptureServer();
    try {
        const result = await runOnce({
            SERVER: 'http://127.0.0.1:' + stub.port,
            BOARD: 'ops',
            KEY: 't1',
            TOKEN: 'x'
        });
        assert.strictEqual(result.code, 0, 'script exits 0: ' + result.stderr);

        assert.ok(stub.requests.length >= 1, 'at least one POST was captured');
        for (const req of stub.requests) {
            assert.strictEqual(req.method, 'POST');
            assert.strictEqual(req.url, '/notify/ops', 'posted to /notify/{BOARD}');
            assert.strictEqual(req.headers['authorization'], 'Bearer x', 'Authorization header carries TOKEN');
            assert.ok(req.headers['tags'], 'Tags header present');
            assert.ok(req.headers['tags'].includes('key=t1'), 'Tags header includes key=KEY: ' + req.headers['tags']);
            assert.ok(req.headers['tags'].includes('ttl='), 'Tags header includes ttl=: ' + req.headers['tags']);
        }

        // disk, mem, load metrics should each be posted once.
        const metrics = stub.requests.map((r) => {
            const m = /metric=([a-z]+)/.exec(r.headers['tags']);
            return m ? m[1] : null;
        });
        assert.ok(metrics.includes('disk'), 'disk metric posted');
        assert.ok(metrics.includes('mem'), 'mem metric posted');
        assert.ok(metrics.includes('load'), 'load metric posted');
    } finally {
        await stub.close();
    }
});

test('once does not hang against a dead server (curl -m 10, `|| true`)', async () => {
    const start = Date.now();
    const result = await runOnce({
        SERVER: 'http://127.0.0.1:9',
        BOARD: 'b',
        KEY: 'k',
        TOKEN: 't'
    });
    const elapsed = Date.now() - start;
    assert.strictEqual(result.code, 0, 'script still exits 0 even though POSTs fail: ' + result.stderr);
    assert.ok(elapsed < 14000, 'returns well within the 15s test timeout: ' + elapsed + 'ms');
});

run();
