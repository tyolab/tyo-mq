# tyo-mq Clustering Setup

This guide sets up multiple tyo-mq nodes (one per VM) that share one Redis.

## What clustering currently provides

| Capability | Status |
|------------|--------|
| Settings sync — realms, pre-shared keys, acceptance flags, approved/revoked tokens, persistence config applied on any node propagate to every node | ✅ |
| Cluster-wide manager-proof replay protection (a signed manager command works on exactly one node) | ✅ |
| Durable message replay across nodes — a durable subscriber can reconnect to a *different* node and still receive its queued messages (requires `storage: "redis"`) | ✅ |
| Live message routing across nodes — a producer on node A reaching a live subscriber socket on node B | ❌ not yet — see [Topology rules](#topology-rules) |
| Pending authorization requests visible from any node | ❌ not yet — submit and approve through the same node |

Because live routing is not yet cross-node, a producer and the consumers
subscribed to it must be connected to the **same** node. Use sticky sessions
(or route each realm/tenant to one node) until the socket.io Redis adapter
lands.

## Architecture

```
                        ┌─────────────┐
              ┌────────►│  Redis      │◄────────┐
              │         │ 10.0.0.5    │         │
              │         └──────▲──────┘         │
              │                │                │
        ┌─────┴─────┐    ┌─────┴─────┐    ┌─────┴─────┐
        │ tyo-mq    │    │ tyo-mq    │    │ tyo-mq    │
        │ node VM 1 │    │ node VM 2 │    │ node VM 3 │
        └─────▲─────┘    └─────▲─────┘    └─────▲─────┘
              │                │                │
              └──────── load balancer ──────────┘
                    (sticky sessions required)
```

- All tyo-mq nodes are equal peers — there is no "master" node.
- One shared Redis is the source of truth for managed settings, manager-proof
  nonces, and durable message queues. It can run on a dedicated small VM, on
  one of the tyo-mq VMs, or be a managed service (ElastiCache, Memorystore…).
- Keep Redis and the nodes in the same VPC/region — sub-millisecond RTT.

## 1. Set up the shared Redis

On the Redis VM (Debian/Ubuntu shown):

```bash
sudo apt-get install redis-server
```

Edit `/etc/redis/redis.conf`:

```conf
bind 10.0.0.5            # the private address the nodes will reach
requirepass <strong-password>
maxmemory 256mb          # cap it; queues + settings stay far below this
maxmemory-policy noeviction
appendonly yes           # survive Redis restarts with queued messages intact
```

```bash
sudo systemctl restart redis-server
```

Firewall: allow port 6379 **only** from the tyo-mq node VMs. Never expose
Redis to the internet.

For high availability, add a replica plus Redis Sentinel (or use a managed
Redis) — tyo-mq only needs a single connection URL either way.

## 2. Configure every tyo-mq node identically

Create the same `/etc/tyo-mq/settings.json` on **every** node:

```json
{
  "storage": "redis",
  "storage_options": {
    "url": "redis://:<strong-password>@10.0.0.5:6379/0",
    "prefix": "tyo-mq"
  },
  "cluster": {
    "enabled": true
  },
  "auth": {
    "enabled": true
  }
}
```

- `cluster.redis_url` is optional — it defaults to `storage_options.url`, so
  most deployments configure Redis exactly once. Set it only when settings
  sync should use a different Redis than message storage.
- Optional cluster fields: `prefix` (key/channel namespace, default
  `tyo-mq:cluster`) and `node_id` (defaults to a random id per process).
- Cluster config is read at startup; changing it requires a node restart.
  Everything else in the file stays hot-reloadable.

Create the same `.env` on every node, with the **same admin token**:

```bash
TYO_MQ_AUTH_ENABLED=true
TYO_MQ_ADMIN_TOKEN=<one-shared-admin-token>
TYO_MQ_SETTINGS_FILE=/etc/tyo-mq/settings.json
```

Setting `TYO_MQ_ADMIN_TOKEN` explicitly matters in a cluster: if you let each
node auto-generate its own token on first start, the last node to publish its
settings wins and the other nodes' generated tokens stop working. One shared
token avoids the race (approved client tokens have no such problem — they are
created once and synced).

Start each node:

```bash
npm start                      # or: node server.js --port 17352
```

The log line `Cluster sync active (node <id>)` confirms the node joined.

## 3. Load balancer

socket.io needs sticky sessions (its handshake spans multiple requests), and
until cross-node live routing exists, stickiness is also what keeps a
producer and its subscribers on the same node.

nginx example:

```nginx
upstream tyo_mq {
    ip_hash;                          # sticky by client IP
    server 10.0.0.11:17352;
    server 10.0.0.12:17352;
    server 10.0.0.13:17352;
}

server {
    listen 443 ssl;
    location / {
        proxy_pass http://tyo_mq;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;     # websocket upgrade
        proxy_set_header Connection "upgrade";
        proxy_read_timeout 86400;
    }
}
```

## 4. Verify the cluster

From any machine that can reach the nodes:

```bash
# 1. Settings written through node 1...
TYO_MQ_HOST=10.0.0.11 npm run manager     # add a realm, set a consumer key

# 2. ...are enforced by node 2:
TYO_MQ_HOST=10.0.0.12 npm run manager     # option 1: Show auth settings
```

Both nodes must show the same realms, `key_configured` flags, and token list.
A consumer connecting to any node with the realm's pre-shared key must get
`AUTH_OK`; without it, `AUTH_FAIL 401` — on every node.

## How the sync works

- The full managed settings document lives in Redis under
  `<prefix>:settings`, with a revision counter and a
  `<prefix>:settings:changed` pub/sub channel.
- Any node that applies a signed management command (or approves an
  authorization request) writes the document and publishes the change; peers
  fetch and adopt it, then refresh their local `settings.json` file cache.
  Changes published by a node are ignored by that same node (echo guard).
- A node that starts with an empty cluster seeds Redis from its local
  settings; a node that joins an existing cluster adopts the Redis document
  as the source of truth (its local file is overwritten).
- Manager-proof nonces are claimed in Redis with `SET NX PX` (10-minute TTL,
  double the proof timestamp window), so a captured signed command cannot be
  replayed against another node.
- If Redis is briefly unavailable, nodes keep serving with their last-known
  settings; management commands still apply locally and replay protection
  falls back to per-node (fail-open). Re-sync happens on the next successful
  publish.

## Sizing

For settings sync alone, Redis traffic is a few commands per management
action — idle otherwise. With `storage: "redis"`, memory grows with the
offline durable backlog (roughly payload + ~0.5 KB per queued message). A
1-core / 512 MB Redis VM is comfortable for typical fleets; cap it with
`maxmemory` as shown above.
