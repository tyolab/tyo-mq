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

module.exports = {
    MemoryStore: MemoryStore,
    createStore: createStore
};

Object.defineProperty(module.exports, 'RedisStore', {
    enumerable: true,
    get: function () { return require('./redis'); }
});

Object.defineProperty(module.exports, 'SQLiteStore', {
    enumerable: true,
    get: function () { return require('./sqlite'); }
});
