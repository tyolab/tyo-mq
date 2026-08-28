# TYO Notify — actionable notifications + reply topics — design

- **Date:** 2026-08-28
- **Status:** Implemented (broker + CLI). App half: tyonotify repo plan.
- **Builds on:** `docs/specs/2026-08-20-tyo-notify-service-design.md` (the base
  Notify surface and its ntfy wire-compat commitment) and
  `docs/specs/2026-08-26-tyo-notify-private-topics-design.md` (claim /
  signed reads / bearer publish — reply topics are just private topics used
  by machines). App side builds on the tyonotify Android app
  (`/data/tyolab/android/projects/tyonotify`, private-topic support shipped
  2026-08-27).
- **Motivating use case (reference example, NOT integrated in this scope):**
  the owner's daily security-scan pipeline currently posts findings to a
  Telegram bot unconditionally. With this feature, a future pipeline of that
  shape publishes an alert to a private topic with **Approve / Reject**
  buttons; the phone's button-tap publishes the decision to a *reply topic*
  the pipeline listens on; the pipeline posts to Telegram only on Approve.
  The existing Telegram script is explicitly untouched.

## 0. The idea in one paragraph

A topic is already a lightweight chatroom: publishers speak, subscribers get
notified. This feature adds two things. (1) **Actionable messages**: a
published message can carry ntfy-format `actions` — buttons the phone renders
on the notification and on the in-app message card; an `http` action fires a
pre-baked HTTP request when tapped. (2) **Headless participants**: a small
CLI so a script can claim a private topic, publish actionable alerts, and
listen (signed) for replies. A "reply topic" is not a new primitive — it is
an ordinary private topic whose publish token rides *inside the alert's
action buttons*, so the phone can speak back to the pipeline with one tap.
Zero new broker protocol; composition of what already shipped.

## 1. Message schema — ntfy `actions` (subset, relaxed count)

A published message MAY carry an `actions` array. Wire format is exactly
[ntfy's published actions format](https://docs.ntfy.sh/publish/#action-buttons)
so existing ntfy clients parse our messages (they render their first 3):

```json
{
  "topic": "scan-alerts",
  "message": "3 network-gear CVEs found. Post digest to Telegram?",
  "title": "Security scan",
  "actions": [
    { "action": "http",  "label": "Approve", "url": "https://freemq.tyo.com.au/notify/scan-replies",
      "method": "POST", "headers": {"Authorization": "Bearer <reply-token>"}, "body": "approve" },
    { "action": "http",  "label": "Reject",  "url": "https://freemq.tyo.com.au/notify/scan-replies",
      "method": "POST", "headers": {"Authorization": "Bearer <reply-token>"}, "body": "reject" },
    { "action": "view",  "label": "Details", "url": "https://..." }
  ]
}
```

**v1 action types:** `http` (fire a request from the phone) and `view` (open
a URL). `broadcast` (Android intents) is a non-goal.

**Counts** (owner decision): broker cap **6 actions** per message — laxer
than ntfy's 3 but format-identical. The notification shade renders the
**first 3** (hard Android platform limit — order the important ones first);
the in-app message card renders **all**.

**Validation (broker, fail-loud):** publish is rejected 400 — not silently
stripped — when `actions` is malformed: more than 6 entries; unknown
`action` type; missing `label`/`url`; **non-https URL**; `method` outside
GET/POST/PUT/DELETE; or over the length caps (label ≤ 64, url ≤ 2048, body ≤
1024, headers ≤ 8 entries of ≤ 256 each — bounded like every other Notify
field so the ring and FCM payloads stay small). A pipeline must find out its
buttons are broken at publish time, not from silence.

## 2. Broker changes (small)

- `lib/notify.js buildMessage`: accept + validate + pass through `actions`;
  the ring, SSE/json subscribers, and polls all carry it (plain ntfy wire
  format — no consumer changes needed).
- **Publish forms:** JSON form only (`POST /notify` or path form with a JSON
  content-type carrying `{topic?, message, actions, ...}` — implementation
  picks the cleanest fit with the existing dual-form parsing). ntfy's compact
  `Actions:` *header* grammar is deferred (fiddly; pipelines publish JSON).
- **Push delivery:** `wake` mode needs nothing (the app fetches the full
  message — actions included; wake is the RECOMMENDED mode for actionable
  messages). `content` mode: actions ride the FCM data payload when the
  total stays under the 4KB cap (measured in BYTES — FCM's limit is bytes,
  and multibyte content can be ~2x its char count); when they don't fit, the
  broker **automatically downgrades that one push to wake** so button
  fidelity is never silently lost. Publisher note: a downgraded wake tells
  the app to fetch from the ring, so do NOT combine actionable content-mode
  messages with `Cache: no` (which skips the ring) — that combination can
  yield a wake with nothing to fetch.

## 3. App changes (tyonotify Android)

- **Notification shade:** up to 3 `NotificationCompat.Action` buttons.
  Tapping an `http` action fires the request on a background thread (no UI),
  then updates the notification in place ("Approved ✓" / "Failed — tap to
  retry"). `view` opens the browser.
- **In-app message card** (owner's option B — actions must outlive the
  notification): cards for messages with actions render ALL the buttons; the
  app stores a local per-(message id, action) "responded" state so a handled
  card shows the chosen outcome instead of live buttons. An approval stays
  actionable until dealt with, then shows what you chose. Local state only —
  no server-side tracking (see §6).
- **Safety:** https-only re-enforced app-side; a button tap is explicit user
  consent (ntfy's own precedent, even on public topics). Docs advise that
  action buttons carrying reply tokens belong on **private** alert topics —
  anyone who can read the alert can press its buttons.

## 4. Headless participant CLI — the machine-side enabler

New `bin/notify-cli.js` in the tyo-mq repo, reusing the broker's own
`lib/notify-auth.js` (zero new dependencies):

- `keygen` — EC P-256 keypair as PEM under `~/.config/tyo-notify/` (0600).
- `claim <topic>` — claims a private topic; prints the publish token once.
- `publish <topic>` — bearer publish; `--title/--priority/--push`;
  `--action 'http|Approve|<url>|POST|<body>'`-style flags (or `--actions-json`).
- `listen <topic>` / `poll <topic>` — signed reads (`--json` for scripting);
  `listen` follows SSE with per-reconnect tickets.

A pipeline then needs ~5 lines: claim its reply topic once; per alert,
publish with Approve/Reject actions carrying the reply token; `listen` for
the answer; act. The reply body's *meaning* ("approve"/"reject"/JSON) is the
pipeline's own convention — it owns both ends; no enforced schema; the
security-scan→Telegram case is the documented example.

## 5. Threat model deltas

| Adversary | Goal | Defense |
|---|---|---|
| Reader of a public topic carrying actions | Make the phone fire arbitrary requests | https-only + explicit button tap (no auto-fire); advisory: reply tokens only on private topics |
| Whoever obtains the alert content | Press Approve themselves | The alert topic being PRIVATE is the boundary — same trust as reading the alert at all; token grants publish-to-reply-topic only |
| Malicious/oversized actions payload | Bloat ring/FCM, break rendering | Count + length caps, 400 on violation, content→wake downgrade |
| Replay of a tapped action | Duplicate approvals | Pipeline-side concern by design (it owns reply semantics — dedupe/timeout there; see §6) |

## 6. Deliberately out of scope

Server-side response tracking / single-response enforcement (workflow state
stays out of the relay — same layering rule as the sealed-reporting design),
reply timeouts/dedupe/defaults (pipeline-side), ntfy `Actions:` header
grammar, `broadcast` actions, iOS (same wire format, rides later), and any
change to the existing security-scan/Telegram script.

## 7. Testing

- Broker: validation unit tests (caps, types, https, 400s) + integration
  (publish-with-actions → poll/SSE round-trip; oversized-actions rejection;
  content→wake downgrade).
- App: JVM tests for action parsing/validation + responded-state store;
  on-device manual pass (shade buttons, card buttons, retry path).
- CLI: unit tests against a local broker (keygen/claim/publish/poll).
- End-to-end (the acceptance test): CLI claims a reply topic → publishes an
  actionable alert to a private topic → phone renders buttons → tap →
  CLI's `listen` receives the reply. The full loop, live.
