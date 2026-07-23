/**
 * Signed manager actions for admin-only operations.
 */

'use strict';

const crypto = require('crypto');

function stableStringify(value) {
    if (value === null || typeof value !== 'object')
        return JSON.stringify(value);
    if (Array.isArray(value))
        // JSON serializes an undefined array element as null.
        return '[' + value.map(function (item) {
            var encoded = stableStringify(item);
            return encoded === undefined ? 'null' : encoded;
        }).join(',') + ']';

    // JSON.stringify drops object keys whose value is undefined, and the wire
    // carries the JSON form — so the signature base must drop them too, or a
    // body with an undefined field signs one payload and transmits another.
    return '{' + Object.keys(value).sort().filter(function (key) {
        return value[key] !== undefined;
    }).map(function (key) {
        return JSON.stringify(key) + ':' + stableStringify(value[key]);
    }).join(',') + '}';
}

function signatureBase(action, body, timestamp, nonce) {
    return [
        String(action || ''),
        String(timestamp || ''),
        String(nonce || ''),
        stableStringify(body || {})
    ].join('\n');
}

function signAdminAction(adminToken, action, body, timestamp, nonce) {
    return crypto.createHmac('sha256', String(adminToken))
        .update(signatureBase(action, body, timestamp, nonce))
        .digest('hex');
}

function createAdminProof(adminToken, action, body, opts) {
    opts = opts || {};
    var timestamp = opts.timestamp || Date.now();
    var nonce = opts.nonce || crypto.randomBytes(16).toString('hex');
    return {
        timestamp: timestamp,
        nonce: nonce,
        signature: signAdminAction(adminToken, action, body || {}, timestamp, nonce)
    };
}

function signaturesEqual(a, b) {
    var left = Buffer.from(String(a || ''), 'hex');
    var right = Buffer.from(String(b || ''), 'hex');
    return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function verifyAdminProof(adminToken, action, body, proof, opts) {
    opts = opts || {};
    if (!proof || !proof.timestamp || !proof.nonce || !proof.signature)
        return false;

    var maxAgeMs = opts.maxAgeMs || 5 * 60 * 1000;
    var timestamp = Number(proof.timestamp);
    if (!Number.isFinite(timestamp))
        return false;
    if (Math.abs(Date.now() - timestamp) > maxAgeMs)
        return false;

    var expected = signAdminAction(adminToken, action, body || {}, timestamp, proof.nonce);
    return signaturesEqual(expected, proof.signature);
}

module.exports = {
    createAdminProof: createAdminProof,
    signAdminAction: signAdminAction,
    stableStringify: stableStringify,
    verifyAdminProof: verifyAdminProof
};
