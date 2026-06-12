/**
 * @file cluster.js
 *
 * Cluster settings sync over Redis (Phase 6, tier 1).
 *
 * All tyo-mq nodes in a cluster connect to ONE shared Redis. The managed
 * settings document (auth tokens, realms, keys, persistence) lives under a
 * single key; every change is announced on a pub/sub channel so peers reload
 * it. Signed manager-proof nonces are claimed with SET NX PX so a proof can
 * be used on exactly one node cluster-wide.
 *
 * Keyspace (under `prefix`, default 'tyo-mq:cluster'):
 *   <prefix>:settings            JSON {settings, node_id, updated_at}
 *   <prefix>:settings:rev        monotonically increasing revision counter
 *   <prefix>:settings:changed    pub/sub channel: JSON {revision, node_id}
 *   <prefix>:nonce:<nonce>       claimed manager-proof nonces (PX TTL)
 */

'use strict';

const crypto = require('crypto');

function ClusterSync(options) {
    options = options || {};

    this.prefix = options.prefix || options.channel_prefix || options.channelPrefix || 'tyo-mq:cluster';
    this.nodeId = options.node_id || options.nodeId || crypto.randomBytes(8).toString('hex');
    this.logger = options.logger || null;

    this.client = options.client || null;
    this.subscriber = options.subscriber || null;
    this.ownsClient = !this.client;

    if (!this.client) {
        var redis;
        try {
            redis = require('redis');
        }
        catch (err) {
            throw new Error('Cluster sync requires the redis package. Run npm install.');
        }
        var url = options.redis_url || options.redisUrl || options.url;
        if (!url)
            throw new Error('Cluster sync requires a redis url (cluster.redis_url or storage_options.url)');
        this.client = redis.createClient({url: url});
    }

    if (!this.subscriber) {
        if (typeof this.client.duplicate !== 'function')
            throw new Error('Cluster sync requires a subscriber client (client.duplicate is unavailable)');
        this.subscriber = this.client.duplicate();
    }
}

ClusterSync.prototype._settingsKey = function () {
    return this.prefix + ':settings';
};

ClusterSync.prototype._revisionKey = function () {
    return this.prefix + ':settings:rev';
};

ClusterSync.prototype._channel = function () {
    return this.prefix + ':settings:changed';
};

ClusterSync.prototype._nonceKey = function (nonce) {
    return this.prefix + ':nonce:' + nonce;
};

ClusterSync.prototype._connectClient = function (client) {
    if (client && typeof client.connect === 'function' && client.isOpen === false)
        return client.connect();
    return Promise.resolve();
};

ClusterSync.prototype.connect = function () {
    var self = this;
    return this._connectClient(this.client).then(function () {
        return self._connectClient(self.subscriber);
    }).then(function () {
        return self;
    });
};

/**
 * Persist the full settings document and announce the change to peers.
 * Returns the new revision number.
 */
ClusterSync.prototype.publishSettings = function (settings) {
    var self = this;
    var payload = JSON.stringify({
        settings: settings || {},
        node_id: this.nodeId,
        updated_at: new Date().toISOString()
    });

    return this.client.sendCommand(['SET', this._settingsKey(), payload]).then(function () {
        return self.client.sendCommand(['INCR', self._revisionKey()]);
    }).then(function (revision) {
        var message = JSON.stringify({revision: Number(revision), node_id: self.nodeId});
        return self.client.sendCommand(['PUBLISH', self._channel(), message]).then(function () {
            return Number(revision);
        });
    });
};

/**
 * Fetch the current settings document, or null when the cluster is empty.
 */
ClusterSync.prototype.fetchSettings = function () {
    return this.client.sendCommand(['GET', this._settingsKey()]).then(function (raw) {
        if (!raw)
            return null;
        try {
            return JSON.parse(raw);
        }
        catch (err) {
            return null;
        }
    });
};

/**
 * Invoke `callback(settings, revision)` whenever a peer publishes a change.
 * Changes published by this node are ignored.
 */
ClusterSync.prototype.onSettingsChange = function (callback) {
    var self = this;
    return this.subscriber.subscribe(this._channel(), function (raw) {
        var message;
        try {
            message = JSON.parse(raw);
        }
        catch (err) {
            return;
        }
        if (!message || message.node_id === self.nodeId)
            return;
        self.fetchSettings().then(function (doc) {
            if (doc && doc.settings)
                callback(doc.settings, message.revision);
        }).catch(function (err) {
            if (self.logger && self.logger.error)
                self.logger.error('Cluster settings fetch failed: ' + err.message);
        });
    });
};

/**
 * Claim a manager-proof nonce cluster-wide. Resolves true when this node is
 * the first to use it, false when any node has seen it before.
 */
ClusterSync.prototype.claimNonce = function (nonce, ttlMs) {
    return this.client.sendCommand([
        'SET', this._nonceKey(nonce), '1', 'NX', 'PX', String(ttlMs || 10 * 60 * 1000)
    ]).then(function (result) {
        return result === 'OK';
    });
};

ClusterSync.prototype.close = function () {
    var closing = [];
    if (this.subscriber && typeof this.subscriber.quit === 'function')
        closing.push(Promise.resolve(this.subscriber.quit()).catch(function () {}));
    if (this.client && typeof this.client.quit === 'function')
        closing.push(Promise.resolve(this.client.quit()).catch(function () {}));
    return Promise.all(closing);
};

module.exports = ClusterSync;
