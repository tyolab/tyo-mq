/**
 * Messaging Server 
 */
'esversion: 6';

const crypto = require('crypto');
const http = require('http');
const https = require('https');
const pak = require('../package.json');

// info
var eventManager    = require('./events');

const Constants = require('./constants');
const Logger    = require('./logger');

function Server(options) {
    this.options = options || {};
    this.authOptions = this.options.auth || {};

    var server = this;

    this.logger = new Logger('tyo-mq', { level: Logger.LOG });

    var app = http.createServer((req, res) => {
        res.writeHead(403);
    });

    // Default to 50 MB so large messages don't silently drop the connection.
    // Callers can override by passing maxHttpBufferSize in options.
    var ioOptions = Object.assign({ maxHttpBufferSize: 50 * 1024 * 1024 }, options);
    var io = require('socket.io')(app, ioOptions);
    // app.listen(this.options.port || Constants.DEFAULT_PORT);

    var DEFAULT_REALM = 'default';
    var REALM_ALL = '*';
    var realms = {};

    var getRealm = function (realmId) {
        realmId = realmId || DEFAULT_REALM;
        realms[realmId] = realms[realmId] || {producers: {}, consumers: {}, subscriptions: {}};
        return realms[realmId];
    };

    var getSocketRealmId = function (socket) {
        return (socket.tyoAuth && socket.tyoAuth.realm) || DEFAULT_REALM;
    };

    var getSocketRealm = function (socket) {
        return getRealm(getSocketRealmId(socket));
    };

    var isAuthEnabled = function () {
        return !!(server.authOptions && server.authOptions.enabled);
    };

    var normalizeRole = function (role) {
        return role || 'both';
    };

    var roleAllows = function (role, allowed) {
        role = normalizeRole(role);
        if (role === 'admin' || role === 'both')
            return true;
        return allowed.indexOf(role) >= 0;
    };

    var sendAuthFail = function (socket, code, message) {
        socket.emit('AUTH_FAIL', {code: code, message: message});
    };

    var decodeBase64UrlJson = function (value) {
        value = value.replace(/-/g, '+').replace(/_/g, '/');
        while (value.length % 4)
            value += '=';
        return JSON.parse(Buffer.from(value, 'base64').toString('utf8'));
    };

    var encodeBase64Url = function (value) {
        return Buffer.from(value).toString('base64')
            .replace(/=/g, '')
            .replace(/\+/g, '-')
            .replace(/\//g, '_');
    };

    var validateJwtToken = function (token, secret) {
        var parts = token.split('.');
        if (parts.length !== 3)
            return null;

        var header = decodeBase64UrlJson(parts[0]);
        if (header.alg !== 'HS256')
            return null;

        var expected = encodeBase64Url(
            crypto.createHmac('sha256', secret).update(parts[0] + '.' + parts[1]).digest()
        );
        var expectedBuffer = Buffer.from(expected);
        var actualBuffer = Buffer.from(parts[2]);
        if (expectedBuffer.length !== actualBuffer.length || !crypto.timingSafeEqual(expectedBuffer, actualBuffer))
            return null;

        var payload = decodeBase64UrlJson(parts[1]);
        var now = Math.floor(Date.now() / 1000);
        if (payload.exp && payload.exp <= now)
            return null;
        if (payload.nbf && payload.nbf > now)
            return null;
        if (!payload.realm || !payload.role)
            return null;

        return {realm: String(payload.realm), role: String(payload.role)};
    };

    var validateExternalToken = function (token, url) {
        return new Promise(function (resolve, reject) {
            var parsed = new URL(url);
            var body = JSON.stringify({token: token});
            var client = parsed.protocol === 'https:' ? https : http;
            var req = client.request({
                method: 'POST',
                protocol: parsed.protocol,
                hostname: parsed.hostname,
                port: parsed.port,
                path: parsed.pathname + parsed.search,
                headers: {
                    'content-type': 'application/json',
                    'content-length': Buffer.byteLength(body)
                }
            }, function (res) {
                var chunks = '';
                res.setEncoding('utf8');
                res.on('data', function (chunk) { chunks += chunk; });
                res.on('end', function () {
                    if (res.statusCode < 200 || res.statusCode >= 300)
                        return resolve(null);

                    try {
                        var data = chunks ? JSON.parse(chunks) : {};
                        if (data.valid === false || data.ok === false)
                            return resolve(null);
                        if (!data.realm || !data.role)
                            return resolve(null);
                        resolve({realm: String(data.realm), role: String(data.role)});
                    }
                    catch (err) {
                        reject(err);
                    }
                });
            });
            req.on('error', reject);
            req.write(body);
            req.end();
        });
    };

    var validateToken = function (token) {
        var auth = server.authOptions || {};

        if (auth.validator && typeof auth.validator === 'function')
            return Promise.resolve(auth.validator(token));

        if (auth.auth_url)
            return validateExternalToken(token, auth.auth_url);

        if (auth.jwt_secret) {
            try {
                return Promise.resolve(validateJwtToken(token, auth.jwt_secret));
            }
            catch (err) {
                return Promise.resolve(null);
            }
        }

        var tokens = auth.tokens || [];
        for (var i = 0; i < tokens.length; i++) {
            if (tokens[i].token === token) {
                return Promise.resolve({
                    realm: String(tokens[i].realm || DEFAULT_REALM),
                    role: normalizeRole(tokens[i].role)
                });
            }
        }

        return Promise.resolve(null);
    };

    /**
     * 
     * @param {*} eventStr 
     * @returns 
     */
    var getEventSubscriptions = function (realmId, eventStr) {
        var realm = getRealm(realmId);
        realm.subscriptions[eventStr] = realm.subscriptions[eventStr] || {};
        return realm.subscriptions[eventStr];
    };

    /**
     * 
     * @param {*} eventStr 
     * @param {*} consumer 
     * @returns 
     */
    var getEventSubscriber = function (realmId, eventStr, consumer) {
        consumer = consumer || Constants.ANONYMOUS;
        var subscriptions = getEventSubscriptions(realmId, eventStr);

        subscriptions[consumer] = subscriptions[consumer] || {subscribeTos: new Set()};
        return subscriptions[consumer];
    };

    /**
     * @todo
     * Each event may be unqiue, deal with later
     * 
     * @param {*} producer 
     */

    var getProducerMetaInfo = function (realmId, producer) {
        producer = producer || Constants.ANONYMOUS;
        var realm = getRealm(realmId);
        realm.producers[producer] = realm.producers[producer] || {subscribers: new Set(), realm: realmId};
        return realm.producers[producer];
    };

    /**
     * 
     * @param {*} consumer 
     */

    var getConsumerMetaInfo = function (realmId, consumer) {
        consumer = consumer || Constants.ANONYMOUS;
        var realm = getRealm(realmId);
        realm.consumers[consumer] = realm.consumers[consumer] || {name: consumer, subscribeTos: new Set(), realm: realmId};
        return realm.consumers[consumer];
    };

    /**
     * 
     * @param {*} consumer 
     */

    var deleteConsumerFromSubscriptions = function (realmId, consumer) {
        var subscriptions = getRealm(realmId).subscriptions;
        for (var event in subscriptions) {
            if (subscriptions[event][consumer])
                delete subscriptions[event][consumer];
        }
    };

    /**
     * Actually we don't need to delete the subscription if the consumer lost connection, do we? 
     */

    var deleteProducerFromSubscriptions = function (realmId, producer) {
        var subscriptions = getRealm(realmId).subscriptions;
        for (var event in subscriptions) {
            for (var consumer in subscriptions[event]) {
                var subscription = getEventSubscriber(realmId, event, consumer);

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

    var getSubscribersByProducer = function (realmId, producer) {
        var ids = {};
        var subscriptions = getRealm(realmId).subscriptions;

        for (var key in subscriptions) {
            var event = key;
            for (var consumer in subscriptions[event]) {
                var subscription = getEventSubscriber(realmId, event, consumer);

                if (subscription.subscribeTos)
                    subscription.subscribeTos.forEach(function (name) {
                        if (name === producer) {
                            if (!ids[subscription.id]) {
                                ids[subscription.id] = {};
                                ids[subscription.id].events = new Set();
                                ids[subscription.id].name = subscription.name;
                            }
                            ids[subscription.id].events.add(event);
                        }
                    });
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
            if (!isAuthEnabled()) {
                socket.tyoAuth = {authenticated: true, realm: DEFAULT_REALM, role: 'both'};
            }

            function currentRealmId () {
                return getSocketRealmId(socket);
            }

            function currentRealm () {
                return getSocketRealm(socket);
            }

            function authorize (eventName, roles) {
                if (!isAuthEnabled())
                    return true;

                if (!socket.tyoAuth || !socket.tyoAuth.authenticated) {
                    sendAuthFail(socket, 401, "Authentication required before " + eventName);
                    return false;
                }

                if (roles && roles.length > 0 && !roleAllows(socket.tyoAuth.role, roles)) {
                    sendAuthFail(socket, 403, "Role '" + socket.tyoAuth.role + "' is not allowed to send " + eventName);
                    return false;
                }

                return true;
            }

            function onAuthorized (eventName, roles, handler) {
                socket.on(eventName, function () {
                    if (!authorize(eventName, roles))
                        return;
                    handler.apply(this, arguments);
                });
            }

            var setupConsumer = function (consumer, consumerId) {
                // unlike producer, consumer doesn't need to know the status of the producer
                var consumerMeta = getConsumerMetaInfo(currentRealmId(), consumer);
                consumerMeta.id = consumerId || consumerMeta.id;
                consumerMeta.socket = socket.id;
                consumerMeta.online = true;
                return consumerMeta;
            };

            var setupProducer = function (producer, producerId) {
                // unlike producer, producer doesn't need to know the status of the producer
                var producerMeta = getProducerMetaInfo(currentRealmId(), producer);
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
                var consumerMeta = getConsumerMetaInfo(currentRealmId(), consumer);
                if (!consumerMeta.socket)
                    setupConsumer(consumer, consumerId);

                var subscription = getEventSubscriber(currentRealmId(), eventStr, consumer);
                // the subscription is neither confirmed or authorized
                subscription.id = consumerMeta.id;
                subscription.acked = false;
                subscription.name = consumer;

                var subscribeTos;
                
                subscribeTos = consumerMeta.subscribeTos || new Set();

                if (!subscribeTos.has(producer)) {
                    subscribeTos.add(producer);
                    subscription.subscribeTos.add(producer);
                }
                
                var producerMeta;
                var status = true;
                if (producer !== Constants.ALL_PUBLISHERS) {
                    producerMeta = getProducerMetaInfo(currentRealmId(), producer);
                    sendSubscriptionMessageToProducer(eventStr, producerMeta, consumerMeta, status);
                }
                else {
                    for (var name in currentRealm().producers) {
                        if (name === consumer)
                            continue;

                        producerMeta = getProducerMetaInfo(currentRealmId(), name);
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

                    var subscription = getEventSubscriber(currentRealmId(), eventStr, consumer);

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
            onAuthorized('SUBSCRIBE', ['consumer'], function (event) {
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
                    var scope;

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
            onAuthorized('UNSUBSCRIBE', ['consumer'], function (data) {
                var subscriptions = currentRealm().subscriptions;
                if (subscriptions[data] && subscriptions[data][socket.id]) {
                    delete subscriptions[data][socket.id];
                }
            });

            /**ƒ
             * 
             */

            onAuthorized('DEBUG', [], function (data) {
                if (server.logger)
                    server.logger.log('Received DEBUG message: ' + data);
            });

            /**
             * DISCONNECT from server
             */

             onAuthorized('QUIT', [], function (id) {
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
                getCurrentRealmSocketIds().forEach(function (socketId) {
                    server.volatile(event, message, socketId);
                });
            }

            /**
             * 
             * @param {*} event 
             * @param {*} message 
             */

            function broadcastMessage (event, message) {
                server.logger.debug("broadcastMessage  event: " + event + "  message: " + JSON.stringify(message));
                getCurrentRealmSocketIds().forEach(function (socketId) {
                    server.send(socketId, event, message);
                });
            }

            function getCurrentRealmSocketIds () {
                var ids = new Set();
                var realm = currentRealm();
                Object.keys(realm.producers).forEach(function (name) {
                    if (realm.producers[name].socket)
                        ids.add(realm.producers[name].socket);
                });
                Object.keys(realm.consumers).forEach(function (name) {
                    if (realm.consumers[name].socket)
                        ids.add(realm.consumers[name].socket);
                });
                return ids;
            }

            /**
             * 
             */

            function generateMessage (event, message, producer) {
                producer = producer || Constants.ANONYMOUS;

                var msgObj = {event:event, message:message, from:producer};

                let subscriptionEvent = eventManager.toConsumerEvent(event, producer);
                let subscriptionEventAll = eventManager.toConsumerEventAll(producer);

                var targetRealmIds = [currentRealmId()];
                if (currentRealmId() !== REALM_ALL && realms[REALM_ALL])
                    targetRealmIds.push(REALM_ALL);

                targetRealmIds.forEach(function (targetRealmId) {
                    [subscriptionEvent, subscriptionEventAll].forEach(function (eventStr) {

                        var subscriptions = getEventSubscriptions(targetRealmId, eventStr);
                        for (var consumer in subscriptions) {
                            var subscription = subscriptions[consumer];
                            var consumerMeta = getConsumerMetaInfo(targetRealmId, subscription.name);

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

                var producerMeta = getProducerMetaInfo(currentRealmId(), producerName);

                if (!producerMeta.socket)
                    setupProducer(producerName, obj.id);

                if (obj.method && obj.method === 'broadcast')
                    broadcastConsumeMessage(event, message, producerName);
                else
                    generateMessage(event, message, producerName);
            }

            onAuthorized('PRODUCE', ['producer'], function (msg) {
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
            onAuthorized('PRODUCE_CHUNK', ['producer'], function (chunk) {
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

            onAuthorized('CONSUMER', ['consumer'], function (consumer) {
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
                var existingMeta = currentRealm().consumers[consumer.name];
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
                message.id = consumerMeta.id;
                let subscribedTos = consumerMeta.subscribeTos;
                if (subscribedTos && subscribedTos.size > 0) {
                    let producers = Array.from(subscribedTos);
                    producers.forEach(function (producerName) {
                        var producerMeta = getProducerMetaInfo(currentRealmId(), producerName);

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
            onAuthorized('PING', [], function (msg, callback) {
                server.logger.debug("PING from " + socket.id + ": " + JSON.stringify(msg));
                if (callback) {
                    const response = Object.assign({}, msg, { pong: "PONG", timestamp: new Date().toISOString() });
                    callback(JSON.stringify(response));
                }
            });

            onAuthorized('PRODUCER', ['producer'], function (msg) {
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

                var producerMeta = getProducerMetaInfo(currentRealmId(), producerName); // producers[producerName] = producers[producerName] || {subscribers: new Set()};
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
                var ids = getSubscribersByProducer(currentRealmId(), producerName);

                var event;
                var message = {event: 'CONNECT', socket: socket.id};

                for (var id in ids) {
                    var obj = ids[id];
                    var consumer = obj.name;
                    var events = [];

                    var consumerMeta = getConsumerMetaInfo(currentRealmId(), consumer);

                    if (!producerMeta.subscribers.has(consumer))
                        producerMeta.subscribers.add(consumer);
                    
                    Array.from(obj.events).forEach(function (event) {
                        var subscription = getEventSubscriber(currentRealmId(), event, consumer);

                        if (resendSubscriptionMessage || !subscription.acked) {
                            events.push(event);

                            subscription.acked = true;
                            subscription.subscribeToId = socket.id;
                        }
                    });

                    if (events.length > 0) {
                        sendSubscriptionMessage(events, producerMeta, consumerMeta, consumerMeta.online);
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

            onAuthorized('HELLO', [], function (message) {
                server.logger.info("HELLO from '" + message.name + "' (type: " + message.type + ")  socket=" + socket.id);
            });

            /**
             * @todo
             * On Authentication
             */
            socket.on('AUTHENTICATION', function (message) {
                if (typeof message === 'string')
                    try {
                        message = JSON.parse(message);
                    }
                    catch (e) {
                        server.logger.warn("AUTHENTICATION: failed to parse JSON: " + message);
                        sendAuthFail(socket, 401, "Invalid authentication payload");
                        return;
                    }

                if (!isAuthEnabled()) {
                    socket.tyoAuth = {authenticated: true, realm: DEFAULT_REALM, role: 'both'};
                    socket.emit('AUTH_OK', {realm: DEFAULT_REALM, role: 'both'});
                    return;
                }

                if (socket.tyoAuth && socket.tyoAuth.authenticated) {
                    sendAuthFail(socket, 403, "Socket is already authenticated");
                    return;
                }

                if (!message || typeof message.token !== 'string' || !message.token) {
                    sendAuthFail(socket, 401, "Missing authentication token");
                    return;
                }

                validateToken(message.token).then(function (authResult) {
                    if (!authResult || !authResult.realm || !authResult.role) {
                        sendAuthFail(socket, 401, "Invalid authentication token");
                        return;
                    }

                    socket.tyoAuth = {
                        authenticated: true,
                        realm: String(authResult.realm),
                        role: normalizeRole(authResult.role)
                    };
                    getRealm(socket.tyoAuth.realm);
                    socket.emit('AUTH_OK', {realm: socket.tyoAuth.realm, role: socket.tyoAuth.role});
                }).catch(function (err) {
                    server.logger.warn("AUTHENTICATION: token validation failed: " + err.message);
                    sendAuthFail(socket, 401, "Authentication failed");
                });

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
                var realm = currentRealm();
                for (var name in realm.producers) {
                    var producerMeta = realm.producers[name];
                    if (producerMeta.socket && producerMeta.socket === socket.id) {
                        // isProducer = true;
                        producerMeta.online = false;

                        producerMeta.subscribers.forEach (function (consumerName) {
                            var consumerMeta = getConsumerMetaInfo(currentRealmId(), consumerName);

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
                     for (var consumerName in realm.consumers) {
                        var consumerMeta = realm.consumers[consumerName];
                        if (consumerMeta.socket && consumerMeta.socket === socket.id) {
                            server.logger.warn("Consumer disconnected: '" + consumerName + "'  socket=" + socket.id);

                            consumerMeta.online = false;

                            consumerMeta.subscribeTos.forEach( function (producerName) {
                                var producerMeta = getProducerMetaInfo(currentRealmId(), producerName);

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
