
function Constants() {
    this.ANONYMOUS = 'ANONYMOUS';
    
    this.EVENT_DEFAULT = 'tyo-mq-mt-default';
    this.EVENT_ALL = 'TM-ALL';
    
    this.SYSTEM = 'TYO-MQ-SYSTEM';
    this.ALL_PUBLISHERS = 'TYO-MQ-ALL';

    this.SCOPE_ALL = "all";
    this.SCOPE_DEFAULT = "default";
    
    this.DEFAULT_PORT = 17352;

    // E2EE public-key directory caps (E2EE.md). A base64 uncompressed P-256
    // point is ~88 chars — 4 KB leaves ample headroom for any future suite
    // while keeping directory entries un-abusable as a memory sink.
    this.E2EE_MAX_PUBLIC_KEY_LENGTH = 4096;
    this.E2EE_MAX_KEY_ID_LENGTH = 128;
    this.E2EE_MAX_KEYS_PER_IDENTITY = 8;

    // Signal prekey directory (secure-chat): a client publishes a prekey bundle
    // (identity key + signed prekey + a pool of one-time prekeys); a peer TAKEs
    // it, consuming one one-time prekey. Cap the pool so it cannot grow without
    // bound, and cap how many prekeys one PREKEY_PUBLISH may add at once.
    this.PREKEY_POOL_MAX = 100;
    this.PREKEY_PUBLISH_BATCH_MAX = 100;

    // Sealed-sender broker: anonymous senders present a short-lived sender
    // cert plus a per-recipient unidentified access key (UAK) instead of an
    // authenticated identity.
    this.SEALED_CERT_TTL_MS = 24 * 60 * 60 * 1000;   // sender cert validity (24h)
    this.SEALED_UAK_LENGTH = 16;                     // bytes, matches core derive_uak
    this.SEALED_MAX_BLOB_LENGTH = 65536;             // reject absurd sealed blobs (64 KiB)
    this.SEALED_SENDS_PER_MIN = 60;                  // per-connection anon sealed-send budget
}

var constants = constants || new Constants();

module.exports = constants;