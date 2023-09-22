
function Constants() {
    this.ANONYMOUS = 'ANONYMOUS';
    
    this.EVENT_DEFAULT = 'tyo-mq-mt-default';
    this.EVENT_ALL = 'TM-ALL';
    
    this.SYSTEM = 'TYO-MQ-SYSTEM';
    this.ALL_PUBLISHERS = 'TYO-MQ-ALL';

    this.SCOPE_ALL = "all";
    this.SCOPE_DEFAULT = "default";
    
    this.DEFAULT_PORT = 17352;
}

var constants = constants || new Constants();

module.exports = constants;