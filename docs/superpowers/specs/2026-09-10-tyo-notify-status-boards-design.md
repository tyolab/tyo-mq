# TYO Notify — Status Boards (design)

**Date:** 2026-09-10
**Status:** Design approved (decisions locked); spec under review
**Owner:** Eric (eric@tyo.com.au)
**Related:** [[tyo-notify]], [[tyo-notify-account-backup]] (broker contract + vault),
[[tyo-notify-center-desktop]]; broker in `tyo-mq/lib/*`. Companion to the
2026-09-10 blog post "I Moved My Trading Signals From Email to TYO Notify".

## 1. Purpose

Turn TYO Notify from a stream of one-off alerts into a **live status board**: a
view of the *current state of N things* (servers, containers, jobs, sensors…),
fed by a tiny agentless producer, with real up/down detection. It reuses the
structured-card contract; it does **not** turn the app into an SSH client or a
monitoring agent. The app stays a pure notification/display client — the
monitoring lives in a producer that *feeds* Notify.

Framing: **the phone is where you want the alert; a big screen is where you want
the board.** So the primary board surface is the trymq web dashboard; the phone
keeps getting the loud events as its feed.

## 2. Scope

**v1 — in:**
- Broker: **compacted topics** (latest-message-per-key) + a **watchdog**
  (dead-man's-switch) that fires synthetic DOWN/RECOVERED alerts from missed
  heartbeats.
- A generic **status field vocabulary** in the shared card contract.
- The **`tyo-notify-watch`** agentless producer + its **one-liner installer**.
- The **board view on the trymq dashboard** (backend agent), incl. token-mint +
  the one-liner install UX + the install-confirm loop, and a **user-set board
  name**.
- **Explicit uptime pings from day one** (heartbeat + ttl → real down-detection).

**v1 — out (deferred to v2):**
- Board *views* on phone and desktop (they still receive the loud events as
  toasts in v1 — just no board UI).
- The "install for me over SSH" hub installer (v1 is the copy-paste one-liner).
- Deep metrics beyond the default set (custom check plugins).
- Multi-user/shared boards, per-viewer ACLs beyond the existing topic-key model.

## 3. Concepts

- **Board** = a **compacted topic**: the broker keeps only the latest message per
  `key`. A board has a user-set **display name** ("Production Fleet", "Home Lab")
  stored in the topic config; the feature is "Status Boards", each board is named
  by its owner.
- **Key** = the entity a row represents (a host id, container name, job name). The
  compaction + the board row are keyed on it.
- **State** = `ok | warn | crit | unknown` — drives the row/card accent colour
  (green / amber / red / grey), the same mechanism `dir` drives for trading cards.
- **Heartbeat + ttl** = every producer message declares `ttl` (seconds until the
  next update is due). The broker watchdog uses it for down-detection.
- **Loudness** = existing per-message priority. Routine updates are silent (board
  refresh only); threshold trips and DOWN/RECOVERED are high-priority (board +
  push). One topic serves both the board and the feed.

## 4. Broker design (mine)

### 4.1 Compacted topics
- A topic is marked **compacted** with a **key field name** (default `key`) when
  claimed/configured. Stored alongside the `notify_claims` row (new columns or a
  small `notify_topic_config`).
- On publish to a compacted topic, the broker upserts by `(topic, key)`: the new
  message **replaces** the prior message for that key. Non-keyed messages on a
  compacted topic are rejected (400) so a board can't silently accumulate a log.
- **Retention:** bounded to `MAX_KEYS` per board (config, default e.g. 500), LRU
  evict beyond it. The compacted set is durable like `notify_claims` (survives
  restart) — it *is* the board, not a ring.
- **Fetch:** `GET /notify/{topic}/board` → `{ board: [ <latest msg per key>… ],
  name, updated_at }`. Signed-GET for private topics (same proof as `/json`).
- **Live:** over the existing SSE/`/json` stream, a compacted update is delivered
  as a normal message; the client replaces that key's row (keyed by `key`). No new
  stream type — clients just index by `key`.

### 4.2 Watchdog (dead-man's-switch) — the explicit-uptime mechanism
- Each board key has an **expected-by** deadline = time of last message + its
  `ttl` (+ a grace factor, e.g. ×2). Persisted with the compacted row.
- A periodic broker **sweep** (every ~15–30 s) finds keys whose deadline has
  passed and are not already DOWN → emits a **synthetic DOWN message** for that
  key (state=`crit`/`unknown`, high priority) into the topic: it updates the board
  row *and* pushes a toast ("web1 is DOWN — no heartbeat for 3m"). Marks the key
  `down`.
- When a heartbeat resumes for a `down` key → emit **RECOVERED** (state back to
  reported, high priority: "web1 RECOVERED").
- This is what makes uptime real: the box being silent is itself the signal, and
  the *broker* (not the phone) notices it, so the DOWN push fires even if no client
  is watching. Pattern = Healthchecks.io dead-man's-switch.
- `ttl: 0` / absent ⇒ no watchdog for that key (pure state board, no liveness).

### 4.3 Auth — boards are service-managed
- **Ownership:** the broker generates + holds a per-board key and claims the
  compacted topic with it (broker-initiated claim). The board is bound to a
  TYO-ID account.
- **Publishing** (the watcher): a **labeled Bearer publish token** from the board's
  `notify_publish_tokens` set (§4.4). No signing.
- **Management** (create board, mint/list/revoke tokens, set name): authorized by
  **`x-service-token`** (the notify-vault pattern) from store-backend, naming the
  board topic + authed user. No device-key proof.
- **Reading `/board`** (v1 = dashboard only): the dashboard backend calls the
  broker with its service token on behalf of the authed user (the broker holds the
  board-key). Phone/desktop still receive the loud DOWN/threshold events via the
  normal push path. Direct device reads of a board (phone/desktop board views) are
  v2 (sync the board-key to devices via the vault, or proxy — decide then).

### 4.4 Per-watcher publish tokens (`notify_publish_tokens`)
- New table `notify_publish_tokens(topic, token_id, token_hash, label, created_at,
  last_used_at?)` — supersedes the single `publish_token_hash` column for boards
  (personal topics keep their single token; the board set is additive).
- **Publish auth:** broker matches the request's Bearer token against ANY
  non-revoked `token_hash` for the topic.
- `POST /notify/{topic}/tokens` → mint. Auth: service token (board) or owner proof
  (personal). Body `{label}`. Returns `{token_id, token /* one-time raw */, label,
  created_at}`.
- `GET /notify/{topic}/tokens` → list metadata only (never raw tokens).
- `DELETE /notify/{topic}/tokens/{token_id}` → revoke (delete by id; immediate).
- store-backend's watcher record = 1:1 with `token_id`.

## 5. Contract (producers + clients)

**Publish a status update** (routine, silent board refresh):
```
POST /notify/{board}                Authorization: Bearer <publish-token>
Tags: key=web1,label=web1,metric=disk,value=96%,state=warn,ttl=120
Priority: 1                         # silent — board only
Body: "web1 disk 96%"
```
**Publish a trip** (loud — board + phone toast): same, `state=crit`, `Priority: 5`.

**Fields** (status family; complements the trading family symbol/dir/level/price):
- `key` (required on a board) — entity id, compaction key + row identity.
- `label` — display name (defaults to `key`).
- `state` — `ok|warn|crit|unknown` → row/card colour.
- `metric`, `value` — the headline reading ("disk", "96%"). Extra `k=v` allowed.
- `ttl` — seconds until the next update is due (watchdog). Omit ⇒ no liveness.

**Board fetch:** `GET /notify/{board}/board` → latest-per-key + board `name`.
Boards are service-managed (§4.3): the dashboard backend fetches this with its
service token for the authed user. **Live:** the backend proxies the board's
message stream; the client indexes incoming messages by `key` and replaces rows.

## 6. Producer — `tyo-notify-watch` (small; I'll own it)

- **Dependency-free POSIX `sh`** (coreutils + `curl`), one file. Runs on a
  fresh Debian/Ubuntu/Alpine with nothing else.
- **Install (primary path):** the dashboard mints a token and shows one command:
  ```sh
  curl -fsSL https://get.tyonotify.com/watch | BOARD=ops KEY=web1 TOKEN=xxxx sh
  ```
  The script drops the watcher + a **systemd timer (fallback: cron)**, writes a
  `0600` config (`/etc/tyo-notify-watch.conf` or `~/.config/…` for non-root),
  runs one check immediately, and supports `… | sh -s uninstall`. Idempotent
  (re-running replaces, doesn't stack timers).
- **Default checks** (each → a `key`d status message; heartbeat carries `ttl`):
  load average, memory %, disk % (root + configured mounts), optional Docker
  container health/count. A **heartbeat** every interval (default 60 s) with
  `ttl` = 2× interval, so a dead box trips the watchdog.
- **Thresholds** in config → `state` and loudness: within limits ⇒ `ok`, silent;
  over warn/crit ⇒ `warn`/`crit`, and the crossing message goes high-priority.
- **Token rotation:** config token is replaceable (ties into the broker
  rotate/unclaim endpoints — a rotated token just gets rewritten into the conf).

## 7. Dashboard slice (backend agent — to confirm on `trymq`)

- **Board view:** render `GET /notify/{board}/board` as a grid/list of rows,
  one per `key`: `label`, `state` colour, `metric=value`, **last-seen**, and an
  explicit **UP/DOWN** badge derived from the watchdog state. Live-update rows
  over SSE by `key`. Show the user-set **board name** as the title, editable.
- **Onboarding:** a "Add a host / add to board" flow that (1) mints a publish
  token for the board, (2) shows the copy-paste one-liner with token/board/key
  baked in, (3) **confirms via the topic** — waits for the first check-in and
  flips the row to "web1 connected ✓". This closed loop is the key UX beat.
- **Board naming:** UI to name/rename a board (persists to the topic config).
- Reuses the dashboard's existing vault/topic auth + rendering; exact plug-in
  point (SSE vs poll, framework) pending the backend agent's answers to the
  scoping ping (trymq channel, 2026-09-10).

## 8. Division of labour

**Three backend roles, not one** (corrected 2026-09-10 after store-backend's
ownership note — I'd conflated them):

| Piece | Owner |
|---|---|
| Compacted-topic mode, `key`, `/board`, SSE replace, retention | **broker (me)** |
| Watchdog sweep + synthetic DOWN/RECOVERED | **broker (me)** |
| **Per-watcher publish tokens** — multiple labeled, independently-revocable tokens per board topic (`notify_publish_tokens`); mint/list/revoke API | **broker (me)** |
| Status field vocabulary in the shared card contract | **broker (me)** |
| `tyo-notify-watch` script | **me** |
| **"My watchers" ownership API** (create/list/revoke a watcher, request token mint/revoke from broker, emit the `curl … | sh`) + hosting the install endpoint | **store-backend** (`work3-agent-backend#1`) — mirrors notify-vault |
| Board view / topic rendering / onboarding UX + board naming | **trymq-web** (`work3-agent#20`) |
| Phone/desktop board views | **v2** |

Handoff pattern = the rotate/unclaim one: I pin the byte-level contract, then
hand each agent its precise slice (store-backend: the `notify_publish_tokens`
mint/revoke API; trymq-web: the `/board` render contract).

**Token model:** one board = one compacted topic; hosts = `key`s within it;
watchers = per-host *labeled* publish tokens on that one topic (revoke one box
without re-tokening the fleet). The broker is the token authority; store-backend
owns the management/UX layer; id stays identity/session only.

**Ownership model — SETTLED (Eric, 2026-09-10): two resource classes.**
- **Personal private topics** (a user's signals topic, etc.) — **device-key-owned**:
  only the user's devices can read; the server cannot. Server-side management
  (rotate/unclaim) is possible only for plaintext vaults, else app-only. Unchanged.
- **Boards** — **broker-held board-key**. Web-accessible by design, so they can't
  be gated by an on-device-only key. The broker generates + holds a per-board key
  and owns the compacted topic; the user's master device key is never involved
  (no escrow, works for passphrase vaults too). Consequence, accepted by the owner:
  the broker CAN read a board's data (host names/metrics) — appropriate for a
  hosted status view, and NOT device-only-private. Anything needing device-only
  privacy uses a personal topic instead.
- Therefore **no service signs device-key proofs for boards**: store-backend's
  "my watchers" API and the dashboard's board reads are authorized by a **service
  token** (x-service-token, the notify-vault pattern) naming the board topic + the
  authed TYO-ID user. Signing capability question is moot for boards.

## 9. Security & privacy

- Boards use a **broker-held board-key** (server-readable status; §4.3), a
  deliberate, owner-approved step down from the device-only model used for personal
  topics. No SSH keys anywhere (the box pushes out); the master device key is never
  escrowed.
- Each watcher's install one-liner carries a **labeled, publish-only** token (can
  post to one board, can't read/claim/manage), independently revocable by
  `token_id` (§4.4).
- The watcher runs `0600` config, no inbound access, no agent phoning a third
  party — it only POSTs to the broker the user owns.
- Board content is user data (host names, metrics) on the user's own private
  topic; nothing is shared cross-account.

## 10. Open questions / v2

- **Board name storage:** a `notify_topic_config` row vs a field on the vault
  topic entry (the vault already carries per-topic display prefs — likely reuse).
- **Watchdog cost:** the sweep is O(keys) every ~20 s; fine at fleet scale,
  revisit if boards get huge.
- **Synthetic-message identity:** DOWN/RECOVERED are broker-authored messages on a
  user topic — mark them `source=watchdog` so clients can style/filter them.
- v2: phone/desktop board views; SSH-hub installer; custom check plugins; a
  hosted external-uptime probe (HTTP/TCP from a TYO box) for things with no shell.

## 11. Non-goals

- Not an SSH terminal or an on-device SSH monitor (that's a separate product; the
  app's clean identity stays intact).
- Not a general metrics/timeseries store (no history/graphs in v1 — current state
  only; Prometheus/Grafana own that space).
