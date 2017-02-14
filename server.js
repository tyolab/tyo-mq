/**
 * Messaging Server 
 */

var MessageServer = require("./");

var mq = new MessageServer();
mq.start();

if (process.send && typeof process.send === 'function')
    process.send("Server started");