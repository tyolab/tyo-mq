var Socket = require('./lib/socket');

module.exports = function () {

    var app = require('http').createServer((req, res) => {
        res.writeHead(403);
    });

    var io = require('socket.io').listen(app);
    var self = this;

    // info
    var DEFAULT_PORT = 17352;
    var port;

    this.start = function (p) {
        port = p || DEFAULT_PORT;

        // creating the message server
        app.listen(port);

        console.log('message server listening on localhost:' + port);

        // maintain a request table for whom is requesting what
        // 1 success, 
            
        // creating a new websocket then wait for connection
        io.sockets.on('connection', function(socket) {
            
            // system message all CAPS

            // subscribe message
            socket.on('SUBSCRIBE', function (event) {
                if ((typeof event) === 'string') {
                    subscriptions[event] = subscriptions[event] || {};
                    subscriptions[event][socket.id] = true;

                    socket.on(event, function (data) {
                        for (var key in subscriptions[event]) {
                            var socketId = subscriptions[event][key];
                            self.send(socketId, event, data);
                        }
                    });
                }
                else {
                    var msg = "Message name should be a string";
                    console.error("Incorrect subcription message name: " + event);
                    console.error(msg);
                    self.send(socket.id, 'ERROR', msg);
                }
            });

            socket.on('UNSUBSCRIBE', function (data) {
                if (subscriptions[data] && subscriptions[data][socket.id]) {
                    delete subscriptions[data][socket.id];
                }
            });
        });

    }

    var subscriptions = {};

    this.subscribe = function (event, callback, onErrorCallback) {
        var mySocket = this.createSocket();

        mySocket.sendMessage('SUBSCRIBE', event);
        mySocket.on(event, callback);

        onErrorCallback = onErrorCallback || function (message) {
            console.error("Error message received: " + message);
        };
        mySocket.on('ERROR', onErrorCallback);

        return mySocket;
    };

    this.createSocket = function () {
        var mySocket = new Socket();
        mySocket.connect();
        return mySocket;
    };

    this.createProducer = function (event) {
        var producer = this.createSocket();
        producer.produce = function (data) {
            producer.sendMessage(event, data);
        };

        return producer;
    }

    this.broadcast = function (event, message) {
        io.volatile.emit(event, message);
    };

    this.send = function (socketId, event, message) {
        io.to(socketId).emit(event, message);
    };

}