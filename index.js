const Factory = require('./lib/factory');

module.exports = { 
    Factory: Factory,
    Server: require('./lib/server'),

    // @depreciated
    MessageQueue: Factory
};
