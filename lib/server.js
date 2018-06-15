/**
 * Messaging Server 
 */

// info
const DEFAULT_PORT = 17352;

function Server() {
    this.logger = console;

    var app = require('http').createServer((req, res) => {
        res.writeHead(403);
    });

    var io = require('socket.io').listen(app);

    this.start = function (p) {
        var self = this;
        
        var port = p || DEFAULT_PORT;

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

            function sendErrorMessage (msg) {
                sendErrorMessageById(socket.id, msg);
            }

            function sendErrorMessageById (id, msg) {
                mq.send(id, 'ERROR', msg);
            }
            
            // system message all CAPS
            function subscribeMessage (event, producer, consumer) {
                var eventStr, id;

                mq.logger.error("Consumer (name: " + consumer + ", id: " + socket.id + " subscribe: " + event + " from: " + producer);

                eventStr = eventManager.toEventString(event);

                // id is the message subscriber's id
                id = socket.id;

                var subscription = getEventSubscriber(eventStr, consumer);
                // the subscription is neither confirmed or authorized
                subscription.id = id;
                subscription.acked = false;
                subscription.name = consumer;
                subscription.subscribeTo = producer;

                // regisiter consumer if it hasn't done so
                var consumerMeta = getConsumerMetaInfo(consumer);
                var subcribeTos;
                // if (!consumerMeta) {
                //     consumers[consumer] = {id: id, subscribeTos: new Set()};
                // }
                
                subcribeTos = consumerMeta.subscribeTos;

                if (!subcribeTos.has(producer)) {
                    subcribeTos.add(producer);
                }

                sendSubscriptionMessageByName(eventStr, producer, consumer, id, true);
            }

            // 
            function sendSubscriptionMessageByName(eventStr, producer, consumer, consumerId, status) {
                // check if producer is registered
                var producerMeta;
                
                if (producer !== Constants.ALL_PUBLISHERS) {
                    producerMeta = getProducerMetaInfo(producer);
                    sendSubscriptionMessageToProducer(eventStr, producerMeta, consumer, consumerId, status);
                }
                else {
                    for (var name in producers) {
                        producerMeta = getProducerMetaInfo(name);
                        sendSubscriptionMessageToProducer(eventStr, producerMeta, consumer, consumerId, status);
                    }
                }
            }

            // 
            function sendSubscriptionMessageToProducer(eventStr, producerMeta, consumer, consumerId, status) {
                if (producerMeta.online) {
                    if (!producerMeta.subscribers.has(consumer))
                        producerMeta.subscribers.add(consumer);

                    sendSubscriptionMessageWithConsumerInfo(producerMeta.id, [eventStr], producerMeta.name, consumer, consumerId, status);

                    var subscription = getEventSubscriber(eventStr, consumer);

                    subscription.acked = true;
                    subscription.subscribeToId = producerMeta.id;

                    // @todo
                    // send subscription confirmation / rejection here
                    
                }
            }
            
            // send subscrition message
            function sendSubscriptionMessage(events, producer, consumer, consumerId, status) {
                var producerMeta = getProducerMetaInfo(producer);

                if (producerMeta && producerMeta.id)
                    sendSubscriptionMessageWithConsumerInfo(producerMeta.id, events, producer, consumer, consumerId, status);
            }

            // it seems the new updates weren't pushed to the remote repo
            function sendSubscriptionMessageWithConsumerInfo(id, events, producer, consumer, consumerId, status) {
                if (status === null)
                    status = true;

                var onSubscribeEvent = eventManager.toOnSubscribeEvent(id);

                sendMessage(id, onSubscribeEvent, {name:consumer, id:consumerId, events:events, online:status});
            }

            // subscribe message
            socket.on('SUBSCRIBE', function (event) {
                if ((typeof event === 'object' && event.event) || (typeof event) === 'string') {
                    var targetEvent;
                    var producer;
                    var consumer;
                    if (event.event) {
                        targetEvent = event.event;
                        producer = event.producer;
                        consumer = event.consumer;
                    }
                    else {
                        targetEvent = event;
                    }

                    producer = producer || Constants.ANONYMOUS;
                    consumer = consumer || Constants.ANONYMOUS;

                    subscribeMessage(targetEvent, producer, consumer);

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
                    if (mq.logger) {
                        mq.logger.error("Incorrect subcription message name: " + event);
                        mq.logger.error(msg);
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
                if (mq.logger)
                    mq.logger.log('Received DEBUG message: ' + data);
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

            function sendConsumeMessage (id, event, message, producer) {
                sendMessage(id, eventManager.toConsumeEvent(event), {event:event, message:message, from:producer});
            }

            /**
             * Send socket message
             */

            function sendMessage (id, event, message) {
                mq.send(id, event, message);
            }

            /**
             * 
             */

            function generateMessage (event, message, producer) {
                producer = producer || Constants.ANONYMOUS;

                var subscriptions = getEventSubscriptions(event);

                for (var consumer in subscriptions) {
                    var subcription = subscriptions[consumer];

                    if (subcription.subscribeTo === producer)
                    // for (var id in subscription) {
                    //     if (subscription[id]) {
                            sendConsumeMessage(subcription.id, event, message, producer);
                        // }
                    // }
                }
            };

            /**
             * Relay message from producer to consumer
             */

            socket.on('PRODUCE', function (obj) {
                var event = obj.event;
                var message = obj.message;
                var producerName = obj.from;

                generateMessage(event, message, producerName);
            });

            /**
             * On a consumer is ready
             */

            socket.on('CONSUMER', function (consumer) {
                if (typeof consumer.name !== "string") {
                    mq.logger.error("Received incorrect consumer information");
                    sendErrorMessage({message: "Incorrect consumer's name", code: -1});
                    return;
                }

                mq.logger.error("A consumer (name: " + consumer.name + ", id: " + socket.id + ") has joined.");

                // unlike producer, consumer doesn't need to know the status of the producer
                var consumerMeta = getConsumerMetaInfo(consumer.name);
                consumerMeta.id = socket.id;
                consumerMeta.socket = socket;
                consumerMeta.online = true;
            });

            /**
             * On producer is ready
             */
            socket.on('PRODUCER', function (producer) {
                if (typeof producer.name !== "string") {
                    mq.logger.error("Received incorrect producer information");
                    sendErrorMessage({message: "Incorrect producer's name", code: -1});
                    return;
                }

                mq.logger.log("A producer (name: " + producer.name + ", id: " + socket.id + ") has joined.");

                var producerName = producer.name;
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

                if (producerMeta.id && producerMeta.id !== socket.id) {
                    sendErrorMessageById(producerMeta.id, "The same producer newly joined");

                    try {
                        if (producerMeta.socket)
                            producerMeta.socket.disconnect();
                    }
                    catch (err) {
                        mq.logger.error("Failed to disconnect previous joind producer: " + producerMeta.id);
                    }

                    resendSubscriptionMessage = true;
                }

                producerMeta.id = socket.id;
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

                    if (events.length > 0)
                        sendSubscriptionMessage(obj.events, producerName, consumer, id, consumerMeta.online);
                }

            });

            /**
             * On HELLO
             */

            socket.on('HELLO', function (message) {
                mq.logger.log("Received greetings from client who claims his/her name is " + message.name + " and a " + message.type);
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
                var message = {event: 'DISCONNECT', id: socket.id};
                
                var id = socket.id;

                /**
                 * @todo
                 * 
                 * update the registration information
                 * 
                 */
                var isProducer = false;
                var event = eventManager.toOnDisconnectEvent(id);

                 // check if it is a producer
                for (var name in producers) {
                    var producerMeta = producers[name];
                    if (producerMeta.id === id) {
                        isProducer = true;
                        producerMeta.online = false;

                        producerMeta.subscribers.forEach (function (consumerName) {
                            var consumerMeta = getConsumerMetaInfo(consumerName);

                            if (consumerMeta) {
                                // consumerMeta.subcribeTos.delete(name);
                                message.producer = name;
                                event = eventManager.toOnDisconnectEvent(consumerMeta.id);
                                mq.logger.log("Triggering event: " + event);
                                mq.logger.log("Lost connection to a producer (" + name + ")");
                                sendMessage(consumerMeta.id, event, message);
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
                        if (consumerMeta.id === id) {
                            mq.logger.log("Lost connection to a consumer (" + consumerName + ")");

                            consumerMeta.online = false;

                            consumerMeta.subscribeTos.forEach( function (producerName) {
                                var producerMeta = getProducerMetaInfo(producerName);

                                if (producerMeta) {
                                    message.consumer = consumerName;
                                    event = eventManager.toOnDisconnectEvent(producerMeta.id);
                                    mq.logger.log("Triggering event: " + event);
                                    sendMessage(producerMeta.id, event, message);
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