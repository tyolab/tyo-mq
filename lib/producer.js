/**
 * @file producer.js
 */
const util      = require('util'),
      events    = require('./events');;

var Subscriber  = require('./subscriber');

function SubscriberInfo (name) {
    this.name = name;
}

function Producer (event) {
    // call prarent constructor
    Subscriber.call(this);

    var producer = this;
    this.eventDefault = event;

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
        var event = {event: events.toOnDisconnectFromProducerEvent(id), id: this.getId()};
        this.subscribe(event, callback);
    };

    /**
     * On Unsubsribe
     */

    this.subscribeToOnUnsubscribedEvent = function (id, callback) {
        var event = {event: events.toOnUnsubscribeEvent(id), id: this.getId()};
        this.subscribe(event, callback);
    }

    // Initialisation
    this.addConnectonListener(function () {
        producer.sendMessage.call(self, 'PRODUCER', {name:self.name});
    });
}

/**
 * Inherits from Socket
 */

util.inherits(Producer, Subscriber);

module.exports = Producer;