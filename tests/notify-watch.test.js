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

test('once posts ONE aggregated heartbeat per host to /notify/{BOARD}', async () => {
    const stub = await startCaptureServer();
    try {
        const result = await runOnce({
            SERVER: 'http://127.0.0.1:' + stub.port,
            BOARD: 'ops',
            KEY: 't1',
            TOKEN: 'x'
        });
        assert.strictEqual(result.code, 0, 'script exits 0: ' + result.stderr);

        // Exactly one row-per-host message (key-based compaction — a per-metric
        // message would overwrite the host's row).
        assert.strictEqual(stub.requests.length, 1, 'exactly one POST per host per cycle');
        const req = stub.requests[0];
        assert.strictEqual(req.method, 'POST');
        assert.strictEqual(req.url, '/notify/ops', 'posted to /notify/{BOARD}');
        assert.strictEqual(req.headers['authorization'], 'Bearer x', 'Authorization header carries TOKEN');
        const tags = req.headers['tags'] || '';
        for (const needle of ['key=t1', 'label=t1', 'state=', 'disk=', 'mem=', 'load=', 'ttl=']) {
            assert.ok(tags.includes(needle), 'Tags include ' + needle + ': ' + tags);
        }
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
