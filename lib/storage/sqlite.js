/**
 * SQLite durable-message store using Node's built-in node:sqlite module.
 */

'use strict';

const crypto = require('crypto');

let DatabaseSync;
try {
    DatabaseSync = require('node:sqlite').DatabaseSync;
}
catch (err) {
    throw new Error('SQLite storage requires a Node.js runtime with node:sqlite support');
}

function SQLiteStore(options) {
    options = options || {};
    var defaultTtl = options.default_ttl;
    if (defaultTtl === undefined)
        defaultTtl = options.defaultTtl;
    if (defaultTtl === undefined)
        defaultTtl = 24 * 60 * 60;
    this.defaultTtl = Number(defaultTtl);
    this.filename = options.filename || options.file || options.path || 'tyo-mq.sqlite';
    this.db = new DatabaseSync(this.filename);
    this.db.exec([
        'CREATE TABLE IF NOT EXISTS messages (',
        'id TEXT PRIMARY KEY,',
        'realm TEXT NOT NULL,',
        'event TEXT NOT NULL,',
        'consumer TEXT NOT NULL,',
        'payload TEXT NOT NULL,',
        'producer TEXT,',
        'created_at TEXT NOT NULL,',
        'expires_at INTEGER',
        ');',
        '',
        'CREATE INDEX IF NOT EXISTS idx_messages_delivery',
        'ON messages (realm, event, consumer, expires_at)'
    ].join(' '));
}

SQLiteStore.prototype._now = function () {
    return Date.now();
};

SQLiteStore.prototype._expiresAt = function (message) {
    var ttl = message && message.ttl;
    if (ttl === undefined || ttl === null)
        ttl = this.defaultTtl;
    ttl = Number(ttl);
    if (!Number.isFinite(ttl) || ttl < 0)
        return null;
    return this._now() + ttl * 1000;
};

SQLiteStore.prototype._purgeExpired = function () {
    this.db.prepare('DELETE FROM messages WHERE expires_at IS NOT NULL AND expires_at <= ?').run(this._now());
};

SQLiteStore.prototype.enqueue = function (realm, event, message) {
    message = message || {};
    this._purgeExpired();

    var id = message.id || ('msg-' + this._now().toString(36) + '-' + crypto.randomBytes(6).toString('hex'));
    this.db.prepare([
        'INSERT INTO messages',
        '(id, realm, event, consumer, payload, producer, created_at, expires_at)',
        'VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    ].join(' ')).run(
        id,
        String(realm || 'default'),
        String(event || ''),
        String(message.consumer || message.consumer_id || ''),
        JSON.stringify(message.payload !== undefined ? message.payload : message.message),
        message.producer || null,
        new Date(this._now()).toISOString(),
        this._expiresAt(message)
    );

    return Promise.resolve(id);
};

SQLiteStore.prototype.dequeue = function (realm, event, consumer) {
    this._purgeExpired();

    var rows = this.db.prepare([
        'SELECT id, realm, event, consumer, payload, producer, created_at, expires_at',
        'FROM messages',
        'WHERE realm = ? AND event = ? AND consumer = ?',
        'ORDER BY rowid ASC'
    ].join(' ')).all(String(realm || 'default'), String(event || ''), String(consumer || ''));

    return Promise.resolve(rows.map(function (row) {
        return {
            id: row.id,
            realm: row.realm,
            event: row.event,
            consumer: row.consumer,
            message: JSON.parse(row.payload),
            producer: row.producer,
            created_at: row.created_at,
            expires_at: row.expires_at
        };
    }));
};

SQLiteStore.prototype.ack = function (msgId) {
    this.db.prepare('DELETE FROM messages WHERE id = ?').run(msgId);
    return Promise.resolve();
};

SQLiteStore.prototype.close = function () {
    this.db.close();
};

module.exports = SQLiteStore;
