# Sealed Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Guaranteed-once sealed replay (opt-in client ack), per-recipient inbound cap, and client emit timeout guards — spec `docs/superpowers/specs/2026-08-26-sealed-guaranteed-once-replay.md`.

**Architecture:** Broker (`tyo-mq/lib/server.js` SEALED_SUBSCRIBE handler) gains an ack-mode drain: sequential per-message `socket.timeout(ms).emit` with client-confirmed `store.ack`, DLQ on client-reported poison, 409 on concurrent drain. Clients (JS `tyo-mq-client`, Kotlin `secure-chat/android` + `tyo-mq-client-java`, Swift `secure-chat/apple`) send `ack:true` and answer the server's ack callback. Separate broker change adds `max_queued_per_recipient` backed by an event-scoped `countQueued` (NEW on Redis — today Redis has NO countQueued, so even the realm cap silently never runs on the TW brokers).

**Tech stack:** Node (broker + JS client, `tests/runner.js` + `tests/helpers.js` harness), Kotlin/JVM (elitebook1), Swift (devmac). Broker socket.io is ≥4.4 (`socket.timeout().emit` available).

**Repos touched:** `/data/tyolab/node/tyo-mq`, `/data/tyolab/node/tyo-mq-client`, `/data/tyolab/java/tyo-mq-client-java`, `/data/tyolab/misc/secure-chat`.

**Deviation from spec:** `SEALED_REPLAY_ACK_TIMEOUT_MS` lives in the broker (env-overridable `TYO_MQ_SEALED_REPLAY_ACK_TIMEOUT_MS`, default 30000), NOT in `tyo-mq-protocol` constants — avoids an npm publish of the protocol package for a broker-internal tunable.

---

### Task 1: Broker — guaranteed-once SEALED_SUBSCRIBE (ack mode)

**Files:**
- Modify: `lib/server.js` (SEALED_SUBSCRIBE handler, ~line 6183)
- Test: `tests/sealed-replay-ack.test.js` (new)

- [ ] **Step 1: Write failing tests** in `tests/sealed-replay-ack.test.js` using the `startServer`/`Factory` pattern from `tests/sealed-sender.test.js` (realm with `e2ee:'required'`, sealed cfg from `makeCfgAndRoot`, UAK-registered recipient, N messages queued via SEALED_DELIVER while recipient offline). Raw socket.io client (`require('socket.io-client')`) as the recipient so tests control ack behaviour precisely:
  - `ack-mode drain acks each message and empties the inbox` — client answers every `SEALED_MESSAGE` ack callback `{ok:true}`; assert final callback `{ok:true, replayed:N, dead:0, pending:0, more:false}` and a re-drain returns `replayed:0`.
  - `mid-drain death loses nothing` (headline) — client acks the first 2 of 5 then `socket.disconnect()`s without acking the 3rd; reconnect + re-drain → exactly 3 remain, in original order.
  - `client-reported poison goes to DLQ` — client answers one message `{ok:false, message:'core refused'}`; assert it is NOT re-delivered on re-drain and IS in the DLQ (`server.store` DLQ inspection, mirroring how existing tests reach the store).
  - `no flag = legacy behaviour` — drain without `ack:true` still acks-on-emit (callback `{ok:true, replayed:N}` and inbox empty even though the client never answered acks).
  - `concurrent drain is rejected` — issue a second SEALED_SUBSCRIBE while the first is mid-flight (delay the client's first ack); assert `{ok:false, code:409}`.
- [ ] **Step 2: Run** `node tests/sealed-replay-ack.test.js` → all fail (no ack mode yet).
- [ ] **Step 3: Implement** in `lib/server.js`. Near the sealed constants, read the timeout once: `var sealedReplayAckTimeoutMs = Number(process.env.TYO_MQ_SEALED_REPLAY_ACK_TIMEOUT_MS) > 0 ? Number(process.env.TYO_MQ_SEALED_REPLAY_ACK_TIMEOUT_MS) : 30000;`. In the SEALED_SUBSCRIBE handler, after the existing identity/realm checks, branch on `obj.ack === true`:

```js
if (obj.ack === true) {
    // Guaranteed-once drain: per-message emit-with-ack; the entry is
    // removed only when the client confirms it processed the blob.
    socket._sealedDraining = socket._sealedDraining || new Set();
    if (socket._sealedDraining.has(identity)) {
        if (callback) callback({ok: false, code: 409, message: 'drain in progress'});
        return;
    }
    socket._sealedDraining.add(identity);
    Promise.resolve(server.store.dequeue(realmId, 'sealed:' + identity, identity))
        .then(function (entries) {
            entries = entries || [];
            var batch = entries.slice(0, Constants.SEALED_REPLAY_BATCH);
            var replayed = 0, dead = 0, pending = 0;
            // Sequential: preserves ratchet order, keeps ≤1 message in flight.
            var chain = Promise.resolve();
            batch.forEach(function (entry) {
                chain = chain.then(function () {
                    if (socket.disconnected) { pending++; return; }
                    var payload = Object.assign({queue_id: entry.id}, entry.message);
                    return new Promise(function (resolve) {
                        socket.timeout(sealedReplayAckTimeoutMs).emit('SEALED_MESSAGE', payload, function (err, resp) {
                            // socket.io timeout(): err set on timeout/disconnect.
                            if (err) { pending++; return resolve(); }
                            resp = Array.isArray(resp) ? resp[0] : resp;
                            if (resp && resp.ok === true) {
                                replayed++;
                                server.store.ack(entry.id).catch(function (e) {
                                    server.logger.error('SEALED_SUBSCRIBE ack failed: ' + e.message);
                                }).then(resolve);
                            } else {
                                dead++;
                                deadLetterMessage(realmId, entry.id,
                                    'client refused sealed blob' + (resp && resp.message ? ': ' + String(resp.message).slice(0, 200) : ''))
                                    .then(resolve, resolve);
                            }
                        });
                    });
                });
            });
            return chain.then(function () {
                socket._sealedDraining.delete(identity);
                if (callback) callback({ok: true, replayed: replayed, dead: dead, pending: pending,
                    more: entries.length > batch.length || pending > 0});
            });
        })
        .catch(function (e) {
            socket._sealedDraining.delete(identity);
            server.logger.warn('SEALED_SUBSCRIBE replay failed: ' + e.message);
            if (callback) callback({ok: false, code: 500});
        });
    return;
}
// (existing legacy emit+immediate-ack path stays below, unchanged)
```
  Notes for the implementer: `deadLetterMessage` already exists (~line 3217) and falls back to `store.ack` when the backend lacks a DLQ. Verify the actual `socket.timeout().emit` ack-callback arg shape on socket.io 4.8 (`(err, ...args)`) against the installed version before trusting `resp` handling; adjust the unwrap accordingly. Never log `entry.message`/blobs.
- [ ] **Step 4: Run** `node tests/sealed-replay-ack.test.js` → all pass. Then the full suite: `npm test` (or `node tests/run-all.js` — match how existing tests are invoked in package.json) → no regressions.
- [ ] **Step 5: Commit** `feat(sealed): guaranteed-once SEALED_SUBSCRIBE drain (opt-in ack mode)` staging `lib/server.js tests/sealed-replay-ack.test.js` by name.

### Task 2: JS client — ack plumbing + `sealedSubscribe({ack:true})`

**Files:**
- Modify: `/data/tyolab/node/tyo-mq-client/lib/subscriber.js` (SEALED_MESSAGE listener ~line 400; `sealedSubscribe` ~line 503)
- Test: `/data/tyolab/node/tyo-mq/tests/sealed-replay-ack-client.test.js` (new — lives in the broker repo where the real-broker harness is)

- [ ] **Step 1: Write failing test**: subscriber with `onSealedMessage` set; queue 3 sealed messages; `sealedSubscribe(identity)` drains all 3 through `onSealedMessage` with the broker's ack-mode active (verify inbox empty after, and that an `onSealedMessage` that THROWS on one message routes it to the DLQ, not back to the queue).
- [ ] **Step 2: Run it** → fails (client never sends `ack:true` nor answers acks).
- [ ] **Step 3: Implement** in `subscriber.js`:
  - Listener: replace the SEALED_MESSAGE handler body with an ack-aware one —

```js
subscriber.socket.off('SEALED_MESSAGE');
subscriber.socket.on('SEALED_MESSAGE', function (payload, serverAck) {
    var done = typeof serverAck === 'function' ? serverAck : function () {};
    if (typeof subscriber.onSealedMessage !== 'function')
        return done({ok: false, message: 'no sealed handler'});
    try {
        // Handler may be sync (throw = refuse) or return a Promise.
        Promise.resolve(subscriber.onSealedMessage(payload.blob, payload.msg_id))
            .then(function () { done({ok: true}); },
                  function (e) { done({ok: false, message: e && e.message}); });
    } catch (e) {
        done({ok: false, message: e && e.message});
    }
});
```
  - `sealedSubscribe`: `return this._sealedEmit('SEALED_SUBSCRIBE', { identity: identity, ack: true }, callback);` and update its JSDoc (at-least-once, `{replayed, dead, pending, more}`).
- [ ] **Step 4: Run** the new test + the broker repo's existing sealed tests (they use this client via `tyo-mq-client`; if the broker repo resolves the client from npm rather than the sibling checkout, `npm link`/`file:` the sibling for the test run and note it in the commit).
- [ ] **Step 5: Commit** both repos: client `feat(sealed): ack-mode drain (guaranteed-once) in sealedSubscribe + listener`; broker repo test `test(sealed): client-driven ack-mode drain coverage`.

### Task 3: Broker — per-recipient inbound cap (+ countQueued on Redis)

**Files:**
- Modify: `lib/storage/redis.js` (ADD `countQueued`), `lib/storage/sqlite.js`, `lib/storage/memory.js` (optional `event` filter), `lib/server.js` (SEALED_DELIVER offline path ~line 6151), `lib/limits.js` (default for `max_queued_per_recipient`)
- Test: `tests/sealed-recipient-cap.test.js` (new) + extend the storage backend tests if a shared storage test file exists

- [ ] **Step 1: Write failing tests**: (a) storage-level — `countQueued(realm)` and `countQueued(realm, event)` correct on memory + sqlite + (if a test Redis is available in the harness — check how `tests/` exercise RedisStore; if only via mock/optional, cover redis with the same optional pattern) redis; (b) behaviour — recipient in `unrestricted` mode, cap set low (e.g. 3 via realm limits config the way `tests/limits.test.js` does): 4th offline SEALED_DELIVER → `{ok:false, code:507, message:'recipient inbox full'}`; a DIFFERENT identity in the same realm still queues fine; metric `tyo_mq_rate_limited_total{reason:'max_queued_per_recipient'}` increments.
- [ ] **Step 2: Run** → fail.
- [ ] **Step 3: Implement**:
  - `redis.js`: `RedisStore.prototype.countQueued = function (realm, event) { ... }` — with `event`: `ZCARD` of `this._indexKey(realm, event, consumer)`… note the index key includes consumer; for sealed the consumer IS the identity and event is `'sealed:'+identity`, so pass both from the caller: implement as `countQueued(realm, event, consumer)` optional-args going most-specific ZCARD; without args fall back to scanning realm message keys ONLY if cheap — if not cheap, return `Promise.resolve(null)` for the unscoped realm-wide count and make the server treat `null` as "cannot count → skip that check" (preserves today's Redis behaviour explicitly instead of silently).
  - `sqlite.js`/`memory.js`: accept optional `(realm, event, consumer)` and filter accordingly (SQL: `AND event = ?` / `AND consumer = ?` when present).
  - `server.js` SEALED_DELIVER offline path: before `doSealedEnqueue`, alongside the existing realm-wide check, add
    `var maxPerRecipient = limiter.enabled() ? limiter.value(to.realm, 'max_queued_per_recipient') : Infinity;` and when finite, `store.countQueued(to.realm, 'sealed:' + to.identity, to.identity)` → `>= cap` → 507 `'recipient inbox full'` + metric. Keep both checks in one promise chain; a `null` count skips only that check.
  - `limits.js`: register the `max_queued_per_recipient` key with default `1000` following exactly how `max_queued_per_realm` is declared.
- [ ] **Step 4: Run** new tests + `tests/limits.test.js` + storage/phase2-persistence tests → green.
- [ ] **Step 5: Commit** `feat(sealed): per-recipient inbound cap + event-scoped countQueued (adds Redis countQueued)`.

### Task 4: JS client — `_sealedEmit` timeout + disconnect guard

**Files:**
- Modify: `/data/tyolab/node/tyo-mq-client/lib/subscriber.js` (`_sealedEmit` ~line 432)
- Test: in tyo-mq-client's own test setup if one exists (check `package.json test` script); otherwise `tests/sealed-emit-timeout.test.js` in the broker repo against a socket that never acks

- [ ] **Step 1: Failing test**: `_sealedEmit` against a server with the handler removed (or a socket.io server that swallows the event) rejects within ~15s (use a shortened override for the test), and rejects immediately on `disconnect` mid-wait.
- [ ] **Step 2: Run** → hangs/fails.
- [ ] **Step 3: Implement**: use the client socket.io's own `timeout()` if the bundled socket.io-client is ≥4.4 (check `tyo-mq-client/package.json`): `self.socket.timeout(Subscriber.EMIT_ACK_TIMEOUT_MS).emit(event, payload, function (err, response) {...})` with `Subscriber.EMIT_ACK_TIMEOUT_MS = 15000` (overridable static). If the bundled client is older, hand-roll: `setTimeout` reject + a one-shot `disconnect` listener that rejects, both cleared on ack. Keep the promise/callback dual API exactly as now.
- [ ] **Step 4: Run** tests → green; also re-run Task 2's drain test (drain loop must still work with the timeout wrapper).
- [ ] **Step 5: Commit** `fix(sealed): _sealedEmit timeout + disconnect rejection (no eternal hangs)`.

### Task 5: Kotlin — ack-mode receiver (tyo-mq-client-java + secure-chat)

**Files:**
- Modify: `/data/tyolab/java/tyo-mq-client-java` — `MqSocket` (surface the trailing `io.socket.client.Ack` arg in `onEvent`)
- Modify: `/data/tyolab/misc/secure-chat/android/securechat/src/main/kotlin/au/com/tyo/securechat/TyoMqReceiver.kt` (~line 39 listener + the drain call that emits SEALED_SUBSCRIBE)
- Test: extend the existing JVM sealed round-trip test (spawned-broker) in secure-chat android

- [ ] **Step 1: Failing test** (elitebook1 or local JVM if the harness runs here — same harness as `TyoMqSealedRoundTripTest`): queue 2 sealed messages for an offline identity, connect + drain with ack mode; assert both arrive AND a broker-side re-drain reports 0 (i.e. the client's acks actually deleted them).
- [ ] **Step 2: Implement**: `MqSocket.onEvent` handler signature gains the ack: socket.io-client-java passes it as the LAST element of `args` when the server requests one (`args.last() as? io.socket.client.Ack`). `TyoMqReceiver`: on SEALED_MESSAGE, run `chatCore.handleIncomingSealed(...)`; on success `ack?.call(JSONObject(mapOf("ok" to true)))`, on `ChatException` `ack?.call(JSONObject(mapOf("ok" to false, "message" to (e.message ?: ""))))`. Drain call: add `"ack": true` to the SEALED_SUBSCRIBE payload and keep looping while `more`.
- [ ] **Step 3: Run** the JVM suite via the established elitebook1 flow (see secure-chat `android/scripts/`, TYO_MQ_BROKER_DIR/TYO_MQ_NODE env) → green.
- [ ] **Step 4: Commit** both repos (client-java first, then secure-chat), message `feat(android): ack-mode sealed drain (guaranteed-once)`. **Then announce the secure-chat SHA in the `secure-chat` agent room for Hilia re-pin.**

### Task 6: Swift — ack-mode receiver (secure-chat apple/)

**Files:**
- Modify: `/data/tyolab/misc/secure-chat/apple/Sources/SecureChat/TyoMqClient.swift` (`on` — deliver the `SocketAckEmitter`), `TyoMqReceiver.swift` (~line 40 listener + drain)
- Test: extend the macOS-host sealed round-trip suite (spawned broker) on devmac

- [ ] **Step 1: Failing test**: same shape as Task 5 (2 queued messages → ack drain → broker re-drain reports 0).
- [ ] **Step 2: Implement**: socket.io-client-swift handlers get `(data, SocketAckEmitter)`; `TyoMqClient.on` currently drops the emitter — pass it through (add an overload to avoid breaking existing callers). `TyoMqReceiver`: reply `ack.with(["ok": true])` / `ack.with(["ok": false, "message": ...])` after `handleIncomingSealed`. `SocketAckEmitter` no-ops when the server didn't request an ack, so replying unconditionally is safe. Drain adds `"ack": true`.
- [ ] **Step 3: Run** `swift test` on devmac (rsync flow per `apple/scripts/`, re-run build-core if `--delete` wiped libs) → green.
- [ ] **Step 4: Commit** `feat(ios): ack-mode sealed drain (guaranteed-once)`.

### Task 7: Version bump + deploy (GATED on Eric)

- [ ] Bump tyo-mq to 1.2.x? — NO: freemq already runs a 1.2.0 line (notify). Read `package.json` on master, bump patch/minor consistently with what's deployed, update CHANGELOG if present.
- [ ] `git push` tyo-mq + tyo-mq-client (+ npm publish of tyo-mq-client if the TW deploy flow consumes it from npm — check how `/home/dev/tyo-mq/node_modules/tyo-mq-client` got there before assuming).
- [ ] **Ask Eric before deploying** to the TW VMs (git pull + systemd restart, the flow used for the TTL change). Smoke: drain a test identity's inbox on trymq realm with the new JS client.
- [ ] Update wiki ([[tyo-mq-wiki]] rule) + GAPS.md follow-ups list (remove #39/#40/#41 items) + task list.

---

## Self-review notes

- Spec deviation (constants location) documented in the header.
- `resp` unwrap in Task 1: socket.io's `timeout().emit` callback delivers `(err, ...ackArgs)` — the code handles both array/scalar; implementer MUST verify against installed 4.8.x behaviour (step-3 note).
- Redis `countQueued` design accounts for the index-key-includes-consumer reality; unscoped realm-wide count on Redis stays unsupported-but-now-explicit (`null` → skip), matching current silent behaviour without pretending.
- Kotlin/Swift tasks reuse existing spawned-broker suites rather than inventing new harnesses.
