/**
 * Storage backend factory for durable queues.
 */

'use strict';

const MemoryStore = require('./memory');

function createStore(options) {
    options = options || {};
    var storage = options.storage || options.store || 'memory';
    var storageOptions = options.storage_options || options.storageOptions || {};

    if (storage && typeof storage.enqueue === 'function'
            && typeof storage.dequeue === 'function'
            && typeof storage.ack === 'function')
        return storage;

    if (storage === 'memory' || storage === true)
        return new MemoryStore(storageOptions);

    if (storage === 'sqlite') {
        const SQLiteStore = require('./sqlite');
        return new SQLiteStore(storageOptions);
    }

    if (storage === 'redis') {
        const RedisStore = require('./redis');
        return new RedisStore(storageOptions);
    }

    if (typeof storage === 'function')
        return storage(storageOptions);

    throw new Error('Unsupported storage backend: ' + storage);
}

// Build the storage_options for the fallback backend from the redis options,
// carrying default_ttl and mapping fallback_filename → the sqlite file.
function fallbackOptions(storageOptions) {
    var out = {};
    if (storageOptions.default_ttl !== undefined) out.default_ttl = storageOptions.default_ttl;
    if (storageOptions.defaultTtl !== undefined) out.defaultTtl = storageOptions.defaultTtl;
    var file = storageOptions.fallback_filename || storageOptions.fallbackFilename
        || storageOptions.fallback_path || storageOptions.fallbackPath;
    if (file) out.filename = file;
    return out;
}

/**
 * Async store selection with startup fallback.
 *
 * For `storage: 'redis'` WITH `storage_options.fallback` set (e.g. 'sqlite'),
 * this probes Redis at startup and, if it is unreachable within
 * `storage_options.probe_timeout` ms, transparently falls back to the fallback
 * backend so the broker still has a working durable store on disk. Every other
 * configuration resolves synchronously exactly like createStore().
 *
 * Resolves to { store, backend, fellBack, error } so the caller can log.
 */
function createStoreAsync(options) {
    options = options || {};
    var storage = options.storage || options.store || 'memory';
    var storageOptions = options.storage_options || options.storageOptions || {};

    if (storage === 'redis' && storageOptions.fallback) {
        const RedisStore = require('./redis');
        var primary;
        try {
            primary = new RedisStore(storageOptions);
        }
        catch (err) {
            // Even constructing the client failed (e.g. redis pkg missing) —
            // go straight to the fallback rather than throwing.
            return Promise.resolve(buildFallback(storageOptions, err));
        }
        var probeMs = Number(storageOptions.probe_timeout || storageOptions.probeTimeout) || 5000;
        return primary.probe(probeMs).then(function () {
            return { store: primary, backend: 'redis', fellBack: false, error: null };
        }).catch(function (err) {
            return buildFallback(storageOptions, err);
        });
    }

    return Promise.resolve({
        store: createStore(options),
        backend: (typeof storage === 'string' ? storage : 'custom'),
        fellBack: false,
        error: null
    });
}

function buildFallback(storageOptions, error) {
    var backend = String(storageOptions.fallback || 'sqlite').toLowerCase();
    if (backend === 'redis') backend = 'sqlite'; // a redis fallback for redis makes no sense
    var store = createStore({ storage: backend, storage_options: fallbackOptions(storageOptions) });
    return { store: store, backend: backend, fellBack: true, error: error };
}

module.exports = {
    MemoryStore: MemoryStore,
    createStore: createStore,
    createStoreAsync: createStoreAsync
};

Object.defineProperty(module.exports, 'RedisStore', {
    enumerable: true,
    get: function () { return require('./redis'); }
});

Object.defineProperty(module.exports, 'SQLiteStore', {
    enumerable: true,
    get: function () { return require('./sqlite'); }
});
