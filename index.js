var Socket = require('./lib/socket');

module.exports = function () {
    // Server: require('./lib/server'),
    // Client: require('./lib/client'),

    var app = require('http').createServer(handler);
    var io = require('socket.io').listen(app);
    var self = this;

    var start = function (port) {
        // creating the message server
        app.listen(port);

        console.log('message server listening on localhost:' + port);

        // maintain a request table for whom is requesting what
        // 1 success, 
            
        // creating a new websocket then wait for connection
        io.sockets.on('connection', function(socket) {
                    // system message all CAPS
            socket.on('SUBSCRIBE', function (data) {
                if ((typeof data) === 'string') {
                    subscriptions[data] = subscriptions[data] || {};
                    subscriptions[data][socket.id] = true;
                }
                else {
                    console.error("Incorrect subcription message: " + data);
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

    var subscribe = function (event) {

    };

    var broadcast = function (event, message) {
        io.volatile.emit(event, message);
    };

    var send = function (socketId, event, message) {
        io.to(socketId).emit(event, message);
    };

}