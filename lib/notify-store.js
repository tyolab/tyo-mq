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
    // A second process/handle briefly opening the same file (e.g. an admin
    // inspection script, or an overlapping restart) would otherwise throw
    // "database is locked" immediately rather than waiting a moment.
    this.db.exec('PRAGMA busy_timeout = 5000');
    this.db.exec(
        'CREATE TABLE IF NOT EXISTS notify_claims (' +
        'topic TEXT PRIMARY KEY,' +
        'pubkey TEXT NOT NULL,' +
        'pubkey_fingerprint TEXT NOT NULL,' +
        'publish_token_hash TEXT NOT NULL,' +
        'created_at INTEGER NOT NULL' +
        ')'
    );
    this.db.exec(
        'CREATE TABLE IF NOT EXISTS notify_board_config (' +
        'topic TEXT PRIMARY KEY, name TEXT, compact_key TEXT NOT NULL DEFAULT \'key\',' +
        'board_privkey TEXT NOT NULL, board_pubkey TEXT NOT NULL, owner_uid TEXT, created_at INTEGER NOT NULL)'
    );
    this.db.exec(
        'CREATE TABLE IF NOT EXISTS notify_board_state (' +
        'topic TEXT NOT NULL, key TEXT NOT NULL, msg TEXT NOT NULL, state TEXT,' +
        'expires_at INTEGER NOT NULL DEFAULT 0, down INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL,' +
        'PRIMARY KEY (topic, key))'
    );
    this.db.exec(
        'CREATE TABLE IF NOT EXISTS notify_publish_tokens (' +
        'topic TEXT NOT NULL, token_id TEXT NOT NULL, token_hash TEXT NOT NULL, label TEXT,' +
        'created_at INTEGER NOT NULL, PRIMARY KEY (topic, token_id))'
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

// ── board config: topic name, compaction key, broker-held board key, owner ──
NotifyStore.prototype.createBoard = function (topic, b) {
    this.db.prepare('INSERT OR REPLACE INTO notify_board_config' +
        '(topic,name,compact_key,board_privkey,board_pubkey,owner_uid,created_at) VALUES (?,?,?,?,?,?,?)')
        .run(topic, b.name || topic, b.compact_key || 'key', b.board_privkey, b.board_pubkey, b.owner_uid || null, Date.now());
    return this.getBoard(topic);
};

NotifyStore.prototype.getBoard = function (topic) {
    return this.db.prepare('SELECT topic,name,compact_key,board_privkey,board_pubkey,owner_uid,created_at ' +
        'FROM notify_board_config WHERE topic = ?').get(topic) || null;
};

NotifyStore.prototype.setBoardName = function (topic, name) {
    this.db.prepare('UPDATE notify_board_config SET name = ? WHERE topic = ?').run(name, topic);
};

// ── board state: compacted latest-message-per-key + watchdog down/expiry ────
NotifyStore.prototype.upsertBoardState = function (topic, key, s) {
    this.db.prepare('INSERT OR REPLACE INTO notify_board_state' +
        '(topic,key,msg,state,expires_at,down,updated_at) VALUES (?,?,?,?,?,COALESCE((SELECT down FROM notify_board_state WHERE topic=? AND key=?),0),?)')
        .run(topic, key, s.msg, s.state || null, s.expires_at || 0, topic, key, Date.now());
};

NotifyStore.prototype.getBoardState = function (topic) {
    return this.db.prepare('SELECT key,msg,state,expires_at,down,updated_at FROM notify_board_state WHERE topic = ? ORDER BY key').all(topic);
};

NotifyStore.prototype.setBoardDown = function (topic, key, down) {
    this.db.prepare('UPDATE notify_board_state SET down = ? WHERE topic = ? AND key = ?').run(down ? 1 : 0, topic, key);
};

NotifyStore.prototype.dueBoardKeys = function (now) {
    return this.db.prepare('SELECT topic,key FROM notify_board_state WHERE expires_at > 0 AND expires_at < ? AND down = 0').all(now);
};

// ── per-watcher publish token set ───────────────────────────────────────────
NotifyStore.prototype.addPublishToken = function (topic, t) {
    var id = require('crypto').randomBytes(8).toString('hex');
    this.db.prepare('INSERT INTO notify_publish_tokens(topic,token_id,token_hash,label,created_at) VALUES (?,?,?,?,?)')
        .run(topic, id, t.token_hash, t.label || null, Date.now());
    return id;
};

NotifyStore.prototype.listPublishTokens = function (topic) {
    return this.db.prepare('SELECT token_id,label,created_at FROM notify_publish_tokens WHERE topic = ? ORDER BY created_at').all(topic);
};

NotifyStore.prototype.revokePublishToken = function (topic, id) {
    var result = this.db.prepare('DELETE FROM notify_publish_tokens WHERE topic = ? AND token_id = ?').run(topic, id);
    return result.changes > 0; // true if a token was actually removed (idempotent-friendly)
};

NotifyStore.prototype.publishTokenMatchesAny = function (topic, token) {
    var NotifyAuth = require('./notify-auth');
    var rows = this.db.prepare('SELECT token_hash FROM notify_publish_tokens WHERE topic = ?').all(topic);
    for (var i = 0; i < rows.length; i++)
        if (NotifyAuth.publishTokenMatches(token, rows[i].token_hash)) return true;
    return false;
};

NotifyStore.prototype.close = function () {
    this.db.close();
};

NotifyStore.isSupported = function () {
    return !!DatabaseSync;
};

module.exports = NotifyStore;
