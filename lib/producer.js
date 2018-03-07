/**
 * @file producer.js
 */
const util      = require('util'),
      events    = require('./events');;

var Subscriber  = require('./subscriber');

function Producer (event) {
    this.eventDefault = event;
    Subscriber.call(this);

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

        //setTimeout(function() {
            self.sendMessage.call(self, 'PRODUCE', {event:event, message:data});
        //}, 10);
    };

    /**
     * On Lost connections with subscriber(s)
     */

    this.onSubscriberLost = function (id, callback) {
        var event = {event: events.toOnDisconnectFromProducerEvent(id), id: this.getId()};
        this.subscribe(event, callback);
    };

    /**
     * On Unsubsribe
     */

    this.onUnsubscribed = function (id, callback) {
        var event = {event: events.toOnUnsubscribeEvent(id), id: this.getId()};
        this.subscribe(event, callback);
    }
}

/**
 * Inherits from Socket
 */

util.inherits(Producer, Subscriber);

module.exports = Producer;