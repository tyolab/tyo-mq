# Sealed hardening — guaranteed-once replay + inbound cap + wrapper guards

**Date:** 2026-08-26 · **Status:** design, pending review
**Tracks:** task #39 (guaranteed-once sealed replay), #41 (unrestricted-mode
per-recipient cap), #40 (client wrapper timeout guards).
**Why now:** Hilia Slice A ships degraded (no push wake), so `SEALED_SUBSCRIBE`
replay-on-foreground is the *primary* delivery path for chat. Today a client
that disconnects mid-drain silently loses messages (ack-on-emit,
`lib/server.js` SEALED_SUBSCRIBE handler). Fix before Slice A device-testing.

---

## Part 1 — Guaranteed-once sealed replay (#39)

### Current behaviour (the hole)

`SEALED_SUBSCRIBE` → `store.dequeue(realm, 'sealed:'+identity, identity)` →
for each entry (capped at `SEALED_REPLAY_BATCH` = 100): `emit('SEALED_MESSAGE')`
then **immediately** `store.ack(id)`. The emit is fire-and-forget over the
socket; a disconnect/crash between emit and client processing = permanent loss.
`store.dequeue` is a non-destructive read (entries are deleted only by
`store.ack`), so the storage layer already supports deferred ack — only the
protocol needs to change.

### Design

**Opt-in capability flag.** The client sends `SEALED_SUBSCRIBE
{identity, ack: true}`. Without the flag (old clients), behaviour is byte-for-
byte today's (emit + immediate ack). With it, the broker:

1. Rejects a **concurrent** drain: if a drain for this `(socket, identity)` is
   already in flight, respond `{ok:false, code:409, message:'drain in
   progress'}`. (Prevents double-dequeue duplicates from a misbehaving client —
   `dequeue` has no in-flight marking.)
2. Dequeues, slices to `SEALED_REPLAY_BATCH`, and for each entry emits
   **with a server-side ack callback + timeout**:
   `socket.timeout(SEALED_REPLAY_ACK_TIMEOUT_MS).emit('SEALED_MESSAGE',
   payload, cb)` (socket.io ≥4.4; broker runs 4.8.x). The payload gains a
   `queue_id` field (the durable-store entry id) so the client can correlate
   and — if it wants — dedup.
3. Resolution per entry:
   - client responds `{ok:true}` → `store.ack(id)` (delete).
   - client responds `{ok:false}` (it received the blob but the core refused
     it — undecryptable/poison) → `store.deadLetter(id, reason)` (or fallback
     ack where the backend has no DLQ, mirroring `deadLetterMessage`). Poison
     must not requeue-loop or block the inbox.
   - timeout / no response / socket gone → **do nothing**: the entry stays
     queued; the next `SEALED_SUBSCRIBE` re-delivers it. Reconnect *is* the
     retry; no server-side retry timers, no `pendingAcks` table.
4. Entries are delivered **sequentially in queue order** (await each ack or
   timeout before the next emit). Rationale: preserves ordering into the
   Double Ratchet, keeps at most one message in flight (a crash loses zero
   acked + at most re-delivers one unacked), and self-throttles the drain. With
   a 30s timeout the worst-case stall is one RTT per message for a live client,
   and a dead client stalls once then the socket disconnect ends the drain.
5. Batch callback after the batch settles:
   `{ok:true, replayed:<acked>, dead:<dlq'd>, pending:<timed out>, more:<bool>}`.
   The client re-calls `SEALED_SUBSCRIBE` while `more` (existing loop contract,
   unchanged).

**Constants** (in `tyo-mq-protocol/constants.js`):
`SEALED_REPLAY_ACK_TIMEOUT_MS = 30000`.

### Delivery semantics (and the duplicate story)

Semantics become **at-least-once with client-side dedup** — the Signal model.
Duplicates arise only when a client processed a message but died before its ack
reached the broker. On re-delivery `handle_incoming_sealed` fails (the ratchet
has advanced past that ciphertext); the receiver treats a decrypt failure on a
`queue_id`-bearing replayed entry as "already processed or poison" and responds
`{ok:false}` → broker DLQs it. Either way the inbox drains; nothing wedges.

The live-delivery path (`SEALED_DELIVER` → online emit) is *unchanged* in this
slice: for an online recipient the message was never durably queued, so there
is nothing to ack against. (Loss window there = socket death during delivery;
the sender's `delivered:'online'` ack covers the send side. A future slice
could route live delivery through the durable store too; out of scope.)

### Client changes (all three, same shape)

On `SEALED_MESSAGE` with an ack callback present (server requested ack):
process via `handle_incoming_sealed`, then respond `{ok:true}` on success /
`{ok:false, message}` on core refusal. Without a callback: today's behaviour.
And the drain call sends `ack: true`:

- **JS** (`tyo-mq-client/lib/subscriber.js`): `sealedSubscribe` passes
  `{identity, ack:true}`; the `SEALED_MESSAGE` listener gains the optional
  socket.io ack arg (last arg is the callback function when present).
- **Kotlin** (`secure-chat/android … TyoMqReceiver.kt` + `MqSocket`):
  socket.io-client-java presents the server ack as a trailing `Ack` arg;
  `MqSocket.onEvent` must surface it. Receiver calls `ack.call(jsonOk)` after
  `handleIncomingSealed` returns / refuses.
- **Swift** (`secure-chat/apple … TyoMqReceiver.swift` + `TyoMqClient`):
  socket.io-client-swift hands the handler a `SocketAckEmitter`; wire it
  through `TyoMqClient.on` and reply `ack.with([...])`.

Kotlin+Swift changes land in the secure-chat repo → regen nothing (no FFI
change), but announce the landing SHA in the `secure-chat` agent room so Hilia
re-pins.

### Testing (#39)

- Broker unit/integration (tyo-mq `tests/`): drain with acks → inbox empty;
  **kill the socket mid-drain after N acks → exactly the unacked remainder
  survives and re-delivers on reconnect** (the headline test); `{ok:false}`
  response → entry in DLQ, not requeued; legacy client (no flag) → old
  behaviour; concurrent drain → 409; ordering preserved.
- JS client: sealedSubscribe loop against a real broker with a mid-drain
  disconnect (extend the existing sealed round-trip fixtures).
- Kotlin/Swift: extend the existing real-broker round-trip tests (JVM + sim)
  with an ack-mode drain; the kill-mid-drain case is covered at the broker
  level, clients just prove the ack plumbing.

---

## Part 2 — Unrestricted-mode per-recipient inbound cap (#41)

`SEALED_DELIVER` to an offline recipient enforces only the *realm-wide*
`max_queued_per_realm`. In `unrestricted` access mode (no UAK gate), one
anonymous sender can fill a whole realm's quota against a single victim
identity — and, because the quota is realm-wide, starve durable delivery for
*every other* identity in the realm (cross-consumer denial of service).

**Design:** add `max_queued_per_recipient` (limiter key, default e.g. 1000) —
checked in `SEALED_DELIVER`'s offline path via
`store.countQueued(realm, 'sealed:'+identity)` scoping (extend `countQueued`
with an optional event filter; all three backends). Over cap → `{ok:false,
code:507, message:'recipient inbox full'}` + `tyo_mq_rate_limited_total
{reason:'max_queued_per_recipient'}`. Applies in *both* modes (a UAK holder
can also misbehave) but matters most for `unrestricted`. Realm-wide check
stays as the outer bound.

**Testing:** fill one identity's inbox to the cap → 507 for it, delivery still
OK for a second identity in the same realm; metric increments.

---

## Part 3 — Client wrapper timeout guards (#40)

The Java client already fails blocking emits on timeout/disconnect
(`MqSocket.emitWithAck` → ArrayBlockingQueue + TimeoutException, wired to
`ChatException.Transport`). Verify + close the gap in the other two:

- **Swift**: `TyoMqClient` already uses a semaphore with timeout — audit that
  a *disconnect during wait* also unblocks (not just the timer) and that the
  error maps to `ChatError.Transport`.
- **JS** (`tyo-mq-client/lib/subscriber.js` `_sealedEmit` and friends): add a
  timeout (reject after `EMIT_ACK_TIMEOUT_MS = 15000`) and reject in-flight
  emits on `disconnect`, so a dead broker can't hang a caller forever.

**Testing:** JS — emit against a dead/never-acking socket resolves with a
rejection within the timeout; disconnect mid-emit rejects immediately.

---

## Sequencing

1. Part 1 broker + JS client (+ tests) — the message-loss fix.
2. Part 1 Kotlin + Swift receivers (+ tests, elitebook1/devmac) — announce SHA
   for Hilia re-pin.
3. Part 2 (broker-only) and Part 3 (clients) — independent, either order.
4. Deploy both TW brokers; version bump.

Non-goals: routing online SEALED_DELIVER through the durable store; server-side
retry timers for sealed replay; changing plain (non-sealed) durable replay
(it already has `ack_required`).
