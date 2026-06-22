#!/usr/bin/env node
/**
 * Interactive tyo-mq manager.
 *
 * Sends signed management commands to a running tyo-mq server. The admin token
 * is used locally to sign commands and is never sent directly.
 */

'use strict';

const path = require('path');
const readline = require('readline');
const env = require('../lib/env');
const Authorization = require('../lib/authorization');

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

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});

function ask(question) {
    return new Promise(resolve => rl.question(question, answer => resolve(answer.trim())));
}

function getAdminToken() {
    env.loadEnvFile(envFile);
    return process.env[tokenEnv];
}

function connectionOptions() {
    return {host: host, port: port, protocol: protocol};
}

function requireAdminToken() {
    var token = getAdminToken();
    if (!token)
        throw new Error('Missing admin token. Expected ' + tokenEnv + ' in ' + envFile + ' or process.env.');
    return token;
}

function printHeader() {
    console.log('\nTYO-MQ Manager');
    console.log('server   : ' + protocol + '://' + host + ':' + port);
    console.log('env      : ' + path.resolve(envFile));
    console.log('admin env: ' + tokenEnv);
    console.log('mode     : signed socket commands\n');
}

function printMenu() {
    console.log('1. Show auth settings');
    console.log('2. Enable global auth');
    console.log('3. Disable global auth');
    console.log('4. Add realm');
    console.log('5. Rename realm');
    console.log('6. Enable auth for realm');
    console.log('7. Disable auth for realm');
    console.log('8. Verify admin token against server');
    console.log('9. Show next authorization request');
    console.log('10. Approve next authorization request');
    console.log('11. Reject next authorization request');
    console.log('12. Approve request by id');
    console.log('13. Reject request by id');
    console.log('14. Revoke authorized client token');
    console.log('15. Set or clear realm manager key');
    console.log('16. Set or clear realm pre-shared key (consumers)');
    console.log('17. Set realm producer acceptance requirement');
    console.log('18. Show live stats (realms, producers, consumers)');
    console.log('19. List dead-letter queue');
    console.log('20. Replay dead-letter message');
    console.log('21. Discard dead-letter message');
    console.log('22. Remove realm');
    console.log('0. Exit');
}

async function managementCommand(command) {
    return Authorization.authManagementCommand(requireAdminToken(), command, connectionOptions());
}

async function showAuthSettings() {
    var response = await managementCommand({command: 'get'});
    console.log(JSON.stringify(response.settings, null, 2));
}

async function setGlobalAuth(enabled) {
    var response = await managementCommand({command: 'set_global_auth', enabled: enabled});
    console.log('Global auth ' + (enabled ? 'enabled' : 'disabled') + '.');
    console.log(JSON.stringify(response.settings.realms || {}, null, 2));
}

async function addRealm() {
    var realm = await ask('Realm name: ');
    if (!realm)
        return console.log('No realm name provided.');

    var requiredAnswer = await ask('Require auth for this realm? [Y/n]: ');
    var response = await managementCommand({
        command: 'add_realm',
        realm: realm,
        required: requiredAnswer.toLowerCase() !== 'n'
    });
    console.log('Added realm: ' + realm);
    console.log(JSON.stringify(response.settings.realms[realm], null, 2));
}

async function renameRealm() {
    var from = await ask('Current realm name: ');
    var to = await ask('New realm name: ');
    if (!from || !to)
        return console.log('Both names are required.');

    await managementCommand({command: 'rename_realm', from: from, to: to});
    console.log('Renamed realm ' + from + ' -> ' + to);
}

async function removeRealm() {
    var realm = await ask('Realm to remove: ');
    if (!realm)
        return console.log('No realm name provided.');

    var confirm = await ask('Type the realm name again to confirm removal: ');
    if (confirm !== realm)
        return console.log('Realm name did not match — removal cancelled.');

    var response = await managementCommand({command: 'remove_realm', realm: realm});
    var removed = response.removed_tokens ? (' (' + response.removed_tokens + ' token(s) removed)') : '';
    console.log('Removed realm ' + realm + removed);
}

async function setRealmAuth(required) {
    var realm = await ask('Realm name: ');
    if (!realm)
        return console.log('No realm name provided.');

    await managementCommand({command: 'set_realm_auth', realm: realm, required: required});
    console.log('Realm ' + realm + ' auth.required = ' + required);
}

async function verifyAdminToken() {
    await managementCommand({command: 'get'});
    console.log('Admin signature accepted by server.');
}

async function nextRequest(realm) {
    return Authorization.nextAuthorizationRequest(requireAdminToken(), realm ? {realm: realm} : {}, connectionOptions());
}

async function showNextRequest() {
    var realm = await ask('Realm filter (blank for any): ');
    var response = await nextRequest(realm);
    console.log(JSON.stringify(response.request || {message: 'No pending requests'}, null, 2));
}

async function decideRequest(requestId, approved) {
    var role = approved ? await ask('Role to grant [both]: ') : '';
    var reason = approved ? '' : await ask('Reject reason: ');

    var response = await Authorization.decideAuthorizationRequest(requireAdminToken(), {
        request_id: requestId,
        approved: approved,
        role: role || 'both',
        reason: reason || null
    }, connectionOptions());
    console.log(JSON.stringify(response.request, null, 2));
}

async function decideNext(approved) {
    var realm = await ask('Realm filter (blank for any): ');
    var response = await nextRequest(realm);
    if (!response.request)
        return console.log('No pending requests.');

    console.log(JSON.stringify(response.request, null, 2));
    var confirm = await ask((approved ? 'Approve' : 'Reject') + ' this request? [y/N]: ');
    if (confirm.toLowerCase() !== 'y')
        return console.log('Cancelled.');
    await decideRequest(response.request.request_id, approved);
}

async function decideById(approved) {
    var requestId = await ask('Request id: ');
    if (!requestId)
        return console.log('No request id provided.');
    await decideRequest(requestId, approved);
}

async function revokeToken() {
    var realm = await ask('Realm (optional if using token hash): ');
    var clientId = await ask('Client id (optional if using token hash): ');
    var tokenHash = await ask('Token hash (optional if realm + client id provided): ');

    if (!tokenHash && (!realm || !clientId))
        return console.log('Provide either token hash, or realm + client id.');

    var response = await managementCommand({
        command: 'revoke_token',
        realm: realm || null,
        client_id: clientId || null,
        token_hash: tokenHash || null
    });
    console.log('Revoked token(s):');
    console.log(JSON.stringify(response.revoked || [], null, 2));
}

async function setRealmManagerKey() {
    var realm = await ask('Realm name: ');
    if (!realm)
        return console.log('No realm name provided.');

    var managerKey = await ask('Manager key (blank to clear): ');
    var response = await managementCommand({
        command: 'set_realm_manager_key',
        realm: realm,
        manager_key: managerKey || null
    });
    console.log(JSON.stringify(response.settings.realms[realm], null, 2));
}

async function setRealmKey() {
    var realm = await ask('Realm name: ');
    if (!realm)
        return console.log('No realm name provided.');

    var key = await ask('Pre-shared key (blank to clear): ');
    var response = await managementCommand({
        command: 'set_realm_key',
        realm: realm,
        key: key || null
    });
    console.log(JSON.stringify(response.settings.realms[realm], null, 2));
}

async function setRealmAcceptance() {
    var realm = await ask('Realm name: ');
    if (!realm)
        return console.log('No realm name provided.');

    var answer = await ask('Require producer acceptance for this realm? [Y/n]: ');
    var required = answer.toLowerCase() !== 'n';
    var response = await managementCommand({
        command: 'set_realm_acceptance',
        realm: realm,
        required: required
    });
    console.log('Realm ' + realm + ' require_acceptance = ' + required);
    console.log(JSON.stringify(response.settings.realms[realm], null, 2));
}

async function showStats() {
    var response = await managementCommand({command: 'stats'});
    console.log(JSON.stringify(response.stats, null, 2));
}

async function listDlq() {
    var realm = await ask('Realm filter (blank for all): ');
    var response = await managementCommand({command: 'dlq_list', realm: realm || null});
    if (!response.entries || response.entries.length === 0)
        return console.log('Dead-letter queue is empty.');
    console.log(JSON.stringify(response.entries, null, 2));
}

async function replayDlq() {
    var realm = await ask('Realm (blank for all): ');
    var msgId = await ask('Message id: ');
    if (!msgId)
        return console.log('No message id provided.');
    var response = await managementCommand({command: 'dlq_replay', realm: realm || null, msg_id: msgId});
    console.log('Replayed ' + response.msg_id + ' as ' + response.new_msg_id);
}

async function discardDlq() {
    var realm = await ask('Realm (blank for all): ');
    var msgId = await ask('Message id: ');
    if (!msgId)
        return console.log('No message id provided.');
    await managementCommand({command: 'dlq_discard', realm: realm || null, msg_id: msgId});
    console.log('Discarded ' + msgId);
}

async function handleChoice(choice) {
    if (choice === '0') return false;
    if (choice === '1') await showAuthSettings();
    else if (choice === '2') await setGlobalAuth(true);
    else if (choice === '3') await setGlobalAuth(false);
    else if (choice === '4') await addRealm();
    else if (choice === '5') await renameRealm();
    else if (choice === '6') await setRealmAuth(true);
    else if (choice === '7') await setRealmAuth(false);
    else if (choice === '8') await verifyAdminToken();
    else if (choice === '9') await showNextRequest();
    else if (choice === '10') await decideNext(true);
    else if (choice === '11') await decideNext(false);
    else if (choice === '12') await decideById(true);
    else if (choice === '13') await decideById(false);
    else if (choice === '14') await revokeToken();
    else if (choice === '15') await setRealmManagerKey();
    else if (choice === '16') await setRealmKey();
    else if (choice === '17') await setRealmAcceptance();
    else if (choice === '18') await showStats();
    else if (choice === '19') await listDlq();
    else if (choice === '20') await replayDlq();
    else if (choice === '21') await discardDlq();
    else if (choice === '22') await removeRealm();
    else console.log('Unknown choice: ' + choice);
    return true;
}

async function main() {
    printHeader();
    while (true) {
        printMenu();
        var choice = await ask('\nSelect: ');
        console.log('');

        try {
            var keepGoing = await handleChoice(choice);
            if (!keepGoing)
                break;
        }
        catch (err) {
            console.log(err.message);
            if (err.response)
                console.log(JSON.stringify(err.response, null, 2));
        }

        console.log('');
    }
    rl.close();
}

main().catch(function (err) {
    rl.close();
    console.error(err.stack || err.message);
    process.exit(1);
});
