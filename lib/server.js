/**
 * Messaging Server 
 */
'esversion: 6';

// info
var eventManager    = require('./events');

const Constants = require('./constants');

function Server(options) {
    this.options = options || {};

    var server = this;

    this.logger = console;
    this.logger.debug = this.logger.debug || console.log;

    var app = require('http').createServer((req, res) => {
        res.writeHead(403);
    });

    var io = require('socket.io')/* .listen */(app, options);
    // app.listen(this.options.port || Constants.DEFAULT_PORT);

    /**
     * 
     */
    var subscriptions = {};

    /**
     * 
     */
    var producers = {};

    /**
     * 
     */
    var consumers = {};

    /**
     * 
     * @param {*} eventStr 
     * @returns 
     */
    var getEventSubscriptions = function (eventStr) {
        subscriptions[eventStr] = subscriptions[eventStr] || {};
        return subscriptions[eventStr];
    };

    /**
     * 
     * @param {*} eventStr 
     * @param {*} consumer 
     * @returns 
     */
    var getEventSubscriber = function (eventStr, consumer) {
        consumer = consumer || Constants.ANONYMOUS;
        var subscriptions = getEventSubscriptions(eventStr);

        subscriptions[consumer] = subscriptions[consumer] || {subscribeTos: new Set()};
        return subscriptions[consumer];
    };

    /**
     * @todo
     * Each event may be unqiue, deal with later
     * 
     * @param {*} producer 
     */

    var getProducerMetaInfo = function (producer) {
        producer = producer || Constants.ANONYMOUS;
        producers[producer] = producers[producer] || {subscribers: new Set()};
        return producers[producer];
    };

    /**
     * 
     * @param {*} consumer 
     */

    var getConsumerMetaInfo = function (consumer) {
        consumer = consumer || Constants.ANONYMOUS;
        consumers[consumer] = consumers[consumer] || {name: consumer, subscribeTos: new Set()};
        return consumers[consumer];
    };

    /**
     * 
     * @param {*} consumer 
     */

    var deleteConsumerFromSubscriptions = function (consumer) {
        for (var event in subscriptions) {
            if (subscriptions[event][consumer])
                delete subscriptions[event][consumer];
        }
    };

    /**
     * Actually we don't need to delete the subscription if the consumer lost connection, do we? 
     */

    var deleteProducerFromSubscriptions = function (producer) {
        for (var event in subscriptions) {
            for (var consumer in subscriptions[event]) {
                var subscription = getEventSubscriber(event, consumer);

                subscription.subscribeTos.forEach(function (name) {
                    if (name == producer) {
                        delete subscriptions[event][consumer];

                        var size = 0;
                        for (var key in subscriptions[event])
                            ++size;

                        if (size === 0)
                            delete subscriptions[event];
                    }
                });
            }
        }
    };

    /**
     * 
     * @param {*} producer 
     */

    var getSubscribersByProducer = function (producer) {
        var ids = {};

        for (var key in subscriptions) {
            if (typeof subscriptions[key] === 'string') {
                var event = key;
                for (var consumer in subscriptions[event]) {
                    var subscription = getEventSubscriber(event, consumer);

                    if (subscription.subscribeTos)
                        subscription.subscribeTos.forEach(function (name) {
                            if (name === producer) {
                                if (!ids[subscription.id]) {
                                    ids[subscription.id] = {};
                                    ids[subscription.id].events = new Set();
                                    ids[subscription.id].name = subscription.name;
                                }
                            }
                        });
                }

                /**
                 * What is the purpose of this?
                 */
                for (var id in ids) {
                    ids[id].events = ids[id].events || new Set();
                    ids[id].events.add(event);
                }
            }
        }

        return ids;
    };

    /**
     * 
     * @param {*} p 
     */

    this.start = function (p) {
        var self = this;
        
        var port = p || this.options.port || Constants.DEFAULT_PORT;

        if (self.logger)
            self.logger.log('message server listening on localhost:' + port);

        this.create(io);

        // creating the message server
        app.listen(port);
        if (process.send && typeof process.send === 'function')
            process.send("Server started");
    };

     /**
      * Create the queue
      */

     this.create = function (io) {
        // 
        var self = this;

        // maintain a request table for whom is requesting what
        // 1 success, 

        // creating a new websocket then wait for connection
        io.sockets.on('connection', function(socket) {

            var setupConsumer = function (consumer, consumerId) {
                // unlike producer, consumer doesn't need to know the status of the producer
                var consumerMeta = getConsumerMetaInfo(consumer);
                consumerMeta.id = consumerId || consumerMeta.id;
                consumerMeta.socket = socket.id;
                consumerMeta.online = true;
            };

            var setupProducer = function (producer, producerId) {
                // unlike producer, producer doesn't need to know the status of the producer
                var producerMeta = getProducerMetaInfo(producer);
                producerMeta.id = producerId || producerMeta.id;
                producerMeta.socket = socket.id;
                producerMeta.online = true;
            };

            function sendErrorMessage (msg) {
                sendErrorMessageById(socket.id, msg);
            }

            function sendErrorMessageById (id, msg) {
                server.send(id, 'ERROR', msg);
            }
            
            /**
             *  system message all CAPS
             * 
             * @param {*} event 
             * @param {*} producer 
             * @param {*} consumer 
             * @param {*} consumerId 
             */
            function subscribeMessage (event, producer, consumer, consumerId) {
                var eventStr;

                server.logger.error("Consumer (name: " + consumer + ", id: " + socket.id + " subscribe: " + event + " from: " + producer);

                eventStr = eventManager.toEventString(event);

                // id is the message subscriber's id
                // id = socket.id;

                // regisiter consumer if it hasn't done so
                var consumerMeta = getConsumerMetaInfo(consumer);
                if (!consumerMeta.socket)
                    setupConsumer(consumer, consumerId);

                var subscription = getEventSubscriber(eventStr, consumer);
                // the subscription is neither confirmed or authorized
                subscription.id = consumerMeta.id;
                subscription.acked = false;
                subscription.name = consumer;

                var subscribeTos;
                
                subscribeTos = consumerMeta.subscribeTos || new Set();

                if (!(producer in subscribeTos)) {
                    subscribeTos.add(producer);
                    subscription.subscribeTos.add(producer);
                }
                
                var producerMeta;
                var status = true;
                if (producer !== Constants.ALL_PUBLISHERS) {
                    producerMeta = getProducerMetaInfo(producer);
                    sendSubscriptionMessageToProducer(eventStr, producerMeta, consumerMeta, status);
                }
                else {
                    for (var name in producers) {
                        if (name === consumer)
                            continue;

                        producerMeta = getProducerMetaInfo(name);
                        sendSubscriptionMessageToProducer(eventStr, producerMeta, consumerMeta, status);
                    }
                }
            }

            /**
             * 
             * @param {*} eventStr 
             * @param {*} producerMeta 
             * @param {*} consumerMeta 
             * @param {*} status 
             */
            function sendSubscriptionMessageToProducer(eventStr, producerMeta, consumerMeta, status) {
                var consumer = consumerMeta.name;

                if (producerMeta.online) {
                    if (!producerMeta.subscribers.has(consumer))
                        producerMeta.subscribers.add(consumer);

                    sendSubscriptionMessageWithConsumerInfo(producerMeta, [eventStr], consumerMeta, status);

                    var subscription = getEventSubscriber(eventStr, consumer);

                    subscription.acked = true;
                    subscription.subscribeToId = producerMeta.id;

                    // @todo
                    // send subscription confirmation / rejection here
                    
                }
            }
            
            // send subscription message
            function sendSubscriptionMessage(events, producerMeta, consumerMeta, status) {
                if (producerMeta && producerMeta.id)
                    sendSubscriptionMessageWithConsumerInfo(producerMeta, events,consumerMeta, status);
            }

            // it seems the new updates weren't pushed to the remote repo
            function sendSubscriptionMessageWithConsumerInfo(producerMeta, events, consumerMeta, status) {
                if (status === null)
                    status = true;

                var onSubscribeEvent = eventManager.toOnSubscribeEvent(producerMeta.id);

                sendMessage(producerMeta.socket, 
                    onSubscribeEvent, 
                    {
                        name:consumerMeta.name, 
                        id:consumerMeta.id, 
                        socket:consumerMeta.socket, 
                        events:events, online:status
                    },
                    consumerMeta.name
                    );
            }

            // subscribe message
            socket.on('SUBSCRIBE', function (event) {
                if (typeof event === "string") 
                    try {
                        event = JSON.parse(event);
                    }
                    catch (e) {
                        server.logger.error("unknown subscribe event: " + e);
                        return;
                    }
                if ((typeof event === 'object' && event.event)) {
                    var targetEvent;
                    var producer;
                    var consumer;
                    var id;
                    // if (event.event) {
                        targetEvent = event.event.toLowerCase();
                        producer = event.producer;
                        consumer = event.consumer;
                        id = event.id || socket.id;
                    // }
                    // else {
                    //     targetEvent = event;
                    //     id = socket.id;
                    // }

                    producer = producer || Constants.ANONYMOUS;
                    consumer = consumer || Constants.ANONYMOUS;

                    subscribeMessage(targetEvent, producer, consumer, id);

                    // can't do it in this scope, hasn't figured out why
                    // socket.on(event, function (data) {
                    //     self.logger.log('Received subscribed message: ' + event + ', data: ' + data);

                    //     for (var key in subscriptions[event]) {
                    //         if (subscriptions[event][key])
                    //             self.send(key, event, data);
                    //     }
                    // });
                }
                else {
                    var msg = "Message name should be a object";
                    if (server.logger) {
                        server.logger.error("Incorrect subcription message name: " + event);
                        server.logger.error(msg);
                    }
                    sendErrorMessage(msg);
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

            /**ƒ
             * 
             */

            socket.on('DEBUG', function (data) {
                if (server.logger)
                    server.logger.log('Received DEBUG message: ' + data);
            });

            /**
             * DISCONNECT from server
             */

             socket.on('QUIT', function (id) {
                if (id === socket.id)
                    socket.disconnect();
             });

            /**
             * Send the message for subscriber(s)' consumption
             * 
             * we need to send two sets of messages one for single event receiver and one for all-event receivers
             * 
             */

            function sendConsumeMessage (socketId, event, message, producer) {
                var eventStr = eventManager.toConsumeEvent(event);
                var msgObj = {event:event, message:message, from:producer};
                var eventAll = eventManager.toConsumeEventAll(producer);

                sendMessage(socketId, eventStr, msgObj, producer);
                sendVolatileMessage(socketId, eventAll, msgObj);
            }

            /**
             * we need to send two sets of messages one for single event receiver and one for all-event receivers
             * 
             * @param {*} event 
             * @param {*} message 
             * @param {*} producer 
             */

            function broadcastConsumeMessage (event, message, producer) {
                var eventStr = eventManager.toConsumeEvent(event);
                var msgObj = {event:event, message:message, from:producer};
                var eventAll = eventManager.toConsumeEventAll(producer);

                // setTimeout(function () {
                    broadcastVolatileMessage(eventAll, msgObj);
                //}, 400);

                broadcastMessage(eventStr, msgObj);
            }

            /**
             * Send socket message
             * 
             */

            function sendMessage (id, event, message, from) {
                if (!id) {
                    server.logger.error("Error: null socket");
                    server.logger.error("Event: " + event);
                    server.logger.error("Message: " + JSON.stringify(message));
                    if (from)
                        server.logger.error("From: " + JSON.stringify(from));
                    return;
                }
                server.logger.debug("sending message to " + id + ", event:" + event + ", message: " + JSON.stringify(message));
                server.send(id, event, message);
            }

            /**
             * Send socket volatile message
             * 
             */

             function sendVolatileMessage (id, event, message) {
                if (!id) {
                    server.logger.error("Error: null socket");
                    server.logger.error("Event: " + event);
                    server.logger.error("Message: " + JSON.stringify(message));
                    return;
                }
                server.logger.debug("sending volatile message to " + id + ", event:" + event + ", message: " + JSON.stringify(message));
                server.volatile(event, message, id);
            }

            /**
             * Send volatile message
             * 
             */

            function broadcastVolatileMessage (event, message) {
                server.logger.debug("broadcasting volatile message to everyone"  + ", event:" + event + ", message: " + JSON.stringify(message));
                server.volatile(event, message);
            }

            /**
             * 
             * @param {*} event 
             * @param {*} message 
             */

            function broadcastMessage (event, message) {
                server.logger.debug("broadcasting message to everyone"  + ", event:" + event + ", message: " + JSON.stringify(message));
                server.broadcast(event, message);
            }

            /**
             * 
             */

            function generateMessage (event, message, producer) {
                producer = producer || Constants.ANONYMOUS;

                var subscriptions = getEventSubscriptions(event);

                for (var consumer in subscriptions) {
                    var subcription = subscriptions[consumer];
                    var consumerMeta = getConsumerMetaInfo(subcription.name);

                    var ar = Array.from(consumerMeta.subscribeTos);
                    for (var i = 0; i < ar.length; ++i) {
                        var name = ar[i];
                        if (name === Constants.ALL_PUBLISHERS || name === producer) {
                            sendConsumeMessage(consumerMeta.socket, event, message, producer);
                            break;
                        }
                    }
                }
            }

            /**
             * Relay message from producer to consumer
             * the message has to an object containing event, message and producer name
             */

            socket.on('PRODUCE', function (msg) {
                let obj;
                if (typeof msg === "string")
                    try {
                        obj = JSON.parse(msg);
                    }
                    catch (e) {
                        server.logger.error("Error parsing message: " + msg);
                        return;
                    }
                else
                    obj = msg;
                    
                var producerName = obj.from;
                var event = eventManager.toEventString(obj.event, producerName);
                var message = obj.message;

                var producerMeta = getProducerMetaInfo(producerName, obj.id);

                if (!producerMeta.socket)
                    setupProducer(producerName, obj.id);

                if (obj.method && obj.method === 'broadcast')
                    broadcastConsumeMessage(event, message, producerName);
                else
                    generateMessage(event, message, producerName);
            });

            /**
             * On a consumer is ready
             */

            socket.on('CONSUMER', function (consumer) {
                if (typeof consumer === "string")
                    try {
                        consumer = JSON.parse(consumer);
                    }
                    catch (e) {
                        server.logger.error("Error parsing consumer: " + consumer);
                        return;
                    }
                    
                if (typeof consumer.name !== "string") {
                    server.logger.error("Received incorrect consumer information");
                    sendErrorMessage({message: "Incorrect consumer's name", code: -1});
                    return;
                }
        
                server.logger.error("A consumer (name: " + consumer.name + ", socket: " + socket.id + ") has joined.");

                setupConsumer(consumer.name, consumer.id || socket.id);
            });

            /**
             * On producer is ready
             */
            socket.on('PING', function (msg, callback) {
                console.log("received PING message: " + msg);
                if (callback)
                    callback("PONG");
            });

            socket.on('PRODUCER', function (msg) {
                let producer;
                if (typeof msg === "string") 
                    try {
                        producer = JSON.parse(msg);
                    }
                    catch (e) {
                        server.logger.error("Unknown producer: " + msg);
                        // server.logger.error(e.message)
                        return;
                    }
                else
                    producer = msg;

                if (typeof producer.name !== "string") {
                    server.logger.error("Received incorrect producer information");
                    sendErrorMessage({message: "Incorrect producer's name", code: -1});
                    return;
                }

                var producerName = producer.name;
                var producerId = producer.id || socket.id;

                server.logger.log("A producer (name: " + producer.name + ", socket: " + socket.id + ", id: " + producerId + ") has joined.");
                // var producerMeta = getProducerMetaInfo(producerName);

                /**
                 * @todo
                 * 
                 *  Already a producer with such a name exists
                 */
                // if (producerMeta) {
                //     // @todo
                //     socket.disconnect();
                //     return;
                // }

                var producerMeta = getProducerMetaInfo(producerName); // producers[producerName] = producers[producerName] || {subscribers: new Set()};
                var resendSubscriptionMessage = false;

                if (producerMeta.id && producerMeta.id !== producerId) {
                    sendErrorMessageById(producerMeta.id, "The same producer newly joined");

                    // try {
                    //     if (producerMeta.socket)
                    //         producerMeta.socket.disconnect();
                    // }
                    // catch (err) {
                    //     server.logger.error("Failed to disconnect previous joind producer: " + producerMeta.id);
                    // }

                    resendSubscriptionMessage = true;
                }

                setupProducer(producerName, producerId);

                // in case the consumer connect before producer is ready
                var ids = getSubscribersByProducer(producerName);

                for (var id in ids) {
                    var obj = ids[id];
                    var consumer = obj.name;
                    var events = [];

                    var consumerMeta = getConsumerMetaInfo(consumer);

                    if (!producerMeta.subscribers.has(consumer))
                        producerMeta.subscribers.add(consumer);
                    
                    for (var event in obj.events) {
                        var subscription = getEventSubscriber(event, consumer);

                        if (resendSubscriptionMessage || !subscription.acked) {
                            events.push(event);

                            subscription.acked = true;
                            subscription.subscribeToId = socket.id;
                        }
                    }

                    if (events.length > 0) {
                        // var producerMeta = getProducerMetaInfo(producer);
                        sendSubscriptionMessage(obj.events, producerMeta, consumerMeta, consumerMeta.online);
                    }
                }

            });

            /**
             * On HELLO
             */

            socket.on('HELLO', function (message) {
                server.logger.log("Received greetings from client who claims his/her name is " + message.name + " and a " + message.type);
            });

            /**
             * @todo
             * On Authentication
             */
            socket.on('AUTHENTICATION', function (message) {

            });

            /**
             * On Disconnect
             * 
             * Please be noted losing connection doesn't mean unscribe / stop producing
             * 
             * for unsubscribe / unpublish, see #UNSUBSCRIBE, #UNPUBLISH messages
             */

            socket.on('disconnect', function () {
                var event;
                var message = {event: 'DISCONNECT', socket: socket.id};
                
                // var id = socket.id;

                /**
                 * @todo
                 * 
                 * update the registration information
                 * 
                 */
                var isProducer = false;

                 // check if it is a producer
                for (var name in producers) {
                    var producerMeta = producers[name];
                    if (producerMeta.socket && producerMeta.socket === socket.id) {
                        isProducer = true;
                        producerMeta.online = false;

                        producerMeta.subscribers.forEach (function (consumerName) {
                            var consumerMeta = getConsumerMetaInfo(consumerName);

                            if (consumerMeta) {
                                // consumerMeta.subscribeTos.delete(name);
                                message.producer = name;
                                event = eventManager.toOnDisconnectEvent(consumerMeta.id);
                                server.logger.log("Triggering event: " + event);
                                server.logger.log("Lost connection to a producer (" + name + ")");
                                if (consumerMeta.socket)
                                    sendMessage(consumerMeta.socket, event, message, name);
                                else
                                    server.logger.debug("Trying to inform consumer that producer is offline but it seems the consumer is offline too");
                            }
                        });

                        producerMeta.socket = null;

                        // deleteProducerFromSubscriptions(name);
                        // no we are not gonna do it, as consumer still can wait for producer to come back online
                        // for whatever reasons it loses connection

                        // delete producers[name];

                        /**
                         * @todo
                         * 
                         * send disconn info to subscribers
                         */
                        break;
                    }
                }

                 // check if it is a consumer
                 // a producer could be also a consumer
                 //if (!isProducer) {
                     for (var consumerName in consumers) {
                        var consumerMeta = consumers[consumerName];
                        if (consumerMeta.socket && consumerMeta.socket === socket.id) {
                            server.logger.log("Lost connection to a consumer (" + consumerName + ")");

                            consumerMeta.online = false;

                            consumerMeta.subscribeTos.forEach( function (producerName) {
                                var producerMeta = getProducerMetaInfo(producerName);

                                if (producerMeta && producerMeta.socket) {
                                    message.consumer = consumerName;
                                    event = eventManager.toOnDisconnectEvent(producerMeta.id);
                                    server.logger.log("Triggering event: " + event);
                                    sendMessage(producerMeta.socket, event, message, consumerName);
                                    // producerMeta.subscribers.delete(consumerName);
                                }
                            }); 

                            consumerMeta.socket = null;
                            // deleteConsumerFromSubscriptions(consumerName);

                            // delete consumers[consumerName];
                            break;
                        }
                     }
                //  }
            });

        });

        /**
         * broadcast message to all connected sockets
         */

        this.broadcast = function (event, message) {
            io.emit(event, message);
        };

        /**
         * sending the volatile message to all connected sockets
         */

        this.volatile = function (event, message, id) {
            if (id) 
                io.to(id).volatile.emit(event, message);
            else
                io.volatile.emit(event, message);
        };

    
        /**
         * Send event / message to a particular endpoint
         */
    
        this.send = function (socketId, event, message) {
            io.to(socketId).emit(event, message);
        };


    };
}

module.exports = Server;