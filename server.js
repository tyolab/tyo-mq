var Params = require('node-programmer/params');
var Server = require('./lib/server');
var env = require('./lib/env');

env.loadEnvFile(process.env.TYO_MQ_ENV_FILE || '.env');

var params = new Params({
    "port": null,
    "auth-store": null,
});

var opts = params.getOpts();

// The SQLite auth store is strictly opt-in. Enable it explicitly with
// --auth-store [file], TYO_MQ_AUTH_STORE=true|<file>, or an "auth_store"
// block in the settings file; otherwise realms/tokens stay in the JSON
// settings file as always.
var authStore = opts['auth-store'] !== undefined && opts['auth-store'] !== null
    ? opts['auth-store']
    : process.env.TYO_MQ_AUTH_STORE;
if (authStore === 'true' || authStore === true)
    authStore = true;
else if (authStore === 'false' || !authStore)
    authStore = undefined;

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
    auth: {
        enabled: process.env.TYO_MQ_AUTH_ENABLED === 'true',
        env_file: process.env.TYO_MQ_ENV_FILE || '.env',
        auto_admin_token: process.env.TYO_MQ_AUTO_ADMIN_TOKEN !== 'false'
    },
    auth_store: authStore,
});

if (process.env.TYO_MQ_SETTINGS_FILE)
    server.loadSettings(process.env.TYO_MQ_SETTINGS_FILE);

server.start(opts.port ? parseInt(opts.port) : undefined);

module.exports = server;
