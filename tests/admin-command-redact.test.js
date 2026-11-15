/**
 * scripts/admin-command.js prints a management ack with secrets redacted.
 * Pins that redaction works by SHAPE as well as by name: on 2026-11-15 the
 * settings dump carried `persistence.storage_options.url` = redis://:<pw>@host
 * and a name-only rule printed the Redis password into a transcript.
 *
 * Usage: node tests/admin-command-redact.test.js
 */

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { test, run } = require('./runner');

// The script connects on load, so lift just the redactor out of its source.
function loadRedact() {
    const src = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'admin-command.js'), 'utf8');
    const m = src.match(/var SECRET_KEY_RE[\s\S]*?\nfunction redact\(value\)[\s\S]*?\n}\n/);
    assert.ok(m, 'redactor block found in scripts/admin-command.js');
    return new Function(m[0] + '; return redact;')();
}

test('URL credentials are masked wherever they sit; credential-free URLs are kept', () => {
    const redact = loadRedact();
    const out = redact({
        persistence: { storage_options: { url: 'redis://:c4cc46eb00@127.0.0.1:6379', prefix: 'p', fallback_filename: '/x.sqlite' } },
        validators: [{ jwks_url: 'https://id.tyo.com.au/.well-known/jwks.json', dsn: 'postgres://user:pw@db/x' }],
    });
    assert.strictEqual(out.persistence.storage_options.url, 'redis://<redacted>@127.0.0.1:6379');
    assert.strictEqual(out.persistence.storage_options.prefix, 'p');
    assert.strictEqual(out.validators[0].jwks_url, 'https://id.tyo.com.au/.well-known/jwks.json');
    assert.strictEqual(out.validators[0].dsn, 'postgres://<redacted>@db/x');
    assert.ok(!JSON.stringify(out).includes('c4cc46eb00'));
});

test('secret-named fields are masked: key/token/secret and password-ish names, any nesting', () => {
    const redact = loadRedact();
    const out = redact({ manager_key: 'k', tokens: ['t'], auth_secret: 's', password: 'p', passwd: 'p', pwd: 'p', credentials: {}, api_key: 'a', nested: [{ private_key: 'x', name: 'keep' }], require_key: true });
    for (const k of ['manager_key', 'tokens', 'auth_secret', 'password', 'passwd', 'pwd', 'credentials', 'api_key', 'require_key'])
        assert.strictEqual(out[k], '<redacted>', k);
    assert.strictEqual(out.nested[0].private_key, '<redacted>');
    assert.strictEqual(out.nested[0].name, 'keep');
});

run();
