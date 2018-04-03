var Socket          = require('./socket'),
    Subscriber      = require('./subscriber'),
    Producer        = require('./publisher'),
    eventManager    = require('./events');

const Constants = require('./constants');

function MessageQueue (io) {
    /**
     * for log
     */
    this.logger = console;
    this.port = null;
    this.host = null;

    var mq = this;

    var subscriptions = {};
    var producers = {};
    var consumers = {};

    var getEventSubscriptions = function (eventStr) {
        subscriptions[eventStr] = subscriptions[eventStr] || {};
        return subscriptions[eventStr];
    }

    var getEventSubscriber = function (eventStr, consumer) {
        consumer = consumer || Constants.ANONYMOUS;
        var subscriptions = getEventSubscriptions(eventStr);

        subscriptions[consumer] = subscriptions[consumer] || {};
        return subscriptions[consumer];
    }

    /**
     * @todo
     * Each event may be unqiue, deal with later
     * 
     * @param {*} producer 
     */

    var getProducerMetaInfo = function (producer) {
        producer = producer || Constants.ANONYMOUS;
        producers[producer] = producers[producer] || {subscribers: new Set()}
        return producers[producer];
    }

    /**
     * 
     * @param {*} consumer 
     */

    var getConsumerMetaInfo = function (consumer) {
        consumer = consumer || Constants.ANONYMOUS;
        consumers[consumer] = consumers[consumer] || {subscribeTos: new Set()};
        return consumers[consumer];
    }

    var deleteConsumerFromSubscriptions = function (consumer) {
        for (var event in subscriptions) {
            if (subscriptions[event][consumer])
                delete subscriptions[event][consumer];
        }
    }

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
    }

    var getSubscribersByProducer = function (producer) {
        var ids = {};

        for (var event in subscriptions) {
            for (var consumer in subscriptions[event]) {
                var subscription = getEventSubscriber(event, consumer);

                // already sent the subscription message to producer
                if (subscription.acked)
                    continue;

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
    }

     /**
      * Create the queue
      */

    this.create = function () {
        // 
        var self = this;

        // maintain a request table for whom is requesting what
        // 1 success, 

        // creating a new websocket then wait for connection
        io.sockets.on('connection', function(socket) {

            function sendErrorMessage (msg) {
                mq.send(socket.id, 'ERROR', msg);
            }
            
            // system message all CAPS
            function subscribeMessage (event, producer, consumer) {
                var eventStr, id;

                console.error("Consumer (name: " + consumer + ", id: " + socket.id + " subscribe: " + event + " from: " + producer);

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

                sendSubscriptionMessageByName(eventStr, producer, consumer, id);
            }

            // 
            function sendSubscriptionMessageByName(eventStr, producer, consumer, consumerId) {
                // check if producer is registered
                var producerMeta;
                
                if (producer !== 'TYO-MQ-ALL') {
                    producerMeta = getProducerMetaInfo(producer);
                    sendSubscriptionMessageToProducer(eventStr, producerMeta, consumer, consumerId);
                }
                else {
                    for (var name in producers) {
                        producerMeta = getProducerMetaInfo(name);
                        sendSubscriptionMessageToProducer(eventStr, producerMeta, consumer, consumerId);
                    }
                }
            }

            // 
            function sendSubscriptionMessageToProducer(eventStr, producerMeta, consumer, consumerId) {
                if (producerMeta.online) {
                    if (!producerMeta.subscribers.has(consumer))
                        producerMeta.subscribers.add(consumer);

                    sendSubscriptionMessageWithConsumerInfo(producerMeta.id, [eventStr], producerMeta.name, consumer, consumerId);

                    var subscription = getEventSubscriber(eventStr, consumer);

                    subscription.acked = true;
                    subscription.subscribeToId = producerMeta.id;

                    // @todo
                    // send subscription confirmation / rejection here
                    
                }
            }
            
            // send subscrition message
            function sendSubscriptionMessage(events, producer, consumer, consumerId) {
                var producerMeta = getProducerMetaInfo(producer);

                if (producerMeta && producerMeta.id)
                    sendSubscriptionMessageWithConsumerInfo(producerMeta.id, events, producer, consumer, consumerId);
            }

            // it seems the new updates weren't pushed to the remote repo
            function sendSubscriptionMessageWithConsumerInfo(id, events, producer, consumer, consumerId) {
                var onSubscribeEvent = eventManager.toOnSubscribeEvent(id);
                sendMessage(id, onSubscribeEvent, {name:consumer, id:consumerId, events:events});
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
                    //     logger.log('Received subscribed message: ' + event + ', data: ' + data);

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
                    console.error("Received incorrect consumer information");
                    sendErrorMessage({message: "Incorrect consumer's name", code: -1});
                    return;
                }

                console.error("A consumer (name: " + consumer.name + ", id: " + socket.id + ") has joined.");

                // unlike producer, consumer doesn't need to know the status of the producer
                var consumerMeta = getConsumerMetaInfo(consumer.name);
                consumerMeta.id = socket.id;
            });

            /**
             * On producer is ready
             */
            socket.on('PRODUCER', function (producer) {
                if (typeof producer.name !== "string") {
                    console.error("Received incorrect producer information");
                    sendErrorMessage({message: "Incorrect producer's name", code: -1});
                    return;
                }

                console.log("A producer (name: " + producer.name + ", id: " + socket.id + ") has joined.");

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
                producerMeta.id = socket.id;
                producerMeta.name = producerName;
                producerMeta.online = true;

                // in case the consumer connect before producer is ready
                var ids = getSubscribersByProducer(producerName);
                for (var obj in ids) {
                    var consumer = obj.name;
                    var id = obj.id;

                    if (!producerMeta.subscribers.has(consumer))
                        producerMeta.subscribers.add(consumer);
                    
                    sendSubscriptionMessage(obj.events, producerName, consumer, id);

                    for (var event in obj.events) {
                        var subscription = getEventSubscriber(event, consumer);
                        subscription.acked = true;
                        subscription.subscribeToId = socket.id;
                    }
                }
            });

            /**
             * On HELLO
             */

            socket.on('HELLO', function (message) {
                console.log("Received greetings from client who claims his/her name is " + message.name + " and a " + message.type);
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
                        if (consumers[consumerName].id === id) {
                            consumers[consumerName].subscribeTos.forEach( function (producerName) {
                                var producerMeta = getProducerMetaInfo(producerName);

                                if (producerMeta) {
                                    message.consumer = consumerName;
                                    event = eventManager.toOnDisconnectEvent(producerMeta.id);
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
         * create function alias
         */

        this.start = this.create;
    }

    /**
     * Create the comminucation channel (e.g. socket)
     */

    this.createSocket = function (callback, port, host, protocol, args) {
        var mySocket = new Socket();
        if (this.logger) 
            mySocket.logger = this.logger;

        if (callback) {
            mySocket.connect(function ()  {
                callback(mySocket)
            },
            port || mq.port,
            host || mq.host,
            protocol || mq.protocol,
            args || mq.args
            );
        }
        return mySocket;
    };

    /**
     * private function
     */

    this.createConsumerPrivate = function (context, name, callback, port, host, protocol, args, onErrorCallback) {
        var consumer = new Subscriber(name);
        
        if (context && context.logger)
            consumer.logger = context.logger;

        if (callback) {
            consumer.connect(function ()  {
                onErrorCallback = onErrorCallback || function (message) {
                    if (mq.logger)
                        mq.logger.error("Error message received: " + message);
                };

                if (onErrorCallback) {
                    var oldOnError = consumer.onError;
                    consumer.on('ERROR', function () {
                        oldOnError.call(consumer);
                        onErrorCallback();
                    });
                }

                callback(consumer);
            },
            port,
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

    this.createConsumer = function (context, name, callback, port, host, protocol, args, onErrorCallback) {
        var self = this;
        if (context && typeof context === 'string') {
            onErrorCallback = args;
            args = protocol;
            protocol = host;
            host = port;
            port = callback;
            callback = name;
            name = context;
            context = this;
        }

        if (!callback) {
            return new Promise(function (resolve, reject) {
                try {
                mq.createConsumerPrivate.call(
                    self,
                    context, 
                    name,
                    function (consumer) {
                        resolve(consumer);
                    }, 
                    port || mq.port,
                    host || mq.host,
                    protocol || mq.protocol,
                    args || mq.args,
                    onErrorCallback);
                }
                catch (err) {
                    reject(err);
                }
            });
        }
        else
            mq.createConsumerPrivate(context, 
                name,
                callback, 
                port || mq.port,
                host || mq.host,
                protocol || mq.protocol,
                args || mq.args, 
                onErrorCallback);
    }

    /**
     * Alias of createConsumer
     */

    this.createSubscriber = this.createConsumer;

    /**
     * private function
     */
     
     this.createProducerPrivate = function (context, name, eventDefault, callback, port, host, protocol, args) {
        if (!callback && typeof eventDefault === 'function') {
            args = protocol;
            protocol = host;
            host = port;
            port = callback;
            callback = eventDefault;
            eventDefault = null;
        }

        var producer = new Producer(name, eventDefault);
        if (context && context.logger)
            producer.logger = context.logger;

        if (callback)
            return producer.connect(function ()  {
                callback(producer);
            },
            port,
            host,
            protocol,
            args
            );

        return producer;
     }

    /**
     * Create a producer
     */

    this.createProducer = function (name, eventDefault, callback, port, host, protocol, args) {
        var self = this;

        if (eventDefault && typeof eventDefault === 'function') {
            args = protocol;
            protocol = host;
            host = port;
            port = callback;
            callback = eventDefault;
            eventDefault = null;
        }

        if (!callback) {
            return new Promise(function (resolve, reject) {
                try {
                    mq.createProducerPrivate.call(
                        self,
                        self,
                        name,
                        eventDefault,
                        function (producer) {
                            resolve(producer);
                        },
                        port || mq.port,
                        host || mq.host,
                        protocol || mq.protocol,
                        args || mq.args);
                }
                catch (err) {
                    reject(err);
                }
            });
        }
        else
            mq.createProducerPrivate(self, 
                name,
                eventDefault,
                callback,
                port || mq.port,
                host || mq.host,
                protocol || mq.protocol,
                args || mq.args
            );
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

};

MessageQueue.prototype.createServer = function () {
    return new Server();
};

MessageQueue.Producer = Producer;
MessageQueue.Consumer = Subscriber;
MessageQueue.Publisher = Producer;
MessageQueue.Subscriber = Subscriber;

module.exports = MessageQueue;