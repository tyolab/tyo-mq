/**
 * TYO Notify Status Boards — unit tests for lib/notify-boards.js.
 * Pure functions, no server. Usage: node tests/notify-boards-unit.test.js
 */

'use strict';

const assert = require('assert');
const { test, run } = require('./runner');
const B = require('../lib/notify-boards');

test('extractField pulls key/ttl from a tags array (key=value csv already split)', () => {
    const tags = ['key=web1', 'metric=disk', 'value=96%', 'ttl=120', 'state=warn'];
    assert.strictEqual(B.extractField(tags, 'key'), 'web1');
    assert.strictEqual(B.extractField(tags, 'ttl'), '120');
    assert.strictEqual(B.extractField(tags, 'nope'), null);
    assert.strictEqual(B.extractField(null, 'key'), null);
});

test('boardKeypair returns matching PKCS8 + SPKI base64 (EC P-256)', () => {
    const kp = B.boardKeypair();
    assert.ok(kp.privateKeyPkcs8B64 && kp.publicKeySpkiB64);
    // fingerprint of the SPKI must be derivable (same algo as notify-auth)
    const fp = require('../lib/notify-auth').pubkeyFingerprint(kp.publicKeySpkiB64);
    assert.strictEqual(fp.length, 64);
});

test('synthDownMessage builds a high-priority watchdog DOWN card for a key', () => {
    const m = B.synthDownMessage('ops', 'web1', 'web1');
    assert.strictEqual(m.topic, 'ops');
    assert.ok(m.tags.includes('key=web1'));
    assert.ok(m.tags.includes('state=crit'));
    assert.ok(m.tags.includes('source=watchdog'));
    assert.strictEqual(m.priority, 5);
});

run();
