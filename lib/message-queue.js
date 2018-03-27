var Socket          = require('./socket'),
    Subscriber      = require('./subscriber'),
    Producer        = require('./producer'),
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

    var getSubscriptions = function (eventStr) {
        consumer = consumer || Constants.ANONYMOUS;
        subscriptions[eventStr] = subscriptions[eventStr] || {};
        return subscriptions[eventStr].subscribers;
    }

    var getEventSubscriber = function (eventStr, consumer) {
        consumer = consumer || Constants.ANONYMOUS;
        var subscriptions = getSubscriptions(eventStr);

        subscribers[consumer] = subscribers[consumer] || {};
        return subscribers[consumer];
    }

    /**
     * @todo
     * Each event may be unqiue, deal with later
     * 
     * @param {*} eventStr 
     * @param {*} producer 
     */
    var getProducerMetaInfo = function (producer) {
        producer = producer || Constants.ANONYMOUS;
        // producers[producer] = producers[producer] || {};
        return producers[producer];
    }

    var getSubscribersByProducer = function (producer) {
        var obj = {};
        var ids = {};

        for (var event in subscriptions) {
            obj[event] = {};

            for (var eventSubscription in subscriptions[event]) {
                if (eventSubscription[producer]) {
                    var producerMeta = eventSubscription[producer];
                    obj[event] = producerMeta.subscribers;
                    for (var subscriber in producerMeta.subscribers) {
                        if (!ids[id]) {
                            ids[id] = {};
                            ids[id].events = ids[id].events || {};
                            ids[id].events.push(event);
                        }
                    }  
                }
            }
        }

        return {subscribers: obj, ids: ids};
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
            
            // system message all CAPS
            function subscribeMessage (event, producer, consumer) {
                var eventStr, id;

                eventStr = eventManager.toEventString(event);

                // id is the message subscriber's id
                id = event.id || socket.id;

                var subscription = getEventSubscriber(eventStr, consumer);
                // the subscription is neither confirmed or authorized
                subscription.id = false;
                subscription.name = consumer;
                subscription.subscribeTo = producer;

                var producerMeta = getProducerMetaInfo(eventStr, producer);

                // check if producer is registered
                if (producerMeta) {
                    sendSubscriptionMessage(eventStr, producer, consumer, id);
                    subscription.id = true;
                }
            }

            // send subscrition message
            function sendSubscriptionMessage(eventStr, producer, consumer, consumerId) {
                var producerInfo = getProducerMetaInfo(eventStr, producer);

                if (producerInfo && producerInfo.id)
                    sendSubscriptionMessageWithConsumerInfo(producerInfo.id, producer, consumer, consumerId);
            }

            function sendSubscriptionMessageWithConsumerInfo(id, producer, consumer, consumerId) {
                var onSubscribeEvent = eventManager.toOnSubscribeEvent(producer);
                sendMessage(id, onSubscribeEvent, {name:consumer, id:consumerId});
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
                    var msg = "Message name should be a string";
                    if (mq.logger) {
                        mq.logger.error("Incorrect subcription message name: " + event);
                        mq.logger.error(msg);
                    }
                    mq.send(socket.id, 'ERROR', msg);
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
             * Send the message
             */
            function sendMessage (id, event, message) {
                mq.send(id, eventManager.toConsumeEvent(event), {event:event, message:message, from:producer});
            }

            /**
             * 
             */

            function generateMessage (event, message, producer) {
                var subscription = this.getSubscription(event, producer);

                if (subscription)
                    for (var id in subscription) {
                        if (subscription[id]) {
                            sendMessage(id, event, message, producer);
                        }
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
             * On producer is ready
             */
            socket.on('PRODUCER', function (producer) {
                var producerName = producer.name || producer;
                var obj = getSubscribers(producerName);
                for (var id in obj.ids)
                    send
            });

            /**
             * 
             */

            socket.on('disconnect', function () {
                var event = eventManager.toOnDisconnectFromProducerEvent(socket.id);
                var message = {event: 'DISCONNECT', who: socket.id};
                generateMessage(event, message);
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

    this.createConsumerPrivate = function (context, callback, port, host, protocol, args, onErrorCallback) {
        var consumer = new Subscriber();
        if (context && context.logger)
            consumer.logger = context.logger;

        if (callback) {
            consumer.connect(function ()  {
                onErrorCallback = onErrorCallback || function (message) {
                    if (mq.logger)
                        mq.logger.error("Error message received: " + message);
                };

                consumer.on('ERROR', onErrorCallback);

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

    this.createConsumer = function (context, callback, port, host, protocol, args, onErrorCallback) {
        var self = this;
        if (context && typeof context === 'function') {
            onErrorCallback = args;
            args = protocol;
            protocol = host;
            host = port;
            port = callback;
            callback = context;
            context = this;
        }

        if (!callback) {
            return new Promise(function (resolve, reject) {
                try {
                mq.createConsumerPrivate.call(
                    self,
                    context, 
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
     
     this.createProducerPrivate = function (context, eventDefault, callback, port, host, protocol, args) {
        if (!callback && typeof eventDefault === 'function') {
            args = protocol;
            protocol = host;
            host = port;
            port = callback;
            callback = eventDefault;
            eventDefault = null;
        }

        var producer = new Producer(eventDefault);
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

    this.createProducer = function (eventDefault, callback, port, host, protocol, args) {
        var self = this;
        if (!callback) {
            return new Promise(function (resolve, reject) {
                try {
                    mq.createProducerPrivate.call(
                        self,
                        self,
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

module.exports = MessageQueue;