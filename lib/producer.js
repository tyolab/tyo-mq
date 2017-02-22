/**
 * @file producer.js
 */
const util      = require('util'),
      events    = require('./events');;

var Subscriber  = require('./subscriber');

function Producer (event) {
    this.eventDefault = event;
    Subscriber.call(this);
}

/**
 * Inherits from Socket
 */

util.inherits(Producer, Subscriber);

/**
 * Event produce function
 */

Producer.prototype.produce = function (event, data) {
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

Producer.prototype.onSubscriberLost = function (id, callback) {
    var event = {event: events.toOnDisconnectFromProducerEvent(id), id: this.getId()};
    this.subscribe(event, callback);
};

/**
 * On Unsubsribe
 */

Producer.prototype.onUnsubscribed = function (id, callback) {
    var event = {event: events.toOnUnsubscribeEvent(id), id: this.getId()};
    this.subscribe(event, callback);
}

module.exports = Producer;