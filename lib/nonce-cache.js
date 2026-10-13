/**
 * NonceCache — bounded replay protection for signed manager proofs.
 *
 * A proof's nonce must be single-use, but it does not have to be remembered
 * forever: verifyAdminProof already rejects any proof whose timestamp is more
 * than `maxAgeMs` away from now (in either direction), so a nonce older than
 * 2 * maxAgeMs can never be replayed successfully. Remembering nonces in a
 * plain Set grew by one entry per manager command for the life of the process.
 *
 * `has` / `add` mirror the Set API the broker used before. The clock is
 * injectable so the expiry can be tested without sleeping.
 */
'use strict';

function NonceCache(options) {
    options = options || {};
    this.maxAgeMs = options.maxAgeMs || 5 * 60 * 1000;
    // Covers the full ±maxAgeMs acceptance window of verifyAdminProof.
    this.retainMs = 2 * this.maxAgeMs;
    this.now = options.now || Date.now;
    this.entries = new Map(); // nonce -> insertedAt
    this._lastPrune = this.now();
    // Pruning is for memory, not correctness (`has` checks expiry inline), so
    // it only needs to run every so often.
    this.pruneEveryMs = Math.min(30 * 1000, Math.max(1, Math.floor(this.retainMs / 4)));
}

NonceCache.prototype.prune = function () {
    var now = this.now();
    this._lastPrune = now;
    var cutoff = now - this.retainMs;
    var self = this;
    this.entries.forEach(function (insertedAt, nonce) {
        if (insertedAt <= cutoff) self.entries.delete(nonce);
    });
};

NonceCache.prototype._maybePrune = function () {
    if (this.now() - this._lastPrune >= this.pruneEveryMs) this.prune();
};

// True when `nonce` was seen within the retention window.
NonceCache.prototype.has = function (nonce) {
    this._maybePrune();
    var insertedAt = this.entries.get(nonce);
    return insertedAt !== undefined && insertedAt > this.now() - this.retainMs;
};

NonceCache.prototype.add = function (nonce) {
    this._maybePrune();
    this.entries.set(nonce, this.now());
    return this;
};

// Live (unexpired) entry count. Prunes first so the number is honest.
NonceCache.prototype.size = function () {
    this.prune();
    return this.entries.size;
};

module.exports = NonceCache;
