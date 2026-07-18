# Plan: generic /remote relay + pluggable namespaces

**Date:** 2026-07-18
**Status:** Plan — answers `docs/specs/2026-07-18-remote-namespace-webrtc-signaling.md`
**Components:** `lib/remote-namespace.js`, `lib/server.js`, settings

## Design goal

The spec asks for six more relay handlers. Adding them as literal handlers
would unblock tyoman today and guarantee the same outage next time: any new
event name is silently dropped until a tyo-mq release ships. Since the
relay is content-agnostic by design (opaque payloads, two authenticated
parties, room-scoped), the right shape is:

> **New relay events must never require a tyo-mq code change again, and new
> namespaces must be attachable without touching tyo-mq core.**

Three phases. Phase 1 alone satisfies the spec and the "never again for
events" goal; Phase 2 covers "further namespaces"; Phase 3 makes simple
future namespaces pure configuration.

---

## Phase 1 — config-driven relay + catch-all (unblocks tyoman, 0.14.x)

Replace the per-event handlers in `lib/remote-namespace.js` with a **relay
rule table** plus a **catch-all**:

```js
// Built-in rules — the current events plus the six from the spec.
var DEFAULT_RELAY = {
    'frame':             {from: 'agent',  to: 'viewers', binary: true},
    'input.mouse':       {from: 'viewer', to: 'agent'},
    'input.keyboard':    {from: 'viewer', to: 'agent'},
    'input.sas':         {from: 'viewer', to: 'agent'},
    'remote.setmonitor': {from: 'viewer', to: 'agent'},
    'rtc.offer':         {from: 'agent',  to: 'viewers'},
    'rtc.answer':        {from: 'viewer', to: 'agent'},
    'rtc.ready':         {from: 'viewer', to: 'agent'},
    'rtc.ice':           {from: 'any',    to: 'opposite'}
};
```

Rule fields: `from` (`'agent' | 'viewer' | 'any'` — sender role guard),
`to` (`'agent' | 'viewers' | 'opposite'` — destination room), `binary`
(base64→Buffer decode, `frame` only), `enabled: false` (drop).

**Catch-all** (`socket.onAny`): an authenticated socket emitting an event
with no rule gets the **opposite-role relay** (`agent → viewers`,
`viewer → agent`) — payload forwarded verbatim. This is what makes the
namespace future-proof: `rtc.restart`, `clipboard.set`, whatever comes
next, just works. Guards:

- **Reserved names are never relayed**, listed and unoverridable: `auth`,
  `auth_ok`, `auth_error`, `disconnect`, `disconnecting`, plus socket.io
  internals. (Prevents a viewer forging server-emitted control events at
  the agent.)
- Only after `auth` (`socket.remoteSession` set) — unchanged.
- Room scoping is unchanged, so cross-session/cross-realm isolation holds
  exactly as today.

**Configuration** (settings file / constructor, hot-reloadable):

```json
"remote": {
  "relay": {
    "clipboard.set": {"from": "viewer", "to": "agent"},
    "input.sas":     {"enabled": false}
  },
  "relay_unlisted": "opposite"
}
```

- `remote.relay` merges over `DEFAULT_RELAY` — operators can add, restrict,
  or disable events with no code change.
- `remote.relay_unlisted`: `"opposite"` (default) or `"off"` for operators
  who want an explicit allow-list.

Why catch-all defaults ON: the two-party session was authenticated with
one-time tickets precisely so the channel could be trusted end-to-end; the
relay never interprets payloads; and "silently drop unknown events" is the
bug this spec exists to fix. `"off"` remains one line of settings away.

**Tests** (`tests/remote-namespace.test.js`): the six spec events relay in
the right directions; role guards reject (viewer-sent `rtc.offer` dropped,
`rtc.ice` routes by sender role); an unlisted event relays opposite-role
both ways; reserved names never relay; `relay_unlisted: "off"` drops
unlisted; settings can disable a built-in and add a custom rule; existing
frame/input behavior byte-identical.

**Acceptance:** the spec's own five verification steps, run against a
deployed mq.tyo.com.au with the tyoman WebRTC viewer/agent.

Estimated size: ~60 lines net in `remote-namespace.js` (it shrinks), plus
tests. Ships as 0.14.3; deploy = pm2 restart, no client or ticket changes.

---

## Phase 2 — pluggable namespaces (0.15.x)

For "further namespaces", copy the proven **custom storage backend**
pattern (`storage: 'custom'` + module path):

```json
"namespaces": {
  "/collab": {"module": "./namespaces/collab.js", "options": {"max_rooms": 100}},
  "/telemetry-fanout": {"module": "@tyolab/mq-ns-fanout"}
}
```

Module contract (mirrors what `attachRemoteNamespace` already looks like):

```js
// module.exports = function attach(io, options, context) -> api | undefined
//   io       — the socket.io server (module calls io.of('/name') itself)
//   options  — the per-namespace options block, verbatim
//   context  — {name, logger, settings (read-only), issueTicket?}
```

- Loaded at `create()` (path resolution + error isolation identical to the
  custom store: a broken module logs and is skipped, never crashes boot).
- Hot-reload semantics: namespaces present in settings at boot attach;
  adding one via settings reload attaches it live; removal requires a
  restart (documented — socket.io can't cleanly detach a namespace).
- The returned api is exposed as `server.namespaces['/collab']` (the way
  `server.remote` works today).
- **Refactor `/remote` into the first bundled plugin** under the same
  contract — zero behavior change, and the contract is proven by its own
  reference implementation rather than invented speculatively.
- `get` management command lists attached namespaces (name + module) for
  observability.

After Phase 2, a product team needing a new namespace writes one file in
*their* repo and one settings entry — tyo-mq core is untouched.

---

## Phase 3 (later, only if demand appears) — declarative relay namespaces

Most conceivable namespaces are "ticketed N-party relay with roles" — the
/remote shape generalized. A config-only factory would remove even the
module file:

```json
"namespaces": {
  "/support-session": {
    "type": "relay",
    "roles": {"host": {"max": 1}, "guest": {"max": 8}},
    "relay": {"screen": {"from": "host", "to": "guest"}},
    "relay_unlisted": "opposite",
    "tickets": {"ttl_ms": 60000}
  }
}
```

Defer until a second real consumer shows up — Phase 2's module contract
already covers it, and guessing the role/room model generality now risks
baking in the wrong abstraction.

---

## Explicitly out of scope

- Cluster-aware /remote (tickets and rooms are per-node today; unchanged).
- WebRTC itself (TURN, SDP munging) — the relay stays a dumb signaling bus.
- Payload validation beyond role guards — endpoints own their schemas (as
  the spec states).

## Sequencing

1. **Phase 1 now** — tyoman is blocked on it; it is also the smallest
   change (the file gets simpler, not bigger).
2. Verify with tyoman Tier-2 acceptance, deploy to tw, wiki update
   ([[Remote Namespace]] page: relay table, catch-all, settings).
3. **Phase 2 next minor** — includes the /remote-as-plugin refactor.
4. Phase 3 parked.
