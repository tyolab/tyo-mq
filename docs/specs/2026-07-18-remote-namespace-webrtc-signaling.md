# /remote namespace — relay WebRTC signaling (and the missing input events)

**Date:** 2026-07-18
**Status:** Requirements — for the tyo-mq maintainer to implement
**Component:** `lib/remote-namespace.js`
**Requested by:** tyoman remote-control (WebRTC Tier 2)

## Summary

The `/remote` namespace currently relays only five events (`auth`, `frame`,
`input.mouse`, `input.keyboard`, `disconnect`). tyoman's remote-desktop client
(agent + browser viewer) has added a **WebRTC DataChannel P2P** path whose
signaling rides this same namespace, plus two control events (`input.sas`,
`remote.setmonitor`). None of those event names are handled, so the server
**silently drops them** and the features can't work. This asks for a small set
of additional relay handlers that mirror the existing `frame`/`input.*` pattern.

## Background — why the /remote room is the signaling bus

tyoman streams a remote desktop over `/remote`: the **agent** (the controlled
machine) captures the screen and emits `frame`; the **viewer** (browser)
renders it and emits `input.*`. Each session has exactly two logical parties in
two rooms — `session:{id}:agent` and `session:{id}:viewers` — established at
`auth` time from a one-time ticket (`socket.remoteSession.role` is `'agent'` or
`'viewer'`).

To cut latency (esp. cross-region, e.g. India↔Sydney), the session now
negotiates a **WebRTC DataChannel** and, when it connects, carries the JPEG
frames + input **peer-to-peer** instead of through the Sydney relay, falling
back to the relay when P2P can't be established. WebRTC needs a **signaling
channel** to exchange the SDP offer/answer and ICE candidates before the P2P
link exists — and the already-authenticated, exactly-two-party `/remote` room
is the natural bus for it. That was the design assumption; the namespace was
just never updated to forward those events.

**Nothing about auth, tickets, rooms, or the frame/input paths changes.** These
are additive relay handlers only. The relay is content-agnostic — it forwards
opaque JSON between the two parties; it does not run WebRTC itself.

## Required: additional relayed events

All follow the existing role-guarded, room-targeted pattern. Payloads are
plain JSON objects (NOT base64/binary — unlike `frame`), relayed verbatim.

| Event | Emitted by | Guard (role) | Relay to | Purpose |
|---|---|---|---|---|
| `rtc.offer` | agent | `agent` | `session:{id}:viewers` | SDP offer (agent is the offerer) |
| `rtc.answer` | viewer | `viewer` | `session:{id}:agent` | SDP answer |
| `rtc.ice` | both | any authed | **opposite** role's room | trickle ICE candidates (bidirectional) |
| `rtc.ready` | viewer | `viewer` | `session:{id}:agent` | viewer signals it is connected + subscribed, so the agent emits its offer now (see "the race" below) |
| `input.sas` | viewer | `viewer` | `session:{id}:agent` | secure-attention (Ctrl-Alt-Del) request |
| `remote.setmonitor` | viewer | `viewer` | `session:{id}:agent` | multi-monitor switch request |

### Why `rtc.ready` (the offer/subscribe race)

The agent is the WebRTC offerer. If it emits its one-shot `rtc.offer` the instant
its worker starts, the browser viewer usually hasn't loaded/subscribed yet, so it
misses the offer and P2P never forms. To fix this deterministically, the viewer
emits `rtc.ready` once it has connected, authed, and subscribed; the agent
creates the peer and emits the offer **in response**. So `rtc.ready` must be
relayed viewer→agent for the handshake to start at all. (The agent ignores
repeats once a peer exists, so re-sends on reconnect are safe.)

### Why `rtc.ice` is bidirectional

Both peers gather and trickle their own ICE candidates continuously during
connection setup. Each candidate must reach the *other* party. So `rtc.ice` is
the one event routed by the **sender's role**: from an `agent` socket → viewers
room; from a `viewer` socket → agent room.

## Suggested implementation

Insert alongside the existing handlers in `nsp.on('connection', socket => …)`,
after the `input.keyboard` handler. `socket.remoteSession.role` and
`.session_id` are already populated at `auth`.

```js
// ── WebRTC signaling (agent <-> viewer). Opaque JSON, relayed verbatim. ──
socket.on('rtc.offer', function (data) {
    if (!socket.remoteSession || socket.remoteSession.role !== 'agent') return;
    nsp.to('session:' + socket.remoteSession.session_id + ':viewers').emit('rtc.offer', data || {});
});
socket.on('rtc.answer', function (data) {
    if (!socket.remoteSession || socket.remoteSession.role !== 'viewer') return;
    nsp.to('session:' + socket.remoteSession.session_id + ':agent').emit('rtc.answer', data || {});
});
socket.on('rtc.ready', function (data) {
    if (!socket.remoteSession || socket.remoteSession.role !== 'viewer') return;
    nsp.to('session:' + socket.remoteSession.session_id + ':agent').emit('rtc.ready', data || {});
});
socket.on('rtc.ice', function (data) {
    if (!socket.remoteSession) return;
    var sid = socket.remoteSession.session_id;
    var dest = socket.remoteSession.role === 'agent' ? ':viewers' : ':agent';
    nsp.to('session:' + sid + dest).emit('rtc.ice', data || {});
});

// ── Control events (viewer -> agent) also currently dropped ──
socket.on('input.sas', function (data) {
    if (!socket.remoteSession || socket.remoteSession.role !== 'viewer') return;
    nsp.to('session:' + socket.remoteSession.session_id + ':agent').emit('input.sas', data || {});
});
socket.on('remote.setmonitor', function (data) {
    if (!socket.remoteSession || socket.remoteSession.role !== 'viewer') return;
    nsp.to('session:' + socket.remoteSession.session_id + ':agent').emit('remote.setmonitor', data || {});
});
```

Notes:
- Do **not** base64-decode these (that's specific to `frame`'s binary payload).
- No payload validation is required beyond the role guard; the endpoints validate
  shape. The events are already scoped to the session's two rooms, so there is no
  cross-session or cross-realm leakage.
- Size: SDP offers are a few KB; ICE candidates and the rest are tiny. Volume is a
  short burst at session start, then quiet.

## Acceptance / verification

1. Start a tyoman remote session (human viewer, agent with `webrtc: true`).
2. On the agent, confirm it now proceeds past offer: worker log shows
   `webrtc peer created on viewer rtc.ready` then `→ emit event=rtc.offer`.
3. In the browser (`chrome://webrtc-internals`): an `RTCPeerConnection` forms,
   `rtc.answer` is exchanged, the `frames`+`input` DataChannels open, and the
   selected ICE candidate pair is `host`/`srflx` (P2P).
4. Frame egress switches off the relay (agent worker stops `→ emit event=frame`
   once the DataChannel is open) and the picture keeps rendering.
5. Ctrl-Alt-Del and monitor-switch from the viewer reach the agent.

## Deployment

Ship the change to the running mq.tyo.com.au (pm2 restart / container redeploy).
No settings, tickets, or client changes are needed — the tyoman agent + viewer
already emit and handle all of these events; they are just not being relayed
today.
