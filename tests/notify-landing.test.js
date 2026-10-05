// tests/notify-landing.test.js
/**
 * Browser landing page for the PUBLIC notify subscribe URL.
 *
 * GET /notify/{topic} defaults to a text/event-stream subscribe, so a phone
 * browser that opens the bare URL (e.g. from a QR code) just gets a blank,
 * hanging tab. When the request is a browser navigation (Accept: text/html and
 * no explicit format suffix), the broker serves a small "subscribe in the app"
 * HTML page instead — while EventSource / API clients still get the stream.
 *
 * Usage: node tests/notify-landing.test.js
 */

'use strict';

const assert = require('assert');
const http = require('http');
const { test, run } = require('./runner');
const { startServer } = require('./helpers');

// Full-body request (the landing page and error bodies close the connection).
function httpText(port, method, pathname, headers) {
    return new Promise((resolve) => {
        const req = http.request({ host: '127.0.0.1', port, path: pathname, method, headers: headers || {}, timeout: 4000 }, (res) => {
            let data = '';
            res.setEncoding('utf8');
            res.on('data', (c) => { data += c; });
            res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
        });
        req.on('timeout', () => { req.destroy(); resolve({ status: null, headers: {}, body: '' }); });
        req.on('error', () => resolve({ status: null, headers: {}, body: '' }));
        req.end();
    });
}

// SSE is a live stream — read the response head + first chunk, then hang up.
function sseFirstChunk(port, pathname, headers) {
    return new Promise((resolve) => {
        const req = http.request({ host: '127.0.0.1', port, path: pathname, method: 'GET', headers: headers || {}, timeout: 4000 }, (res) => {
            res.setEncoding('utf8');
            res.once('data', (c) => {
                const out = { status: res.statusCode, headers: res.headers, first: c };
                req.destroy();
                resolve(out);
            });
        });
        req.on('timeout', () => { req.destroy(); resolve({ status: null, headers: {}, first: '' }); });
        req.on('error', () => resolve({ status: null, headers: {}, first: '' }));
        req.end();
    });
}

const BROWSER = 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8';

test('bare /notify/{topic} with Accept: text/html → HTML landing page (not a hanging stream)', async () => {
    const server = await startServer({ notify: { enabled: true } });
    try {
        const r = await httpText(server.port, 'GET', '/notify/auction-alerts', { Accept: BROWSER });
        assert.strictEqual(r.status, 200, 'browser navigation is answered');
        assert.ok(/text\/html/.test(r.headers['content-type'] || ''), 'served as text/html');
        assert.ok(r.body.indexOf('auction-alerts') !== -1, 'names the topic');
        // Opens the app for existing users via the custom scheme…
        assert.ok(r.body.indexOf('tyonotify://subscribe?topic=auction-alerts') !== -1, 'carries the app deep link');
        // …and offers BOTH stores for everyone else.
        assert.ok(r.body.indexOf('au.com.tyo.notify') !== -1, 'links the Android app (Play)');
        assert.ok(r.body.indexOf('apps.apple.com/app/id6804510763') !== -1, 'links the iOS app (App Store)');
        // Points the deep link at THIS broker (server= param, url-encoded).
        assert.ok(r.body.indexOf('server=http') !== -1, 'deep link names this broker');
    } finally {
        await server.close();
    }
});

test('bare /notify/{topic} with Accept: text/event-stream → still an SSE stream (EventSource unchanged)', async () => {
    const server = await startServer({ notify: { enabled: true } });
    try {
        const r = await sseFirstChunk(server.port, '/notify/auction-alerts', { Accept: 'text/event-stream' });
        assert.strictEqual(r.status, 200);
        assert.ok(/text\/event-stream/.test(r.headers['content-type'] || ''), 'EventSource still gets the stream');
        assert.ok(r.first.indexOf('event: open') !== -1, 'stream opens with the ntfy open frame');
    } finally {
        await server.close();
    }
});

test('explicit /notify/{topic}/sse suffix stays a stream even for a browser Accept', async () => {
    const server = await startServer({ notify: { enabled: true } });
    try {
        const r = await sseFirstChunk(server.port, '/notify/auction-alerts/sse', { Accept: BROWSER });
        assert.strictEqual(r.status, 200);
        assert.ok(/text\/event-stream/.test(r.headers['content-type'] || ''), 'an explicit format suffix wins over Accept');
    } finally {
        await server.close();
    }
});

test('a non-browser client (Accept: */*, e.g. curl/fetch) is unchanged — still a stream', async () => {
    const server = await startServer({ notify: { enabled: true } });
    try {
        const r = await sseFirstChunk(server.port, '/notify/auction-alerts', { Accept: '*/*' });
        assert.strictEqual(r.status, 200);
        assert.ok(/text\/event-stream/.test(r.headers['content-type'] || ''), 'only text/html navigations get the page');
    } finally {
        await server.close();
    }
});

test('a browser hitting an INVALID topic falls through to the normal 400 (no landing page)', async () => {
    const server = await startServer({ notify: { enabled: true } });
    try {
        const r = await httpText(server.port, 'GET', '/notify/' + encodeURIComponent('bad topic!'), { Accept: BROWSER });
        assert.strictEqual(r.status, 400, 'invalid topic is rejected, not dressed up as a page');
    } finally {
        await server.close();
    }
});

test('deep link server= is https for a public host even when TLS is terminated upstream', async () => {
    const server = await startServer({ notify: { enabled: true } });
    try {
        // A public hostname arriving over plain HTTP (proxy-terminated TLS, no
        // X-Forwarded-Proto) must still yield an https broker URL for the app…
        const pub = await httpText(server.port, 'GET', '/notify/mytopic', { Accept: BROWSER, Host: 'freemq.tyo.com.au' });
        assert.ok(pub.body.indexOf('server=https%3A%2F%2Ffreemq.tyo.com.au') !== -1, 'public host → https server=');
        // …even when nginx sets a misleading X-Forwarded-Proto: http (its own
        // http hop to the broker) on a public host, the deep link stays https…
        const xfp = await httpText(server.port, 'GET', '/notify/mytopic', { Accept: BROWSER, Host: 'freemq.tyo.com.au', 'X-Forwarded-Proto': 'http' });
        assert.ok(xfp.body.indexOf('server=https%3A%2F%2Ffreemq.tyo.com.au') !== -1, 'public host is https despite a lying X-Forwarded-Proto');
        // …and a local dev host stays http (no false https promotion).
        const loc = await httpText(server.port, 'GET', '/notify/mytopic', { Accept: BROWSER, Host: '127.0.0.1:8080' });
        assert.ok(loc.body.indexOf('server=http%3A%2F%2F127.0.0.1%3A8080') !== -1, 'local host stays http');
    } finally {
        await server.close();
    }
});

test('raw page carries a plain-ampersand canonical link (no &amp; mis-parse for QR/copy)', async () => {
    const server = await startServer({ notify: { enabled: true } });
    try {
        const r = await httpText(server.port, 'GET', '/notify/auction-alerts', { Accept: BROWSER, Host: 'self.example.com' });
        // The raw bytes must contain the deep link with a LITERAL & so a QR
        // generator / copy-paste off view-source gets server= intact rather than
        // a param named `amp;server` that both clients drop.
        assert.ok(r.body.indexOf('tyonotify://subscribe?topic=auction-alerts&server=https%3A%2F%2Fself.example.com') !== -1,
            'canonical link present with a plain ampersand');
        // And that literal-& form must NOT be the entity-mangled one.
        assert.ok(r.body.indexOf('topic=auction-alerts&amp;server=') !== -1,
            'the tap href is still entity-escaped (valid HTML, no-JS fallback)');
        // A raw extraction of the data-href parses to the right (topic, server).
        const m = r.body.match(/data-href="(tyonotify:\/\/[^"]+)"/);
        assert.ok(m, 'data-href present');
        const u = new URL(m[1]);
        assert.strictEqual(u.searchParams.get('topic'), 'auction-alerts');
        assert.strictEqual(u.searchParams.get('server'), 'https://self.example.com', 'server= survives a raw parse');
    } finally {
        await server.close();
    }
});

run();
