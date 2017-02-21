/**
 * @file events.js
 */

function Events () {

}

/**
 * To Consume Event
 */

Events.prototype.toConsumeEvent = function (event) {
    /**
     * COSUMER EVENT = "CONSUME" + CAP(event)
     */
    var capEvent = event.toUpperCase();
    return 'CONSUME-' + capEvent;
}

/**
 * 
 */

Events.prototype.toOnDisconnectFromProducerEvent = function (producerId) {

}

/**
 * 
 */

Events.prototype.toOnUnsubscribeEvent =function  (event) {

}

var events = events || new Events();
module.exports = events;