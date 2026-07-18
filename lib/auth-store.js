/**
 * @file auth-store.js
 *
 * SQLite-backed store for the server's dynamic auth data: realms, tokens,
 * and management tokens. The in-memory settings object remains the runtime
 * representation — this store is the durable, transactional copy of the
 * sections that grow without bound, replacing the whole-file JSON rewrite.
 *
 * Rows hold JSON blobs keyed by realm name / token string, so realm configs
 * keep their free-form shape while writes stay row-level: sync() diffs the
 * incoming auth object against what the store last wrote and applies only
 * the changed rows, inside one transaction (WAL mode — a crash mid-write
 * can never corrupt or truncate the data).
 */

'use strict';

const stableStringify = require('./admin-signature').stableStringify;

let DatabaseSync;
try {
    DatabaseSync = require('node:sqlite').DatabaseSync;
}
catch (err) {
    DatabaseSync = null;
}

const SECTIONS = [
    {table: 'realms', keyColumn: 'name'},
    {table: 'tokens', keyColumn: 'token'},
    {table: 'management_tokens', keyColumn: 'token'}
];

function AuthStore(options) {
    options = options || {};
    if (!DatabaseSync)
        throw new Error('The SQLite auth store requires a Node.js runtime with node:sqlite support (Node 22+)');

    this.filename = options.filename || options.file || options.path || 'tyo-mq.auth.sqlite';
    this.db = new DatabaseSync(this.filename);
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec([
        'CREATE TABLE IF NOT EXISTS realms (',
        'name TEXT PRIMARY KEY,',
        'config TEXT NOT NULL',
        ');',
        'CREATE TABLE IF NOT EXISTS tokens (',
        'token TEXT PRIMARY KEY,',
        'entry TEXT NOT NULL',
        ');',
        'CREATE TABLE IF NOT EXISTS management_tokens (',
        'token TEXT PRIMARY KEY,',
        'entry TEXT NOT NULL',
        ');'
    ].join(' '));

    // Last-synced state per section: {key: stableJson}. Built by load(),
    // maintained by sync(), so diffs never need to re-read the database.
    this._cache = null;
}

// Normalize an auth object into the three keyed sections the store persists.
AuthStore.prototype._sections = function (auth) {
    auth = auth || {};
    var realms = {};
    Object.keys(auth.realms || {}).forEach(function (name) {
        realms[name] = stableStringify(auth.realms[name] || {});
    });

    var keyedTokens = function (list) {
        var out = {};
        (list || []).forEach(function (entry) {
            if (entry && typeof entry.token === 'string' && entry.token)
                out[entry.token] = stableStringify(entry);
        });
        return out;
    };

    return {
        realms: realms,
        tokens: keyedTokens(auth.tokens),
        management_tokens: keyedTokens(auth.management_tokens || auth.managementTokens)
    };
};

/**
 * Read everything back out. Returns {realms, tokens, management_tokens} in
 * the same shape the settings object uses, and primes the diff cache.
 */
AuthStore.prototype.load = function () {
    var db = this.db;
    var cache = {realms: {}, tokens: {}, management_tokens: {}};
    var result = {realms: {}, tokens: [], management_tokens: []};

    db.prepare('SELECT name, config FROM realms').all().forEach(function (row) {
        try {
            result.realms[row.name] = JSON.parse(row.config);
            cache.realms[row.name] = stableStringify(result.realms[row.name]);
        }
        catch (err) { /* skip unreadable row */ }
    });

    [['tokens', 'tokens'], ['management_tokens', 'management_tokens']].forEach(function (pair) {
        db.prepare('SELECT token, entry FROM ' + pair[0]).all().forEach(function (row) {
            try {
                var entry = JSON.parse(row.entry);
                result[pair[1]].push(entry);
                cache[pair[1]][row.token] = stableStringify(entry);
            }
            catch (err) { /* skip unreadable row */ }
        });
    });

    this._cache = cache;
    return result;
};

/**
 * Write-through: bring the store in line with `auth`, touching only the
 * rows that changed. Everything runs in one transaction.
 */
AuthStore.prototype.sync = function (auth) {
    if (!this._cache)
        this.load();

    var db = this.db;
    var cache = this._cache;
    var next = this._sections(auth);
    var statements = [];

    SECTIONS.forEach(function (section) {
        var valueColumn = section.table === 'realms' ? 'config' : 'entry';
        var current = cache[section.table];
        var wanted = next[section.table];

        Object.keys(wanted).forEach(function (key) {
            if (current[key] !== wanted[key])
                statements.push({
                    sql: 'INSERT INTO ' + section.table + ' (' + section.keyColumn + ', ' + valueColumn + ') VALUES (?, ?) '
                        + 'ON CONFLICT(' + section.keyColumn + ') DO UPDATE SET ' + valueColumn + ' = excluded.' + valueColumn,
                    args: [key, wanted[key]]
                });
        });
        Object.keys(current).forEach(function (key) {
            if (!(key in wanted))
                statements.push({
                    sql: 'DELETE FROM ' + section.table + ' WHERE ' + section.keyColumn + ' = ?',
                    args: [key]
                });
        });
    });

    if (statements.length === 0)
        return 0;

    db.exec('BEGIN IMMEDIATE');
    try {
        statements.forEach(function (statement) {
            var prepared = db.prepare(statement.sql);
            prepared.run.apply(prepared, statement.args);
        });
        db.exec('COMMIT');
    }
    catch (err) {
        try { db.exec('ROLLBACK'); } catch (rollbackErr) { /* already failed */ }
        throw err;
    }

    this._cache = next;
    return statements.length;
};

/**
 * Consistent online backup — safe while the server is running.
 */
AuthStore.prototype.backup = function (destination) {
    var prepared = this.db.prepare('VACUUM INTO ?');
    prepared.run(destination);
};

AuthStore.prototype.close = function () {
    this.db.close();
};

AuthStore.isSupported = function () {
    return !!DatabaseSync;
};

module.exports = AuthStore;
