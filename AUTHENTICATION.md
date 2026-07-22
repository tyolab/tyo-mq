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

If `auth.auth_url` is set, tokens that no local credential recognizes (per-realm
JWT, global `jwt_secret`, static `auth.tokens`) are posted to that URL as a
fallback. Local credentials are always checked first, so enabling an external
validator never breaks already-configured tokens.

```json
{ "token": "...", "realm": "tyolab" }
```

`realm` is the realm the client declared in its `AUTHENTICATION` message, when
present. If `auth.auth_secret` is set, the request carries it in an
`X-MQ-Auth-Secret` header so the validator can refuse token-probing from anyone
other than this server.

The endpoint should return:

```json
{ "realm": "tyolab", "role": "consumer" }
```

Non-2xx responses, `{ "valid": false }`, `{ "ok": false }`, or missing
`realm`/`role` reject the token.

### Realm- and Prefix-Scoped Validators

External validators can be scoped instead of global — the right choice when
each organization runs its own auth server. Resolution order for a token
nothing local recognizes, based on the realm the client declared (or the
token's JWT `realm` claim):

1. **Realm scope** — `auth.realms[<realm>].auth_url` (+ optional
   `auth_secret`)
2. **Prefix scope** — `auth.external_validators`, longest matching
   `realm_prefix` wins:

   ```json
   {
     "auth": {
       "external_validators": [
         { "realm_prefix": "apps:tyoman:", "auth_url": "https://tyoman.tyo.com.au/api/v1/mq-auth", "auth_secret": "..." }
       ]
     }
   }
   ```
3. **Global** — `auth.auth_url`, as before.

Scoped validators are an isolation boundary, not just routing: a validator
bound to a realm (or prefix) can only authorize tokens **into** that realm
(or realms under that prefix) — a response naming any other realm is
discarded. The global validator keeps its original unrestricted behavior.
Clients must declare their realm (or use JWTs carrying a `realm` claim) for
scoped validators to be selected.

Configure with `set_external_auth` plus a scope (see Useful Commands), or in
the web manager's External Auth panel via the Scope field (blank = global,
`org:acme` = that realm, `apps:tyoman:` = prefix).

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

## Signed Manager Proofs

Managers should not send shared secrets directly for approval actions. Instead,
the manager signs each action locally with HMAC-SHA256:

```text
signature = HMAC_SHA256(manager_secret, action + "\n" + timestamp + "\n" + nonce + "\n" + stable_json(body))
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

The server rejects expired proofs and reused nonces.

Two secret scopes are supported:

- Global admin token: configured as `auth.tokens[]` with `realm: "*"` and
  `role: "admin"`. This can sign all management operations.
- Realm manager key: configured on one realm as `auth.realms[realm].manager_key`.
  This can sign only `AUTHORIZATION_NEXT` and `AUTHORIZATION_DECIDE` for that
  realm.

Realm manager keys are intentionally narrower than the global admin token. They
let an org operator approve or reject client enrollment requests without
receiving server-wide admin power.

Example realm manager key config:

```json
{
  "auth": {
    "enabled": true,
    "realms": {
      "realm:prefix:myorg": {
        "required": true,
        "manager_key": "realm-manager-shared-secret"
      }
    }
  }
}
```

The server never returns raw `manager_key` values in management responses. A
configured key is reported as `manager_key_configured: true`.

Realm manager scope rules:

- `AUTHORIZATION_NEXT` signed with a realm manager key must include
  `body.realm`, and it can only read pending requests for that realm.
- `AUTHORIZATION_DECIDE` signed with a realm manager key is checked against the
  stored realm of the pending request, not against a caller-supplied realm.
- `AUTH_MANAGEMENT_COMMAND` always requires the global admin token.

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
    process.env.TYO_MQ_REALM_MANAGER_KEY,
    { realm: 'tyolab' }
);

// Equivalent clearer helper:
var next = await Authorization.nextRealmAuthorizationRequest(
    process.env.TYO_MQ_REALM_MANAGER_KEY,
    'tyolab'
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
    process.env.TYO_MQ_REALM_MANAGER_KEY,
    {
        request_id: next.request.request_id,
        approved: true,
        role: 'consumer'
    }
);

// Equivalent clearer helper:
await Authorization.decideRealmAuthorizationRequest(
    process.env.TYO_MQ_REALM_MANAGER_KEY,
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

When approved, the requested client token is added to the server's token list:

```javascript
{ token: client_token, realm, role }
```

The client can then authenticate with normal `AUTHENTICATION { token }`.
If the server is started with `TYO_MQ_SETTINGS_FILE`, the approved token is
also written to that settings file so it survives server/container restarts.

## Useful Commands

Open the interactive server manager:

```bash
npm run manager
```

The manager sends signed commands to the running server. It can add/rename
realms, enable or disable auth globally or per realm, verify the admin token,
and approve or reject pending authorization requests. The admin token is used
locally to sign commands and is never sent directly.

Create a realm in either of its two forms — permanent (default) or ephemeral
(disposable, auto-removed with its tokens, sockets, and stored messages once
the `ttl` lapses):

```json
{ "command": "add_realm", "realm": "org:acme" }
{ "command": "add_realm", "realm": "ci:run-4821", "ephemeral": true, "ttl": "2h" }
```

Convert an existing realm between the forms (see REALM.md, and
EPHEMERAL-REALMS.md for the full provisioning guide):

```json
{ "command": "set_realm_lifetime", "realm": "ci:run-4821", "ephemeral": false }
```

Set or rotate a realm manager key with a global admin signed management command:

```json
{
  "command": "set_realm_manager_key",
  "realm": "tyolab",
  "manager_key": "new-realm-manager-secret"
}
```

Use `manager_key: null` or omit `manager_key` to remove the key.

Configure external token validation (see "External Auth" above) with:

```json
{
  "command": "set_external_auth",
  "auth_url": "https://tyoman.tyo.com.au/api/v1/mq-auth",
  "auth_secret": "shared-callback-secret"
}
```

Omitting `auth_secret` keeps the current one (it is never echoed back — `get`
shows `"<configured>"`); an empty `auth_url` disables external validation. The
browser manager exposes this as the "External Auth" panel on the Main tab.

Scope the validator to one realm or a realm prefix by adding `realm` or
`realm_prefix` (see "Realm- and Prefix-Scoped Validators" above):

```json
{ "command": "set_external_auth", "realm": "org:acme", "auth_url": "https://auth.acme.example/mq-auth", "auth_secret": "..." }
{ "command": "set_external_auth", "realm_prefix": "apps:tyoman:", "auth_url": "https://tyoman.tyo.com.au/api/v1/mq-auth" }
{ "command": "set_external_auth", "realm_prefix": "apps:tyoman:", "auth_url": "" }
```

The last form removes the scoped validator (an empty `auth_url` with a scope
clears just that scope, leaving the global validator untouched).

Manage HTTP-management-API bearer tokens (`auth.management_tokens`) with:

```json
{ "command": "add_management_token", "token": "<random hex>", "realm_prefix": "apps:tyoman:" }
{ "command": "add_management_token", "token": "<random hex>", "realm_prefix": "trymq:", "ephemeral_only": true, "max_ttl": "7d" }
{ "command": "revoke_management_token", "token_hash": "<sha256 from get>" }
```

A token marked `ephemeral_only` can never mint a permanent realm through
`POST /api/realms` — every realm it creates is ephemeral regardless of the
request body, with the requested TTL capped at `max_ttl`. This is the
guarantee for public playground deployments where provisioned realms must
always clean themselves up.

`get` never returns raw management tokens — only `{realm_prefix, token_hash}` —
so revocation is by hash. The browser manager's "Management API Tokens" panel
generates tokens client-side, shows them once for copying, and lists/revokes
by prefix + hash.

If the server is started with `TYO_MQ_SETTINGS_FILE`, management changes are
persisted to that file. In Docker, mount that file or its parent directory as a
volume.

## SQLite Auth Store

By default, realms and tokens are persisted by rewriting the whole settings
JSON file on every change. That is fine while the data is small, but once
realms and tokens grow (especially with programmatically created ephemeral
realms), switch to the SQLite auth store:

```json
{
  "auth_store": { "filename": "tyo-mq.auth.sqlite" }
}
```

or start the server with `--auth-store [/path/to/auth.sqlite]`, or with
`TYO_MQ_AUTH_STORE=true` (default filename) or
`TYO_MQ_AUTH_STORE=/path/to/auth.sqlite`. Requires Node 22+ (`node:sqlite`).
The store is strictly **opt-in** — without one of these, realms and tokens
keep being persisted to the settings JSON file exactly as before.

What changes when the store is enabled:

- Realms, tokens, and management tokens are persisted **row-level in SQLite
  (WAL mode)** — every change is a small transaction instead of a full-file
  rewrite, and a crash mid-write can never truncate or corrupt the data.
- The settings JSON file keeps only static config (ports, storage, auth
  flags) and stops carrying the growing sections.
- **Migration is automatic**: on first boot with the store enabled, realms
  and tokens found in the settings file or constructor options are imported
  into the database. Entries hand-added to the settings file later are still
  imported on reload — the file acts as a one-way inbox.
- Removals are durable: a removed or expired-ephemeral realm deleted from
  the store stays gone across restarts.

Back it up while running with a consistent online snapshot:

```js
server.backupAuthStore('/backups/tyo-mq-auth-' + date + '.sqlite');
```

or from cron: `sqlite3 tyo-mq.auth.sqlite "VACUUM INTO 'backup.sqlite'"`.

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

Approve a request with a realm manager key:

```bash
TYO_MQ_REALM_MANAGER_KEY="realm-manager-shared-secret" \
  npm run auth:manager -- next --realm tyolab

TYO_MQ_REALM_MANAGER_KEY="realm-manager-shared-secret" \
  npm run auth:manager -- approve <request_id> --role consumer
```

Approve a request with the global admin token:

```bash
npm run auth:manager -- approve <request_id> --role consumer
```

Revoke an approved client token with the interactive manager:

```bash
npm run manager
# choose "Revoke authorized client token"
```

The signed management command is:

```json
{
  "command": "revoke_token",
  "realm": "tyolab",
  "client_id": "client-01"
}
```

You can also revoke by `token_hash`, which is available in manager settings
responses. Raw token values are not shown by the manager UI.

## Current Limitations

- Authorization requests are in-memory only.
- Approved request tokens are persisted only when the server has a settings file
  configured with `TYO_MQ_SETTINGS_FILE`; otherwise they are runtime-only.
- Revoked tokens are removed from the settings file when `TYO_MQ_SETTINGS_FILE`
  is configured.
- Manager nonce replay protection is in-memory only.
- This phase does not include a REST management API.
