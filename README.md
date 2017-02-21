# tyo-mq

A distributed messaging server.

At the moment, the message queuing is not implemented yet.

## Installation
    npm install tyo-mq

## Creating a messaging server

```javascript
var MessageServer = require("tyo-mq");

var mq = new MessageServer();
mq.start();
```

## Creating a message producer

```javascript
var MessageQueue = require('tyo-mq'),
    producer;

mq.createProducer('testevent')
.then((p) => {
    producer = p;

    // produce a default event with data {data: 'test'}
    producer.produce('test text from default event');

    // produce a different kind of event
    producer.produce('event2', {data: 'test text from event2'})
});
```

## Creating a message subscriber

```javascript
var MessageQueue = require('tyo-mq'),
    consumer;

mq.createConsumer()
.then((c) => {
    consumer = c;
    consumer.on('connect', () => {
        console.log('consumer\'s own connect listenr');
    });

    // subscribe 'event2'
    consumer.subscribe('event2', (data) => {
        console.log(data);
    });

    // subscribe 'testevent'
    consumer.subscribe('testevent', (data) => {
        console.log(data);
    });
});
```