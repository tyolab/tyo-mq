/**
 * @file socket.js
 * 
 * A Socket.io connection 
 * 
 */

'use strict';

/**
 * Socket Class
 */

function Socket() {
    
    this.io = require('socket.io-client');

    this.socket = null;
    
    this.id = function () { 
        return this.socket.id; 
    }

    this.logger = (process.env.NODE_ENV === 'production') ? null : console;
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
    this.connectString = this.protocol + "://" + this.host + ':' + this.port;
    
    if (self.logger)
        self.logger.log("connecting to " + this.connectString + "...");
    
    this.socket = this.io.connect(this.connectString, args || { transports: ["websocket"] });

    this.socket.on('connect', function(socket) {
        if (self.logger)
            self.logger.log("connected to message queue server");
        if (callback) {
            callback();
        }
    });

    this.socket.on('disconnect', function(socket) {
        if (self.logger)
            self.logger.log("connection lost");
    });
    
};

/**
 * Send Event Message
 */

Socket.prototype.sendMessage = function (event, msg, callback) {
    if (!this.socket)
        throw new Error("Socket isn't ininitalized yet");

    if (!this.socket.connected)
        throw new Error("Socket is created but not connected");

    this.socket.emit(event, msg);
    if (callback) {
        callback();
    }
};

/**
 * On Event
 */

Socket.prototype.on = function (event, callback) {
    this.socket.on(event, callback);
};

module.exports = Socket;