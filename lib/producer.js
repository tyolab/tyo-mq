/**
 * @file producer.js
 */
const util = require('util');

var Subscriber = require('./subscriber');

function Producer () {

}
/**
 * Inherits from Socket
 */

util.inherits(Producer, Subscriber);

module.exports = Producer;