/**
 * @file subscription-store.js
 *
 * SQLite-backed durable store for the plaintext pub/sub routing table —
 * which named consumer is subscribed to which event string, with what
 * options — so subscriptions SURVIVE A BROKER RESTART.
 *
 * Why this exists: realm.subscriptions and consumers[name].subscribeTos were
 * in-memory only, rebuilt from each client's SUBSCRIBE after it reconnected.
 * A consumer that had not reconnected since the last restart therefore did
 * not exist for routing: a `guaranteed` PRODUCE addressed to it was fanned
 * out to the subscribers that did exist, nothing was enqueued for it (there
 * was no subscription to enqueue under), no push wake fired (the plain-path
 * wake fires only after an enqueue), and there was nothing to replay when it
 * came back. Found 2026-11-11: a plain inbox message to a phone that had been
 * off since a deploy 23 h earlier vanished, while sealed delivery to the same
 * phone — whose inbox, UAK and push registries are all durable — worked.
 *
 * Mirrors lib/notify-push-store.js: same node:sqlite binding, same WAL +
 * busy_timeout pragmas, owner-only file mode. Only NAMED consumers are
 * stored; anonymous (socket-id) consumers are transient by definition.
 */

'use strict';

let DatabaseSync;
try {
    DatabaseSync = require('node:sqlite').DatabaseSync;
}
catch (err) {
    DatabaseSync = null;
}

function SubscriptionStore(options) {
    options = options || {};
    if (!DatabaseSync)
        throw new Error('The SQLite subscription store requires a Node.js runtime with node:sqlite support (Node 22+)');

    this.filename = options.filename || options.file || options.path || 'tyo-mq.subscriptions.sqlite';
    this.db = new DatabaseSync(this.filename);
    ['', '-wal', '-shm'].forEach(function (suffix) {
        try { require('fs').chmodSync(this.filename + suffix, 0o600); } catch (e) { /* best-effort */ }
    }, this);
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA busy_timeout = 5000');
    this.db.exec(
        'CREATE TABLE IF NOT EXISTS subscriptions (' +
        'realm TEXT NOT NULL,' +
        'event_str TEXT NOT NULL,' +
        'consumer TEXT NOT NULL,' +
        'producer TEXT NOT NULL,' +
        'event TEXT NOT NULL,' +
        'scope_all INTEGER NOT NULL DEFAULT 0,' +
        'durable INTEGER NOT NULL DEFAULT 0,' +
        'ack_required INTEGER NOT NULL DEFAULT 0,' +
        'ack_timeout_ms INTEGER,' +
        'group_name TEXT,' +
        'mode TEXT,' +
        'consumer_id TEXT,' +
        'retry_json TEXT,' +
        'updated_at INTEGER NOT NULL,' +
        'PRIMARY KEY (realm, event_str, consumer)' +
        ')'
    );
}

// Every stored subscription, for hydrating the routing table on boot.
SubscriptionStore.prototype.all = function () {
    return this.db.prepare(
        'SELECT realm, event_str, consumer, producer, event, scope_all, durable, ack_required, ' +
        'ack_timeout_ms, group_name, mode, consumer_id, retry_json, updated_at FROM subscriptions'
    ).all().map(function (row) {
        var retry = null;
        if (row.retry_json) { try { retry = JSON.parse(row.retry_json); } catch (e) { retry = null; } }
        return {
            realm: row.realm, event_str: row.event_str, consumer: row.consumer, producer: row.producer,
            event: row.event, scope_all: !!row.scope_all, durable: !!row.durable, ack_required: !!row.ack_required,
            ack_timeout_ms: row.ack_timeout_ms, group: row.group_name || null, mode: row.mode || null,
            consumer_id: row.consumer_id || null, retry: retry, updated_at: row.updated_at
        };
    });
};

// Upsert one subscription (a repeat SUBSCRIBE refreshes it in place).
SubscriptionStore.prototype.put = function (realm, eventStr, consumer, rec) {
    rec = rec || {};
    this.db.prepare(
        'INSERT OR REPLACE INTO subscriptions ' +
        '(realm, event_str, consumer, producer, event, scope_all, durable, ack_required, ack_timeout_ms, ' +
        'group_name, mode, consumer_id, retry_json, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(
        String(realm), String(eventStr), String(consumer), String(rec.producer || ''), String(rec.event || ''),
        rec.scope_all ? 1 : 0, rec.durable ? 1 : 0, rec.ack_required ? 1 : 0,
        rec.ack_timeout_ms != null ? Number(rec.ack_timeout_ms) : null,
        rec.group != null ? String(rec.group) : null, rec.mode != null ? String(rec.mode) : null,
        rec.consumer_id != null ? String(rec.consumer_id) : null,
        rec.retry ? JSON.stringify(rec.retry) : null, Date.now()
    );
};

SubscriptionStore.prototype.del = function (realm, eventStr, consumer) {
    this.db.prepare('DELETE FROM subscriptions WHERE realm = ? AND event_str = ? AND consumer = ?')
        .run(String(realm), String(eventStr), String(consumer));
};

SubscriptionStore.prototype.delConsumer = function (realm, consumer) {
    this.db.prepare('DELETE FROM subscriptions WHERE realm = ? AND consumer = ?').run(String(realm), String(consumer));
};

SubscriptionStore.prototype.delRealm = function (realm) {
    this.db.prepare('DELETE FROM subscriptions WHERE realm = ?').run(String(realm));
};

SubscriptionStore.prototype.close = function () {
    try { this.db.close(); } catch (e) { /* already closed */ }
};

SubscriptionStore.isSupported = function () {
    return !!DatabaseSync;
};

module.exports = SubscriptionStore;
