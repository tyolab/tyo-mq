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

function Producer (name) {
    // call prarent constructor
    Subscriber.call(this, name);

    var producer = this;
    this.eventDefault = Constants.EVENT_DEFAULT;

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
    this.subscribeToOnSubscriptionEvent = function (callback) {
        var event = events.toOnSubscribeEvent(this.getId());
        this.subscribe(event, function (data, from) {
            producer.subscribers[from.name] = from;

            // further listener
            if (producer.onSubscriptionListener)
                producer.onSubscriptionListener.call(producer, from);

            if (callback)
                callback(from);
        });
    }

    /**
     * On Lost connections with subscriber(s)
     */

    this.subscribeToOnSubscriberLostEvent = function (id, callback) {
        var event = {event: events.toOnDisconnectEvent(id), id: this.getId()};
        this.subscribe(event, callback);
    };

    this.onSubscriberLost = this.subscribeToOnSubscriberLostEvent;

    /**
     * On Unsubsribe
     */

    this.subscribeToOnUnsubscribedEvent = function (id, callback) {
        var event = {event: events.toOnUnsubscribeEvent(id), id: this.getId()};
        this.subscribe(event, callback);
    }

    this.onUnsubscribed = this.subscribeToOnUnsubscribedEvent;

    // Initialisation
    this.addConnectonListener(function () {
        producer.sendMessage.call(producer, 'PRODUCER', {name:producer.name});
    });
}

/**
 * Inherits from Socket
 */

util.inherits(Producer, Subscriber);

module.exports = Producer;