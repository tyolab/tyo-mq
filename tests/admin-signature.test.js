/**
 * Signed manager proofs — signing/verification and the undefined-key
 * invariant (the signature base must match the JSON that crosses the wire).
 *
 * Usage: node tests/admin-signature.test.js
 */

'use strict';

const assert = require('assert');
const { test, run } = require('./runner');
const adminSignature = require('../lib/admin-signature');

test('a proof verifies against the same action and body', () => {
    const body = { command: 'add_realm', realm: 'org:acme', required: true };
    const proof = adminSignature.createAdminProof('secret', 'AUTH_MANAGEMENT_COMMAND', body);
    assert.strictEqual(adminSignature.verifyAdminProof('secret', 'AUTH_MANAGEMENT_COMMAND', body, proof), true);
    assert.strictEqual(adminSignature.verifyAdminProof('other', 'AUTH_MANAGEMENT_COMMAND', body, proof), false);
});

test('undefined-valued keys are ignored, matching JSON on the wire', () => {
    // A body signed with an undefined field must verify against the same body
    // AFTER a JSON round-trip (socket.io drops undefined values in transit).
    const signedBody = { request_id: 'r1', approved: true, role: 'producer', reason: undefined };
    const wireBody = JSON.parse(JSON.stringify(signedBody)); // { request_id, approved, role }

    const proof = adminSignature.createAdminProof('k', 'AUTHORIZATION_DECIDE', signedBody);
    assert.strictEqual(
        adminSignature.verifyAdminProof('k', 'AUTHORIZATION_DECIDE', wireBody, proof),
        true,
        'proof over a body with an undefined field must verify against the transmitted (undefined-stripped) body'
    );

    // stableStringify itself drops the undefined key.
    assert.strictEqual(
        adminSignature.stableStringify({ b: undefined, a: 1 }),
        adminSignature.stableStringify({ a: 1 })
    );
});

test('key order does not affect the signature', () => {
    const proof = adminSignature.createAdminProof('k', 'X', { a: 1, b: 2, c: 3 });
    assert.strictEqual(adminSignature.verifyAdminProof('k', 'X', { c: 3, b: 2, a: 1 }, proof), true);
});

test('stableStringify serializes undefined array elements as null (like JSON)', () => {
    assert.strictEqual(adminSignature.stableStringify([1, undefined, 3]), JSON.stringify([1, undefined, 3]));
});

run();
