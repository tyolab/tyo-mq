# tyo-mq
[![NPM module](https://badge.fury.io/js/tyo-mq.png)](https://badge.fury.io/js/tyo-mq)

TYO-MQ is a distributed messaging (pub/sub) service with socket.io. 

[![NPM](https://nodei.co/npm/tyo-mq.png?stars&downloads)](https://nodei.co/npm/tyo-mq/)

TYO-MQ supports fire-and-forget pub/sub by default, plus opt-in durable delivery with ACK, retry, and dead-letter handling for messages that must survive disconnects or failed consumers.

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

## Durable Delivery and ACK

Durable subscriptions store matching messages while the consumer is offline. ACK
is not required by default: `durable: true` alone keeps the Phase 2 behavior,
where replayed durable messages are removed immediately after delivery. When a
subscription explicitly asks for ACK with `ack`, `require_ack`, or `manual_ack`,
the server includes a `msgId`, waits for `ACK {msgId}`, retries on timeout, and
moves exhausted messages to the realm DLQ.

```javascript
consumer.subscribe(producer.name, 'task', function (data) {
    // auto-ACK after the handler resolves
}, {
    durable: true,
    ack: true,
    retry: { max_attempts: 3, delay: '5s', backoff: 'exponential' }
});

consumer.subscribe(producer.name, 'task', function (data, from, ack, raw) {
    doWork(data).then(function () {
        ack();
    });
}, {
    durable: true,
    manual_ack: true,
    ack_timeout: '30s',
    retry: { max_attempts: 5, delay: '2s' }
});
```

The storage backends expose `deadLetter(msgId, reason)`, `listDlq(realm)`, and
`discardDlq(msgId)` for management tooling. The in-memory backend keeps DLQ
entries until process exit; SQLite and Redis keep them in their configured
stores.

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

Managers do not need to send shared secrets to approve new client tokens. A
client can submit a pending authorization request:

```bash
npm run auth:request -- \
  --realm tyolab \
  --role consumer \
  --client-id tyolab-agent-01 \
  --client-name "Tyolab Agent 01"
```

The command prints a generated `client_token` and `request_id`. A server admin
can retrieve pending requests and approve or reject them with a signed proof
derived from `TYO_MQ_ADMIN_TOKEN`:

```bash
npm run auth:manager -- next
npm run auth:manager -- approve <request_id> --role consumer
npm run auth:manager -- reject <request_id> --reason "unknown client"
```

An org or realm operator can use a scoped realm manager key instead:

```json
{
  "auth": {
    "realms": {
      "tyolab": {
        "required": true,
        "manager_key": "realm-manager-shared-secret"
      }
    }
  }
}
```

```bash
TYO_MQ_REALM_MANAGER_KEY="realm-manager-shared-secret" \
  npm run auth:manager -- next --realm tyolab

TYO_MQ_REALM_MANAGER_KEY="realm-manager-shared-secret" \
  npm run auth:manager -- approve <request_id> --role consumer
```

The manager proof is an HMAC-SHA256 signature over the action, body, timestamp,
and nonce. The admin token or realm manager key stays local to the manager
script. A realm manager key can only poll and decide authorization requests in
its configured realm; server-wide management commands still require the global
admin token. Approved client tokens are added to the server's auth token list.
When `TYO_MQ_SETTINGS_FILE` is configured, approved tokens are persisted to that
file and survive restarts; otherwise they are runtime-only.

Approved client tokens can be revoked through the interactive manager or the
signed management command `revoke_token`. Revocation can identify a token by
`token_hash`, or by `realm` plus `client_id`.

The same flow is available as library calls:

```javascript
var Authorization = require('tyo-mq').Authorization;

await Authorization.submitAuthorizationRequest({
    realm: 'tyolab',
    role: 'consumer',
    client_id: 'tyolab-agent-01',
    client_name: 'Tyolab Agent 01',
    client_token: 'client-secret',
    challenge_response: { ticket: 'INC-123' }
});

var next = await Authorization.nextAuthorizationRequest(process.env.TYO_MQ_ADMIN_TOKEN);
await Authorization.decideAuthorizationRequest(process.env.TYO_MQ_ADMIN_TOKEN, {
    request_id: next.request.request_id,
    approved: true,
    role: 'consumer'
});

var realmNext = await Authorization.nextRealmAuthorizationRequest(
    process.env.TYO_MQ_REALM_MANAGER_KEY,
    'tyolab'
);
await Authorization.decideRealmAuthorizationRequest(process.env.TYO_MQ_REALM_MANAGER_KEY, {
    request_id: realmNext.request.request_id,
    approved: true,
    role: 'consumer'
});
```

For interactive auth and realm management:

```bash
npm run manager
```

With Docker Compose, provide the admin token from the host and persist server
settings through the bundled volume:

```bash
export TYO_MQ_ADMIN_TOKEN="$(openssl rand -hex 32)"
docker compose up -d tyo-mq
docker compose run --rm manager
```

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
