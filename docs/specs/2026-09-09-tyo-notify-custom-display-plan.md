# TYO Notify — Customizable display, levels & filtering — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Render structured messages richly (direction-coloured cards, per-topic level chips), filter the topic screen by any field, add a message-detail screen + actions, and hide the composer by default — all driven by a generic `key=value` contract.

**Architecture:** App-only (publisher side already shipped, tyostocks 0.3.0). Messages carry fields in ntfy `tags` as `key=value`. Pure parsing/resolution/filter logic is Android-free + JVM-unit-tested; UI binds it. Config + filters persist on `Topic` (Gson via `NotifyStore`, already backed up by the account vault).

**Tech Stack:** Android (Java, tyodroid framework), JUnit unit tests under `app/src/test`. Build/test on elitebook1 (`rsync app/src → :app:testDebugUnitTest / :app:assembleDebug`). Design: `docs/specs/2026-09-09-tyo-notify-custom-display-design.md`.

**Key existing files:** `core/NotifyMessage.java` (id/time/topic/message/title/priority/tags/click/actions), `core/NotifyAction.java` (view/http), `core/Topic.java`, `core/NotifyStore.java`, `TopicDetailActivity.java` (message list, binds `res/layout/item_message.xml`, has `input_send` composer), `TopicSettingsActivity.java`, `Notifier.java` (builds notifications), `core/PriorityColors.java`, `core/TopicColors.java`.

---

## File structure

New (all under `app/src/main/java/au/com/tyo/notify/`):
- `core/display/MessageFields.java` — parse `tags` → `{fields:Map, plainTags:List}` (pure).
- `core/display/LevelPalette.java` — level value → `{label,color}` (pure).
- `core/display/DisplayColors.java` — accent colour from a field + built-in dir map (pure).
- `core/display/MessageFilter.java` — filter predicate + field/value discovery (pure).
- `core/display/TopicDisplay.java` — the per-topic config POJO (pure, Gson).
- `MessageDetailActivity.java` (+ `res/layout/activity_message_detail.xml`).

Modified:
- `core/Topic.java` (+ `display` + `filters`), `core/NotifyMessage.java` (helper accessors optional),
  `res/layout/item_message.xml` (accent bar + chip row), `TopicDetailActivity.java` (bind card, filter bar, card-tap→detail), `TopicSettingsActivity.java` (Display section), `Notifier.java` (accent colour, View Details + Chart actions, notifTap), `res/values/strings.xml`, `res/values/colors.xml`.

Tests under `app/src/test/java/au/com/tyo/notify/core/display/`.

---

## Phase A — Pure core (JVM-unit-tested, no Android imports)

### Task A1: MessageFields — parse tags into fields

**Files:** Create `core/display/MessageFields.java`, `app/src/test/java/au/com/tyo/notify/core/display/MessageFieldsTest.java`.

- [ ] **Step 1: Write the failing test.**
```java
package au.com.tyo.notify.core.display;
import static org.junit.Assert.*;
import java.util.*; import org.junit.Test;
public class MessageFieldsTest {
  @Test public void splitsKeyValueFromPlainTags() {
    MessageFields f = MessageFields.parse(Arrays.asList(
        "symbol=XAUUSD","dir=short","level=h1","chart_with_downwards_trend"));
    assertEquals("XAUUSD", f.get("symbol"));
    assertEquals("short", f.get("dir"));
    assertEquals(Arrays.asList("chart_with_downwards_trend"), f.plainTags);
    assertNull(f.get("missing"));
  }
  @Test public void handlesNullEmptyAndMalformed() {
    MessageFields f = MessageFields.parse(null);
    assertTrue(f.fields.isEmpty()); assertTrue(f.plainTags.isEmpty());
    MessageFields g = MessageFields.parse(Arrays.asList("=novalue","k=","a=b=c","plain"));
    assertEquals("", g.get("k"));           // empty value kept
    assertEquals("b=c", g.get("a"));        // only first '=' splits
    assertEquals(Arrays.asList("=novalue","plain"), g.plainTags); // no key → plain
  }
}
```
- [ ] **Step 2: Run** `./gradlew :app:testDebugUnitTest --tests '*MessageFieldsTest'` → FAIL (class missing).
- [ ] **Step 3: Implement.**
```java
package au.com.tyo.notify.core.display;
import java.util.*;
public final class MessageFields {
  public final Map<String,String> fields = new LinkedHashMap<>();
  public final List<String> plainTags = new ArrayList<>();
  public static MessageFields parse(List<String> tags) {
    MessageFields m = new MessageFields();
    if (tags == null) return m;
    for (String t : tags) {
      if (t == null) continue;
      int eq = t.indexOf('=');
      if (eq > 0) m.fields.put(t.substring(0, eq), t.substring(eq + 1));
      else m.plainTags.add(t);          // no key (or leading '=') → plain tag
    }
    return m;
  }
  public String get(String key) { return fields.get(key); }
  public boolean has(String key) { return fields.containsKey(key); }
}
```
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(display): MessageFields — parse key=value tags`.

### Task A2: LevelPalette — level value → label + colour

**Files:** Create `core/display/LevelPalette.java`, `.../display/LevelPaletteTest.java`.

- [ ] **Step 1: Failing test** — a default palette maps `h1`→a blue label "h1"; an unknown value returns a neutral entry with the raw value as label; a custom palette overrides.
```java
@Test public void defaultAndCustom() {
  LevelPalette def = LevelPalette.defaults();
  assertEquals("h1", def.labelFor("h1"));
  assertTrue(def.colorFor("h1") != 0);
  // unknown → neutral entry, raw label
  assertEquals("zzz", def.labelFor("zzz"));
  LevelPalette custom = LevelPalette.of(Arrays.asList(
      new LevelPalette.Level("h1","1-hour",0xFF112233)));
  assertEquals("1-hour", custom.labelFor("h1"));
  assertEquals(0xFF112233, custom.colorFor("h1"));
}
```
- [ ] **Step 2–4:** Implement `Level{value,label,color}`, `defaults()` (the §5 ramp: m15/h1/h4/D/W/M/M3/Y → the 8 hex colours), `of(list)`, `labelFor`/`colorFor` (unknown → raw value + a neutral grey `0xFF888888`). Run → PASS.
- [ ] **Step 5: Commit** `feat(display): LevelPalette (default ramp + custom)`.

### Task A3: DisplayColors — accent colour from a field

**Files:** Create `core/display/DisplayColors.java`, `.../DisplayColorsTest.java`.

- [ ] **Step 1: Failing test.**
```java
@Test public void accentFromDir() {
  assertEquals(DisplayColors.GREEN, DisplayColors.dirColor("long"));
  assertEquals(DisplayColors.GREEN, DisplayColors.dirColor("buy"));
  assertEquals(DisplayColors.RED, DisplayColors.dirColor("short"));
  assertEquals(DisplayColors.RED, DisplayColors.dirColor("sell"));
  assertEquals(0, DisplayColors.dirColor("wat"));   // unknown → 0 (no accent)
}
@Test public void accentResolves() {
  MessageFields f = MessageFields.parse(java.util.Arrays.asList("dir=short","level=h1"));
  // accentField=dir → red; accentField=level → the level colour
  assertEquals(DisplayColors.RED, DisplayColors.accent(f, "dir", LevelPalette.defaults()));
  assertEquals(LevelPalette.defaults().colorFor("h1"),
               DisplayColors.accent(f, "level", LevelPalette.defaults()));
}
```
- [ ] **Step 2–4:** Implement `GREEN=0xFF28C76F`, `RED=0xFFFF5B5B`; `dirColor(v)`; `accent(fields, accentField, palette)` → if field is `dir` use dirColor, if `level` use palette.colorFor, else 0. Run → PASS.
- [ ] **Step 5: Commit** `feat(display): DisplayColors — direction + accent resolution`.

### Task A4: MessageFilter — predicate + discovery

**Files:** Create `core/display/MessageFilter.java`, `.../MessageFilterTest.java`.

- [ ] **Step 1: Failing test** — within-field OR, cross-field AND, empty filter matches all; `discover(list of MessageFields)` returns each field's observed value set.
```java
@Test public void matchesAndDiscovers() {
  MessageFields a = MessageFields.parse(Arrays.asList("level=h1","dir=short"));
  MessageFields b = MessageFields.parse(Arrays.asList("level=h4","dir=short"));
  Map<String,Set<String>> none = new HashMap<>();
  assertTrue(MessageFilter.matches(a, none));                       // empty → all
  Map<String,Set<String>> f = new HashMap<>();
  f.put("level", new HashSet<>(Arrays.asList("h1")));
  assertTrue(MessageFilter.matches(a, f));
  assertFalse(MessageFilter.matches(b, f));                         // level mismatch
  f.put("dir", new HashSet<>(Arrays.asList("short")));              // AND across fields
  assertTrue(MessageFilter.matches(a, f));
  f.get("level").add("h4");                                         // OR within field
  assertTrue(MessageFilter.matches(b, f));
  Map<String,Set<String>> disc = MessageFilter.discover(Arrays.asList(a,b));
  assertEquals(new HashSet<>(Arrays.asList("h1","h4")), disc.get("level"));
}
```
- [ ] **Step 2–4:** Implement `matches(fields, active)` (for each active field, the message value must be in the set; missing field → no match), `discover(list)` → field→value-set. Run → PASS.
- [ ] **Step 5: Commit** `feat(display): MessageFilter — predicate + field discovery`.

### Task A5: TopicDisplay config model + Topic wiring

**Files:** Create `core/display/TopicDisplay.java`; modify `core/Topic.java`; test `.../TopicDisplayTest.java` + extend an existing `NotifyStoreTest` case.

- [ ] **Step 1: Failing test** — `TopicDisplay` defaults (`accentField="dir"`, `titleField="symbol"`, `levelField="level"`, `showStrategy=true`, `showPriceLine=true`, `showCompose=false`, `notifTap="details"`, `levels=null`); Gson round-trip; a `Topic` with a `display` + `filters` serializes and reloads through `NotifyStore` (reuse `InMemoryPersistence`).
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** `TopicDisplay` POJO (fields above + `List<LevelPalette.Level> levels`), a static `defaults()`. Add to `Topic`: `public TopicDisplay display;` and `public Map<String,List<String>> filters;` (both nullable → absent = defaults; keeps existing topics + the vault backup working). `Topic.displayOrDefault()` returns `display != null ? display : TopicDisplay.defaults()`.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(display): TopicDisplay config on Topic (persisted, backed up)`.

---

## Phase B — Card rendering

### Task B1: item_message.xml — accent bar + chip row

**Files:** Modify `res/layout/item_message.xml`; add colours to `res/values/colors.xml`.

- [ ] **Step 1:** Add a left **accent bar** view (`@+id/msg_accent`, 4dp wide, full height) to the card root; a horizontal **chip row** (`@+id/msg_chip_row`) holding `@+id/msg_symbol` (bold), a level chip container `@+id/msg_level_chip`, and `@+id/msg_meta_inline` (muted dir·strategy). Keep `msg_title/msg_body/msg_time/msg_actions`. Use a rounded-chip drawable (`res/drawable/shape_chip.xml`).
- [ ] **Step 2:** Build `:app:assembleDebug` on elitebook1 → compiles (layout inflates). Commit `feat(display): message card layout — accent bar + chip row`.

### Task B2: Bind the card from fields

**Files:** Modify `TopicDetailActivity.java` (the message-list adapter's `onBindViewHolder`).

- [ ] **Step 1:** In bind: `MessageFields f = MessageFields.parse(msg.tags)`. Resolve `TopicDisplay d = topic.displayOrDefault()`, `LevelPalette pal = d.levels!=null?LevelPalette.of(d.levels):LevelPalette.defaults()`.
  - Accent: `int c = DisplayColors.accent(f, d.accentField, pal)`; if `c!=0` show `msg_accent` tinted `c`, tint `msg_symbol` text `c`; else hide accent + default text colour.
  - Symbol: `f.get(d.titleField)` → `msg_symbol` (fallback to `msg.title`/topic name when absent → then it's a "plain" message: hide the field row, show title/body as today).
  - Level chip: `f.get(d.levelField)` → chip label `pal.labelFor`, background `pal.colorFor`; hide when absent.
  - Meta: dir + (showStrategy? strategy). Body: price/sl/tp line when `showPriceLine` and present, else `msg.message`.
  - **Fallback:** when `f.fields` is empty → render exactly as today (no regression).
- [ ] **Step 2:** Build; commit `feat(display): render structured message cards (style A)`.
- [ ] **Step 3 (verify):** deferred to Phase F on-device.

---

## Phase C — Filtering (topic screen)

### Task C1: Filter bar + sheet

**Files:** Modify `res/layout/activity_topic_detail.xml` (add `@+id/filter_bar` above the list); modify `TopicDetailActivity.java`; create `res/layout/sheet_filter.xml`.

- [ ] **Step 1:** Maintain `Map<String,Set<String>> active` = `topic.filters` (loaded). Render the filter bar: a chip per active `field:value` (tap ✕ removes) + a "+ Filter" chip.
- [ ] **Step 2:** "+ Filter" opens a `BottomSheetDialog` built from `MessageFilter.discover(parsed fields of cached messages)`: one group per field, tappable values (multi-select) reflecting `active`. On change: update `active`, persist to `topic.filters` via `store.updateTopic`, re-filter the adapter (`MessageFilter.matches`), update the "N of M" footer.
- [ ] **Step 3:** Build; commit `feat(display): topic-screen field filtering (bar + sheet)`.
- [ ] **Step 4 (verify):** Phase F.

---

## Phase D — Message detail + actions + system-notification colour

### Task D1: MessageDetailActivity

**Files:** Create `MessageDetailActivity.java`, `res/layout/activity_message_detail.xml`; register in `AndroidManifest.xml` (`exported=false`).

- [ ] **Step 1:** Launched with topic+server+messageId extras (or a serialized `NotifyMessage`). Parse fields; lay out: symbol (accent-coloured) + level chip + priority + time; a labelled row per known field (strategy/price/sl/tp/market) then any remaining `k=v`; the raw `message`; plain tags; and **all** action buttons — publisher `msg.actions` (view/http via the existing `ActionRunner`) **plus a "Chart" button** when `msg.click` present (opens the URL).
- [ ] **Step 2:** Build; commit `feat(display): message detail screen`.

### Task D2: Card tap + notifTap + View Details/Chart on notifications

**Files:** Modify `TopicDetailActivity.java` (card `onClick` → `MessageDetailActivity`); modify `Notifier.java`.

- [ ] **Step 1:** Card tap in the list → open `MessageDetailActivity` (was: none/click).
- [ ] **Step 2:** In `Notifier`:
  - **Accent colour:** `int c = DisplayColors.accent(parse(msg.tags), display.accentField, palette)`; if `c!=0` `b.setColor(c)` + coloured small-icon.
  - **View Details action:** always add an action (PendingIntent → `MessageDetailActivity`) — label "Details".
  - **Chart action:** when `msg.click` present, add a `view`-style "Chart" action (PendingIntent → the URL).
  - **Content tap (`setContentIntent`):** per `display.notifTap` — `chart` → the `click` URL (today's behaviour) ; `details` (default) → `MessageDetailActivity`.
- [ ] **Step 3:** Build; commit `feat(display): notif accent colour + View Details/Chart actions + configurable tap`.
- [ ] **Step 4 (verify):** Phase F.

---

## Phase E — Config UI + compose default-hidden

### Task E1: Topic → Display settings

**Files:** Modify `TopicSettingsActivity.java` + its layout; reuse a colour-picker (Material or a small hue grid).

- [ ] **Step 1:** Add a **Display** section: a **Levels** editor (chip list from the palette; tap → rename/recolour/remove dialog; "+ Add level"), spinners for **Accent field / Title field / Level field**, switches for **Show strategy / Show price line / Show compose box**, and a **Notification tap opens** (Details | Chart) spinner. Persist into `topic.display` via `store.updateTopic`.
- [ ] **Step 2:** Build; commit `feat(display): per-topic Display settings (levels + fields + notifTap)`.

### Task E2: Compose box hidden by default

**Files:** Modify `TopicDetailActivity.java`.

- [ ] **Step 1:** Show `input_send`/`btn_send` only when `topic.displayOrDefault().showCompose`. (Default false → hidden.) The E1 switch toggles it.
- [ ] **Step 2:** Build; commit `feat(display): compose box hidden unless enabled`.

---

## Phase F — On-device end-to-end

- [ ] **Step 1:** Build signed release (bump `versionPatch`/`buildNumber`), **in-place install** on the daily phone (upload key → preserves claims). Publish real tagged signals (short/long, several levels) to a scratch or the live `tyostocks-signals`.
- [ ] **Step 2:** Verify: cards show accent colour + level chip; short = red notification accent; filter by level+dir narrows the list and persists; card tap + "Details" open the detail screen; "Chart" opens TradingView; `notifTap` switch changes the tap target; editing a level colour re-renders; compose box appears only when enabled.
- [ ] **Step 3:** Update memory + the design corpus; commit `chore(release): custom display vX.Y.Z`.

---

## Self-review notes

- **Spec coverage:** §2 contract → A1; §4 card/accent → A2/A3/B; §5 levels → A2/E1; §6 config → A5/E1; §7 filtering → A4/C; §8 model → A5; §9 compose → E2; §10a detail+actions → D; system-notification colour → D2. All covered.
- **Type consistency:** `MessageFields`, `LevelPalette.Level{value,label,color}`, `TopicDisplay{accentField,titleField,levelField,showStrategy,showPriceLine,showCompose,notifTap,levels}`, `Topic.filters:Map<String,List<String>>` used consistently A→F.
- **No regression:** empty-fields messages render exactly as today (B2 fallback); all new `Topic` fields nullable (existing topics + vault backup unaffected).
- **Backup:** `Topic.display`/`filters` serialize with the topic → automatically included in the account backup already built.
