/**
 * SQLite auth store: durable, transactional persistence for realms, tokens,
 * and management tokens (opt-in via the `auth_store` setting).
 *
 * Usage: node tests/auth-store.test.js
 */

'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Authorization = require('../lib/authorization');
const AuthStore = require('../lib/auth-store');
const { test, run } = require('./runner');
const { startServer, delay } = require('./helpers');

const ADMIN_TOKEN = 'secret-admin';

function tmpDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'tyo-mq-auth-store-'));
}

function serverOptions(storeFile, extraAuth) {
    return Object.assign({
        auth: Object.assign({
            enabled: true,
            auto_admin_token: false,
            tokens: [{ token: ADMIN_TOKEN, realm: '*', role: 'admin' }]
        }, extraAuth || {}),
        auth_store: { filename: storeFile }
    });
}

test('realms and tokens from settings are imported and survive a restart', async () => {
    const dir = tmpDir();
    const storeFile = path.join(dir, 'auth.sqlite');

    // First boot: realm + client token come from constructor options and are
    // imported into the store.
    const first = await startServer(serverOptions(storeFile, {
        realms: { 'org:acme': { required: true } },
        tokens: [
            { token: ADMIN_TOKEN, realm: '*', role: 'admin' },
            { token: 'acme-client', realm: 'org:acme', role: 'both' }
        ]
    }));
    const firstOptions = {host: '127.0.0.1', port: first.port, protocol: 'http'};

    try {
        await Authorization.authManagementCommand(ADMIN_TOKEN, {
            command: 'add_realm',
            realm: 'org:runtime-added'
        }, firstOptions);
    } finally {
        await first.close();
    }

    // Second boot: options carry only the admin token — everything else must
    // come back from the store.
    const second = await startServer(serverOptions(storeFile));
    const secondOptions = {host: '127.0.0.1', port: second.port, protocol: 'http'};

    try {
        const settings = await Authorization.authManagementCommand(ADMIN_TOKEN, {
            command: 'get'
        }, secondOptions);
        assert.ok(settings.settings.realms['org:acme'], 'imported realm should survive restart');
        assert.ok(settings.settings.realms['org:runtime-added'], 'runtime-added realm should survive restart');
        assert.ok(settings.settings.tokens.some(t => t.realm === 'org:acme'),
            'imported client token should survive restart');
    } finally {
        await second.close();
        fs.rmSync(dir, {recursive: true, force: true});
    }
});

test('removals persist — deleted realms do not resurrect on restart', async () => {
    const dir = tmpDir();
    const storeFile = path.join(dir, 'auth.sqlite');

    const first = await startServer(serverOptions(storeFile));
    const firstOptions = {host: '127.0.0.1', port: first.port, protocol: 'http'};

    try {
        await Authorization.authManagementCommand(ADMIN_TOKEN, {
            command: 'add_realm', realm: 'doomed-realm'
        }, firstOptions);
        await Authorization.authManagementCommand(ADMIN_TOKEN, {
            command: 'add_realm', realm: 'kept-realm'
        }, firstOptions);
        await Authorization.authManagementCommand(ADMIN_TOKEN, {
            command: 'remove_realm', realm: 'doomed-realm'
        }, firstOptions);
    } finally {
        await first.close();
    }

    const second = await startServer(serverOptions(storeFile));
    const secondOptions = {host: '127.0.0.1', port: second.port, protocol: 'http'};

    try {
        const settings = await Authorization.authManagementCommand(ADMIN_TOKEN, {
            command: 'get'
        }, secondOptions);
        assert.ok(!settings.settings.realms['doomed-realm'], 'removed realm must stay removed');
        assert.ok(settings.settings.realms['kept-realm'], 'other realms must be untouched');
    } finally {
        await second.close();
        fs.rmSync(dir, {recursive: true, force: true});
    }
});

test('with the store active, the settings file sheds realms and tokens', async () => {
    const dir = tmpDir();
    const storeFile = path.join(dir, 'auth.sqlite');
    const settingsFile = path.join(dir, 'settings.json');

    const server = await startServer(serverOptions(storeFile));
    const options = {host: '127.0.0.1', port: server.port, protocol: 'http'};

    try {
        server.server.loadSettings(settingsFile);
        await Authorization.authManagementCommand(ADMIN_TOKEN, {
            command: 'add_realm', realm: 'org:file-check'
        }, options);
        await delay(300); // let the write + watcher debounce settle

        const onDisk = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
        assert.ok(!(onDisk.auth && onDisk.auth.realms), 'realms must not be written to the JSON file');
        assert.ok(!(onDisk.auth && onDisk.auth.tokens), 'tokens must not be written to the JSON file');

        // ... but the realm is in the SQLite store.
        const store = new AuthStore({filename: storeFile});
        const stored = store.load();
        store.close();
        assert.ok(stored.realms['org:file-check'], 'realm must be in the auth store');
        assert.ok(stored.tokens.some(t => t.token === ADMIN_TOKEN), 'tokens must be in the auth store');
    } finally {
        await server.close();
        fs.rmSync(dir, {recursive: true, force: true});
    }
});

test('ephemeral realm disposal is durable across restarts', async () => {
    const dir = tmpDir();
    const storeFile = path.join(dir, 'auth.sqlite');

    const first = await startServer(serverOptions(storeFile));
    const firstOptions = {host: '127.0.0.1', port: first.port, protocol: 'http'};

    try {
        await Authorization.authManagementCommand(ADMIN_TOKEN, {
            command: 'add_realm', realm: 'ci:short-lived', ephemeral: true, ttl: '150ms'
        }, firstOptions);
        await delay(250);
        assert.strictEqual(first.server.sweepEphemeralRealms(), 1);
    } finally {
        await first.close();
    }

    const second = await startServer(serverOptions(storeFile));
    const secondOptions = {host: '127.0.0.1', port: second.port, protocol: 'http'};

    try {
        const settings = await Authorization.authManagementCommand(ADMIN_TOKEN, {
            command: 'get'
        }, secondOptions);
        assert.ok(!settings.settings.realms['ci:short-lived'], 'disposed ephemeral realm must stay gone');
    } finally {
        await second.close();
        fs.rmSync(dir, {recursive: true, force: true});
    }
});

test('an expired ephemeral realm in the store is swept at next boot', async () => {
    const dir = tmpDir();
    const storeFile = path.join(dir, 'auth.sqlite');

    // Seed the store directly with an already-expired ephemeral realm, as if
    // the server crashed before its sweep ran.
    const seed = new AuthStore({filename: storeFile});
    seed.sync({
        realms: {
            'ci:crashed-run': { required: true, ephemeral: true, expires_at: Date.now() - 1000 },
            'ci:live-run':    { required: true, ephemeral: true, expires_at: Date.now() + 60000 }
        },
        tokens: []
    });
    seed.close();

    const server = await startServer(serverOptions(storeFile));
    const options = {host: '127.0.0.1', port: server.port, protocol: 'http'};

    try {
        const settings = await Authorization.authManagementCommand(ADMIN_TOKEN, {
            command: 'get'
        }, options);
        assert.ok(!settings.settings.realms['ci:crashed-run'], 'expired realm must be swept at boot');
        assert.ok(settings.settings.realms['ci:live-run'], 'unexpired realm must survive boot');
    } finally {
        await server.close();
        fs.rmSync(dir, {recursive: true, force: true});
    }
});

test('backupAuthStore writes a consistent, loadable snapshot', async () => {
    const dir = tmpDir();
    const storeFile = path.join(dir, 'auth.sqlite');
    const backupFile = path.join(dir, 'auth-backup.sqlite');

    const server = await startServer(serverOptions(storeFile));
    const options = {host: '127.0.0.1', port: server.port, protocol: 'http'};

    try {
        await Authorization.authManagementCommand(ADMIN_TOKEN, {
            command: 'add_realm', realm: 'org:backup-me'
        }, options);

        assert.strictEqual(server.server.backupAuthStore(backupFile), true);

        const restored = new AuthStore({filename: backupFile});
        const stored = restored.load();
        restored.close();
        assert.ok(stored.realms['org:backup-me'], 'backup must contain the realm');
    } finally {
        await server.close();
        fs.rmSync(dir, {recursive: true, force: true});
    }
});

test('servers without auth_store are untouched (settings file keeps realms)', async () => {
    const dir = tmpDir();
    const settingsFile = path.join(dir, 'settings.json');

    const server = await startServer({
        auth: {
            enabled: true,
            auto_admin_token: false,
            tokens: [{ token: ADMIN_TOKEN, realm: '*', role: 'admin' }]
        }
    });
    const options = {host: '127.0.0.1', port: server.port, protocol: 'http'};

    try {
        server.server.loadSettings(settingsFile);
        await Authorization.authManagementCommand(ADMIN_TOKEN, {
            command: 'add_realm', realm: 'org:legacy-mode'
        }, options);
        await delay(300);

        const onDisk = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
        assert.ok(onDisk.auth.realms['org:legacy-mode'],
            'without the store, realms keep going to the JSON file as before');
    } finally {
        await server.close();
        fs.rmSync(dir, {recursive: true, force: true});
    }
});

run();
