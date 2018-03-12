

mq.host = "lab2.tyolab.com";

var producer;
var consumer;

function updateProducerStatus(connected) {
    var elem = document.getElementById('producer-status');
    updateConnectionStatus(elem, connected);
}

function updateConsumerStatus(connected) {
    var elem = document.getElementById('consumer-status');
    updateConnectionStatus(elem, connected);
}

function updateConnectionStatusById(connected, id) {
    var elem = document.getElementById(id);
    updateConnectionStatus(elem, connected);
}

function updateConnectionStatus(elem, connected) {
    if (!elem)
        return;

    if (connected) {
        elem.innerHTML = "Connected to MQ Server";
    }
    else {
        elem.innerHTML = "Disconnected";
    }
}

function updateMessageFromPublisher(message) {
    var elem = document.getElementById('message-received');
    elem.innerHTML = message;
}

function publish() {
    var message = document.getElementById('message-to-send').value;
    var type = document.getElementById('message-type-producer').value;
    producer.produce(type, message);
}

function onConnect(entity, id) {
    updateConnectionStatusById(true, id);

    entity.on('disconnect', function ()  {
        updateConnectionStatusById(false, id);
    });
}

function connect(entity, id) {
    if (entity) {
        entity.disconnect();
        entity.connect(function ()  {
                    onConnect(entity, id);
                },
            mq.port,
            mq.host);
    }
}

function disableSometing(socket) {
    // You can't do it here
    // socket.disable('browser client cache');
    // socket.disable('heartbeats');
}

function connectProducerToServer() {
    if (producer) {
        disableSometing(producer);

        connect(producer);
    }
    else {
        var publishType = document.getElementById('message-type-producer').value;
        mq.createProducer(publishType, function (p) {
            producer = p;
            disableSometing(producer);

            onConnect(producer, 'producer-status');
        });
    }
}

function connectConsumerToServer() {
    if (consumer) {
        disableSometing(consumer);

        connect(consumer);

        updateSubscription();
    }
    else {
        var subscribeType = document.getElementById('message-type-consumer').value;
        mq.createConsumer(subscribeType, function (c) {
            consumer = c;
            disableSometing(consumer);

            onConnect(consumer, 'consumer-status');

            updateSubscription();
        });
    }
}

function updateMQServer() {
    mq.host = document.getElementById('server').value;

    connectProducerToServer();
    connectConsumerToServer();
}

function updateSubscription() {
    var subscribeType = document.getElementById('message-type-consumer').value;
    if (consumer) {
        if (!consumer.connected)
            connectConsumerToServer();

        consumer.subscribe(subscribeType, function (message) {
            updateMessageFromPublisher(message);
        });
    }
}

// mq.createConsumer(function (c) {
//         consumer = c;
//         console.log('Subscriber: ' + consumer.getId());
//         var test = 0;

//         consumer.on('connect', function ()  {
//             console.log('consumer\'s own connect listenr');
//         });

//         consumer.subscribe('test', (data) => {
//             test += 1;
//             if (data === 'test-a') 
//                 console.log('test1 succeeded!');
//             else   
//                 console.log('test1 failed');

//             //if (test === 2) disconnectConsumer();
//         });

//         consumer.subscribe('test2', (data) => {
//             test += 1;
//             if (data === 'test-b') 
//                 console.log('test2 succeeded!');
//             else   
//                 console.log('test2 failed');

//             //if (test === 2) disconnectConsumer();
//         });
//     }
// );

