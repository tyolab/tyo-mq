var childProcess = require('child_process');

var MessageQueue = require('.');
var mq = new MessageQueue();

var forkServer = false;

var main = function () {
    var producer;
    var consumer;
    mq.createProducer('test')
    .then((p) => {
        producer = p;

        return mq.createConsumer();
    })
    .then((c) => {
        consumer = c;

        consumer.subscribe('test', (data) => {
            if (data === 'test-a') 
                console.log('test1 succeeded!');
            else   
                console.log('test1 failed');
        });

        consumer.subscribe('test2', (data) => {
            if (data === 'test-b') 
                console.log('test2 succeeded!');
            else   
                console.log('test2 failed');
        });

        producer.produce('test', 'test-a');
        producer.produce('test2', 'test-b');
    });
}

if (forkServer)
{
    try {
        var child = childProcess.fork('server.js');

        child.on('message', function(m) {
            console.log(m);
            main();
        });

        child.on('exit', (code, signal) => {
        });
    }
    catch (err) {
        console.error('cannot fork server.js');
        main();
    }
}
else
    main();