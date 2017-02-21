/**
 * @file producer.js
 */
const util = require('util');

var Subscriber = require('./subscriber');

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

module.exports = Producer;