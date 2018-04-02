var Server = require('./lib/server');
var server = new Server();

server.start();

module.exports = server;