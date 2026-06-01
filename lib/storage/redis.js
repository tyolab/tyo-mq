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
