/**
 * @file events.js
 */

function Events () {

}

/**
 * Normailise event string
 */

Events.prototype.toEventString = function (event) {
    var eventStr;
    if (typeof event === 'string') {
        eventStr = event;
    }
    else if (typeof event === 'object' && event.event) {
        eventStr = event.event;
    }
    else 
        throw new Error ('Unknown event object: should be a string or object with event string');
    return eventStr;
}

/**
 * To Consume Event
 */

Events.prototype.toConsumeEvent = function (event) {
    /**
     * COSUMER EVENT = "CONSUME" + CAP(event)
     */
    //var capEvent = event.toUpperCase();
    var eventStr = this.toEventString(event);
    return 'CONSUME-' + eventStr;
}

/**
 * 
 */

Events.prototype.toOnDisconnectFromProducerEvent = function (id) {
    return 'DISCONNECT-' + id; // 'DISCONNECT'; //
}

/**
 * 
 */

Events.prototype.toOnUnsubscribeEvent =function  (id) {
    return 'UNSUBSCRIBE-' + id;
}

var events = events || new Events();
module.exports = events;