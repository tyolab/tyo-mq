'use strict';
// Pure helpers for TYO Notify Status Boards (compaction key/ttl extraction,
// board keypair generation, synthetic watchdog messages). No storage/server.
var crypto = require('crypto');

// tags is the already-split array of "key=value" strings (as stored on a msg).
function extractField(tags, name) {
    if (!Array.isArray(tags)) return null;
    var prefix = name + '=';
    for (var i = 0; i < tags.length; i++) {
        if (typeof tags[i] === 'string' && tags[i].indexOf(prefix) === 0)
            return tags[i].slice(prefix.length);
    }
    return null;
}

// A broker-held board key: EC P-256, exported as base64 PKCS8 + SPKI.
function boardKeypair() {
    var kp = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    return {
        privateKeyPkcs8B64: kp.privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64'),
        publicKeySpkiB64: kp.publicKey.export({ type: 'spki', format: 'der' }).toString('base64')
    };
}

// A synthetic watchdog message (DOWN/RECOVERED). state 'crit' for down,
// 'ok' for recovered; source=watchdog so clients can style/filter it.
function synthMessage(topic, key, label, state, text) {
    return {
        topic: topic, message: text, priority: 5,
        // Stamp generation time (unix seconds) like a normal publish so live
        // clients can show a DOWN card's detection time / age without special-casing.
        time: Math.floor(Date.now() / 1000),
        tags: ['key=' + key, 'label=' + (label || key), 'state=' + state, 'source=watchdog'],
        event: 'message'
    };
}
function synthDownMessage(topic, key, label) {
    return synthMessage(topic, key, label, 'crit', (label || key) + ' is DOWN — no heartbeat');
}
function synthRecoveredMessage(topic, key, label) {
    return synthMessage(topic, key, label, 'ok', (label || key) + ' RECOVERED');
}

module.exports = { extractField, boardKeypair, synthDownMessage, synthRecoveredMessage };
