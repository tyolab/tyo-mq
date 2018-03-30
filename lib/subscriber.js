/**
 * @file subscriber.js
 */

const util        = require('util'),
      events      = require('./events'),
      Constants = require('./constants');

var Socket = require('./socket');

/**
 * 
 */

function Subscriber (name) {
    this.context = null;

    Socket.call(this);
    this.name = name || Constants.ANONYMOUS;

    var subscriber = this;

    /**
     * @override
     * 
     */

    this.sendIdentificationInfo = function () {
        this.sendMessage.call(subscriber, 'CONSUMER', {name: name});
    }

    /**
     * Subscribe message
     * 
     * If an event name is not provided, then we subscribe all the messages from the producer
     */

    this.subscribe = function (context, who, event, onConsumeCallback) {
        var self = this;

        if (!onConsumeCallback) {
            onConsumeCallback = event;
            event = who;
            who = context;
            context = self;
        }

        if ((typeof event) !== "string") {
            onConsumeCallback = event;
            event = null;
        }

        var eventStr;
        if (event)
            eventStr = events.toEventString(event);
        else
            eventStr = who + "-ALL";
        /**
         * @todo
         * 
         * deal with the ALL events later
         */

        function sendSubscritionMessage () {
            self.sendMessage('SUBSCRIBE', {event:eventStr, producer:who, consumer:self.name});
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