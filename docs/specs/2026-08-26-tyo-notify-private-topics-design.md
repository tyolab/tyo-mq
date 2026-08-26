# TYO Notify — private topics (cert-bound subscribe + token-gated publish) — design

- **Date:** 2026-08-26
- **Status:** Design for review (not yet built)
- **Builds on:** `docs/specs/2026-08-20-tyo-notify-service-design.md` (TYO
  Notify core: public, no-auth publish/subscribe on the isolated `notify`
  realm). This doc resolves that spec's deferred **Open decision #5 — "Topic
  access control (later)... note as a P-later for a paid/hosted tier."**
- **Motivating use case:** hooking push notifications into TYO product contact
  forms (tyo.com.au, tyo.com.au-nextjs15, id.tyo.com.au via the shared
  `pymailer` `/send_mail` endpoint; store.tyo.com.au separately). Contact-form
  submissions carry a third party's PII (name, email, message) — a materially
  higher bar than the fully-public model is appropriate for. Private topics are
  a general broker capability; the contact-form hook is simply the first
  consumer.

## 1. Goal

Add an **opt-in, per-topic** access-control layer to TYO Notify, without
touching the behavior of any topic that doesn't opt in. Today, knowing a
topic's name is the entire security model (publish AND subscribe are fully
public on the `notify` realm, by design — see the base spec). That's fine for
demo/playground use, but wrong for a topic carrying real personal data:
whoever learns the name — via a log line, a leaked config, a screenshot —
gets standing read access forever.

**Non-negotiable constraint:** zero behavior change for any topic that has not
opted in. Private topics are claimed explicitly; everything else on `notify`
stays exactly as public/no-auth as it is today.

## 2. Architecture — two-sided model

Two independent problems, two independently-appropriate mechanisms — reusing
patterns this codebase already trusts rather than inventing new primitives:

- **Who can read (subscribe/register)** → **device keypair binding**. The
  claiming device generates an asymmetric keypair, hardware-backed
  (Android Keystore / iOS Keychain-Secure Enclave — see §7), and the broker
  pins its public key to the topic at claim time, trust-on-first-use. This is
  the same identity-pinning pattern secure-chat already uses. No CA, no
  certificate chain — the broker just remembers "this exact public key owns
  this topic," permanently, from claim onward.
- **Who can write (publish)** → **plain bearer token**. The publisher is a
  server (pymailer, later store.tyo.com.au's Strapi backend), not the phone —
  it can't hold the phone's private key. A random 256-bit token, generated at
  claim time and stored hashed, is the simplest correct answer here — the same
  trust model pymailer's own client API key already uses today.

**Algorithm choice:** ECDSA over P-256 (secp256r1). This is the one curve
natively supported by hardware-backed key storage on **both** platforms —
Android Keystore (API 23+) and iOS Secure Enclave (`kSecAttrTokenIDSecureEnclave`
only supports P-256 for private-key operations) — so it's a locked decision,
not an open risk.

## 3. Claim flow (first-claim-wins, opt-in)

```
POST /notify/{topic}/claim
  { pubkey, push_token, app_id?, signature }
  // signature = ECDSA-P256(private_key,
  //   adminSignature.signatureBase('claim', {topic, pubkey, push_token, app_id}, timestamp, nonce))
```
Reuses `tyo-mq-protocol`'s existing `adminSignature.stableStringify`/
`signatureBase(action, body, timestamp, nonce)` (already imported into
`server.js` as `adminSignature`, used today for HMAC-signed admin actions) —
only the final primitive differs: ECDSA-verify against the claimed pubkey
instead of HMAC against a shared secret. `timestamp`+`nonce` are
**client-generated**, not server-issued — see §4 for why that's sufficient.

The broker verifies the topic is unclaimed and the signature is valid, then
atomically binds `topic → pubkey`. Response:

```
{ publish_token: "<256-bit random, shown once>" }
```

`publish_token` is what you hand to the publisher's config (e.g. pymailer's
settings) — it is never stored in plaintext, only its hash. Claim also
performs the initial push registration (`push_token`), so no separate register
call is needed for the claiming device.

**Race/squat note:** claiming is first-come, not identity-verified against the
topic name itself. If someone else claims a name you wanted first, the fix is
just "pick a different name" — this was never a security property, since the
whole point of this design is that the name no longer needs to stay secret.

## 4. Subscribe / register — self-signed requests, ticket only for SSE

**No server-issued challenge round-trip.** `admin-signature.js` already solves
"verify a signed action with replay protection" without one: the client
generates its own `timestamp` + `nonce`, signs `signatureBase(action, body,
timestamp, nonce)`, and the broker checks (a) the signature against the
pinned key, (b) `timestamp` is within a small freshness window, and (c) the
`(topic, nonce)` pair hasn't been seen before within that window (a small,
TTL-swept in-memory set — bounded the same way the SSE ticket store is
bounded). That's sufficient replay protection without ever asking the broker
for a nonce first — one fewer round trip on every call.

The existing ticket mechanism (`POST /sub-ticket/:realm` →
`GET /sub/:realm/:event?ticket=...`, P4b-2, `lib/server.js:4584`) still
matters for exactly one case: it exists because a browser `EventSource`
cannot set an `Authorization` header, and a live SSE stream can't be resigned
per-event either way. TYO Notify's mobile client *can* set headers on
ordinary requests, so only SSE needs the ticket indirection:

**Self-signed requests** (`json`/`raw` poll, `register`, `unregister`):
```
GET  /notify/{topic}/json|raw
POST /notify/{topic}/register
POST /notify/{topic}/unregister
  X-Tyo-Notify-Timestamp: <ms>
  X-Tyo-Notify-Nonce: <client-generated random>
  X-Tyo-Notify-Signature: <ECDSA-P256 over signatureBase(action, body-or-query, timestamp, nonce)>
```
Freshness window ~60s. No ticket, no extra round trip — a native client signs
locally and sends.

**SSE — ticket, mirroring `/sub-ticket` exactly** (can't resign per event):
```
POST /notify/{topic}/sse-ticket
  { timestamp, nonce, signature }                     // same self-signed proof, action='sse-ticket'
  → { ticket, expires_in: 60 }                         // single-use, ~60s — same as P4b-2

GET  /notify/{topic}/sse?ticket=...
```

Unclaimed topics are untouched by any of this — no signature, no ticket
required, exactly as today.

## 5. Publish — bearer token

```
POST /notify/{topic}
  Authorization: Bearer <publish_token>
```

Required only when the topic is claimed. Constant-time comparison against the
stored hash (no timing side channel), same discipline as the broker's existing
token-validation paths. Publish on an unclaimed topic is unchanged (still
fully public, matching today).

## 6. Storage

A **new, dedicated store** (`lib/notify-store.js` → `tyo-mq.notify.sqlite`,
same `DatabaseSync` + WAL pattern as `lib/auth-store.js`), not a bolt-on to
the existing auth-store. `auth-store.js` is built specifically around
diffing an in-memory `settings.auth` object (`sync(auth)` — realms/tokens are
admin-configured settings); claims aren't admin config, they're
server-generated records created by a single atomic claim event, so they
don't fit that diff-sync shape. A small dedicated table is the honest fit:

```
notify_claims (topic PRIMARY KEY, pubkey, pubkey_fingerprint,
                publish_token_hash, created_at)
```

Note **no `push_token` column** — the device's current FCM/APNs token for
delivery stays exactly where it already lives, the in-memory
`Push.TokenRegistry` (`lib/push.js:1323`), unaffected by this design. That
registry is deliberately non-durable (per the base spec: "no durable account
data" on the public surface) and cheap to repopulate — the app just calls
`register` again next time it opens, now under the same
self-signed-request auth as any other read-side call (§4). Only topic
*ownership* (the pubkey binding + publish token) needs to survive a broker
restart; *where to currently deliver* does not.

This makes claims **durable across broker restarts**, unlike the message ring
itself (still memory-only, 12h TTL — unchanged, see base spec). A restart does
not un-claim a topic or invalidate its publish token; only in-flight messages
in the ring are lost on restart, exactly as today.

## 7. Platform notes — Android now, iOS rides the same protocol later

The broker-side protocol (§3–§5) is entirely platform-agnostic — plain HTTP +
a public-key signature, nothing Android-specific. The only platform-specific
piece is where the private key lives, and both platforms already have shipped
precedent in this codebase:

- **Android:** Keystore-backed keypair (same as secure-chat's SC-Android P2).
- **iOS:** Keychain/Secure Enclave-backed keypair (same as secure-chat's
  SC-iOS P2).

This spec ships **Android-first**, matching where TYO Notify's mobile app
actually runs today (per `2026-08-20-tyo-notify-android-app-design.md`). TYO
Notify iOS's own APNs content-push pipeline (P2–P4) is separately blocked on
an Apple APNs key + App ID, not on code — once that unblocks, iOS gets private
topics "for free" from the same broker protocol, no new design needed.

## 8. Reserved system namespace (future-proofing, not built now)

Topic names starting with `_` or `system:` are **reserved** — the claim
endpoint refuses them, unclaimed or not. This mirrors how the `notify` realm
name itself is already documented as reserved and rejected for account
realms.

This is a one-line validation rule and one line of documentation — **not** a
new admin-messaging feature. The actual use (e.g. the broker notifying a topic
owner "this topic is being removed for abuse") has no concrete scenarios yet
and is explicitly **not designed here** — speccing hypothetical abuse flows
now would be guessing. The payoff of reserving the namespace today is that
whenever a real scenario shows up, it has a collision-free space to land in
as its own small follow-up spec.

## 9. Threat model

| Adversary | Goal | Defense |
|---|---|---|
| Stranger who learns the topic name | Read messages | Must also prove possession of the device's private key via a signed nonce, or an SSE ticket derived from one (§4) — the name alone is now worthless |
| Stranger who learns the topic name | Inject fake messages | Must also hold the publish token (§5) — bearer, server-held, never present on the phone |
| Attacker who intercepts a nonce or SSE ticket | Reuse it to read | Both are single-use and short-lived (~60s) and scoped to one topic (§4) — not long-lived secrets |
| Race to claim a name first | Squat someone's intended topic | Not a security hole (§3) — the model never depended on the name being secret; worst case is picking a different name |
| Lost/reinstalled phone | Recover a claimed topic | **Non-goal for v1** (§10) — no recovery path exists; explicitly accepted, not a silent gap |
| Anyone | Claim a reserved system-namespace topic | Rejected outright by the claim endpoint (§8), regardless of claim state |

## 10. Non-goals (v1)

- Key recovery / backup if a device is lost or reinstalled. Given rare,
  low-stakes traffic, the accepted fallback is: claim a new topic name, update
  the publisher's token. Explicit, not silently missing.
- Multi-device sharing of one claimed topic (one pubkey per topic only).
- Revocation UI — rotation means claiming under a new name; there is no
  in-place "reset this topic's key" operation in v1.
- Idle-expiry auto-release of abandoned claims — a reasonable future addition,
  deferred.
- Any actual admin/system-notification feature using the reserved namespace
  (§8) — namespace only, no feature.

**Known limitation (not a v1 non-goal — a real gap to track before multi-node
deployment):** the claim store (`lib/notify-store.js`) is a local SQLite file
per broker node, not cluster-coordinated. `tyo-mq`'s existing multi-node
support (`lib/cluster.js`) uses a shared Redis for settings sync and a
`SET NX` pattern for exclusive nonce claims — the private-topics claim store
uses neither. If TYO Notify is ever run on more than one broker node (the
production TW deployment already runs two VMs for other realms), two devices
racing to claim the same topic against two *different* nodes would **both
win**, each on its own node's local store — silently violating first-claim-wins
across the cluster. Single-node deployments (where TYO Notify runs today) are
unaffected. Before enabling private topics on a multi-node deployment, this
needs either topic-sticky routing at the load balancer or a Redis `SET NX`
guard before the local write, mirroring `cluster.js`'s existing nonce-claim
pattern — not designed here.

## 11. How the contact-form use case wires in

pymailer's `server/api/send.py::send_mail()`, after a successful
`provider.send(message)` where `template_name == "contactus.html"`, does:

```
POST /notify/{claimed-topic}
  Authorization: Bearer <publish_token>
  (mode=wake — keeps the actual PII out of FCM/Google, per the existing
   content-vs-wake choice in the base spec)
```

`{claimed-topic}` and `<publish_token>` are pymailer config, set once after
claiming the topic from the TYO Notify Android app. This covers tyo.com.au,
tyo.com.au-nextjs15, and id.tyo.com.au in one hook, with zero frontend
changes. store.tyo.com.au's separate Strapi-based contact-form (currently
wired to **no** notification at all) is an explicit follow-up, out of scope
here — different stack, its own lifecycle-hook design.
