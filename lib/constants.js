
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
}

var constants = constants || new Constants();

module.exports = constants;