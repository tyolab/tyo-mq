# TYO Notify — push service (PUT/POST → your phone) — design

- **Date:** 2026-08-20
- **Status:** Design for review (not yet built)
- **Product name:** **TYO Notify** (route/realm `notify`). "ntfy" appears in this
  doc only as the **reference product / wire-format** we aim to be compatible
  with — it is not our brand.
- **Builds on:** `docs/2026-08-07-ntfy-http-pubsub-design.md` (P4b HTTP pub/sub,
  shipped: `POST /pub`, SSE `/sub`, resume) and the push-wake stack in
  `lib/push.js` (FCM / APNs / UnifiedPush transports + per-(realm,identity)
  token registry).
- **Reference product:** [ntfy.sh](https://ntfy.sh) — "send push notifications
  to your phone or desktop via PUT/POST".

## Goal

Give tyo-mq an **ntfy-compatible notification surface**, shipped as **TYO
Notify**: publish a message to a topic with a plain `PUT`/`POST` (no SDK, no
socket) and have it arrive as a **push notification on a phone**, stream to
browsers over SSE, and be catchable after reconnect. This is the
privacy-respecting notification service of the hosted-product strategy,
showcased as a trymq demo and consumed by a dedicated **TYO Notify mobile app**
(built separately).

## Product decisions (locked with the owner, 2026-08-20)

1. **Deliverable:** broker Notify surface **+** a trymq demo page. A real mobile
   app will consume the same surface, so the publish/subscribe/registration
   protocol is a first-class contract, not a demo-only shim.
2. **Auth:** **public, no-auth publish/subscribe**, but **only on a dedicated,
   isolated `notify` realm** (never on account realms). Within that sandbox we
   match ntfy semantics; around it we keep rate limits, isolation, and no
   durable account data.
3. **Notification content:** **configurable per publish** — content-ful
   (message/title/tags on the notification, ntfy-style) **or** contentless wake
   (privacy-first, the default). The publisher chooses per message.
4. **Naming:** the service is **TYO Notify**; the route/realm/config use
   `notify`, not the third-party "ntfy" brand.

## Scope boundary

This surface carries **plain (non-E2EE) notifications** — same boundary as the
existing HTTP pub/sub. Sealed-sender / E2EE stays on the socket path. A Notify
publisher may still send already-encrypted opaque bytes as the body; the server
provides no sealed-sender machinery here.

## The Notify realm (isolation)

A single reserved realm — configurable, default id `notify` — that is:

- **Public:** publish and subscribe require no token. Enabled only when the
  operator sets `TYO_MQ_NOTIFY` config on (off by default, like `/pub`).
- **Non-durable by default:** messages are streamed live and cached in a
  **short-TTL ring** (default 12h, like ntfy) purely to serve `?since=` catch-up
  — never the durable account inbox, never Datastore/account storage.
- **Isolated:** its own rate-limit buckets, its own topic keyspace, its own push
  registry namespace. A bug or flood here cannot touch `apps:*` realms.
- **Capped:** per-IP publish rate, per-topic subscriber cap, body-size cap
  (reuse `HTTP_PUBLISH_MAX_BODY`), max topics tracked, ring size per topic.

Topic ↔ internal mapping: a Notify `topic` → event name on the `notify` realm.
Topic strings are validated with the existing `isUnsafePubKey`
(prototype-pollution safe) and a charset/length limit (ntfy allows
`[-_A-Za-z0-9]{1,64}`; we adopt the same).

## HTTP surface (ntfy-compatible subset)

Mounted under the `/notify` prefix (see open decisions for a dedicated host).

### Publish — `POST /notify/{topic}` and `PUT /notify/{topic}`

- **Body** = the notification message (UTF-8 text; empty allowed if a title/tags
  header is present). `PUT` and `POST` are equivalent (ntfy parity — this is the
  headline "via PUT/POST" behaviour; today `/pub` is POST-only).
- **Headers** (case-insensitive; support `X-` and short aliases, matching ntfy):
  - `Title` / `X-Title` / `t`
  - `Priority` / `X-Priority` / `p` — `1..5` or `min|low|default|high|max|urgent`
  - `Tags` / `X-Tags` / `ta` — comma-separated (emoji shortcodes rendered client-side)
  - `Click` — URL to open on tap
  - `Markdown` / `X-Markdown` — render body as markdown
  - `Icon`, `Cache: no` (skip the ring), `Firebase: no` (skip FCM)
  - **`X-Tyo-Push`** / `?push=` — `content` | `wake` | `off` (decision #3;
    default `wake`). `content` = message/title/priority in the push payload;
    `wake` = contentless wake; `off` = stream/SSE only, no phone push.
- **JSON publish:** `POST /notify` with `{topic, message, title, priority, tags,
  click, markdown, push}` (ntfy's "publish as JSON" form).
- **Behaviour:** build a canonical message → route through the SAME
  `routeProducedMessage` core (live SSE + socket subscribers) → append to the
  topic ring → fire phone push to the topic's registered devices per the `push`
  mode.
- **Response:** the message JSON (`{id, time, event:"message", topic, ...}`) with
  `200` (ntfy returns the published message, not 202).

### Subscribe — `GET /notify/{topic}/json`, `/sse`, `/raw`

- `/json` — newline-delimited JSON stream (ntfy's primary format).
- `/sse` — Server-Sent Events (reuse the shipped SSE sink + keep-alive).
- `/raw` — message body per line.
- Query: `?since=<id|duration|all>` (ring catch-up, reuse resume logic),
  `?poll=1` (drain + close, no stream), `?title=&priority=&tags=` filters.
- Emits `open` / `message` / `keepalive` events (ntfy event names).

### Message JSON schema (ntfy-shaped, for client compatibility)

```
{ "id", "time", "expires", "event": "open|message|keepalive|poll_request",
  "topic", "message", "title", "priority", "tags": [..], "click", "content_type" }
```

## Phone delivery

The phone push path reuses `lib/push.js` transports (FCM, APNs, UnifiedPush) but
needs a **topic → device** subscription map (the existing registry is
per-(realm,identity); Notify push is per-topic and identity-less).

- **New: NotifyTopicRegistry** — `topic → [{ transport, token/endpoint, app_id,
  added_at, last_ok }]`, node-local (a cluster mirror is the same follow-up as
  the sealed/push registries — flagged, not solved here). Namespaced to the
  `notify` realm; same per-topic cap and pruning-on-`gone` behaviour as the push
  registry.
- **Registration endpoint:** `POST /notify/{topic}/register` (public) with
  `{transport, token|endpoint, app_id}` — the mobile app / UnifiedPush distributor
  calls this to receive pushes for a topic. `POST /notify/{topic}/unregister` to
  drop.
- **Delivery:** on publish with `push=content`, send a content-ful data message
  (message/title/priority/tags/click, size-bounded) to each registered device;
  `push=wake` sends the existing contentless `{type:'wake',v:1}`; `push=off`
  skips. Best-effort, coalesced per (topic, device), prune on `gone`.
- **Transports for the TYO Notify app:** FCM (Android/our app) + APNs (iOS/our
  app) + UnifiedPush (de-Googled, SSRF-guarded — already built). The app
  registers its FCM/APNs token; UnifiedPush users register their endpoint URL.

## trymq demo page

A new demo (sibling to Secure DM/Drop), route `/notify/` on the trymq site:

- Pick or generate a topic (high-entropy default so public topics aren't
  trivially guessable).
- Copyable `curl` examples: `curl -d "Backup done" .../notify/<topic>` (POST) and
  the `-T`/`-X PUT` form, plus Title/Priority/Tags header examples.
- Live SSE view of the topic (messages stream in as you publish).
- "Get it on your phone": QR / deep link to subscribe in the TYO Notify app (or a
  UnifiedPush endpoint), so a real `curl` lights up a real phone — the demo's
  payoff.
- Honest limits note: public topic = anyone who knows it can read/write;
  non-durable; use an account realm + auth for anything private.

## Security / abuse (public no-auth surface — must-haves)

- Per-IP publish + subscribe rate limits (reuse the XFF-aware limiter); per-topic
  subscriber and device caps; global topic-count cap with LRU eviction of idle
  topics.
- Body-size cap; header-size caps; charset-validated topic keys (`isUnsafePubKey`
  + regex); prototype-pollution-safe maps.
- No durable/account storage; ring is memory-only with TTL; `Cache: no` honoured.
- Push registration abuse: cap devices/topic, verify UnifiedPush endpoints with
  the existing connect-time SSRF guard, prune aggressively on delivery failure.
- Content-ful pushes are opt-in per message; default stays contentless.
- Isolation invariant (test): nothing on the `notify` realm can publish to,
  subscribe to, or register a device against any `apps:*` / account realm.

## Reuse vs new

| Reuse | New |
|---|---|
| `routeProducedMessage` core fan-out | Notify path router (`/notify/...`), PUT support |
| SSE sink + keep-alive + `?since` resume | Notify message schema + headers→fields mapping |
| `lib/push.js` FCM/APNs/UnifiedPush transports | `NotifyTopicRegistry` (topic→device) |
| XFF rate limiter, `HTTP_PUBLISH_MAX_BODY`, `isUnsafePubKey` | topic ring buffer (TTL cache) |
| `getHttpPublishConfig` flag pattern | `TYO_MQ_NOTIFY` config + `notify` realm reservation |

## Phasing

- **N1 — publish core:** `PUT|POST /notify/{topic}` + JSON publish, headers →
  message, notify realm + config flag, ring buffer, route to live SSE/socket
  subscribers. Test: curl PUT and POST both deliver to an SSE subscriber.
- **N2 — subscribe surface:** `/json`, `/sse`, `/raw`, `?since`, `?poll`,
  filters, events. Test: ntfy CLI / `curl -s .../json` streams messages;
  `?since` catches up from the ring.
- **N3 — phone push:** `NotifyTopicRegistry` + register/unregister + content-ful
  vs wake vs off delivery over FCM/UnifiedPush. Test: register a device → publish
  → device receives the chosen payload; prune on `gone`.
- **N4 — trymq demo page:** topic picker, curl snippets, live SSE, phone
  subscribe (QR/UnifiedPush), honest-limits copy.
- **N5 — hardening + deploy:** rate/abuse caps, isolation test, adversarial
  security review of the public surface, docs/wiki, enable on trymq/freemq.
- **(TYO Notify mobile app — separate track):** subscribe to topics, register
  push, render content-ful notifications, manage topics; consumes N1–N3.

## Open decisions (resolve in review)

1. **Where it is exposed:** dedicated host (e.g. `notify.tyo.com.au` → broker, so
   the URL root is topics and clients feel native) vs a path prefix
   `/notify/{topic}` on the existing broker host. A dedicated host is the most
   native and lets the topic sit at the URL root, but needs DNS + nginx. **Lean:
   path prefix `/notify/` first (no infra), dedicated host later.**
2. **Wire-compat strictness:** exact ntfy JSON/paths so the *existing* ntfy
   Android app + `ntfy` CLI work unmodified, vs an ntfy-*shaped* API tailored to
   the TYO Notify app. **Lean: match ntfy's wire format closely** (cheap, and the
   CLI/app become free test clients), extend with `X-Tyo-*` headers.
3. **Storage/retention:** memory-only ring (simplest, lost on restart) vs a
   short-TTL durable cache for `?since` across restarts/cluster. **Lean:
   memory-only ring for N1–N4; revisit for cluster.**
4. **Mobile push transport priority:** FCM-first (fastest to a working Android
   app) vs UnifiedPush-first (de-Googled, matches the privacy positioning).
   **Lean: both, FCM-first for the app, UnifiedPush in the same phase.**
5. **Topic access control (later):** ntfy supports per-topic read/write tokens
   and reservations. Out of scope for the public sandbox now; note as a P-later
   for a paid/hosted tier.
