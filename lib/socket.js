/**
 * @file socket.js
 * 
 * A Socket.io connection 
 * 
 */

const Constants = require('./constants');

/**
 * Socket Class
 */

function Socket() {

    /**
     * Autoconnect
     */

    this.autoreconnect = true;
    
    /**
     * SocketIO instance
     */

    this.io = require('socket.io-client');

    /**
     * Socket Instance from socket.io
     */
    this.socket = null;

    this.connected = false;
    
    /**
     * Socket Id
     */
    this.id = function () { 
        return this.socket.id; 
    };

    this.logger = this.logger || /* (process.env.NODE_ENV === 'production') ? null :  */console;

    this.onConnectListeners = null;

    /**
     * Add on connect listener
     */
    this.addConnectionListener = function (listener) {
        this.onConnectListeners = this.onConnectListeners || [];
        this.onConnectListeners.push(listener);
    };

    var self = this;
    this.onDisconnectListener = function(socket) {
        self.connected = false;
        if (self.logger)
            self.logger.log("connection lost");
    };

    // Only available from the server side
    // this.disable = function (what) {
    //     this.io.disable(what);
    // }

    /**
     * The name of the socket such as a name of an App
     */

    this.name = Constants.ANONYMOUS;

    /**
     * Alias
     */

    this.alias = null;

    /**
    this.serial_id = -1;
    this.sendIdentificationInfo = function () {
        // do nothing yet
    }

     * On Error 
     */
    this.onError = function (message) {
        this.logger.error(message);
    }

    /**
     * On Connect
     */
    this.onConnect = function () {
        this.sendIdentificationInfo();

        this.on("ERROR", function (message) {
            if (self.onError)
                self.onError.call(self, message);
        });
    }

    /**
     * On Disconnect
     */

    this.onDisconnect = function () {
        this.logger.log("Socket (" + this.getId() + ") is disconnected");
    }
}

/**
 * 
 */

Socket.prototype.generateConnectionUrl = function() {
    var host_url = this.protocol + "://"  + this.host + ":" + this.port + "/";
    return host_url;
};

/**
 * Disconnect
 */

Socket.prototype.disconnect = function (callback) {
    if (this.socket && this.socket.connected) {
        this.socket.disconnect();
    }
};

/**
 * Flush
 */

Socket.prototype.flush = function (callback) {
    this.socket.flush();
    setTimeout(function() {
        callback();
    }, 10);
};

/**
 * Connect to the Socket.io server
 */

Socket.prototype.connect = function (callback, port, host, protocol, args) {
    var self = this;

    if (this.socket && this.socket.connected) {
        if (callback) {
            return callback();
        }
        return;
    }

    this.host = host || process.env.TYO_MQ_HOST || 'localhost';
    this.port = port || process.env.TYO_MQ_PORT || '17352';
    this.protocol = protocol || 'http';

    /**
     */
    var connectString = this.protocol + "://" + this.host + ':' + this.port;
    this.connectWith(callback, connectString, args);
};

/**
 * Connect to ther server with connection string
 */
    
Socket.prototype.connectWith = function (callback, connectStr, args) {
    var self = this;
    this.connectString = connectStr;

    if (self.logger)
        self.logger.log("connecting to " + this.connectString + "...");
    
    this.socket = this.io.connect(this.connectString, args || { transports: ["websocket"] });

    this.socket.on('connect', function(socket) {
        self.connected = true;

        if (self.logger)
            self.logger.log("connected to message queue server");
        
        self.onConnect();

        if (self.onConnectListeners && self.onConnectListeners.length > 0) {
            self.onConnectListeners.forEach(function (listener) {
                listener();
            });
        }

        if (callback) {
            callback();
            callback = null;
        }
    });

    this.socket.on('disconnect', this.onDisconnectListener);
    
};

/**
 * Send Event Message
 */

Socket.prototype.sendMessage = function (event, msg, callback) {
    if (!this.socket)
        throw new Error("Socket isn't ininitalized yet");

    if (!this.socket.connected) {
        var futureFunc = this.socket.emit.bind(self, event, msg);
        if (this.autoreconnect)
            this.connect(function (){
                futureFunc.call();
            });
        else
            throw new Error("Socket is created but not connected");
        return;
    }
    
    this.socket.emit(event, msg);
    if (callback) {
        callback();
    }
};

/**
 * On Event
 */

Socket.prototype.on = function (event, callback) {
    if (event === 'connect') {
        this.addConnectionListener(callback);
        return;
    }
    this.socket.on(event, callback);
};

/**
 * Get Socket Id
 */

Socket.prototype.getSocketId = function () {
    return this.socket ? this.socket.id : null;
};

Socket.prototype.getId = Socket.prototype.getSocketId;

module.exports = Socket;