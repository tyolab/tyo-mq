/**
 * TYO Notify — unit tests for the pure message model + topic ring (lib/notify.js).
 * No server; fast. Usage: node tests/notify-unit.test.js
 */

'use strict';

const assert = require('assert');
const { test, run } = require('./runner');
const N = require('../lib/notify');

// ── topic validation ──────────────────────────────────────────────────────────
test('isValidTopic accepts ntfy charset, rejects the rest', async () => {
    assert.ok(N.isValidTopic('alerts'));
    assert.ok(N.isValidTopic('ci_build-42'));
    assert.ok(N.isValidTopic('a'.repeat(64)));
    assert.ok(!N.isValidTopic('a'.repeat(65)), 'too long');
    assert.ok(!N.isValidTopic(''), 'empty');
    assert.ok(!N.isValidTopic('has space'));
    assert.ok(!N.isValidTopic('slash/topic'));
    assert.ok(!N.isValidTopic('__proto__'.replace(/_/g, '.'))); // dots not allowed
    assert.ok(!N.isValidTopic(123));
});

// ── priority ──────────────────────────────────────────────────────────────────
test('parsePriority handles names, numbers, and junk', async () => {
    assert.strictEqual(N.parsePriority(undefined), 3);
    assert.strictEqual(N.parsePriority('urgent'), 5);
    assert.strictEqual(N.parsePriority('MAX'), 5);
    assert.strictEqual(N.parsePriority('low'), 2);
    assert.strictEqual(N.parsePriority('4'), 4);
    assert.strictEqual(N.parsePriority('9'), 3, 'out of range → default');
    assert.strictEqual(N.parsePriority('nonsense'), 3);
});

// ── tags ──────────────────────────────────────────────────────────────────────
test('parseTags splits, trims, caps', async () => {
    assert.deepStrictEqual(N.parseTags('warning, skull ,'), ['warning', 'skull']);
    assert.deepStrictEqual(N.parseTags(''), []);
    assert.strictEqual(N.parseTags(Array.from({ length: 30 }, (_, i) => 't' + i).join(',')).length, 20);
});

// ── push mode ─────────────────────────────────────────────────────────────────
test('parsePush defaults to wake and honours content/off', async () => {
    assert.strictEqual(N.parsePush(undefined, undefined), 'wake');
    assert.strictEqual(N.parsePush('content', undefined), 'content');
    assert.strictEqual(N.parsePush(undefined, 'off'), 'off');
    assert.strictEqual(N.parsePush('wake', 'content'), 'content', 'query overrides header');
    assert.strictEqual(N.parsePush('garbage', undefined), 'wake');
});

// ── buildMessage ──────────────────────────────────────────────────────────────
test('buildMessage produces an ntfy-shaped object, omitting empties', async () => {
    const m = N.buildMessage({ topic: 'alerts', message: 'hi', id: 'n-1', time: 100 });
    assert.deepStrictEqual(m, { id: 'n-1', time: 100, event: 'message', topic: 'alerts', message: 'hi' });

    const full = N.buildMessage({
        topic: 'alerts', message: 'boom', title: 'Alert', priority: 'high',
        tags: 'warning,skull', click: 'https://x', markdown: true, id: 'n-2', time: 5
    });
    assert.strictEqual(full.title, 'Alert');
    assert.strictEqual(full.priority, 4);
    assert.deepStrictEqual(full.tags, ['warning', 'skull']);
    assert.strictEqual(full.click, 'https://x');
    assert.strictEqual(full.content_type, 'text/markdown');
});

test('buildMessage generates an id and unix time when omitted', async () => {
    const m = N.buildMessage({ topic: 't', message: 'x' });
    assert.ok(/^n-[0-9a-f]{18}$/.test(m.id));
    assert.ok(m.time > 1000000000, 'unix seconds');
});

// ── ring: append + since ──────────────────────────────────────────────────────
test('ring returns messages since an id, and all/duration', async () => {
    const ring = new N.NotifyRing({ ttlMs: 60000, maxPerTopic: 10 });
    const t0 = 1000;
    ring.append('t', N.buildMessage({ topic: 't', message: 'a', id: 'a', time: 1 }), t0);
    ring.append('t', N.buildMessage({ topic: 't', message: 'b', id: 'b', time: 2 }), t0 + 10);
    ring.append('t', N.buildMessage({ topic: 't', message: 'c', id: 'c', time: 3 }), t0 + 20);

    assert.deepStrictEqual(ring.since('t', 'all', t0 + 20).map((m) => m.id), ['a', 'b', 'c']);
    assert.deepStrictEqual(ring.since('t', 'a', t0 + 20).map((m) => m.id), ['b', 'c'], 'strictly after id');
    assert.deepStrictEqual(ring.since('t', '', t0 + 20), [], 'no since → nothing');
    assert.deepStrictEqual(ring.since('nope', 'all', t0), [], 'unknown topic');
    assert.deepStrictEqual(ring.since('t', 'unknownid', t0 + 20).map((m) => m.id), ['a', 'b', 'c'], 'unknown id → all');
});

test('ring evicts by TTL and per-topic cap', async () => {
    const ring = new N.NotifyRing({ ttlMs: 100, maxPerTopic: 2 });
    ring.append('t', N.buildMessage({ topic: 't', message: 'old', id: 'old' }), 0);
    // 200ms later the old one is beyond the 100ms TTL:
    ring.append('t', N.buildMessage({ topic: 't', message: 'new', id: 'new' }), 200);
    assert.deepStrictEqual(ring.since('t', 'all', 200).map((m) => m.id), ['new'], 'TTL drop');

    const ring2 = new N.NotifyRing({ ttlMs: 60000, maxPerTopic: 2 });
    ['1', '2', '3'].forEach((id, i) => ring2.append('t', N.buildMessage({ topic: 't', message: id, id }), 1000 + i));
    assert.deepStrictEqual(ring2.since('t', 'all', 1002).map((m) => m.id), ['2', '3'], 'cap keeps newest 2');
});

test('ring evicts least-recently-used topics past maxTopics', async () => {
    const ring = new N.NotifyRing({ maxTopics: 2 });
    ring.append('a', N.buildMessage({ topic: 'a', message: 'x', id: 'x' }), 1);
    ring.append('b', N.buildMessage({ topic: 'b', message: 'y', id: 'y' }), 2);
    ring.append('c', N.buildMessage({ topic: 'c', message: 'z', id: 'z' }), 3);
    assert.strictEqual(ring.topicCount(), 2);
    assert.deepStrictEqual(ring.since('a', 'all', 3), [], 'oldest topic evicted');
    assert.deepStrictEqual(ring.since('c', 'all', 3).map((m) => m.id), ['z']);
});

run();
