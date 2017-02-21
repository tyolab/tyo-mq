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

Events.prototype.toOnDisconnectFromProducerEvent = function (id) {
    return 'DISCONNECT-' + id;
}

/**
 * 
 */

Events.prototype.toOnUnsubscribeEvent =function  (event) {
    return 'UNSUBSCRIBE-' + event.toUpperCase();
}

var events = events || new Events();
module.exports = events;