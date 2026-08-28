// tests/notify-actions-e2e.test.js
/**
 * TYO Notify actionable notifications — the end-to-end reply-topic loop
 * (spec docs/specs/2026-08-28-notify-actions-reply-topics-design.md §7,
 * machine-side half — the phone's role is played by a stand-in here; the
 * real phone tap is exercised by the tyonotify app repo's e2e).
 *
 * The loop under test:
 *   pipeline claims  alerts-x  and  replies-x  (private topics, one keypair)
 *   pipeline ──publish {actions:[Approve→replies-x]}──▶ alerts-x
 *   phone    ──signed poll──▶ alerts-x, reads the Approve action
 *   phone    ──fires action verbatim (method/url/headers/body)──▶ replies-x
 *   pipeline ──signed poll──▶ replies-x, sees "approve"
 *   stranger ──signed poll──▶ replies-x → 401
 *
 * Usage: node tests/notify-actions-e2e.test.js
 */

'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { test, run } = require('./runner');
const { startServer } = require('./helpers');
const notifyAuth = require('../lib/notify-auth');

// ── low-level helpers (same mechanics as tests/notify-claim.test.js) ──────────

// JSON request/response (claim, JSON-form publish).
function httpRequest (port, method, pathname, opts) {
    opts = opts || {};
    return new Promise((resolve) => {
        const payload = opts.body === undefined ? '' : JSON.stringify(opts.body);
        const headers = Object.assign({ 'content-type': 'application/json' }, opts.headers || {});
        headers['content-length'] = Buffer.byteLength(payload);
        const req = http.request({ host: '127.0.0.1', port, path: pathname, method, headers, timeout: 3000 }, (res) => {
            let data = '';
            res.setEncoding('utf8');
            res.on('data', (c) => { data += c; });
            res.on('end', () => {
                let json = null;
                try { json = data ? JSON.parse(data) : null; } catch (e) { /* leave null */ }
                resolve({ status: res.statusCode, json, text: data });
            });
        });
        req.on('timeout', () => { req.destroy(); resolve({ status: null, json: null, text: '' }); });
        req.on('error', () => resolve({ status: null, json: null, text: '' }));
        req.end(payload);
    });
}

// Raw request — body sent verbatim, headers passed through untouched. This is
// what the phone's action-fire uses so the test proves the action's recorded
// method/headers/body are sufficient AS-IS (no client-side embellishment).
function rawRequest (port, method, pathname, headers, body) {
    return new Promise((resolve) => {
        const payload = body === undefined ? '' : String(body);
        const h = Object.assign({}, headers || {});
        h['content-length'] = Buffer.byteLength(payload);
        const req = http.request({ host: '127.0.0.1', port, path: pathname, method, headers: h, timeout: 3000 }, (res) => {
            let data = '';
            res.setEncoding('utf8');
            res.on('data', (c) => { data += c; });
            res.on('end', () => {
                let json = null;
                try { json = data ? JSON.parse(data) : null; } catch (e) { /* leave null */ }
                resolve({ status: res.statusCode, json, text: data });
            });
        });
        req.on('timeout', () => { req.destroy(); resolve({ status: null, json: null, text: '' }); });
        req.on('error', () => resolve({ status: null, json: null, text: '' }));
        req.end(payload);
    });
}

function genKeyPair () {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    return { pubkey: publicKey.export({ type: 'spki', format: 'der' }).toString('base64'), privateKey };
}

function claimBody (privateKey, topic, extra) {
    const now = Date.now();
    const nonce = crypto.randomBytes(8).toString('hex');
    const body = Object.assign({ topic: topic }, extra);
    const base = notifyAuth.signatureBase('claim', body, now, nonce);
    const signature = crypto.sign('sha256', Buffer.from(base), privateKey).toString('base64');
    return Object.assign({}, body, { timestamp: now, nonce: nonce, signature: signature });
}

function signedGetHeaders (privateKey, action, topic) {
    const now = Date.now();
    const nonce = crypto.randomBytes(8).toString('hex');
    const base = notifyAuth.signatureBase(action, { topic: topic }, now, nonce);
    const signature = crypto.sign('sha256', Buffer.from(base), privateKey).toString('base64');
    return {
        'x-tyo-notify-timestamp': String(now),
        'x-tyo-notify-nonce': nonce,
        'x-tyo-notify-signature': signature
    };
}

// Signed catch-up poll of a claimed topic. `/json?poll=1&since=all` drains the
// retained window as ndjson and closes; returns the parsed `message` events.
async function signedPollMessages (port, privateKey, topic) {
    const res = await httpRequest(port, 'GET', `/notify/${topic}/json?poll=1&since=all`, {
        headers: signedGetHeaders(privateKey, 'json', topic)
    });
    assert.strictEqual(res.status, 200, 'signed poll of ' + topic + ' must succeed: ' + JSON.stringify(res));
    return res.text.split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line))
        .filter((m) => m.event === 'message');
}

function tmpNotifyStoreFile () {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tyo-mq-notify-actions-e2e-'));
    return path.join(dir, 'notify.sqlite');
}

// ── the acceptance test ───────────────────────────────────────────────────────

test('end-to-end reply-topic loop: actionable alert → phone fires Approve action verbatim → pipeline sees the reply', async () => {
    const server = await startServer({ notify: { enabled: true }, notify_store: { filename: tmpNotifyStoreFile() } });
    try {
        // The pipeline party owns BOTH topics with one keypair (a pipeline
        // claiming its own alert channel and its own reply channel).
        const pipeline = genKeyPair();

        // 1. Claim alerts-x and replies-x.
        const alertsClaim = await httpRequest(server.port, 'POST', '/notify/alerts-x/claim', {
            body: claimBody(pipeline.privateKey, 'alerts-x', { pubkey: pipeline.pubkey, transport: 'null', token: 'dev-token-alerts' })
        });
        assert.strictEqual(alertsClaim.status, 200, JSON.stringify(alertsClaim));
        const alertsToken = alertsClaim.json.publish_token;

        const repliesClaim = await httpRequest(server.port, 'POST', '/notify/replies-x/claim', {
            body: claimBody(pipeline.privateKey, 'replies-x', { pubkey: pipeline.pubkey, transport: 'null', token: 'dev-token-replies' })
        });
        assert.strictEqual(repliesClaim.status, 200, JSON.stringify(repliesClaim));
        const repliesToken = repliesClaim.json.publish_token;

        // 2. Pipeline publishes the actionable alert (JSON form — the only form
        // that carries actions) to alerts-x. The Approve action's url points at
        // the broker's replies-x publish endpoint and its Authorization header
        // carries the replies-x publish token — exactly what a real pipeline
        // embeds so the phone tap can publish the decision.
        //
        // NOTE on the https URL: validateActions requires https:// (fail-loud,
        // by design — production actions must never point at plaintext
        // endpoints), but this test broker only speaks http on 127.0.0.1. So
        // the action is constructed with the syntactically-valid https form of
        // the broker's own URL (accepted by validation and stored verbatim),
        // and the phone stand-in below derives the real local endpoint by
        // swapping the scheme back to http when EXECUTING it. Everything else
        // — method, path, headers, body — is used verbatim off the action,
        // which is precisely the property this test exists to prove (the app
        // fires actions with no out-of-band knowledge). The scheme swap is
        // test-harness plumbing only; a production action's https URL is used
        // untouched.
        const actionUrl = 'https://127.0.0.1:' + server.port + '/notify/replies-x';
        const pub = await httpRequest(server.port, 'POST', '/notify', {
            headers: { authorization: 'Bearer ' + alertsToken },
            body: {
                topic: 'alerts-x',
                title: 'Security scan: 1 finding',
                message: 'Approve posting the daily report?',
                actions: [
                    {
                        action: 'http', label: 'Approve',
                        url: actionUrl, method: 'POST', body: 'approve',
                        headers: { Authorization: 'Bearer ' + repliesToken }
                    },
                    {
                        action: 'http', label: 'Reject',
                        url: actionUrl, method: 'POST', body: 'reject',
                        headers: { Authorization: 'Bearer ' + repliesToken }
                    }
                ]
            }
        });
        assert.strictEqual(pub.status, 200, JSON.stringify(pub));

        // 3. The "phone" does a signed poll of alerts-x and reads the actions
        // off the message — the same fields the app parses out of SSE/FCM.
        const alerts = await signedPollMessages(server.port, pipeline.privateKey, 'alerts-x');
        assert.strictEqual(alerts.length, 1, 'exactly one alert retained: ' + JSON.stringify(alerts));
        const alert = alerts[0];
        assert.strictEqual(alert.message, 'Approve posting the daily report?');
        assert.ok(Array.isArray(alert.actions), 'alert carries its actions');
        assert.strictEqual(alert.actions.length, 2);

        const approve = alert.actions.find((a) => a.label === 'Approve');
        assert.ok(approve, 'Approve action present');
        assert.strictEqual(approve.action, 'http');
        assert.strictEqual(approve.method, 'POST');
        assert.strictEqual(approve.url, actionUrl, 'url survives the round-trip verbatim');
        assert.strictEqual(approve.body, 'approve');
        assert.strictEqual(approve.headers.Authorization, 'Bearer ' + repliesToken,
            'the reply-topic publish token rides inside the action headers');

        // 4. The phone fires the Approve action EXACTLY as the app will:
        // action.method against action.url with action.headers and action.body,
        // verbatim — nothing added, nothing rewritten (scheme swap per the
        // NOTE above: https → the local test broker's http).
        const fireUrl = new URL(approve.url.replace(/^https:/, 'http:'));
        const fired = await rawRequest(
            parseInt(fireUrl.port, 10),
            approve.method,
            fireUrl.pathname + fireUrl.search,
            approve.headers,
            approve.body
        );
        assert.strictEqual(fired.status, 200, 'action fire must be accepted: ' + JSON.stringify(fired));

        // 5. The pipeline's signed poll of replies-x sees the decision.
        const replies = await signedPollMessages(server.port, pipeline.privateKey, 'replies-x');
        assert.strictEqual(replies.length, 1, 'exactly one reply: ' + JSON.stringify(replies));
        assert.strictEqual(replies[0].topic, 'replies-x');
        assert.strictEqual(replies[0].message, 'approve', 'the action body IS the reply');

        // 6. A stranger's signed poll of replies-x is rejected — decisions stay
        // between the pipeline and the phone.
        const stranger = genKeyPair();
        const strangerRead = await httpRequest(server.port, 'GET', '/notify/replies-x/json?poll=1&since=all', {
            headers: signedGetHeaders(stranger.privateKey, 'json', 'replies-x')
        });
        assert.strictEqual(strangerRead.status, 401, JSON.stringify(strangerRead));

        // 7. And firing the action without its Authorization header (a stranger
        // who somehow learned the URL but not the token) is rejected too.
        const noAuthFire = await rawRequest(
            parseInt(fireUrl.port, 10), 'POST', fireUrl.pathname + fireUrl.search, {}, 'approve');
        assert.strictEqual(noAuthFire.status, 401, JSON.stringify(noAuthFire));
    } finally {
        await server.close();
    }
});

run();
