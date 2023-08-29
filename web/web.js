var Factory = require('../lib/factory');
var Producer = require('../lib/publisher');
var Consumer = require('../lib/subscriber');

var mq = {
    Factory: Factory,
    Producer: Producer,
    Consumer: Consumer,
    Publisher: Producer,
    Subscriber: Consumer,
    factory: new Factory()
};

window.mq = mq;