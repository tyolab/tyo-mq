#!/usr/bin/env node
'use strict';

/**
 * tyo-notify — headless TYO Notify participant.
 *
 *   tyo-notify keygen  [--dir DIR] [--force]
 *   tyo-notify claim   <topic> --server URL [--dir DIR]      # prints token ONCE
 *   tyo-notify publish <topic> --server URL [--token-file F] [--title T]
 *                      [--priority N] [--push wake|content]
 *                      [--actions-json FILE|-] [message|-]
 *   tyo-notify poll    <topic> --server URL [--since all|id|dur] [--json] [--dir DIR]
 *   tyo-notify listen  <topic> --server URL [--json] [--dir DIR]  # SSE, ticket per reconnect
 *
 * Zero dependencies beyond the broker's own lib/notify-auth.js; HTTP via
 * Node's built-in fetch (Node 18+). Works against unclaimed topics with no
 * keyfile at all; against claimed topics it signs reads with the key under
 * --dir (default ~/.config/tyo-notify) and publishes with a bearer token.
 *
 * Exit codes: 0 ok, 1 usage/local error, 2 HTTP/auth failure.
 *
 * Spec: docs/specs/2026-08-28-notify-actions-reply-topics-design.md §4.
 */

var crypto = require('crypto');
var fs = require('fs');
var os = require('os');
var path = require('path');
var notifyAuth = require('../lib/notify-auth');

var EXIT_USAGE = 1;
var EXIT_HTTP = 2;

var USAGE = [
    'usage: tyo-notify <command> [options]',
    '',
    '  keygen  [--dir DIR] [--force]                 generate an EC P-256 keypair (PEM, 0600)',
    '  claim   <topic> --server URL [--dir DIR]      claim a private topic; prints the publish token ONCE',
    '  publish <topic> --server URL [--token-file F] [--title T] [--priority N]',
    '          [--push wake|content] [--actions-json FILE|-] [message|-]',
    '  poll    <topic> --server URL [--since all|id|dur] [--json] [--dir DIR]',
    '  listen  <topic> --server URL [--json] [--dir DIR]   follow via SSE (fresh ticket per reconnect)',
    '',
    'Keys default to ~/.config/tyo-notify/. Unclaimed topics need no key or token.'
].join('\n');

function fail(code, message) {
    process.stderr.write(message + '\n');
    process.exit(code);
}

// ── argv ────────────────────────────────────────────────────────────────────

var FLAGS_WITH_VALUE = ['dir', 'server', 'token-file', 'title', 'priority', 'push', 'actions-json', 'since'];
var FLAGS_BOOLEAN = ['force', 'json'];

function parseArgs(argv) {
    var out = { flags: {}, positional: [] };
    for (var i = 0; i < argv.length; i++) {
        var a = argv[i];
        if (a.slice(0, 2) === '--') {
            var name = a.slice(2);
            if (FLAGS_BOOLEAN.indexOf(name) !== -1) { out.flags[name] = true; continue; }
            if (FLAGS_WITH_VALUE.indexOf(name) === -1) fail(EXIT_USAGE, 'unknown option --' + name + '\n' + USAGE);
            if (i + 1 >= argv.length) fail(EXIT_USAGE, '--' + name + ' needs a value');
            out.flags[name] = argv[++i];
        } else {
            out.positional.push(a);
        }
    }
    return out;
}

function requireServer(flags) {
    if (!flags.server) fail(EXIT_USAGE, '--server URL is required');
    return String(flags.server).replace(/\/+$/, '');
}

function requireTopic(positional) {
    var topic = positional[0];
    if (!topic) fail(EXIT_USAGE, 'a topic is required\n' + USAGE);
    return topic;
}

// ── keys ────────────────────────────────────────────────────────────────────

function keyDir(flags) {
    return flags.dir || path.join(os.homedir(), '.config', 'tyo-notify');
}

// Returns the private key, or null when no keyfile exists (unclaimed-topic
// use needs none — degrade gracefully). A present-but-unreadable key fails loud.
function loadPrivateKey(dir) {
    var file = path.join(dir, 'key.pem');
    if (!fs.existsSync(file)) return null;
    try {
        return crypto.createPrivateKey(fs.readFileSync(file, 'utf8'));
    } catch (e) {
        fail(EXIT_USAGE, 'could not read ' + file + ': ' + e.message);
    }
}

function pubkeyBase64(privateKey) {
    return crypto.createPublicKey(privateKey)
        .export({ type: 'spki', format: 'der' }).toString('base64');
}

// Self-signed proof scoped to (action, body) — the same wire convention the
// broker verifies in notifyProofRejected (see tests/notify-claim.test.js).
function makeProof(privateKey, action, body) {
    var timestamp = Date.now();
    var nonce = crypto.randomBytes(8).toString('hex');
    var base = notifyAuth.signatureBase(action, body, timestamp, nonce);
    var signature = crypto.sign('sha256', Buffer.from(base), privateKey).toString('base64');
    return { timestamp: timestamp, nonce: nonce, signature: signature };
}

function signedGetHeaders(privateKey, action, topic) {
    var p = makeProof(privateKey, action, { topic: topic });
    return {
        'x-tyo-notify-timestamp': String(p.timestamp),
        'x-tyo-notify-nonce': p.nonce,
        'x-tyo-notify-signature': p.signature
    };
}

// ── HTTP ────────────────────────────────────────────────────────────────────

async function request(method, url, opts) {
    opts = opts || {};
    var res;
    try {
        res = await fetch(url, { method: method, headers: opts.headers, body: opts.body });
    } catch (e) {
        fail(EXIT_HTTP, 'request failed: ' + (e.cause && e.cause.message || e.message));
    }
    var text = await res.text();
    var json = null;
    try { json = text ? JSON.parse(text) : null; } catch (e) { /* not JSON */ }
    return { status: res.status, ok: res.ok, text: text, json: json };
}

function brokerMessage(r) {
    return (r.json && r.json.message) ? r.json.message : (r.text || ('HTTP ' + r.status));
}

function readStdin() {
    return new Promise(function (resolve, reject) {
        var chunks = [];
        process.stdin.on('data', function (c) { chunks.push(c); });
        process.stdin.on('end', function () { resolve(Buffer.concat(chunks).toString('utf8')); });
        process.stdin.on('error', reject);
    });
}

// ── commands ────────────────────────────────────────────────────────────────

function cmdKeygen(flags) {
    var dir = keyDir(flags);
    var keyPath = path.join(dir, 'key.pem');
    var pubPath = path.join(dir, 'pub.pem');
    if (!flags.force && (fs.existsSync(keyPath) || fs.existsSync(pubPath)))
        fail(EXIT_USAGE, 'refusing to overwrite existing key in ' + dir + ' (use --force to rotate; ' +
            'a rotated key loses access to topics claimed under the old one)');
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    var pair = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    fs.writeFileSync(keyPath, pair.privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
    fs.writeFileSync(pubPath, pair.publicKey.export({ type: 'spki', format: 'pem' }), { mode: 0o600 });
    // writeFileSync's mode only applies on create — pin it on overwrite too.
    fs.chmodSync(keyPath, 0o600);
    fs.chmodSync(pubPath, 0o600);
    process.stderr.write('wrote ' + keyPath + ' and pub.pem (0600)\n');
}

async function cmdClaim(topic, flags) {
    var server = requireServer(flags);
    var privateKey = loadPrivateKey(keyDir(flags));
    if (!privateKey)
        fail(EXIT_USAGE, 'no key found in ' + keyDir(flags) + " — run 'tyo-notify keygen' first");
    // Headless participants have no push transport; 'null' satisfies the
    // claim shape without registering a device (same as the test-suite flow).
    var body = { topic: topic, pubkey: pubkeyBase64(privateKey), transport: 'null', token: 'none' };
    var proof = makeProof(privateKey, 'claim', body);
    var r = await request('POST', server + '/notify/' + encodeURIComponent(topic) + '/claim', {
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(Object.assign({}, body, proof))
    });
    if (r.status !== 200) fail(EXIT_HTTP, 'claim failed: ' + brokerMessage(r));
    process.stderr.write('Topic \'' + topic + '\' claimed. Publish token (shown ONCE — store it now, ' +
        'it cannot be retrieved again):\n');
    process.stdout.write(r.json.publish_token + '\n');
}

async function cmdPublish(topic, flags, positional) {
    var server = requireServer(flags);
    var actionsArg = flags['actions-json'];
    var messageArg = positional[1];
    if (actionsArg === '-' && (messageArg === '-' || messageArg === undefined))
        fail(EXIT_USAGE, 'only one of the message and --actions-json can come from stdin');

    var message = messageArg !== undefined && messageArg !== '-' ? messageArg : await readStdin();

    var body = { topic: topic, message: message };
    if (flags.title !== undefined) body.title = flags.title;
    if (flags.priority !== undefined) {
        var prio = Number(flags.priority);
        if (!Number.isFinite(prio)) fail(EXIT_USAGE, '--priority must be a number');
        body.priority = prio;
    }
    if (flags.push !== undefined) {
        if (flags.push !== 'wake' && flags.push !== 'content')
            fail(EXIT_USAGE, '--push must be wake or content');
        body.push = flags.push;
    }
    if (actionsArg !== undefined) {
        // Pass-through verbatim: parse only to embed in the JSON body; the
        // broker validates and its 400 message is surfaced as-is (exit 2).
        var raw;
        try { raw = actionsArg === '-' ? await readStdin() : fs.readFileSync(actionsArg, 'utf8'); }
        catch (e) { fail(EXIT_USAGE, 'could not read actions file: ' + e.message); }
        try { body.actions = JSON.parse(raw); }
        catch (e) { fail(EXIT_USAGE, '--actions-json is not valid JSON: ' + e.message); }
    }

    var headers = { 'content-type': 'application/json' };
    // File (or TYO_NOTIFY_TOKEN env) only — never an argv flag, which would
    // leak the bearer token into `ps` output and shell history.
    var token = process.env.TYO_NOTIFY_TOKEN;
    if (flags['token-file'] !== undefined) {
        try { token = fs.readFileSync(flags['token-file'], 'utf8').trim(); }
        catch (e) { fail(EXIT_USAGE, 'could not read token file: ' + e.message); }
    }
    if (token) headers['authorization'] = 'Bearer ' + token;

    var r = await request('POST', server + '/notify', { headers: headers, body: JSON.stringify(body) });
    if (r.status !== 200) fail(EXIT_HTTP, 'publish failed: ' + brokerMessage(r));
    process.stdout.write(JSON.stringify(r.json) + '\n'); // the stored message (id, time, ...)
}

function printNotifyLine(line, jsonMode) {
    if (!line) return;
    if (jsonMode) { process.stdout.write(line + '\n'); return; }
    var m;
    try { m = JSON.parse(line); } catch (e) { return; }
    if (!m || m.event !== 'message') return; // skip open/keepalive control frames
    var head = m.title ? m.title + ': ' : '';
    process.stdout.write('[' + m.id + '] ' + head + (m.message || '') + '\n');
}

async function cmdPoll(topic, flags) {
    var server = requireServer(flags);
    var privateKey = loadPrivateKey(keyDir(flags)); // null → unsigned (unclaimed topics)
    var since = flags.since || 'all';
    var headers = privateKey ? signedGetHeaders(privateKey, 'json', topic) : {};
    var r = await request('GET', server + '/notify/' + encodeURIComponent(topic) +
        '/json?poll=1&since=' + encodeURIComponent(since), { headers: headers });
    if (r.status !== 200) fail(EXIT_HTTP, 'poll failed: ' + brokerMessage(r));
    r.text.split('\n').forEach(function (line) { printNotifyLine(line.trim(), !!flags.json); });
}

// listen — follow the topic over SSE. Claimed topics need a single-use ticket
// per connection (SSE cannot carry per-request signatures), so EVERY
// (re)connect fetches a fresh one; unclaimed topics connect bare.
async function sseTicket(server, topic, privateKey) {
    var proof = makeProof(privateKey, 'sse-ticket', { topic: topic });
    var r = await request('POST', server + '/notify/' + encodeURIComponent(topic) + '/sse-ticket', {
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(proof)
    });
    // Throws (rather than fail/exit) so listen can fall back to a bare
    // connect — sse-ticket 404s on unclaimed topics by design.
    if (r.status !== 200) throw new Error('sse-ticket failed: ' + brokerMessage(r));
    return r.json.ticket;
}

async function listenOnce(server, topic, privateKey, jsonMode) {
    var url = server + '/notify/' + encodeURIComponent(topic) + '/sse';
    var res;
    try {
        if (privateKey) {
            // A key implies the topic is (probably) claimed — go ticket-first
            // rather than burning a doomed bare connect on every reconnect.
            // sse-ticket 404s on an UNCLAIMED topic, so fall back to bare then.
            var ticket = null;
            try { ticket = await sseTicket(server, topic, privateKey); }
            catch (e) { /* unclaimed or transient — try bare below */ }
            res = await fetch(url + (ticket ? '?ticket=' + encodeURIComponent(ticket) : ''),
                { headers: { accept: 'text/event-stream' } });
        } else {
            res = await fetch(url, { headers: { accept: 'text/event-stream' } });
        }
    } catch (e) {
        return false; // connect failure → caller backs off and retries
    }
    if (res.status !== 200) {
        var text = await res.text().catch(function () { return ''; });
        fail(EXIT_HTTP, 'listen failed: ' + (text || ('HTTP ' + res.status)));
    }
    process.stderr.write('listening on ' + topic + '\n');
    // Minimal SSE parse: accumulate data: lines, dispatch on blank line.
    var buffer = '';
    var eventName = 'message';
    var data = [];
    var decoder = new TextDecoder();
    for await (var chunk of res.body) {
        buffer += decoder.decode(chunk, { stream: true });
        var idx;
        while ((idx = buffer.indexOf('\n')) !== -1) {
            var line = buffer.slice(0, idx).replace(/\r$/, '');
            buffer = buffer.slice(idx + 1);
            if (line === '') {
                if (data.length && eventName === 'message')
                    printNotifyLine(data.join('\n'), jsonMode);
                eventName = 'message';
                data = [];
            } else if (line.slice(0, 6) === 'event:') {
                eventName = line.slice(6).trim();
            } else if (line.slice(0, 5) === 'data:') {
                data.push(line.slice(5).replace(/^ /, ''));
            } // id:/retry:/comments ignored
        }
    }
    return true; // stream ended (server closed) → reconnect
}

async function cmdListen(topic, flags) {
    var server = requireServer(flags);
    var privateKey = loadPrivateKey(keyDir(flags));
    var backoffMs = 1000;
    for (;;) {
        var opened = await listenOnce(server, topic, privateKey, !!flags.json);
        backoffMs = opened ? 1000 : Math.min(backoffMs * 2, 30000);
        process.stderr.write('disconnected; reconnecting in ' + (backoffMs / 1000) + 's\n');
        await new Promise(function (r) { setTimeout(r, backoffMs); });
    }
}

// ── main ────────────────────────────────────────────────────────────────────

async function main() {
    var argv = process.argv.slice(2);
    var cmd = argv.shift();
    var parsed = parseArgs(argv);
    switch (cmd) {
        case 'keygen': return cmdKeygen(parsed.flags);
        case 'claim': return cmdClaim(requireTopic(parsed.positional), parsed.flags);
        case 'publish': return cmdPublish(requireTopic(parsed.positional), parsed.flags, parsed.positional);
        case 'poll': return cmdPoll(requireTopic(parsed.positional), parsed.flags);
        case 'listen': return cmdListen(requireTopic(parsed.positional), parsed.flags);
        default:
            fail(EXIT_USAGE, USAGE);
    }
}

main().catch(function (e) {
    fail(EXIT_USAGE, 'error: ' + (e && e.message || e));
});
