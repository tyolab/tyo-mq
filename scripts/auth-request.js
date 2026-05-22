#!/usr/bin/env node
/**
 * Submit a client authorization request to a running tyo-mq server.
 */

'use strict';

const crypto = require('crypto');
const Authorization = require('../lib/authorization');

var host = process.env.TYO_MQ_HOST || 'localhost';
var port = parseInt(process.env.TYO_MQ_PORT, 10) || 17352;
var protocol = process.env.TYO_MQ_PROTOCOL || 'http';
var request = {
    realm: process.env.TYO_MQ_REALM || 'default',
    role: process.env.TYO_MQ_ROLE || 'both',
    client_id: process.env.TYO_MQ_CLIENT_ID || null,
    client_name: process.env.TYO_MQ_CLIENT_NAME || null,
    client_token: process.env.TYO_MQ_CLIENT_TOKEN || null,
    challenge_response: null
};

for (var i = 2; i < process.argv.length; i++) {
    switch (process.argv[i]) {
        case '-h': host = process.argv[++i]; break;
        case '-p': port = parseInt(process.argv[++i], 10); break;
        case '-s': protocol = process.argv[++i]; break;
        case '--realm': request.realm = process.argv[++i]; break;
        case '--role': request.role = process.argv[++i]; break;
        case '--client-id': request.client_id = process.argv[++i]; break;
        case '--client-name': request.client_name = process.argv[++i]; break;
        case '--client-token': request.client_token = process.argv[++i]; break;
        case '--challenge-response': request.challenge_response = process.argv[++i]; break;
        default:
            console.error('Unknown option: ' + process.argv[i]);
            process.exit(1);
    }
}

request.client_id = request.client_id || ('client-' + crypto.randomBytes(6).toString('hex'));
request.client_name = request.client_name || request.client_id;
request.client_token = request.client_token || crypto.randomBytes(32).toString('hex');

Authorization.submitAuthorizationRequest(request, {host: host, port: port, protocol: protocol})
    .then(function (response) {
        console.log(JSON.stringify({
            ok: true,
            request_id: response.request_id,
            status: response.status,
            client_token: request.client_token
        }, null, 2));
    })
    .catch(function (err) {
        console.error(err.message);
        if (err.response)
            console.error(JSON.stringify(err.response));
        process.exit(1);
    });
