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

    if (!this.client) {
        var redis;
        try {
            redis = require('redis');
        }
        catch (err) {
            throw new Error('Redis storage requires the redis package. Run npm install.');
        }
        this.client = redis.createClient(options.url ? {url: options.url} : (options.client_options || options.clientOptions || {}));
    }
}

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
    if (!this.ownsClient || !this.client)
        return Promise.resolve();
    if (this.client.quit)
        return this.client.quit();
    if (this.client.disconnect)
        return Promise.resolve(this.client.disconnect());
    return Promise.resolve();
};

module.exports = RedisStore;
