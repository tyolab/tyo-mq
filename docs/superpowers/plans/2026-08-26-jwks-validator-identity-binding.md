# JWKS Validator + Identity Binding Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Offline RS256/JWKS token validation for prefix-scoped external validators + binding a connection's registrable identity to the token's `identity` claim. Spec: `docs/superpowers/specs/2026-08-26-jwks-validator-identity-binding.md` (read it first — it contains the verified current-state map and all constants).

**Architecture:** New `lib/jwks.js` module (fetch/cache/verify, no server deps); `lib/server.js` wires it into `resolveExternalValidator`/`validateToken`, extends `peekJwtRealm` usage, stores `socket.tyoAuth.identity`, gates `registerIdentity`, and extends the `set_external_auth` admin command. All tests in the repo's existing `tests/runner.js` style.

**Repo:** `/data/tyolab/node/tyo-mq` only (master). Tasks are SEQUENTIAL (both touch lib/server.js).

---

### Task A: JWKS validation path

**Files:** Create `lib/jwks.js`; Modify `lib/server.js` (resolveExternalValidator ~2355, validateToken ~2442, peekJwtRealm ~2331 + its manager-key caller ~2456, set_external_auth handler ~1993); Test `tests/jwks-validator.test.js` (new, wire into package.json chain after sealed-recipient-cap).

- [ ] Step 1: Write failing tests per the spec's Testing section (happy path, all rejections, kid rotation with refetch-cooldown, admin command set/get/clear, HS256+static+preshared+live-validator regressions). Test JWKS server: plain `http.createServer` returning `{keys:[jwk]}` (export the pubkey with `key.export({format:'jwk'})`); mint tokens with `crypto.sign('RSA-SHA256', ...)` over base64url header.payload. Allow `http:` jwks_url ONLY when `NODE_ENV==='test'`-style override — decide: simpler, `lib/jwks.js` accepts http but `set_external_auth` validation requires https unless host is 127.0.0.1 (tests configure via settings object at boot, not the admin command, where convenient — mirror how sealed tests boot realms).
- [ ] Step 2: Run → red.
- [ ] Step 3: Implement `lib/jwks.js` exporting `createJwksValidator(entry)` → `{ verify(token, nowMs): Promise<{realm, role, identity?, sub}|null> }` with the cache/cooldown/TTL/skew/max-TTL semantics and constants from the spec (env overrides read once at construction). Never log tokens or keys; log fetch failures at warn with the cooldown guard.
- [ ] Step 4: Wire `lib/server.js`: jwks entries recognized in the external_validators normalization (~835) and `resolveExternalValidator` (return kind); `validateToken`'s external branch calls the jwks verify for jwks entries (same scope-check as live); realm-hint peek works for RS256 (keep HS256 gate for the manager-key path); `set_external_auth` accepts/validates/clears jwks fields; `get` echoes them.
- [ ] Step 5: Run new file + full `npm test` → green. Commit ONE commit staging the three files + package.json by name: `feat(auth): offline JWKS validator mode for prefix-scoped external validators`.

### Task B: identity binding

**Files:** Modify `lib/server.js` (AUTHENTICATION ~6731; CONSUMER handler around registerIdentity call ~5458; PRODUCER ~5554); Test `tests/identity-binding.test.js` (new, wire into chain after jwks-validator).

- [ ] Step 1: Failing tests. Fastest auth vector for binding tests WITHOUT jwks: boot with `auth.validator` function (validateToken line ~2445 honors it first) returning `{realm, role, identity}` — plus ONE end-to-end jwks-token binding test reusing Task A's helpers. Cover: bound CONSUMER register self OK / other 403 + not in `_tyoIdentities` + downstream SEALED_SUBSCRIBE for other identity still 403; PRODUCER same; unbound token unchanged; AUTH_OK unchanged shape.
- [ ] Step 2: Red. Step 3: implement per spec §2 (store `identity`, gate both registration sites through their existing error paths — read each handler's failure convention first and match it exactly). Step 4: green + full suite. Step 5: commit `feat(auth): bind connection identity to token identity claim`.

### Task C (orchestrator, after review): version bump 1.3.0→1.4.0, push, deploy both TW VMs (gated on Eric), configure the `apps:hilia:` jwks entry on mq.tyo.com.au ONCE id-auth's endpoint exists (not before — entry without a live JWKS is inert but pointless), announce in the secure-chat room + id-auth handoff.
