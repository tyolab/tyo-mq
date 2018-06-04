
function Constants() {
    this.ANONYMOUS = 'ANONYMOUS';
    this.EVENT_DEFAULT = 'tyo-mq-mt-default';
    this.SYSTEM = 'TYO-MQ-SYSTEM';
    this.ALL_PUBLISHERS = 'TYO-MQ-ALL';
}

var constants = constants || new Constants();

module.exports = constants;