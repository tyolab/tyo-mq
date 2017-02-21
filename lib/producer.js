/**
 * @file producer.js
 */
const util      = require('util'),
      events    = require('./events');;

var Subscriber  = require('./subscriber');

function Producer () {
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
        event = eventDefault;

        if (!event)
            throw new Error('Default event name is not set.');
    }

    //setTimeout(function() {
        self.sendMessage.call(self, 'PRODUCE', {event:event, message:data});
    //}, 10);
};

/**
 * 
 */

Producer.prototype.onSubscriberLost = function (id) {
    var event = 
    this.subscribe();
};

module.exports = Producer;