# TYO Notify — Android app (v1) — design

- **Date:** 2026-08-20
- **Status:** Design approved; spec for review before planning
- **Depends on:** the broker TYO Notify surface (tyo-mq 1.2.0, LIVE on
  `https://freemq.tyo.com.au/notify/*`) — see
  `docs/specs/2026-08-20-tyo-notify-service-design.md`.
- **Reference app:** the ntfy.sh Android app (UX patterns only).

## Goal

A native Android app that subscribes to TYO Notify topics on a chosen broker
(default `freemq.tyo.com.au`, or a custom one), receives pushes, shows system
notifications, and can publish. It must complete the full loop end-to-end
against the LIVE freemq broker before anything is published to a store.

## Non-goals (v1)

- iOS (freemq has no APNs; a separate spec later).
- Accounts / auth-protected topics / reserved topics (Notify is public today).
- E2EE (the Notify surface is plaintext by design).
- Attachments upload (render/click only; no file upload in v1).

## Decisions (locked)

- **Framework:** the **tyodroid** Java framework (`tyodroid-boilerplate`:
  Controller/App/AppUI/Page/Activity, multi-module with Common* submodules), like
  hilia. New project `/data/tyolab/android/projects/tyonotify`, package
  **`au.com.tyo.notify`**, app label **TYO Notify**.
- **SDK:** bump the boilerplate's `compileSdk`/`targetSdk` **29 → 34** (needed for
  `POST_NOTIFICATIONS` runtime permission + modern notification behavior) and
  `minSdk` **16 → 21** (Firebase Cloud Messaging floor). AndroidX.
- **Push:** **FCM** (Firebase Cloud Messaging). The app registers in the
  **store-tyo-com-au** Firebase project (freemq's default FCM sender), so freemq
  can send to its tokens with no per-app mapping. `google-services.json` +
  google-services plugin (hilia's pattern) + `firebase-messaging` via the BoM.
- **Broker-agnostic:** a global default broker AND a per-subscription server
  override (ntfy's "use another server"). For a broker WITHOUT FCM, an optional
  **always-on (SSE) delivery** mode holds a foreground-service connection.

## FCM provisioning (prerequisite)

Register an Android app **`au.com.tyo.notify`** in Firebase project
**`store-tyo-com-au`** and download `google-services.json` into
`app/`. Done via the firebase/gcloud CLI if authed, else a short runbook for the
owner. Non-secret facts to record: project `store-tyo-com-au`, the app's `appId`,
package `au.com.tyo.notify`. (freemq already holds the matching sender SA
`fcm-service-account.json`.)

## Architecture

tyodroid `App`/`Controller`/`AppUI`/Pages + a focused, unit-testable Notify layer
(plain Java, no Android deps where possible so it tests on the JVM):

| Unit | Responsibility | Depends on |
|---|---|---|
| `Server` (model) | `{ id, baseUrl, label, authToken?, headers? }`. Default = freemq. | — |
| `Topic` (model) | `{ name, serverId, deliveryMode(FCM\|SSE), pushMode(content\|wake), muted, minPriority, channelId }`. | Server |
| `NotifyMessage` (model) | ntfy-shaped `{ id, time, topic, message, title, priority, tags[], click, content_type }`. | — |
| `NotifyApi` | Server-scoped HTTP client (OkHttp): `publish`, `poll(since)`, `register`, `unregister`. Pure I/O, mockable. | Server |
| `TopicStore` | Persistence (Room): servers, topics + settings, cached recent messages; observable lists for the UI. | models |
| `PushRegistrar` | Get FCM token; `(topic,server)` register/unregister; re-register all on `onNewToken`/add. | NotifyApi, TopicStore |
| `NotifyMessagingService` | `FirebaseMessagingService`: parse `data` (`type:notify`; content vs `wake:1`), honor mute/min-priority/pushMode; post to the priority channel; wake → `poll` then notify; deep-link tap. | TopicStore, NotifyApi, Notifier |
| `Notifier` | Build/post notifications; manage per-priority channels; tags→emoji; click/attachment actions. | — |
| `SseService` | Foreground service holding `/sse` connections for `deliveryMode=SSE` topics (custom/FCM-less brokers). | NotifyApi, Notifier |

Screens (tyodroid Pages/Activities):
- **Dashboard** — list of subscriptions (topic, server label, last message, unread,
  muted icon); FAB → Add topic; overflow → Settings. Optional message bar to
  publish to a selected topic.
- **Topic detail** — recent messages (from `poll` + cache) with a **live SSE
  view while open**; per-topic settings (delivery mode, content/wake, mute,
  min-priority); a **send/publish** box; share entry point.
- **Add topic** — topic name + **server picker** (default freemq, or "Use another
  server" → custom baseUrl + optional token/headers; remembers recent servers);
  delivery mode (auto: FCM if the server supports it, else SSE). Also reached via
  **share-to-subscribe** (open `https://…/notify/{topic}`).
- **Settings** — **default broker** (freemq / custom), default push mode, default
  delivery mode, theme, notification defaults, advanced (custom headers).

## Broker/server model (the setting you asked for)

- **Global default broker** in Settings: `https://freemq.tyo.com.au` out of the
  box; editable to any custom TYO Notify broker (URL + optional bearer/headers).
- **Per-topic server override**: each subscription stores its `serverId`, so
  different topics can live on different brokers. `NotifyApi`/`PushRegistrar` are
  always constructed for a specific `Server`.
- **Delivery mode per topic:** `FCM` (default; battery-friendly) or `SSE`
  (always-on foreground service) for brokers without an FCM sender. The Add flow
  defaults to FCM for freemq and offers SSE for custom servers.

## Payload contract (what the app parses)

freemq's FCM `data` message from `buildNotifyPayload`:
`{ type:"notify", v:"1", topic, id, message?, title?, priority?, tags?(csv),
click?, wake?("1") }`. If `wake:"1"` (contentless), the app fetches the latest
via `GET {base}/notify/{topic}/json?poll=1&since=<lastSeenId|all>` then notifies;
otherwise it notifies directly from the payload. Registration body:
`{ transport:"fcm", token:<fcmToken>, app_id:"notify" }` →
`POST {base}/notify/{topic}/register`.

## Notifications

- One channel per ntfy priority: min→IMPORTANCE_MIN … urgent/max→IMPORTANCE_HIGH
  (+ default). `minPriority` per topic filters below-threshold messages.
- Tags rendered as emoji (shortcode map, fallback to `#tag`). `click` → tap
  opens the URL; default tap → Topic detail deep link. `POST_NOTIFICATIONS`
  requested at first subscribe (API 33+).

## Testing

- **JVM unit tests** (no device): `NotifyApi` against a mock HTTP server
  (publish/poll/register), payload parsing (content vs wake, tags csv, priority),
  `TopicStore` CRUD + settings, priority→importance mapping, min-priority filter.
- **Instrumented/manual E2E** on an emulator with Google Play services, against
  **live freemq**: (1) add a topic → registration 200; (2) `curl` publish
  content → notification appears with title/priority/tags → tap → Topic detail
  shows it; (3) publish `?push=wake` → app fetches via poll then notifies with no
  content in the push; (4) live SSE view updates while the topic is open;
  (5) kill+relaunch → token refresh re-registers; (6) custom-server topic in SSE
  mode receives via the foreground service.

## Phasing (implementation)

- **A1 — Project bootstrap:** clone tyodroid-boilerplate → `tyonotify`, rename
  package `au.com.tyo.notify`, bump SDKs, wire submodules, build an empty app.
- **A2 — Notify core (JVM-testable):** `Server`/`Topic`/`NotifyMessage` models,
  `NotifyApi` (+ mock-server unit tests), payload parser.
- **A3 — Persistence:** `TopicStore` (Room) + servers/topics/settings/messages.
- **A4 — FCM + registration:** Firebase wiring, `google-services.json`,
  `PushRegistrar`, `NotifyMessagingService` (content path), `Notifier` + channels.
- **A5 — Screens:** Dashboard, Add topic (server picker), Topic detail, Settings.
- **A6 — Fuller features:** wake→poll path, live SSE view, publish/message-bar,
  share-to-publish + share-to-subscribe + `SEND_MESSAGE` intent, per-topic
  mute/min-priority.
- **A7 — Always-on SSE delivery:** `SseService` foreground service for FCM-less
  brokers.
- **A8 — End-to-end acceptance** against live freemq (the 6 checks above).

## Open items / risks

- **FCM provisioning access** (Firebase console/CLI for store-tyo-com-au) — may
  need the owner; blocks A4's real push (A1–A3 unaffected).
- tyodroid boilerplate is old (SDK 29, Java, submodules) — expect some
  build-tooling/AGP/Gradle updates during A1; keep changes minimal and building.
- Emulator FCM needs a Google-Play-services system image.
- Cluster note (inherited from the broker): the notify registry is node-local;
  fine while freemq is single-node.
