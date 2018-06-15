var Socket          = require('./socket'),
    Subscriber      = require('./subscriber'),
    Producer        = require('./publisher'),
    eventManager    = require('./events');

var Constants = require('./constants');

function MessageQueue () {
    /**
     * for log
     */
    this.logger = this.logger || console;
    this.port = null;
    this.host = null;

    var mq = this;

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
        consumers[consumer] = consumers[consumer] || {subscribeTos: new Set()};
        return consumers[consumer];
    };

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
     * Create the comminucation channel (e.g. socket)
     */

    this.createSocket = function (callback, port, host, protocol, args) {
        var mySocket = new Socket();
        if (this.logger) 
            mySocket.logger = this.logger;

        if (callback) {
            mySocket.connect(function ()  {
                callback(mySocket);
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
    };

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
    };

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
     };

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
    };
}

MessageQueue.prototype.createServer = function () {
    return new Server();
};

MessageQueue.Producer = Producer;
MessageQueue.Consumer = Subscriber;
MessageQueue.Publisher = Producer;
MessageQueue.Subscriber = Subscriber;

module.exports = MessageQueue;