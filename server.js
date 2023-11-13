var Server = require('./lib/server');
var server = new Server({
    serveClient: false,
    pingInterval: 5000,
    pingTimeout: 10000,
    allowEIO3: true,
    perMessageDeflate: {
        threshold: 2048, // defaults to 1024

        zlibDeflateOptions: {
            chunkSize: 8 * 1024, // defaults to 16 * 1024
        },

        zlibInflateOptions: {
            windowBits: 14, // defaults to 15
            memLevel: 7, // defaults to 8
        },

        clientNoContextTakeover: true, // defaults to negotiated value.
        serverNoContextTakeover: true, // defaults to negotiated value.
        serverMaxWindowBits: 10, // defaults to negotiated value.

        concurrencyLimit: 20, // defaults to 10
    },
});

server.start();

module.exports = server;