# Offline JWKS validator + token identity binding

**Date:** 2026-08-26 · **Status:** design, pending review · **Task:** #82
**Purpose:** per-user tyoid authentication for `apps:hilia:*` (and any future
app realm) replacing the shared realm pre-shared key: id.tyo.com.au mints
short-lived RS256 user tokens; the broker validates them **offline** against
id's JWKS and **binds the connection to the token's identity**. Coordination:
secure-chat agent room msgs #317+ (token contract agreed there); id-auth agent
builds the minting endpoint (mirrors `/api/leaderboard-token`); Hilia builds
the client-side token provider seam. E2EE is unaffected — this is transport
authN/authZ only.

## Current state (verified in lib/server.js)

- `validateToken` (~2442): auth.validator fn → per-realm **HS256** JWT vs
  `manager_key` → global `jwt_secret` HS256 → static tokens → **external
  validator = live HTTP callback only** (`validateExternalToken`, POST
  {token, realm} + `x-mq-auth-secret`, prefix-scoped via
  `resolveExternalValidator`, response `{realm, role}` scope-checked).
- `peekJwtRealm` (~2331) returns null for any non-HS256 token — an RS256
  token currently yields **no realm hint** unless the client passed
  `desiredRealm` in AUTHENTICATION.
- AUTHENTICATION (~6731) stores `socket.tyoAuth = {authenticated, realm,
  role}`. Identities are registered ONLY via `registerIdentity(name)` at the
  CONSUMER (~5458) and PRODUCER (~5554) handlers into `socket._tyoIdentities`;
  all sealed/prekey/push/KEY_PUBLISH handlers authorize against that set — so
  restricting registration transitively restricts everything.
- `external_validators` entries `{realm_prefix, auth_url, auth_secret}` are
  managed by the `set_external_auth` admin command (~1993) and persisted with
  auth settings.

## Design

### 1. JWKS validator mode (new, offline)

An `external_validators[]` entry may now be a **jwks entry**:
`{realm_prefix, jwks_url, iss, aud}` (mutually exclusive with `auth_url` in
one entry; both kinds may coexist in the list for different prefixes).
`resolveExternalValidator` returns the matched entry with its kind; a jwks
entry short-circuits to offline verification instead of the HTTP callback.

**Verification** (new module `lib/jwks.js`):
- Parse compact JWT; header must be `alg:"RS256"` with a `kid`.
- Key lookup from a per-entry cache `{byKid, fetchedAt}`; on unknown `kid`,
  re-fetch the JWKS (HTTPS GET, 5s timeout, response ≤64KB) at most once per
  `JWKS_REFETCH_COOLDOWN_MS` (60s); background TTL refresh after
  `JWKS_CACHE_TTL_MS` (1h) on next use. Fetch failure → token rejected (fail
  closed), cache retained, error logged once per cooldown (no log flood).
- JWK → key via `crypto.createPublicKey({key: jwk, format: 'jwk'})`;
  signature via `crypto.verify('RSA-SHA256', ...)`; constant-time not required
  (public-key op) but signature must be checked before ANY claim is trusted.
- Claims enforced: `iss` === entry.iss; `aud` === entry.aud (string or
  array-contains); `exp` REQUIRED and > now; `nbf` honored; token lifetime
  capped — reject if `exp - (iat || now)` > `JWKS_MAX_TTL_SECONDS` (default
  3600, env-overridable `TYO_MQ_JWKS_MAX_TTL_SECONDS`) so a misconfigured
  minter can't issue effectively-eternal user tokens. All time claims
  (`exp`/`iat`/`nbf`) must be FINITE numbers (`{exp: 1e999}` parses to
  Infinity and would NaN the cap); `iat` must not be in the future beyond
  skew (a far-future iat would slide the exp−iat window past the cap); and
  the cap is ALSO enforced against now (`exp - now ≤ maxTtl + skew`) so no
  iat/exp combination yields a token valid longer than maxTtl from the
  moment of validation. (Amended per Task A review.)
- Payload contract: `realm` REQUIRED (scope-checked against the entry's
  `realm_prefix` exactly like live validators), `role` REQUIRED
  (producer|consumer|both), `sub` REQUIRED (audit logging only), `identity`
  OPTIONAL string → returned for binding.
- Returns `{realm, role, identity?}`; validateToken passes `identity` through.
- Clock skew: allow `JWKS_CLOCK_SKEW_SECONDS` (default 30) on exp/nbf.

**Realm hint:** extend the peek helper so an RS256 token's (unverified)
`realm` claim can serve as `realmHint` for `resolveExternalValidator`, WITHOUT
loosening the HS256 gate on the manager-key verify path (the HS256-only check
moves from `peekJwtRealm` into its manager-key caller, or peek gains an
`anyAlg` mode). A forged realm claim only selects which validator runs — the
signature/scope checks still decide.

### 2. Identity binding (enforcement)

- AUTHENTICATION: when `authResult.identity` is a non-empty string, store it —
  `socket.tyoAuth.identity = String(authResult.identity)` — and include `sub`
  in the auth log line (never the token).
- `registerIdentity` gate: registration sites (CONSUMER/PRODUCER handlers)
  reject a name ≠ `socket.tyoAuth.identity` when the binding is present:
  error `403 "identity not authorized by this connection's token"` through
  each handler's existing error path. Connections whose auth carried no
  identity claim (static tokens, pre-shared key, HS256 realm JWTs, live
  validators) are UNCHANGED — binding is opt-in via the token.
- No changes needed downstream: `_tyoIdentities` can then only ever contain
  the bound identity, and every sealed/prekey/push/KEY_PUBLISH check already
  consults it.

### 3. Admin surface

`set_external_auth` (prefix-scoped form) accepts `jwks_url`, `iss`, `aud` as
an alternative to `auth_url` (+ clearing). Validation: `jwks_url` must be a
valid https URL; `iss`/`aud` required alongside `jwks_url`. Persisted exactly
like existing entries. `get` output includes the new fields (never any cached
keys).

## Token contract (for id-auth; from room msg #317)

Header `{alg: RS256, kid}`. Claims: `iss: "https://id.tyo.com.au"`,
`aud: "tyo-mq"`, `sub: <tyoid uid>`, `realm: "apps:hilia:chat"`,
`role: "both"`, `identity: "chat-<uid>"`, `exp` ≤ 15–60 min, `iat`, `nbf`.
JWKS at `https://id.tyo.com.au/.well-known/jwks.json`.

## Testing

Local RSA keypair (`crypto.generateKeyPairSync`), in-test HTTP server serving
the JWKS, tokens minted in-test. Broker boots with a jwks validator entry for
`apps:testjwks:`.
- Happy path: valid token → AUTH_OK with the token's realm/role; CONSUMER
  register as the bound identity succeeds; sealed flows work end-to-end.
- Rejections: bad signature, wrong iss, wrong aud, expired, nbf-future,
  lifetime > max TTL, realm outside prefix, missing role/realm/sub, HS256
  token against a jwks entry.
- kid rotation: token with new kid → exactly one refetch → accepted; unknown
  kid + refetch still missing → rejected; refetch cooldown respected (two
  bad-kid tokens in <60s → one fetch).
- Binding: register bound identity OK; register OTHER identity → 403 and NOT
  in `_tyoIdentities`; sealed SEALED_SUBSCRIBE for the other identity still
  403s; no-identity-claim token → unrestricted registration (legacy).
- Regression: HS256 realm JWTs, static tokens, pre-shared key realms, and
  live-callback validators all behave exactly as before (existing suites).

## Non-goals

Mid-session revocation / disconnect-on-expiry (token checked at AUTHENTICATION
only — same as tyoman today; possible later feature). HTTP publish/SSE
identity binding (those paths have no identity registration). ES256/EdDSA
(RS256 only until id needs otherwise). JWKS for the id endpoint itself
(id-auth agent's side).

## Rollout

Ship broker (this batch) → id-auth builds the endpoint against the token
contract → configure the `apps:hilia:` jwks entry on mq.tyo.com.au via
`set_external_auth` → Hilia swaps its provider seam → static realm key retired
for user traffic (may stay for CI/smoke). Hilia's feature flag opens to real
users only after this chain is live (their stated gate).
