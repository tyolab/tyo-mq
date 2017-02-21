/**
 * @file subscriber.js
 */

const util = require('util');
var Socket = require('./socket');

/**
 * 
 */

function Subscriber () {

}

/**
 * Inherits from Socket
 */

util.inherits(Subscriber, Socket);

module.exports = Subscriber;