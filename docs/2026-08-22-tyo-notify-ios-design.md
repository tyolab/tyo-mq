# TYO Notify for iOS — design

**Date:** 2026-08-22
**Status:** Approved. **P0 (broker APNs content push) implemented** on branch `feat/broker-apns-notify-content` — see `docs/2026-08-22-broker-apns-notify-content-plan.md`. iOS app (P1–P4) plan pending.
**Author:** eric@tyo.com.au (with Claude)
**Related:** [Android app](../../../android/projects/tyonotify) · broker Notify surface (`lib/server.js` `/notify/*`, `lib/push.js`) · `docs/2026-08-07-ntfy-http-pubsub-design.md`

A native iOS client for the public **TYO Notify** service (ntfy-compatible
publish/subscribe over `/notify/{topic}`), at **feature parity** with the
shipped Android app. Background delivery on iOS is **APNs-only** — Apple does
not permit an app to hold a persistent background connection, so the Android
"live connection" (SSE foreground service) has no iOS equivalent.

---

## 1. Scope (v1 — full parity)

- Subscribe to topics (freemq default server; custom/self-hosted servers supported).
- Receive push per topic in one of three modes: **CONTENT / WAKE / OFF**.
- Per-topic message **history**.
- **In-app compose & publish** to a topic.
- Per-topic **mute** and **minimum-priority** filter.
- Optional **foreground SSE** stream for instant updates while the app is open
  (background remains APNs-only).

Out of scope for v1: attachments/icons, message actions/click-through URLs
beyond opening the app, watch/widget targets, iPad-specific layouts (universal
build is fine, no bespoke iPad UI).

## 2. Platform & project structure

- New **Xcode app, SwiftUI**. Bundle id **`au.com.tyo.notify`**, Apple team
  **GR4ZBUUW77** (TYONLINE TECHNOLOGY PTY. LTD.). Minimum **iOS 16**.
- Intended repo home: **`/data/tyolab/ios/projects/tyonotify`** (new git repo,
  created during P1 scaffolding; mirrors the Android path).
- **App Group** `group.au.com.tyo.notify` so the app and the Notification
  Service Extension share one on-disk store.
- Layered like the Android app:
  - **NotifyCore** — a local Swift package, pure Swift, unit-testable on the
    macOS host (no simulator needed):
    - Models: `Server` (freemq default, `notifyBase()`), `Topic`
      (name, serverId, pushMode, minPriority, muted), `NotifyMessage`
      (id, topic, title, message, priority, time).
    - `NotifyApi` — `URLSession` client: `publish`, `subscribeJson`/`since`,
      `register`, `unregister`. Mirrors Android `NotifyApi`.
    - `NotifyStore` — **Codable JSON** persisted in the App Group container.
      Chosen over SwiftData because it shares cleanly with the extension and
      unit-tests on the host without a simulator.
  - **App target** — SwiftUI views + `AppDelegate` (APNs) + `PushRegistrar`.
  - **Notification Service Extension** — on a CONTENT push, records the
    message into the shared store (so history stays current when delivered in
    the background) and renders the alert.

## 3. Screens

1. **Topics** (home) — subscribed topics with latest message; add button.
2. **Add topic** — name + server picker (freemq default / "use another server"
   URL + optional bearer token) + push mode.
3. **Topic detail** — message history + composer (publish) + settings: mute,
   push mode (CONTENT/WAKE/OFF), minimum priority.
4. **Settings** — notification-permission status, default server, about.

## 4. Delivery mechanics

- **Registration** (`PushRegistrar`, mirrors Android): on subscribe /
  push-mode change, `POST /notify/{topic}/register`:
  ```json
  { "transport": "apns", "token": "<apns device token>",
    "app_id": "notify", "env": "production", "min_priority": 1 }
  ```
  `/unregister` on remove or OFF. (`min_priority` is the new server-side field —
  see §5.)
- **CONTENT** — broker sends an APNs **alert** push (title = topic,
  body = message) → shown instantly, app closed. NSE also records it to history.
- **WAKE** — broker sends a silent `content-available` push → app wakes,
  fetches `/notify/{topic}/json?since=<lastId>`, posts a local notification.
  The deliberate "quiet background sync" mode.
- **OFF** — not registered; no push.
- **Foreground** — while a topic detail (or the app) is open, optionally open
  the `/notify/{topic}/sse` stream for instant updates; closed on background.

## 5. Broker phase (prerequisite — must ship before CONTENT works)

Contained changes to `lib/push.js` / `lib/server.js`, mirroring patterns
already present:

1. **APNs alert payload.** `ApnsTransport` currently hardcodes the contentless
   `{"aps":{"content-available":1}}` background push (`lib/push.js:993-1009`).
   Add: for **CONTENT** mode send `{"aps":{"alert":{"title","body"},"sound":"default"}}`
   with `apns-push-type: alert`, priority 10; keep the contentless background
   push for **WAKE**. Thread the message/title through (already computed for FCM
   by `buildNotifyPayload`, `lib/push.js:1491-1510`).
2. **Per-`app_id` APNs bundle id.** Today `apns-topic` is a single global env
   (`TYO_MQ_PUSH_APNS_TOPIC`). Add `TYO_MQ_PUSH_APNS_TOPICS` = JSON
   `{app_id: bundleId}`; select `apns-topic` by the endpoint's `app_id`,
   falling back to the single value. Mirrors the per-`app_id` FCM-project
   routing (`_projectFor`, `lib/push.js:586`). Lets freemq serve TYO Notify and
   secure-chat APNs with **different bundle ids** on one broker.
3. **Server-side minimum priority.** Store a per-registration `min_priority`
   (register handler `lib/server.js:4364`; endpoint object `lib/server.js:4406`;
   `TokenRegistry` fields `lib/push.js:1315-1324`) and **skip the push** when a
   published message's priority is below it (`deliverNotifyPush`,
   `lib/push.js:1512`). Needed because an NSE cannot fully suppress an alert
   push — the min-priority filter must act server-side to hold parity with
   Android's per-topic minimum priority.
4. Unit tests for each; deploy to **both TW VMs**; verify a real push to a live
   device token (WAKE and CONTENT).

## 6. Apple prerequisites (portal actions — the user's to create)

- Register **App ID `au.com.tyo.notify`** with **Push Notifications** + the
  **App Group** `group.au.com.tyo.notify`.
- Create an **APNs Auth Key (.p8)** → Key ID; team GR4ZBUUW77. The `.p8` +
  Key ID + Team ID + bundle id populate freemq's APNs env
  (`TYO_MQ_PUSH_APNS_KEY` / `_KEY_ID` / `_TEAM_ID` / `_TOPICS`), and `apns`
  is added to `TYO_MQ_PUSH_TRANSPORT`.
- Create the **App Store Connect app record** ("TYO Notify", the bundle id).
- Create an **App Store Connect API key** for automated TestFlight / App Store
  upload.

Secrets handling: the `.p8`, ASC API key, and provisioning assets never enter
git; they live on devmac / freemq only, referenced by path via env.

## 7. Build & release topology

- Build/sign on **devmac** (macOS 26.5, Xcode 26.5; **Apple Distribution** cert
  for the team already installed).
- Automate with **fastlane** (`gym` build, `pilot` TestFlight, `deliver`
  App Store) — install fastlane on devmac; authenticate with the ASC API key.
- `NotifyCore` unit tests run on the host in CI/local; push paths verified
  on a real device (silent pushes don't fire on the simulator).
- Path: internal build → **TestFlight** → App Store review.

## 8. Implementation phases

- **P0 — Broker:** APNs alert payload + per-`app_id` bundle id + server-side
  min-priority; tests; deploy to freemq; real-device push verified.
- **P1 — NotifyCore:** models + API + store; host unit tests; live broker
  round-trip (publish → json).
- **P2 — Push:** APNs registration, `PushRegistrar`, silent-wake fetch, local +
  alert notifications, NSE; on-device WAKE + CONTENT verified.
- **P3 — UI:** the four SwiftUI screens with all parity features (compose/
  publish, min-priority, custom server, mute, push mode).
- **P4 — Release:** ASC record, signing, listing text/screenshots, TestFlight,
  submit for review.

## 9. Decisions & defaults

- **Persistence:** Codable JSON in the App Group container (not SwiftData).
- **Minimum iOS:** 16.
- **CONTENT privacy note:** an alert push carries the message through Apple's
  servers (as FCM content mode already does on Android). Fine for a public
  notify service; WAKE mode keeps message bodies off Apple's push path for
  anyone who wants that.

## 10. Risks / open items

- **freemq APNs env not yet confirmed** (SSH locked down from the dev box).
  Verify at P0 whether `apns` is already in `TYO_MQ_PUSH_TRANSPORT` and with
  which bundle id; the per-`app_id` bundle-id change (§5.2) is required if any
  other iOS app (secure-chat) already uses APNs on freemq.
- **Silent-push throttling** (WAKE mode): Apple rate-limits `content-available`
  background pushes; WAKE is inherently best-effort. CONTENT mode is the
  reliable, immediate path — hence it being a first-class option, not a
  fallback.
- **Apple review:** push-only background usage is unremarkable for a
  notifications app; no special entitlements beyond `aps-environment` + the
  App Group.
