# TYO Notify Center — Desktop tray client (design)

**Date:** 2026-09-09
**Status:** Design approved (core), spec under review
**Owner:** Eric (eric@tyo.com.au)
**Related:** [[tyo-notify]], [[tyo-notify-account-backup]]; broker notify protocol in
`tyo-mq/lib/notify*.js`; reference client `tyo-mq/bin/notify-cli.js`.

## 1. Purpose

A lightweight desktop app so the owner can see TYO Notify messages — especially the
**private** topics (`cron-cac31e`, `tyostocks-signals`, `tyostocks-alerts`,
`contact-mail`) — on a Linux desktop, without picking up the phone. It lives in the
system tray, pops a native OS toast on each new message, and keeps a short scrollback
of recent notifications in a tray dropdown.

This is made possible by the 2026-09-09 **exportable device key** work: the desktop
signs in with TYO ID, pulls the account vault, and uses the exported device key to
read private topics — no re-claim, no phone pairing.

## 2. Scope (v1)

**In:**
- Linux only (StatusNotifier/AppIndicator tray; libnotify/D-Bus toasts).
- Tray-first, lightweight: tray icon with an unread badge, a dropdown of recent
  notifications, per-topic mute, "mark all read", "manage topics", "sign in / out",
  quit. **No large window** in v1.
- Native OS toast on each new (unmuted, at/above min-priority) message; clicking a
  toast or menu item opens the message's `click` URL (if any) in the browser.
- TYO ID browser sign-in → vault pull → auto-configure device key + topic list +
  publish tokens. Auto-subscribe to **all** vault topics.
- Live delivery via the broker's SSE-ticket stream + poll backfill (the exact
  contract `notify-cli.js` already implements).
- Structured trading-signal rendering (parse the `Tags` fields) in toast + menu.

**Out (later):**
- macOS / Windows.
- A full notification-center window (scrollable per-topic history UI).
- Publishing from the desktop (tokens are pulled, but v1 is read/notify only).
- OS keyring (libsecret) storage — v1 uses a `0600` file.
- Drive-appData path / passphrase-set-on-desktop.

## 3. Architecture

Go single static binary. Components, each independently testable:

| Unit | Responsibility | Depends on |
|------|----------------|------------|
| `identity` | Browser OAuth-code sign-in → JWT; `GET https://id.tyo.com.au/api/notify/vault` (Bearer JWT) → parse `Vault`; decrypt `secret_enc` if passphrase-set. Emits device key (PKCS8), topic list, tokens. | `store`, browser, net/http |
| `signer` | The proof primitive: `signatureBase(action,{topic},ts,nonce)` → ECDSA-P256/SHA-256 base64. Byte-identical to `lib/notify-auth.js`. | crypto/ecdsa |
| `subscriber` | One goroutine per topic: backfill poll + SSE-ticket live loop + reconnect/backoff. Emits parsed messages on a channel. | `signer`, net/http |
| `signalfields` | Parse the ntfy `Tags` CSV (`symbol/dir/level/strategy/market/price/sl/tp`) into fields for toast/menu, mirroring the Android contract. | — |
| `store` | Load/save config + device key (`0600`) + per-topic `last_seen_id` + read/unread state, under `~/.config/tyo-notify-center/`. | os, encoding/json |
| `tray` | systray icon + unread badge; recent-notifications menu; per-topic mute; mark-all-read; manage-topics; sign-in/out; quit. Fires toasts. | systray, libnotify |
| `app` | Wires it together; owns the message fan-in and the tray state. | all |

### 3.1 Verified broker contract (from `bin/notify-cli.js`, `lib/notify-auth.js`)

- **Proof:** `base = [action, timestamp, nonce, stableStringify(body)].join("\n")`,
  `signature = ECDSA_P256_SHA256(base)` base64. `body = {topic}` for reads. 60s
  freshness window; nonce single-use per (topic,nonce).
- **Signed GET headers** (poll): `x-tyo-notify-timestamp`, `x-tyo-notify-nonce`,
  `x-tyo-notify-signature`; proof action `"json"`.
- **Backfill:** `GET /notify/{topic}/json?poll=1&since=<last_seen_id|all>` (+ signed
  headers for private topics; bare for public). Returns the cached ring, then closes.
- **Live (private):** `POST /notify/{topic}/sse-ticket` body `{timestamp,nonce,signature}`
  (proof action `"sse-ticket"`, body `{topic}`) → `200 {ticket}`. Then
  `GET /notify/{topic}/sse?ticket=<ticket>` with `Accept: text/event-stream`. A fresh
  single-use ticket per (re)connect. `sse-ticket` **404s on an unclaimed topic** → fall
  back to a **bare** `GET /notify/{topic}/sse`.
- **Live (public):** bare `GET /notify/{topic}/sse`.
- **SSE parse:** accumulate `data:` lines, dispatch on blank line; `event:` sets the
  event name (only `message` events are notifications). Ignore `id:`/`retry:`/comments.
- **Reconnect:** exponential backoff 1s → 30s; reset to 1s on a clean open.
- **Base URL:** `https://freemq.tyo.com.au` (from the vault's `servers[].base_url`;
  fall back to this default).

### 3.2 Vault blob (source of truth for config)

`GET https://id.tyo.com.au/api/notify/vault` with `Authorization: Bearer <jwt>` →
`{ blob: "<Vault JSON string>", vault_version, updated_at }` (404 = no vault yet).
Parse `blob`:
- `public.topics[]` → `{name, server_id, delivery_mode, push_mode, muted, min_priority,
  is_private, last_seen_id}` — the subscription set. `is_private` decides signed vs bare.
- `public.servers[]` → `{id, name, base_url}` — resolve `server_id` → base URL.
- `secret.device_key_pkcs8_b64` (+ `spki_b64`) → the signing key. **If `secret_enc`
  present** (passphrase mode): prompt for the passphrase, derive PBKDF2-SHA256
  (`iters`, `salt_b64`), AES-256-GCM decrypt (`nonce_b64`, `ct_b64`) → the `secret`
  JSON. If neither `secret` nor `secret_enc` present → no key → private topics can't
  be read; show them as "needs key (back up from the phone with the device key)".

## 4. Data flow

1. **Launch** → `store` loads cached config (device key, topics, `last_seen_id` per
   topic). If a device key is cached, **start subscribers immediately** — the client
   works offline of id.tyo, since subscriptions use the device key, not the JWT.
2. **In parallel**, if a non-expired JWT is cached, `identity` refreshes the vault
   (picks up new topics / rotated key). If no/expired JWT → tray shows "Sign in".
3. **Sign in** (menu) → open browser to id.tyo login (`state`, `product`,
   `redirect_uri=http://127.0.0.1:<port>/callback`) → local callback captures the
   one-time code → `POST id.tyo /api/auth/exchange {code}` → JWT → vault pull → persist
   → (re)start subscribers.
4. Each `subscriber`: on start, **backfill** poll `since=<last_seen_id|all>` → emit the
   (bounded, newest-N) backlog silently into the menu (no toast storm on first run);
   then **live** SSE loop. Each live `message` → `signalfields` parse → `app` fans in.
5. `app` on a new message: if topic unmuted and `priority >= min_priority` → fire a
   toast; prepend to the tray's recent list (ring of ~50); bump unread badge; persist
   `last_seen_id`.
6. **Quit** closes streams cleanly; state is already persisted incrementally.

## 5. Storage & security

- Dir `~/.config/tyo-notify-center/` (mode `0700`).
  - `config.json` (0600): topics, per-topic mute/min_priority, server base URLs,
    UI prefs, `last_seen_id` map, `jwt` (+ decoded `exp`).
  - `device_key.pem` (0600): EC P-256 PKCS8 (the exported key).
  - `state.json` (0600): recent-notification ring + read/unread.
- The device key is the sensitive asset; `0600` matches `notify-cli`'s keyfile
  convention. **Follow-up:** move key + JWT into libsecret (GNOME Keyring/KWallet via
  D-Bus) behind the same `store` interface.
- Never log the JWT, device key, publish tokens, or the raw vault blob.
- Publish tokens are pulled (for a future publish feature) but unused in v1; stored in
  `config.json` (0600) alongside the key.

## 6. Error handling

- **JWT expired / vault 401:** subscriptions keep running on the cached key; tray shows
  a subtle "Sign in to sync" state. No crash, no data loss.
- **No vault (404):** signed in but nothing backed up → tray prompts "Back up your
  topics from the phone first."
- **`secret_enc` + wrong/no passphrase:** fail closed on the secret tier; still show the
  public topic list (read-only, "locked" markers); private topics not subscribed.
- **sse-ticket 404 (topic not actually claimed):** fall back to bare SSE.
- **Stream drops / broker down:** per-topic exponential backoff (1s→30s); tray icon
  reflects "reconnecting"; buffered `last_seen_id` means no missed messages (backfill on
  reconnect via `since=<last_seen_id>`).
- **Nonce replay 401 (clock skew / dup):** re-sign with a fresh nonce+timestamp and retry
  once before backing off.
- **Toast subsystem unavailable (no libnotify):** degrade to menu-only; log once.

## 7. Testing

- `signer`: golden-vector test against `lib/notify-auth.js` output (same base string →
  same verifiable signature; cross-verify with the Node verifier in a test fixture).
- `signalfields`: table test mirroring the Android `MessageFields` cases (dir/level/
  price present/absent/malformed → never panics).
- `subscriber`: httptest server emulating `/json?poll=1`, `/sse-ticket`, `/sse`
  (including a 404 sse-ticket → bare fallback, a mid-stream drop → reconnect, and a
  replay-401 → re-sign). Assert emitted messages + backoff schedule.
- `identity`: httptest for `/api/auth/exchange` + `/api/notify/vault` (200 plaintext
  secret, 200 `secret_enc`, 404, 401); assert parsed key/topics and passphrase decrypt.
- `store`: round-trip config/state; assert `0600`/`0700` perms.
- **End-to-end (manual, live):** run against `freemq.tyo.com.au` signed in as the owner;
  publish a test signal to `tyostocks-signals`; assert a toast appears with the parsed
  card and the menu updates.

## 8. Open questions / future

- Publish-from-desktop (reply / quick-send) — tokens already available.
- A real notification-center window (Tauri or a Go webview) if the tray dropdown proves
  too small.
- macOS/Windows ports (Go systray + beeep already cross-compile; toast + tray specifics
  differ).
- Per-topic notification sound / priority-based toast styling.
- Multi-account (v1 assumes one TYO ID).

## 9. Non-goals

- Not a replacement for the phone app; it's a companion viewer.
- Not a broker or a message store; it holds only a small local scrollback.
- No new broker endpoints required — v1 uses the existing notify read/stream contract.
