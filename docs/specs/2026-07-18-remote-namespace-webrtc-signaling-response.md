# Response: /remote WebRTC signaling relay — shipped

**Date:** 2026-07-18
**Status:** Implemented and deployed
**Answers:** `2026-07-18-remote-namespace-webrtc-signaling.md` (tyoman WebRTC Tier 2)
**Shipped in:** tyo-mq **v0.14.3** (relay), **v0.15.0** (namespace plugin follow-up) — both live on mq.tyo.com.au

## What you asked for — done

All six events now relay exactly as specified, with the requested role
guards and directions:

| Event | Guard | Relayed to |
|---|---|---|
| `rtc.offer` | agent | viewers |
| `rtc.answer`, `rtc.ready` | viewer | agent |
| `rtc.ice` | either | the opposite role |
| `input.sas`, `remote.setmonitor` | viewer | agent |

Payloads are opaque JSON relayed verbatim (no base64 handling — that stays
`frame`-only). Auth, tickets, rooms, and the existing frame/input paths are
unchanged. No tyoman client or ticket changes are needed, as your spec
assumed.

## One deliberate difference from the suggested implementation

Rather than six more hardcoded handlers, the namespace now runs a
**rule-table relay with a catch-all**: any event with no explicit rule is
forwarded to the opposite role's room automatically (reserved control
events excepted, so `auth_ok`/`auth_error` cannot be forged). Practical
consequence for tyoman: **the next event you invent will just work** — no
tyo-mq release, no silent dropping, ever again. If you need a restricted
direction for a future event (like `input.*`), it's one entry in the
server's hot-reloadable `remote.relay` settings block, no deploy.

Since 0.15.0 the same is true one level up: whole new namespaces can be
attached from your own module via the `namespaces` setting
(`attach(io, options, context)` — `/remote` itself is the reference
implementation), so future surfaces need no tyo-mq changes either.

## Verification status

Server-side behavior is covered by 12 new automated tests (directions,
role guards, forgery protection, catch-all, config modes) — all green, and
the full 124-test suite passes. The end-to-end acceptance from your spec
(§Acceptance 1–5: agent log `webrtc peer created on viewer rtc.ready` →
`rtc.offer`, `chrome://webrtc-internals` showing the DataChannels and a
host/srflx candidate pair, frame egress leaving the relay, SAS +
monitor-switch reaching the agent) **remains for the tyoman side to run**
against the deployed server — it needs your real agent + viewer pair.
Please report back if any of the five steps fails.

## Notes for your implementers

- Re-sends of `rtc.ready` on reconnect are safe (your spec's assumption
  holds — the relay is stateless about it).
- Acknowledgement callbacks on emits are stripped by the relay; don't
  expect acks across it.
- Multi-argument emits relay intact.
- Full relay documentation: the repo wiki's **Remote Namespace** page;
  namespace plugins: **Custom Namespaces**.
