/**
 * @file subscriber.js
 */

const util        = require('util'),
      events      = require('./events'),
      Constants = require('./constants');

var Socket = require('./socket');
const { constants } = require('buffer');

/**
 * 
 */

function Subscriber (name, options) {
    options = options || {};
    this.context = null;

    Socket.call(this);
    this.name = name || Constants.ANONYMOUS;
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
                self.sendMessage('SUBSCRIBE', {
                    event:eventStr,
                    producer: who,
                    consumer:self.name,
                    scope: scope,
                    durable: !!subscribeOptions.durable,
                    consumer_id: subscribeOptions.consumer_id || subscribeOptions.consumerId || self.consumer_id
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
    
                var from = obj.from || message.from;
    
                //if (intendedEvent === targetEventStr) {
                    onConsumeCallback(message, from);
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

}

/**
 * Inherits from Socket
 */

util.inherits(Subscriber, Socket);

module.exports = Subscriber;
