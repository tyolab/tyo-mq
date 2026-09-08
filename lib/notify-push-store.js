/**
 * @file notify-push-store.js
 *
 * SQLite-backed durable store for TYO Notify's phone-push registrations
 * (topic → device endpoint). Companion to the in-memory {@link TokenRegistry}
 * (lib/push.js): the registry is the hot path, this store is its backing tape
 * so registrations SURVIVE A BROKER RESTART.
 *
 * Why this exists: the notify push registry was originally in-memory only, so
 * every broker restart (a deploy, a crash) silently dropped every device's
 * registration. Publishes kept returning 200 and fanning out to SSE, but
 * `deliverNotifyPush` found no endpoints and no push ever arrived — and the
 * only client-side re-register trigger was an FCM token rotation (rare). A
 * daily-cron topic could go dark for days after a single deploy. Persisting
 * the registry closes that gap: on boot the registry hydrates from here.
 *
 * Mirrors lib/notify-store.js (the claim store): same node:sqlite binding,
 * same WAL + busy_timeout pragmas, so any runtime that supports the claim
 * store supports this one too.
 */

'use strict';

let DatabaseSync;
try {
    DatabaseSync = require('node:sqlite').DatabaseSync;
}
catch (err) {
    DatabaseSync = null;
}

function NotifyPushStore(options) {
    options = options || {};
    if (!DatabaseSync)
        throw new Error('The SQLite notify push store requires a Node.js runtime with node:sqlite support (Node 22+)');

    this.filename = options.filename || options.file || options.path || 'tyo-mq.notify-push.sqlite';
    this.db = new DatabaseSync(this.filename);
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA busy_timeout = 5000');
    this.db.exec(
        'CREATE TABLE IF NOT EXISTS notify_push_endpoints (' +
        'realm TEXT NOT NULL,' +
        'identity TEXT NOT NULL,' +
        'transport TEXT NOT NULL,' +
        'token TEXT NOT NULL,' +
        'app_id TEXT,' +
        'env TEXT,' +
        'min_priority INTEGER,' +
        'added_at INTEGER NOT NULL,' +
        'PRIMARY KEY (realm, identity, transport, token)' +
        ')'
    );
}

// Every stored endpoint, for hydrating the in-memory registry on boot.
NotifyPushStore.prototype.all = function () {
    return this.db.prepare(
        'SELECT realm, identity, transport, token, app_id, env, min_priority, added_at ' +
        'FROM notify_push_endpoints'
    ).all();
};

// Upsert one endpoint. Called on every register/rotate; keyed by
// (realm, identity, transport, token) so a repeat refreshes added_at in place.
NotifyPushStore.prototype.put = function (realm, identity, ep) {
    ep = ep || {};
    this.db.prepare(
        'INSERT OR REPLACE INTO notify_push_endpoints ' +
        '(realm, identity, transport, token, app_id, env, min_priority, added_at) ' +
        'VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(
        String(realm), String(identity), String(ep.transport), String(ep.token),
        ep.app_id != null ? String(ep.app_id) : null,
        ep.env != null ? String(ep.env) : null,
        (typeof ep.min_priority === 'number') ? ep.min_priority : null,
        Number(ep.added_at) || 0
    );
};

// Remove one endpoint (unregister / gone-prune).
NotifyPushStore.prototype.del = function (realm, identity, transport, token) {
    this.db.prepare(
        'DELETE FROM notify_push_endpoints ' +
        'WHERE realm = ? AND identity = ? AND transport = ? AND token = ?'
    ).run(String(realm), String(identity), String(transport), String(token));
};

// Drop rows older than cutoff (ms epoch) — mirrors the registry's idle TTL so a
// long-dead endpoint isn't resurrected on hydrate. Best-effort housekeeping.
NotifyPushStore.prototype.pruneOlderThan = function (cutoff) {
    this.db.prepare(
        'DELETE FROM notify_push_endpoints WHERE added_at < ?'
    ).run(Number(cutoff) || 0);
};

NotifyPushStore.prototype.close = function () {
    this.db.close();
};

NotifyPushStore.isSupported = function () {
    return !!DatabaseSync;
};

module.exports = NotifyPushStore;
