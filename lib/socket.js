/**
 * @file socket.js
 * 
 * A Socket.io connection 
 * 
 */

'use strict';


function Socket() {
    
    this.io = require('socket.io-client');
    
    this.host = process.env.TYO_MQ_HOST || 'localhost';
    
    this.port = process.env.TYO_MQ_PORT || '17352';
    this.protocol = 'http';
    
    /**
     */
    this.connectString = this.protocol + "://" + this.host + ':' + this.port;
    
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

Socket.prototype.connect = function () {
    console.log("connecting to " + this.connectString + "...");
    
    this.socket = this.io.connect(this.connectString);
    
    return this.socket;
};


Socket.prototype.sendMessage = function (event, msg, callback) {
    this.socket.emit(event, msg);
    if (callback) {
        callback();
    }
};

module.exports = Socket;