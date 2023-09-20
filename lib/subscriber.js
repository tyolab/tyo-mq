/**
 * @file subscriber.js
 */

const util        = require('util'),
      events      = require('./events'),
      Constants = require('./constants');

var Socket = require('./socket');

/**
 * 
 */

function Subscriber (name) {
    this.context = null;

    Socket.call(this);
    this.name = name || Constants.ANONYMOUS;

    var subscriber = this;

    /**
     * @override
     * 
     */

    this.sendIdentificationInfo = function () {
        this.sendMessage.call(subscriber, 'CONSUMER', {name: name});
    }

    /**
     * Resend the subscription message after a connection is lost (particularily when server is gone) and reconnected
     */

    this.resubscribeWhenReconnect = function (context, who, event, onConsumeCallback, reSubscribe) {
        var self = this;

        if (reSubscribe === null)
            reSubscribe = true;

        if (!onConsumeCallback) {
            onConsumeCallback = event;
            event = who;
            who = context;
            context = self;
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
            if (event)
                eventStr = events.toEventString(event, who);
            else
                eventStr = who + "-ALL";
            /**
             * @todo
             * 
             * deal with the ALL events later
             */
    
            function sendSubscritionMessage () {
                self.sendMessage('SUBSCRIBE', {event:eventStr, producer: who, consumer:self.name});
            }
    
            // On Connect Message will be trigger by system
            sendSubscritionMessage();
            // the connection should be ready before we subscribe the message
            // this.on('connect', function ()  {
            //     sendSubscritionMessage();
            // });
    
            if (!self.consumes)
                self.consumes = {};
    
            var consumerEventStr = events.toConsumerEvent(eventStr);
            var targetEventStr = eventStr.toLowerCase();
            self.consumes[consumerEventStr] = function (obj) {
                var intendedEvent = obj.event;
    
                // if the message is encrypted, then it needs to be decrypted first
                var message = obj.message;
    
                var from = obj.from || message.from;
    
                if (intendedEvent === targetEventStr) {
                    onConsumeCallback(message, from);
                }
            };
    
            var consumeEventStr = events.toConsumeEvent(consumerEventStr);
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

    this.subscribe = function (context, who, event, onConsumeCallback, reconcect) {
        this.resubscribeWhenReconnect(context, who, event, onConsumeCallback, reconcect);
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
        this.socket.off(eventStr);
    }

    this.unsubscribeAll = function () {
        this.socket.removeAllListeners();
    }

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