'use strict';
/**
 * Multi-device helpers shared by the broker and its tests (secure-chat spec
 * 2026-11-16; Phase 1 = tyo-mq 1.11.x/1.12.x). Pure functions, no state.
 *
 * Proof of possession at linked-device registration (1.12.0):
 *   sig = XEdDSA(identity key, UTF-8(DEVREG_PREFIX + account + "\n" + N + "\n" + nonce))
 * where nonce is the broker's base64 string exactly as received. Pinned by the
 * frozen vector tests/vectors/multi-device/devreg.json (secure-chat
 * feat/multi-device-p2b, crates/tyo-chat-core/tests/vectors/devreg.json).
 */
var DEVREG_PREFIX = 'tyo-devreg-v1\n';
var DEVLIST_PREFIX = 'tyo-devlist-v1\n';

function devregMessage(account, device, nonce) {
    return Buffer.from(DEVREG_PREFIX + account + '\n' + device + '\n' + nonce, 'utf8');
}

/** true iff `sigB64` is a valid signature by `identityKeyB64` over the devreg bytes. */
function verifyDevreg(identityKeyB64, account, device, nonce, sigB64) {
    try {
        var ls = require('@signalapp/libsignal-client');
        return ls.PublicKey.deserialize(Buffer.from(identityKeyB64, 'base64'))
            .verify(devregMessage(account, device, nonce), Buffer.from(sigB64, 'base64'));
    } catch (e) { return false; }
}

/** true iff `sigB64` is a valid signature by `identityKeyB64` over DEVLIST_PREFIX || record. */
function verifyDeviceListSig(identityKeyB64, record, sigB64) {
    try {
        var ls = require('@signalapp/libsignal-client');
        return ls.PublicKey.deserialize(Buffer.from(identityKeyB64, 'base64'))
            .verify(Buffer.concat([Buffer.from(DEVLIST_PREFIX, 'utf8'), Buffer.from(record, 'utf8')]), Buffer.from(sigB64, 'base64'));
    } catch (e) { return false; }
}

module.exports = { DEVREG_PREFIX: DEVREG_PREFIX, DEVLIST_PREFIX: DEVLIST_PREFIX, devregMessage: devregMessage, verifyDevreg: verifyDevreg, verifyDeviceListSig: verifyDeviceListSig };
