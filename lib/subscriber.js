/**
 * @file subscriber.js
 */

const crypto      = require('crypto'),
      util        = require('util'),
      events      = require('./events'),
      Constants = require('./constants'),
      e2ee      = require('./e2ee');

var Socket = require('./socket');
const { constants } = require('buffer');

/**
 * 
 */

function Subscriber (name, options) {
    options = options || {};
    this.context = null;

    Socket.call(this);
    // When no name is supplied, mint a unique anonymous identity so two unnamed
    // producers/consumers never collide on the shared 'ANONYMOUS' name. The
    // ANONYMOUS- prefix keeps them recognisable to the server's realm policy.
    this.name = name || (Constants.ANONYMOUS + '-' + crypto.randomUUID());
    this.consumer_id = options.consumer_id || options.consumerId || this.name;

    var subscriber = this;

    /**
     * @override
     * 
     */

    this.sendIdentificationInfo = function () {
        this.sendMessage.call(subscriber, 'CONSUMER', {
            name: subscriber.name,
            id: subscriber.consumer_id,
            consumer_id: subscriber.consumer_id
        });
    }

    /**
     * Resend the subscription message after a connection is lost (particularily when server is gone) and reconnected
     */

    this.resubscribeWhenReconnect = function (context, who, event, onConsumeCallback, reSubscribe) {
        var self = this;
        var subscribeOptions = {};

        if (reSubscribe === null || reSubscribe === undefined)
            reSubscribe = true;

        if (typeof who === 'function' && event && typeof event === 'object' && !Array.isArray(event)) {
            subscribeOptions = event;
            onConsumeCallback = who;
            event = context;
            who = Constants.ALL_PUBLISHERS;
            context = self;
        }
        else if (typeof event === 'function') {
            var optionArg = onConsumeCallback;
            onConsumeCallback = event;
            event = who;
            who = context;
            context = self;

            if (optionArg && typeof optionArg === 'object')
                subscribeOptions = optionArg;
            else if (typeof optionArg === 'boolean')
                reSubscribe = optionArg;
        }
        else if (!onConsumeCallback) {
            onConsumeCallback = event;
            event = who;
            who = context;
            context = self;
        }
        else if (reSubscribe && typeof reSubscribe === 'object') {
            subscribeOptions = reSubscribe;
            reSubscribe = subscribeOptions.reconnect;
        }

        function resubscribeListener() {
            subscribeInternal();
        }

        function subscribeInternal() {   
            if ((typeof event) !== "string") {
                onConsumeCallback = event;
                event = null;
            }
    
            var eventStr;
            var scope;
            var scope_all = false;
            if (event)
                eventStr = events.toEventString(event);
            else {
                eventStr = constants.EVENT_ALL; // who + "-ALL";
                scope = Constants.SCOPE_ALL;
                scope_all = true;
            }
            /**
             * @todo
             * 
             * deal with the ALL events later
             */
    
            function sendSubscriptionMessage () {
                var ackEnabled = !!(subscribeOptions.ack
                    || subscribeOptions.require_ack
                    || subscribeOptions.requireAck
                    || subscribeOptions.manual_ack
                    || subscribeOptions.manualAck);

                self.sendMessage('SUBSCRIBE', {
                    event:eventStr,
                    producer: who,
                    consumer:self.name,
                    scope: scope,
                    durable: !!subscribeOptions.durable,
                    consumer_id: subscribeOptions.consumer_id || subscribeOptions.consumerId || self.consumer_id,
                    ack: ackEnabled,
                    manual_ack: !!(subscribeOptions.manual_ack || subscribeOptions.manualAck),
                    ack_timeout: subscribeOptions.ack_timeout || subscribeOptions.ackTimeout,
                    retry: subscribeOptions.retry || null,
                    mode: subscribeOptions.mode || null,
                    group: subscribeOptions.group || null
                });
            }
    
            // On Connect Message will be trigger by system
            sendSubscriptionMessage();
            // the connection should be ready before we subscribe the message
            // this.on('connect', function ()  {
            //     sendSubscritionMessage();
            // });
    
            if (!self.consumes)
                self.consumes = {};
    
            var consumerEventStr = events.toConsumerEvent(eventStr, who, scope_all);
            // var targetEventStr = events.toEventString(event, who).toLowerCase();
            self.consumes[consumerEventStr] = function (obj) {
                //var intendedEvent = obj.event;
    
                // if the message is encrypted, then it needs to be decrypted first
                var message = obj.message;
                if (obj.enc) {
                    if (!self.e2ee || !self.e2ee.resolver || typeof self.e2ee.resolver.privateKey !== 'function') {
                        if (self.logger && self.logger.warn)
                            self.logger.warn('E2EE: received an encrypted message but no key resolver is configured — dropping');
                        return;
                    }
                    try {
                        var priv = self.e2ee.resolver.privateKey(obj.enc.kid);
                        var pt = e2ee.open(priv, obj.enc, obj.event, obj.to, obj.from, obj.message);
                        message = JSON.parse(pt.toString('utf8'));
                    }
                    catch (err) {
                        if (self.logger && self.logger.warn)
                            self.logger.warn('E2EE: failed to decrypt message — dropping: ' + err.message);
                        return; // never hand ciphertext to the application handler
                    }
                }
    
                var from = obj.from || message.from;
                var msgId = obj.msgId || obj.msg_id;
                var manualAck = !!(subscribeOptions.manual_ack || subscribeOptions.manualAck);
                var acked = false;
                function ack(callback) {
                    if (!msgId || acked) {
                        if (callback)
                            callback();
                        return;
                    }
                    acked = true;
                    self.sendMessage('ACK', {msgId: msgId}, null, callback);
                }
    
                //if (intendedEvent === targetEventStr) {
                    var result = onConsumeCallback(message, from, ack, obj);
                    if (msgId && !manualAck) {
                        Promise.resolve(result).then(function () {
                            ack();
                        }).catch(function (err) {
                            if (self.logger && self.logger.warn)
                                self.logger.warn('Message handler rejected before ACK: ' + err.message);
                        });
                    }
                //}
            };
    
            var consumeEventStr = events.toConsumeEvent(consumerEventStr);

            // remove the old listener, we only need one listener for each event
            self.off(consumeEventStr);
            self.on(consumeEventStr, function (obj) {
                if (context)
                    self.consumes[consumerEventStr].call(context, obj);
                else
                    self.consumes[consumerEventStr](obj);
            });
        }

        subscribeInternal();

        if (reSubscribe)
            self.addConnectionListener(resubscribeListener);
     }

    /**
     * Subscribe message
     * 
     * If an event name is not provided, then we subscribe all the messages from the producer
     */

    this.subscribe = function (context, who, event, onConsumeCallback, reconnect) {
        this.resubscribeWhenReconnect(context, who, event, onConsumeCallback, reconnect);
    };

    /**
     * Subscribe only once, if the connection is gone, let it be
     */

    this.subscribeOnce = function (context, who, event, onConsumeCallback) {
        this.subscribe(context, who, event, onConsumeCallback, false);
    };

    /**
     * Subscribe all events with this name whatever providers are publishing
     */
    this.subscribeAll = function (context, event, onConsumeCallback) {
        this.subscribe(context, Constants.ALL_PUBLISHERS, event, onConsumeCallback);
    }

    this.unsubscribe = function (event, who) {
        var eventStr = events.toConsumerEvent(event, who);
        // this.sendMessage('UNSUBSCRIBE', {event:eventStr});
        this.off(eventStr);
    }

    this.unsubscribeAll = function () {
        this.socket.removeAllListeners();
    }

    /**
     * Remove only the consume-event handlers that this subscriber registered,
     * leaving the socket.io system handlers (connect / disconnect / CONSUME_CHUNK)
     * intact so reconnection and chunk reassembly keep working.
     */
    this.clearSubscriptions = function () {
        if (!subscriber.consumes) return;

        Object.keys(subscriber.consumes).forEach(function (consumerEventStr) {
            var consumeEventStr = events.toConsumeEvent(consumerEventStr);
            subscriber.off(consumeEventStr);
        });

        subscriber.consumes = {};
    };

    this.setOnProducerOnlineListener = function (producer, callback) {
        var eventStr = events.toEventString(producer, null, "ONLINE");
        this.on(eventStr, callback);
    }

    this.whenProducerOnline = this.setOnProducerOnline = this.setOnProducerOnlineListener;

    /**
     * E2EE public-key directory (E2EE.md) — discovery only, never a trust
     * anchor. Publishes this client's own public key under its own name (the
     * broker only accepts KEY_PUBLISH for a name this connection has already
     * registered as CONSUMER/PRODUCER).
     *
     * @param {{key_id, alg, public_key}} keyInfo
     */
    this.publishKey = function (keyInfo, callback) {
        var self = this;
        keyInfo = keyInfo || {};
        var payload = {
            identity: keyInfo.identity || self.name,
            key_id: keyInfo.key_id || keyInfo.kid,
            alg: keyInfo.alg,
            public_key: keyInfo.public_key || keyInfo.publicKey
        };

        function ack (response, cb) {
            if (!response || response.ok === false) {
                var err = new Error((response && response.message) || 'KEY_PUBLISH failed');
                if (cb) return cb(err);
                throw err;
            }
            if (cb) cb(null, response);
            return response;
        }

        if (!callback)
            return new Promise(function (resolve, reject) {
                self.socket.emit('KEY_PUBLISH', payload, function (response) {
                    if (!response || response.ok === false)
                        return reject(new Error((response && response.message) || 'KEY_PUBLISH failed'));
                    resolve(response);
                });
            });

        self.socket.emit('KEY_PUBLISH', payload, function (response) { ack(response, callback); });
    };

    /**
     * Look up a peer's published key(s) via the broker's discovery directory.
     * This is convenience/discovery only — the caller's own KeyResolver still
     * decides whether the returned key is trusted (see E2EE.md Trust model).
     *
     * @returns Promise<Array<{key_id, alg, public_key, updated_at}>> when no callback is given
     */
    this.lookupKey = function (identity, callback) {
        var self = this;
        var payload = {identity: identity};

        if (!callback)
            return new Promise(function (resolve) {
                self.socket.emit('KEY_LOOKUP', payload, function (response) {
                    resolve((response && response.keys) || []);
                });
            });

        self.socket.emit('KEY_LOOKUP', payload, function (response) {
            callback((response && response.keys) || []);
        });
    };

    /**
     * Signal prekey directory (secure-chat): publish/replenish this client's own
     * X3DH prekey bundle. `bundle` = {identity_key, signed_prekey,
     * signed_prekey_sig, registration_id, device_id, one_time_prekeys[]}. The
     * broker only accepts it for a name this connection has registered.
     *
     * @returns Promise<{ok, one_time_available}> when no callback is given
     */
    this.publishPrekeys = function (bundle, callback) {
        var self = this;
        var payload = Object.assign({identity: (bundle && bundle.identity) || self.name}, bundle);

        if (!callback)
            return new Promise(function (resolve, reject) {
                self.socket.emit('PREKEY_PUBLISH', payload, function (response) {
                    if (!response || response.ok === false)
                        return reject(new Error((response && response.message) || 'PREKEY_PUBLISH failed'));
                    resolve(response);
                });
            });

        self.socket.emit('PREKEY_PUBLISH', payload, function (response) {
            if (!response || response.ok === false)
                callback(new Error((response && response.message) || 'PREKEY_PUBLISH failed'));
            else
                callback(null, response);
        });
    };

    /**
     * Fetch a peer's prekey bundle to start an X3DH session, atomically
     * consuming one of their one-time prekeys. Resolves null when the peer has
     * published no bundle.
     *
     * @returns Promise<bundle|null> when no callback is given
     */
    this.takePrekeys = function (identity, callback) {
        var self = this;
        var payload = {identity: identity};

        if (!callback)
            return new Promise(function (resolve) {
                self.socket.emit('PREKEY_TAKE', payload, function (response) {
                    resolve(response && response.found ? response : null);
                });
            });

        self.socket.emit('PREKEY_TAKE', payload, function (response) {
            callback(response && response.found ? response : null);
        });
    };

    /**
     * Sealed-sender delivery (see sealed-sender broker plan): the broker
     * forwards a UAK-gated sealed blob to a subscribed recipient as a
     * SEALED_MESSAGE event. The transport stays crypto-agnostic — set
     * `subscriber.onSealedMessage = function (blob, msgId) {...}` to hand the
     * blob off to the E2EE core's handle_incoming_sealed. Wired inside
     * addConnectionListener (rather than eagerly here) because self.socket
     * doesn't exist yet until the underlying connection is established; the
     * off()-before-on() guards against listener stacking across reconnects
     * (self.socket persists and re-fires 'connect' on every reconnect — see
     * socket.js connectWith), mirroring the same guard resubscribeWhenReconnect
     * uses for its consume-event listeners above.
     */
    subscriber.addConnectionListener(function () {
        subscriber.socket.off('SEALED_MESSAGE');
        subscriber.socket.on('SEALED_MESSAGE', function (payload) {
            if (typeof subscriber.onSealedMessage === 'function')
                subscriber.onSealedMessage(payload.blob, payload.msg_id);
        });
    });

}

/**
 * Inherits from Socket
 */

util.inherits(Subscriber, Socket);

/**
 * Sealed-sender client wrappers (see sealed-sender broker plan). Placed on
 * the prototype (rather than as instance closures like publishKey/
 * publishPrekeys above) so both Subscriber and Publisher instances share
 * them without re-creating closures per instance; Publisher.call(this, name)
 * still runs the Subscriber constructor against the Publisher instance, so
 * either style works, but the prototype keeps these particular wrappers
 * stateless and shared.
 *
 * Mirrors the exact callback/Promise idiom of publishPrekeys/takePrekeys:
 * no callback -> return a Promise that resolves to the raw `response` on
 * response.ok !== false, rejects with an Error otherwise; callback given ->
 * err-first callback(err) / callback(null, response), matching publishKey /
 * publishPrekeys (not the callback(value)-only shape of lookupKey/
 * takePrekeys, since these commands report success/failure via `ok` rather
 * than a found/not-found lookup).
 */
Subscriber.prototype._sealedEmit = function (event, payload, callback) {
    var self = this;

    if (!callback)
        return new Promise(function (resolve, reject) {
            self.socket.emit(event, payload, function (response) {
                if (!response || response.ok === false)
                    return reject(new Error((response && response.message) || (event + ' failed')));
                resolve(response);
            });
        });

    self.socket.emit(event, payload, function (response) {
        if (!response || response.ok === false)
            callback(new Error((response && response.message) || (event + ' failed')));
        else
            callback(null, response);
    });
};

/**
 * Request a Signal sealed-sender certificate for an identity this
 * connection has already registered (CONSUMER/PRODUCER).
 *
 * @returns Promise<{ok, sender_cert, server_cert}> when no callback is given
 */
Subscriber.prototype.requestSenderCert = function (identity, identityKeyB64, deviceId, callback) {
    return this._sealedEmit('SEALED_CERT_REQUEST', {
        identity: identity,
        identity_key: identityKeyB64,
        device_id: deviceId || 1
    }, callback);
};

/**
 * Set (or clear) this identity's per-realm sealed-sender Unidentified
 * Access Key gate. `mode` is 'require-uak' (default) or 'unrestricted'.
 *
 * @returns Promise<{ok, mode}> when no callback is given
 */
Subscriber.prototype.setUak = function (identity, uakB64, mode, callback) {
    return this._sealedEmit('SEALED_UAK_SET', {
        identity: identity,
        uak: uakB64,
        mode: mode || 'require-uak'
    }, callback);
};

/**
 * Deliver an opaque sealed-sender blob to a recipient identity in a realm.
 * Delivered live via SEALED_MESSAGE if the recipient is online, otherwise
 * durably queued and drained via sealedSubscribe().
 *
 * @returns Promise<{ok, delivered}> when no callback is given
 */
Subscriber.prototype.sendSealed = function (toRealm, toIdentity, uakB64, blobB64, msgId, callback) {
    return this._sealedEmit('SEALED_DELIVER', {
        to: { realm: toRealm, identity: toIdentity },
        uak: uakB64,
        blob: blobB64,
        msg_id: msgId || ''
    }, callback);
};

/**
 * Drain any durably-queued sealed messages for an owned identity (queued by
 * sendSealed() while this identity was offline). Replayed entries arrive via
 * the SEALED_MESSAGE listener / onSealedMessage hook, not in the response.
 *
 * @returns Promise<{ok, replayed, more}> when no callback is given
 */
Subscriber.prototype.sealedSubscribe = function (identity, callback) {
    return this._sealedEmit('SEALED_SUBSCRIBE', { identity: identity }, callback);
};

module.exports = Subscriber;
