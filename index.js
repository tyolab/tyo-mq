const Factory = require('./lib/factory');

module.exports = {
    Authorization: require('./lib/authorization'),
    Factory: Factory,
    Server: require('./lib/server'),
    Settings: require('./lib/settings'),
    Storage: require('./lib/storage'),

    // @depreciated
    MessageQueue: Factory
};
