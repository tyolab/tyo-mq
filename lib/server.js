/**
 * Messaging Server 
 */
'esversion: 6';

// info
var eventManager    = require('./events');

const Constants = require('./constants');

function Server() {
    var server = this;

    this.logger = console;
    this.logger.debug = this.logger.debug || console.log;

    var app = require('http').createServer((req, res) => {
        res.writeHead(403);
    });

    var io = require('socket.io').listen(app);

    var subscriptions = {};
    var producers = {};
    var consumers = {};

    var getEventSubscriptions = function (eventStr) {
        subscriptions[eventStr] = subscriptions[eventStr] || {};
        return subscriptions[eventStr];
    };

    var getEventSubscriber = function (eventStr, consumer) {
        consumer = consumer || Constants.ANONYMOUS;
        var subscriptions = getEventSubscriptions(eventStr);

        subscriptions[consumer] = subscriptions[consumer] || {};
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

                if (subscription.subscribeTo == producer) {
                    delete subscriptions[event][consumer];

                    var size = 0;
                    for (var key in subscriptions[event])
                        ++size;

                    if (size === 0)
                        delete subscriptions[event];
                }
            }
        }
    };

    /**
     * 
     * @param {*} producer 
     */

    var getSubscribersByProducer = function (producer) {
        var ids = {};

        for (var event in subscriptions) {
            for (var consumer in subscriptions[event]) {
                var subscription = getEventSubscriber(event, consumer);

                // already sent the subscription message to producer
                // if (subscription.acked)
                //     continue;

                if (subscription.subscribeTo === producer) {
                    if (!ids[subscription.id]) {
                        ids[subscription.id] = {};
                        ids[subscription.id].events = [];
                        ids[subscription.id].name = subscription.name;
                    }
                }
            }

            for (var id in ids)
                ids[id].events.push(event);
        }

        return ids;
    };

    /**
     * 
     * @param {*} p 
     */

    this.start = function (p) {
        var self = this;
        
        var port = p || Constants.DEFAULT_PORT;

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
                consumerMeta.id = consumerMeta.id || consumerId || socket.id;
                consumerMeta.socket = socket;
                consumerMeta.online = true;
            };

            function sendErrorMessage (msg) {
                sendErrorMessageById(socket.id, msg);
            }

            function sendErrorMessageById (id, msg) {
                server.send(id, 'ERROR', msg);
            }
            
            // system message all CAPS
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
                subscription.subscribeTo = producer;

                var subcribeTos;
                // if (!consumerMeta) {
                //     consumers[consumer] = {id: id, subscribeTos: new Set()};
                // }
                
                subcribeTos = consumerMeta.subscribeTos;

                if (!subcribeTos.has(producer)) {
                    subcribeTos.add(producer);
                }

                sendSubscriptionMessageByName(eventStr, producer, consumerMeta, true);
            }

            // 
            function sendSubscriptionMessageByName(eventStr, producer, consumerMeta, status) {
                // check if producer is registered
                var producerMeta;
                
                if (producer !== Constants.ALL_PUBLISHERS) {
                    producerMeta = getProducerMetaInfo(producer);
                    sendSubscriptionMessageToProducer(eventStr, producerMeta, consumerMeta, status);
                }
                else {
                    for (var name in producers) {
                        producerMeta = getProducerMetaInfo(name);
                        sendSubscriptionMessageToProducer(eventStr, producerMeta, consumerMeta, status);
                    }
                }
            }

            // 
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
            
            // send subscrition message
            function sendSubscriptionMessage(events, producerMeta, consumerMeta, status) {
                //

                if (producerMeta && producerMeta.id)
                    sendSubscriptionMessageWithConsumerInfo(producerMeta, events,consumerMeta, status);
            }

            // it seems the new updates weren't pushed to the remote repo
            function sendSubscriptionMessageWithConsumerInfo(producerMeta, events, consumerMeta, status) {
                if (status === null)
                    status = true;

                var onSubscribeEvent = eventManager.toOnSubscribeEvent(producerMeta.id);

                sendMessage(producerMeta.socket.id, onSubscribeEvent, {name:consumerMeta.name, id:consumerMeta.id, socket:consumerMeta.socket.id, events:events, online:status});
            }

            // subscribe message
            socket.on('SUBSCRIBE', function (event) {
                if ((typeof event === 'object' && event.event) || (typeof event) === 'string') {
                    var targetEvent;
                    var producer;
                    var consumer;
                    var id;
                    if (event.event) {
                        targetEvent = event.event;
                        producer = event.producer;
                        consumer = event.consumer;
                        id = event.id || socket.id;
                    }
                    else {
                        targetEvent = event;
                        id = socket.id;
                    }

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
             * Send the message for subcriber's consumption
             */

            function sendConsumeMessage (socketId, event, message, producer) {
                sendMessage(socketId, eventManager.toConsumeEvent(event), {event:event, message:message, from:producer});
            }

            function broadcastConsumeMessage (event, message, producer) {
                broadcastMessage(eventManager.toConsumeEvent(event), {event:event, message:message, from:producer});
            }

            /**
             * Send socket message
             * 
             */

            function sendMessage (id, event, message) {
                server.logger.debug("sending message to " + id + ", event:" + event + ", message: " + JSON.stringify(message));
                server.send(id, event, message);
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
                    if (subcription.subscribeTo === producer)
                    // for (var id in subscription) {
                    //     if (subscription[id]) {
                            sendConsumeMessage(consumerMeta.socket.id, event, message, producer);
                        // }
                    // }
                }
            }

            /**
             * Relay message from producer to consumer
             */

            socket.on('PRODUCE', function (obj) {
                var event = obj.event;
                var message = obj.message;
                var producerName = obj.from;

                if (obj.method && obj.method === 'broadcast')
                    broadcastConsumeMessage(event, message);
                else
                    generateMessage(event, message, producerName);
            });

            /**
             * On a consumer is ready
             */

            socket.on('CONSUMER', function (consumer) {
                if (typeof consumer.name !== "string") {
                    server.logger.error("Received incorrect consumer information");
                    sendErrorMessage({message: "Incorrect consumer's name", code: -1});
                    return;
                }
        
                server.logger.error("A consumer (name: " + consumer.name + ", id: " + socket.id + ") has joined.");

                setupConsumer(consumer.name);
            });

            /**
             * On producer is ready
             */

            socket.on('PRODUCER', function (producer) {
                if (typeof producer.name !== "string") {
                    server.logger.error("Received incorrect producer information");
                    sendErrorMessage({message: "Incorrect producer's name", code: -1});
                    return;
                }

                server.logger.log("A producer (name: " + producer.name + ", id: " + socket.id + ") has joined.");

                var producerName = producer.name;
                var producerId = producer.id || socket.id;
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

                    try {
                        if (producerMeta.socket)
                            producerMeta.socket.disconnect();
                    }
                    catch (err) {
                        server.logger.error("Failed to disconnect previous joind producer: " + producerMeta.id);
                    }

                    resendSubscriptionMessage = true;
                }

                producerMeta.id = producerId;
                producerMeta.name = producerName;
                producerMeta.online = true;
                producerMeta.socket = socket;

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
                    if (producerMeta.socket.id === socket.id) {
                        isProducer = true;
                        producerMeta.online = false;

                        producerMeta.subscribers.forEach (function (consumerName) {
                            var consumerMeta = getConsumerMetaInfo(consumerName);

                            if (consumerMeta) {
                                // consumerMeta.subcribeTos.delete(name);
                                message.producer = name;
                                event = eventManager.toOnDisconnectEvent(consumerMeta.id);
                                server.logger.log("Triggering event: " + event);
                                server.logger.log("Lost connection to a producer (" + name + ")");
                                sendMessage(consumerMeta.socket.id, event, message);
                            }
                        });

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
                 if (!isProducer) {
                     var consumerId;
                     for (var consumerName in consumers) {
                        var consumerMeta = consumers[consumerName];
                        if (consumerMeta.socket.id === socket.id) {
                            server.logger.log("Lost connection to a consumer (" + consumerName + ")");

                            consumerMeta.online = false;

                            consumerMeta.subscribeTos.forEach( function (producerName) {
                                var producerMeta = getProducerMetaInfo(producerName);

                                if (producerMeta) {
                                    message.consumer = consumerName;
                                    event = eventManager.toOnDisconnectEvent(producerMeta.id);
                                    server.logger.log("Triggering event: " + event);
                                    sendMessage(producerMeta.socket.id, event, message);
                                    // producerMeta.subscribers.delete(consumerName);
                                }
                            }); 

                            // deleteConsumerFromSubscriptions(consumerName);

                            // delete consumers[consumerName];
                            break;
                        }
                     }
                 }
            });

        });

        /**
         * broadcast message to all connected sockets
         */

        this.broadcast = function (event, message) {
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