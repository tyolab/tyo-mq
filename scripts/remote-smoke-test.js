#!/usr/bin/env node
/**
 * Remote connection smoke test for a deployed tyo-mq server.
 *
 * Without a token, this verifies Socket.IO connectivity and reports whether
 * the server requires authentication. With TYO_MQ_TOKEN, TYO_MQ_ADMIN_TOKEN,
 * --token, or --admin-token, it also runs authenticated PING and
 * producer/consumer round-trip checks.
 */

'use strict';

const io = require('socket.io-client');
const Factory = require('../lib/factory');
const env = require('../lib/env');

var url = process.env.TYO_MQ_URL || 'https://mq.tyo.com.au';
var envFile = process.env.TYO_MQ_ENV_FILE || null;
var token = process.env.TYO_MQ_TOKEN || process.env.TYO_MQ_ADMIN_TOKEN || null;
var timeout = parseInt(process.env.TYO_MQ_TEST_TIMEOUT, 10) || 10000;
var producerName = process.env.TYO_MQ_TEST_PRODUCER || ('remote-producer-' + Date.now());
var consumerName = process.env.TYO_MQ_TEST_CONSUMER || ('remote-consumer-' + Date.now());
var eventName = process.env.TYO_MQ_TEST_EVENT || 'remote-smoke-event';
var message = process.env.TYO_MQ_TEST_MESSAGE || ('remote-smoke-' + Date.now());
var noToken = process.env.TYO_MQ_NO_TOKEN === '1';

for (var i = 2; i < process.argv.length; i++) {
    switch (process.argv[i]) {
        case '--url': url = process.argv[++i]; break;
        case '--env-file': envFile = process.argv[++i]; break;
        case '--token': token = process.argv[++i]; break;
        case '--admin-token': token = process.argv[++i]; break;
        case '--no-token': noToken = true; break;
        case '--timeout': timeout = parseInt(process.argv[++i], 10); break;
        case '--producer': producerName = process.argv[++i]; break;
        case '--consumer': consumerName = process.argv[++i]; break;
        case '--event': eventName = process.argv[++i]; break;
        case '--message': message = process.argv[++i]; break;
        default:
            console.error('Unknown option: ' + process.argv[i]);
            process.exit(1);
    }
}

if (envFile) {
    env.loadEnvFile(envFile);
    url = process.env.TYO_MQ_URL || url;
    token = token || process.env.TYO_MQ_TOKEN || process.env.TYO_MQ_ADMIN_TOKEN || null;
}

if (noToken)
    token = null;

function parseTarget(targetUrl) {
    var parsed = new URL(targetUrl);
    return {
        host: parsed.hostname,
        port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
        protocol: parsed.protocol.replace(':', '')
    };
}

function rawConnect() {
    return new Promise(function (resolve, reject) {
        var socket = io(url, {transports: ['websocket'], timeout: timeout});
        var timer = setTimeout(function () {
            socket.disconnect();
            reject(new Error('Timed out connecting to ' + url));
        }, timeout);

        socket.once('connect', function () {
            clearTimeout(timer);
            resolve(socket);
        });
        socket.once('connect_error', function (err) {
            clearTimeout(timer);
            socket.disconnect();
            reject(err);
        });
    });
}

function authenticate(socket) {
    return new Promise(function (resolve, reject) {
        if (!token)
            return resolve(null);

        var timer = setTimeout(function () {
            reject(new Error('Timed out waiting for AUTH_OK'));
        }, timeout);

        socket.once('AUTH_OK', function (info) {
            clearTimeout(timer);
            resolve(info);
        });
        socket.once('AUTH_FAIL', function (message) {
            clearTimeout(timer);
            var err = new Error('AUTH_FAIL ' + JSON.stringify(message));
            err.authFail = message;
            reject(err);
        });
        socket.emit('AUTHENTICATION', {token: token});
    });
}

function ping(socket) {
    return new Promise(function (resolve, reject) {
        var done = false;
        var timer = setTimeout(function () {
            if (done) return;
            done = true;
            reject(new Error('Timed out waiting for PING response'));
        }, timeout);

        socket.once('AUTH_FAIL', function (message) {
            if (done) return;
            done = true;
            clearTimeout(timer);
            resolve({authFail: message});
        });

        socket.emit('PING', {app_id: 'remote-smoke-test'}, function (response) {
            if (done) return;
            done = true;
            clearTimeout(timer);
            resolve({response: response});
        });
    });
}

async function roundTrip() {
    var target = parseTarget(url);
    var mq = new Factory({
        host: target.host,
        port: target.port,
        protocol: target.protocol,
        auth: token ? {token: token} : null,
        logger: {
            log: function () {},
            warn: console.warn.bind(console),
            error: console.error.bind(console)
        }
    });

    var producer;
    var consumer;
    try {
        producer = await mq.createProducer(producerName);
        consumer = await mq.createConsumer(consumerName);

        var received = await new Promise(function (resolve, reject) {
            var timer = setTimeout(function () {
                reject(new Error('Timed out waiting for round-trip message'));
            }, timeout);

            consumer.subscribe(producer.name, eventName, function (data, from) {
                clearTimeout(timer);
                resolve({data: data, from: from});
            });

            setTimeout(function () {
                producer.produce(eventName, message);
            }, 750);
        });

        if (received.data !== message)
            throw new Error('Round trip payload mismatch: ' + JSON.stringify(received));

        return received;
    }
    finally {
        if (consumer) consumer.disconnect();
        if (producer) producer.disconnect();
    }
}

async function main() {
    console.log('[remote-smoke] target:', url);
    console.log('[remote-smoke] token :', token ? 'provided' : 'not provided');

    var socket = await rawConnect();
    console.log('[remote-smoke] socket connected:', socket.id);

    try {
        if (token) {
            var authInfo = await authenticate(socket);
            console.log('[remote-smoke] AUTH_OK:', JSON.stringify(authInfo));
        }

        var pingResult = await ping(socket);
        if (pingResult.authFail) {
            console.log('[remote-smoke] PING rejected:', JSON.stringify(pingResult.authFail));
            console.log('[remote-smoke] connection OK, authentication required');
            if (!token)
                return;
            process.exitCode = 1;
            return;
        }

        console.log('[remote-smoke] PING response:', pingResult.response);
    }
    finally {
        socket.disconnect();
    }

    if (!token) {
        console.log('[remote-smoke] no token provided; skipping authenticated round trip');
        return;
    }

    var received = await roundTrip();
    console.log('[remote-smoke] round trip OK:', JSON.stringify(received));
}

main().catch(function (err) {
    console.error('[remote-smoke] failed:', err.message);
    if (err.authFail)
        console.error(JSON.stringify(err.authFail));
    process.exit(1);
});
