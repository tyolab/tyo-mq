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
const attachRemoteNamespace = require('./remote-namespace');
const ClusterSync = require('./cluster');

// info
var eventManager    = require('./events');

const Constants = require('./constants');
const Logger    = require('./logger');
const Settings  = require('./settings');
const Storage   = require('./storage');

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
    var remoteNsp = null;
    var remoteIo = null;

    this.logger = new Logger('tyo-mq', { level: Logger.LOG });
    this.store = Storage.createStore(this.options);

    Object.defineProperty(this, 'remote', {
        get: function () { return remoteNsp; },
        enumerable: true
    });

    var app = http.createServer((req, res) => {
        if (!handleHttpApiRequest(req, res)) {
            res.writeHead(403);
            res.end();
        }
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
    var applyingPersistenceChange = false;
    var clusterSync = null;
    var applyingRemoteSettings = false;

    Object.defineProperty(this, 'cluster', {
        get: function () { return clusterSync; },
        enumerable: true
    });

    var getEnvPath = function () {
        return server.authOptions.env_file || process.env.TYO_MQ_ENV_FILE || '.env';
    };

    var getAdminTokenEnvName = function () {
        return server.authOptions.admin_token_env || 'TYO_MQ_ADMIN_TOKEN';
    };

    var generateToken = function () {
        return crypto.randomBytes(32).toString('hex');
    };

    var ensureRemoteNamespace = function (socketIo) {
        if (remoteNsp && remoteIo === socketIo)
            return remoteNsp;
        remoteIo = socketIo;
        remoteNsp = attachRemoteNamespace(socketIo, server.options.remote || {});
        return remoteNsp;
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

    var validateManagerProofEnvelope = function (proof) {
        if (!proof || !proof.nonce)
            return {ok: false, code: 401, message: 'Missing manager proof'};

        if (usedManagerNonces.has(proof.nonce))
            return {ok: false, code: 401, message: 'Manager proof nonce was already used'};

        return {ok: true};
    };

    var verifyProofWithSecrets = function (secrets, action, body, proof) {
        for (var i = 0; i < secrets.length; i++) {
            if (secrets[i] && adminSignature.verifyAdminProof(secrets[i], action, body || {}, proof))
                return true;
        }
        return false;
    };

    var markManagerProofUsed = function (proof) {
        usedManagerNonces.add(proof.nonce);
    };

    var getRealmConfig = function (realm) {
        var auth = server.authOptions || {};
        var authRealms = auth.realms || {};
        return authRealms[realm] || null;
    };

    // A name is "anonymous" when it is the bare ANONYMOUS placeholder or a
    // client-minted unique ANONYMOUS-<uuid> identity (no app_id was configured).
    var isAnonymousName = function (name) {
        return name === Constants.ANONYMOUS
            || (typeof name === 'string' && name.indexOf(Constants.ANONYMOUS + '-') === 0);
    };

    // Whether unnamed (ANONYMOUS / no app_id) producers and consumers may
    // register in a realm. An explicit realms.<id>.allow_anonymous wins;
    // otherwise only the open 'default' realm permits anonymous — configured
    // and named realms reject it unless they opt in.
    var isAnonymousAllowed = function (realmId) {
        var rc = getRealmConfig(realmId);
        if (rc) {
            if (typeof rc.allow_anonymous === 'boolean') return rc.allow_anonymous;
            if (typeof rc.allowAnonymous === 'boolean') return rc.allowAnonymous;
        }
        return realmId === DEFAULT_REALM;
    };

    var getRealmManagerKey = function (realm) {
        var realmConfig = getRealmConfig(realm);
        if (!realmConfig)
            return null;
        return realmConfig.manager_key || realmConfig.managerKey || null;
    };

    var verifyGlobalManagerProof = function (action, body, proof) {
        var envelope = validateManagerProofEnvelope(proof);
        if (!envelope.ok)
            return envelope;

        if (verifyProofWithSecrets(getAdminTokens(), action, body, proof)) {
            markManagerProofUsed(proof);
            return {ok: true, scope: 'global'};
        }

        return {ok: false, code: 401, message: 'Invalid manager proof'};
    };

    var verifyAuthorizationNextProof = function (body, proof) {
        body = body || {};
        var envelope = validateManagerProofEnvelope(proof);
        if (!envelope.ok)
            return envelope;

        if (verifyProofWithSecrets(getAdminTokens(), 'AUTHORIZATION_NEXT', body, proof)) {
            markManagerProofUsed(proof);
            return {ok: true, scope: 'global'};
        }

        if (!body.realm)
            return {ok: false, code: 401, message: 'Invalid manager proof'};

        var managerKey = getRealmManagerKey(body.realm);
        if (managerKey && adminSignature.verifyAdminProof(managerKey, 'AUTHORIZATION_NEXT', body, proof)) {
            markManagerProofUsed(proof);
            return {ok: true, scope: 'realm', realm: body.realm};
        }

        return {ok: false, code: 401, message: 'Invalid manager proof'};
    };

    var verifyAuthorizationDecisionProof = function (body, proof, request) {
        body = body || {};
        var envelope = validateManagerProofEnvelope(proof);
        if (!envelope.ok)
            return envelope;

        if (verifyProofWithSecrets(getAdminTokens(), 'AUTHORIZATION_DECIDE', body, proof)) {
            markManagerProofUsed(proof);
            return {ok: true, scope: 'global'};
        }

        if (!request || request.status !== 'pending')
            return {ok: false, code: 401, message: 'Invalid manager proof'};

        var managerKey = getRealmManagerKey(request.realm);
        if (managerKey && adminSignature.verifyAdminProof(managerKey, 'AUTHORIZATION_DECIDE', body, proof)) {
            markManagerProofUsed(proof);
            return {ok: true, scope: 'realm', realm: request.realm};
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

    var createStoreFromSettings = function (settings) {
        settings = settings || {};
        var storageOptions = Object.assign({}, settings.storage_options || settings.storageOptions || {});
        var storage = settings.storage || settings.store || 'memory';

        if (storage === 'custom') {
            var modulePath = storageOptions.module || storageOptions.module_path || settings.storage_module;
            if (!modulePath)
                throw new Error('custom storage requires storage_options.module');
            storage = require(path.isAbsolute(modulePath) ? modulePath : path.resolve(process.cwd(), modulePath));
        }

        return Storage.createStore({
            storage: storage,
            storage_options: storageOptions
        });
    };

    var publicPersistenceSettings = function () {
        var allSettings = server.settings.get() || {};
        var storage = allSettings.storage || allSettings.store || 'memory';
        var storageOptions = clone(allSettings.storage_options || allSettings.storageOptions || {});

        if (storage && typeof storage !== 'string')
            storage = 'custom';

        return {
            storage: storage,
            storage_options: storageOptions
        };
    };

    var persistenceSignature = function (settings) {
        settings = settings || {};
        return JSON.stringify({
            storage: settings.storage || settings.store || 'memory',
            storage_options: settings.storage_options || settings.storageOptions || {}
        });
    };

    var publicManagementSettings = function () {
        var auth = publicAuthSettings();
        auth.persistence = publicPersistenceSettings();
        return auth;
    };

    var normalizePersistenceSettings = function (body) {
        var storage = String(body.storage || body.backend || 'memory').toLowerCase();
        var allowed = {memory: true, sqlite: true, redis: true, custom: true};
        if (!allowed[storage])
            return {ok: false, code: 400, message: 'unsupported storage backend'};

        var storageOptions = Object.assign({}, body.storage_options || body.storageOptions || body.options || {});

        if (body.default_ttl !== undefined && body.default_ttl !== '')
            storageOptions.default_ttl = Number(body.default_ttl);
        if (!Number.isFinite(Number(storageOptions.default_ttl)) && storageOptions.default_ttl !== undefined)
            return {ok: false, code: 400, message: 'default_ttl must be a number'};

        if (storage === 'sqlite') {
            if (body.filename)
                storageOptions.filename = body.filename;
            if (body.path)
                storageOptions.filename = body.path;
        }

        if (storage === 'redis') {
            if (body.url)
                storageOptions.url = body.url;
            if (body.prefix)
                storageOptions.prefix = body.prefix;
        }

        if (storage === 'custom') {
            if (body.module)
                storageOptions.module = body.module;
            if (!storageOptions.module && !storageOptions.module_path)
                return {ok: false, code: 400, message: 'custom storage requires a module path'};
        }

        return {
            ok: true,
            settings: {
                storage: storage,
                storage_options: storageOptions
            }
        };
    };

    var applyPersistenceSettings = function (persistence) {
        var nextStore = createStoreFromSettings(persistence);
        var previousStore = server.store;
        server.store = nextStore;

        if (previousStore && previousStore !== nextStore && typeof previousStore.close === 'function') {
            try {
                var closeResult = previousStore.close();
                if (closeResult && typeof closeResult.catch === 'function')
                    closeResult.catch(function (err) {
                        server.logger.error("Previous storage close failed: " + err.message);
                    });
            }
            catch (err) {
                server.logger.error("Previous storage close failed: " + err.message);
            }
        }
    };

    var revokeAuthTokens = function (auth, body) {
        var token = body.token || null;
        var tokenHash = body.token_hash || body.tokenHash || null;
        var realm = body.realm || null;
        var clientId = body.client_id || body.clientId || null;
        var allowAdmin = !!body.allow_admin;

        if (!token && !tokenHash && !(realm && clientId))
            return {ok: false, code: 400, message: 'token, token_hash, or realm + client_id is required'};

        var removed = [];
        var kept = [];

        auth.tokens.forEach(function (entry) {
            var matches = false;
            if (token && entry.token === token)
                matches = true;
            if (tokenHash && entry.token && hashToken(entry.token) === tokenHash)
                matches = true;
            if (realm && clientId && entry.realm === realm && entry.client_id === clientId)
                matches = true;

            if (matches) {
                if (entry.realm === REALM_ALL && entry.role === 'admin' && !allowAdmin) {
                    kept.push(entry);
                    return;
                }
                removed.push(entry);
                return;
            }

            kept.push(entry);
        });

        if (removed.length === 0)
            return {ok: false, code: 404, message: 'matching revocable token not found'};

        auth.tokens = kept;
        return {
            ok: true,
            revoked: removed.map(function (entry) {
                return {
                    realm: entry.realm,
                    role: entry.role,
                    client_id: entry.client_id || null,
                    client_name: entry.client_name || null,
                    token_hash: entry.token ? hashToken(entry.token) : null
                };
            })
        };
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
        if (auth.realms) {
            Object.keys(auth.realms).forEach(function (realm) {
                var realmConfig = auth.realms[realm] || {};
                if (realmConfig.manager_key || realmConfig.managerKey) {
                    delete realmConfig.manager_key;
                    delete realmConfig.managerKey;
                    realmConfig.manager_key_configured = true;
                }
                if (realmConfig.key || realmConfig.preshared_key || realmConfig.presharedKey) {
                    delete realmConfig.key;
                    delete realmConfig.preshared_key;
                    delete realmConfig.presharedKey;
                    realmConfig.key_configured = true;
                }
            });
        }
        if (auth.jwt_secret)
            auth.jwt_secret = '<configured>';
        return auth;
    };

    var writeSettingsFile = function () {
        if (!loadedSettingsFile)
            return;
        var dir = path.dirname(loadedSettingsFile);
        if (!fs.existsSync(dir))
            fs.mkdirSync(dir, {recursive: true});
        fs.writeFileSync(loadedSettingsFile, JSON.stringify(server.settings.get(), null, 2) + '\n');
    };

    var persistSettings = function () {
        writeSettingsFile();
        if (clusterSync && !applyingRemoteSettings) {
            clusterSync.publishSettings(server.settings.get()).catch(function (err) {
                server.logger.error("Cluster settings publish failed: " + err.message);
            });
        }
    };

    // A peer published new settings: adopt them as the source of truth and
    // refresh the local file cache, without re-publishing (echo guard).
    var applyRemoteSettings = function (remoteSettings, revision) {
        applyingRemoteSettings = true;
        try {
            server.settings.replace(remoteSettings);
        }
        finally {
            applyingRemoteSettings = false;
        }
        writeSettingsFile();
        server.logger.info("Cluster settings applied" + (revision !== undefined ? " (revision " + revision + ")" : ""));
    };

    var initCluster = function () {
        if (clusterSync)
            return;

        // The raw constructor options keep injected redis clients intact;
        // the settings store (JSON-cloned) covers file-based configuration.
        var config = server.options.cluster || server.settings.get('cluster');
        if (!config || !config.enabled)
            return;

        var allSettings = server.settings.get() || {};
        var storageOptions = allSettings.storage_options || allSettings.storageOptions || {};

        try {
            clusterSync = new ClusterSync({
                prefix: config.prefix || config.channel_prefix || config.channelPrefix,
                redis_url: config.redis_url || config.redisUrl || config.url || storageOptions.url,
                client: config.client,
                subscriber: config.subscriber,
                node_id: config.node_id || config.nodeId,
                logger: server.logger
            });
        }
        catch (err) {
            server.logger.error("Cluster sync init failed: " + err.message);
            clusterSync = null;
            return;
        }

        clusterSync.ready = clusterSync.connect().then(function () {
            return clusterSync.onSettingsChange(function (settings, revision) {
                applyRemoteSettings(settings, revision);
            });
        }).then(function () {
            return clusterSync.fetchSettings();
        }).then(function (doc) {
            if (doc && doc.settings)
                applyRemoteSettings(doc.settings);
            else
                return clusterSync.publishSettings(server.settings.get());
        }).then(function () {
            server.logger.log("Cluster sync active (node " + clusterSync.nodeId + ")");
        }).catch(function (err) {
            server.logger.error("Cluster sync startup failed: " + err.message);
        });
    };

    var NONCE_CLAIM_TTL_MS = 10 * 60 * 1000; // 2x the proof timestamp window

    // Cluster-wide replay protection: a manager proof nonce may be used on
    // exactly one node. Resolves true when this node won the claim (or no
    // cluster is configured — the local nonce set still protects the node).
    var claimClusterNonce = function (proof) {
        if (!clusterSync || !proof || !proof.nonce)
            return Promise.resolve(true);
        return clusterSync.claimNonce(proof.nonce, NONCE_CLAIM_TTL_MS).catch(function (err) {
            server.logger.error("Cluster nonce claim failed: " + err.message);
            return true; // fail open: redis outage must not lock out managers
        });
    };

    // ── shared authorization requests ─────────────────────────────────────
    // In a cluster, pending authorization requests live in Redis so a manager
    // can poll and decide them from any node. The local in-memory maps keep
    // working unchanged for single-node deployments.

    var mirrorAuthRequestToCluster = function (request) {
        if (!clusterSync)
            return;
        clusterSync.getAuthRequests().then(function (doc) {
            Object.keys(doc).forEach(function (id) {
                var existing = doc[id];
                if (existing.status === 'pending' && existing.realm === request.realm
                        && existing.client_id === request.client_id) {
                    existing.status = 'superseded';
                    existing.superseded_at = request.created_at;
                }
            });
            doc[request.request_id] = request;
            return clusterSync.putAuthRequests(doc);
        }).catch(function (err) {
            server.logger.error("Cluster auth request mirror failed: " + err.message);
        });
    };

    var findNextAuthorizationRequest = function (filter) {
        if (!clusterSync)
            return Promise.resolve(nextPendingAuthorizationRequest(filter));
        return clusterSync.getAuthRequests().then(function (doc) {
            var pending = Object.keys(doc).map(function (id) { return doc[id]; })
                .filter(function (request) {
                    if (request.status !== 'pending') return false;
                    if (filter && filter.realm && request.realm !== filter.realm) return false;
                    return true;
                })
                .sort(function (a, b) { return String(a.created_at).localeCompare(String(b.created_at)); });
            return pending[0] || null;
        }).catch(function (err) {
            server.logger.error("Cluster auth request lookup failed: " + err.message);
            return nextPendingAuthorizationRequest(filter);
        });
    };

    var lookupAuthorizationRequest = function (requestId) {
        var local = authorizationRequestMap[requestId];
        if (!clusterSync)
            return Promise.resolve(local);
        return clusterSync.getAuthRequests().then(function (doc) {
            return doc[requestId] || local;
        }).catch(function () {
            return local;
        });
    };

    var persistAuthDecisionToCluster = function (request) {
        if (!clusterSync)
            return;
        clusterSync.getAuthRequests().then(function (doc) {
            doc[request.request_id] = request;
            return clusterSync.putAuthRequests(doc);
        }).then(function () {
            return clusterSync.publishAuthDecision(request);
        }).catch(function (err) {
            server.logger.error("Cluster auth decision publish failed: " + err.message);
        });
    };

    var isLocalRequester = function (request) {
        return !clusterSync || !request.node_id || request.node_id === clusterSync.nodeId;
    };

    var syncLocalAuthRequest = function (request) {
        var local = authorizationRequestMap[request.request_id];
        if (local && local !== request) {
            local.status = request.status;
            local.decided_at = request.decided_at;
            local.decision_reason = request.decision_reason;
            local.role = request.role;
        }
    };

    // ── opt-in HTTP observability surface (Phase 5, revised) ─────────────────
    //
    // Enabled with `http_api: { enabled: true }` (constructor options or
    // settings file) and served on the SAME port as the socket server.
    // Read-only: /health, /api/metrics, /api/stats, /api/realms/{realm}/dlq.
    // Disabled by default — without the option no HTTP endpoint exists.

    var currentIo = null;
    var metricsCounters = {};

    var incMetric = function (name, labels) {
        var labelKeys = labels ? Object.keys(labels).sort() : [];
        var key = name + '|' + labelKeys.map(function (k) { return k + '=' + labels[k]; }).join(',');
        var entry = metricsCounters[key] = metricsCounters[key] || {name: name, labels: labels || {}, value: 0};
        entry.value++;
    };

    var escapeLabelValue = function (value) {
        return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
    };

    var renderPrometheusMetrics = function () {
        var lines = [];
        var byName = {};
        Object.keys(metricsCounters).forEach(function (key) {
            var entry = metricsCounters[key];
            byName[entry.name] = byName[entry.name] || [];
            byName[entry.name].push(entry);
        });

        Object.keys(byName).sort().forEach(function (name) {
            lines.push('# TYPE ' + name + ' counter');
            byName[name].forEach(function (entry) {
                var labelKeys = Object.keys(entry.labels).sort();
                var labelStr = labelKeys.length
                    ? '{' + labelKeys.map(function (k) {
                        return k + '="' + escapeLabelValue(entry.labels[k]) + '"';
                    }).join(',') + '}'
                    : '';
                lines.push(name + labelStr + ' ' + entry.value);
            });
        });

        var connected = connectionsCurrent();
        if (connected !== null) {
            lines.push('# TYPE tyo_mq_connections_current gauge');
            lines.push('tyo_mq_connections_current ' + connected);
        }

        return lines.join('\n') + '\n';
    };

    var connectionsCurrent = function () {
        if (currentIo && currentIo.engine && typeof currentIo.engine.clientsCount === 'number')
            return currentIo.engine.clientsCount;
        return null;
    };

    var buildStats = function () {
        var stats = {realms: {}, connections_current: connectionsCurrent()};
        Object.keys(realms).forEach(function (realmId) {
            var realm = realms[realmId];
            var producers = {total: 0, online: 0};
            var consumers = {total: 0, online: 0};
            Object.keys(realm.producers || {}).forEach(function (name) {
                producers.total++;
                if (realm.producers[name].socket) producers.online++;
            });
            Object.keys(realm.consumers || {}).forEach(function (name) {
                consumers.total++;
                if (realm.consumers[name].socket) consumers.online++;
            });
            stats.realms[realmId] = {
                producers: producers,
                consumers: consumers,
                subscriptions: Object.keys(realm.subscriptions || {}).length
            };
        });
        if (clusterSync)
            stats.cluster_node_id = clusterSync.nodeId;
        return stats;
    };

    // Public: snapshot of realm/producer/consumer/subscription counts.
    this.getStats = function () {
        return buildStats();
    };

    var getHttpApiConfig = function () {
        var config = server.options.http_api || server.options.httpApi
            || server.settings.get('http_api') || server.settings.get('httpApi');
        return (config && config.enabled) ? config : null;
    };

    var httpAuthOk = function (req) {
        if (!isAuthEnabled())
            return true;
        var header = req.headers['authorization'] || '';
        var match = header.match(/^Bearer\s+(.+)$/i);
        if (!match)
            return false;
        var provided = hashToken(match[1]);
        return getAdminTokens().some(function (token) {
            return hashToken(token) === provided;
        });
    };

    var sendJson = function (res, status, body) {
        res.writeHead(status, {'content-type': 'application/json; charset=utf-8'});
        res.end(JSON.stringify(body));
    };

    var handleHttpApiRequest = function (req, res) {
        var config = getHttpApiConfig();
        if (!config)
            return false;

        if (req.method !== 'GET')
            return false; // the surface is read-only by design

        var pathname;
        try {
            pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
        }
        catch (err) {
            return false;
        }

        if ((pathname === '/health' || pathname === '/healthz') && config.health !== false) {
            sendJson(res, 200, {
                status: 'ok',
                version: pak.version,
                uptime_seconds: Math.floor(process.uptime()),
                node_id: clusterSync ? clusterSync.nodeId : null
            });
            return true;
        }

        if (pathname === '/api/metrics' && config.metrics !== false) {
            if (config.metrics_auth !== false && !httpAuthOk(req)) {
                sendJson(res, 401, {ok: false, code: 401, message: 'Bearer admin token required'});
                return true;
            }
            res.writeHead(200, {'content-type': 'text/plain; version=0.0.4; charset=utf-8'});
            res.end(renderPrometheusMetrics());
            return true;
        }

        if (pathname === '/api/stats' && config.stats !== false) {
            if (!httpAuthOk(req)) {
                sendJson(res, 401, {ok: false, code: 401, message: 'Bearer admin token required'});
                return true;
            }
            sendJson(res, 200, buildStats());
            return true;
        }

        var dlqMatch = pathname.match(/^\/api\/realms\/([^\/]+)\/dlq$/);
        if (dlqMatch && config.stats !== false) {
            if (!httpAuthOk(req)) {
                sendJson(res, 401, {ok: false, code: 401, message: 'Bearer admin token required'});
                return true;
            }
            if (!server.store || typeof server.store.listDlq !== 'function') {
                sendJson(res, 501, {ok: false, code: 501, message: 'Storage backend has no DLQ support'});
                return true;
            }
            server.store.listDlq(dlqMatch[1]).then(function (entries) {
                sendJson(res, 200, {realm: dlqMatch[1], entries: entries || []});
            }).catch(function (err) {
                sendJson(res, 500, {ok: false, code: 500, message: err.message});
            });
            return true;
        }

        return false;
    };

    var applyAuthManagementCommand = function (body) {
        body = body || {};
        var command = body.command;
        var auth = clone(server.authOptions || {});
        auth.realms = auth.realms || {};
        auth.tokens = auth.tokens || [];

        if (command === 'get') {
            return {ok: true, settings: publicManagementSettings()};
        }

        if (command === 'reload_settings') {
            if (!loadedSettingsFile)
                return {ok: false, code: 400, message: 'No settings file is being watched'};
            try {
                server.settings.reloadSync();
            }
            catch (err) {
                return {ok: false, code: 500, message: 'Settings reload failed: ' + err.message};
            }
            return {ok: true, settings: publicManagementSettings()};
        }

        if (command === 'set_global_auth') {
            auth.enabled = !!body.enabled;
        }
        else if (command === 'set_persistence') {
            var normalized = normalizePersistenceSettings(body);
            if (!normalized.ok)
                return normalized;

            try {
                applyPersistenceSettings(normalized.settings);
            }
            catch (err) {
                return {ok: false, code: 400, message: err.message};
            }

            var nextPersistenceSettings = clone(server.settings.get());
            nextPersistenceSettings.storage = normalized.settings.storage;
            nextPersistenceSettings.storage_options = normalized.settings.storage_options;
            applyingPersistenceChange = true;
            try {
                server.settings.replace(nextPersistenceSettings);
            }
            finally {
                applyingPersistenceChange = false;
            }
            persistSettings();
            return {ok: true, settings: publicManagementSettings()};
        }
        else if (command === 'add_realm') {
            if (!body.realm)
                return {ok: false, code: 400, message: 'realm is required'};
            if (auth.realms[body.realm])
                return {ok: false, code: 409, message: 'realm already exists'};
            auth.realms[body.realm] = {required: body.required !== false};
            if (body.manager_key || body.managerKey)
                auth.realms[body.realm].manager_key = body.manager_key || body.managerKey;
            if (body.key || body.preshared_key || body.presharedKey)
                auth.realms[body.realm].key = body.key || body.preshared_key || body.presharedKey;
            if (body.require_acceptance !== undefined && body.require_acceptance !== null)
                auth.realms[body.realm].require_acceptance = !!body.require_acceptance;
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
        else if (command === 'remove_realm') {
            if (!body.realm)
                return {ok: false, code: 400, message: 'realm is required'};
            if (body.realm === DEFAULT_REALM || body.realm === REALM_ALL)
                return {ok: false, code: 400, message: 'cannot remove the "' + body.realm + '" realm'};
            if (!auth.realms[body.realm])
                return {ok: false, code: 404, message: 'realm not found'};
            delete auth.realms[body.realm];
            // Drop tokens scoped to the removed realm — they would be orphaned.
            var tokensBefore = auth.tokens.length;
            auth.tokens = auth.tokens.filter(function (token) {
                return token.realm !== body.realm;
            });
            body._removed_tokens = tokensBefore - auth.tokens.length;
            // Drop in-memory runtime state (producers/consumers/subscriptions).
            if (realms[body.realm])
                delete realms[body.realm];
        }
        else if (command === 'set_realm_auth') {
            if (!body.realm)
                return {ok: false, code: 400, message: 'realm is required'};
            auth.realms[body.realm] = auth.realms[body.realm] || {};
            auth.realms[body.realm].required = !!body.required;
        }
        else if (command === 'set_realm_manager_key') {
            if (!body.realm)
                return {ok: false, code: 400, message: 'realm is required'};
            if (!auth.realms[body.realm])
                return {ok: false, code: 404, message: 'realm not found'};
            if (body.manager_key || body.managerKey)
                auth.realms[body.realm].manager_key = body.manager_key || body.managerKey;
            else
                delete auth.realms[body.realm].manager_key;
        }
        else if (command === 'set_realm_key') {
            if (!body.realm)
                return {ok: false, code: 400, message: 'realm is required'};
            if (!auth.realms[body.realm])
                return {ok: false, code: 404, message: 'realm not found'};
            if (body.key || body.preshared_key || body.presharedKey)
                auth.realms[body.realm].key = body.key || body.preshared_key || body.presharedKey;
            else
                delete auth.realms[body.realm].key;
            if (body.require_key !== undefined && body.require_key !== null)
                auth.realms[body.realm].require_key = !!body.require_key;
        }
        else if (command === 'set_realm_acceptance') {
            if (!body.realm)
                return {ok: false, code: 400, message: 'realm is required'};
            auth.realms[body.realm] = auth.realms[body.realm] || {};
            auth.realms[body.realm].require_acceptance = !!body.required;
        }
        else if (command === 'revoke_token') {
            var revoked = revokeAuthTokens(auth, body);
            if (!revoked.ok)
                return revoked;
            body._revoked = revoked.revoked;
        }
        else {
            return {ok: false, code: 400, message: 'unknown management command'};
        }

        var nextSettings = clone(server.settings.get());
        nextSettings.auth = auth;
        server.settings.replace(nextSettings);
        persistSettings();
        var result = {ok: true, settings: publicManagementSettings()};
        if (body._revoked)
            result.revoked = body._revoked;
        if (body._removed_tokens !== undefined)
            result.removed_tokens = body._removed_tokens;
        return result;
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

    // Roles a client may declare for itself on connection. 'manager' and
    // 'admin' are deliberately excluded — those are only granted via tokens.
    var CONNECT_ROLES = ['producer', 'consumer', 'both'];

    // MQTT-style topic matching: '+' matches exactly one level, '#' matches
    // any number of trailing levels (must be the last segment).
    var topicMatches = function (pattern, topic) {
        if (pattern === topic)
            return true;
        var p = String(pattern).split('/');
        var t = String(topic).split('/');
        for (var i = 0; i < p.length; i++) {
            if (p[i] === '#')
                return i === p.length - 1;
            if (i >= t.length)
                return false;
            if (p[i] !== '+' && p[i] !== t[i])
                return false;
        }
        return p.length === t.length;
    };

    var getRealmPresharedKey = function (realmId) {
        var rc = getRealmConfig(realmId);
        if (!rc)
            return null;
        return rc.key || rc.preshared_key || rc.presharedKey || null;
    };

    // Consumers (and 'both') need the realm pre-shared key only when the realm
    // says so.  Default: required exactly when a key is configured.
    var isKeyRequiredForRealm = function (realmId) {
        if (!isAuthEnabled()) return false;
        var rc = getRealmConfig(realmId);
        if (!rc) return false;
        if (typeof rc.require_key === 'boolean') return rc.require_key;
        if (typeof rc.requireKey === 'boolean') return rc.requireKey;
        return !!getRealmPresharedKey(realmId);
    };

    // Producers (and 'both') must be accepted into the realm unless the realm
    // waives it.  Falls back to the realm's general auth requirement so realms
    // with required: false stay fully open.
    var isAcceptanceRequiredForRealm = function (realmId) {
        if (!isAuthEnabled()) return false;
        var rc = getRealmConfig(realmId);
        if (rc) {
            if (typeof rc.require_acceptance === 'boolean') return rc.require_acceptance;
            if (typeof rc.requireAcceptance === 'boolean') return rc.requireAcceptance;
        }
        return isAuthRequiredForRealm(realmId);
    };

    var roleAllows = function (role, allowed) {
        role = normalizeRole(role);
        if (role === 'admin' || role === 'manager' || role === 'both')
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

    // Read the realm claim from a JWT WITHOUT verifying its signature, so the
    // per-realm signing key can be looked up before verification. Returns null
    // for anything that is not a well-formed HS256 JWT carrying a realm claim.
    var peekJwtRealm = function (token) {
        try {
            var parts = token.split('.');
            if (parts.length !== 3)
                return null;
            var header = decodeBase64UrlJson(parts[0]);
            if (header.alg !== 'HS256')
                return null;
            var payload = decodeBase64UrlJson(parts[1]);
            return payload && payload.realm ? String(payload.realm) : null;
        }
        catch (err) {
            return null;
        }
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

        // Per-realm JWT: verify against the realm's own manager_key, looked up
        // from the token's (unverified) realm claim. This keeps realms isolated
        // — a token minted for one realm cannot be verified with another's key.
        // Falls through when the realm has no key or verification fails.
        var realmClaim = peekJwtRealm(token);
        if (realmClaim) {
            var realmSecret = getRealmManagerKey(realmClaim);
            if (realmSecret) {
                try {
                    var realmResult = validateJwtToken(token, realmSecret);
                    if (realmResult)
                        return Promise.resolve(realmResult);
                }
                catch (err) {
                    // fall through to the global secret / static tokens
                }
            }
        }

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

    // ── Idle registration eviction ──────────────────────────────────────────
    // Consumer/producer entries are kept after a disconnect so that a quick
    // reconnect keeps its subscriptions (see getConsumerMetaInfo). To stop the
    // mapping tables from growing without bound when many short-lived names come
    // and go, a periodic sweep removes entries that have stayed offline (no live
    // socket) for longer than a grace TTL. Durable messages live in the store,
    // so an evicted consumer is simply recreated — and re-delivered to — when it
    // reconnects.
    var idleEvictionTimer = null;

    var getIdleEvictionConfig = function () {
        var cfg = server.settings.get('idle_eviction')
            || server.options.idle_eviction || server.options.idleEviction || {};
        return {
            enabled:    cfg.enabled !== false,                      // default: on
            ttlMs:      cfg.ttl_ms      || cfg.ttlMs      || 300000, // 5 min offline grace
            intervalMs: cfg.interval_ms || cfg.intervalMs || 60000   // sweep once a minute
        };
    };

    // Run one eviction pass. An entry is eligible only once its socket is null
    // (fully disconnected) and it has been idle past the TTL. Returns the count.
    var sweepIdleRegistrations = function () {
        var cfg = getIdleEvictionConfig();
        if (!cfg.enabled)
            return 0;

        var cutoff = Date.now() - cfg.ttlMs;
        var removed = 0;

        var evictable = function (meta) {
            return !meta.socket && meta.online === false
                && meta.offline_at && meta.offline_at <= cutoff;
        };

        Object.keys(realms).forEach(function (realmId) {
            var realm = realms[realmId];

            Object.keys(realm.consumers || {}).forEach(function (name) {
                if (evictable(realm.consumers[name])) {
                    delete realm.consumers[name];
                    deleteConsumerFromSubscriptions(realmId, name);
                    removed++;
                    if (server.logger && server.logger.info)
                        server.logger.info("Idle eviction: removed offline consumer '" + name + "' from realm '" + realmId + "'");
                }
            });

            Object.keys(realm.producers || {}).forEach(function (name) {
                if (evictable(realm.producers[name])) {
                    delete realm.producers[name];
                    deleteProducerFromSubscriptions(realmId, name);
                    removed++;
                    if (server.logger && server.logger.info)
                        server.logger.info("Idle eviction: removed offline producer '" + name + "' from realm '" + realmId + "'");
                }
            });
        });

        return removed;
    };

    var startIdleEviction = function () {
        var cfg = getIdleEvictionConfig();
        if (!cfg.enabled || idleEvictionTimer)
            return;
        idleEvictionTimer = setInterval(function () {
            try { sweepIdleRegistrations(); }
            catch (err) {
                if (server.logger && server.logger.error)
                    server.logger.error("Idle eviction sweep failed: " + (err && err.message || err));
            }
        }, cfg.intervalMs);
        if (idleEvictionTimer.unref)
            idleEvictionTimer.unref(); // never keep the process alive on our account
    };

    // Public: stop the sweep timer (shutdown / tests).
    this.stopIdleEviction = function () {
        if (idleEvictionTimer) {
            clearInterval(idleEvictionTimer);
            idleEvictionTimer = null;
        }
        return this;
    };

    // Public: run a single eviction pass immediately; returns the count removed.
    this.sweepIdleRegistrations = function () {
        return sweepIdleRegistrations();
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
     *       "acme":   { "required": true, "key": "consumer-psk", "require_acceptance": true },
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

            // Seed the open 'default' realm so token-less clients — those that
            // connect without specifying a realm — can produce and consume out
            // of the box even when auth.enabled is true. Named realms stay
            // governed by auth.enabled and their own `required` flag.
            var seedAuth = this.settings.get('auth') || {};
            if (!(seedAuth.realms && seedAuth.realms[DEFAULT_REALM]))
                this.settings.merge({auth: {realms: {'default': {required: false}}}});

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

            if (!applyingPersistenceChange && persistenceSignature(prev) !== persistenceSignature(next)) {
                try {
                    applyPersistenceSettings(next);
                    self.logger.log("Settings reload: persistence storage changed to " + (next.storage || next.store || 'memory'));
                }
                catch (err) {
                    self.logger.error("Settings reload: persistence update failed: " + err.message);
                }
            }

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
        initCluster();
        currentIo = io;
        startIdleEviction();

        // When attached to an external http server (not our own `app`), serve
        // the opt-in HTTP API from there too. Only our own paths are answered;
        // everything else is left to the host server's handlers.
        if (io.httpServer && io.httpServer !== app && !io.httpServer._tyoMqHttpApiAttached) {
            io.httpServer._tyoMqHttpApiAttached = true;
            io.httpServer.on('request', function (req, res) {
                handleHttpApiRequest(req, res);
            });
        }

        var remoteNamespace = ensureRemoteNamespace(io);

        // maintain a request table for whom is requesting what
        // 1 success, 

        // Pending chunk transfers keyed by "<socketId>:<transferId>"
        var pendingChunks = {};
        var pendingAcks = {};

        function parseDurationMs(value, fallbackMs) {
            if (value === undefined || value === null || value === '')
                return fallbackMs;
            if (typeof value === 'number')
                return value * 1000;
            var raw = String(value).trim();
            var match = raw.match(/^(\d+(?:\.\d+)?)(ms|s|m)?$/i);
            if (!match)
                return fallbackMs;
            var amount = Number(match[1]);
            var unit = (match[2] || 's').toLowerCase();
            if (unit === 'ms')
                return amount;
            if (unit === 'm')
                return amount * 60 * 1000;
            return amount * 1000;
        }

        function normalizeRetryPolicy(subscription) {
            subscription = subscription || {};
            var retry = subscription.retry || {};
            var maxAttempts = retry.max_attempts || retry.maxAttempts || subscription.max_attempts || subscription.maxAttempts || 3;
            var delay = retry.delay || subscription.retry_delay || subscription.retryDelay || '5s';
            return {
                max_attempts: Math.max(1, Number(maxAttempts) || 3),
                delay_ms: parseDurationMs(delay, 5000),
                backoff: retry.backoff || subscription.backoff || 'fixed'
            };
        }

        function retryDelayMs(policy, attempt) {
            if (policy.backoff === 'exponential')
                return policy.delay_ms * Math.pow(2, Math.max(0, attempt - 1));
            return policy.delay_ms;
        }

        // ── delivery machinery ────────────────────────────────────────────
        // Realm-parameterized so it can run without an originating socket
        // (e.g. for messages relayed from another cluster node).

        function sendMessage (id, event, message, from) {
            if (!id) {
                server.logger.error("sendMessage: null socket — event: " + event
                    + (from ? ", from: " + JSON.stringify(from) : "")
                    + ", message: " + JSON.stringify(message));
                return;
            }
            server.logger.debug("sendMessage → " + id + "  event: " + event + "  message: " + JSON.stringify(message));
            server.send(id, event, message);
        }

        function sendVolatileMessage (id, event, message) {
            if (!id) {
                server.logger.error("sendVolatileMessage: null socket — event: " + event + ", message: " + JSON.stringify(message));
                return;
            }
            server.logger.debug("sendVolatileMessage → " + id + "  event: " + event + "  message: " + JSON.stringify(message));
            server.volatile(event, message, id);
        }

        function getRealmSocketIds (realmId) {
            var ids = new Set();
            var realm = getRealm(realmId);
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

        function broadcastVolatileMessage (realmId, event, message) {
            server.logger.debug("broadcastVolatileMessage  event: " + event + "  message: " + JSON.stringify(message));
            getRealmSocketIds(realmId).forEach(function (socketId) {
                server.volatile(event, message, socketId);
            });
        }

        function broadcastMessage (realmId, event, message) {
            server.logger.debug("broadcastMessage  event: " + event + "  message: " + JSON.stringify(message));
            getRealmSocketIds(realmId).forEach(function (socketId) {
                server.send(socketId, event, message);
            });
        }

        /**
         * Send the message for subscriber(s)' consumption.
         * Large messages are sent as ordered chunks; the subscriber
         * reassembles them before dispatching.
         */

        function sendConsumeMessage (realmId, socketId, event, message, producer, delivery) {
            incMetric('tyo_mq_messages_delivered_total', {realm: realmId, event: String(event)});
            var eventStr = eventManager.toConsumeEvent(event);
            var outgoing = message;
            if (delivery && delivery.msgId) {
                outgoing = Object.assign({}, message, {
                    msgId: delivery.msgId,
                    msg_id: delivery.msgId,
                    delivery_attempt: delivery.attempt || 1
                });
            }

            var str = JSON.stringify(outgoing);
            var chunkSize = 256 * 1024; // 256 KB — keep frames well under maxHttpBufferSize

            if (str.length <= chunkSize) {
                sendMessage(socketId, eventStr, outgoing, producer);
                return;
            }

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

        function getMessageTtl(message) {
            if (!message)
                return undefined;
            if (message.ttl !== undefined)
                return message.ttl;
            if (message.lifespan !== undefined && message.lifespan !== -1)
                return message.lifespan;
            return undefined;
        }

        function isGuaranteedMessage(message) {
            if (!message)
                return false;
            return !!(message.guaranteed
                || message.guaranteed_delivery
                || message.guaranteedDelivery
                || message.durable
                || message.delivery === 'guaranteed'
                || message.delivery_mode === 'guaranteed');
        }

        function enqueueDurableMessage(realmId, event, message, producer, subscription, options) {
            options = options || {};
            if (!subscription || (!subscription.durable && !options.guaranteed))
                return;

            return server.store.enqueue(realmId, event, {
                consumer_id: subscription.consumer_id || subscription.name,
                payload: message,
                producer: producer,
                ttl: options.ttl
            }).then(function (msgId) {
                incMetric('tyo_mq_messages_queued_total', {realm: realmId});
                return msgId;
            }).catch(function (err) {
                server.logger.error("Durable enqueue failed: " + err.message);
            });
        }

        function enqueueAndDeliverReliable(realmId, event, message, producer, subscription, consumerMeta, options) {
            return enqueueDurableMessage(realmId, event, message, producer, subscription, options).then(function (msgId) {
                if (!msgId || !consumerMeta.socket)
                    return;
                deliverDurableEntry({
                    id: msgId,
                    realm: realmId,
                    event: event,
                    consumer: subscription.consumer_id || subscription.name,
                    message: message,
                    producer: producer
                }, subscription, consumerMeta, 1);
            });
        }

        function deadLetterMessage(realmId, msgId, reason) {
            incMetric('tyo_mq_messages_dlq_total', {realm: realmId});
            if (server.store && typeof server.store.deadLetter === 'function') {
                return server.store.deadLetter(msgId, reason).catch(function (err) {
                    server.logger.error("DLQ move failed: " + err.message);
                });
            }

            server.logger.warn("Storage backend has no deadLetter(msgId) method; acking failed message " + msgId);
            return server.store.ack(msgId).catch(function (err) {
                server.logger.error("Fallback DLQ ack failed: " + err.message);
            });
        }

        function scheduleAckTimeout(entry, subscription, consumerMeta, attempt, policy) {
            pendingAcks[entry.id] = {
                socket: consumerMeta.socket,
                consumer_id: subscription.consumer_id,
                attempt: attempt,
                timer: setTimeout(function () {
                    delete pendingAcks[entry.id];
                    incMetric('tyo_mq_ack_timeout_total', {realm: entry.realm});

                    if (attempt >= policy.max_attempts) {
                        deadLetterMessage(entry.realm, entry.id, 'ack timeout after ' + attempt + ' attempt(s)');
                        return;
                    }

                    setTimeout(function () {
                        if (!consumerMeta.socket)
                            return;
                        deliverDurableEntry(entry, subscription, consumerMeta, attempt + 1);
                    }, retryDelayMs(policy, attempt)).unref();
                }, subscription.ack_timeout_ms || 30 * 1000)
            };
            pendingAcks[entry.id].timer.unref();
        }

        function deliverDurableEntry(entry, subscription, consumerMeta, attempt) {
            if (!entry || !subscription || !consumerMeta || !consumerMeta.socket)
                return;

            if (pendingAcks[entry.id])
                clearTimeout(pendingAcks[entry.id].timer);

            var policy = normalizeRetryPolicy(subscription);
            sendConsumeMessage(entry.realm, consumerMeta.socket, entry.event, entry.message, entry.producer, {
                msgId: entry.id,
                attempt: attempt
            });
            scheduleAckTimeout(entry, subscription, consumerMeta, attempt, policy);
        }

        function replayDurableMessages(realmId, event, subscription, consumerMeta) {
            if (!subscription || !consumerMeta || !consumerMeta.socket)
                return;

            var consumerId = subscription.consumer_id || consumerMeta.id || consumerMeta.name;
            server.store.dequeue(realmId, event, consumerId).then(function (messages) {
                messages.forEach(function (entry) {
                    if (!consumerMeta.socket)
                        return;

                    if (subscription.ack_required)
                        deliverDurableEntry(entry, subscription, consumerMeta, 1);
                    else {
                        // Backward compatibility: lower-version clients do
                        // not send ACK, so legacy durable replay keeps the
                        // Phase 2 immediate storage ack behavior.
                        sendConsumeMessage(realmId, consumerMeta.socket, entry.event, entry.message, entry.producer);
                        server.store.ack(entry.id).catch(function (err) {
                            server.logger.error("Durable ack failed: " + err.message);
                        });
                    }
                });
            }).catch(function (err) {
                server.logger.error("Durable replay failed: " + err.message);
            });
        }

        function broadcastConsumeMessage (realmId, event, message, producer) {
            var eventStr = eventManager.toConsumeEvent(event);
            var msgObj = {event:event, message:message, from:producer};
            var eventAll = eventManager.toConsumeEventAll(producer);

            broadcastVolatileMessage(realmId, eventAll, msgObj);
            broadcastMessage(realmId, eventStr, msgObj);

            // Also emit the subscription-shaped consume events so library
            // subscribers (which listen on producer-prefixed names)
            // receive realm broadcasts.
            var consumeSpecific = eventManager.toConsumeEvent(eventManager.toConsumerEvent(event, producer));
            var consumeAnyProducer = eventManager.toConsumeEvent(eventManager.toConsumerEvent(event, Constants.ALL_PUBLISHERS));
            var consumeAllFromProducer = eventManager.toConsumeEvent(eventManager.toConsumerEventAll(producer));
            getRealmSocketIds(realmId).forEach(function (socketId) {
                server.send(socketId, consumeSpecific, msgObj);
                server.send(socketId, consumeAnyProducer, msgObj);
                server.send(socketId, consumeAllFromProducer, msgObj);
            });
        }

        /**
         * Broadcast to every member of a consumer group in the realm —
         * one copy per member (unlike normal group delivery, which load
         * balances to a single member).
         */

        function broadcastToGroup (realmId, event, message, producer, group) {
            var msgObj = {event: event, message: message, from: producer};
            var realm = getRealm(realmId);
            var delivered = {};

            for (var eventStr in realm.subscriptions) {
                var subscriptions = realm.subscriptions[eventStr];
                for (var consumer in subscriptions) {
                    var subscription = subscriptions[consumer];
                    if (subscription.group !== group || delivered[subscription.name])
                        continue;

                    var consumerMeta = getConsumerMetaInfo(realmId, subscription.name);
                    if (!consumerMeta.socket)
                        continue;

                    delivered[subscription.name] = true;
                    sendConsumeMessage(realmId, consumerMeta.socket, eventStr, msgObj, producer);
                }
            }
        }

        function deliverToSubscription (realmId, eventStr, msgObj, producer, subscription, consumerMeta, options) {
            if (consumerMeta.socket) {
                if (subscription.ack_required)
                    enqueueAndDeliverReliable(realmId, eventStr, msgObj, producer, subscription, consumerMeta, options);
                else
                    sendConsumeMessage(realmId, consumerMeta.socket, eventStr, msgObj, producer);
            }
            else
                enqueueDurableMessage(realmId, eventStr, msgObj, producer, subscription, options);
        }

        function generateMessage (realmId, event, message, producer, options) {
            producer = producer || Constants.ANONYMOUS;
            options = options || {};

            var msgObj = {event:event, message:message, from:producer};

            let subscriptionEvent = eventManager.toConsumerEvent(event, producer);
            let subscriptionEventAll = eventManager.toConsumerEventAll(producer);
            let subscriptionEventAnyProducer = eventManager.toConsumerEvent(event, Constants.ALL_PUBLISHERS);

            var targetRealmIds = [realmId];
            if (realmId !== REALM_ALL && realms[REALM_ALL])
                targetRealmIds.push(REALM_ALL);

            // Subscriptions in a consumer group are collected first: each
            // message goes to exactly one member (round-robin).  Ungrouped
            // subscriptions are delivered immediately, exactly as before.
            var groupBuckets = {};

            var dispatch = function (targetRealmId, eventStr, subscription, consumerMeta) {
                if (subscription.group) {
                    // Relayed messages never join group selection: the origin
                    // node already picked a member among its own.
                    if (options.relay)
                        return;
                    var bucketKey = targetRealmId + '\n' + subscription.group;
                    groupBuckets[bucketKey] = groupBuckets[bucketKey]
                        || {realmId: targetRealmId, group: subscription.group, members: []};
                    groupBuckets[bucketKey].members.push({
                        eventStr: eventStr,
                        subscription: subscription,
                        consumerMeta: consumerMeta
                    });
                    return;
                }
                // Relayed messages reach local live sockets only — durable
                // enqueueing happened once, on the origin node.
                if (options.relay && !consumerMeta.socket)
                    return;
                deliverToSubscription(targetRealmId, eventStr, msgObj, producer, subscription, consumerMeta, options);
            };

            targetRealmIds.forEach(function (targetRealmId) {
                [subscriptionEvent, subscriptionEventAll, subscriptionEventAnyProducer].forEach(function (eventStr) {

                    var subscriptions = getEventSubscriptions(targetRealmId, eventStr);
                    for (var consumer in subscriptions) {
                        var subscription = subscriptions[consumer];
                        var consumerMeta = getConsumerMetaInfo(targetRealmId, subscription.name);

                        var ar = Array.from(consumerMeta.subscribeTos);
                        for (var i = 0; i < ar.length; ++i) {
                            var name = ar[i];
                            if (name === Constants.ALL_PUBLISHERS || name === producer) {
                                dispatch(targetRealmId, eventStr, subscription, consumerMeta);
                                break;
                            }
                        }
                    }
                });

                // Topic-mode subscriptions (opt-in): match the produced
                // event against registered MQTT-style patterns.
                var topicPatterns = getRealm(targetRealmId).topicPatterns;
                if (!topicPatterns)
                    return;
                var topicLower = String(event).toLowerCase();
                Object.keys(topicPatterns).forEach(function (eventStr) {
                    if (eventStr === subscriptionEvent || eventStr === subscriptionEventAll || eventStr === subscriptionEventAnyProducer)
                        return; // exact patterns are already handled above
                    if (!topicMatches(topicPatterns[eventStr], topicLower))
                        return;

                    var subscriptions = getEventSubscriptions(targetRealmId, eventStr);
                    for (var consumer in subscriptions) {
                        var subscription = subscriptions[consumer];
                        var consumerMeta = getConsumerMetaInfo(targetRealmId, subscription.name);
                        dispatch(targetRealmId, eventStr, subscription, consumerMeta);
                    }
                });
            });

            Object.keys(groupBuckets).forEach(function (bucketKey) {
                var bucket = groupBuckets[bucketKey];
                var realm = getRealm(bucket.realmId);
                realm.groupCounters = realm.groupCounters || {};

                var online = bucket.members.filter(function (member) {
                    return member.consumerMeta.socket;
                });
                var candidates = online.length > 0 ? online : bucket.members;
                var counter = realm.groupCounters[bucket.group] = (realm.groupCounters[bucket.group] || 0) + 1;
                var target = candidates[(counter - 1) % candidates.length];
                deliverToSubscription(bucket.realmId, target.eventStr, msgObj, producer, target.subscription, target.consumerMeta, options);
            });
        }

        // ── cluster message relay ─────────────────────────────────────────
        // The origin node delivers locally with full semantics (live, durable
        // enqueue, groups). Peers deliver relayed messages to their local live
        // subscribers only: durable enqueueing happened once on the origin
        // node, and group selection is per-node (a group's members should
        // connect to the same node).

        function handleRelayedMessage (payload) {
            if (!payload || !payload.realm || payload.event === undefined)
                return;

            if (payload.method === 'broadcast') {
                if (payload.broadcast === 'group' && payload.group)
                    broadcastToGroup(payload.realm, payload.event, payload.message, payload.producer, payload.group);
                else
                    broadcastConsumeMessage(payload.realm, payload.event, payload.message, payload.producer);
                return;
            }

            generateMessage(payload.realm, payload.event, payload.message, payload.producer, {
                ttl: payload.ttl,
                guaranteed: payload.guaranteed,
                relay: true
            });
        }

        function relayProducedMessage (payload) {
            if (!clusterSync)
                return;
            clusterSync.publishMessage(payload).catch(function (err) {
                server.logger.error("Cluster message relay failed: " + err.message);
            });
        }

        // A peer decided an authorization request whose requester socket
        // lives on this node: deliver the notification locally.
        function handlePeerAuthDecision (request) {
            if (!request || !clusterSync || request.node_id !== clusterSync.nodeId || !request.socket_id)
                return;

            if (request.status === 'approved')
                server.send(request.socket_id, 'AUTHORIZATION_APPROVED', {
                    request_id: request.request_id,
                    realm: request.realm,
                    role: request.role
                });
            else if (request.status === 'rejected')
                server.send(request.socket_id, 'AUTHORIZATION_REJECTED', {
                    request_id: request.request_id,
                    reason: request.decision_reason || null
                });

            syncLocalAuthRequest(request);
        }

        if (clusterSync) {
            var subscribeRelay = function () {
                return clusterSync.onMessage(handleRelayedMessage).then(function () {
                    return clusterSync.onAuthDecision(handlePeerAuthDecision);
                });
            };
            clusterSync.ready = clusterSync.ready
                ? clusterSync.ready.then(subscribeRelay)
                : subscribeRelay();
        }

        // ── async management commands (stats + DLQ) ───────────────────────
        // Handled outside applyAuthManagementCommand because they read the
        // store (promises) and never touch the settings document.
        // Returns null when the command is not one of ours.

        function attemptDlqLiveReplay (entry) {
            var realm = getRealm(entry.realm);
            var subscriptions = realm.subscriptions[entry.event];
            if (!subscriptions)
                return;
            for (var consumer in subscriptions) {
                var subscription = subscriptions[consumer];
                if ((subscription.consumer_id || subscription.name) !== entry.consumer)
                    continue;
                var consumerMeta = getConsumerMetaInfo(entry.realm, subscription.name);
                if (consumerMeta.socket)
                    replayDurableMessages(entry.realm, entry.event, subscription, consumerMeta);
                return;
            }
        }

        function handleAsyncManagementCommand (body) {
            var command = body.command;

            if (command === 'stats')
                return Promise.resolve({ok: true, stats: buildStats()});

            if (command !== 'dlq_list' && command !== 'dlq_replay' && command !== 'dlq_discard')
                return null;

            if (!server.store || typeof server.store.listDlq !== 'function')
                return Promise.resolve({ok: false, code: 501, message: 'Storage backend has no DLQ support'});

            if (command === 'dlq_list') {
                return server.store.listDlq(body.realm || null).then(function (entries) {
                    return {ok: true, realm: body.realm || null, entries: entries || []};
                });
            }

            var msgId = body.msg_id || body.msgId || body.id;
            if (!msgId)
                return Promise.resolve({ok: false, code: 400, message: 'msg_id is required'});

            if (command === 'dlq_discard') {
                return server.store.discardDlq(msgId, body.realm || null).then(function () {
                    return {ok: true, msg_id: msgId};
                });
            }

            // dlq_replay: re-enqueue the message for its consumer, remove it
            // from the DLQ, and nudge an online consumer immediately.
            return server.store.listDlq(body.realm || null).then(function (entries) {
                var entry = (entries || []).filter(function (candidate) {
                    return candidate.id === msgId;
                })[0];
                if (!entry)
                    return {ok: false, code: 404, message: 'DLQ message not found'};

                return server.store.enqueue(entry.realm, entry.event, {
                    consumer_id: entry.consumer,
                    payload: entry.message,
                    producer: entry.producer
                }).then(function (newMsgId) {
                    return server.store.discardDlq(entry.id, entry.realm).then(function () {
                        incMetric('tyo_mq_messages_queued_total', {realm: entry.realm});
                        attemptDlqLiveReplay(entry);
                        return {ok: true, msg_id: entry.id, new_msg_id: newMsgId};
                    });
                });
            });
        }

        // creating a new websocket then wait for connection
        io.sockets.on('connection', function(socket) {
            incMetric('tyo_mq_connections_total');
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
                    // Connection-authorization defaults: consumers are allowed
                    // in automatically when the realm requires no pre-shared
                    // key; producers when the realm waives acceptance.
                    if (roles && roles.length === 1) {
                        if (roles[0] === 'consumer' && !isKeyRequiredForRealm(desiredRealm)) {
                            socket.tyoAuth = {authenticated: true, realm: desiredRealm, role: 'consumer'};
                            return true;
                        }
                        if (roles[0] === 'producer' && !isAcceptanceRequiredForRealm(desiredRealm)) {
                            socket.tyoAuth = {authenticated: true, realm: desiredRealm, role: 'producer'};
                            return true;
                        }
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
            function subscribeMessage (event, producer, consumer, consumerId, scope, options) {
                var eventStr;
                options = options || {};

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
                subscription.durable = !!options.durable;
                subscription.consumer_id = options.consumer_id || consumerMeta.id || consumer;
                subscription.ack_required = !!(options.ack || options.require_ack || options.requireAck || options.manual_ack || options.manualAck);
                subscription.ack_timeout_ms = parseDurationMs(
                    options.ack_timeout || options.ackTimeout || server.options.ack_timeout || server.options.ackTimeout,
                    30 * 1000
                );
                subscription.retry = options.retry || null;
                subscription.group = options.group || null;
                subscription.mode = options.mode === 'topic' ? 'topic' : null;

                if (subscription.mode === 'topic') {
                    // Index the pattern so produced events can be matched
                    // against it without scanning every subscription.
                    var topicRealm = currentRealm();
                    topicRealm.topicPatterns = topicRealm.topicPatterns || {};
                    topicRealm.topicPatterns[eventStr] = String(event).toLowerCase();
                }

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

                replayDurableMessages(currentRealmId(), eventStr, subscription, consumerMeta);
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

                    subscribeMessage(targetEvent, producer, consumer, id, scope, {
                        durable: !!(event.durable || (event.options && event.options.durable)),
                        consumer_id: event.consumer_id || event.consumerId || id,
                        ack: !!(event.ack || event.require_ack || event.requireAck || (event.options && (event.options.ack || event.options.require_ack || event.options.requireAck))),
                        manual_ack: !!(event.manual_ack || event.manualAck || (event.options && (event.options.manual_ack || event.options.manualAck))),
                        ack_timeout: event.ack_timeout || event.ackTimeout || (event.options && (event.options.ack_timeout || event.options.ackTimeout)),
                        retry: event.retry || (event.options && event.options.retry) || null,
                        mode: event.mode || (event.options && event.options.mode) || null,
                        group: event.group || (event.options && event.options.group) || null
                    });

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

            onAuthorized('ACK', ['consumer'], function (message, callback) {
                if (typeof message === 'string')
                    try {
                        message = JSON.parse(message);
                    }
                    catch (e) {
                        var parseFail = {ok: false, code: 400, message: 'Invalid ACK JSON'};
                        socket.emit('ACK_FAIL', parseFail);
                        if (callback) callback(parseFail);
                        return;
                    }

                var msgId = message && (message.msgId || message.msg_id || message.id);
                if (!msgId) {
                    var missing = {ok: false, code: 400, message: 'ACK requires msgId'};
                    socket.emit('ACK_FAIL', missing);
                    if (callback) callback(missing);
                    return;
                }

                var pending = pendingAcks[msgId];
                if (!pending) {
                    var unknown = {ok: false, code: 404, message: 'Pending ACK not found'};
                    socket.emit('ACK_FAIL', unknown);
                    if (callback) callback(unknown);
                    return;
                }

                if (pending.socket !== socket.id) {
                    var forbidden = {ok: false, code: 403, message: 'ACK does not belong to this socket'};
                    socket.emit('ACK_FAIL', forbidden);
                    if (callback) callback(forbidden);
                    return;
                }

                clearTimeout(pending.timer);
                delete pendingAcks[msgId];
                server.store.ack(msgId).then(function () {
                    var ok = {ok: true, msgId: msgId};
                    socket.emit('ACK_OK', ok);
                    if (callback) callback(ok);
                }).catch(function (err) {
                    var fail = {ok: false, code: 500, message: err.message};
                    socket.emit('ACK_FAIL', fail);
                    if (callback) callback(fail);
                });
            });

            /**
             * DISCONNECT from server
             */

             onAuthorized('QUIT', [], function (id) {
                if (id === socket.id)
                    socket.disconnect();
             });

            /**
             * Relay message from producer to consumer
             * the message has to an object containing event, message and producer name
             */

            function handleProduce(obj) {
                var producerName = obj.from;
                var event = obj.event;
                var message = obj.message;
                incMetric('tyo_mq_messages_produced_total', {realm: currentRealmId(), event: String(event)});
                var ttl = getMessageTtl(obj);
                var guaranteed = isGuaranteedMessage(obj);

                var producerMeta = getProducerMetaInfo(currentRealmId(), producerName);
                if (ttl === undefined && producerMeta.default_ttl !== undefined)
                    ttl = producerMeta.default_ttl;

                if (!producerMeta.socket)
                    setupProducer(producerName, obj.id);

                if (obj.method && obj.method === 'broadcast') {
                    if (obj.broadcast === 'group' && obj.group)
                        broadcastToGroup(currentRealmId(), event, message, producerName, obj.group);
                    else
                        broadcastConsumeMessage(currentRealmId(), event, message, producerName);
                }
                else
                    generateMessage(currentRealmId(), event, message, producerName, {ttl: ttl, guaranteed: guaranteed});

                relayProducedMessage({
                    realm: currentRealmId(),
                    event: event,
                    message: message,
                    producer: producerName,
                    ttl: ttl,
                    guaranteed: guaranteed,
                    method: obj.method === 'broadcast' ? 'broadcast' : null,
                    broadcast: obj.broadcast || null,
                    group: obj.group || null
                });
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

                // Enforce the realm's anonymous policy: unnamed (ANONYMOUS / no
                // app_id) consumers are only accepted where the realm allows them
                // (the open 'default' realm by default; named realms must opt in via
                // allow_anonymous).
                if (isAnonymousName(consumer.name) && !isAnonymousAllowed(currentRealmId())) {
                    server.logger.warn("ANONYMOUS consumer rejected in realm '" + currentRealmId() + "' — anonymous consumers are not allowed here.");
                    sendErrorMessage({message: "Anonymous consumers are not allowed in realm '" + currentRealmId() + "'. Set a unique app_id per broker/instance.", code: -4});
                    socket.disconnect();
                    return;
                }

                // Reject duplicate consumer names: if an existing live socket is already
                // registered under this name, the new connection is a misconfiguration
                // (e.g. two instances sharing the same app_id).  Disconnect the newcomer
                // immediately so the existing consumer is not silently displaced.
                // Unnamed clients mint unique ANONYMOUS-<uuid> names, so they no longer
                // collide here; idle entries are reclaimed by the eviction sweep.
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

                // Enforce the realm's anonymous policy for unnamed producers too.
                if (isAnonymousName(producer.name) && !isAnonymousAllowed(currentRealmId())) {
                    server.logger.warn("ANONYMOUS producer rejected in realm '" + currentRealmId() + "' — anonymous producers are not allowed here.");
                    sendErrorMessage({message: "Anonymous producers are not allowed in realm '" + currentRealmId() + "'. Set a unique app_id per broker/instance.", code: -4});
                    socket.disconnect();
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
                if (producer.default_ttl !== undefined)
                    producerMeta.default_ttl = producer.default_ttl;

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

            onAuthorized('REMOTE_TICKET_REQUEST', [], function (message, callback) {
                if (typeof message === 'string')
                    try {
                        message = JSON.parse(message);
                    }
                    catch (e) {
                        var parseFail = {ok: false, code: 400, message: 'Invalid remote ticket request JSON'};
                        socket.emit('REMOTE_TICKET_FAIL', parseFail);
                        if (callback) callback(parseFail);
                        return;
                    }

                var data = message || {};
                var role = data.role === 'viewer' ? 'viewer' : 'agent';
                var sessionId = data.session_id || data.sessionId || crypto.randomBytes(8).toString('hex');
                var machineId = data.machine_id || data.machineId || data.client_id || data.clientId || socket.id;
                var ticket = remoteNamespace.issueTicket({
                    session_id: sessionId,
                    realm: currentRealmId(),
                    machine_id: machineId,
                    role: role
                });
                var response = {
                    ok: true,
                    session_id: sessionId,
                    ticket: ticket,
                    role: role,
                    expires_in: 60
                };
                socket.emit('REMOTE_TICKET', response);
                if (callback) callback(response);
                server.logger.info("REMOTE_TICKET issued session=" + sessionId + " role=" + role + " realm=" + currentRealmId());
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
                if (['producer', 'consumer', 'both', 'manager', 'admin'].indexOf(role) < 0)
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
                    socket_id: socket.id,
                    node_id: clusterSync ? clusterSync.nodeId : null
                };

                saveLatestAuthorizationRequest(request);
                mirrorAuthRequestToCluster(request);

                var response = {ok: true, request_id: request.request_id, status: request.status};
                socket.emit('AUTHORIZATION_REQUEST_OK', response);
                if (callback) callback(response);
            });

            socket.on('AUTHORIZATION_NEXT', function (message, callback) {
                message = message || {};
                var body = message.body || {};
                var verified = verifyAuthorizationNextProof(body, message.proof);
                if (!verified.ok) {
                    if (callback) callback(verified);
                    else socket.emit('AUTHORIZATION_FAIL', verified);
                    return;
                }

                claimClusterNonce(message.proof).then(function (claimed) {
                    if (!claimed) {
                        var used = {ok: false, code: 401, message: 'Manager proof nonce was already used'};
                        if (callback) callback(used);
                        else socket.emit('AUTHORIZATION_FAIL', used);
                        return;
                    }

                    findNextAuthorizationRequest(body).then(function (request) {
                        var response = {ok: true, request: publicAuthorizationRequest(request)};
                        if (callback) callback(response);
                        else socket.emit('AUTHORIZATION_NEXT_RESULT', response);
                    });
                });
            });

            socket.on('AUTHORIZATION_DECIDE', function (message, callback) {
                message = message || {};
                var body = message.body || {};
                lookupAuthorizationRequest(body.request_id).then(function (request) {
                    var verified = verifyAuthorizationDecisionProof(body, message.proof, request);
                    if (!verified.ok) {
                        if (callback) callback(verified);
                        else socket.emit('AUTHORIZATION_FAIL', verified);
                        return;
                    }

                    claimClusterNonce(message.proof).then(function (claimed) {
                        if (!claimed) {
                            var used = {ok: false, code: 401, message: 'Manager proof nonce was already used'};
                            if (callback) callback(used);
                            else socket.emit('AUTHORIZATION_FAIL', used);
                            return;
                        }

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
                            persistSettings();
                            if (isLocalRequester(request))
                                server.send(request.socket_id, 'AUTHORIZATION_APPROVED', {
                                    request_id: request.request_id,
                                    realm: request.realm,
                                    role: request.role
                                });
                        }
                        else {
                            if (isLocalRequester(request))
                                server.send(request.socket_id, 'AUTHORIZATION_REJECTED', {
                                    request_id: request.request_id,
                                    reason: request.decision_reason
                                });
                        }

                        syncLocalAuthRequest(request);
                        persistAuthDecisionToCluster(request);

                        var response = {ok: true, request: publicAuthorizationRequest(request)};
                        if (callback) callback(response);
                        else socket.emit('AUTHORIZATION_DECIDE_RESULT', response);
                    });
                });
            });

            socket.on('AUTH_MANAGEMENT_COMMAND', function (message, callback) {
                message = message || {};
                var body = message.body || {};
                var verified = verifyGlobalManagerProof('AUTH_MANAGEMENT_COMMAND', body, message.proof);
                if (!verified.ok) {
                    if (callback) callback(verified);
                    else socket.emit('AUTH_MANAGEMENT_FAIL', verified);
                    return;
                }

                claimClusterNonce(message.proof).then(function (claimed) {
                    if (!claimed) {
                        var used = {ok: false, code: 401, message: 'Manager proof nonce was already used'};
                        if (callback) callback(used);
                        else socket.emit('AUTH_MANAGEMENT_FAIL', used);
                        return;
                    }

                    var asyncCommand = handleAsyncManagementCommand(body);
                    if (asyncCommand) {
                        asyncCommand.then(function (response) {
                            if (callback) callback(response);
                            else socket.emit(response.ok ? 'AUTH_MANAGEMENT_RESULT' : 'AUTH_MANAGEMENT_FAIL', response);
                        }).catch(function (err) {
                            var fail = {ok: false, code: 500, message: err.message};
                            if (callback) callback(fail);
                            else socket.emit('AUTH_MANAGEMENT_FAIL', fail);
                        });
                        return;
                    }

                    var response = applyAuthManagementCommand(body);
                    if (callback) callback(response);
                    else socket.emit('AUTH_MANAGEMENT_RESULT', response);
                });
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

                var hasToken = !!(message && typeof message.token === 'string' && message.token);
                var requestedRole = (message && typeof message.role === 'string' && message.role)
                    ? message.role : null;

                // Manager connections always require manual authorization — the
                // role is only obtainable through an approved or configured token.
                if (!hasToken && requestedRole === 'manager') {
                    sendAuthFail(socket, 401, "Manager role requires manual authorization");
                    return;
                }

                // Allow token-less access to explicitly open realms.
                if (!hasToken && desiredRealm && !isAuthRequiredForRealm(desiredRealm)) {
                    var openRole = CONNECT_ROLES.indexOf(requestedRole) >= 0 ? requestedRole : 'both';
                    socket.tyoAuth = {
                        authenticated: true,
                        realm: desiredRealm,
                        role: openRole
                    };
                    getRealm(desiredRealm);
                    server.logger.info("AUTHENTICATION: open realm '" + desiredRealm + "' — token not required, socket=" + socket.id);
                    socket.emit('AUTH_OK', {realm: desiredRealm, role: openRole});
                    return;
                }

                // Role-declared connection authorization (no token):
                //  - consumer / both present the realm pre-shared key when required
                //  - producer / both must be accepted into the realm when required
                if (!hasToken && (requestedRole || (message && message.key !== undefined))) {
                    var connectRole = CONNECT_ROLES.indexOf(requestedRole) >= 0 ? requestedRole : 'both';
                    var effectiveRealm = desiredRealm || DEFAULT_REALM;

                    if ((connectRole === 'consumer' || connectRole === 'both') && isKeyRequiredForRealm(effectiveRealm)) {
                        var realmKey = getRealmPresharedKey(effectiveRealm);
                        if (!realmKey || !message || message.key !== realmKey) {
                            sendAuthFail(socket, 401, "Realm '" + effectiveRealm + "' requires a valid pre-shared key");
                            return;
                        }
                    }

                    if ((connectRole === 'producer' || connectRole === 'both') && isAcceptanceRequiredForRealm(effectiveRealm)) {
                        sendAuthFail(socket, 403, "Producer must be accepted into realm '" + effectiveRealm + "'");
                        return;
                    }

                    socket.tyoAuth = {
                        authenticated: true,
                        realm: effectiveRealm,
                        role: connectRole
                    };
                    getRealm(effectiveRealm);
                    server.logger.info("AUTHENTICATION: connection authorized — realm='" + effectiveRealm + "' role='" + connectRole + "' socket=" + socket.id);
                    socket.emit('AUTH_OK', {realm: effectiveRealm, role: connectRole});
                    return;
                }

                if (!hasToken) {
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
                Object.keys(pendingAcks).forEach(function (msgId) {
                    if (pendingAcks[msgId].socket === socket.id) {
                        clearTimeout(pendingAcks[msgId].timer);
                        delete pendingAcks[msgId];
                    }
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
                        producerMeta.offline_at = Date.now();

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
                            consumerMeta.offline_at = Date.now();
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
