# tyo-mq

TYO-MQ is a distributed messaging (pub/sub) service with socket.io. 

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
.then(function (p) {
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
.then(function (c) {
    consumer = c;
    consumer.on('connect', function ()  {
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

## Browserify
This package supports being browserified.
In order to browserify, please install two more extra packages:
```
nmp install utf-8-validate bufferutil
```

Afterward,
```
browserify web/web.js -o web/client/tyo-mq-client.js
```

## TODO list
* implement the message queuing
* message queuing if intended subscriber is down, resend message when it is up
* message delivery for one or some intended subscribers only

## Maintainer

[Eric Tang](https://twitter.com/_e_tang) @ [TYO LAB](http://tyo.com.au)