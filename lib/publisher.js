/**
 * @file producer.js
 */
const util      = require('util'),
      events    = require('./events'),
      Constants = require('./constants');

var Subscriber  = require('./subscriber');

function SubscriberInfo (name) {
    this.name = name;
}

function Publisher (name, event) {
    // call parent constructor
    Subscriber.call(this, name);

    var producer = this;
    this.eventDefault = event || Constants.EVENT_DEFAULT;

    this.subscribers = {};
    this.onSubscriptionListener = null;


    /**
     * @override
     * 
     */

    this.sendIdentificationInfo = function () {
        this.sendMessage.call(producer, 'PRODUCER', {name: name});
    };

    /**
     * Event produce function
     * @param event
     * @param data
     * @param validFor, the valid time (lifespan of the message)
     */

    this.produce = function (event, data, validFor, to) {
        var self = this;

        if (!data) {
            data = event;
            event = this.eventDefault;

            if (!event)
                throw new Error('Default event name is not set.');
        }

        /**
         * @todo
         * 1) make an encryption option
         * 2) Encrypt the message when a cryto algorithm is negotiated 
         */
        var message =  {event:event, message:data, from:self.name, lifespan: validFor || -1};

        // Maybe we could delay a bit
        self.sendMessage.call(self, 'PRODUCE', message, self.name);
    };

    /**
     * On Subscribe
     */
    this.setOnSubscriptionListener = function (callback) {
        var event = events.toOnSubscribeEvent(this.getId());
        this.on(event, function (data) {
            producer.logger.log("Received subscription information: " + JSON.stringify(data));

            producer.subscribers[data.id] = data;

            // further listener
            if (producer.onSubscriptionListener)
                producer.onSubscriptionListener.call(producer, data);

            if (callback)
                callback(data);
        });
    };

    this.onSubscribed = this.setOnSubscriptionListener;

    /**
     * On Lost connections with subscriber(s)
     */

    this.setOnSubscriberLostListener = function (callback) {
        var event = events.toOnDisconnectEvent(this.getId());
        this.off(event); // clear all previous listeners
        this.on(event, function(data) {
            producer.logger.log("Lost subscriber's connection");
            if (callback)
                callback(data);
        });
    };

    this.onSubscriberLost = this.setOnSubscriberLostListener;

    /**
     * On Unsubsribe
     */

    this.setOnUnsubscribedListener = function (callback) {
        var event = events.toOnUnsubscribeEvent(this.getId());
        this.on(event, function() {
            if (callback)
                callback();
        });
    };

    this.onUnsubscribed = this.setOnUnsubscribedListener;

    // Initialisation
    this.addConnectionListener(function () {
        var producerName = producer.name || Constants.ANONYMOUS;
        // producer.sendMessage.call(producer, 'PRODUCER', {name: producerName});
        producer.setOnSubscriptionListener();
    });

    this.setOnSubscriberLostListener = function (callback) {
        var event = events.toOnDisconnectEvent(this.getId());
        this.on(event, function(data) {
            producer.logger.log("Lost subscriber's connection");
            if (callback)
                callback(data);
        });
    };
    this.setOnSubscriberLost = this.setOnSubscriberLostListener;

    this.setOnSubscriberOnlineListener = function (callback) {
        var event = events.toOnConnectEvent(this.getId());
        this.on(event, function(data) {
            producer.logger.log("Subscriber is online");
            if (callback)
                callback(data);
        });
    }

    this.whenSubscriberOnline = this.setOnSubscriberOnline = this.setOnSubscriberOnlineListener;
}

/**
 * Inherits from Socket
 */

util.inherits(Publisher, Subscriber);

module.exports = Publisher;