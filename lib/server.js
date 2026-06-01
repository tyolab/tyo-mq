/**
 * Messaging Server 
 */
'esversion: 6';

const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const https = require('https');
const path = require('path');
const pak = require('../package.json');
const env = require('./env');
const adminSignature = require('./admin-signature');

// info
var eventManager    = require('./events');

const Constants = require('./constants');
const Logger    = require('./logger');
const Settings  = require('./settings');

function Server(options) {
    this.options = options || {};

    // Hot-loadable settings store — seeded with constructor options.
    // Call server.loadSettings(path) to watch a JSON file for live updates.
    this.settings = new Settings(this.options);

    // Convenience alias kept for backwards compatibility; always reads live value.
    Object.defineProperty(this, 'authOptions', {
        get: function () { return this.settings.get('auth') || {}; },
        enumerable: true
    });

    var server = this;

    this.logger = new Logger('tyo-mq', { level: Logger.LOG });

    var app = http.createServer((req, res) => {
        res.writeHead(403);
    });

    // Default to 50 MB so large messages don't silently drop the connection.
    // Callers can override by passing maxHttpBufferSize in options.
    var ioOptions = Object.assign({ maxHttpBufferSize: 50 * 1024 * 1024 }, options);
    var io = require('socket.io')(app, ioOptions);
    // app.listen(this.options.port || Constants.DEFAULT_PORT);

    var DEFAULT_REALM = 'default';
    var REALM_ALL = '*';
    var realms = {};
    var authorizationRequests = [];
    var authorizationRequestMap = {};
    var authorizationRequestClientMap = {};
    var usedManagerNonces = new Set();
    var loadedSettingsFile = null;

    var getEnvPath = function () {
        return server.authOptions.env_file || process.env.TYO_MQ_ENV_FILE || '.env';
    };

    var getAdminTokenEnvName = function () {
        return server.authOptions.admin_token_env || 'TYO_MQ_ADMIN_TOKEN';
    };

    var generateToken = function () {
        return crypto.randomBytes(32).toString('hex');
    };

    var hasAdminToken = function (auth) {
        var tokens = (auth && auth.tokens) || [];
        for (var i = 0; i < tokens.length; i++) {
            if (tokens[i].token && tokens[i].realm === REALM_ALL && tokens[i].role === 'admin')
                return true;
        }
        return false;
    };

    var getAdminTokens = function () {
        var tokens = (server.authOptions && server.authOptions.tokens) || [];
        return tokens.filter(function (item) {
            return item && item.token && item.realm === REALM_ALL && item.role === 'admin';
        }).map(function (item) {
            return item.token;
        });
    };

    var verifyManagerProof = function (action, body, proof) {
        if (!proof || !proof.nonce)
            return {ok: false, code: 401, message: 'Missing manager proof'};

        if (usedManagerNonces.has(proof.nonce))
            return {ok: false, code: 401, message: 'Manager proof nonce was already used'};

        var tokens = getAdminTokens();
        for (var i = 0; i < tokens.length; i++) {
            if (adminSignature.verifyAdminProof(tokens[i], action, body || {}, proof)) {
                usedManagerNonces.add(proof.nonce);
                return {ok: true};
            }
        }

        return {ok: false, code: 401, message: 'Invalid manager proof'};
    };

    var ensureAdminToken = function () {
        var auth = server.authOptions || {};
        if (!auth.enabled || hasAdminToken(auth))
            return;

        var envFile = getEnvPath();
        var tokenEnv = getAdminTokenEnvName();
        env.loadEnvFile(envFile);

        var token = process.env[tokenEnv];
        if (!token) {
            if (auth.auto_admin_token === false)
                return;

            token = generateToken();
            env.appendEnvValue(envFile, tokenEnv, token);
            if (server.logger)
                server.logger.warn("Generated admin auth token and saved it to " + envFile + " as " + tokenEnv);
        }

        var nextAuth = Object.assign({}, auth, {
            tokens: (auth.tokens || []).concat([{token: token, realm: REALM_ALL, role: 'admin'}])
        });
        server.settings.merge({auth: nextAuth});
    };

    var hashToken = function (token) {
        return crypto.createHash('sha256').update(String(token)).digest('hex');
    };

    var publicAuthorizationRequest = function (request) {
        if (!request)
            return null;
        return {
            request_id: request.request_id,
            status: request.status,
            realm: request.realm,
            role: request.role,
            client_id: request.client_id,
            client_name: request.client_name,
            client_token_hash: request.client_token_hash,
            challenge_response: request.challenge_response,
            created_at: request.created_at,
            decided_at: request.decided_at || null,
            decision_reason: request.decision_reason || null
        };
    };

    var addRuntimeAuthToken = function (token, realm, role, meta) {
        var auth = server.authOptions || {};
        var tokens = auth.tokens || [];
        for (var i = 0; i < tokens.length; i++) {
            if (tokens[i].token === token)
                return;
        }

        var entry = Object.assign({}, meta || {}, {
            token: token,
            realm: realm,
            role: normalizeRole(role)
        });

        server.settings.merge({
            auth: Object.assign({}, auth, {tokens: tokens.concat([entry])})
        });
    };

    var clone = function (obj) {
        return JSON.parse(JSON.stringify(obj || {}));
    };

    var publicAuthSettings = function () {
        var auth = clone(server.authOptions || {});
        auth.tokens = (auth.tokens || []).map(function (token) {
            return {
                realm: token.realm,
                role: token.role,
                client_id: token.client_id || null,
                client_name: token.client_name || null,
                token_hash: token.token ? hashToken(token.token) : null
            };
        });
        if (auth.jwt_secret)
            auth.jwt_secret = '<configured>';
        return auth;
    };

    var persistSettings = function () {
        if (!loadedSettingsFile)
            return;
        var dir = path.dirname(loadedSettingsFile);
        if (!fs.existsSync(dir))
            fs.mkdirSync(dir, {recursive: true});
        fs.writeFileSync(loadedSettingsFile, JSON.stringify(server.settings.get(), null, 2) + '\n');
    };

    var applyAuthManagementCommand = function (body) {
        body = body || {};
        var command = body.command;
        var auth = clone(server.authOptions || {});
        auth.realms = auth.realms || {};
        auth.tokens = auth.tokens || [];

        if (command === 'get') {
            return {ok: true, settings: publicAuthSettings()};
        }

        if (command === 'set_global_auth') {
            auth.enabled = !!body.enabled;
        }
        else if (command === 'add_realm') {
            if (!body.realm)
                return {ok: false, code: 400, message: 'realm is required'};
            if (auth.realms[body.realm])
                return {ok: false, code: 409, message: 'realm already exists'};
            auth.realms[body.realm] = {required: body.required !== false};
        }
        else if (command === 'rename_realm') {
            if (!body.from || !body.to)
                return {ok: false, code: 400, message: 'from and to are required'};
            if (!auth.realms[body.from])
                return {ok: false, code: 404, message: 'realm not found'};
            if (auth.realms[body.to])
                return {ok: false, code: 409, message: 'target realm already exists'};
            auth.realms[body.to] = auth.realms[body.from];
            delete auth.realms[body.from];
            auth.tokens.forEach(function (token) {
                if (token.realm === body.from)
                    token.realm = body.to;
            });
            if (realms[body.from] && !realms[body.to]) {
                realms[body.to] = realms[body.from];
                delete realms[body.from];
            }
        }
        else if (command === 'set_realm_auth') {
            if (!body.realm)
                return {ok: false, code: 400, message: 'realm is required'};
            auth.realms[body.realm] = auth.realms[body.realm] || {};
            auth.realms[body.realm].required = !!body.required;
        }
        else {
            return {ok: false, code: 400, message: 'unknown management command'};
        }

        var nextSettings = clone(server.settings.get());
        nextSettings.auth = auth;
        server.settings.replace(nextSettings);
        persistSettings();
        return {ok: true, settings: publicAuthSettings()};
    };

    var nextPendingAuthorizationRequest = function (filter) {
        filter = filter || {};
        for (var i = 0; i < authorizationRequests.length; i++) {
            var request = authorizationRequests[i];
            if (request.status !== 'pending')
                continue;
            if (filter.realm && request.realm !== filter.realm)
                continue;
            return request;
        }
        return null;
    };

    var authorizationClientKey = function (realm, clientId) {
        return String(realm) + '\n' + String(clientId);
    };

    var saveLatestAuthorizationRequest = function (request) {
        var key = authorizationClientKey(request.realm, request.client_id);
        var previous = authorizationRequestClientMap[key];
        if (previous && previous.status === 'pending') {
            previous.status = 'superseded';
            previous.superseded_at = request.created_at;
            delete authorizationRequestMap[previous.request_id];
        }

        authorizationRequestClientMap[key] = request;
        authorizationRequests.push(request);
        authorizationRequestMap[request.request_id] = request;
    };

    var getRealm = function (realmId) {
        realmId = realmId || DEFAULT_REALM;
        realms[realmId] = realms[realmId] || {producers: {}, consumers: {}, subscriptions: {}};
        return realms[realmId];
    };

    var getSocketRealmId = function (socket) {
        return (socket.tyoAuth && socket.tyoAuth.realm) || DEFAULT_REALM;
    };

    var getSocketRealm = function (socket) {
        return getRealm(getSocketRealmId(socket));
    };

    // Global auth toggle — true if auth.enabled is set in current settings.
    var isAuthEnabled = function () {
        return !!(server.settings.get('auth') && server.settings.get('auth').enabled);
    };

    // Per-realm auth requirement.  Resolution order:
    //   1. auth.realms[realmId].required  (explicit per-realm override)
    //   2. auth.enabled                   (global default)
    // Returns true when auth is required for this realm.
    var isAuthRequiredForRealm = function (realmId) {
        if (!isAuthEnabled()) return false;
        var auth = server.settings.get('auth') || {};
        if (realmId && auth.realms && auth.realms[realmId]) {
            var rc = auth.realms[realmId];
            if (typeof rc.required === 'boolean') return rc.required;
        }
        return true;
    };

    var normalizeRole = function (role) {
        return role || 'both';
    };

    var roleAllows = function (role, allowed) {
        role = normalizeRole(role);
        if (role === 'admin' || role === 'both')
            return true;
        return allowed.indexOf(role) >= 0;
    };

    var sendAuthFail = function (socket, code, message) {
        socket.emit('AUTH_FAIL', {code: code, message: message});
    };

    var decodeBase64UrlJson = function (value) {
        value = value.replace(/-/g, '+').replace(/_/g, '/');
        while (value.length % 4)
            value += '=';
        return JSON.parse(Buffer.from(value, 'base64').toString('utf8'));
    };

    var encodeBase64Url = function (value) {
        return Buffer.from(value).toString('base64')
            .replace(/=/g, '')
            .replace(/\+/g, '-')
            .replace(/\//g, '_');
    };

    var validateJwtToken = function (token, secret) {
        var parts = token.split('.');
        if (parts.length !== 3)
            return null;

        var header = decodeBase64UrlJson(parts[0]);
        if (header.alg !== 'HS256')
            return null;

        var expected = encodeBase64Url(
            crypto.createHmac('sha256', secret).update(parts[0] + '.' + parts[1]).digest()
        );
        var expectedBuffer = Buffer.from(expected);
        var actualBuffer = Buffer.from(parts[2]);
        if (expectedBuffer.length !== actualBuffer.length || !crypto.timingSafeEqual(expectedBuffer, actualBuffer))
            return null;

        var payload = decodeBase64UrlJson(parts[1]);
        var now = Math.floor(Date.now() / 1000);
        if (payload.exp && payload.exp <= now)
            return null;
        if (payload.nbf && payload.nbf > now)
            return null;
        if (!payload.realm || !payload.role)
            return null;

        return {realm: String(payload.realm), role: String(payload.role)};
    };

    var validateExternalToken = function (token, url) {
        return new Promise(function (resolve, reject) {
            var parsed = new URL(url);
            var body = JSON.stringify({token: token});
            var client = parsed.protocol === 'https:' ? https : http;
            var req = client.request({
                method: 'POST',
                protocol: parsed.protocol,
                hostname: parsed.hostname,
                port: parsed.port,
                path: parsed.pathname + parsed.search,
                headers: {
                    'content-type': 'application/json',
                    'content-length': Buffer.byteLength(body)
                }
            }, function (res) {
                var chunks = '';
                res.setEncoding('utf8');
                res.on('data', function (chunk) { chunks += chunk; });
                res.on('end', function () {
                    if (res.statusCode < 200 || res.statusCode >= 300)
                        return resolve(null);

                    try {
                        var data = chunks ? JSON.parse(chunks) : {};
                        if (data.valid === false || data.ok === false)
                            return resolve(null);
                        if (!data.realm || !data.role)
                            return resolve(null);
                        resolve({realm: String(data.realm), role: String(data.role)});
                    }
                    catch (err) {
                        reject(err);
                    }
                });
            });
            req.on('error', reject);
            req.write(body);
            req.end();
        });
    };

    var validateToken = function (token) {
        var auth = server.authOptions || {};

        if (auth.validator && typeof auth.validator === 'function')
            return Promise.resolve(auth.validator(token));

        if (auth.auth_url)
            return validateExternalToken(token, auth.auth_url);

        if (auth.jwt_secret) {
            try {
                return Promise.resolve(validateJwtToken(token, auth.jwt_secret));
            }
            catch (err) {
                return Promise.resolve(null);
            }
        }

        var tokens = auth.tokens || [];
        for (var i = 0; i < tokens.length; i++) {
            if (tokens[i].token === token) {
                return Promise.resolve({
                    realm: String(tokens[i].realm || DEFAULT_REALM),
                    role: normalizeRole(tokens[i].role)
                });
            }
        }

        return Promise.resolve(null);
    };

    /**
     * 
     * @param {*} eventStr 
     * @returns 
     */
    var getEventSubscriptions = function (realmId, eventStr) {
        var realm = getRealm(realmId);
        realm.subscriptions[eventStr] = realm.subscriptions[eventStr] || {};
        return realm.subscriptions[eventStr];
    };

    /**
     * 
     * @param {*} eventStr 
     * @param {*} consumer 
     * @returns 
     */
    var getEventSubscriber = function (realmId, eventStr, consumer) {
        consumer = consumer || Constants.ANONYMOUS;
        var subscriptions = getEventSubscriptions(realmId, eventStr);

        subscriptions[consumer] = subscriptions[consumer] || {subscribeTos: new Set()};
        return subscriptions[consumer];
    };

    /**
     * @todo
     * Each event may be unqiue, deal with later
     * 
     * @param {*} producer 
     */

    var getProducerMetaInfo = function (realmId, producer) {
        producer = producer || Constants.ANONYMOUS;
        var realm = getRealm(realmId);
        realm.producers[producer] = realm.producers[producer] || {subscribers: new Set(), realm: realmId};
        return realm.producers[producer];
    };

    /**
     * 
     * @param {*} consumer 
     */

    var getConsumerMetaInfo = function (realmId, consumer) {
        consumer = consumer || Constants.ANONYMOUS;
        var realm = getRealm(realmId);
        realm.consumers[consumer] = realm.consumers[consumer] || {name: consumer, subscribeTos: new Set(), realm: realmId};
        return realm.consumers[consumer];
    };

    /**
     * 
     * @param {*} consumer 
     */

    var deleteConsumerFromSubscriptions = function (realmId, consumer) {
        var subscriptions = getRealm(realmId).subscriptions;
        for (var event in subscriptions) {
            if (subscriptions[event][consumer])
                delete subscriptions[event][consumer];
        }
    };

    /**
     * Actually we don't need to delete the subscription if the consumer lost connection, do we? 
     */

    var deleteProducerFromSubscriptions = function (realmId, producer) {
        var subscriptions = getRealm(realmId).subscriptions;
        for (var event in subscriptions) {
            for (var consumer in subscriptions[event]) {
                var subscription = getEventSubscriber(realmId, event, consumer);

                subscription.subscribeTos.forEach(function (name) {
                    if (name == producer) {
                        delete subscriptions[event][consumer];

                        var size = 0;
                        for (var key in subscriptions[event])
                            ++size;

                        if (size === 0)
                            delete subscriptions[event];
                    }
                });
            }
        }
    };

    /**
     * 
     * @param {*} producer 
     */

    var getSubscribersByProducer = function (realmId, producer) {
        var ids = {};
        var subscriptions = getRealm(realmId).subscriptions;

        for (var key in subscriptions) {
            var event = key;
            for (var consumer in subscriptions[event]) {
                var subscription = getEventSubscriber(realmId, event, consumer);

                if (subscription.subscribeTos)
                    subscription.subscribeTos.forEach(function (name) {
                        if (name === producer) {
                            if (!ids[subscription.id]) {
                                ids[subscription.id] = {};
                                ids[subscription.id].events = new Set();
                                ids[subscription.id].name = subscription.name;
                            }
                            ids[subscription.id].events.add(event);
                        }
                    });
            }
        }

        return ids;
    };

    /**
     * 
     * @param {*} p 
     */

    this.start = function (p) {
        var self = this;

        var port = p || this.options.port || Constants.DEFAULT_PORT;
        ensureAdminToken();

        if (self.logger) {
            self.logger.log("                                        ");
            self.logger.log(" | |_ _   _  ___        _ __ ___   __ _ ");
            self.logger.log(" | __| | | |/ _ \\ _____| '_ ` _ \\ / _` |");
            self.logger.log(" | |_| |_| | (_) |_____| | | | | | (_| |");
            self.logger.log("  \\__|\\__, |\\___/      |_| |_| |_|\\__, |");
            self.logger.log("      |___/                          |_|");
            self.logger.log("                                        ");
            self.logger.log('Message server version: ' + pak.version);
            self.logger.log('Now listening on localhost:' + port);
        }

        this.create(io);

        // creating the message server
        app.listen(port);
        if (process.send && typeof process.send === 'function')
            process.send("Server started");
    };

    /**
     * Load and hot-watch a JSON settings file.
     *
     * Settings in the file are deep-merged into the current settings on every
     * change.  Auth rules (tokens, realm requirements) take effect immediately
     * for all new connections and authorization checks — no restart needed.
     *
     * Example settings file:
     * {
     *   "auth": {
     *     "enabled": true,
     *     "realms": {
     *       "acme":   { "required": true  },
     *       "public": { "required": false }
     *     },
     *     "tokens": [
     *       { "token": "secret", "realm": "acme", "role": "both" }
     *     ]
     *   }
     * }
     *
     * Send SIGHUP to the process to force a reload without a file change.
     *
     * @param {string} filePath  Path to the JSON settings file.
     * @param {object} [opts]    Options forwarded to Settings#watch().
     * @returns {Server}         this, for chaining.
     */
    this.loadSettings = function (filePath, opts) {
        var self = this;
        loadedSettingsFile = path.resolve(filePath);

        if (!fs.existsSync(loadedSettingsFile)) {
            var dir = path.dirname(loadedSettingsFile);
            if (!fs.existsSync(dir))
                fs.mkdirSync(dir, {recursive: true});
            fs.writeFileSync(loadedSettingsFile, JSON.stringify(this.settings.get(), null, 2) + '\n');
        }

        this.settings.on('change', function (next, prev) {
            var prevAuth = prev.auth || {};
            var nextAuth = next.auth || {};

            // Log realm-level auth changes so operators can verify hot-reload worked.
            var prevRealms = prevAuth.realms || {};
            var nextRealms = nextAuth.realms || {};
            var allRealms  = Object.keys(Object.assign({}, prevRealms, nextRealms));

            allRealms.forEach(function (r) {
                var wasRequired = prevRealms[r] && prevRealms[r].required;
                var isRequired  = nextRealms[r] && nextRealms[r].required;
                if (wasRequired !== isRequired)
                    self.logger.log("Settings reload: realm '" + r + "' auth.required changed: " + wasRequired + " → " + isRequired);
            });

            var wasEnabled = !!prevAuth.enabled;
            var isNowEnabled = !!nextAuth.enabled;
            if (wasEnabled !== isNowEnabled)
                self.logger.log("Settings reload: auth.enabled changed: " + wasEnabled + " → " + isNowEnabled);

            var tokenCountPrev = (prevAuth.tokens || []).length;
            var tokenCountNext = (nextAuth.tokens || []).length;
            if (tokenCountPrev !== tokenCountNext)
                self.logger.log("Settings reload: auth.tokens count changed: " + tokenCountPrev + " → " + tokenCountNext);

            ensureAdminToken();
            self.logger.log("Settings hot-reloaded from " + filePath);
        });

        this.settings.on('error', function (err) {
            self.logger.error("Settings error: " + err.message);
        });

        this.settings.watch(filePath, opts);
        return this;
    };

    /**
     * Force a reload of the watched settings file (no-op if none is watched).
     * Useful for testing or triggering a reload programmatically.
     *
     * @returns {Server}
     */
    this.reloadSettings = function () {
        this.settings.reload();
        return this;
    };

     /**
      * Create the queue
      */

     this.create = function (io) {
        // 
        var self = this;
        ensureAdminToken();

        // maintain a request table for whom is requesting what
        // 1 success, 

        // Pending chunk transfers keyed by "<socketId>:<transferId>"
        var pendingChunks = {};

        // creating a new websocket then wait for connection
        io.sockets.on('connection', function(socket) {
            if (!isAuthEnabled()) {
                // Auth globally off — grant default realm immediately.
                socket.tyoAuth = {authenticated: true, realm: DEFAULT_REALM, role: 'both'};
            }
            // Auth is on but the client may connect to an open realm without a
            // token.  We assign the realm when AUTHENTICATION arrives (or when
            // they first register as PRODUCER/CONSUMER with realm in the payload).

            function currentRealmId () {
                return getSocketRealmId(socket);
            }

            function currentRealm () {
                return getSocketRealm(socket);
            }

            function authorize (eventName, roles) {
                if (!isAuthEnabled())
                    return true;

                if (!socket.tyoAuth || !socket.tyoAuth.authenticated) {
                    // If the socket is trying to reach a realm that has auth
                    // disabled, grant access to that realm without a token.
                    var desiredRealm = (socket._pendingRealm) || DEFAULT_REALM;
                    if (!isAuthRequiredForRealm(desiredRealm)) {
                        socket.tyoAuth = {authenticated: true, realm: desiredRealm, role: 'both'};
                        return true;
                    }
                    sendAuthFail(socket, 401, "Authentication required before " + eventName);
                    return false;
                }

                // Re-check: if realm auth requirement changed since login, honour the
                // new setting for the next event (existing session keeps its role).
                if (!isAuthRequiredForRealm(socket.tyoAuth.realm)) {
                    // Realm became open — keep auth status but don't block.
                    return true;
                }

                if (roles && roles.length > 0 && !roleAllows(socket.tyoAuth.role, roles)) {
                    sendAuthFail(socket, 403, "Role '" + socket.tyoAuth.role + "' is not allowed to send " + eventName);
                    return false;
                }

                return true;
            }

            function onAuthorized (eventName, roles, handler) {
                socket.on(eventName, function () {
                    if (!authorize(eventName, roles))
                        return;
                    handler.apply(this, arguments);
                });
            }

            var setupConsumer = function (consumer, consumerId) {
                // unlike producer, consumer doesn't need to know the status of the producer
                var consumerMeta = getConsumerMetaInfo(currentRealmId(), consumer);
                consumerMeta.id = consumerId || consumerMeta.id;
                consumerMeta.socket = socket.id;
                consumerMeta.online = true;
                return consumerMeta;
            };

            var setupProducer = function (producer, producerId) {
                // unlike producer, producer doesn't need to know the status of the producer
                var producerMeta = getProducerMetaInfo(currentRealmId(), producer);
                producerMeta.id = producerId || producerMeta.id;
                producerMeta.socket = socket.id;
                producerMeta.online = true;
                return producerMeta;
            };

            function sendErrorMessage (msg) {
                sendErrorMessageById(socket.id, msg);
            }

            function sendErrorMessageById (id, msg) {
                server.send(id, 'ERROR', msg);
            }
            
            /**
             *  system message all CAPS
             * 
             * @param {*} event 
             * @param {*} producer 
             * @param {*} consumer 
             * @param {*} consumerId 
             */
            function subscribeMessage (event, producer, consumer, consumerId, scope) {
                var eventStr;

                server.logger.info("Consumer (name: " + consumer + ", id: " + socket.id + ") subscribing to event '" + event + "' from producer '" + producer + "'");

                eventStr = eventManager.toConsumerEvent(event, producer, scope != Constants.SCOPE_ALL);

                // id is the message subscriber's id
                // id = socket.id;

                // register consumer if it hasn't done so
                var consumerMeta = getConsumerMetaInfo(currentRealmId(), consumer);
                if (!consumerMeta.socket)
                    setupConsumer(consumer, consumerId);

                var subscription = getEventSubscriber(currentRealmId(), eventStr, consumer);
                // the subscription is neither confirmed or authorized
                subscription.id = consumerMeta.id;
                subscription.acked = false;
                subscription.name = consumer;

                var subscribeTos;
                
                subscribeTos = consumerMeta.subscribeTos || new Set();

                if (!subscribeTos.has(producer)) {
                    subscribeTos.add(producer);
                    subscription.subscribeTos.add(producer);
                }
                
                var producerMeta;
                var status = true;
                if (producer !== Constants.ALL_PUBLISHERS) {
                    producerMeta = getProducerMetaInfo(currentRealmId(), producer);
                    sendSubscriptionMessageToProducer(eventStr, producerMeta, consumerMeta, status);
                }
                else {
                    for (var name in currentRealm().producers) {
                        if (name === consumer)
                            continue;

                        producerMeta = getProducerMetaInfo(currentRealmId(), name);
                        sendSubscriptionMessageToProducer(eventStr, producerMeta, consumerMeta, status);
                    }
                }
            }

            /**
             * 
             * @param {*} eventStr 
             * @param {*} producerMeta 
             * @param {*} consumerMeta 
             * @param {*} status 
             */
            function sendSubscriptionMessageToProducer(eventStr, producerMeta, consumerMeta, status) {
                var consumer = consumerMeta.name;

                if (producerMeta.online) {
                    if (!producerMeta.subscribers.has(consumer))
                        producerMeta.subscribers.add(consumer);

                    sendSubscriptionMessageWithConsumerInfo(producerMeta, [eventStr], consumerMeta, status);

                    var subscription = getEventSubscriber(currentRealmId(), eventStr, consumer);

                    subscription.acked = true;
                    subscription.subscribeToId = producerMeta.id;

                    // @todo
                    // send subscription confirmation / rejection here
                    
                }
            }
            
            // send subscription message
            function sendSubscriptionMessage(events, producerMeta, consumerMeta, status) {
                if (producerMeta && producerMeta.id)
                    sendSubscriptionMessageWithConsumerInfo(producerMeta, events,consumerMeta, status);
            }

            // it seems the new updates weren't pushed to the remote repo
            function sendSubscriptionMessageWithConsumerInfo(producerMeta, events, consumerMeta, status) {
                if (status === null)
                    status = true;

                var onSubscribeEvent = eventManager.toOnSubscribeEvent(producerMeta.id);

                sendMessage(producerMeta.socket, 
                    onSubscribeEvent, 
                    {
                        name:consumerMeta.name, 
                        id:consumerMeta.id, 
                        socket:consumerMeta.socket, 
                        events:events, online:status
                    },
                    consumerMeta.name
                    );
            }

            // subscribe message
            onAuthorized('SUBSCRIBE', ['consumer'], function (event) {
                if (typeof event === "string") 
                    try {
                        event = JSON.parse(event);
                    }
                    catch (e) {
                        server.logger.warn("SUBSCRIBE: failed to parse event JSON: " + e);
                        return;
                    }
                if ((typeof event === 'object' && event.event)) {
                    var targetEvent;
                    var producer;
                    var consumer;
                    var id;
                    var scope;

                    producer = event.producer;
                    consumer = event.consumer;
                    id = event.id || socket.id;
                    targetEvent = event.event; 
                    producer = producer || Constants.ANONYMOUS;
                    consumer = consumer || Constants.ANONYMOUS;
                    scope = event.scope || Constants.SCOPE_DEFAULT;

                    subscribeMessage(targetEvent, producer, consumer, id, scope);

                    // can't do it in this scope, hasn't figured out why
                    // socket.on(event, function (data) {
                    //     self.logger.log('Received subscribed message: ' + event + ', data: ' + data);

                    //     for (var key in subscriptions[event]) {
                    //         if (subscriptions[event][key])
                    //             self.send(key, event, data);
                    //     }
                    // });
                }
                else {
                    var msg = "Message name should be a object";
                    if (server.logger) {
                        server.logger.warn("SUBSCRIBE: incorrect message format (event must be an object with .event): " + JSON.stringify(event));
                    }
                    sendErrorMessage(msg);
                }
            });

            /**
             * 
             */
            onAuthorized('UNSUBSCRIBE', ['consumer'], function (data) {
                var subscriptions = currentRealm().subscriptions;
                if (subscriptions[data] && subscriptions[data][socket.id]) {
                    delete subscriptions[data][socket.id];
                }
            });

            /**ƒ
             * 
             */

            onAuthorized('DEBUG', [], function (data) {
                if (server.logger)
                    server.logger.log('Received DEBUG message: ' + data);
            });

            /**
             * DISCONNECT from server
             */

             onAuthorized('QUIT', [], function (id) {
                if (id === socket.id)
                    socket.disconnect();
             });

            /**
             * Send the message for subscriber(s)' consumption
             * 
             * we need to send two sets of messages one for single event receiver and one for all-event receivers
             * 
             */

            function sendConsumeMessage (socketId, event, message, producer) {
                var eventStr = eventManager.toConsumeEvent(event);
                var str = JSON.stringify(message);
                var chunkSize = 256 * 1024; // 256 KB — keep frames well under maxHttpBufferSize

                if (str.length <= chunkSize) {
                    sendMessage(socketId, eventStr, message, producer);
                    return;
                }

                // Large message — send as ordered chunks; subscriber reassembles before dispatching
                var total = Math.ceil(str.length / chunkSize);
                var transferId = Date.now().toString(36) + '-' + Math.random().toString(36).slice(2);
                for (var i = 0; i < total; i++) {
                    server.send(socketId, 'CONSUME_CHUNK', {
                        transferId: transferId,
                        event:      eventStr,
                        index:      i,
                        total:      total,
                        data:       str.slice(i * chunkSize, (i + 1) * chunkSize)
                    });
                }
            }

            /**
             * we need to send two sets of messages one for single event receiver and one for all-event receivers
             * 
             * @param {*} event 
             * @param {*} message 
             * @param {*} producer 
             */

            function broadcastConsumeMessage (event, message, producer) {
                var eventStr = eventManager.toConsumeEvent(event);
                var msgObj = {event:event, message:message, from:producer};
                var eventAll = eventManager.toConsumeEventAll(producer);

                // setTimeout(function () {
                    broadcastVolatileMessage(eventAll, msgObj);
                //}, 400);

                broadcastMessage(eventStr, msgObj);
            }

            /**
             * Send socket message
             * 
             */

            function sendMessage (id, event, message, from) {
                if (!id) {
                    server.logger.error("sendMessage: null socket — event: " + event
                        + (from ? ", from: " + JSON.stringify(from) : "")
                        + ", message: " + JSON.stringify(message));
                    return;
                }
                server.logger.debug("sendMessage → " + id + "  event: " + event + "  message: " + JSON.stringify(message));
                server.send(id, event, message);
                // server.broadcast(event, message);
            }

            /**
             * Send socket volatile message
             * 
             */

             function sendVolatileMessage (id, event, message) {
                if (!id) {
                    server.logger.error("sendVolatileMessage: null socket — event: " + event + ", message: " + JSON.stringify(message));
                    return;
                }
                server.logger.debug("sendVolatileMessage → " + id + "  event: " + event + "  message: " + JSON.stringify(message));
                server.volatile(event, message, id);
            }

            /**
             * Send volatile message
             * 
             */

            function broadcastVolatileMessage (event, message) {
                server.logger.debug("broadcastVolatileMessage  event: " + event + "  message: " + JSON.stringify(message));
                getCurrentRealmSocketIds().forEach(function (socketId) {
                    server.volatile(event, message, socketId);
                });
            }

            /**
             * 
             * @param {*} event 
             * @param {*} message 
             */

            function broadcastMessage (event, message) {
                server.logger.debug("broadcastMessage  event: " + event + "  message: " + JSON.stringify(message));
                getCurrentRealmSocketIds().forEach(function (socketId) {
                    server.send(socketId, event, message);
                });
            }

            function getCurrentRealmSocketIds () {
                var ids = new Set();
                var realm = currentRealm();
                Object.keys(realm.producers).forEach(function (name) {
                    if (realm.producers[name].socket)
                        ids.add(realm.producers[name].socket);
                });
                Object.keys(realm.consumers).forEach(function (name) {
                    if (realm.consumers[name].socket)
                        ids.add(realm.consumers[name].socket);
                });
                return ids;
            }

            /**
             * 
             */

            function generateMessage (event, message, producer) {
                producer = producer || Constants.ANONYMOUS;

                var msgObj = {event:event, message:message, from:producer};

                let subscriptionEvent = eventManager.toConsumerEvent(event, producer);
                let subscriptionEventAll = eventManager.toConsumerEventAll(producer);

                var targetRealmIds = [currentRealmId()];
                if (currentRealmId() !== REALM_ALL && realms[REALM_ALL])
                    targetRealmIds.push(REALM_ALL);

                targetRealmIds.forEach(function (targetRealmId) {
                    [subscriptionEvent, subscriptionEventAll].forEach(function (eventStr) {

                        var subscriptions = getEventSubscriptions(targetRealmId, eventStr);
                        for (var consumer in subscriptions) {
                            var subscription = subscriptions[consumer];
                            var consumerMeta = getConsumerMetaInfo(targetRealmId, subscription.name);

                            var ar = Array.from(consumerMeta.subscribeTos);
                            for (var i = 0; i < ar.length; ++i) {
                                var name = ar[i];
                                if (name === Constants.ALL_PUBLISHERS || name === producer) {
                                    sendConsumeMessage(consumerMeta.socket, eventStr, msgObj, producer);
                                    break;
                                }
                            }
                        }
                    });
                });
                
            }

            /**
             * Relay message from producer to consumer
             * the message has to an object containing event, message and producer name
             */

            function handleProduce(obj) {
                var producerName = obj.from;
                var event = obj.event;
                var message = obj.message;

                var producerMeta = getProducerMetaInfo(currentRealmId(), producerName);

                if (!producerMeta.socket)
                    setupProducer(producerName, obj.id);

                if (obj.method && obj.method === 'broadcast')
                    broadcastConsumeMessage(event, message, producerName);
                else
                    generateMessage(event, message, producerName);
            }

            onAuthorized('PRODUCE', ['producer'], function (msg) {
                let obj;
                if (typeof msg === "string")
                    try {
                        obj = JSON.parse(msg);
                    }
                    catch (e) {
                        server.logger.warn("PRODUCE: failed to parse message JSON: " + msg);
                        return;
                    }
                else
                    obj = msg;

                handleProduce(obj);
            });

            /**
             * Handle one chunk of a large message.
             * When all chunks arrive the reassembled message is processed via handleProduce.
             */
            onAuthorized('PRODUCE_CHUNK', ['producer'], function (chunk) {
                if (typeof chunk === 'string')
                    try { chunk = JSON.parse(chunk); }
                    catch (e) { server.logger.warn("PRODUCE_CHUNK: failed to parse JSON: " + e); return; }

                var key = socket.id + ':' + chunk.transferId;

                if (!pendingChunks[key]) {
                    pendingChunks[key] = { parts: new Array(chunk.total), received: 0 };
                }

                var transfer = pendingChunks[key];
                transfer.parts[chunk.index] = chunk.data;
                transfer.received++;

                if (transfer.received === chunk.total) {
                    delete pendingChunks[key];
                    var fullStr = transfer.parts.join('');
                    var assembled;
                    try {
                        assembled = JSON.parse(fullStr);
                    } catch (e) {
                        server.logger.warn("PRODUCE_CHUNK: failed to parse reassembled message: " + e);
                        return;
                    }
                    handleProduce(assembled);
                }
            });

            /**
             * On a consumer is ready
             */

            onAuthorized('CONSUMER', ['consumer'], function (consumer) {
                if (typeof consumer === "string")
                    try {
                        consumer = JSON.parse(consumer);
                    }
                    catch (e) {
                        server.logger.warn("CONSUMER: failed to parse JSON: " + consumer);
                        return;
                    }

                if (typeof consumer.name !== "string") {
                    server.logger.warn("CONSUMER: missing or non-string name field: " + JSON.stringify(consumer));
                    sendErrorMessage({message: "Incorrect consumer's name", code: -1});
                    return;
                }

                // Reject duplicate consumer names: if an existing live socket is already
                // registered under this name, the new connection is a misconfiguration
                // (e.g. two instances sharing the same app_id).  Disconnect the newcomer
                // immediately so the existing consumer is not silently displaced.
                var existingMeta = currentRealm().consumers[consumer.name];
                if (existingMeta && existingMeta.socket && existingMeta.socket !== socket.id) {
                    var existingSocket = io.sockets.sockets.get(existingMeta.socket);
                    if (existingSocket && existingSocket.connected) {
                        server.logger.critical("DUPLICATE CONSUMER: '" + consumer.name + "' already registered with socket " + existingMeta.socket + ". Rejecting new socket " + socket.id + " — check app_id configuration.");
                        sendErrorMessage({message: "Duplicate consumer name: '" + consumer.name + "' is already registered. Use a unique app_id per broker/instance.", code: -3});
                        socket.disconnect();
                        return;
                    }
                }

                server.logger.log("Consumer joined: name='" + consumer.name + "'  socket=" + socket.id);

                var event;
                var message = {event: 'CONNECT', socket: socket.id};
                let consumerMeta = setupConsumer(consumer.name, consumer.id || socket.id);
                message.id = consumerMeta.id;
                let subscribedTos = consumerMeta.subscribeTos;
                if (subscribedTos && subscribedTos.size > 0) {
                    let producers = Array.from(subscribedTos);
                    producers.forEach(function (producerName) {
                        var producerMeta = getProducerMetaInfo(currentRealmId(), producerName);

                        if (producerMeta && producerMeta.socket) {
                            message.consumer = consumer.name;
                            event = eventManager.toOnConnectEvent(producerMeta.id);
                            server.logger.debug("Notifying producer '" + producerName + "' of consumer reconnect — event: " + event);
                            sendMessage(producerMeta.socket, event, message, consumer.name);
                        }
                    });
                }
            });

            /**
             * On producer is ready
             */
            onAuthorized('PING', [], function (msg, callback) {
                server.logger.debug("PING from " + socket.id + ": " + JSON.stringify(msg));
                if (callback) {
                    const response = Object.assign({}, msg, { pong: "PONG", timestamp: new Date().toISOString() });
                    callback(JSON.stringify(response));
                }
            });

            onAuthorized('PRODUCER', ['producer'], function (msg) {
                let producer;
                if (typeof msg === "string") 
                    try {
                        producer = JSON.parse(msg);
                    }
                    catch (e) {
                        server.logger.warn("PRODUCER: failed to parse JSON: " + msg);
                        return;
                    }
                else
                    producer = msg;

                if (typeof producer.name !== "string") {
                    server.logger.warn("PRODUCER: missing or non-string name field: " + JSON.stringify(producer));
                    sendErrorMessage({message: "Incorrect producer's name", code: -1});
                    return;
                }

                var producerName = producer.name;
                var producerId = producer.id || socket.id;

                server.logger.log("Producer joined: name='" + producer.name + "'  socket=" + socket.id + "  id=" + producerId);
                // var producerMeta = getProducerMetaInfo(producerName);

                /**
                 * @todo
                 * 
                 *  Already a producer with such a name exists
                 */
                // if (producerMeta) {
                //     // @todo
                //     socket.disconnect();
                //     return;
                // }

                var producerMeta = getProducerMetaInfo(currentRealmId(), producerName); // producers[producerName] = producers[producerName] || {subscribers: new Set()};
                var resendSubscriptionMessage = false;

                if (producerMeta.id && producerMeta.id !== producerId) {
                    sendErrorMessageById(producerMeta.id, "The same producer newly joined");

                    // try {
                    //     if (producerMeta.socket)
                    //         producerMeta.socket.disconnect();
                    // }
                    // catch (err) {
                    //     server.logger.error("Failed to disconnect previous joind producer: " + producerMeta.id);
                    // }

                    resendSubscriptionMessage = true;
                }

                setupProducer(producerName, producerId);

                // in case the consumer connect before producer is ready
                var ids = getSubscribersByProducer(currentRealmId(), producerName);

                var event;
                var message = {event: 'CONNECT', socket: socket.id};

                for (var id in ids) {
                    var obj = ids[id];
                    var consumer = obj.name;
                    var events = [];

                    var consumerMeta = getConsumerMetaInfo(currentRealmId(), consumer);

                    if (!producerMeta.subscribers.has(consumer))
                        producerMeta.subscribers.add(consumer);
                    
                    Array.from(obj.events).forEach(function (event) {
                        var subscription = getEventSubscriber(currentRealmId(), event, consumer);

                        if (resendSubscriptionMessage || !subscription.acked) {
                            events.push(event);

                            subscription.acked = true;
                            subscription.subscribeToId = socket.id;
                        }
                    });

                    if (events.length > 0) {
                        sendSubscriptionMessage(events, producerMeta, consumerMeta, consumerMeta.online);
                    }

                    // now we send the producer online message to the consumer(s)
                    message.producer = producerName;
                    event = eventManager.toOnConnectEvent(consumerMeta.id);
                    server.logger.log("Producer '" + producerName + "' online — notifying consumer '" + consumer + "' via event: " + event);
                    if (consumerMeta.socket)
                        sendMessage(consumerMeta.socket, event, message, producerName);
                    else
                        server.logger.debug("Trying to inform consumer (" + consumerMeta.name + ") that producer (" + producerName + ") is online but it seems the consumer is offline");
                }

            });

            /**
             * On HELLO
             */

            onAuthorized('HELLO', [], function (message) {
                server.logger.info("HELLO from '" + message.name + "' (type: " + message.type + ")  socket=" + socket.id);
            });

            socket.on('AUTHORIZATION_REQUEST', function (message, callback) {
                if (typeof message === 'string')
                    try {
                        message = JSON.parse(message);
                    }
                    catch (e) {
                        var parseFail = {ok: false, code: 400, message: 'Invalid authorization request JSON'};
                        socket.emit('AUTHORIZATION_REQUEST_FAIL', parseFail);
                        if (callback) callback(parseFail);
                        return;
                    }

                if (!message || typeof message.realm !== 'string' || typeof message.client_id !== 'string'
                        || typeof message.client_token !== 'string' || typeof message.client_name !== 'string') {
                    var invalid = {ok: false, code: 400, message: 'Authorization request requires realm, client_id, client_token, and client_name'};
                    socket.emit('AUTHORIZATION_REQUEST_FAIL', invalid);
                    if (callback) callback(invalid);
                    return;
                }

                var role = normalizeRole(message.role);
                if (['producer', 'consumer', 'both', 'admin'].indexOf(role) < 0)
                    role = 'both';

                var request = {
                    request_id: 'authreq-' + Date.now().toString(36) + '-' + crypto.randomBytes(6).toString('hex'),
                    status: 'pending',
                    realm: message.realm,
                    role: role,
                    client_id: message.client_id,
                    client_name: message.client_name,
                    client_token: message.client_token,
                    client_token_hash: hashToken(message.client_token),
                    challenge_response: message.challenge_response || message.challengeResponse || null,
                    created_at: new Date().toISOString(),
                    socket_id: socket.id
                };

                saveLatestAuthorizationRequest(request);

                var response = {ok: true, request_id: request.request_id, status: request.status};
                socket.emit('AUTHORIZATION_REQUEST_OK', response);
                if (callback) callback(response);
            });

            socket.on('AUTHORIZATION_NEXT', function (message, callback) {
                message = message || {};
                var body = message.body || {};
                var verified = verifyManagerProof('AUTHORIZATION_NEXT', body, message.proof);
                if (!verified.ok) {
                    if (callback) callback(verified);
                    else socket.emit('AUTHORIZATION_FAIL', verified);
                    return;
                }

                var request = nextPendingAuthorizationRequest(body);
                var response = {ok: true, request: publicAuthorizationRequest(request)};
                if (callback) callback(response);
                else socket.emit('AUTHORIZATION_NEXT_RESULT', response);
            });

            socket.on('AUTHORIZATION_DECIDE', function (message, callback) {
                message = message || {};
                var body = message.body || {};
                var verified = verifyManagerProof('AUTHORIZATION_DECIDE', body, message.proof);
                if (!verified.ok) {
                    if (callback) callback(verified);
                    else socket.emit('AUTHORIZATION_FAIL', verified);
                    return;
                }

                var request = authorizationRequestMap[body.request_id];
                if (!request || request.status !== 'pending') {
                    var missing = {ok: false, code: 404, message: 'Pending authorization request not found'};
                    if (callback) callback(missing);
                    else socket.emit('AUTHORIZATION_FAIL', missing);
                    return;
                }

                request.status = body.approved ? 'approved' : 'rejected';
                request.decided_at = new Date().toISOString();
                request.decision_reason = body.reason || null;

                if (body.approved) {
                    request.role = normalizeRole(body.role || request.role);
                    addRuntimeAuthToken(request.client_token, request.realm, request.role, {
                        client_id: request.client_id,
                        client_name: request.client_name,
                        approved_at: request.decided_at
                    });
                    server.send(request.socket_id, 'AUTHORIZATION_APPROVED', {
                        request_id: request.request_id,
                        realm: request.realm,
                        role: request.role
                    });
                }
                else {
                    server.send(request.socket_id, 'AUTHORIZATION_REJECTED', {
                        request_id: request.request_id,
                        reason: request.decision_reason
                    });
                }

                var response = {ok: true, request: publicAuthorizationRequest(request)};
                if (callback) callback(response);
                else socket.emit('AUTHORIZATION_DECIDE_RESULT', response);
            });

            socket.on('AUTH_MANAGEMENT_COMMAND', function (message, callback) {
                message = message || {};
                var body = message.body || {};
                var verified = verifyManagerProof('AUTH_MANAGEMENT_COMMAND', body, message.proof);
                if (!verified.ok) {
                    if (callback) callback(verified);
                    else socket.emit('AUTH_MANAGEMENT_FAIL', verified);
                    return;
                }

                var response = applyAuthManagementCommand(body);
                if (callback) callback(response);
                else socket.emit('AUTH_MANAGEMENT_RESULT', response);
            });

            /**
             * @todo
             * On Authentication
             */
            socket.on('AUTHENTICATION', function (message) {
                if (typeof message === 'string')
                    try {
                        message = JSON.parse(message);
                    }
                    catch (e) {
                        server.logger.warn("AUTHENTICATION: failed to parse JSON: " + message);
                        sendAuthFail(socket, 401, "Invalid authentication payload");
                        return;
                    }

                if (!isAuthEnabled()) {
                    socket.tyoAuth = {authenticated: true, realm: DEFAULT_REALM, role: 'both'};
                    socket.emit('AUTH_OK', {realm: DEFAULT_REALM, role: 'both'});
                    return;
                }

                if (socket.tyoAuth && socket.tyoAuth.authenticated) {
                    sendAuthFail(socket, 403, "Socket is already authenticated");
                    return;
                }

                // Client may declare a desired realm upfront so the server can
                // check its auth requirement before token validation.
                var desiredRealm = (message && typeof message.realm === 'string' && message.realm)
                    ? message.realm : null;

                if (desiredRealm)
                    socket._pendingRealm = desiredRealm;

                // Allow token-less access to explicitly open realms.
                if (desiredRealm && !isAuthRequiredForRealm(desiredRealm)) {
                    socket.tyoAuth = {
                        authenticated: true,
                        realm: desiredRealm,
                        role: 'both'
                    };
                    getRealm(desiredRealm);
                    server.logger.info("AUTHENTICATION: open realm '" + desiredRealm + "' — token not required, socket=" + socket.id);
                    socket.emit('AUTH_OK', {realm: desiredRealm, role: 'both'});
                    return;
                }

                if (!message || typeof message.token !== 'string' || !message.token) {
                    sendAuthFail(socket, 401, "Missing authentication token");
                    return;
                }

                validateToken(message.token).then(function (authResult) {
                    if (!authResult || !authResult.realm || !authResult.role) {
                        sendAuthFail(socket, 401, "Invalid authentication token");
                        return;
                    }

                    socket.tyoAuth = {
                        authenticated: true,
                        realm: String(authResult.realm),
                        role: normalizeRole(authResult.role)
                    };
                    getRealm(socket.tyoAuth.realm);
                    server.logger.info("AUTHENTICATION: token accepted — realm='" + socket.tyoAuth.realm + "' role='" + socket.tyoAuth.role + "' socket=" + socket.id);
                    socket.emit('AUTH_OK', {realm: socket.tyoAuth.realm, role: socket.tyoAuth.role});
                }).catch(function (err) {
                    server.logger.warn("AUTHENTICATION: token validation failed: " + err.message);
                    sendAuthFail(socket, 401, "Authentication failed");
                });

            });

            /**
             * On Disconnect
             * 
             * Please be noted losing connection doesn't mean unsubscribing / stop producing
             * 
             * for unsubscribe / unpublish, see #UNSUBSCRIBE, #UNPUBLISH messages
             */

            socket.on('disconnect', function () {
                // Clean up any in-flight chunked transfers for this socket
                var prefix = socket.id + ':';
                Object.keys(pendingChunks).forEach(function (key) {
                    if (key.indexOf(prefix) === 0) delete pendingChunks[key];
                });

                var event;
                var message = {event: 'DISCONNECT', socket: socket.id};
                
                // var id = socket.id;

                /**
                 * @todo
                 * 
                 * update the registration information
                 * 
                 */
                // var isProducer = false;

                 // check if it is a producer
                var realm = currentRealm();
                for (var name in realm.producers) {
                    var producerMeta = realm.producers[name];
                    if (producerMeta.socket && producerMeta.socket === socket.id) {
                        // isProducer = true;
                        producerMeta.online = false;

                        producerMeta.subscribers.forEach (function (consumerName) {
                            var consumerMeta = getConsumerMetaInfo(currentRealmId(), consumerName);

                            if (consumerMeta) {
                                // consumerMeta.subscribeTos.delete(name);
                                message.producer = name;
                                event = eventManager.toOnDisconnectEvent(consumerMeta.id);
                                server.logger.warn("Producer disconnected: '" + name + "' — notifying consumer '" + consumerName + "' via event: " + event);
                                if (consumerMeta.socket)
                                    sendMessage(consumerMeta.socket, event, message, name);
                                else
                                    server.logger.debug("Trying to inform consumer that producer is offline but it seems the consumer is offline too");
                            }
                        });

                        producerMeta.socket = null;

                        // deleteProducerFromSubscriptions(name);
                        // no we are not gonna do it, as consumer still can wait for producer to come back online
                        // for whatever reasons it loses connection

                        // delete producers[name];

                        /**
                         * @todo
                         * 
                         * send disconn info to subscribers
                         */
                        break;
                    }
                }

                 // check if it is a consumer
                 // a producer could be also a consumer
                 //if (!isProducer) {
                     for (var consumerName in realm.consumers) {
                        var consumerMeta = realm.consumers[consumerName];
                        if (consumerMeta.socket && consumerMeta.socket === socket.id) {
                            server.logger.warn("Consumer disconnected: '" + consumerName + "'  socket=" + socket.id);

                            consumerMeta.online = false;

                            consumerMeta.subscribeTos.forEach( function (producerName) {
                                var producerMeta = getProducerMetaInfo(currentRealmId(), producerName);

                                if (producerMeta && producerMeta.socket) {
                                    message.consumer = consumerName;
                                    event = eventManager.toOnDisconnectEvent(producerMeta.id);
                                    server.logger.info("Notifying producer '" + producerName + "' of consumer '" + consumerName + "' disconnect — event: " + event);
                                    sendMessage(producerMeta.socket, event, message, consumerName);
                                    // producerMeta.subscribers.delete(consumerName);
                                }
                            }); 

                            consumerMeta.socket = null;
                            // deleteConsumerFromSubscriptions(consumerName);

                            // delete consumers[consumerName];
                            break;
                        }
                     }
                //  }
            });

        });

        /**
         * broadcast message to all connected sockets
         */

        this.broadcast = function (event, message) {
            io.emit(event, message);
        };

        /**
         * sending the volatile message to all connected sockets
         */

        this.volatile = function (event, message, id) {
            if (id) 
                io.to(id).volatile.emit(event, message);
            else
                io.volatile.emit(event, message);
        };

    
        /**
         * Send event / message to a particular endpoint
         */
    
        this.send = function (socketId, event, message) {
            io.to(socketId).emit(event, message);
        };


    };
}

module.exports = Server;
