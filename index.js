var Socket          = require('./lib/socket'),
    Subscriber      = require('./lib/subscriber'),
    Producer        = require('./lib/producer'),
    eventManager    = require('./lib/events');

module.exports = function (p) {
    /**
     * for log
     */
    this.logger = console;

    var app = require('http').createServer((req, res) => {
        res.writeHead(403);
    });

    var io = require('socket.io').listen(app);
    var self = this;

    // info
    var DEFAULT_PORT = 17352;
    var port = p;

    /**
     * Start the message queue server with specific port
     */

    this.start = function (p) {
        var self = this;

        port = p || port || DEFAULT_PORT;

        // creating the message server
        app.listen(port);

        if (self.logger)
            self.logger.log('message server listening on localhost:' + port);

        // maintain a request table for whom is requesting what
        // 1 success, 
        
        
        // creating a new websocket then wait for connection
        io.sockets.on('connection', function(socket) {
            
            // system message all CAPS
            function subscribeMessage (event, id) {
                subscriptions[event] = subscriptions[event] || {};
                if (!subscriptions[event][socket.id]) {
                    subscriptions[event][socket.id] = true;
                }
            }

            // subscribe message
            socket.on('SUBSCRIBE', function (event) {
                if ((typeof event) === 'string') {
                    subscribeMessage (event);

                    // can't do it in this scope, hasn't figured out why
                    // socket.on(event, function (data) {
                    //     logger.log('Received subscribed message: ' + event + ', data: ' + data);

                    //     for (var key in subscriptions[event]) {
                    //         if (subscriptions[event][key])
                    //             self.send(key, event, data);
                    //     }
                    // });
                }
                else {
                    var msg = "Message name should be a string";
                    if (self.logger) {
                        self.logger.error("Incorrect subcription message name: " + event);
                        self.logger.error(msg);
                    }
                    self.send(socket.id, 'ERROR', msg);
                }
            });

            /**
             * 
             */
            socket.on('UNSUBSCRIBE', function (data) {
                if (subscriptions[data] && subscriptions[data][socket.id]) {
                    delete subscriptions[data][socket.id];
                }
            });

            /**
             * 
             */

            socket.on('DEBUG', function (data) {
                if (self.logger)
                    self.logger.log('Received DEBUG message: ' + data);
            });

            /**
             * 
             */

            function generateMessage (event, message) {
                for (var id in subscriptions[event]) {
                    if (subscriptions[event][id]) {
                        self.send(id, eventManager.toConsumeEvent(event), {event:event, message:message});
                    }
                }
            };

            /**
             * 
             */

            socket.on('PRODUCE', function (obj) {
                var event = obj.event;
                var message = obj.message;

                generateMessage(event, message);
            });

            /**
             * 
             */

            socket.on('disconnect', function () {
                var event = eventManager.toOnDisconnectFromProducerEvent(socket.id);
                var id = self.producerid || socket
            });
        });

    }

    var subscriptions = {};

    /**
     * Create the comminucation channel (e.g. socket)
     */

    this.createSocket = function (callback, p, host, protocol, args) {
        var mySocket = new Socket();
        if (this.logger) 
            mySocket.logger = this.logger;

        if (callback) {
            mySocket.connect(() => {
                callback(mySocket)
            },
            p || port,
            host,
            protocol,
            args
            );
        }
        return mySocket;
    };

    /**
     * private function
     */

    this.createConsumerPrivate = function (context, callback, port, host, protocol, args, onErrorCallback) {
        var consumer = new Subscriber();
        if (context && context.logger)
            consumer.logger = context.logger;

        if (callback) {
            consumer.connect(() => {
                onErrorCallback = onErrorCallback || function (message) {
                    if (self.logger)
                        self.logger.error("Error message received: " + message);
                };

                consumer.on('ERROR', onErrorCallback);

                callback(consumer);
            },
            p || port,
            host,
            protocol,
            args
            );
        }
        return consumer;
    }

    /**
     * Create a consumer
     */

    this.createConsumer = function (context, callback, port, host, protocol, args, onErrorCallback) {
        var self = this;
        if (context && typeof context === 'function') {
            onErrorCallback = args;
            args = protocol;
            protocol = host;
            host = port;
            port = callbak;
            callback = context;
            context = this;
        }

        if (!callback) {
            return new Promise((resolve, reject) => {
                try {
                self.createConsumerPrivate.call(
                    self,
                    context, 
                    (consumer) => {
                        resolve(consumer);
                    }, 
                    port, host, protocol, args,
                    onErrorCallback);
                }
                catch (err) {
                    reject(err);
                }
            });
        }
        else
            self.createConsumerPrivate(context, callback, port, host, protocol, args, onErrorCallback);
    }

    /**
     * Alias of createConsumer
     */

    this.createSubscriber = this.createConsumer;

    /**
     * private function
     */
     
     this.createProducerPrivate = function (context, eventDefault, callback, port, host, protocol, args) {
        if (!callback && typeof eventDefault === 'function') {
            args = protocol;
            protocol = host;
            host = port;
            port = callbak;
            callback = eventDefault;
            eventDefault = null;
        }

        var producer = new Producer();
        if (context && context.logger)
            producer.logger = context.logger;

        if (callback)
            return producer.connect(() => {
                callback(producer);
            },
            p || port,
            host,
            protocol,
            args
            );

        return producer;
     }

    /**
     * Create a producer
     */

    this.createProducer = function (eventDefault, callback, port, host, protocol, args) {
        var self = this;
        if (!callback) {
            return new Promise((resolve, reject) => {
                try {
                    self.createProducerPrivate.call(
                        self,
                        self,
                        eventDefault, 
                        (producer) => {
                            resolve(producer);
                        });
                }
                catch (err) {
                    reject(err);
                }
            });
        }
        else
            self.createProducerPrivate(self, eventDefault, callback);
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