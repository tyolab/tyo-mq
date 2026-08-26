/**
 * @file notify-store.js
 *
 * SQLite-backed store for TYO Notify's private-topic claims: which pubkey
 * owns which topic, and that topic's hashed publish token. Durable across
 * broker restarts (unlike the notify message ring or push-token registry,
 * both deliberately in-memory — see
 * docs/specs/2026-08-26-tyo-notify-private-topics-design.md §6).
 *
 * A separate, dedicated store from lib/auth-store.js: auth-store is built
 * around diffing an in-memory settings.auth object (admin-configured
 * realms/tokens); claims are server-generated records from a single atomic
 * claim event, which doesn't fit that diff-sync shape.
 */

'use strict';

let DatabaseSync;
try {
    DatabaseSync = require('node:sqlite').DatabaseSync;
}
catch (err) {
    DatabaseSync = null;
}

function NotifyStore(options) {
    options = options || {};
    if (!DatabaseSync)
        throw new Error('The SQLite notify store requires a Node.js runtime with node:sqlite support (Node 22+)');

    this.filename = options.filename || options.file || options.path || 'tyo-mq.notify.sqlite';
    this.db = new DatabaseSync(this.filename);
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec(
        'CREATE TABLE IF NOT EXISTS notify_claims (' +
        'topic TEXT PRIMARY KEY,' +
        'pubkey TEXT NOT NULL,' +
        'pubkey_fingerprint TEXT NOT NULL,' +
        'publish_token_hash TEXT NOT NULL,' +
        'created_at INTEGER NOT NULL' +
        ')'
    );
}

NotifyStore.prototype.getClaim = function (topic) {
    var row = this.db.prepare(
        'SELECT topic, pubkey, pubkey_fingerprint, publish_token_hash, created_at FROM notify_claims WHERE topic = ?'
    ).get(topic);
    return row || null;
};

// Atomic first-claim-wins insert (INSERT OR IGNORE avoids a read-then-write
// race between two concurrent claim attempts on the same topic). Returns the
// stored row on success, or null if the topic was already claimed.
NotifyStore.prototype.claim = function (topic, entry) {
    var stmt = this.db.prepare(
        'INSERT OR IGNORE INTO notify_claims (topic, pubkey, pubkey_fingerprint, publish_token_hash, created_at) VALUES (?, ?, ?, ?, ?)'
    );
    var result = stmt.run(topic, entry.pubkey, entry.pubkey_fingerprint, entry.publish_token_hash, entry.created_at);
    if (!result.changes)
        return null;
    return this.getClaim(topic);
};

NotifyStore.prototype.close = function () {
    this.db.close();
};

NotifyStore.isSupported = function () {
    return !!DatabaseSync;
};

module.exports = NotifyStore;
