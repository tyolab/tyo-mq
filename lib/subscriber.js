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
    this.context = null;

    Socket.call(this);


    /**
     * Subscribe message
     */

    this.subscribe = function (context, event, onConsumeCallback) {
        var self = this;

        if (!onConsumeCallback) {
            onConsumeCallback = event;
            event = context;
            context = null;
        }

        var eventStr = events.toEventString(event);

        function sendSubscritionMessage () {
            self.sendMessage('SUBSCRIBE', event);
        }

        // On Connect Message will be trigger by system
        sendSubscritionMessage();
        // the connection should be ready before we subscribe the message
        // this.on('connect', function ()  {
        //     sendSubscritionMessage();
        // });

        if (!self.consumes)
            self.consumes = {};

        var consumeEventStr = events.toConsumeEvent(eventStr);
        self.consumes[consumeEventStr] = function (obj) {
            var intendedEvent = obj.event;

            // if the message is encrypted, then it needs to be decrypted first
            var message = obj.message;

            var from = obj.from || message.from;

            if (intendedEvent === eventStr) {
                onConsumeCallback(message, from);
            }
        };

        self.on(consumeEventStr, function (obj) {
            if (context)
                self.consumes[consumeEventStr].call(context, obj);
            else
                self.consumes[consumeEventStr](obj);
        });
    };
}

/**
 * Inherits from Socket
 */

util.inherits(Subscriber, Socket);

module.exports = Subscriber;