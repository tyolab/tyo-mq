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
    if (!onConsumeCallback) {
        onConsumeCallback = event;
        event = context;
        context = null;
    }

    var eventStr = events.toEventString(event);

    this.sendMessage('SUBSCRIBE', event);

    if (!this.consumes)
        this.consumes = {};

    this.consumes[eventStr] = function (obj) {
        var intendedEvent = obj.event;
        var message = obj.message;

        if (intendedEvent === eventStr) {
            onConsumeCallback(message);
        }
    };

    this.on(events.toConsumeEvent(eventStr), (obj) => {
        if (context)
            this.consumes[eventStr].call(context, obj);
        else
            this.consumes[eventStr](obj);
    });
};



/**
 * Inherits from Socket
 */

util.inherits(Subscriber, Socket);

module.exports = Subscriber;