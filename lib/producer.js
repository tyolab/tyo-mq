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

function Producer (name, event) {
    // call prarent constructor
    Subscriber.call(this, name);

    var producer = this;
    this.eventDefault = event || Constants.EVENT_DEFAULT;

    this.subscribers = {};
    this.onSubscriptionListener = null;

    /**
     * Event produce function
     */

    this.produce = function (event, data) {
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
        var message =  {event:event, message:data, from:self.name};

        // Maybe we could delay a bit
        self.sendMessage.call(self, 'PRODUCE', message);
    };

    /**
     * On Subscribe
     */
    this.setOnSubscriptionListener = function (callback) {
        var event = events.toOnSubscribeEvent(this.getId());
        this.on(event, function (data) {
            console.log("Received subscription information: " + JSON.stringify(data));

            producer.subscribers[data.id] = data;

            // further listener
            if (producer.onSubscriptionListener)
                producer.onSubscriptionListener.call(producer, data);

            if (callback)
                callback(from);
        });
    }

    /**
     * On Lost connections with subscriber(s)
     */

    this.setOnSubscriberLostListener = function (id, callback) {
        var event = {event: events.toOnDisconnectEvent(id), id: this.getId()};
        this.on(event, function() {
            if (callback)
                callback();
        });
    };

    this.onSubscriberLost = this.setOnSubscriberLostListener;

    /**
     * On Unsubsribe
     */

    this.setOnUnsubscribedListener = function (id, callback) {
        var event = {event: events.toOnUnsubscribeEvent(id), id: this.getId()};
        this.subscribe(event, function() {
            if (callback)
                callback();
        });
    }

    this.onUnsubscribed = this.setOnUnsubscribedListener;

    // Initialisation
    this.addConnectonListener(function () {
        var producerName = producer.name || Constants.ANONYMOUS;
        producer.sendMessage.call(producer, 'PRODUCER', {name: producerName});
        producer.setOnSubscriptionListener();
    });
}

/**
 * Inherits from Socket
 */

util.inherits(Producer, Subscriber);

module.exports = Producer;