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
                    if (!subscriptions[event][socket.id]) {
                        subscriptions[event][socket.id] = true;
                    }

                    // can't do it in this scope, hasn't figured out why
                    // socket.on(event, function (data) {
                    //     console.log('Received subscribed message: ' + event + ', data: ' + data);

                    //     for (var key in subscriptions[event]) {
                    //         if (subscriptions[event][key])
                    //             self.send(key, event, data);
                    //     }
                    // });
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

            socket.on('DEBUG', function (data) {
                console.log('Received DEBUG message: ' + data);
            });

            socket.on('PRODUCE', function (obj) {
                var event = obj.event;
                var message = obj.message;

                for (var id in subscriptions[event]) {
                    if (subscriptions[event][id])
                        self.send(id, 'CONSUME', {event:event, message:message});
                }
            });

        });

    }

    var subscriptions = {};

    /**
     * Create the comminucation channel (e.g. socket)
     */

    this.createSocket = function (callback) {
        var mySocket = new Socket();

        if (callback) {
            mySocket.connect(() => {
                callback(mySocket)
            });
        }
        return mySocket;
    };

    /**
     * Create a consumer
     */

    this.createConsumer = function (callback, onErrorCallback) {
        this.createSocket((consumer) => {

            onErrorCallback = onErrorCallback || function (message) {
                console.error("Error message received: " + message);
            };
            consumer.on('ERROR', onErrorCallback);

            consumer.subscribe = function (event, onConsumeCallback) {
                consumer.sendMessage('SUBSCRIBE', event);
``
                consumer.consume = function (obj) {
                    var intendedEvent = obj.event;
                    var message = obj.message;

                    if (intendedEvent === event) {
                        onConsumeCallback(message);
                    }
                };

                consumer.on('CONSUME', consumer.consume);
            };

            callback(consumer);
        });
    }

    /**
     * Create a producer
     */

    this.createProducer = function (eventDefault, callback) {
        if (!callback) {
            callback = eventDefault;
            eventDefault = null;
        }
        this.createSocket((producer) => {
        
            producer.produce = function (event, data) {
                var self = this;

                if (!data) {
                    data = event;
                    event = eventDefault;

                    if (!event)
                        throw new Error('Default event name is not set.');
                }

                setTimeout(function() {
                    self.sendMessage.call(self, 'PRODUCE', {event:event, message:data});
                }, 10);
            };

            callback(producer);
        });
        //return producer;
    }

    this.broadcast = function (event, message) {
        io.volatile.emit(event, message);
    };

    /**
     * Send event / message to a particular endpoint
     */

    this.send = function (socketId, event, message) {
        io.to(socketId).emit(event, message);
    };

}