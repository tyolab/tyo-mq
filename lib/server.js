/**
 * Messaging Server 
 */
'esversion: 6';

const os = require('os');
const pak = require('../package.json');

// info
var eventManager    = require('./events');

const Constants = require('./constants');
const Logger    = require('./logger');

function Server(options) {
    this.options = options || {};

    var server = this;

    this.logger = new Logger('tyo-mq', { level: Logger.LOG });

    var app = require('http').createServer((req, res) => {
        res.writeHead(403);
    });

    // Default to 50 MB so large messages don't silently drop the connection.
    // Callers can override by passing maxHttpBufferSize in options.
    var ioOptions = Object.assign({ maxHttpBufferSize: 50 * 1024 * 1024 }, options);
    var io = require('socket.io')(app, ioOptions);
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

        if (self.logger) {
            self.logger.log("                                        ");
            self.logger.log(" | |_ _   _  ___        _ __ ___   __ _ ");
            self.logger.log(" | __| | | |/ _ \\ _____| '_ ` _ \\ / _` |");
            self.logger.log(" | |_| |_| | (_) |_____| | | | | | (_| |");
            self.logger.log("  \\__|\\__, |\\___/      |_| |_| |_|\\__, |");
            self.logger.log("      |___/                          |_|");
            self.logger.log("                                        ");
            self.logger.log('Message server version: ' + pak.version);
            self.logger.log('Now listening on localhost:' + port);
        }

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

        // Pending chunk transfers keyed by "<socketId>:<transferId>"
        var pendingChunks = {};

        // creating a new websocket then wait for connection
        io.sockets.on('connection', function(socket) {

            var setupConsumer = function (consumer, consumerId) {
                // unlike producer, consumer doesn't need to know the status of the producer
                var consumerMeta = getConsumerMetaInfo(consumer);
                consumerMeta.id = consumerId || consumerMeta.id;
                consumerMeta.socket = socket.id;
                consumerMeta.online = true;
                return consumerMeta;
            };

            var setupProducer = function (producer, producerId) {
                // unlike producer, producer doesn't need to know the status of the producer
                var producerMeta = getProducerMetaInfo(producer);
                producerMeta.id = producerId || producerMeta.id;
                producerMeta.socket = socket.id;
                producerMeta.online = true;
                return producerMeta;
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
            function subscribeMessage (event, producer, consumer, consumerId, scope) {
                var eventStr;

                server.logger.info("Consumer (name: " + consumer + ", id: " + socket.id + ") subscribing to event '" + event + "' from producer '" + producer + "'");

                eventStr = eventManager.toConsumerEvent(event, producer, scope != Constants.SCOPE_ALL);

                // id is the message subscriber's id
                // id = socket.id;

                // register consumer if it hasn't done so
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
                        server.logger.warn("SUBSCRIBE: failed to parse event JSON: " + e);
                        return;
                    }
                if ((typeof event === 'object' && event.event)) {
                    var targetEvent;
                    var producer;
                    var consumer;
                    var id;

                    producer = event.producer;
                    consumer = event.consumer;
                    id = event.id || socket.id;
                    targetEvent = event.event; 
                    producer = producer || Constants.ANONYMOUS;
                    consumer = consumer || Constants.ANONYMOUS;
                    scope = event.scope || Constants.SCOPE_DEFAULT;

                    subscribeMessage(targetEvent, producer, consumer, id, scope);

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
                        server.logger.warn("SUBSCRIBE: incorrect message format (event must be an object with .event): " + JSON.stringify(event));
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
                var str = JSON.stringify(message);
                var chunkSize = 256 * 1024; // 256 KB — keep frames well under maxHttpBufferSize

                if (str.length <= chunkSize) {
                    sendMessage(socketId, eventStr, message, producer);
                    return;
                }

                // Large message — send as ordered chunks; subscriber reassembles before dispatching
                var total = Math.ceil(str.length / chunkSize);
                var transferId = Date.now().toString(36) + '-' + Math.random().toString(36).slice(2);
                for (var i = 0; i < total; i++) {
                    server.send(socketId, 'CONSUME_CHUNK', {
                        transferId: transferId,
                        event:      eventStr,
                        index:      i,
                        total:      total,
                        data:       str.slice(i * chunkSize, (i + 1) * chunkSize)
                    });
                }
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
                    server.logger.error("sendMessage: null socket — event: " + event
                        + (from ? ", from: " + JSON.stringify(from) : "")
                        + ", message: " + JSON.stringify(message));
                    return;
                }
                server.logger.debug("sendMessage → " + id + "  event: " + event + "  message: " + JSON.stringify(message));
                server.send(id, event, message);
                // server.broadcast(event, message);
            }

            /**
             * Send socket volatile message
             * 
             */

             function sendVolatileMessage (id, event, message) {
                if (!id) {
                    server.logger.error("sendVolatileMessage: null socket — event: " + event + ", message: " + JSON.stringify(message));
                    return;
                }
                server.logger.debug("sendVolatileMessage → " + id + "  event: " + event + "  message: " + JSON.stringify(message));
                server.volatile(event, message, id);
            }

            /**
             * Send volatile message
             * 
             */

            function broadcastVolatileMessage (event, message) {
                server.logger.debug("broadcastVolatileMessage  event: " + event + "  message: " + JSON.stringify(message));
                server.volatile(event, message);
            }

            /**
             * 
             * @param {*} event 
             * @param {*} message 
             */

            function broadcastMessage (event, message) {
                server.logger.debug("broadcastMessage  event: " + event + "  message: " + JSON.stringify(message));
                server.broadcast(event, message);
            }

            /**
             * 
             */

            function generateMessage (event, message, producer) {
                producer = producer || Constants.ANONYMOUS;

                var msgObj = {event:event, message:message, from:producer};

                let subscriptionEvent = eventManager.toConsumerEvent(event, producer);
                let subscriptionEventAll = eventManager.toConsumerEventAll(producer);

                [subscriptionEvent, subscriptionEventAll].forEach(function (eventStr) {

                    var subscriptions = getEventSubscriptions(eventStr);
                    for (var consumer in subscriptions) {
                        var subscription = subscriptions[consumer];
                        var consumerMeta = getConsumerMetaInfo(subscription.name);

                        var ar = Array.from(consumerMeta.subscribeTos);
                        for (var i = 0; i < ar.length; ++i) {
                            var name = ar[i];
                            if (name === Constants.ALL_PUBLISHERS || name === producer) {
                                sendConsumeMessage(consumerMeta.socket, eventStr, msgObj, producer);
                                break;
                            }
                        }
                    }
                });
                
            }

            /**
             * Relay message from producer to consumer
             * the message has to an object containing event, message and producer name
             */

            function handleProduce(obj) {
                var producerName = obj.from;
                var event = obj.event;
                var message = obj.message;

                var producerMeta = getProducerMetaInfo(producerName, obj.id);

                if (!producerMeta.socket)
                    setupProducer(producerName, obj.id);

                if (obj.method && obj.method === 'broadcast')
                    broadcastConsumeMessage(event, message, producerName);
                else
                    generateMessage(event, message, producerName);
            }

            socket.on('PRODUCE', function (msg) {
                let obj;
                if (typeof msg === "string")
                    try {
                        obj = JSON.parse(msg);
                    }
                    catch (e) {
                        server.logger.warn("PRODUCE: failed to parse message JSON: " + msg);
                        return;
                    }
                else
                    obj = msg;

                handleProduce(obj);
            });

            /**
             * Handle one chunk of a large message.
             * When all chunks arrive the reassembled message is processed via handleProduce.
             */
            socket.on('PRODUCE_CHUNK', function (chunk) {
                if (typeof chunk === 'string')
                    try { chunk = JSON.parse(chunk); }
                    catch (e) { server.logger.warn("PRODUCE_CHUNK: failed to parse JSON: " + e); return; }

                var key = socket.id + ':' + chunk.transferId;

                if (!pendingChunks[key]) {
                    pendingChunks[key] = { parts: new Array(chunk.total), received: 0 };
                }

                var transfer = pendingChunks[key];
                transfer.parts[chunk.index] = chunk.data;
                transfer.received++;

                if (transfer.received === chunk.total) {
                    delete pendingChunks[key];
                    var fullStr = transfer.parts.join('');
                    var assembled;
                    try {
                        assembled = JSON.parse(fullStr);
                    } catch (e) {
                        server.logger.warn("PRODUCE_CHUNK: failed to parse reassembled message: " + e);
                        return;
                    }
                    handleProduce(assembled);
                }
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
                        server.logger.warn("CONSUMER: failed to parse JSON: " + consumer);
                        return;
                    }

                if (typeof consumer.name !== "string") {
                    server.logger.warn("CONSUMER: missing or non-string name field: " + JSON.stringify(consumer));
                    sendErrorMessage({message: "Incorrect consumer's name", code: -1});
                    return;
                }

                // Reject duplicate consumer names: if an existing live socket is already
                // registered under this name, the new connection is a misconfiguration
                // (e.g. two instances sharing the same app_id).  Disconnect the newcomer
                // immediately so the existing consumer is not silently displaced.
                var existingMeta = consumers[consumer.name];
                if (existingMeta && existingMeta.socket && existingMeta.socket !== socket.id) {
                    var existingSocket = io.sockets.sockets.get(existingMeta.socket);
                    if (existingSocket) {
                        server.logger.critical("DUPLICATE CONSUMER: '" + consumer.name + "' already registered with socket " + existingMeta.socket + ". Rejecting new socket " + socket.id + " — check app_id configuration.");
                        sendErrorMessage({message: "Duplicate consumer name: '" + consumer.name + "' is already registered. Use a unique app_id per broker/instance.", code: -3});
                        socket.disconnect();
                        return;
                    }
                }

                server.logger.log("Consumer joined: name='" + consumer.name + "'  socket=" + socket.id);

                var event;
                var message = {event: 'CONNECT', socket: socket.id};
                let consumerMeta = setupConsumer(consumer.name, consumer.id || socket.id);
                let subscribedTos = consumerMeta.subscribeTos;
                if (subscribedTos && subscribedTos.size > 0) {
                    let producers = Array.from(subscribedTos);
                    producers.forEach(function (producerName) {
                        var producerMeta = getProducerMetaInfo(producerName);

                        if (producerMeta && producerMeta.socket) {
                            message.consumer = consumer.name;
                            event = eventManager.toOnConnectEvent(producerMeta.id);
                            server.logger.debug("Notifying producer '" + producerName + "' of consumer reconnect — event: " + event);
                            sendMessage(producerMeta.socket, event, message, consumer.name);
                        }
                    });
                }
            });

            /**
             * On producer is ready
             */
            socket.on('PING', function (msg, callback) {
                server.logger.debug("PING from " + socket.id + ": " + JSON.stringify(msg));
                if (callback) {
                    const response = Object.assign({}, msg, { pong: "PONG", timestamp: new Date().toISOString() });
                    callback(JSON.stringify(response));
                }
            });

            socket.on('PRODUCER', function (msg) {
                let producer;
                if (typeof msg === "string") 
                    try {
                        producer = JSON.parse(msg);
                    }
                    catch (e) {
                        server.logger.warn("PRODUCER: failed to parse JSON: " + msg);
                        return;
                    }
                else
                    producer = msg;

                if (typeof producer.name !== "string") {
                    server.logger.warn("PRODUCER: missing or non-string name field: " + JSON.stringify(producer));
                    sendErrorMessage({message: "Incorrect producer's name", code: -1});
                    return;
                }

                var producerName = producer.name;
                var producerId = producer.id || socket.id;

                server.logger.log("Producer joined: name='" + producer.name + "'  socket=" + socket.id + "  id=" + producerId);
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

                var event;
                var message = {event: 'CONNECT', socket: socket.id};

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
                        sendSubscriptionMessage(obj.events, producerMeta, consumerMeta, consumerMeta.online);
                    }

                    // now we send the producer online message to the consumer(s)
                    message.producer = producerName;
                    event = eventManager.toOnConnectEvent(consumerMeta.id);
                    server.logger.log("Producer '" + producerName + "' online — notifying consumer '" + consumer + "' via event: " + event);
                    if (consumerMeta.socket)
                        sendMessage(consumerMeta.socket, event, message, producerName);
                    else
                        server.logger.debug("Trying to inform consumer (" + consumerMeta.name + ") that producer (" + producerName + ") is online but it seems the consumer is offline");
                }

            });

            /**
             * On HELLO
             */

            socket.on('HELLO', function (message) {
                server.logger.info("HELLO from '" + message.name + "' (type: " + message.type + ")  socket=" + socket.id);
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
             * Please be noted losing connection doesn't mean unsubscribing / stop producing
             * 
             * for unsubscribe / unpublish, see #UNSUBSCRIBE, #UNPUBLISH messages
             */

            socket.on('disconnect', function () {
                // Clean up any in-flight chunked transfers for this socket
                var prefix = socket.id + ':';
                Object.keys(pendingChunks).forEach(function (key) {
                    if (key.indexOf(prefix) === 0) delete pendingChunks[key];
                });

                var event;
                var message = {event: 'DISCONNECT', socket: socket.id};
                
                // var id = socket.id;

                /**
                 * @todo
                 * 
                 * update the registration information
                 * 
                 */
                // var isProducer = false;

                 // check if it is a producer
                for (var name in producers) {
                    var producerMeta = producers[name];
                    if (producerMeta.socket && producerMeta.socket === socket.id) {
                        // isProducer = true;
                        producerMeta.online = false;

                        producerMeta.subscribers.forEach (function (consumerName) {
                            var consumerMeta = getConsumerMetaInfo(consumerName);

                            if (consumerMeta) {
                                // consumerMeta.subscribeTos.delete(name);
                                message.producer = name;
                                event = eventManager.toOnDisconnectEvent(consumerMeta.id);
                                server.logger.warn("Producer disconnected: '" + name + "' — notifying consumer '" + consumerName + "' via event: " + event);
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
                            server.logger.warn("Consumer disconnected: '" + consumerName + "'  socket=" + socket.id);

                            consumerMeta.online = false;

                            consumerMeta.subscribeTos.forEach( function (producerName) {
                                var producerMeta = getProducerMetaInfo(producerName);

                                if (producerMeta && producerMeta.socket) {
                                    message.consumer = consumerName;
                                    event = eventManager.toOnDisconnectEvent(producerMeta.id);
                                    server.logger.info("Notifying producer '" + producerName + "' of consumer '" + consumerName + "' disconnect — event: " + event);
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
