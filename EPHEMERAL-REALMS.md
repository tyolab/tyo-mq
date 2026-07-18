# Ephemeral Realms — Implementation Guide

This is a self-contained guide for services, tools, and coding agents that
need to provision an **ephemeral realm** on a tyo-mq server: an isolated
pub/sub namespace that cleans itself up. Background on realms in general is
in [REALM.md](REALM.md); authentication details are in
[AUTHENTICATION.md](AUTHENTICATION.md).

## The Two Realm Forms

| | Permanent (default) | Ephemeral (disposable) |
|---|---|---|
| Created by | `add_realm` / `POST /api/realms` | same, plus `ephemeral: true` and an optional `ttl` |
| Lives until | explicit `remove_realm` | its `expires_at` lapses (or explicit removal) |
| Survives server restart | yes | yes, up to its expiry — the expiry itself is persisted |
| Use for | organizations, long-lived integrations | CI runs, test suites, demos, per-session or per-job isolation |

When an ephemeral realm expires, disposal is **complete**: realm config,
every token scoped to the realm, runtime producers/consumers/subscriptions,
connected sockets (force-disconnected), and all durable messages and
dead-letter entries in storage. Expiries are checked once a minute and at
server startup, so a realm disappears at most ~60 seconds after its
`expires_at`.

> Rule of thumb: if your workload creates realms programmatically and would
> otherwise need cleanup code, create them ephemeral.

## TTL Format

`ttl` accepts a duration string or a bare number of seconds:

| Value | Meaning |
|---|---|
| `"250ms"` | 250 milliseconds |
| `"90s"` or `90` | 90 seconds |
| `"15m"` | 15 minutes |
| `"2h"` | 2 hours |
| `"7d"` | 7 days |

- Passing a `ttl` alone implies `ephemeral: true`.
- Omitting `ttl` on an ephemeral realm applies the server default: **1 day**
  (operators can change it with `auth.ephemeral_realm_ttl`).
- An unparseable `ttl` is rejected with `400`.
- `temporary` and `disposable` are accepted as input aliases for `ephemeral`.

## Creating an Ephemeral Realm

There are two paths. Use the HTTP endpoint if you hold a **management token**
(prefix-scoped, safest to hand to automation); use the signed management
command if you hold the **global admin token**.

### Path A — HTTP endpoint (management token)

```
POST /api/realms
Authorization: Bearer <management token>
Content-Type: application/json

{
  "realm": "apps:myservice:ci-run-4821",
  "manager_key": "<random secret you generate>",
  "ephemeral": true,
  "ttl": "2h"
}
```

```bash
curl -X POST "$MQ_URL/api/realms" \
  -H "Authorization: Bearer $TYO_MQ_MANAGEMENT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"realm":"apps:myservice:ci-run-4821","manager_key":"'"$REALM_KEY"'","ephemeral":true,"ttl":"2h"}'
```

Response:

```json
{
  "ok": true,
  "realm": "apps:myservice:ci-run-4821",
  "created": true,
  "manager_key_configured": true,
  "ephemeral": true,
  "expires_at": 1784343485056
}
```

`expires_at` is epoch **milliseconds**. Notes:

- Management tokens are prefix-scoped: the realm name must start with the
  token's `realm_prefix` and be strictly longer than it. `default` and `*`
  are never allowed.
- If the realm already exists, this call only rotates its `manager_key` — it
  does **not** change the realm's lifetime (`created: false` in the
  response). Use `set_realm_lifetime` for that.
- `manager_key` is required on this endpoint. Generate a strong random
  secret and keep it: it is what lets you mint client tokens (below).

Errors: `400` bad body or invalid ttl · `401` missing/invalid bearer token ·
`403` realm outside the token's prefix · `404` endpoint not enabled on this
server (auth off or no management tokens configured).

### Path B — signed management command (admin token)

Management commands travel over a Socket.IO connection as an
`AUTH_MANAGEMENT_COMMAND` event with an HMAC proof — the admin token itself
is never sent.

From Node.js, use the bundled helper:

```js
const { Authorization } = require('tyo-mq');

await Authorization.authManagementCommand(process.env.TYO_MQ_ADMIN_TOKEN, {
    command: 'add_realm',
    realm: 'ci:run-4821',
    ephemeral: true,
    ttl: '2h',
    manager_key: realmKey       // optional but recommended
}, { host: 'mq.example.com', port: 443, protocol: 'https' });
```

From other languages, emit:

```text
AUTH_MANAGEMENT_COMMAND {
  body:  { command: 'add_realm', realm: 'ci:run-4821', ephemeral: true, ttl: '2h' },
  proof: { timestamp, nonce, signature }
}
```

where `signature` is hex `HMAC-SHA256(adminToken, base)` and `base` is:

```text
"AUTH_MANAGEMENT_COMMAND" + "\n" + timestamp + "\n" + nonce + "\n" + stableStringify(body)
```

`stableStringify` is JSON with object keys sorted recursively; `timestamp`
is epoch ms (proofs older than 5 minutes are rejected); `nonce` is any
random hex string (single-use). The Go client ships this as
`CreateAdminProof`; the same recipe is a few lines in any language.

Errors: `400` invalid ttl · `409` realm already exists · `401` bad proof.

## Getting Clients Into the Realm

An ephemeral realm is an auth boundary like any other. Three options, in
order of convenience for automation:

**1. Mint realm JWTs yourself (recommended).** If you set a `manager_key` at
creation, you can sign HS256 JWTs locally — no further server round-trips:

```js
const jwt = signHs256({ realm: 'ci:run-4821', role: 'both', exp: nowSec + 7200 }, realmKey);
// role: 'producer' | 'consumer' | 'both'
```

Clients authenticate with `AUTHENTICATION { token: jwt }` (in the client
libraries: `new Factory({ auth: { token: jwt } })`). The server verifies the
JWT against the realm's own `manager_key`, honours `exp`/`nbf`, and scopes
the connection to the realm. Give tokens an `exp` at or before the realm's
expiry.

**2. Pre-shared key for consumers.** Create the realm with a `key` and let
consumers join with `auth: { realm, role: 'consumer', key }`.

**3. Authorization request flow.** Clients submit `AUTHORIZATION` requests
and a manager approves them with the realm `manager_key`. Full flow in
[AUTHENTICATION.md](AUTHENTICATION.md). Approved tokens are realm-scoped, so
they are disposed of with the realm.

## Managing the Lifetime

Extend, re-arm, or convert with `set_realm_lifetime` (admin command):

```json
{ "command": "set_realm_lifetime", "realm": "ci:run-4821", "ephemeral": true, "ttl": "4h" }
{ "command": "set_realm_lifetime", "realm": "ci:run-4821", "ephemeral": false }
```

- A new `ttl` resets `expires_at` to now + ttl (heartbeat pattern: a
  long-running job can re-issue the ttl periodically and the realm lives
  exactly as long as the job does).
- `ephemeral: false` makes the realm permanent (clears the expiry).
- `ephemeral: true` on a permanent realm makes it disposable.
- `default` and `*` are structural and cannot be converted.

To dispose early, `remove_realm` — same full cleanup, immediately:

```json
{ "command": "remove_realm", "realm": "ci:run-4821" }
```

Inspect state at any time: the `get` management command returns realm
configs including `ephemeral` and `expires_at` (secrets redacted).

## What Your Implementation Must Handle

- **Expiry is a hard stop.** Connected sockets are force-disconnected and
  reconnection fails auth (the realm and its tokens are gone). Treat a
  disconnect followed by `AUTH_FAIL` as "realm expired", not as a transient
  network error — do not retry forever.
- **Durable data dies with the realm.** Queued messages and DLQ entries are
  purged on disposal. Drain anything you need (e.g.
  `GET /api/realms/{realm}/dlq`) before the expiry.
- **Budget the ttl, then extend.** Prefer a short ttl plus heartbeat
  extensions over a generous ttl — an orphaned realm then disappears
  quickly after its owner dies.
- **Name realms uniquely per run.** e.g. `ci:run-<id>`, `session:<uuid>`.
  `add_realm` returns `409` on a name collision; the HTTP endpoint would
  silently rotate the existing realm's key instead of creating one (check
  `created` in the response).
- **The sweep has up to 60 s of slack.** A realm may outlive `expires_at` by
  up to a minute; don't build tests that assume disposal is instant.
- **Clock source is the server.** `expires_at` comes from the server clock;
  compare against it (returned in the create response), not your own clock.

## Quick Reference

| Operation | How |
|---|---|
| Create ephemeral realm | `add_realm {realm, ephemeral: true, ttl}` or `POST /api/realms` |
| Default ttl | 1 day (`auth.ephemeral_realm_ttl`) |
| Extend / re-arm | `set_realm_lifetime {realm, ephemeral: true, ttl}` |
| Make permanent | `set_realm_lifetime {realm, ephemeral: false}` |
| Dispose now | `remove_realm {realm}` |
| Inspect | `get` → `realms[name].ephemeral`, `.expires_at` (epoch ms) |
| Disposal covers | config, scoped tokens, runtime state, sockets, stored messages + DLQ |
| Sweep cadence | every 60 s and at server startup |
