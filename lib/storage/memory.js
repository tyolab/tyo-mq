/**
 * In-process durable-message store.
 *
 * This store survives disconnects but not process restarts. It implements the
 * Phase 2 Store interface and is intentionally small so custom production
 * stores can mirror the same behavior.
 */

'use strict';

const crypto = require('crypto');

function MemoryStore(options) {
    options = options || {};
    var defaultTtl = options.default_ttl;
    if (defaultTtl === undefined)
        defaultTtl = options.defaultTtl;
    if (defaultTtl === undefined)
        defaultTtl = 24 * 60 * 60;
    this.defaultTtl = Number(defaultTtl);
    this.messages = [];
    this.dlq = [];
}

MemoryStore.prototype._now = function () {
    return Date.now();
};

MemoryStore.prototype._expiresAt = function (message) {
    var ttl = message && message.ttl;
    if (ttl === undefined || ttl === null)
        ttl = this.defaultTtl;
    ttl = Number(ttl);
    if (!Number.isFinite(ttl) || ttl < 0)
        return null;
    return this._now() + ttl * 1000;
};

MemoryStore.prototype._purgeExpired = function () {
    var now = this._now();
    this.messages = this.messages.filter(function (entry) {
        return !entry.expires_at || entry.expires_at > now;
    });
};

MemoryStore.prototype.enqueue = function (realm, event, message) {
    message = message || {};
    this._purgeExpired();

    var id = message.id || ('msg-' + this._now().toString(36) + '-' + crypto.randomBytes(6).toString('hex'));
    this.messages.push({
        id: id,
        realm: String(realm || 'default'),
        event: String(event || ''),
        consumer: message.consumer || message.consumer_id || null,
        payload: message.payload !== undefined ? message.payload : message.message,
        producer: message.producer || null,
        created_at: new Date(this._now()).toISOString(),
        expires_at: this._expiresAt(message)
    });

    return Promise.resolve(id);
};

MemoryStore.prototype.dequeue = function (realm, event, consumer) {
    this._purgeExpired();
    realm = String(realm || 'default');
    event = String(event || '');
    consumer = String(consumer || '');

    var result = this.messages.filter(function (entry) {
        return entry.realm === realm && entry.event === event && String(entry.consumer || '') === consumer;
    }).map(function (entry) {
        return {
            id: entry.id,
            realm: entry.realm,
            event: entry.event,
            consumer: entry.consumer,
            message: entry.payload,
            producer: entry.producer,
            created_at: entry.created_at,
            expires_at: entry.expires_at
        };
    });

    return Promise.resolve(result);
};

MemoryStore.prototype.ack = function (msgId) {
    this.messages = this.messages.filter(function (entry) {
        return entry.id !== msgId;
    });
    return Promise.resolve();
};

MemoryStore.prototype.deadLetter = function (msgId, reason) {
    var found = null;
    this.messages = this.messages.filter(function (entry) {
        if (entry.id === msgId) {
            found = entry;
            return false;
        }
        return true;
    });

    if (found) {
        this.dlq.push(Object.assign({}, found, {
            reason: reason || null,
            dead_lettered_at: new Date(this._now()).toISOString()
        }));
    }
    return Promise.resolve(found ? found.id : null);
};

MemoryStore.prototype.listDlq = function (realm) {
    var targetRealm = realm === undefined || realm === null ? null : String(realm);
    return Promise.resolve(this.dlq.filter(function (entry) {
        return !targetRealm || entry.realm === targetRealm;
    }).map(function (entry) {
        return {
            id: entry.id,
            realm: entry.realm,
            event: entry.event,
            consumer: entry.consumer,
            message: entry.payload,
            producer: entry.producer,
            created_at: entry.created_at,
            expires_at: entry.expires_at,
            reason: entry.reason,
            dead_lettered_at: entry.dead_lettered_at
        };
    }));
};

MemoryStore.prototype.discardDlq = function (msgId) {
    this.dlq = this.dlq.filter(function (entry) {
        return entry.id !== msgId;
    });
    return Promise.resolve();
};

// Number of queued (undelivered) messages for a realm — used by the
// max_queued_per_realm quota.
MemoryStore.prototype.countQueued = function (realm) {
    this._purgeExpired();
    var targetRealm = String(realm || 'default');
    return Promise.resolve(this.messages.filter(function (entry) {
        return entry.realm === targetRealm;
    }).length);
};

// Drop every queued message and DLQ entry for a realm — used when a realm is
// removed or an ephemeral realm is disposed of. Returns the count purged.
MemoryStore.prototype.purgeRealm = function (realm) {
    var targetRealm = String(realm || '');
    var before = this.messages.length + this.dlq.length;
    this.messages = this.messages.filter(function (entry) {
        return entry.realm !== targetRealm;
    });
    this.dlq = this.dlq.filter(function (entry) {
        return entry.realm !== targetRealm;
    });
    return Promise.resolve(before - this.messages.length - this.dlq.length);
};

module.exports = MemoryStore;
