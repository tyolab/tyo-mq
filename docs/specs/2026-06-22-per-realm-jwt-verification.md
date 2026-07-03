# Per-realm JWT verification

**Date:** 2026-06-22
**Status:** approved

## Problem

`validateToken()` verifies session JWTs only against a single **global**
`auth.jwt_secret`. When that key is unset (the current production config), no
JWT can be validated — the broker falls through to the static `auth.tokens[]`
list, so dynamically minted per-session tokens are rejected with
`AUTH_FAIL / Invalid authentication token`.

A global secret is also realm-agnostic: any holder could mint a valid token for
any realm, weakening per-realm isolation.

## Goal

Verify a session JWT against the **realm's own `manager_key`** (per-realm
secret) instead of requiring a global secret. This restores realm isolation and
lets a realm authenticate dynamic tokens using the `manager_key` already in its
config. The chat realm `apps:store.tyo.com.au:dev` then works with no change to
the token issuer (Strapi).

## Change — `lib/server.js`, `validateToken()`

Insert one new branch, highest precedence among the token mechanisms:

1. `auth.validator` fn — unchanged
2. `auth.auth_url` — unchanged
3. **NEW — per-realm JWT:** if the token parses as a JWT (3 parts, header
   `alg: HS256`), decode the payload *unverified* to read the `realm` claim, look
   up `getRealmManagerKey(realm)`, and if present verify the whole token with
   `validateJwtToken(token, managerKey)`. Success → `{ realm, role }`; any
   failure (bad signature, expired, no manager_key) → fall through.
4. global `auth.jwt_secret` — unchanged (fallback)
5. static `auth.tokens[]` — unchanged

### New helper

`peekJwtRealm(token)` — safely returns the `realm` claim without verifying
(try/catch; returns `null` for non-JWT / malformed input). Keeps
`validateJwtToken(token, secret)` a pure verify-with-secret function.

## Backward compatibility (purely additive)

- Static hex tokens (e.g. `realm:prefix:ft`) are not JWTs → new branch skipped.
- A realm without a `manager_key` → falls through unchanged.
- A configured global `auth.jwt_secret` still works as a fallback.

No existing behavior is removed.

## Security

Per-realm secrets mean a token minted for realm A cannot authenticate into
realm B. Overloading `manager_key` for both manager-proof operations and session
signing is an accepted trade-off for this deployment.

## Testing — `tests/phase1-auth-realms.test.js`

- JWT signed with the realm's `manager_key` → `AUTH_OK` (correct realm/role).
- JWT for a realm signed with the **wrong** key → `AUTH_FAIL`.
- JWT for a realm with **no** `manager_key` and no global secret → `AUTH_FAIL`.
- Existing static-token and global-`jwt_secret` tests stay green.

Run the full suite (`npm test`) before deploying.

## Deployment (separate, user-gated)

Sync `lib/server.js` to the VM `~/tyo-mq` and `pm2 restart tyo-mq` (briefly
disconnects TYOMAN agents; they auto-reconnect). Re-run the live `AUTH_OK` test
against `wss://mq.tyo.com.au`. Strapi is unchanged
(`mqManagerKey = 9aec46e9…`, `mqRealm = apps:store.tyo.com.au:dev`).
