// tests/notify-boards.test.js
/**
 * TYO Notify Status Boards — board config, compacted state, per-watcher
 * publish token set (lib/notify-store.js).
 * Usage: node tests/notify-boards.test.js
 */

'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { test, run } = require('./runner');
const NotifyStore = require('../lib/notify-store');

function tmp() {
    return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'nb-')), 'n.sqlite');
}

test('createBoard + getBoard persists name, compact_key, board key, owner', () => {
    const s = new NotifyStore({ filename: tmp() });
    const b = s.createBoard('ops-ab12cd', { name: 'Production Fleet', compact_key: 'key',
        board_privkey: 'PK', board_pubkey: 'SP', owner_uid: 'u1' });
    assert.strictEqual(b.name, 'Production Fleet');
    const got = s.getBoard('ops-ab12cd');
    assert.strictEqual(got.owner_uid, 'u1');
    assert.strictEqual(got.board_pubkey, 'SP');
});

test('upsertBoardState keeps latest-per-key; getBoardState returns the set', () => {
    const s = new NotifyStore({ filename: tmp() });
    s.createBoard('ops', { name: 'o', compact_key: 'key', board_privkey: 'x', board_pubkey: 'y', owner_uid: 'u' });
    s.upsertBoardState('ops', 'web1', { msg: '{"a":1}', state: 'ok', expires_at: 100 });
    s.upsertBoardState('ops', 'web2', { msg: '{"b":2}', state: 'crit', expires_at: 0 });
    s.upsertBoardState('ops', 'web1', { msg: '{"a":9}', state: 'warn', expires_at: 200 }); // replace
    const rows = s.getBoardState('ops');
    assert.strictEqual(rows.length, 2);
    const web1 = rows.find(r => r.key === 'web1');
    assert.strictEqual(web1.msg, '{"a":9}');
    assert.strictEqual(web1.state, 'warn');
});

test('publish token set: add / matches / list / revoke', () => {
    const s = new NotifyStore({ filename: tmp() });
    const A = require('../lib/notify-auth');
    const tok = A.generatePublishToken();
    const id = s.addPublishToken('ops', { token_hash: A.hashPublishToken(tok), label: 'web1' });
    assert.ok(id);
    assert.ok(s.publishTokenMatchesAny('ops', tok));      // matches a set token
    assert.ok(!s.publishTokenMatchesAny('ops', 'nope'));
    assert.strictEqual(s.listPublishTokens('ops').length, 1);
    assert.strictEqual(s.listPublishTokens('ops')[0].label, 'web1'); // no raw token in listing
    s.revokePublishToken('ops', id);
    assert.ok(!s.publishTokenMatchesAny('ops', tok));     // revoked
});

test('dueBoardKeys returns keys past expires_at not already down', () => {
    const s = new NotifyStore({ filename: tmp() });
    s.createBoard('ops', { name:'o', compact_key:'key', board_privkey:'x', board_pubkey:'y', owner_uid:'u' });
    s.upsertBoardState('ops', 'web1', { msg:'{}', state:'ok', expires_at: 50 });
    s.upsertBoardState('ops', 'web2', { msg:'{}', state:'ok', expires_at: 0 }); // no watchdog
    const due = s.dueBoardKeys(100);
    assert.deepStrictEqual(due.map(d => d.key), ['web1']);
    s.setBoardDown('ops', 'web1', 1);
    assert.strictEqual(s.dueBoardKeys(100).length, 0); // already down → not re-fired
});

run();
