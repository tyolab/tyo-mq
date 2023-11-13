/**
 * @file events.js
 */

const constants = require( "./constants");

function Events () {

}

/**
 * Normailise event string
 */

Events.prototype.toEventString = function (event, prefix, suffix) {
    var eventStr;
    if (typeof event === 'string') {
        eventStr = event;
    }
    else if (typeof event === 'object' && event.event) {
        eventStr = event.event;
    }
    else 
        throw new Error ('Unknown event object: should be a string or object with event string');
    return (prefix ? (prefix + '-') : '') + eventStr + (suffix ? ('-' + suffix) : '');
};

/**
 * This is different to the cosume event
 * this is the event name that the consumer socker will listen to
 */

Events.prototype.toConsumerEvent = function (event, producer, scope_all) {
    if (scope_all)
        this.toEventString(event, producer.toLowerCase());
    return this.toEventString(event, producer).toLowerCase();
}

/**
 * To Consume Event
 */

Events.prototype.toConsumeEvent = function (event) {
    /**
     * COSUMER EVENT = "CONSUME" + Lower(event)
     * System event or defined Event are all capitalized
     */
    //var capEvent = event.toUpperCase();
    return this.toEventString(event, 'CONSUME');
};

/**
 * 
 */

Events.prototype.toOnDisconnectEvent = function (id) {
    return 'DISCONNECT-' + id;
};

/**
 * 
 */

Events.prototype.toOnUnsubscribeEvent =function  (event, id) {
    // var eventStr = this.toEventString(event);
    // return 'UNSUBSCRIBE-' + eventStr + '-' + id;
    return this.toEventString(event, 'UNSUBSCRIBE', id);
};

/**
 * 
 */
Events.prototype.toOnSubscribeEvent = function (id) {
    return 'SUBSCRIBE-TO' + ((id) ? "-" + id : "");
};

Events.prototype.toConsumeEventAll = function (producer) {
    // return 'CONSUME-' + producer + "-ALL";
    return this.toEventString('CONSUME', this.toConsumerEventAll(producer));
};

Events.prototype.toConsumerEventAll = function (producer) {
    // return 'producer + "-ALL";
    return this.toEventString(producer.toLowerCase(), null, constants.EVENT_ALL);
};

var events = events || new Events();
module.exports = events;