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
     * Chunk size threshold: messages serialised above this byte length are split
     * into multiple PRODUCE_CHUNK frames instead of one PRODUCE frame, keeping
     * each frame safely under the engine.io maxHttpBufferSize limit.
     */
    Publisher.CHUNK_SIZE = Publisher.CHUNK_SIZE || 256 * 1024; // 256 KB

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

        var message = {event:event, message:data, from:self.name, lifespan: validFor || -1};
        var str = JSON.stringify(message);
        var chunkSize = Publisher.CHUNK_SIZE;

        if (str.length <= chunkSize) {
            self.sendMessage.call(self, 'PRODUCE', message, self.name);
            return;
        }

        // Large message — split into chunks
        var total = Math.ceil(str.length / chunkSize);
        var transferId = Date.now().toString(36) + '-' + Math.random().toString(36).slice(2);

        for (var i = 0; i < total; i++) {
            self.sendMessage.call(self, 'PRODUCE_CHUNK', {
                transferId: transferId,
                index:      i,
                total:      total,
                data:       str.slice(i * chunkSize, (i + 1) * chunkSize)
            }, self.name);
        }
    };

    /**
     * On Subscribe
     */
    this.setOnSubscriptionListener = function (callback) {
        var event = events.toOnSubscribeEvent(this.getId());
        this.off(event); // clear all previous listeners
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

    // this.setOnSubscriberLostListener = function (callback) {
    //     var event = events.toOnDisconnectEvent(this.getId());
    //     this.on(event, function(data) {
    //         producer.logger.log("Lost subscriber's connection");
    //         if (callback)
    //             callback(data);
    //     });
    // };
    // this.setOnSubscriberLost = this.setOnSubscriberLostListener;

    this.setOnSubscriberOnlineListener = function (callback) {
        var event = events.toOnConnectEvent(this.getId());
        this.off(event); // clear all previous listeners
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