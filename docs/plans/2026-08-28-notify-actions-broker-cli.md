# Notify actions + reply topics (broker + CLI) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Broker half of the actionable-notifications design: validated ntfy-format
`actions` pass-through on published messages (cap 6, https-only, fail-loud),
content→wake push downgrade when actions don't fit FCM, and a headless
`notify-cli` (keygen/claim/publish/listen) so pipelines can participate in
private topics. App half is a separate plan in the tyonotify repo.

**Architecture:** `actions` validation lives in `lib/notify.js` (pure,
JVM-of-node-testable like the rest of that module); the publish path in
`lib/server.js` rejects invalid actions with 400 before building the message;
`lib/push.js deliverNotifyPush` carries actions in content-mode FCM payloads
with an automatic per-push wake downgrade when oversized. The CLI is a single
`bin/notify-cli.js` reusing `lib/notify-auth.js`.

**Tech Stack:** Node.js, no new dependencies. Repo test runner
(`tests/runner.js` + `tests/helpers.js`).

**Spec:** `docs/specs/2026-08-28-notify-actions-reply-topics-design.md`

---

## Key facts about the existing code (read before starting)

- `lib/notify.js` — pure message model. `buildMessage(opts)` builds the
  ntfy-shaped message; existing caps `MAX_TAGS=20`, `MAX_TAG_LEN=64`,
  `MAX_TITLE_LEN=256`, `MAX_CLICK_LEN=2048` (lines ~39-42). Unit tests:
  `tests/notify-unit.test.js`.
- `lib/server.js` publish path: `handleNotifyRequest` — JSON form parses the
  body into `fields` (`fields = parsed`, ~line 4235); `Notify.buildMessage({...})`
  call at ~line 4267 with explicit field picks (actions must be added there);
  invalid-topic 400s use `sendJson(res, 400, {ok:false, code:400, message})`.
  Path form (`topicFromPath` set) gets fields from HEADERS — per the spec,
  actions are **JSON-form only** (the path form never carries them; ntfy's
  compact `Actions:` header grammar is out of scope).
- `lib/push.js` — `buildNotifyPayload(msg, mode)` (~line 1573) builds the FCM
  data payload (string values only; `NOTIFY_PUSH_MSG_MAX=1024`, title ≤ 256,
  tags ≤ 256, click ≤ 512 — all capped to stay under FCM's 4KB);
  `deliverNotifyPush(cfg, registry, realm, topic, msg, mode, opts)` (~line
  1594) sends per endpoint. Tests: `tests/notify-push.test.js` (uses the
  recording NullTransport via `TYO_MQ_PUSH_TRANSPORT=null`).
- `lib/notify-auth.js` — private-topic crypto: `signatureBase`, `verifyProof`,
  `generatePublishToken`, etc. `tests/notify-claim.test.js` shows exactly how
  a client claims / signs reads / uses sse-tickets (the CLI mirrors these
  flows; its `claimBody`/`signedGetHeaders` helpers are the reference).
- `bin/` currently has `tyo-mq-server` and `web`; `package.json` has a `bin`
  map — check it before adding the CLI entry.
- Grep gotcha: `lib/server.js` contains a NUL byte — use `grep -a`.
- Test-run convention: `node tests/<file>.test.js`; wire every new test file
  into `package.json`'s `test` chain (a review caught this being forgotten
  twice on the private-topics branch — do not repeat it).

---

## Task 1: `lib/notify.js` — actions validation + buildMessage pass-through

**Files:**
- Modify: `lib/notify.js`
- Test: `tests/notify-unit.test.js` (append)

- [ ] **Step 1: Append failing tests**

```js
// append to tests/notify-unit.test.js before run():

// ── actions (ntfy subset) ─────────────────────────────────────────────────────
function httpAction (over) {
    return Object.assign({
        action: 'http', label: 'Approve',
        url: 'https://example.com/notify/replies',
        method: 'POST', body: 'approve',
        headers: { Authorization: 'Bearer tok' }
    }, over || {});
}

test('validateActions accepts a valid http+view set and normalizes it', async () => {
    const r = N.validateActions([httpAction(), { action: 'view', label: 'Details', url: 'https://x.example/d' }]);
    assert.strictEqual(r.error, undefined);
    assert.strictEqual(r.actions.length, 2);
    assert.strictEqual(r.actions[0].action, 'http');
    assert.strictEqual(r.actions[0].method, 'POST');
    assert.strictEqual(r.actions[1].action, 'view');
    assert.strictEqual(r.actions[1].method, undefined, 'view carries no method');
});

test('validateActions rejects: too many, bad type, http url, missing fields, bad method', async () => {
    assert.ok(N.validateActions(Array.from({length: 7}, () => httpAction())).error, '7 > cap 6');
    assert.ok(N.validateActions([httpAction({action: 'broadcast'})]).error, 'unknown type');
    assert.ok(N.validateActions([httpAction({url: 'http://insecure.example/x'})]).error, 'https only');
    assert.ok(N.validateActions([httpAction({label: ''})]).error, 'label required');
    assert.ok(N.validateActions([httpAction({url: undefined})]).error, 'url required');
    assert.ok(N.validateActions([httpAction({method: 'TRACE'})]).error, 'method allow-list');
    assert.ok(N.validateActions(['junk']).error, 'entries must be objects');
    assert.ok(N.validateActions('junk').error, 'must be an array');
});

test('validateActions enforces length caps', async () => {
    assert.ok(N.validateActions([httpAction({label: 'x'.repeat(65)})]).error);
    assert.ok(N.validateActions([httpAction({url: 'https://e.x/' + 'a'.repeat(2049)})]).error);
    assert.ok(N.validateActions([httpAction({body: 'x'.repeat(1025)})]).error);
    const manyHeaders = {}; for (let i = 0; i < 9; i++) manyHeaders['h' + i] = 'v';
    assert.ok(N.validateActions([httpAction({headers: manyHeaders})]).error, 'max 8 headers');
    assert.ok(N.validateActions([httpAction({headers: {A: 'v'.repeat(257)}})]).error, 'header value cap');
});

test('buildMessage carries validated actions; omits when absent', async () => {
    const withA = N.buildMessage({ topic: 't', message: 'm', actions: N.validateActions([httpAction()]).actions });
    assert.strictEqual(withA.actions.length, 1);
    const without = N.buildMessage({ topic: 't', message: 'm' });
    assert.strictEqual(without.actions, undefined);
});
```

- [ ] **Step 2: Run** `node tests/notify-unit.test.js` — new tests fail
  (`validateActions` missing).

- [ ] **Step 3: Implement in `lib/notify.js`**

Add after the tags section (near the other caps), following the module's
existing comment style:

```js
// ── actions (ntfy subset; spec 2026-08-28) ────────────────────────────────────
// Buttons the phone renders (shade: first 3, card: all). Cap 6 (laxer than
// ntfy's 3, format-identical). https-only; fail-loud — the publish path 400s
// on any violation rather than silently stripping a pipeline's buttons.
var MAX_ACTIONS = 6;
var MAX_ACTION_LABEL = 64;
var MAX_ACTION_URL = 2048;
var MAX_ACTION_BODY = 1024;
var MAX_ACTION_HEADERS = 8;
var MAX_ACTION_HEADER_LEN = 256;
var ACTION_METHODS = ['GET', 'POST', 'PUT', 'DELETE'];

// Returns {actions: [...normalized]} or {error: 'reason'}. Never throws.
function validateActions (raw) {
    if (!Array.isArray(raw)) return { error: 'actions must be an array' };
    if (raw.length > MAX_ACTIONS) return { error: 'too many actions (max ' + MAX_ACTIONS + ')' };
    var out = [];
    for (var i = 0; i < raw.length; i++) {
        var a = raw[i];
        if (!a || typeof a !== 'object' || Array.isArray(a))
            return { error: 'action ' + i + ': must be an object' };
        if (a.action !== 'http' && a.action !== 'view')
            return { error: 'action ' + i + ": type must be 'http' or 'view'" };
        if (typeof a.label !== 'string' || !a.label || a.label.length > MAX_ACTION_LABEL)
            return { error: 'action ' + i + ': label required (max ' + MAX_ACTION_LABEL + ')' };
        if (typeof a.url !== 'string' || a.url.indexOf('https://') !== 0 || a.url.length > MAX_ACTION_URL)
            return { error: 'action ' + i + ': url must be https (max ' + MAX_ACTION_URL + ')' };
        var norm = { action: a.action, label: a.label, url: a.url };
        if (a.action === 'http') {
            var method = a.method === undefined ? 'POST' : String(a.method).toUpperCase();
            if (ACTION_METHODS.indexOf(method) === -1)
                return { error: 'action ' + i + ': method must be one of ' + ACTION_METHODS.join('/') };
            norm.method = method;
            if (a.body !== undefined) {
                if (typeof a.body !== 'string' || a.body.length > MAX_ACTION_BODY)
                    return { error: 'action ' + i + ': body must be a string (max ' + MAX_ACTION_BODY + ')' };
                norm.body = a.body;
            }
            if (a.headers !== undefined) {
                if (!a.headers || typeof a.headers !== 'object' || Array.isArray(a.headers))
                    return { error: 'action ' + i + ': headers must be an object' };
                var keys = Object.keys(a.headers);
                if (keys.length > MAX_ACTION_HEADERS)
                    return { error: 'action ' + i + ': too many headers (max ' + MAX_ACTION_HEADERS + ')' };
                var headers = {};
                for (var k = 0; k < keys.length; k++) {
                    var v = a.headers[keys[k]];
                    if (typeof v !== 'string' || v.length > MAX_ACTION_HEADER_LEN || keys[k].length > MAX_ACTION_HEADER_LEN)
                        return { error: 'action ' + i + ': header entries must be strings (max ' + MAX_ACTION_HEADER_LEN + ')' };
                    headers[keys[k]] = v;
                }
                norm.headers = headers;
            }
        }
        out.push(norm);
    }
    return { actions: out };
}
```

In `buildMessage`, after the `click` line, add:

```js
    if (Array.isArray(opts.actions) && opts.actions.length) msg.actions = opts.actions;
```

Export `validateActions` and `MAX_ACTIONS` from `module.exports`.

- [ ] **Step 4: Run** `node tests/notify-unit.test.js` — all pass.
- [ ] **Step 5: Commit**

```bash
git add lib/notify.js tests/notify-unit.test.js
git commit -m "feat(notify): validate + carry ntfy-format actions on messages"
```

---

## Task 2: publish path — 400 on bad actions, carry on good (JSON form only)

**Files:**
- Modify: `lib/server.js`
- Test: `tests/notify.test.js` (append)

- [ ] **Step 1: Append failing tests** (reuse the file's `httpRequest` helper;
  actions ride the JSON publish form `POST /notify {topic, ...}`):

```js
test('JSON publish with valid actions delivers them to a poller', async () => {
    const server = await startServer({ notify: { enabled: true } });
    try {
        const pub = await httpRequest(server.port, 'POST', '/notify', { body: JSON.stringify({
            topic: 'act1', message: 'approve?',
            actions: [{ action: 'http', label: 'Approve', url: 'https://e.x/notify/r', method: 'POST', body: 'ok' }]
        })});
        assert.strictEqual(pub.status, 200, JSON.stringify(pub));
        assert.strictEqual(pub.json.actions.length, 1);

        const poll = await httpRequest(server.port, 'GET', '/notify/act1/json?poll=1&since=all');
        assert.ok(poll.body.includes('"actions"'), 'ring carries actions');
        assert.ok(poll.body.includes('"Approve"'));
    } finally { await server.close(); }
});

test('JSON publish with invalid actions is 400, not silently stripped', async () => {
    const server = await startServer({ notify: { enabled: true } });
    try {
        const bad = await httpRequest(server.port, 'POST', '/notify', { body: JSON.stringify({
            topic: 'act2', message: 'x',
            actions: [{ action: 'http', label: 'A', url: 'http://insecure/x' }]
        })});
        assert.strictEqual(bad.status, 400, JSON.stringify(bad));
        // Nothing landed on the topic.
        const poll = await httpRequest(server.port, 'GET', '/notify/act2/json?poll=1&since=all');
        assert.ok(!poll.body.includes('"actions"'));
    } finally { await server.close(); }
});
```

(Check the file's `httpRequest` signature first — if `body` is already
JSON-stringified by the helper, pass the object per the existing JSON-form
tests like "POST /notify (JSON body) publishes with the topic from the body".)

- [ ] **Step 2: Run to verify the valid-actions test fails** (actions currently
  dropped by buildMessage's field picks).

- [ ] **Step 3: Implement in `lib/server.js`** — in `handleNotifyRequest`'s
  publish path, after the topic validity check (and after the JSON-body
  publish-auth gate), add before `Notify.buildMessage`:

```js
                // Actions (ntfy subset) — JSON form only; fail-loud per spec.
                var validatedActions;
                if (fields && fields.actions !== undefined) {
                    var av = Notify.validateActions(fields.actions);
                    if (av.error) {
                        sendJson(res, 400, {ok: false, code: 400, message: 'invalid actions: ' + av.error});
                        return;
                    }
                    validatedActions = av.actions;
                }
```

and add `actions: validatedActions,` to the `Notify.buildMessage({...})` call.
(The path form's `fields` never has `.actions` — headers only — so this is
naturally JSON-form-only; no extra guard needed.)

- [ ] **Step 4: Run** `node tests/notify.test.js` — all pass.
- [ ] **Step 5: Commit**

```bash
git add lib/server.js tests/notify.test.js
git commit -m "feat(notify): JSON publish carries validated actions; 400 on invalid"
```

---

## Task 3: content-mode FCM — actions in payload + auto wake-downgrade

**Files:**
- Modify: `lib/push.js`
- Test: `tests/notify-push.test.js` (append)

- [ ] **Step 1: Append failing tests** (this file boots servers with
  `TYO_MQ_PUSH_TRANSPORT=null` and inspects the NullTransport's recorded
  sends — follow its existing register+publish pattern exactly):

```js
test('content push carries actions JSON when they fit', async () => {
    // register a device on topic, publish content-mode message WITH actions,
    // assert the recorded FCM payload has p.actions (JSON string) and
    // p.message (still content mode).
});

test('content push downgrades to wake when actions would overflow the payload', async () => {
    // publish content-mode with actions whose total size pushes the payload
    // past the cap (e.g. 6 actions with 1KB bodies + near-1KB message):
    // recorded payload must be a WAKE payload (p.wake === '1', no p.message)
    // — never a content payload with silently-dropped actions.
});
```

Write these as real tests against the recorded transport (the file's existing
tests show the register/publish/read-back mechanics); the comments above are
the spec of each.

- [ ] **Step 2: Run to verify they fail.**

- [ ] **Step 3: Implement in `lib/push.js`** — in `buildNotifyPayload(msg, mode)`:
  content branch additionally sets `p.actions = JSON.stringify(msg.actions)`
  when `msg.actions` is present. Then in `deliverNotifyPush`, after building
  the content payload, measure it (`JSON.stringify(payload).length`) against a
  new `NOTIFY_PUSH_TOTAL_MAX = 3500` (headroom under FCM's 4096); if over AND
  the message has actions, rebuild with `buildNotifyPayload(msg, 'wake')` and
  proceed as wake for that push (comment: fidelity over content — the app
  fetches the full message, buttons intact). Keep the existing per-field caps
  untouched.

- [ ] **Step 4: Run** `node tests/notify-push.test.js` — all pass.
- [ ] **Step 5: Commit**

```bash
git add lib/push.js tests/notify-push.test.js
git commit -m "feat(push): content-mode carries actions; auto-downgrade to wake when oversized"
```

---

## Task 4: `bin/notify-cli.js` — keygen / claim / publish / poll / listen

**Files:**
- Create: `bin/notify-cli.js`
- Modify: `package.json` (bin entry `"tyo-notify": "bin/notify-cli.js"` +
  test chain)
- Test: `tests/notify-cli.test.js`

Single-file CLI, no new deps. Shape:

```
tyo-notify keygen  [--dir ~/.config/tyo-notify]
tyo-notify claim   <topic> --server https://freemq.tyo.com.au   # prints token ONCE
tyo-notify publish <topic> --server URL --token-file F [--title T] [--priority N]
                   [--push wake|content] [--actions-json FILE|-] [message|-]
tyo-notify poll    <topic> --server URL [--since all|id|dur] [--json]
tyo-notify listen  <topic> --server URL [--json]                # SSE, ticket per reconnect
```

Implementation notes (the crypto/wire mechanics are already proven in
`tests/notify-claim.test.js` — mirror its `claimBody`/`signedGetHeaders`/
sse-ticket helpers, sourcing the key from PEM files instead of in-memory):

- `keygen`: `crypto.generateKeyPairSync('ec', {namedCurve: 'prime256v1'})`,
  write `key.pem` (pkcs8) + `pub.pem` (spki) mode 0600 under the dir; refuse
  to overwrite an existing key without `--force`.
- `claim`: signed body per the convention (action `'claim'`, body
  `{topic, pubkey, transport: 'null', token: 'none'}` — headless participants
  have no FCM); prints `publish_token` to stdout ONCE with a "store this now"
  warning to stderr.
- `publish`: bearer publish; `--actions-json` value is passed through
  verbatim (the broker validates; CLI just surfaces the 400 message).
- `poll`: signed `X-Tyo-Notify-*` headers (action `'json'`, body `{topic}`);
  plain text lines by default, raw ND-JSON with `--json`.
- `listen`: loop — `sse-ticket` (signed) → open SSE with `?ticket=` → print
  each `message` event; on drop, new ticket + reconnect with capped backoff
  (mirror the app's SseService semantics: fresh single-use ticket EVERY
  reconnect).
- Works against UNCLAIMED topics too (no key needed for poll/listen/publish
  then) — degrade gracefully when no keyfile exists.
- Exit codes: 0 ok, 1 usage, 2 HTTP/auth failure (stderr gets the broker's
  message).

**Tests** (`tests/notify-cli.test.js`): spawn the CLI as a child process
(`child_process.execFile('node', ['bin/notify-cli.js', ...])`) against
`startServer({notify: {enabled: true}, notify_store: {...tmp}})` with
`--dir` pointed at a tmp keydir: keygen creates 0600 PEMs; claim prints a
64-char token and the topic 409s on re-claim; publish with token → 200, and
without → exit 2 on the claimed topic; poll (signed) returns the published
message; publish `--actions-json` with an invalid action surfaces the
broker's 400 text and exits 2. (listen/SSE is exercised in Task 5's e2e, not
unit-tested here.)

- [ ] **Step 1:** tests first (they fail: no bin). **Step 2:** implement.
- [ ] **Step 3:** `node tests/notify-cli.test.js` + full `npm test` green
  (chain updated). **Step 4: Commit**

```bash
git add bin/notify-cli.js package.json tests/notify-cli.test.js
git commit -m "feat(cli): tyo-notify headless CLI - keygen/claim/publish/poll/listen"
```

---

## Task 5: end-to-end reply-topic loop + docs

**Files:**
- Test: `tests/notify-actions-e2e.test.js` (new)
- Modify: `docs/specs/2026-08-28-notify-actions-reply-topics-design.md` (status)
- Modify: `package.json` test chain

- [ ] **Step 1: The acceptance test, machine-side half** (the phone's role is
  played by a script — the real phone tap is the app plan's e2e): boot a
  broker; "pipeline" (CLI or direct helpers) claims `alerts-x` and
  `replies-x`; publishes to `alerts-x` an actionable message whose Approve
  action's url/token point at `replies-x`; a "phone" stand-in polls
  `alerts-x` (signed), reads the action, and fires it EXACTLY as the app
  will (POST action.url with action.headers/body); the pipeline's signed
  poll of `replies-x` sees "approve". Assert the loop end to end, plus: a
  stranger's signed poll of `replies-x` is 401.

- [ ] **Step 2:** full `npm test` green; spec Status → "Implemented (broker +
  CLI). App half: tyonotify repo plan."

- [ ] **Step 3: Commit**

```bash
git add tests/notify-actions-e2e.test.js package.json docs/specs/2026-08-28-notify-actions-reply-topics-design.md
git commit -m "test(notify): end-to-end reply-topic loop; mark broker+CLI implemented"
```

---

## After all tasks

**superpowers:finishing-a-development-branch**, then the tyonotify app plan
(`docs/plans/2026-08-28-notify-actions-app.md` in that repo): NotifyMessage
actions parsing, shade buttons (first 3) + tap-fire receiver with in-place
notification updates, card buttons (all) + responded-state store, FCM
content-payload actions parse, on-device e2e with the CLI from this plan.
Deploy to freemq only after both halves are done.
