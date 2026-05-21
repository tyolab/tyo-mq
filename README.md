# tyo-mq
[![NPM module](https://badge.fury.io/js/tyo-mq.png)](https://badge.fury.io/js/tyo-mq)

TYO-MQ is a distributed messaging (pub/sub) service with socket.io. 

[![NPM](https://nodei.co/npm/tyo-mq.png?stars&downloads)](https://nodei.co/npm/tyo-mq/)

At the moment the message queuing is not implemented yet, which means all messages are sent instantly without confirmation of message delivery or recieving. So message subcriber(s) will need to be online in order to recieve the message.

## Installation
    npm install tyo-mq

## Creating a messaging server

```javascript
var MessageServer = require("tyo-mq").Server;

var mq = new MessageServer();
mq.start();
```

## Creating a message producer

```javascript
var Factory = require('tyo-mq').Factory,
    producer;

var mq = new Factory();  

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
var Factory = require('tyo-mq').Factory,
    consumer;

var mq = new Factory();    

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

## Demo

### Start the TYO-MQ server

```javascript
# Needs to set up the library (module) path
export NODE_PATH=`npm config get prefix`/lib/node_modules/
node -e 'require("tyo-mq/server")'
```

### Customize Server Configuration

You can customize the server configuration including CORS settings by creating your own server file:

```javascript
var Server = require('tyo-mq').Server;

var server = new Server({
    serveClient: false,
    pingInterval: 5000,
    pingTimeout: 10000,
    allowEIO3: true,
    // CORS configuration
    cors: {
        origin: "*",  // Allow all origins, or specify ["http://localhost:3000", "https://yourdomain.com"]
        methods: ["GET", "POST"],
        credentials: true
    },
    // WebSocket compression settings
    perMessageDeflate: {
        threshold: 2048,
        zlibDeflateOptions: {
            chunkSize: 8 * 1024,
        },
        zlibInflateOptions: {
            windowBits: 14,
            memLevel: 7,
        },
        clientNoContextTakeover: true,
        serverNoContextTakeover: true,
        serverMaxWindowBits: 10,
        concurrencyLimit: 20,
    },
});

server.start(8080); // Specify custom port
```

### Authentication and Realms

Authentication is disabled by default for backwards compatibility. When enabled,
clients must send `AUTHENTICATION` before registering as a producer or consumer.
The built-in clients can do this automatically with a configured token:

```javascript
var Server = require('tyo-mq').Server;
var Factory = require('tyo-mq').Factory;

var server = new Server({
    auth: {
        enabled: true,
        tokens: [
            { token: 'secret-acme-prod', realm: 'acme', role: 'producer' },
            { token: 'secret-acme-cons', realm: 'acme', role: 'consumer' }
        ]
    }
});
server.start();

var producerMq = new Factory({ auth: { token: 'secret-acme-prod' } });
var consumerMq = new Factory({ auth: { token: 'secret-acme-cons' } });
```

Supported roles are `producer`, `consumer`, `both`, and `admin`. Producers,
consumers, and subscriptions are scoped to the authenticated `realm`, so the
same producer or consumer names can exist independently in different realms.
In addition to configured opaque tokens, the server can validate HS256 JWTs
with `auth.jwt_secret` or delegate validation to an HTTP endpoint with
`auth.auth_url`.

When auth is enabled and no `realm: "*", role: "admin"` token is configured,
the server creates one automatically and appends it to `.env` as
`TYO_MQ_ADMIN_TOKEN`. The default `server.js` loads `.env`, so you can enable
auth and let the first server start create the admin token:

```bash
printf 'TYO_MQ_AUTH_ENABLED=true\n' > .env
npm start
```

In another shell, verify the generated token can authenticate:

```bash
npm run auth:admin
```

The helper reads `TYO_MQ_ADMIN_TOKEN` from `.env` and sends `AUTHENTICATION` to
the running server.

**CORS Options:**
- `origin: "*"` - Allow all origins (development/testing)
- `origin: ["http://localhost:3000"]` - Allow specific origins (production)
- `methods` - Allowed HTTP methods
- `credentials: true` - Allow credentials in requests

### Test Script
```javascript
export NODE_PATH=`npm config get prefix`/lib/node_modules/
node -e 'require("tyo-mq/test")'
```

## Browserify
This package supports being browserified.
In order to browserify, please install two more extra packages:
```
npm install utf-8-validate bufferutil
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
