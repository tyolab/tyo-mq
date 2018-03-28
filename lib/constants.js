'use strict'

function Constants() {
    this.ANONYMOUS = "ANONYMOUS";
    this.EVENT_DEFAULT = 'tyo-mq-mt-default';
    this.SYSTEM = "TYO-MQ-SYSTEM";
}

var constants = constants || new Constants();

module.exports = constants;