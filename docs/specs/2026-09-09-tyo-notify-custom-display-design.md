# TYO Notify — Customizable message display, levels & filtering (design)

**Status:** Design approved (visual brainstorm 2026-09-09) — ready for spec review.
**Scope:** TYO Notify Android app (`/data/tyolab/android/projects/tyonotify`).
**No broker change.** Publishers (e.g. tyostocks) opt in by adding `key=value` tags.

## 1. Problem & goal

Messages today render as a flat title + body + priority chip. Power users (the
owner's trading signals) carry rich structure — symbol, strategy, timeframe,
direction, price — that's currently flattened into one text line, and there's no
way to colour, categorise, or filter by it. With many signals a topic becomes an
undifferentiated wall.

**Goal:** a **generic, customizable notification contract** so any topic can send
structured fields and the app renders them richly — colour by content (short =
red, long = green), per-topic **levels** with custom labels/colours (e.g.
timeframes m15…Y), and **on-screen filtering** by any field. Non-trading topics
work with zero config; trading topics get the level palette + filters.

## 2. The message contract — structured fields via ntfy `tags`

Publishers add fields as `key=value` entries in the existing ntfy **`tags`** array
(a first-class field already carried end-to-end — **no broker change, curl-still-works**):

```
tags: ["symbol=XAUUSD","dir=short","level=h1","strategy=bb","market=metals",
       "price=2417.5","sl=2431","tp=2388","chart_with_downwards_trend"]
```

- The app splits `tags` into **fields** (`k=v`) and **plain tags** (emoji/words,
  rendered as today).
- **Well-known keys** get smart rendering (§4): `symbol`, `dir`
  (`long|short|buy|sell`), `level`, `strategy`, `market`, `price`, `sl`, `tp`.
- **Any other key** is shown generically as a muted chip — so the contract is
  open-ended, not trading-specific.
- Values are short strings; the app never trusts them for anything but display +
  filtering. Missing fields degrade gracefully (fall back to `title`/`message`).

Parsing is a pure function (`MessageFields.parse(tags) -> {fields:Map, plainTags:List}`),
JVM-unit-testable.

## 3. Publisher change (tyostocks)

`data_processor.js`'s `publish_notify` already sends `tags`. Extend the signal
path to add the structured tags (`symbol`, `dir`, `level`, `strategy`, `market`,
`price`, `sl`, `tp`) — all values it already has in `ret`/`signal_msg`. `level`
= the data-level string (m15/h1/h4/D/W/M/M3/Y). Keep the existing emoji tag. The
plain-text `message` stays as the human fallback. (This is a small, separate
commit in the tyostocks repo; the app works with or without it.)

## 4. Rendering — card style "A"

Chosen: **left accent bar + level chip** (visual option A / accent-rule 1).

A message card renders:
- **Left accent bar** coloured by the **accent field** (default `dir`:
  short→red, long→green; configurable per topic — see §6).
- **Symbol** (the "title field", default `symbol`) bold, tinted by the accent
  colour.
- **Level chip**: the `level` value, filled with that level's palette colour (§5).
- **Meta line**: `dir` + `strategy` (muted).
- **Body**: `price · sl · tp` when present, else the raw `message`.
- **Actions**: existing ntfy action buttons unchanged.

When a message has **no** recognised fields, the card falls back to today's
title/body/priority rendering — nothing regresses.

**System notification** (heads-up / status bar) uses the same accent colour:
`NotificationCompat.setColor(accent)` + small-icon tint; the title is auto-built
from fields (`symbol · dir · level`) when present, else the ntfy title. So a short
signal's pop-up reads red — the owner's original ask.

## 5. Levels (per-topic palette)

A **level** = `{ value, label, colorArgb }`. Per topic, the user edits a list of
levels (Topic → Display → Levels): add/rename/recolour/remove, any number.
Default palette for a fresh topic that uses `level` (cool→warm ramp):

| m15 | h1 | h4 | D | W | M | M3 | Y |
|---|---|---|---|---|---|---|---|
| #7EA6FF | #49C1E6 | #3AD0B0 | #5FD06A | #C9D24B | #F2B13D | #F27A3D | #F2564B |

- A message's `level` value → chip colour/label via this map.
- Unknown level value (not in the palette) → a neutral chip with the raw value
  (and the user can add it).
- Stored on the `Topic` (see §8). Levels are just data — the same mechanism can
  colour any categorical field later, but v1 exposes it as "levels".

## 6. Per-topic display config

Topic → **Display** settings (smart defaults so most topics need no touching):

- **Levels** editor (§5).
- **Accent colour from**: field name (default `dir`) + a value→colour map for it.
  The `dir` default map is built in: `long/buy` → green `#28C76F`, `short/sell` →
  red `#FF5B5B`.
- **Title field** (default `symbol`), **Level chip field** (default `level`).
- **Show strategy**, **Show price/SL/TP** toggles.
- **Show compose box** (default OFF) — see §9.

Config is a small per-topic object with sensible defaults; unset → smart defaults.
Chosen model: **smart-defaults + light per-topic overrides** (not a full template
editor). Approved as "this config model works".

## 7. On-screen filtering (topic screen)

Approved: **full** filtering (chip bar + field→values sheet).

- A **filter bar** above the message list shows active filters as removable chips
  (`h1 ✕`, `short ✕`) + a **"+ Filter"** button.
- **"+ Filter" sheet**: filter **fields are auto-discovered** from the messages
  currently cached for the topic (every `key` seen becomes a group); each group
  lists its observed values. **Multi-select within a field** (OR), **combine
  across fields** (AND). A free-type box for high-cardinality fields (symbol).
- Filtering is **client-side** over the cached message list (the app already
  caches recent messages per topic); shows "N of M".
- **Per-topic, remembered** (persisted on the Topic).
- Pure predicate (`MessageFilter.matches(fields, activeFilters)`), unit-testable.

## 8. Data model & persistence

Extend `Topic` (Gson-persisted in `NotifyStore`, already backed up by the vault):

```
Topic.display : {
  levels: [ {value,label,color} ... ] | null,   // null = default palette
  accentField: "dir",            // + built-in dir color map; overridable
  titleField:  "symbol",
  levelField:  "level",
  showStrategy: true,
  showPriceLine: true,
  showCompose: false,            // §9
  notifTap: "details",           // "details" | "chart" (§10a) — default details
}
Topic.filters : { <field>: [values...] } | null  // remembered active filters
```

All optional/nullable → existing topics and the account-backup vault keep
working (new keys serialize in, absent = defaults). The vault backup (already
built) carries these automatically since it serializes the topic.

## 9. Compose box default-hidden

The topic screen's `input_send` + `btn_send` composer is **hidden by default**
(`Topic.display.showCompose = false`); a **"Show compose box"** switch in Topic
Settings reveals it. (A topic you only *receive* on shouldn't show a publish box;
the owner's private topics do publish, so it's a per-topic opt-in.)

## 10. Testing

- **Pure/unit (JVM):** `MessageFields.parse` (k=v split, plain-tag passthrough,
  malformed `=`), level→colour resolution (known/unknown/default), accent colour
  from field + dir map, `MessageFilter.matches` (within-field OR, cross-field
  AND, empty = all), `Topic.display` (de)serialize round-trip + defaults.
- **On-device:** publish real tagged signals to a scratch topic → cards render
  with correct colours/chips; short = red pop-up; filter by level+dir narrows the
  list; toggle compose box; edit a level colour and see it apply.

## 10a. Actions & the message detail screen

The contract already carries ntfy **actions** (`NotifyAction`: `view` opens a
URL, `http` fires a request; ≤6, first 3 on the shade). What's missing is a
**per-message detail screen** and a clean way to reach it. Added:

- **`MessageDetailActivity`** — a full-screen view of ONE message: the parsed
  fields laid out (symbol/dir/level/strategy/price/sl/tp + any other `k=v`), the
  raw `message`, plain tags, priority + time, and **every** action button (all
  `msg.actions`, not just the shade's first 3). Reuses the same field parsing +
  colour rules as the card (§2/§4). This is the "detailed noti screen".
- **Reaching it:**
  1. **Tapping a card** in the topic list → opens `MessageDetailActivity`.
  2. A built-in **"View Details"** action — always available (app-internal
     `PendingIntent` to `MessageDetailActivity`), shown on the notification
     (as an extra action button) and on the in-app card. This is distinct from
     publisher `view`/`http` actions and needs no publisher change.
  3. **Notification tap** → **configurable per topic** (`Topic.display.notifTap`
     = `details` | `chart`, default **`details`**). `chart` opens the message
     `click` URL (e.g. TradingView); `details` opens `MessageDetailActivity`.
- **"Chart" button:** when a message has a `click` URL, it's also surfaced as a
  `view`-style **"Chart"** action button (on the notification + detail screen),
  so the chart is always one tap away regardless of the tap-default.
- Publisher `http` order-action buttons (Confirm/Direct/Fast/Contrarian) remain
  email/desktop-only for now (they target `localhost:7777`, unreachable from the
  phone; Notify `http` actions require https) — surfacing those on the phone is
  the separate "expose the trade server over https" piece, still deferred.

Config additions (§6): a **"Notification tap opens"** choice (Details | Chart)
in Topic → Display. Data-model additions (§8): `Topic.display.notifTap`.

## 11. Non-goals (v1)

- No broker changes. No server-side filtering (client-side over the cache is
  enough for the message volume held on-device).
- No full drag-and-drop template designer — smart defaults + the field pickers
  cover it.
- iOS parity is a later port (same contract; the tags travel already).

## 12. Open questions

1. **Field-name canon:** confirm the exact tag keys tyostocks will emit
   (`dir` vs `direction`, `level` vs `tf`). Proposed: `symbol,dir,level,strategy,
   market,price,sl,tp`. The app treats them as config-driven, so renaming later
   is cheap, but the tyostocks emit + app defaults should match on day one.
2. **Accent map editing UI:** v1 ships the built-in `dir` colour map + lets the
   user pick the accent *field*; a full value→colour editor for arbitrary accent
   fields could be v2 (levels already have a colour editor to reuse).
