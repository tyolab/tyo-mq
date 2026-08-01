'use strict';
const clientMoved = (sym) => { throw new Error(
    "tyo-mq's client moved to its own Apache-2.0 package '" + sym + "' is now in tyo-mq-client.\n" +
    "  Run: npm install tyo-mq-client\n" +
    "  Then: const { " + sym + " } = require('tyo-mq-client')   // same API"); };
module.exports = {
    Server: require('./lib/server'),
    Settings: require('./lib/settings'),
    Storage: require('./lib/storage'),
    get Factory() { clientMoved('Factory'); },
    get Authorization() { clientMoved('Authorization'); },
    get MessageQueue() { clientMoved('Factory'); },
};
