/**
 * Redis durable-message store.
 */

'use strict';

const crypto = require('crypto');

function encodeKeyPart(value) {
    return Buffer.from(String(value || ''), 'utf8').toString('base64url');
}

function RedisStore(options) {
    options = options || {};
    var defaultTtl = options.default_ttl;
    if (defaultTtl === undefined)
        defaultTtl = options.defaultTtl;
    if (defaultTtl === undefined)
        defaultTtl = 24 * 60 * 60;
    this.defaultTtl = Number(defaultTtl);
    this.prefix = options.prefix || 'tyo-mq:queue';
    this.client = options.client || null;
    this.ownsClient = !this.client;
    this.connectPromise = null;

    // Surfaced to the broker so a Redis 'error' event is logged, never fatal.
    this.onError = options.onError || options.on_error || null;
    this.lastError = null;

    if (!this.client) {
        var redis;
        try {
            redis = require('redis');
        }
        catch (err) {
            throw new Error('Redis storage requires the redis package. Run npm install.');
        }
        // Clone so we never mutate the caller's options object, and bound the
        // initial TCP connect so a dead Redis fails fast (the startup probe
        // relies on connect() not hanging forever).
        var clientConfig = Object.assign({}, options.url ? {url: options.url} : (options.client_options || options.clientOptions || {}));
        clientConfig.socket = Object.assign({}, clientConfig.socket);
        if (clientConfig.socket.connectTimeout === undefined)
            clientConfig.socket.connectTimeout = Number(options.connect_timeout || options.connectTimeout) || 5000;
        this.client = redis.createClient(clientConfig);
    }

    // A redis client emits 'error' on connection loss / auth failure / etc.
    // An unhandled 'error' on the EventEmitter would crash the process, so we
    // always attach a handler — the broker treats Redis as best-effort.
    var self = this;
    if (this.client && typeof this.client.on === 'function') {
        this.client.on('error', function (err) {
            self.lastError = err;
            if (self.onError) {
                try { self.onError(err); } catch (e) { /* never rethrow */ }
            }
        });
    }
}

/**
 * Probe connectivity at startup: connect and PING within timeoutMs. Resolves
 * with this store on success; rejects on timeout or error (the caller then
 * falls back to another backend). On failure the client is disconnected so its
 * background reconnect loop does not linger.
 */
RedisStore.prototype.probe = function (timeoutMs) {
    var self = this;
    timeoutMs = Number(timeoutMs) || 5000;
    return new Promise(function (resolve, reject) {
        var settled = false;
        var timer = setTimeout(function () {
            if (settled) return;
            settled = true;
            self.close().catch(function () {});
            reject(new Error('redis probe timed out after ' + timeoutMs + 'ms'));
        }, timeoutMs);
        if (timer.unref) timer.unref();

        self._ensureConnected()
            .then(function (client) { return client.ping(); })
            .then(function () {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                resolve(self);
            })
            .catch(function (err) {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                self.close().catch(function () {});
                reject(err);
            });
    });
};

RedisStore.prototype._now = function () {
    return Date.now();
};

RedisStore.prototype._expiresAt = function (message) {
    var ttl = message && message.ttl;
    if (ttl === undefined || ttl === null)
        ttl = this.defaultTtl;
    ttl = Number(ttl);
    if (!Number.isFinite(ttl) || ttl < 0)
        return null;
    return this._now() + ttl * 1000;
};

RedisStore.prototype._messageKey = function (id) {
    return this.prefix + ':message:' + id;
};

RedisStore.prototype._dlqMessageKey = function (id) {
    return this.prefix + ':dlq:message:' + id;
};

RedisStore.prototype._dlqIndexKey = function (realm) {
    return [
        this.prefix,
        'dlq',
        encodeKeyPart(realm || '')
    ].join(':');
};

RedisStore.prototype._indexKey = function (realm, event, consumer) {
    return [
        this.prefix,
        'index',
        encodeKeyPart(realm),
        encodeKeyPart(event),
        encodeKeyPart(consumer)
    ].join(':');
};

RedisStore.prototype._ensureConnected = function () {
    if (!this.ownsClient || !this.client.connect)
        return Promise.resolve(this.client);
    if (this.client.isOpen || this.client.isReady)
        return Promise.resolve(this.client);
    if (!this.connectPromise)
        this.connectPromise = this.client.connect();
    return this.connectPromise.then(() => this.client);
};

RedisStore.prototype._send = function (args) {
    return this._ensureConnected().then((client) => {
        if (client.sendCommand)
            return client.sendCommand(args);
        throw new Error('Redis client must implement sendCommand(args)');
    });
};

RedisStore.prototype.enqueue = function (realm, event, message) {
    message = message || {};
    var now = this._now();
    var id = message.id || ('msg-' + now.toString(36) + '-' + crypto.randomBytes(6).toString('hex'));
    var consumer = String(message.consumer || message.consumer_id || '');
    var expiresAt = this._expiresAt(message);
    var payload = {
        id: id,
        realm: String(realm || 'default'),
        event: String(event || ''),
        consumer: consumer,
        message: message.payload !== undefined ? message.payload : message.message,
        producer: message.producer || null,
        created_at: new Date(now).toISOString(),
        expires_at: expiresAt
    };
    var messageKey = this._messageKey(id);
    var indexKey = this._indexKey(payload.realm, payload.event, consumer);

    return this._send(['SET', messageKey, JSON.stringify(payload)]).then(() => {
        if (!expiresAt)
            return null;
        return this._send(['PEXPIREAT', messageKey, String(expiresAt)]);
    }).then(() => {
        return this._send(['ZADD', indexKey, String(now), id]);
    }).then(() => id);
};

RedisStore.prototype.dequeue = function (realm, event, consumer) {
    realm = String(realm || 'default');
    event = String(event || '');
    consumer = String(consumer || '');
    var indexKey = this._indexKey(realm, event, consumer);

    return this._send(['ZRANGE', indexKey, '0', '-1']).then((ids) => {
        ids = ids || [];
        return Promise.all(ids.map((id) => {
            return this._send(['GET', this._messageKey(id)]).then((raw) => {
                if (!raw)
                    return this._send(['ZREM', indexKey, id]).then(() => null);
                var entry = JSON.parse(raw);
                if (entry.expires_at && entry.expires_at <= this._now()) {
                    return this.ack(id).then(() => null);
                }
                return {
                    id: entry.id,
                    realm: entry.realm,
                    event: entry.event,
                    consumer: entry.consumer,
                    message: entry.message,
                    producer: entry.producer,
                    created_at: entry.created_at,
                    expires_at: entry.expires_at
                };
            });
        }));
    }).then((entries) => entries.filter(Boolean));
};

RedisStore.prototype.ack = function (msgId) {
    return this._send(['GET', this._messageKey(msgId)]).then((raw) => {
        var removeIndex = Promise.resolve();
        if (raw) {
            var entry = JSON.parse(raw);
            removeIndex = this._send(['ZREM', this._indexKey(entry.realm, entry.event, entry.consumer), msgId]);
        }
        return removeIndex.then(() => this._send(['DEL', this._messageKey(msgId)]));
    }).then(() => undefined);
};

RedisStore.prototype.deadLetter = function (msgId, reason) {
    return this._send(['GET', this._messageKey(msgId)]).then((raw) => {
        if (!raw)
            return null;

        var entry = JSON.parse(raw);
        var dlqEntry = Object.assign({}, entry, {
            reason: reason || null,
            dead_lettered_at: new Date(this._now()).toISOString()
        });

        return this._send(['SET', this._dlqMessageKey(msgId), JSON.stringify(dlqEntry)]).then(() => {
            return this._send(['ZADD', this._dlqIndexKey(entry.realm), String(this._now()), msgId]);
        }).then(() => {
            return this.ack(msgId);
        }).then(() => msgId);
    });
};

RedisStore.prototype.listDlq = function (realm) {
    realm = String(realm || '');
    return this._send(['ZRANGE', this._dlqIndexKey(realm), '0', '-1']).then((ids) => {
        ids = ids || [];
        return Promise.all(ids.map((id) => {
            return this._send(['GET', this._dlqMessageKey(id)]).then((raw) => {
                if (!raw)
                    return this._send(['ZREM', this._dlqIndexKey(realm), id]).then(() => null);
                var entry = JSON.parse(raw);
                return {
                    id: entry.id,
                    realm: entry.realm,
                    event: entry.event,
                    consumer: entry.consumer,
                    message: entry.message,
                    producer: entry.producer,
                    created_at: entry.created_at,
                    expires_at: entry.expires_at,
                    reason: entry.reason || null,
                    dead_lettered_at: entry.dead_lettered_at
                };
            });
        }));
    }).then((entries) => entries.filter(Boolean));
};

RedisStore.prototype.discardDlq = function (msgId, realm) {
    return this._send(['GET', this._dlqMessageKey(msgId)]).then((raw) => {
        var entryRealm = realm;
        if (raw) {
            var entry = JSON.parse(raw);
            entryRealm = entry.realm;
        }
        return this._send(['DEL', this._dlqMessageKey(msgId)]).then(() => {
            if (entryRealm === undefined || entryRealm === null)
                return null;
            return this._send(['ZREM', this._dlqIndexKey(entryRealm), msgId]);
        });
    }).then(() => undefined);
};

// Number of queued (undelivered) messages. Redis can only answer this cheaply
// for the most-specific form — realm + event + consumer maps to exactly one
// index ZSET (ZCARD). The realm-wide (or partially-scoped) count would need a
// SCAN over every index key, so those forms resolve to `null`: "cannot count",
// and the caller (max_queued_per_realm in lib/server.js) skips that check.
// NOTE: before this method existed the realm-wide quota silently never ran on
// Redis at all (no countQueued → typeof guard skipped it); `null` makes that
// same outcome explicit instead of accidental.
// The ZCARD may include ids whose message keys already PEXPIREAT-expired but
// have not been swept from the index yet — an over-count is acceptable for a
// quota (fail-closed) and dequeue() prunes stale ids on the next drain.
RedisStore.prototype.countQueued = function (realm, event, consumer) {
    if (event === undefined || event === null || consumer === undefined || consumer === null)
        return Promise.resolve(null);
    var indexKey = this._indexKey(String(realm || 'default'), String(event), String(consumer));
    return this._send(['ZCARD', indexKey]).then(function (n) {
        return Number(n) || 0;
    });
};

// Collect every key matching the pattern via a cursor SCAN loop.
RedisStore.prototype._scanKeys = function (pattern) {
    var self = this;
    var keys = [];
    var step = function (cursor) {
        return self._send(['SCAN', cursor, 'MATCH', pattern, 'COUNT', '100']).then(function (reply) {
            var next = String(reply[0]);
            keys = keys.concat(reply[1] || []);
            return next === '0' ? keys : step(next);
        });
    };
    return step('0');
};

// Drop every queued message and DLQ entry for a realm — used when a realm is
// removed or an ephemeral realm is disposed of. Returns the count purged.
RedisStore.prototype.purgeRealm = function (realm) {
    var self = this;
    var purged = 0;

    var drainIndex = function (indexKey, messageKeyFor) {
        return self._send(['ZRANGE', indexKey, '0', '-1']).then(function (ids) {
            ids = ids || [];
            purged += ids.length;
            return Promise.all(ids.map(function (id) {
                return self._send(['DEL', messageKeyFor(id)]);
            }));
        }).then(function () {
            return self._send(['DEL', indexKey]);
        });
    };

    var queuePattern = [this.prefix, 'index', encodeKeyPart(realm), '*'].join(':');
    return this._scanKeys(queuePattern).then(function (indexKeys) {
        return Promise.all(indexKeys.map(function (indexKey) {
            return drainIndex(indexKey, self._messageKey.bind(self));
        }));
    }).then(function () {
        return drainIndex(self._dlqIndexKey(realm), self._dlqMessageKey.bind(self));
    }).then(function () {
        return purged;
    });
};

RedisStore.prototype.close = function () {
    var client = this.client;
    if (!this.ownsClient || !client)
        return Promise.resolve();
    var forceClose = function () {
        try { if (client.disconnect) client.disconnect(); }
        catch (e) { /* already closed */ }
        return Promise.resolve();
    };
    // quit() drains gracefully but needs a live connection; if the client is
    // not open (e.g. a failed startup probe) go straight to a forced close.
    var open = client.isOpen || client.isReady;
    if (open && client.quit) {
        try {
            return Promise.resolve(client.quit()).catch(forceClose);
        }
        catch (e) {
            return forceClose();
        }
    }
    return forceClose();
};

module.exports = RedisStore;
