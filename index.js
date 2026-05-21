const Factory = require('./lib/factory');

module.exports = {
    Factory: Factory,
    Server: require('./lib/server'),
    Settings: require('./lib/settings'),

    // @depreciated
    MessageQueue: Factory
};
