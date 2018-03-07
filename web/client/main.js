

mq.host = "lab2.tyolab.com";

var producer;
var consumer;

function updateProducerStatus(connected) {
    var elem = getElementById('producer-status');
    updateConnectionStatus(elem, connected);
}

function updateConsumerStatus(connected) {
    var elem = getElementById('consumer-status');
    updateConnectionStatus(elem, connected);
}

function updateConnectionStatusById(connected, id) {
    var elem = getElementById(id);
    updateConnectionStatus(elem, connected);
}

function updateConnectionStatus(elem, connected) {
    if (connected) {
        elem.innerHTML = "Connected to MQ Server";
    }
    else {
        elem.innerHTML = "Disconnected";
    }
}

function updateMessageFromPublisher(message) {
    var elem = getElementById('message-received');
    elem.innerHTML = message;
}

function publish() {
    var message = getElementById('message-to-send').innerHTML;
    var type = getElementById('message-type-producer').value;
    producer.produce(type, message);
}

function onConnect(entity, id) {
    updateConnectionStatusById(true, id);

    entity.on('disconnect', () => {
        updateConnectionStatusById(false, id);
    });
}

function connect(entity, id) {
    if (entity) {
        entity.disconnect();
        entity.connect(() => {
                    onConnect(entity, id);
                },
            mq.port,
            mq.host);
    }
}

function updateMQServer() {
    mq.host = document.getElementById('server').value;

    if (producer) {
        connect(producer);
    }
    else {
        var publishType = getElementById('message-type-producer');
        mq.createProducer(publishType, (p) => {
            producer = p;

            onConnect(producer, 'producer-status');
        });
    }
    if (consumer) {
        connect(consumer);

        updateSubscription();
    }
    else {
        var subscribeType = getElementById('message-type-consumer').value;
        mq.createConsumer(subscribeType, (c) => {
            consumer = c;

            onConnect(consumer, 'consumer-status');
        });
    }

}

function updateSubscription() {
    var subscribeType = getElementById('message-type-consumer').value;
    if (consumer) {
        consumer.subscribe(subscribeType, (message) => {
            updateMessageFromPublisher(message);
        });
    }
}

mq.createConsumer(function (c) {
        consumer = c;
        console.log('Subscriber: ' + consumer.getId());
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

            //if (test === 2) disconnectConsumer();
        });

        consumer.subscribe('test2', (data) => {
            test += 1;
            if (data === 'test-b') 
                console.log('test2 succeeded!');
            else   
                console.log('test2 failed');

            //if (test === 2) disconnectConsumer();
        });
    }
);
