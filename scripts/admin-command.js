#!/usr/bin/env node
/**
 * Send ONE signed auth-management command to a running tyo-mq broker.
 *
 * The proof is signed with the admin token from .env (never sent on the wire,
 * never printed); the broker verifies it and applies the command exactly as
 * the manager UI would. Realm fields such as e2ee / key / push are therefore
 * changed through the broker — persisted to the auth store, hot, no restart —
 * instead of by editing SQLite on a production box.
 *
 * Usage:
 *   node scripts/admin-command.js <command> [--json '{"realm":"…",…}' | --json-file PATH | --json -] \
 *        [-h host] [-p port] [-s protocol] [--env-file .env] [--token-env TYO_MQ_ADMIN_TOKEN]
 *   Bodies that carry a secret should come from --json-file (0600) or stdin, never argv.
 *
 * Examples:
 *   node scripts/admin-command.js get
 *   node scripts/admin-command.js set_realm_push --json \
 *     '{"realm":"apps:hilia:chat","default_wake":"alert","alert":{"title":"Hilia","body":"New message","collapse_id":"hilia-chat","extra":{"hilia":"wake"}}}'
 *
 * The ack is printed as JSON with any key / token / secret field redacted.
 */
'use strict';
const env = require('../lib/env');
const ioClient = require('socket.io-client');
const adminSignature = require('tyo-mq-protocol').adminSignature;

var command = process.argv[2];
var host = process.env.TYO_MQ_HOST || 'localhost';
var port = parseInt(process.env.TYO_MQ_PORT, 10) || 17352;
var protocol = process.env.TYO_MQ_PROTOCOL || 'http';
var envFile = process.env.TYO_MQ_ENV_FILE || '.env';
var tokenEnv = process.env.TYO_MQ_ADMIN_TOKEN_ENV || 'TYO_MQ_ADMIN_TOKEN';
var json = null;

if (!command || command[0] === '-') {
    console.error('Usage: node scripts/admin-command.js <command> [--json \'{...}\'] [-h host] [-p port] [-s protocol] [--env-file .env] [--token-env NAME]');
    process.exit(1);
}
for (var i = 3; i < process.argv.length; i++) {
    switch (process.argv[i]) {
        case '-h': host = process.argv[++i]; break;
        case '-p': port = parseInt(process.argv[++i], 10); break;
        case '-s': protocol = process.argv[++i]; break;
        case '--env-file': envFile = process.argv[++i]; break;
        case '--token-env': tokenEnv = process.argv[++i]; break;
        case '--json': json = process.argv[++i]; break;
        // A body that carries a secret (add_management_token, set_realm_key,
        // set_realm_manager_key) must not be a command-line argument — argv is
        // visible in `ps` and lands in shell history. Read it from a 0600 file
        // (--json-file PATH) or from stdin (--json -) instead.
        case '--json-file': json = require('fs').readFileSync(process.argv[++i], 'utf8'); break;
        default:
            console.error('Unknown option: ' + process.argv[i]);
            process.exit(1);
    }
}
if (json === '-') json = require('fs').readFileSync(0, 'utf8');

var body = { command: command };
if (json) {
    try { Object.assign(body, JSON.parse(json)); }
    catch (e) { console.error('--json is not valid JSON: ' + e.message); process.exit(1); }
    body.command = command; // the positional command always wins
}

env.loadEnvFile(envFile);
var token = process.env[tokenEnv];
if (!token) {
    console.error('Missing admin token. Expected ' + tokenEnv + ' in ' + envFile + ' or process.env.');
    process.exit(1);
}

// Never echo secrets that a `get` / realm listing may carry in the ack.
function redact(value) {
    if (Array.isArray(value)) return value.map(redact);
    if (value && typeof value === 'object') {
        var out = {};
        Object.keys(value).forEach(function (k) {
            out[k] = /(^|_)(key|token|secret)s?$/i.test(k) ? '<redacted>' : redact(value[k]);
        });
        return out;
    }
    return value;
}

var url = protocol + '://' + host + ':' + port;
var socket = ioClient(url, { transports: ['websocket'], reconnection: false });
var timer = setTimeout(function () {
    console.error('Timed out sending ' + command + ' to ' + url);
    socket.disconnect();
    process.exit(1);
}, 8000);
socket.on('connect', function () {
    var payload = { body: body, proof: adminSignature.createAdminProof(token, 'AUTH_MANAGEMENT_COMMAND', body) };
    socket.emit('AUTH_MANAGEMENT_COMMAND', payload, function (res) {
        clearTimeout(timer);
        console.log(JSON.stringify(redact(res), null, 2));
        socket.disconnect();
        process.exit(res && res.ok ? 0 : 2);
    });
});
socket.on('connect_error', function (err) {
    clearTimeout(timer);
    console.error('Connect failed: ' + err.message);
    socket.disconnect();
    process.exit(1);
});
