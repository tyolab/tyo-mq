# tyo-mq

TYO-MQ is a distributed messaging service with socket.io. 

At the moment the message queuing is not implemented yet, which means all messages are sent instantly without confirmation of message delivery or recieving. So message subcriber(s) will need to be online in order to recieve the message.

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

## TODO list
* message queuing if intended subscriber is down, resend message when it is up
* message delivery for one or some intended subscribers only

## Maintainer

[Eric Tang](https://twitter.com/_e_tang) @ [TYO LAB](http://tyo.com.au)