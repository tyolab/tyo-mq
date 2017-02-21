/**
 * @file subscriber.js
 */

const util        = require('util'),
      events      = require('./events');

var Socket = require('./socket');

/**
 * 
 */

function Subscriber () {
    Socket.call(this);
}

/**
 * Subscribe message
 */

Subscriber.prototype.subscribe = function (context, event, onConsumeCallback) {
    if (typeof context === 'string') {
        onConsumeCallback = event;
        event = context;
        context = null;
    }

    this.sendMessage('SUBSCRIBE', event);

    if (!this.consumes)
        this.consumes = {};

    this.consumes[event] = function (obj) {
        var intendedEvent = obj.event;
        var message = obj.message;

        if (intendedEvent === event) {
            onConsumeCallback(message);
        }
    };

    this.on(events.toConsumeEvent(event), (obj) => {
        if (context)
            this.consumes[event].call(context, obj);
        else
            this.consumes[event](obj);
    });
};



/**
 * Inherits from Socket
 */

util.inherits(Subscriber, Socket);

module.exports = Subscriber;