var Socket = require('./lib/socket');

function toConsumeEvent (event) {
    /**
     * COSUMER EVENT = "CONSUME" + CAP(event)
     */
    var capEvent = event.toUpperCase();
    return 'CONSUME-' + capEvent;
}

function toOnDisconnectFromProducerEvent (producerId) {

}

function toOnUnsubscribeEvent (event) {

}

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

        self.logger.log('message server listening on localhost:' + port);

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
                    //     logger.log('Received subscribed message: ' + event + ', data: ' + data);

                    //     for (var key in subscriptions[event]) {
                    //         if (subscriptions[event][key])
                    //             self.send(key, event, data);
                    //     }
                    // });
                }
                else {
                    var msg = "Message name should be a string";
                    self.logger.error("Incorrect subcription message name: " + event);
                    self.logger.error(msg);
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
                self.logger.log('Received DEBUG message: ' + data);
            });

            /**
             * 
             */
            socket.on('PRODUCE', function (obj) {
                var event = obj.event;
                var message = obj.message;

                for (var id in subscriptions[event]) {
                    if (subscriptions[event][id]) {
                        self.send(id, toConsumeEvent(event), {event:event, message:message});
                    }
                }
            });

            socket.on('disconnect', function () {

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

        this.createSocket((consumer) => {
            onErrorCallback = onErrorCallback || function (message) {
                self.logger.error("Error message received: " + message);
            };

            consumer.on('ERROR', onErrorCallback);

            consumer.subscribe = function (event, onConsumeCallback) {
                consumer.sendMessage('SUBSCRIBE', event);

                if (!consumer.consumes)
                    consumer.consumes = {};

                consumer.consumes[event] = function (obj) {
                    var intendedEvent = obj.event;
                    var message = obj.message;

                    if (intendedEvent === event) {
                        onConsumeCallback(message);
                    }
                };

                consumer.on(toConsumeEvent(event), (obj) => {
                    if (context)
                        consumer.consumes[event].call(context, obj);
                    else
                    consumer.consumes[event](obj);
                });
            };

            callback(consumer);
        });
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
            context = null;
        }

        if (!callback) {
            return new Promise((resolve, reject) => {
                self.createConsumerPrivate.call(
                    self,
                    context, 
                    (consumer) => {
                        resolve(consumer);
                    }, 
                    port, host, protocol, args,
                    onErrorCallback);
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
     
     this.createProducerPrivate = function (eventDefault, callback, port, host, protocol, args) {
        if (!callback) {
            if (!(typeof eventDefault === 'function'))
                throw new Error('A valid callback function must be provided for creating a message producer');

            args = protocol;
            protocol = host;
            host = port;
            port = callbak;
            callback = eventDefault;
            eventDefault = null;
        }
        this.createSocket((producer) => { 


            /**
             * Event produce function
             */

            producer.produce = function (event, data) {
                var self = this;

                if (!data) {
                    data = event;
                    event = eventDefault;

                    if (!event)
                        throw new Error('Default event name is not set.');
                }

                //setTimeout(function() {
                    self.sendMessage.call(self, 'PRODUCE', {event:event, message:data});
                //}, 10);
            };

            /**
             * create an on subcriber lost listener
             */
             producer.su

            callback(producer);
        }
        , port, host, protocol, args
        );
     }

    /**
     * Create a producer
     */

    this.createProducer = function (eventDefault, callback, port, host, protocol, args) {
        var self = this;
        if (!callback) {
            return new Promise((resolve, reject) => {
                self.createProducerPrivate.call(
                    self,
                    eventDefault, 
                    (producer) => {
                        resolve(producer);
                    });
            });
        }
        else
            self.createProducerPrivate(eventDefault, callback);
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