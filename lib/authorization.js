/**
 * Client helpers for pending authorization requests and signed manager actions.
 */

'use strict';

const ioClient = require('socket.io-client');
const adminSignature = require('./admin-signature');

function connect(options) {
    options = options || {};
    var host = options.host || process.env.TYO_MQ_HOST || 'localhost';
    var port = options.port || process.env.TYO_MQ_PORT || 17352;
    var protocol = options.protocol || process.env.TYO_MQ_PROTOCOL || 'http';
    var url = options.url || (protocol + '://' + host + ':' + port);
    var timeout = options.timeout || 5000;
    var socket = ioClient(url, {transports: ['websocket']});

    return new Promise(function (resolve, reject) {
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

function emitAck(socket, event, payload, timeout) {
    timeout = timeout || 5000;
    return new Promise(function (resolve, reject) {
        var timer = setTimeout(function () {
            reject(new Error('Timed out waiting for ' + event + ' response'));
        }, timeout);

        socket.emit(event, payload, function (response) {
            clearTimeout(timer);
            if (!response || response.ok === false) {
                var err = new Error((response && response.message) || (event + ' failed'));
                err.response = response;
                reject(err);
                return;
            }
            resolve(response);
        });
    });
}

function withSocket(options, fn) {
    return connect(options).then(function (socket) {
        return Promise.resolve(fn(socket)).finally(function () {
            socket.disconnect();
        });
    });
}

function submitAuthorizationRequest(request, options) {
    return withSocket(options, function (socket) {
        return emitAck(socket, 'AUTHORIZATION_REQUEST', request, options && options.timeout);
    });
}

function signedManagerPayload(adminToken, action, body) {
    body = body || {};
    return {
        body: body,
        proof: adminSignature.createAdminProof(adminToken, action, body)
    };
}

function nextAuthorizationRequest(adminToken, filter, options) {
    return withSocket(options, function (socket) {
        return emitAck(socket, 'AUTHORIZATION_NEXT',
            signedManagerPayload(adminToken, 'AUTHORIZATION_NEXT', filter || {}),
            options && options.timeout);
    });
}

function decideAuthorizationRequest(adminToken, decision, options) {
    return withSocket(options, function (socket) {
        return emitAck(socket, 'AUTHORIZATION_DECIDE',
            signedManagerPayload(adminToken, 'AUTHORIZATION_DECIDE', decision || {}),
            options && options.timeout);
    });
}

function authManagementCommand(adminToken, command, options) {
    return withSocket(options, function (socket) {
        return emitAck(socket, 'AUTH_MANAGEMENT_COMMAND',
            signedManagerPayload(adminToken, 'AUTH_MANAGEMENT_COMMAND', command || {}),
            options && options.timeout);
    });
}

module.exports = {
    authManagementCommand: authManagementCommand,
    createAdminProof: adminSignature.createAdminProof,
    decideAuthorizationRequest: decideAuthorizationRequest,
    nextAuthorizationRequest: nextAuthorizationRequest,
    submitAuthorizationRequest: submitAuthorizationRequest
};
