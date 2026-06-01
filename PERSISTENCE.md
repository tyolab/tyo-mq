# Persistence

Phase 2 adds optional durable delivery for subscribers that opt in.

The default storage backend is in-process memory. It survives consumer
disconnects, but it does not survive a server restart.

## Server Configuration

```js
const server = new Server({
  storage: 'memory',
  storage_options: {
    default_ttl: 24 * 60 * 60
  }
});
```

`default_ttl` is in seconds. Messages without an explicit TTL expire after this
period.

Custom stores can be passed directly:

```js
const server = new Server({
  storage: {
    enqueue(realm, event, message) {},
    dequeue(realm, event, consumer) {},
    ack(msgId) {}
  }
});
```

Each method may return a promise.

SQLite is also supported on Node.js runtimes that provide the built-in
`node:sqlite` module:

```js
const server = new Server({
  storage: 'sqlite',
  storage_options: {
    filename: '/data/tyo-mq.sqlite',
    default_ttl: 24 * 60 * 60
  }
});
```

SQLite survives server restarts and is suitable for single-node deployments.

Redis is supported for deployments that need a shared queue backend:

```js
const server = new Server({
  storage: 'redis',
  storage_options: {
    url: 'redis://localhost:6379',
    prefix: 'tyo-mq:queue',
    default_ttl: 24 * 60 * 60
  }
});
```

You can also pass an existing Redis client:

```js
const server = new Server({
  storage: 'redis',
  storage_options: {
    client: redisClient
  }
});
```

## Store Interface

```js
store.enqueue(realm, event, message)   // Promise<msgId>
store.dequeue(realm, event, consumer)  // Promise<Message[]>
store.ack(msgId)                       // Promise<void>
```

The built-in memory store queues messages per realm, event, and stable
consumer id.

## Durable Subscriptions

Durability is opt-in per subscription:

```js
consumer.subscribe('producer-name', 'event-name', handler, {
  durable: true
});
```

For subscriptions that should receive an event from any producer:

```js
consumer.subscribe('event-name', handler, {
  durable: true
});
```

Durable subscriptions use a stable `consumer_id`. By default, the browser and
Node clients use the consumer name as the `consumer_id`.

You can override the durable id per subscription:

```js
consumer.subscribe('producer-name', 'event-name', handler, {
  durable: true,
  consumer_id: 'worker-01'
});
```

When the consumer is offline, messages for durable subscriptions are stored.
When the same consumer reconnects and subscribes again, the server replays the
queued messages in order.

Non-durable subscriptions keep the original behavior: messages published while
the consumer is offline are lost.

## Message TTL

Producers can set a TTL per message:

```js
producer.produce('event-name', data, {ttl: 3600});
```

They can also set a default TTL for every message created by that producer:

```js
const producer = await client.createProducer('producer-name', {default_ttl: 3600});
```

TTL is in seconds. Expired durable messages are purged without delivery.

If no TTL is provided, the store uses `storage_options.default_ttl`, which
defaults to 24 hours.

## Current Limits

- Durable queues are implemented for the in-process memory store.
- Durable queues are implemented for SQLite when `node:sqlite` is available.
- Durable queues are implemented for Redis through the `redis` package.
- Replayed messages are acknowledged by the server immediately after send.
  Explicit client ACK, retry, and dead-letter queues are Phase 3 work.
- Multi-node routing coordination is not included in Phase 2. Redis provides a
  shared durable queue backend, while cross-node Socket.IO routing remains later
  scale work.
