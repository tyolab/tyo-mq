/**
 * @file socket.js
 * 
 * A Socket.io connection 
 * 
 */

'use strict';


function Socket() {
    
    this.io = require('socket.io-client');

    this.socket = null;
    
    this.id = function () { 
        return this.socket.id; 
    }
}

Socket.prototype.generateConnectionUrl = function() {
    var host_url = this.protocol + "://"  + this.host + ":" + this.port + "/";
    return host_url;
};

/**
 * Connect to the Socket.io server
 */

Socket.prototype.connect = function (port, host, protocol, callback) {
    this.host = host || process.env.TYO_MQ_HOST || 'localhost';
    this.port = port || process.env.TYO_MQ_PORT || '17352';
    this.protocol = protocol || 'http';

    /**
     */
    this.connectString = this.protocol + "://" + this.host + ':' + this.port;
    
    console.log("connecting to " + this.connectString + "...");
    
    this.socket = this.io.connect(this.connectString);

    this.socket.on('connect', function(socket) {
        if (callback) {
            callback();
        }
        else {
            console.log("connected to message queue server");
        }
    });
    
    return this.socket;
};

/**
 * Send Event Message
 */

Socket.prototype.sendMessage = function (event, msg, callback) {
    this.socket.emit(event, msg);
    if (callback) {
        callback();
    }
};

/**
 * On Event
 */

Socket.prototype.on = function (event, callback) {
    this.socket.on(event, (data) => {
        callback(data);
    });
};

module.exports = Socket;