// tests/notify-cli.test.js
/**
 * tyo-notify headless CLI — keygen / claim / publish / poll (listen/SSE is
 * exercised in the actions e2e, not here). Spawns the CLI as a child process
 * against an in-process broker. Usage: node tests/notify-cli.test.js
 */

'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { test, run } = require('./runner');
const { startServer } = require('./helpers');

const CLI = path.join(__dirname, '..', 'bin', 'notify-cli.js');

function cli(args, opts) {
    return new Promise((resolve) => {
        execFile(process.execPath, [CLI].concat(args), Object.assign({ timeout: 10000 }, opts || {}),
            (err, stdout, stderr) => {
                resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout, stderr });
            });
    });
}

function tmpDir(prefix) {
    return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function tmpNotifyStoreFile() {
    return path.join(tmpDir('tyo-mq-notify-cli-store-'), 'notify.sqlite');
}

function serverUrl(server) {
    return 'http://127.0.0.1:' + server.port;
}

test('no/unknown command is a usage error (exit 1)', async () => {
    const none = await cli([]);
    assert.strictEqual(none.code, 1);
    assert.ok(/usage/i.test(none.stderr), none.stderr);
    const unknown = await cli(['frobnicate']);
    assert.strictEqual(unknown.code, 1);
});

test('keygen writes 0600 PEMs and refuses overwrite without --force', async () => {
    const dir = path.join(tmpDir('tyo-notify-keys-'), 'keys');
    const first = await cli(['keygen', '--dir', dir]);
    assert.strictEqual(first.code, 0, first.stderr);
    const keyPath = path.join(dir, 'key.pem');
    const pubPath = path.join(dir, 'pub.pem');
    assert.ok(fs.existsSync(keyPath), 'key.pem written');
    assert.ok(fs.existsSync(pubPath), 'pub.pem written');
    assert.strictEqual(fs.statSync(keyPath).mode & 0o777, 0o600, 'key.pem is 0600');
    assert.strictEqual(fs.statSync(pubPath).mode & 0o777, 0o600, 'pub.pem is 0600');

    const before = fs.readFileSync(keyPath, 'utf8');
    const refused = await cli(['keygen', '--dir', dir]);
    assert.strictEqual(refused.code, 1, 'refuses to overwrite an existing key');
    assert.strictEqual(fs.readFileSync(keyPath, 'utf8'), before, 'existing key untouched');

    const forced = await cli(['keygen', '--dir', dir, '--force']);
    assert.strictEqual(forced.code, 0, forced.stderr);
    assert.notStrictEqual(fs.readFileSync(keyPath, 'utf8'), before, '--force rotates the key');
    assert.strictEqual(fs.statSync(keyPath).mode & 0o777, 0o600, 'still 0600 after --force');
});

test('claim prints a 64-char token to stdout (warning on stderr); re-claim exits 2', async () => {
    const server = await startServer({ notify: { enabled: true }, notify_store: { filename: tmpNotifyStoreFile() } });
    const dir = tmpDir('tyo-notify-keys-');
    try {
        assert.strictEqual((await cli(['keygen', '--dir', dir, '--force'])).code, 0);
        const claim = await cli(['claim', 'cli-claim', '--server', serverUrl(server), '--dir', dir]);
        assert.strictEqual(claim.code, 0, claim.stderr);
        const token = claim.stdout.trim();
        assert.match(token, /^[0-9a-f]{64}$/, 'stdout is exactly the 64-char token: ' + JSON.stringify(claim.stdout));
        assert.ok(/store/i.test(claim.stderr), 'stderr warns to store the token now: ' + claim.stderr);

        const again = await cli(['claim', 'cli-claim', '--server', serverUrl(server), '--dir', dir]);
        assert.strictEqual(again.code, 2, 'a 409 re-claim is an HTTP failure (exit 2)');
        assert.ok(again.stderr.length > 0, 'broker message lands on stderr');
    } finally { await server.close(); }
});

test('publish on a claimed topic: token-file → 200/exit 0, no token → exit 2; signed poll reads it back', async () => {
    const server = await startServer({ notify: { enabled: true }, notify_store: { filename: tmpNotifyStoreFile() } });
    const dir = tmpDir('tyo-notify-keys-');
    try {
        assert.strictEqual((await cli(['keygen', '--dir', dir])).code, 0);
        const claim = await cli(['claim', 'cli-flow', '--server', serverUrl(server), '--dir', dir]);
        assert.strictEqual(claim.code, 0, claim.stderr);
        const tokenFile = path.join(dir, 'cli-flow.token');
        fs.writeFileSync(tokenFile, claim.stdout.trim() + '\n');

        const noToken = await cli(['publish', 'cli-flow', '--server', serverUrl(server), 'nope']);
        assert.strictEqual(noToken.code, 2, 'claimed topic without a token is an auth failure');

        const ok = await cli(['publish', 'cli-flow', '--server', serverUrl(server),
            '--token-file', tokenFile, '--title', 'Hi', 'hello from cli']);
        assert.strictEqual(ok.code, 0, ok.stderr);
        assert.ok(ok.stdout.includes('hello from cli'), 'publish echoes the stored message: ' + ok.stdout);

        const poll = await cli(['poll', 'cli-flow', '--server', serverUrl(server), '--dir', dir, '--json']);
        assert.strictEqual(poll.code, 0, poll.stderr);
        assert.ok(poll.stdout.includes('hello from cli'), 'signed poll returns the message: ' + poll.stdout);
        assert.ok(poll.stdout.includes('"Hi"'), 'title survives the round-trip');

        const plain = await cli(['poll', 'cli-flow', '--server', serverUrl(server), '--dir', dir]);
        assert.strictEqual(plain.code, 0, plain.stderr);
        assert.ok(plain.stdout.includes('hello from cli'), 'plain-text poll prints the message');
        assert.ok(!plain.stdout.includes('"event"'), 'plain mode is not raw ND-JSON');
    } finally { await server.close(); }
});

test('unclaimed topics degrade gracefully: publish + poll with no keyfile at all', async () => {
    const server = await startServer({ notify: { enabled: true }, notify_store: { filename: tmpNotifyStoreFile() } });
    const emptyDir = tmpDir('tyo-notify-nokeys-');
    try {
        const pub = await cli(['publish', 'open-topic', '--server', serverUrl(server), 'anyone can post']);
        assert.strictEqual(pub.code, 0, pub.stderr);
        const poll = await cli(['poll', 'open-topic', '--server', serverUrl(server), '--dir', emptyDir]);
        assert.strictEqual(poll.code, 0, poll.stderr);
        assert.ok(poll.stdout.includes('anyone can post'));
    } finally { await server.close(); }
});

test('publish --actions-json: valid actions round-trip; invalid actions surface the broker 400 (exit 2)', async () => {
    const server = await startServer({ notify: { enabled: true }, notify_store: { filename: tmpNotifyStoreFile() } });
    const dir = tmpDir('tyo-notify-actions-');
    try {
        const goodFile = path.join(dir, 'good.json');
        fs.writeFileSync(goodFile, JSON.stringify([
            { action: 'http', label: 'Approve', url: 'https://e.x/notify/replies', method: 'POST', body: 'approve' }
        ]));
        const good = await cli(['publish', 'act-cli', '--server', serverUrl(server),
            '--actions-json', goodFile, 'approve?']);
        assert.strictEqual(good.code, 0, good.stderr);
        assert.ok(good.stdout.includes('"Approve"'), 'published message carries the action: ' + good.stdout);

        const badFile = path.join(dir, 'bad.json');
        fs.writeFileSync(badFile, JSON.stringify([
            { action: 'http', label: 'Approve', url: 'http://insecure.example/x' }
        ]));
        const bad = await cli(['publish', 'act-cli', '--server', serverUrl(server),
            '--actions-json', badFile, 'nope']);
        assert.strictEqual(bad.code, 2, 'broker 400 is exit 2: ' + bad.stderr);
        assert.ok(/invalid actions/i.test(bad.stderr), "broker's 400 text is surfaced: " + bad.stderr);

        const unparseable = path.join(dir, 'junk.json');
        fs.writeFileSync(unparseable, 'not json');
        const junk = await cli(['publish', 'act-cli', '--server', serverUrl(server),
            '--actions-json', unparseable, 'nope']);
        assert.strictEqual(junk.code, 1, 'unreadable actions file is a usage error');
    } finally { await server.close(); }
});

run();
