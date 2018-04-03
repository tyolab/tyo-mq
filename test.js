var childProcess = require('child_process');

var MessageQueue = require('./lib/message-queue');
var mq = new MessageQueue();

var forkServer = false;

var noexit = false;
var port;
var host;
var protocol;

function usage() {
    console.log('node test.js [--noexit] [-h host] [-p port]');
    exit();
}

function exit() {
    process.exit(0);
}

function exitCheck() {
    if (!noexit)
        exit();
}

function errorUnknownOption (opt) {
    console.log("Unknown option: " + opt);
    exit();
}

var param = 2;
if (process.argv.length > 2) {
    for (; param < process.argv.length; ++param) {
        var paramStr = process.argv[param];
    	var o = paramStr.charAt(0);
    	if (o === '-' && paramStr.length > 1) {
    		var c = paramStr.charAt(1);
	        switch (c) {
	            case '?':
                    usage();
                    break;
                case 'p':
                    port = process.argv[++param];
                    break;
                case 'h':
                    host = process.argv[++param];
	                break;
                case '-': {
                    // long option
                    var cc = paramStr.substr(2);
                    if (cc === 'noexit')
                        noexit = true;
                    else if (cc == 'port')
                        port = process.argv[++param];
                    else if (cc == 'host')
                        host = process.argv[++param];
                    break;
                }
	        }
        }
        else {
        	errorUnknownOption(paramStr);
        }
    }
}

mq.host = host;
mq.port = port;

var main = function () {
    var producer;
    var consumer;

    function disconnectConsumer () {
        consumer.disconnect();
    }

    mq.createProducer("TYO Lab")
    .then(function (p) {
        console.log('Producer: ' + p.getId());
        producer = p;

        // Reset the onConnect Listener
        producer.on('connect', function ()  {
            console.log('producer\'s own connect listenr');
        });

        return mq.createConsumer("TYO Lab Tester");
    })
    .then(function (c) {
        console.log('Subscriber: ' + c.getId());
        consumer = c;
        var test = 0;

        // this listener will be only effective after the current connection is lost
        // and get reconnected again
        consumer.on('connect', function ()  {
            console.log('consumer\'s own connect listenr');
        });

        consumer.subscribe(producer.name, 'tyo-mq-mt-default', (data, from) => {
            if (from)
                console.log("Received message from")

            test += 1;
            if (data === 'test-a') 
                console.log('test1 succeeded!');
            else   
                console.log('test1 failed');

            if (test === 2) disconnectConsumer();
        });

        consumer.subscribe(producer.name, 'tyo-mq-mt-test2', (data, from) => {
            test += 1;
            if (data === 'test-b') 
                console.log('test2 succeeded!');
            else   
                console.log('test2 failed');

            if (test === 2) disconnectConsumer();
        });

        producer.onSubscriberLost(consumer.getId(), function ()  {
            test += 1;

            console.log('Informed that connection with a subscriber was lost');

            if (test === 3) exitCheck();
        });

        // wait for 3 seconds before we produce message
        setTimeout(function () {
            producer.produce('tyo-mq-mt-default', 'test-a');
            producer.produce('tyo-mq-mt-test2', 'test-b');
        }, 3000);

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
