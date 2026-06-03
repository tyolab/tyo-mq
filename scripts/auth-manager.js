#!/usr/bin/env node
/**
 * Manage pending client authorization requests with a signed manager proof.
 *
 * Usage:
 *   node scripts/auth-manager.js next [--realm realm]
 *   node scripts/auth-manager.js approve <request_id> [--role role]
 *   node scripts/auth-manager.js reject <request_id> [--reason text]
 */

'use strict';

const env = require('../lib/env');
const Authorization = require('../lib/authorization');

var action = process.argv[2];
var requestId = process.argv[3] && process.argv[3][0] !== '-' ? process.argv[3] : null;
var host = process.env.TYO_MQ_HOST || 'localhost';
var port = parseInt(process.env.TYO_MQ_PORT, 10) || 17352;
var protocol = process.env.TYO_MQ_PROTOCOL || 'http';
var envFile = process.env.TYO_MQ_ENV_FILE || '.env';
var tokenEnv = process.env.TYO_MQ_ADMIN_TOKEN_ENV || 'TYO_MQ_ADMIN_TOKEN';
var managerKeyEnv = process.env.TYO_MQ_REALM_MANAGER_KEY_ENV || 'TYO_MQ_REALM_MANAGER_KEY';
var realm = null;
var role = 'both';
var reason = null;

for (var i = 2; i < process.argv.length; i++) {
    switch (process.argv[i]) {
        case 'next':
        case 'approve':
        case 'reject':
            break;
        case '-h': host = process.argv[++i]; break;
        case '-p': port = parseInt(process.argv[++i], 10); break;
        case '-s': protocol = process.argv[++i]; break;
        case '--env-file': envFile = process.argv[++i]; break;
        case '--token-env': tokenEnv = process.argv[++i]; break;
        case '--manager-key-env': managerKeyEnv = process.argv[++i]; break;
        case '--realm': realm = process.argv[++i]; break;
        case '--role': role = process.argv[++i]; break;
        case '--reason': reason = process.argv[++i]; break;
        default:
            if (process.argv[i][0] === '-') {
                console.error('Unknown option: ' + process.argv[i]);
                process.exit(1);
            }
    }
}

if (!action || ['next', 'approve', 'reject'].indexOf(action) < 0) {
    console.error('Usage: node scripts/auth-manager.js next|approve|reject ...');
    process.exit(1);
}

env.loadEnvFile(envFile);
var realmManagerKey = process.env[managerKeyEnv];
var managerToken = realmManagerKey || process.env[tokenEnv];
if (!managerToken) {
    console.error('Missing manager key. Expected ' + managerKeyEnv + ' or ' + tokenEnv + ' in ' + envFile + ' or process.env.');
    process.exit(1);
}
if (realmManagerKey && action === 'next' && !realm) {
    console.error('--realm is required when using ' + managerKeyEnv + '.');
    process.exit(1);
}

var options = {host: host, port: port, protocol: protocol};
var op;
if (action === 'next') {
    op = Authorization.nextAuthorizationRequest(managerToken, realm ? {realm: realm} : {}, options);
}
else {
    if (!requestId) {
        console.error(action + ' requires a request_id');
        process.exit(1);
    }
    op = Authorization.decideAuthorizationRequest(managerToken, {
        request_id: requestId,
        approved: action === 'approve',
        role: role,
        reason: reason
    }, options);
}

op.then(function (response) {
    console.log(JSON.stringify(response, null, 2));
}).catch(function (err) {
    console.error(err.message);
    if (err.response)
        console.error(JSON.stringify(err.response));
    process.exit(1);
});
