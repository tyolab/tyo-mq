/**
 * Messaging Server 
 */

var MessageQueue = require("./message-queue");

// info
const DEFAULT_PORT = 17352;

function Server() {
    this.logger = console;

    var app = require('http').createServer((req, res) => {
        res.writeHead(403);
    });

    var io = require('socket.io').listen(app);

    var mq = new MessageQueue(io);

    this.start = function (p) {
        var self = this;
        
        var port = p || DEFAULT_PORT;

        if (self.logger)
            self.logger.log('message server listening on localhost:' + port);

        mq.create();

        // creating the message server
        app.listen(port);
        if (process.send && typeof process.send === 'function')
            process.send("Server started");
    }
}

module.exports = Server;