var Params = require('node-programmer/params');
var Server = require('./lib/server');

var params = new Params({
    "port": null,
});

var opts = params.getOpts();

var server = new Server({
    serveClient: false,
    pingInterval: 5000,
    pingTimeout: 10000,
    allowEIO3: true,
    cors: {
        origin: "*",
        methods: ["GET", "POST"],
        credentials: true
    },
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

server.start(opts.port ? parseInt(opts.port) : undefined);

module.exports = server;