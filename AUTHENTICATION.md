# Authentication

Authentication is optional. Existing deployments keep working when
`auth.enabled` is false.

## Enable Auth

The default `server.js` loads `.env` before starting.

```bash
printf 'TYO_MQ_AUTH_ENABLED=true\n' > .env
npm start
```

When auth is enabled and no admin token exists, the server generates one and
appends it to `.env`:

```env
TYO_MQ_ADMIN_TOKEN="..."
```

`.env` is ignored by git.

## Token Auth

Configure static opaque tokens with `realm` and `role`:

```javascript
var Server = require('tyo-mq').Server;

var server = new Server({
    auth: {
        enabled: true,
        tokens: [
            { token: 'secret-prod', realm: 'tyolab', role: 'producer' },
            { token: 'secret-cons', realm: 'tyolab', role: 'consumer' },
            { token: 'secret-admin', realm: '*', role: 'admin' }
        ]
    }
});
server.start();
```

Client:

```javascript
var Factory = require('tyo-mq').Factory;

var mq = new Factory({
    auth: { token: 'secret-prod' }
});

var producer = await mq.createProducer('my-producer');
```

## Roles

- `producer`: can register producers and publish messages.
- `consumer`: can register consumers and subscribe/unsubscribe.
- `both`: can act as producer and consumer.
- `admin`: can do everything, and is intended for management flows.

## Realms

A realm is an isolation boundary. Producers, consumers, and subscriptions in
one realm are invisible to other realms.

`realm: "*"` is the superadmin realm. It can monitor across realms and should
only be used for management.

## JWT Auth

If `auth.jwt_secret` is set, the server accepts HS256 JWTs with `realm` and
`role` claims:

```javascript
var server = new Server({
    auth: {
        enabled: true,
        jwt_secret: process.env.TYO_MQ_JWT_SECRET
    }
});
```

Required payload:

```json
{
  "realm": "tyolab",
  "role": "consumer",
  "exp": 1760000000
}
```

## External Auth

If `auth.auth_url` is set, the server posts the presented token to that URL:

```json
{ "token": "..." }
```

The endpoint should return:

```json
{ "realm": "tyolab", "role": "consumer" }
```

Non-2xx responses, `{ "valid": false }`, `{ "ok": false }`, or missing
`realm`/`role` reject the token.

## Protocol Events

Client authentication:

```text
client -> server: AUTHENTICATION { token }
server -> client: AUTH_OK { realm, role }
server -> client: AUTH_FAIL { code, message }
```

Unauthenticated sockets may connect and may submit authorization requests.
Protected producer/consumer actions require `AUTH_OK` unless the target realm is
configured as open.

## Admin Token Without Sending It

Managers should not send `TYO_MQ_ADMIN_TOKEN` directly for approval actions.
Instead, the manager signs each action locally with HMAC-SHA256:

```text
signature = HMAC_SHA256(admin_token, action + "\n" + timestamp + "\n" + nonce + "\n" + stable_json(body))
```

The manager sends:

```json
{
  "body": { "...": "..." },
  "proof": {
    "timestamp": 1760000000000,
    "nonce": "random",
    "signature": "hex-hmac"
  }
}
```

The server verifies the signature against its configured admin token, rejects
expired proofs, and rejects reused nonces.

## Authorization Request Flow

This flow lets a client request access without already having a valid token.
Requests are stored in memory for the current server process.

### 1. Client submits a request

Script:

```bash
npm run auth:request -- \
  --realm tyolab \
  --role consumer \
  --client-id tyolab-agent-01 \
  --client-name "Tyolab Agent 01"
```

Library:

```javascript
var Authorization = require('tyo-mq').Authorization;

var submitted = await Authorization.submitAuthorizationRequest({
    realm: 'tyolab',
    role: 'consumer',
    client_id: 'tyolab-agent-01',
    client_name: 'Tyolab Agent 01',
    client_token: 'client-secret',
    challenge_response: { ticket: 'INC-123' }
});
```

Server event:

```text
client -> server:
AUTHORIZATION_REQUEST {
  realm,
  role,
  client_id,
  client_name,
  client_token,
  challenge_response
}

server -> client:
AUTHORIZATION_REQUEST_OK { ok, request_id, status }
```

The server stores the raw `client_token` internally, but manager responses only
expose `client_token_hash`.

### 2. Manager retrieves the next request

Script:

```bash
npm run auth:manager -- next
npm run auth:manager -- next --realm tyolab
```

Library:

```javascript
var next = await Authorization.nextAuthorizationRequest(
    process.env.TYO_MQ_ADMIN_TOKEN,
    { realm: 'tyolab' }
);
```

Server event:

```text
manager -> server:
AUTHORIZATION_NEXT { body, proof }

server -> manager:
{ ok: true, request }
```

### 3. Manager approves or rejects

Approve:

```bash
npm run auth:manager -- approve <request_id> --role consumer
```

Reject:

```bash
npm run auth:manager -- reject <request_id> --reason "unknown client"
```

Library:

```javascript
await Authorization.decideAuthorizationRequest(
    process.env.TYO_MQ_ADMIN_TOKEN,
    {
        request_id: next.request.request_id,
        approved: true,
        role: 'consumer'
    }
);
```

Server event:

```text
manager -> server:
AUTHORIZATION_DECIDE {
  body: { request_id, approved, role, reason },
  proof
}
```

When approved, the requested client token is added to the server's in-memory
token list:

```javascript
{ token: client_token, realm, role }
```

The client can then authenticate with normal `AUTHENTICATION { token }`.

## Useful Commands

Open the interactive manager:

```bash
npm run manager
```

The manager sends signed commands to the running server. It can add/rename
realms, enable or disable auth globally or per realm, verify the admin token,
and approve or reject pending authorization requests. The admin token is used
locally to sign commands and is never sent directly.

If the server is started with `TYO_MQ_SETTINGS_FILE`, management changes are
persisted to that file. In Docker, mount that file or its parent directory as a
volume.

Docker example:

```bash
export TYO_MQ_ADMIN_TOKEN="$(openssl rand -hex 32)"
docker compose up -d tyo-mq
docker compose run --rm manager
```

Verify the generated admin token can authenticate:

```bash
npm run auth:admin
```

Submit a request:

```bash
npm run auth:request -- --realm tyolab --role consumer
```

Approve a request:

```bash
npm run auth:manager -- approve <request_id> --role consumer
```

## Current Limitations

- Authorization requests are in-memory only.
- Approved request tokens are in-memory only unless also persisted externally.
- Manager nonce replay protection is in-memory only.
- This phase does not include a REST management API.
