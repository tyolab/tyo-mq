var childProcess = require('child_process');

var MessageQueue = require('.');
var mq = new MessageQueue();

var forkServer = false;

var noexit = false;

function usage() {
    console.log('node test.js [--noexit] [-h]');
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
    	if (o === '-' && paramStr.length > 2) {
    		var c = paramStr.charAt(1);
	        switch (c) {
	            case 'h':
                    usage();
	                break;
                case '-': {
                    // long option
                    var cc = paramStr.substr(2);
                    if (cc === 'noexit')
                        noexit = true;
                    break;
                }
	        }
        }
        else {
        	errorUnknownOption(paramStr);
        }
    }
}

var main = function () {
    var producer;
    var consumer;
    mq.createProducer('test')
    .then((p) => {
        producer = p;
        producer.on('connect', () => {
            console.log('producer\'s own connect listenr');
        });

        return mq.createConsumer();
    })
    .then((c) => {
        consumer = c;
        var test = 0;

        consumer.on('connect', () => {
            console.log('consumer\'s own connect listenr');
        });

        consumer.subscribe('test', (data) => {
            test += 1;
            if (data === 'test-a') 
                console.log('test1 succeeded!');
            else   
                console.log('test1 failed');

            if (test === 2) exitCheck();
        });

        consumer.subscribe('test2', (data) => {
            test += 1;
            if (data === 'test-b') 
                console.log('test2 succeeded!');
            else   
                console.log('test2 failed');

            if (test === 2) exitCheck();
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
