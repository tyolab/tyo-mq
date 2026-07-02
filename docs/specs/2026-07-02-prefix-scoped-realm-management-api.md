# Prefix-scoped realm management API

**Date:** 2026-07-02
**Status:** Approved design — ready for implementation plan

## Problem

tyoman-server needs to create/register a realm (with a per-realm `manager_key`)
on tyo-mq when an operator creates a realm. Today realm management
(`add_realm`, `set_realm_manager_key`) is available only over the **socket**
`AUTH_MANAGEMENT_COMMAND` path, and only to the **global** admin token
(`realm:"*"`, `role:"admin"`), which can manage *any* realm and change server
settings. Handing tyoman-server that token is over-privileged.

We want a narrow HTTP surface tyoman-server can call, authenticated by a
credential that may manage **only realms under a configured prefix**
(`apps:tyoman:`), so tyoman-server can never create or alter realms outside its
namespace.

This is sub-project 1 of a 3-part effort (realm↔MQ integration + operator
approval). It delivers only the tyo-mq side: a prefix-scoped realm create/rotate
REST endpoint.

## Context (current code)

- `lib/server.js` runs an HTTP server (`http.createServer` → `handleHttpApiRequest`).
  `handleHttpApiRequest` is **GET-only** today (`/health`, `/api/metrics`,
  `/api/stats`, `/api/realms/{realm}/dlq`); some routes are gated by
  `httpAuthOk(req)` which Bearer-checks the **global admin** token via
  `hashToken` + `getAdminTokens()`.
- `applyAuthManagementCommand(body)` is the reusable command core. `add_realm`
  creates `auth.realms[realm] = { required, manager_key, ... }` (409 if it
  exists); `set_realm_manager_key` sets/rotates the key (404 if absent). It
  mutates a *clone* of `authOptions`; the socket handler
  (`socket.on('AUTH_MANAGEMENT_COMMAND', …)`, ~line 3038) commits the result and
  persists.
- Per-realm auth: `getRealmManagerKey(realm)` + the per-realm-JWT branch in
  `validateToken()` verify a client JWT against the realm's `manager_key`. So a
  realm created here with a `manager_key` immediately supports JWT auth.
- Settings persist to `TYO_MQ_SETTINGS_FILE` when configured.

## Decisions (approved)

1. Add an HTTP endpoint `POST /api/realms` (create/rotate a realm), not a socket
   command, so a Go caller needs no socket.io/HMAC client.
2. Authenticate it with a new **prefix-scoped management token**, separate from
   the global admin token and from per-realm manager keys.
3. Enforce the prefix on every call: the token may only touch realms starting
   with its `realm_prefix` and strictly longer than it.
4. Scope creep excluded: no approval/`require_acceptance` fields (sub-project 3),
   no realm delete/rename here.

## Architecture

### Component 1 — prefix-scoped management credential

New optional config array `auth.management_tokens`:
```json
{
  "auth": {
    "management_tokens": [
      { "token": "<shared-secret>", "realm_prefix": "apps:tyoman:" }
    ]
  }
}
```
- Provisioned via the settings file (or env-injected into it) out of band; the
  raw value is a shared secret also held by tyoman-server.
- Helper `managementTokenForRequest(req)`:
  - parse `Authorization: Bearer <token>`;
  - hash-compare (`hashToken`) against each `auth.management_tokens[].token`;
  - return the matched entry `{ token, realm_prefix }` or `null`.
- Helper `realmAllowedForPrefix(realm, prefix)` → true iff `prefix` is non-empty,
  `realm.startsWith(prefix)`, `realm.length > prefix.length`, and
  `realm` ∉ { `"*"`, `"default"` }.

These are additive; existing global-admin and manager-key paths are unchanged.

### Component 2 — `POST /api/realms`

Extend `handleHttpApiRequest` so it dispatches by method+path (today it early-
returns on non-GET). Add, before the GET-only guard, a route:

```
POST /api/realms
  Authorization: Bearer <management-token>
  Body (JSON): { "realm": "apps:tyoman:acme", "manager_key": "<hex-secret>" }
```

Handler flow:
1. `entry = managementTokenForRequest(req)`; if `null` → `401
   {ok:false, code:401, message:"management token required"}`.
2. Parse JSON body (bounded read). Require `realm` (string) and `manager_key`
   (non-empty string) → else `400`.
3. `realmAllowedForPrefix(realm, entry.realm_prefix)` false → `403
   {ok:false, code:403, message:"realm outside managed prefix"}`.
4. Upsert via the shared apply helper (Component 3):
   - realm absent → `add_realm` with `{ realm, manager_key, required:true }`
     (`created:true`);
   - realm present → `set_realm_manager_key` with `{ realm, manager_key }`
     (`created:false`).
5. `200 {ok:true, realm, created, manager_key_configured:true}` — never echo the
   `manager_key`.

Only served when auth is enabled and `auth.management_tokens` is non-empty;
otherwise the path falls through to `404` (unknown route). The endpoint accepts
**only** management tokens — a global `*` admin token is not accepted here (admin
keeps using the socket path).

### Component 3 — shared apply/persist helper (DRY)

Factor the socket handler's "run `applyAuthManagementCommand` → commit the
returned auth to `server.authOptions` → persist to settings file" sequence into
one helper (e.g. `runManagementCommand(body)`), and call it from both the socket
`AUTH_MANAGEMENT_COMMAND` handler and the new REST endpoint. This guarantees
the REST path persists realms identically (survives restart) with no divergent
logic. Behavior of the socket path is unchanged.

**Implementation note (2026-07-02):** No refactor was needed. `applyAuthManagementCommand`
already performs the commit (`settings.replace`) and persist (`persistSettings`)
internally; the socket handler simply calls it. The REST endpoint calls the same
function, so both paths share commit/persist by construction.

## Data flow

```
tyoman-server → POST https://mq.tyo.com.au/api/realms
                Authorization: Bearer <mgmt-token>
                { realm: "apps:tyoman:acme", manager_key: "…" }
  → managementTokenForRequest → entry{realm_prefix:"apps:tyoman:"}
  → realmAllowedForPrefix("apps:tyoman:acme","apps:tyoman:") = true
  → runManagementCommand(add_realm | set_realm_manager_key)
  → auth.realms["apps:tyoman:acme"].manager_key set; persisted to settings file
  → 200 {ok:true, realm, created, manager_key_configured:true}
Later: a client JWT for apps:tyoman:acme signed with that manager_key → AUTH_OK.
```

## Error handling

- `401` — missing/invalid management token.
- `403` — realm outside the token's prefix, or `*`/`default`.
- `400` — missing/invalid `realm` or `manager_key`, or malformed JSON.
- `200` — created (`created:true`) or rotated (`created:false`).
- `404` — endpoint disabled (auth off or no `management_tokens`).
- Persistence failure → `500 {ok:false, code:500, ...}`; the in-memory realm
  change is only reported ok after commit+persist succeed.

## Security

- Management token is a bearer secret compared by hash (like admin tokens); raw
  value never logged or returned.
- Prefix enforcement is the core guarantee: a `apps:tyoman:` token cannot create,
  rotate, or otherwise reach `org:*`, `*`, `default`, or a bare `apps:tyoman:`.
- `manager_key` is write-only over this API — never returned (matches the
  existing "manager_key_configured: true" convention).
- Narrower than the global admin token: cannot change global settings, tokens,
  persistence, or other realms.

## Testing (`tests/phase5-http-api.test.js`, plain-node harness)

- Valid management token + in-prefix realm → `200 created:true`; a client JWT
  signed with the posted `manager_key` for that realm then authenticates
  (`AUTH_OK`), proving the key landed.
- Re-POST same realm with a new key → `200 created:false`; old-key JWT now fails,
  new-key JWT succeeds (rotation).
- Out-of-prefix realm (`org:evil`) → `403`; realm not created.
- Bare prefix (`apps:tyoman:`), `*`, `default` → `403` (all fail
  `realmAllowedForPrefix`); realm not created.
- Missing/invalid Bearer token → `401`.
- Global `*` admin token presented to `/api/realms` → `401` (not accepted here).
- With `TYO_MQ_SETTINGS_FILE` set, the created realm is written to the file
  (persists across restart).

## Rollout (user-gated, separate)

Add a `management_tokens` entry (with `realm_prefix: "apps:tyoman:"` and a fresh
secret) to the tyo-mq settings, sync `lib/server.js` to the VM, and
`pm2 restart tyo-mq`. Share the secret with tyoman-server (sub-project 2). Run
`npm test` before deploying.

## Out of scope

- `require_acceptance`/approval semantics (sub-project 3).
- Realm delete/rename over REST.
- tyoman-server changes (sub-project 2).
