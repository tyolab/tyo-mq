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
};

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
    var eventStr = this.toEventString(event);
    return 'UNSUBSCRIBE-' + eventStr + '-' + id;
};

/**
 * 
 */
Events.prototype.toOnSubscribeEvent = function (id) {
    return 'SUBSCRIBE-TO' + ((id) ? "-" + id : "");
};

var events = events || new Events();
module.exports = events;