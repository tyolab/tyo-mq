# tyo-mq — Improvement Plan

Current version: 0.9.x
Based on: socket.io, Node.js

---

## Current State (what exists)

- Pub/sub over WebSocket (socket.io)
- In-memory producer/consumer/subscription registry
- Large message chunking (256 KB frames, reassembled on receiver)
- Disconnect/reconnect awareness (subscriptions survive disconnect)
- Duplicate consumer detection and rejection
- **No authentication** — `AUTHENTICATION` handler is wired but empty
- **No persistence** — messages lost if subscriber is offline
- **No org/realm isolation** — all producers/consumers share one flat namespace
- **No delivery confirmation** — fire-and-forget only
- **No wildcard subscriptions** — must subscribe to exact producer+event string

---

## Roadmap Overview

| Phase | Theme | Key deliverable |
|-------|-------|----------------|
| **1** | Auth + Realms | Token auth, org/realm namespace isolation |
| **2** | Persistence | Durable queues, offline delivery, message TTL |
| **3** | Reliability | ACK, dead-letter queue, retry |
| **4** | Routing | Wildcard subscriptions, topic-based routing, groups |
| **5** | Observability | REST management API, metrics, admin UI |
| **6** | Scale | Multi-node clustering, horizontal scale |

---

## Phase 1 — Authentication & Realm Isolation

### Why first
Without auth and isolation, tyo-mq cannot be safely used for multi-org or
multi-tenant deployments. Everything else builds on a trustworthy boundary.

### 1.1 Token Authentication

Fill in the empty `AUTHENTICATION` handler in `server.js`.

**Protocol:**
```
client → server: AUTHENTICATION { token: "<jwt-or-api-key>" }
server → client: AUTH_OK { realm: "acme", role: "producer|consumer|both|manager|admin" }
               | AUTH_FAIL { code: 401, message: "..." }
```

- Unauthenticated sockets can only complete the handshake; all other events
  are rejected until AUTH_OK is sent
- Token formats supported: opaque API key (v1), JWT with `realm` + `role`
  claims (v2)
- Token validation is pluggable — default is an in-process map from config;
  advanced: delegate to an external auth endpoint

**Config (`tyo-mq.yaml` or passed to `new Server(options)`):**
```yaml
auth:
  enabled: true
  tokens:
    - token: "secret-acme-prod"
      realm: "acme"
      role: "producer"
    - token: "secret-acme-cons"
      realm: "acme"
      role: "consumer"
  jwt_secret: ""        # if set, accept signed JWTs instead of opaque tokens
  auth_url: ""          # if set, POST token here for external validation
```

### 1.2 Realm (Org) Isolation

A **realm** is a named isolation boundary. Producers and consumers in realm
`acme` cannot see or interact with those in realm `beta`.

**How it works:**
- On AUTH_OK, the socket is tagged with its realm
- All subscription lookups and message routing are scoped by realm
- A socket in realm `acme` that tries to subscribe to a producer in realm
  `beta` gets `AUTH_FAIL { code: 403 }`
- A special `realm: "*"` (admin) can see across realms — for monitoring
  and management use only

**Internal change:** `subscriptions`, `producers`, `consumers` maps become
realm-keyed:
```js
// before
var producers = {};

// after
var realms = {};  // realms[realmId] = { producers, consumers, subscriptions }
var getRealm = (id) => realms[id] = realms[id] || { producers: {}, consumers: {}, subscriptions: {} };
```

No changes to the client API — realm is transparent once authenticated.

### 1.3 Roles

> **Note:** `manager` is a new per-realm administration role that sits
> between `admin` and the producer/consumer roles.

| Role | Can do |
|------|--------|
| `producer` | PRODUCER, PRODUCE, PRODUCE_CHUNK |
| `consumer` | CONSUMER, SUBSCRIBE, UNSUBSCRIBE |
| `both` | All of the above |
| `manager` | Realm administration: approve/accept producers, manage realm pre-shared keys and realm settings, management API scoped to its own realm |
| `admin` | Everything, across all realms (`realm: "*"`) + management API (Phase 5) |

### 1.4 Connection Authorization

Originally the plan required manual authorization for **every** connection.
That is now relaxed: only `manager` connections always require manual
authorization (approved by an `admin`, or by an already-authorized
manager of the same realm). All other roles are governed by per-realm
settings:

```yaml
realms:
  acme:
    require_key: true          # consumers must present the realm's pre-shared key
    require_acceptance: true   # producers must be accepted into the realm
```

**`consumer` (and `both`):** must present the realm's **pre-shared key**.
Keys are managed through the backend, the web UI, or `scripts/manager.js`.
If the connection has no realm, or the realm is configured with
`require_key: false`, the connection is allowed automatically.

**`producer` (and `both`):** must be **accepted** into the realm (a manager
or admin approves the pending request) before it may produce messages.
If the realm is configured with `require_acceptance: false`, producing is
allowed without acceptance.

A `both` connection is subject to **both** rules: the pre-shared key to
connect/consume, and realm acceptance to produce — each independently
relaxed by the realm's settings above.

---

## Phase 2 — Persistence & Durable Queues

### Why
A producer publishes a command while the subscriber is offline. Today the
message is lost. Persistence holds it until the subscriber reconnects.

### 2.1 Pluggable Storage Backend

Persistence is optional and pluggable. Default is in-process (memory, no
restart survival). Swap in a real backend for production.

```js
new Server({
  storage: 'memory',    // default — same as today, no persistence
  storage: 'sqlite',    // single-file, zero-dependency persistent store
  storage: 'redis',     // Redis for multi-node / high throughput
  storage: require('./my-store'),  // custom: implement the Store interface
})
```

**Store interface (3 methods):**
```js
store.enqueue(realm, event, message)   // → Promise<msgId>
store.dequeue(realm, event, consumer)  // → Promise<Message[]>  (undelivered for this consumer)
store.ack(msgId)                       // → Promise<void>
```

### 2.2 Per-Subscription Durability Flag

Not all subscriptions need persistence. Subscribers opt in:

```js
// client side
consumer.subscribe('event', handler, { durable: true })
```

Durable subscriptions are registered with a stable `consumer_id` (not the
transient socket id). When the consumer reconnects with the same `consumer_id`,
the server replays undelivered messages.

### 2.3 Message TTL

Every enqueued message has a TTL (default: 24 h, configurable per-producer
or per-message). Expired messages are purged without delivery.

```js
producer.produce('event', data, { ttl: 3600 })  // seconds
```

### 2.4 Offline Delivery on Reconnect

1. Consumer reconnects and sends `CONSUMER { name, consumer_id }`
2. Server calls `store.dequeue(realm, events, consumer_id)` for all subscribed events
3. Replays messages in order before routing live traffic
4. Consumer ACKs each replayed message (Phase 3)

---

## Phase 3 — Reliability: ACK, Retry, Dead-Letter Queue

### 3.1 Delivery ACK

```
server → consumer: CONSUME <message with msgId>
consumer → server: ACK { msgId }
```

If no ACK within `ack_timeout` (default 30 s), server re-enqueues the
message for retry.

Client-side convenience — when ACK is requested, the consumer library handles
ACK automatically unless `manual_ack: true` is set.

ACK is negotiated per subscription for backwards compatibility. Durable delivery
does not require ACK by default; clients must explicitly advertise ACK support
with `ack`, `require_ack`, or `manual_ack`. Clients that omit the flag keep the
Phase 2 immediate-ack replay behavior.

### 3.2 Retry Policy

Per-subscription configuration:
```js
consumer.subscribe('event', handler, {
  durable: true,
  retry: { max_attempts: 3, delay: '5s', backoff: 'exponential' }
})
```

### 3.3 Dead-Letter Queue (DLQ)

After `max_attempts` failures, the message moves to the DLQ for that realm.
DLQ messages are visible via the management API (Phase 5) and can be
replayed or discarded manually or by an AI agent.

---

## Phase 4 — Routing: Wildcards, Topics, Groups

### 4.1 Topic-Based Routing

Today, routing is `producer-name + event-name`. Replace with a **topic path**
model (MQTT-style), so subscriptions can be hierarchical:

```
org/acme/machine/m-01/cmd         ← specific machine
org/acme/machine/+/cmd            ← all machines in acme (single-level wildcard)
org/acme/#                        ← everything in acme (multi-level wildcard)
```

This maps naturally to the tyoman fleet use case without any special-casing.

**Backwards compatible:** existing `producer/event` subscriptions continue
to work; topics are opt-in via `{ mode: 'topic' }`.

### 4.2 Consumer Groups

A consumer group lets multiple subscribers share the load of a topic — each
message is delivered to exactly one member of the group (round-robin or
least-busy), not to all of them. Useful for horizontal scaling of workers.

```js
consumer.subscribe('org/acme/machine/+/cmd', handler, {
  group: 'tyoman-workers'
})
```

### 4.3 Broadcast to Realm

A producer can broadcast to all consumers in its realm without enumerating
them:

```js
producer.produce('event', data, { broadcast: 'realm' })
// or for a subset:
producer.produce('event', data, { broadcast: 'group', group: 'workers' })
```

---

## Phase 5 — Observability & Management API

### 5.1 REST Management API

A lightweight HTTP API (separate port, default `17353`) for inspection and
control. Requires an `admin` token (all realms) or a `manager` token
(scoped to that manager's own realm).

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/realms` | List realms and connection counts |
| GET | `/api/realms/{realm}/producers` | List producers (name, online, subscriber count) |
| GET | `/api/realms/{realm}/consumers` | List consumers (name, online, subscriptions) |
| GET | `/api/realms/{realm}/queue` | Pending messages per topic/event |
| GET | `/api/realms/{realm}/dlq` | Dead-letter queue contents |
| POST | `/api/realms/{realm}/dlq/{msgId}/replay` | Replay a DLQ message |
| DELETE | `/api/realms/{realm}/dlq/{msgId}` | Discard a DLQ message |
| GET | `/api/metrics` | Prometheus-format metrics |

### 5.2 Metrics

Exposed at `GET /api/metrics` (Prometheus text format):

```
tyo_mq_connections_total{realm="acme"}
tyo_mq_messages_produced_total{realm="acme", event="cmd"}
tyo_mq_messages_delivered_total{realm="acme", event="cmd"}
tyo_mq_messages_queued{realm="acme", event="cmd"}
tyo_mq_messages_dlq{realm="acme"}
tyo_mq_ack_timeout_total{realm="acme"}
```

### 5.3 Admin Web UI (optional, Phase 5 stretch)

Minimal dashboard showing real-time realm/producer/consumer state, queue
depths, and DLQ. Can be implemented as a simple static HTML page that polls
the management API.

---

## Phase 6 — Clustering & Horizontal Scale

> **Status:** tier 1 done — shared-Redis settings sync (`cluster.enabled`),
> cluster-wide manager-nonce replay protection, and cross-node durable replay
> via the shared Redis store (see `docs/CLUSTERING.md`). Remaining: shared
> subscription registry, socket.io Redis adapter for live cross-node routing,
> and shared pending authorization requests.

When a single tyo-mq node isn't enough (high connection count or high
throughput), multiple nodes share state via a Redis pub/sub backbone:

- Each node handles its own socket connections
- Messages published on node A are forwarded to node B if the subscriber
  is connected there
- Subscription registry is stored in Redis (replaces in-memory maps)
- Load balancer (nginx / HAProxy) in front of multiple nodes with sticky
  sessions (socket.io requires sticky sessions by default; or use the
  socket.io-redis adapter which removes that requirement)

---

## Versioning Strategy

| Version | Phase | Breaking change? |
|---------|-------|-----------------|
| 0.4.x | Phase 1 (auth + realms) | No — auth is opt-in via config |
| 0.5.x | Phase 2 (persistence) | No — durable is opt-in per subscription |
| 0.6.x | Phase 3 (ACK + DLQ) | Minor — new ACK message in protocol |
| 0.8.x | Phase 4 (topics + groups) | No — topic mode is opt-in |
| 0.9.x | Phase 6 tier 1 (cluster settings sync) | No — cluster is opt-in |
| 0.10.x | Phase 5 (management API) | No |
| 1.0.0 | All phases stable | Semantic versioning from here |

Auth is always backwards-compatible when `auth.enabled: false` (default for
existing deployments).

---

## Use Cases This Unlocks

| Use case | Phases needed |
|----------|--------------|
| **tyoman fleet control** — control plane sends commands to remote tyoman agents across multiple orgs | 1 (realms), 2 (persistence), 3 (ACK), 4 (topics + broadcast) |
| **Multi-tenant SaaS event bus** — different customers' events isolated | 1 (auth + realms) |
| **Microservice message bus** — services consume from shared topics with load balancing | 4 (consumer groups) |
| **Reliable task queue** — tasks survive worker restarts | 2 (durable) + 3 (ACK + retry + DLQ) |
| **Real-time dashboard** — subscribe to wildcard topics for monitoring | 4 (wildcards) + 5 (metrics) |
| **AI agent event bus** — AI agents subscribe to events and act on them | 1 + 2 + 4 |

---

## What Does NOT Change

- socket.io as the transport — keeps browser compatibility and wide client support
- JavaScript / Node.js — no language change
- `new Server()`, `createProducer()`, `createConsumer()` API — fully backwards compatible
- MIT license
- npm package name `tyo-mq`
- Default port `17352`
