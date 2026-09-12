/**
 * @file prekey-store.js
 *
 * SQLite-backed durable store for the Signal prekey directory (secure-chat).
 * Companion to the in-memory per-realm `realm.prekeys` map in lib/server.js
 * (the hot path); this store is its backing tape so a published X3DH/PQXDH
 * bundle SURVIVES A BROKER RESTART.
 *
 * Why this exists: the prekey directory was in-memory / node-local only, so
 * every broker restart (a deploy, a crash) silently dropped every account's
 * published bundle. A long-lived account only publishes at registration (the
 * client's re-publish hook, replenishPrekeys, is not yet implemented), so
 * after one restart a fresh contact taking that account's bundle got nothing
 * back (`found:false`) and the accepter's first send failed with NoSession —
 * even though X3DH itself was fine. Persisting the directory closes that gap:
 * on boot the directory hydrates from here.
 *
 * Mirrors lib/notify-push-store.js (the push registry's backing tape): same
 * node:sqlite binding, same WAL + busy_timeout pragmas, same best-effort
 * contract (the in-memory directory is authoritative during a run; a store
 * write must never break a live PREKEY_PUBLISH / PREKEY_TAKE).
 *
 * Only public key material is stored — the broker never sees a private key.
 */

'use strict';

let DatabaseSync;
try {
    DatabaseSync = require('node:sqlite').DatabaseSync;
}
catch (err) {
    DatabaseSync = null;
}

function PrekeyStore(options) {
    options = options || {};
    if (!DatabaseSync)
        throw new Error('The SQLite prekey store requires a Node.js runtime with node:sqlite support (Node 22+)');

    this.filename = options.filename || options.file || options.path || 'tyo-mq.prekeys.sqlite';
    this.db = new DatabaseSync(this.filename);
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA busy_timeout = 5000');
    // Static X3DH (identity + signed prekey) and PQXDH (Kyber prekey) material.
    this.db.exec(
        'CREATE TABLE IF NOT EXISTS prekey_bundles (' +
        'realm TEXT NOT NULL,' +
        'identity TEXT NOT NULL,' +
        'identity_key TEXT NOT NULL,' +
        'registration_id INTEGER,' +
        'device_id INTEGER,' +
        'signed_prekey_id INTEGER,' +
        'signed_prekey TEXT,' +
        'signed_prekey_sig TEXT,' +
        'kyber_prekey_id INTEGER,' +
        'kyber_prekey TEXT,' +
        'kyber_prekey_sig TEXT,' +
        'updated_at TEXT,' +
        'PRIMARY KEY (realm, identity)' +
        ')'
    );
    // The one-time prekey pool, one row per {id, key}. Consumed one at a time
    // by PREKEY_TAKE, so a consumed OTK is deleted here and never resurrected.
    this.db.exec(
        'CREATE TABLE IF NOT EXISTS prekey_one_time (' +
        'realm TEXT NOT NULL,' +
        'identity TEXT NOT NULL,' +
        'otk_id INTEGER NOT NULL,' +
        'key TEXT NOT NULL,' +
        'PRIMARY KEY (realm, identity, otk_id)' +
        ')'
    );
}

// Upsert one account's bundle. The static material is replaced in place, and
// the one-time pool rows are rewritten to EXACTLY match `bundle.one_time` (the
// in-memory pool after its append + PREKEY_POOL_MAX cap), so disk stays a true
// mirror of memory. Wrapped in a transaction so a bundle is never half-written.
PrekeyStore.prototype.putBundle = function (realm, identity, bundle) {
    bundle = bundle || {};
    realm = String(realm);
    identity = String(identity);
    this.db.exec('BEGIN');
    try {
        this.db.prepare(
            'INSERT OR REPLACE INTO prekey_bundles ' +
            '(realm, identity, identity_key, registration_id, device_id, ' +
            'signed_prekey_id, signed_prekey, signed_prekey_sig, ' +
            'kyber_prekey_id, kyber_prekey, kyber_prekey_sig, updated_at) ' +
            'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
        ).run(
            realm, identity, String(bundle.identity_key),
            Number(bundle.registration_id) || 0,
            Number(bundle.device_id) || 0,
            Number(bundle.signed_prekey_id) || 0,
            bundle.signed_prekey != null ? String(bundle.signed_prekey) : null,
            bundle.signed_prekey_sig != null ? String(bundle.signed_prekey_sig) : null,
            Number(bundle.kyber_prekey_id) || 0,
            bundle.kyber_prekey != null ? String(bundle.kyber_prekey) : null,
            bundle.kyber_prekey_sig != null ? String(bundle.kyber_prekey_sig) : null,
            bundle.updated_at != null ? String(bundle.updated_at) : null
        );
        this.db.prepare('DELETE FROM prekey_one_time WHERE realm = ? AND identity = ?')
            .run(realm, identity);
        var pool = Array.isArray(bundle.one_time) ? bundle.one_time : [];
        var insertOtk = this.db.prepare(
            'INSERT OR REPLACE INTO prekey_one_time (realm, identity, otk_id, key) VALUES (?, ?, ?, ?)'
        );
        for (var i = 0; i < pool.length; i++) {
            var e = pool[i];
            if (!e || e.key == null || !Number.isFinite(Number(e.id))) continue;
            insertOtk.run(realm, identity, Number(e.id), String(e.key));
        }
        this.db.exec('COMMIT');
    }
    catch (err) {
        try { this.db.exec('ROLLBACK'); } catch (e) {}
        throw err;
    }
};

// Delete one consumed one-time prekey (called after PREKEY_TAKE shifts it out
// of the in-memory pool) so a restart cannot hand the same OTK out twice.
PrekeyStore.prototype.consumeOneTime = function (realm, identity, otkId) {
    this.db.prepare(
        'DELETE FROM prekey_one_time WHERE realm = ? AND identity = ? AND otk_id = ?'
    ).run(String(realm), String(identity), Number(otkId));
};

// Remove an account's whole bundle (static row + its one-time pool). For a
// future unclaim/eviction path; kept symmetric with putBundle.
PrekeyStore.prototype.delBundle = function (realm, identity) {
    realm = String(realm);
    identity = String(identity);
    this.db.exec('BEGIN');
    try {
        this.db.prepare('DELETE FROM prekey_bundles WHERE realm = ? AND identity = ?')
            .run(realm, identity);
        this.db.prepare('DELETE FROM prekey_one_time WHERE realm = ? AND identity = ?')
            .run(realm, identity);
        this.db.exec('COMMIT');
    }
    catch (err) {
        try { this.db.exec('ROLLBACK'); } catch (e) {}
        throw err;
    }
};

// Every stored bundle, reconstructed into the in-memory shape
// ({identity_key, ..., one_time: [{id, key}, ...]}) keyed for hydrate on boot.
// Returns [{realm, identity, bundle}, ...].
PrekeyStore.prototype.allBundles = function () {
    var rows = this.db.prepare(
        'SELECT realm, identity, identity_key, registration_id, device_id, ' +
        'signed_prekey_id, signed_prekey, signed_prekey_sig, ' +
        'kyber_prekey_id, kyber_prekey, kyber_prekey_sig, updated_at ' +
        'FROM prekey_bundles'
    ).all();
    var otkStmt = this.db.prepare(
        'SELECT otk_id, key FROM prekey_one_time WHERE realm = ? AND identity = ? ORDER BY otk_id'
    );
    var out = [];
    for (var i = 0; i < rows.length; i++) {
        var r = rows[i];
        var otks = otkStmt.all(r.realm, r.identity).map(function (o) {
            return { id: o.otk_id, key: o.key };
        });
        out.push({
            realm: r.realm,
            identity: r.identity,
            bundle: {
                identity_key: r.identity_key,
                registration_id: r.registration_id,
                device_id: r.device_id,
                signed_prekey_id: r.signed_prekey_id,
                signed_prekey: r.signed_prekey,
                signed_prekey_sig: r.signed_prekey_sig,
                kyber_prekey_id: r.kyber_prekey_id,
                kyber_prekey: r.kyber_prekey,
                kyber_prekey_sig: r.kyber_prekey_sig,
                updated_at: r.updated_at,
                one_time: otks
            }
        });
    }
    return out;
};

PrekeyStore.prototype.close = function () {
    this.db.close();
};

PrekeyStore.isSupported = function () {
    return !!DatabaseSync;
};

module.exports = PrekeyStore;
