# Realms and Organizations

`tyo-mq` uses realms as the low-level routing and authorization boundary.
Organizations should be modeled as the higher-level business concept that maps
to realms.

## Core Model

Use one realm per organization by default:

```text
org acme   -> realm org:acme
org tyolab -> realm org:tyolab
```

A realm is a hard isolation boundary. Producers and consumers authenticated into
one realm do not see producers, consumers, subscriptions, or messages from
another realm.

An organization is the manager-facing concept. Normal operators should think in
terms of orgs, while the server enforces access through the mapped realm.

## Ephemeral and Permanent Realms

A realm is created in one of two forms:

- **Permanent** (the default) — lives until an explicit `remove_realm`. Use
  this for organizations and long-lived integrations.
- **Ephemeral (disposable)** — tagged with an expiry at creation and disposed
  of automatically when it lapses. Use this for test runs, demos, short-lived
  jobs, or per-session isolation, so they never accumulate in the settings
  file.

Create an ephemeral realm with the `add_realm` management command:

```json
{
  "command": "add_realm",
  "realm": "ci:run-4821",
  "ephemeral": true,
  "ttl": "2h"
}
```

`ttl` accepts `"250ms"`, `"90s"`, `"15m"`, `"2h"`, `"7d"`, or a bare number of
seconds; passing a `ttl` alone implies `ephemeral: true` (the aliases
`temporary` and `disposable` are also accepted). Without a `ttl` the default
lifetime is 1 day (configurable via `auth.ephemeral_realm_ttl`). The realm
config carries `ephemeral: true` and an `expires_at` timestamp, so the expiry
survives server restarts.

Disposal is complete: when the expiry lapses (checked once a minute and at
startup) the server removes the realm config, drops every token scoped to the
realm, deletes its runtime producers/consumers/subscriptions, disconnects its
connected sockets, and purges its durable messages and dead-letter entries
from storage. An explicit `remove_realm` performs the same full disposal for
either form.

Convert between the forms with `set_realm_lifetime`:

```json
{ "command": "set_realm_lifetime", "realm": "ci:run-4821", "ephemeral": false }
{ "command": "set_realm_lifetime", "realm": "org:acme", "ephemeral": true, "ttl": "7d" }
```

Making a realm permanent clears its expiry; re-issuing a `ttl` on an ephemeral
realm extends it. The structural `default` and `*` realms are always
permanent.

The HTTP realm-provisioning endpoint accepts the same options:

```bash
curl -X POST http://localhost:17352/api/realms \
  -H "Authorization: Bearer $MANAGEMENT_TOKEN" \
  -d '{"realm": "apps:tyoman:test-1", "manager_key": "...", "ephemeral": true, "ttl": "30m"}'
```

The response includes `ephemeral` and `expires_at`.

## Naming Convention

Use this realm naming pattern:

```text
org:<org_id>
```

Examples:

```text
org:acme
org:tyolab
org:client-x
```

Use lowercase, stable IDs for `org_id`. Prefer letters, numbers, and hyphens.
Avoid using display names directly as IDs because organization names may change.

## Settings Shape

The current server enforces realms through `auth.realms` and `auth.tokens`.
The recommended organization layer can be represented like this:

```json
{
  "auth": {
    "orgs": {
      "acme": {
        "name": "Acme Pty Ltd",
        "realm": "org:acme",
        "enabled": true
      }
    },
    "realms": {
      "org:acme": {
        "required": true,
        "manager_key": "acme-realm-manager-secret"
      }
    },
    "tokens": [
      {
        "token": "client-token",
        "realm": "org:acme",
        "role": "consumer",
        "org_id": "acme",
        "client_id": "worker-01",
        "client_name": "Acme Worker 01"
      }
    ]
  }
}
```

`auth.orgs` is the friendly management layer. `auth.realms` and `auth.tokens`
remain the enforcement layer. A realm `manager_key` lets an org operator approve
or reject authorization requests for that realm without receiving the global
`realm: "*"` admin token.

## Authorization Requests

Client authorization requests should eventually use `org_id` instead of asking
clients to know the raw realm name:

```json
{
  "org_id": "acme",
  "client_id": "worker-01",
  "client_name": "Acme Worker 01",
  "client_token": "requested-client-token",
  "role": "consumer",
  "challenge_response": {
    "ticket": "helpdesk-123"
  }
}
```

The server or manager resolves:

```text
org_id=acme -> realm=org:acme
```

When approved, the token is stored against the resolved realm.

## Manager UX

Managers should operate on organizations:

- create org
- rename org display name
- enable or disable org auth
- rotate org enrollment manager key
- list org clients
- approve or reject client authorization requests for an org

Raw realm operations should remain available for admin/debug workflows, but
they should not be the normal user-facing interface.

Org operators should receive only the manager key for their org's realm. That
key can sign `AUTHORIZATION_NEXT` and `AUTHORIZATION_DECIDE` for the mapped
realm, but it cannot create realms, change server settings, revoke tokens, or
approve requests in other realms.

## Multiple Realms Per Organization

Start with one org mapped to one realm. If an organization later needs multiple
isolated areas, use org-scoped realm names:

```text
org:acme:prod
org:acme:dev
org:acme:billing
```

This should be added only when there is a real isolation requirement. The simple
default is:

```text
one organization = one realm
```

## Inter-Realm Communication

Realms are isolated by default. A normal socket authenticates into one realm,
and it cannot directly publish into or subscribe from another realm. This is a
security boundary, not just a naming convention.

Use one of these patterns when two realms need to exchange messages.

### Bridge Client

The recommended current solution is a bridge service with two authenticated
connections:

- a consumer token for the source realm
- a producer token for the target realm

Example:

```js
const Factory = require('tyo-mq').Factory;

const source = new Factory({
  host: 'mq.tyo.com.au',
  port: 443,
  protocol: 'https',
  auth: {token: process.env.SOURCE_REALM_CONSUMER_TOKEN}
});

const target = new Factory({
  host: 'mq.tyo.com.au',
  port: 443,
  protocol: 'https',
  auth: {token: process.env.TARGET_REALM_PRODUCER_TOKEN}
});

async function main() {
  const consumer = await source.createConsumer('realm-bridge-a-to-b');
  const producer = await target.createProducer('realm-bridge-a-to-b');

  consumer.subscribe('source-producer', 'event-name', (data, from) => {
    producer.produce('event-name', {
      source_realm: 'org:source',
      source_producer: from,
      payload: data
    }, {guaranteed: true});
  }, {durable: true});
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
```

This keeps authorization explicit. The bridge can only read from realms and
write to realms for which it has tokens. It is also easy to audit because each
bridge should have a clear source realm, target realm, and event mapping.

Use durable subscriptions and guaranteed produce options for important
cross-realm messages:

```js
consumer.subscribe('producer', 'event', handler, {durable: true});
producer.produce('event', data, {guaranteed: true});
```

This gives offline replay under the current persistence model. End-to-end
delivery acknowledgement, retry, and dead-letter handling belong to the
reliability phase.

### Shared Integration Realm

For many-to-many integrations, create a dedicated integration realm:

```text
integration:tyoman
integration:billing
integration:fleet
```

Applications publish integration events into that realm, and approved clients
consume only the events they are allowed to see. This avoids granting direct
realm-to-realm access and keeps integration traffic separate from internal
organization traffic.

Use this pattern when several org realms need a common exchange point, for
example:

```text
org:acme           -> integration:tyoman
org:beta           -> integration:tyoman
integration:tyoman -> org:tyolab:ops
```

### Server-Managed Routes

A future server-native route feature can make bridge behavior declarative:

```json
{
  "from_realm": "org:acme",
  "to_realm": "org:tyolab:ops",
  "producer": "orders",
  "event": "created",
  "target_event": "acme.orders.created",
  "durable": true
}
```

This should be admin-managed, audited, and default-deny. Clients should not get
a free-form `target_realm` publish option because that weakens the isolation
model.

Do not use `realm: "*"` as an integration bus. The `*` realm is for
super-admin management and monitoring only.

## Super Admin

Admin tokens use the special realm:

```text
*
```

An admin in realm `*` can manage realms, organizations, and authorization
requests. Normal clients should never use the `*` realm.
