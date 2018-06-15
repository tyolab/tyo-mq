
function Constants() {
    this.ANONYMOUS = 'ANONYMOUS';
    this.EVENT_DEFAULT = 'tyo-mq-mt-default';
    this.SYSTEM = 'TYO-MQ-SYSTEM';
    this.ALL_PUBLISHERS = 'TYO-MQ-ALL';
    
    this.DEFAULT_PORT = 17352;
}

var constants = constants || new Constants();

module.exports = constants;