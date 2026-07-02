# Prefix-scoped realm management API — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `POST /api/realms` to tyo-mq so a caller holding a prefix-scoped management token can create/rotate a realm's `manager_key`, but only for realms under its configured `realm_prefix` (e.g. `apps:tyoman:`).

**Architecture:** Extend the existing opt-in HTTP surface in `lib/server.js` (`handleHttpApiRequest`) with a single POST route. Authenticate with a new `auth.management_tokens` array (bearer secret + `realm_prefix`), enforce the prefix, then reuse the existing `applyAuthManagementCommand` — which already clones auth, mutates realms, commits via `settings.replace`, and persists via `persistSettings`. No new persistence code, no refactor of the socket path.

**Tech Stack:** Node.js, plain `http`, socket.io (unaffected), the repo's minimal test runner (`tests/runner.js` + `tests/helpers.js`).

**Spec:** `docs/specs/2026-07-02-prefix-scoped-realm-management-api.md`

---

## Key facts about the existing code (read before starting)

All line numbers are in `lib/server.js` at the time of writing; treat them as anchors, not guarantees.

- `handleHttpApiRequest(req, res)` (~line 780) returns `true` when it handled the
  request, `false` otherwise. The HTTP server wrapper (~line 50) writes a bare
  `403` when it returns `false`. It currently early-returns on any non-GET
  method (`if (req.method !== 'GET') return false;`).
- `sendJson(res, status, body)` (~line 775) writes a JSON response.
- `hashToken(token)` (~line 258) → `sha256` hex. `getAdminTokens()` (~line 109)
  returns the global `realm:'*' role:'admin'` tokens.
- `isAuthEnabled()` (~line 1048) → `!!settings.get('auth').enabled`.
- `server.authOptions` (getter, ~line 33) always returns the live
  `settings.get('auth') || {}`. Constants `REALM_ALL = '*'` (~line 64) and
  `DEFAULT_REALM = 'default'` (~line 63).
- `applyAuthManagementCommand(body)` (~line 846):
  - `add_realm` (~line 897): 400 if no `realm`, **409 if the realm already
    exists**, else sets `auth.realms[realm] = {required: body.required !== false}`
    and, when `body.manager_key` is present, `.manager_key = body.manager_key`.
  - `set_realm_manager_key` (~line 952): 400 if no `realm`, **404 if the realm
    does not exist**, else sets/deletes `.manager_key`.
  - On success it runs (~lines 990-993) `settings.replace(nextSettings)` +
    `persistSettings()` and returns `{ok: true, settings: ...}`. On failure it
    returns `{ok: false, code, message}`. **This is the shared commit+persist
    path** — the REST endpoint reuses it, so no separate helper is needed.
- Test harness: `tests/phase5-http-api.test.js` uses `startServer(options)` from
  `tests/helpers.js` (options are passed straight into the server, including
  `auth` and `http_api`), and a local `httpGet` helper. `server.server` exposes
  the live `TyoMQServer` (so tests can read `server.server.settings.get('auth')`).
  `server.server.loadSettings(path)` (~line 1558) points persistence at a file.

## File structure

- **Modify `lib/server.js`** — add three internal helpers
  (`managementTokens`, `managementTokenForRequest`, `realmAllowedForPrefix`), a
  bounded JSON body reader (`readJsonBody`), the route handler
  (`handleCreateRealmRequest`), and one POST branch inside
  `handleHttpApiRequest`. All internal `var` function-expressions in the existing
  style; nothing exported.
- **Modify `tests/phase5-http-api.test.js`** — add an `httpPost` helper and the
  new endpoint tests.
- **Modify `docs/specs/2026-07-02-prefix-scoped-realm-management-api.md`** — one
  note recording that Component 3 needed no refactor (the helper already exists).

No new files. The helpers are internal to `server.js` and exercised through the
HTTP endpoint (the module exports only the server), so tests are HTTP-integration
tests, not unit tests of private functions.

---

## Task 1: POST route skeleton + body reader + "disabled → 404"

Adds the routing and body-reading plumbing. When the endpoint is enabled
(`http_api.enabled` + `auth.enabled` + at least one `management_tokens` entry)
but the caller is unauthenticated, we still return 401 in a later task; here we
only prove the route exists when configured and returns 404 when the endpoint is
not configured, plus that non-POST behavior is unchanged.

**Files:**
- Modify: `lib/server.js` (`handleHttpApiRequest` ~line 780; new
  `readJsonBody` + `handleCreateRealmRequest` above it)
- Test: `tests/phase5-http-api.test.js`

- [ ] **Step 1: Add an `httpPost` helper to the test file**

At the top of `tests/phase5-http-api.test.js`, directly after the existing
`httpGet` function (~line 40), add:

```javascript
function httpPost(port, pathname, body, headers) {
    return new Promise((resolve) => {
        const payload = body === undefined
            ? ''
            : (typeof body === 'string' ? body : JSON.stringify(body));
        const req = http.request({
            host: '127.0.0.1',
            port: port,
            path: pathname,
            method: 'POST',
            headers: Object.assign({
                'content-type': 'application/json',
                'content-length': Buffer.byteLength(payload)
            }, headers || {}),
            timeout: 1500
        }, (res) => {
            let data = '';
            res.setEncoding('utf8');
            res.on('data', (chunk) => { data += chunk; });
            res.on('end', () => resolve({ status: res.statusCode, body: data }));
        });
        req.on('timeout', () => { req.destroy(); resolve({ status: null, body: '' }); });
        req.on('error', () => resolve({ status: null, body: '' }));
        req.end(payload);
    });
}
```

- [ ] **Step 2: Write the failing tests for routing/404**

Add these two tests just before the final `run();` line:

```javascript
test('create-realm endpoint is not served when no management token is configured', async () => {
    const server = await startServer({
        http_api: { enabled: true },
        auth: { enabled: true, tokens: [{ token: 'admin-tok', realm: '*', role: 'admin' }] }
    });
    try {
        const res = await httpPost(server.port, '/api/realms',
            { realm: 'apps:tyoman:acme', manager_key: 'k' },
            { authorization: 'Bearer admin-tok' });
        assert.strictEqual(res.status, 404, 'no management_tokens => endpoint disabled: ' + res.body);
    } finally {
        await server.close();
    }
});

test('create-realm endpoint does not exist when http_api is disabled', async () => {
    const server = await startServer({
        auth: {
            enabled: true,
            management_tokens: [{ token: 'mgmt-tok', realm_prefix: 'apps:tyoman:' }]
        }
    });
    try {
        const res = await httpPost(server.port, '/api/realms',
            { realm: 'apps:tyoman:acme', manager_key: 'k' },
            { authorization: 'Bearer mgmt-tok' });
        assert.notStrictEqual(res.status, 200, 'no http_api => no endpoint');
        assert.notStrictEqual(res.status, 404, 'no http_api => handler never reached (bare 403)');
    } finally {
        await server.close();
    }
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `node tests/phase5-http-api.test.js`
Expected: FAIL — the first test gets `403` (route not handled) instead of `404`.

- [ ] **Step 4: Add `readJsonBody` and `handleCreateRealmRequest`**

In `lib/server.js`, immediately **above** `var handleHttpApiRequest = function (req, res) {`
(~line 780), add:

```javascript
    // Read a bounded JSON request body. Calls back with (err, obj); an empty
    // body yields {}. Rejects bodies over maxBytes to avoid unbounded buffering.
    var readJsonBody = function (req, maxBytes, callback) {
        var chunks = [];
        var total = 0;
        var done = false;
        var finish = function (err, obj) {
            if (done) return;
            done = true;
            callback(err, obj);
        };
        req.on('data', function (chunk) {
            total += chunk.length;
            if (total > maxBytes) {
                finish(new Error('request body too large'), null);
                req.destroy();
                return;
            }
            chunks.push(chunk);
        });
        req.on('end', function () {
            var raw = Buffer.concat(chunks).toString('utf8');
            if (!raw) { finish(null, {}); return; }
            try { finish(null, JSON.parse(raw)); }
            catch (err) { finish(err, null); }
        });
        req.on('error', function (err) { finish(err, null); });
    };

    // POST /api/realms — create or rotate a realm's manager_key. Auth and prefix
    // enforcement are added in later steps; this skeleton only handles the
    // "endpoint not configured" case and the body plumbing.
    var handleCreateRealmRequest = function (req, res) {
        if (!isAuthEnabled() || managementTokens().length === 0) {
            sendJson(res, 404, {ok: false, code: 404, message: 'not found'});
            return;
        }
        sendJson(res, 501, {ok: false, code: 501, message: 'not implemented'});
    };
```

Note: `managementTokens()` is defined in Task 2. To keep this step self-contained
and runnable, also add the minimal definition now, directly above
`handleCreateRealmRequest`:

```javascript
    var managementTokens = function () {
        var auth = server.authOptions || {};
        return (auth.management_tokens || auth.managementTokens || []).filter(function (entry) {
            return entry && entry.token && entry.realm_prefix;
        });
    };
```

- [ ] **Step 5: Wire the POST branch into `handleHttpApiRequest`**

Change the top of `handleHttpApiRequest` so the pathname is parsed **before** the
method guard and a POST route is dispatched. Replace:

```javascript
    var handleHttpApiRequest = function (req, res) {
        var config = getHttpApiConfig();
        if (!config)
            return false;

        if (req.method !== 'GET')
            return false; // the surface is read-only by design

        var pathname;
        try {
            pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
        }
        catch (err) {
            return false;
        }
```

with:

```javascript
    var handleHttpApiRequest = function (req, res) {
        var config = getHttpApiConfig();
        if (!config)
            return false;

        var pathname;
        try {
            pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
        }
        catch (err) {
            return false;
        }

        if (req.method === 'POST' && pathname === '/api/realms') {
            handleCreateRealmRequest(req, res);
            return true;
        }

        if (req.method !== 'GET')
            return false; // the rest of the surface is read-only by design
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `node tests/phase5-http-api.test.js`
Expected: PASS for both new tests (first returns 404; second returns non-200,
non-404). All pre-existing tests still pass.

- [ ] **Step 7: Commit**

```bash
cd /data/tyolab/node/tyo-mq
git add lib/server.js tests/phase5-http-api.test.js
git commit -m "feat(server): POST /api/realms route skeleton + bounded JSON body reader

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 2: Management-token authentication (401 path)

**Files:**
- Modify: `lib/server.js` (add `managementTokenForRequest`; use it in
  `handleCreateRealmRequest`)
- Test: `tests/phase5-http-api.test.js`

- [ ] **Step 1: Write the failing auth tests**

Add before `run();`:

```javascript
test('create-realm requires a valid management bearer token', async () => {
    const mgmtToken = 'mgmt-secret-token';
    const server = await startServer({
        http_api: { enabled: true },
        auth: {
            enabled: true,
            tokens: [{ token: 'admin-tok', realm: '*', role: 'admin' }],
            management_tokens: [{ token: mgmtToken, realm_prefix: 'apps:tyoman:' }]
        }
    });
    try {
        const noAuth = await httpPost(server.port, '/api/realms',
            { realm: 'apps:tyoman:acme', manager_key: 'k' });
        assert.strictEqual(noAuth.status, 401, 'no bearer => 401: ' + noAuth.body);

        const wrong = await httpPost(server.port, '/api/realms',
            { realm: 'apps:tyoman:acme', manager_key: 'k' },
            { authorization: 'Bearer nope' });
        assert.strictEqual(wrong.status, 401, 'wrong token => 401: ' + wrong.body);

        // The global admin token is NOT accepted on this endpoint.
        const admin = await httpPost(server.port, '/api/realms',
            { realm: 'apps:tyoman:acme', manager_key: 'k' },
            { authorization: 'Bearer admin-tok' });
        assert.strictEqual(admin.status, 401, 'admin token not accepted here => 401: ' + admin.body);
    } finally {
        await server.close();
    }
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node tests/phase5-http-api.test.js`
Expected: FAIL — the endpoint currently returns `501` for all three, not `401`.

- [ ] **Step 3: Add `managementTokenForRequest` and enforce it**

In `lib/server.js`, directly below the `managementTokens` helper added in Task 1,
add:

```javascript
    var managementTokenForRequest = function (req) {
        var header = req.headers['authorization'] || '';
        var match = header.match(/^Bearer\s+(.+)$/i);
        if (!match)
            return null;
        var provided = hashToken(match[1]);
        var tokens = managementTokens();
        for (var i = 0; i < tokens.length; i++) {
            if (hashToken(tokens[i].token) === provided)
                return {token: tokens[i].token, realm_prefix: tokens[i].realm_prefix};
        }
        return null;
    };
```

Then update `handleCreateRealmRequest`: replace the trailing `sendJson(res, 501, ...)`
line with the auth check (the body/upsert logic is added in Task 3):

```javascript
    var handleCreateRealmRequest = function (req, res) {
        if (!isAuthEnabled() || managementTokens().length === 0) {
            sendJson(res, 404, {ok: false, code: 404, message: 'not found'});
            return;
        }
        var entry = managementTokenForRequest(req);
        if (!entry) {
            sendJson(res, 401, {ok: false, code: 401, message: 'management token required'});
            return;
        }
        sendJson(res, 501, {ok: false, code: 501, message: 'not implemented'});
    };
```

- [ ] **Step 4: Run to verify it passes**

Run: `node tests/phase5-http-api.test.js`
Expected: PASS — all three cases return `401`. Task 1 tests still pass.

- [ ] **Step 5: Commit**

```bash
cd /data/tyolab/node/tyo-mq
git add lib/server.js tests/phase5-http-api.test.js
git commit -m "feat(server): authenticate POST /api/realms with prefix-scoped management token

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 3: Prefix validation + create/rotate + persistence

Completes the endpoint: validate the body, enforce the prefix, upsert via
`applyAuthManagementCommand`, and return the success shape. Also proves the key
lands in memory, rotates, and persists to the settings file.

**Files:**
- Modify: `lib/server.js` (add `realmAllowedForPrefix`; finish
  `handleCreateRealmRequest`)
- Test: `tests/phase5-http-api.test.js`
- Modify: `docs/specs/2026-07-02-prefix-scoped-realm-management-api.md`

- [ ] **Step 1: Write the failing behavior tests**

Add before `run();`. These reuse one server per test for isolation:

```javascript
test('create-realm creates an in-prefix realm and stores its manager_key', async () => {
    const mgmtToken = 'mgmt-create-token';
    const server = await startServer({
        http_api: { enabled: true },
        auth: {
            enabled: true,
            management_tokens: [{ token: mgmtToken, realm_prefix: 'apps:tyoman:' }]
        }
    });
    const auth = { authorization: 'Bearer ' + mgmtToken };
    try {
        const created = await httpPost(server.port, '/api/realms',
            { realm: 'apps:tyoman:acme', manager_key: 'key-one' }, auth);
        assert.strictEqual(created.status, 200, created.body);
        const body = JSON.parse(created.body);
        assert.strictEqual(body.ok, true);
        assert.strictEqual(body.realm, 'apps:tyoman:acme');
        assert.strictEqual(body.created, true);
        assert.strictEqual(body.manager_key_configured, true);
        assert.ok(!('manager_key' in body), 'manager_key must never be echoed');

        // The key actually landed in the live settings.
        const realms = server.server.settings.get('auth').realms || {};
        assert.strictEqual(realms['apps:tyoman:acme'].manager_key, 'key-one');
        assert.strictEqual(realms['apps:tyoman:acme'].required, true);

        // Rotate: same realm, new key => created:false, key replaced.
        const rotated = await httpPost(server.port, '/api/realms',
            { realm: 'apps:tyoman:acme', manager_key: 'key-two' }, auth);
        assert.strictEqual(rotated.status, 200, rotated.body);
        assert.strictEqual(JSON.parse(rotated.body).created, false);
        const realmsAfter = server.server.settings.get('auth').realms || {};
        assert.strictEqual(realmsAfter['apps:tyoman:acme'].manager_key, 'key-two');
    } finally {
        await server.close();
    }
});

test('create-realm rejects realms outside the token prefix and reserved realms', async () => {
    const mgmtToken = 'mgmt-prefix-token';
    const server = await startServer({
        http_api: { enabled: true },
        auth: {
            enabled: true,
            management_tokens: [{ token: mgmtToken, realm_prefix: 'apps:tyoman:' }]
        }
    });
    const auth = { authorization: 'Bearer ' + mgmtToken };
    try {
        const cases = ['org:evil', 'apps:tyoman:', '*', 'default', 'apps:other:x'];
        for (const realm of cases) {
            const res = await httpPost(server.port, '/api/realms',
                { realm: realm, manager_key: 'k' }, auth);
            assert.strictEqual(res.status, 403, 'realm "' + realm + '" must be 403: ' + res.body);
        }
        // Nothing was created.
        const realms = server.server.settings.get('auth').realms || {};
        assert.ok(!realms['org:evil'] && !realms['apps:other:x'], 'no rejected realm should exist');
    } finally {
        await server.close();
    }
});

test('create-realm validates the request body', async () => {
    const mgmtToken = 'mgmt-body-token';
    const server = await startServer({
        http_api: { enabled: true },
        auth: {
            enabled: true,
            management_tokens: [{ token: mgmtToken, realm_prefix: 'apps:tyoman:' }]
        }
    });
    const auth = { authorization: 'Bearer ' + mgmtToken };
    try {
        const noRealm = await httpPost(server.port, '/api/realms', { manager_key: 'k' }, auth);
        assert.strictEqual(noRealm.status, 400, noRealm.body);

        const noKey = await httpPost(server.port, '/api/realms', { realm: 'apps:tyoman:acme' }, auth);
        assert.strictEqual(noKey.status, 400, noKey.body);

        const badJson = await httpPost(server.port, '/api/realms', 'not-json{', auth);
        assert.strictEqual(badJson.status, 400, badJson.body);
    } finally {
        await server.close();
    }
});

test('create-realm persists the new realm to the settings file', async () => {
    const os = require('os');
    const path = require('path');
    const fs = require('fs');
    const mgmtToken = 'mgmt-persist-token';
    const settingsPath = path.join(os.tmpdir(), 'tyo-mq-mgmt-' + process.pid + '-' + Date.now() + '.json');
    const server = await startServer({
        http_api: { enabled: true },
        auth: {
            enabled: true,
            management_tokens: [{ token: mgmtToken, realm_prefix: 'apps:tyoman:' }]
        }
    });
    server.server.loadSettings(settingsPath);
    const auth = { authorization: 'Bearer ' + mgmtToken };
    try {
        const res = await httpPost(server.port, '/api/realms',
            { realm: 'apps:tyoman:persist', manager_key: 'persist-key' }, auth);
        assert.strictEqual(res.status, 200, res.body);
        // writeSettingsFile is synchronous, so the file is written by the time
        // the response returns.
        const onDisk = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
        assert.strictEqual(onDisk.auth.realms['apps:tyoman:persist'].manager_key, 'persist-key');
    } finally {
        await server.close();
        try { require('fs').unlinkSync(settingsPath); } catch (e) { /* ignore */ }
    }
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `node tests/phase5-http-api.test.js`
Expected: FAIL — the endpoint still returns `501` for the create/rotate/validate
cases.

- [ ] **Step 3: Add `realmAllowedForPrefix`**

In `lib/server.js`, directly below `managementTokenForRequest`, add:

```javascript
    // A management token may only touch realms under its prefix, and never the
    // wildcard/default realms or the bare prefix itself.
    var realmAllowedForPrefix = function (realm, prefix) {
        if (!prefix || typeof realm !== 'string')
            return false;
        if (realm === REALM_ALL || realm === DEFAULT_REALM)
            return false;
        return realm.indexOf(prefix) === 0 && realm.length > prefix.length;
    };
```

- [ ] **Step 4: Finish `handleCreateRealmRequest`**

Replace the trailing `sendJson(res, 501, ...)` line in `handleCreateRealmRequest`
with the body read + validation + upsert:

```javascript
        readJsonBody(req, 64 * 1024, function (err, body) {
            if (err) {
                sendJson(res, 400, {ok: false, code: 400, message: 'invalid JSON body'});
                return;
            }
            body = body || {};
            var realm = body.realm;
            var managerKey = body.manager_key || body.managerKey;
            if (typeof realm !== 'string' || !realm) {
                sendJson(res, 400, {ok: false, code: 400, message: 'realm is required'});
                return;
            }
            if (typeof managerKey !== 'string' || !managerKey) {
                sendJson(res, 400, {ok: false, code: 400, message: 'manager_key is required'});
                return;
            }
            if (!realmAllowedForPrefix(realm, entry.realm_prefix)) {
                sendJson(res, 403, {ok: false, code: 403, message: 'realm outside managed prefix'});
                return;
            }
            var existed = !!(server.authOptions.realms && server.authOptions.realms[realm]);
            var result = existed
                ? applyAuthManagementCommand({command: 'set_realm_manager_key', realm: realm, manager_key: managerKey})
                : applyAuthManagementCommand({command: 'add_realm', realm: realm, required: true, manager_key: managerKey});
            if (!result || !result.ok) {
                var code = (result && result.code) || 500;
                sendJson(res, code, {ok: false, code: code, message: (result && result.message) || 'realm update failed'});
                return;
            }
            sendJson(res, 200, {ok: true, realm: realm, created: !existed, manager_key_configured: true});
        });
```

The full `handleCreateRealmRequest` now reads:

```javascript
    var handleCreateRealmRequest = function (req, res) {
        if (!isAuthEnabled() || managementTokens().length === 0) {
            sendJson(res, 404, {ok: false, code: 404, message: 'not found'});
            return;
        }
        var entry = managementTokenForRequest(req);
        if (!entry) {
            sendJson(res, 401, {ok: false, code: 401, message: 'management token required'});
            return;
        }
        readJsonBody(req, 64 * 1024, function (err, body) {
            if (err) {
                sendJson(res, 400, {ok: false, code: 400, message: 'invalid JSON body'});
                return;
            }
            body = body || {};
            var realm = body.realm;
            var managerKey = body.manager_key || body.managerKey;
            if (typeof realm !== 'string' || !realm) {
                sendJson(res, 400, {ok: false, code: 400, message: 'realm is required'});
                return;
            }
            if (typeof managerKey !== 'string' || !managerKey) {
                sendJson(res, 400, {ok: false, code: 400, message: 'manager_key is required'});
                return;
            }
            if (!realmAllowedForPrefix(realm, entry.realm_prefix)) {
                sendJson(res, 403, {ok: false, code: 403, message: 'realm outside managed prefix'});
                return;
            }
            var existed = !!(server.authOptions.realms && server.authOptions.realms[realm]);
            var result = existed
                ? applyAuthManagementCommand({command: 'set_realm_manager_key', realm: realm, manager_key: managerKey})
                : applyAuthManagementCommand({command: 'add_realm', realm: realm, required: true, manager_key: managerKey});
            if (!result || !result.ok) {
                var code = (result && result.code) || 500;
                sendJson(res, code, {ok: false, code: code, message: (result && result.message) || 'realm update failed'});
                return;
            }
            sendJson(res, 200, {ok: true, realm: realm, created: !existed, manager_key_configured: true});
        });
    };
```

- [ ] **Step 5: Run to verify all tests pass**

Run: `node tests/phase5-http-api.test.js`
Expected: PASS for all new tests and all pre-existing tests.

- [ ] **Step 6: Record the Component-3 simplification in the spec**

In `docs/specs/2026-07-02-prefix-scoped-realm-management-api.md`, under
"### Component 3 — shared apply/persist helper (DRY)", append:

```markdown

**Implementation note (2026-07-02):** No refactor was needed. `applyAuthManagementCommand`
already performs the commit (`settings.replace`) and persist (`persistSettings`)
internally; the socket handler simply calls it. The REST endpoint calls the same
function, so both paths share commit/persist by construction.
```

- [ ] **Step 7: Run the full test suite**

Run: `npm test`
Expected: the full suite passes (or, if `npm test` runs many files, at least no
new failures are introduced and `phase5-http-api.test.js` passes).

- [ ] **Step 8: Commit**

```bash
cd /data/tyolab/node/tyo-mq
git add lib/server.js tests/phase5-http-api.test.js docs/specs/2026-07-02-prefix-scoped-realm-management-api.md
git commit -m "feat(server): create/rotate realms via POST /api/realms with prefix enforcement

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Verification checklist (after all tasks)

- `node tests/phase5-http-api.test.js` — all tests pass.
- `npm test` — no new failures.
- Manual sanity (optional, local): start a server with
  `http_api.enabled`, `auth.enabled`, and a `management_tokens` entry; `curl -X POST`
  `/api/realms` with the bearer token for `apps:tyoman:demo` → `200 {created:true}`;
  repeat → `created:false`; try `org:x` → `403`; drop the token → `401`.

## Out of scope (per spec)

- `require_acceptance`/approval semantics (sub-project 3).
- Realm delete/rename over REST.
- tyoman-server changes (sub-project 2).
- Rollout (add `management_tokens` to prod settings, sync, `pm2 restart`) — user-run.
