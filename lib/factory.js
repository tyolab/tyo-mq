/**
 * @file message-queue.js
 * 
 * It may not be a good idea to name it message queue here, but for now leave it as it is
 */
var Socket          = require('./socket'),
    Subscriber      = require('./subscriber'),
    Producer        = require('./publisher');

function Factory (options) {
    options = options || {};
    /**
     * for log
     */
    this.logger = options.logger || console;
    this.port = options.port || null;
    this.host = options.host || null;
    this.protocol = options.protocol || null;
    this.args = options.args || {};

    var mq = this;

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

Factory.Producer = Producer;
Factory.Consumer = Subscriber;
Factory.Publisher = Producer;
Factory.Subscriber = Subscriber;

module.exports = Factory;