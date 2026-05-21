#!/usr/bin/env node
/**
 * Authenticate to a running tyo-mq server with the admin token from .env.
 *
 * Usage:
 *   node scripts/admin-auth.js [-h host] [-p port] [-s protocol] [--env-file .env] [--token-env TYO_MQ_ADMIN_TOKEN]
 */

'use strict';

const env = require('../lib/env');
const ioClient = require('socket.io-client');

var host = process.env.TYO_MQ_HOST || 'localhost';
var port = parseInt(process.env.TYO_MQ_PORT, 10) || 17352;
var protocol = process.env.TYO_MQ_PROTOCOL || 'http';
var envFile = process.env.TYO_MQ_ENV_FILE || '.env';
var tokenEnv = process.env.TYO_MQ_ADMIN_TOKEN_ENV || 'TYO_MQ_ADMIN_TOKEN';

for (var i = 2; i < process.argv.length; i++) {
    switch (process.argv[i]) {
        case '-h': host = process.argv[++i]; break;
        case '-p': port = parseInt(process.argv[++i], 10); break;
        case '-s': protocol = process.argv[++i]; break;
        case '--env-file': envFile = process.argv[++i]; break;
        case '--token-env': tokenEnv = process.argv[++i]; break;
        default:
            console.error('Unknown option: ' + process.argv[i]);
            process.exit(1);
    }
}

env.loadEnvFile(envFile);

var token = process.env[tokenEnv];
if (!token) {
    console.error('Missing admin token. Expected ' + tokenEnv + ' in ' + envFile + ' or process.env.');
    process.exit(1);
}

var url = protocol + '://' + host + ':' + port;
var socket = ioClient(url, {transports: ['websocket']});
var timer = setTimeout(function () {
    console.error('Timed out authenticating to ' + url);
    socket.disconnect();
    process.exit(1);
}, 5000);

socket.on('connect', function () {
    socket.emit('AUTHENTICATION', {token: token});
});

socket.on('AUTH_OK', function (info) {
    clearTimeout(timer);
    console.log('AUTH_OK ' + JSON.stringify(info));
    socket.disconnect();
    process.exit(0);
});

socket.on('AUTH_FAIL', function (message) {
    clearTimeout(timer);
    console.error('AUTH_FAIL ' + JSON.stringify(message));
    socket.disconnect();
    process.exit(1);
});

socket.on('connect_error', function (err) {
    clearTimeout(timer);
    console.error('Connect failed: ' + err.message);
    socket.disconnect();
    process.exit(1);
});
