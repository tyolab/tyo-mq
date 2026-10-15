'use strict';
/**
 * Sealed-sender UAK registry — durable backing store.
 *
 * Field finding (Hilia, 2026-10-15): the sealedUak registry was in-memory
 * only, so a broker restart wiped every identity's access record. Until each
 * client reconnected and re-sent SEALED_UAK_SET, every sealed delivery to it
 * returned 404 'recipient not reachable' and senders fell back to the PLAIN
 * inbox — which carries `to` and `from`, i.e. exactly the metadata sealed
 * sender exists to keep from the broker. These tests pin that a registered
 * access record SURVIVES a simulated restart via the prekey store's SQLite
 * file, proven through the protocol rather than by introspection: after the
 * restart, and with the recipient NOT having re-sent its UAK, a sender with
 * the wrong UAK gets 403 (not 404 — the record is there) and a sender with
 * the right UAK delivers online.
 *
 * Usage: node tests/sealed-uak-durable.test.js
 */
const assert = require('assert');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { test, run } = require('./runner');
const { PrivateKey, ServerCertificate } = require('@signalapp/libsignal-client');
const { startServer, delay } = require('./helpers');
const PrekeyStore = require('../lib/prekey-store');
const Factory = require('tyo-mq-client').Factory;

function tmpDb() {
    return path.join(os.tmpdir(),
        'tyo-sealed-uak-' + process.pid + '-' + Math.floor(Math.random() * 1e9) + '.sqlite');
}

function cleanup(file) {
    for (const suffix of ['', '-wal', '-shm']) {
        try { fs.unlinkSync(file + suffix); } catch (e) {}
    }
}

function clientOpts(port) {
    return { host: '127.0.0.1', port: port, protocol: 'http' };
}

// Sealed realm + an explicit prekey store file so two "restarts" share it.
function serverOptions(file) {
    return {
        auth: { realms: { default: { e2ee: 'required' } } },
        prekey_store: { filename: file },
    };
}

function installSealedEnv() {
    const root = PrivateKey.generate();
    const serverKey = PrivateKey.generate();
    const serverCert = ServerCertificate.new(1, serverKey.getPublicKey(), root);
    const prev = { c: process.env.TYO_MQ_SEALED_SERVER_CERT, k: process.env.TYO_MQ_SEALED_SERVER_KEY };
    process.env.TYO_MQ_SEALED_SERVER_CERT = Buffer.from(serverCert.serialize()).toString('base64');
    process.env.TYO_MQ_SEALED_SERVER_KEY = Buffer.from(serverKey.serialize()).toString('base64');
    return {
        restore: () => {
            process.env.TYO_MQ_SEALED_SERVER_CERT = prev.c;
            process.env.TYO_MQ_SEALED_SERVER_KEY = prev.k;
        },
    };
}

function sealedCall(sock, event, payload) {
    return new Promise((resolve) => sock.emit(event, payload, resolve));
}

// ── store level ─────────────────────────────────────────────────────────

test('store: a require-uak record round-trips as a Buffer and an unrestricted one as null', () => {
    const file = tmpDb();
    try {
        const uak = Buffer.alloc(16, 0x5a);
        const a = new PrekeyStore({ filename: file });
        a.putSealedUak('default', 'bob', { mode: 'require-uak', uak });
        a.putSealedUak('default', 'carol', { mode: 'unrestricted', uak: null });
        a.close();

        // "restart": fresh store on the same file
        const b = new PrekeyStore({ filename: file });
        const rows = b.allSealedUaks();
        const bob = rows.find(r => r.realm === 'default' && r.identity === 'bob');
        const carol = rows.find(r => r.realm === 'default' && r.identity === 'carol');
        assert.ok(bob && carol, 'both records survive the reopen');
        assert.strictEqual(bob.rec.mode, 'require-uak');
        assert.ok(Buffer.isBuffer(bob.rec.uak), 'uak hydrates as a Buffer (what uakEqual expects)');
        assert.ok(bob.rec.uak.equals(uak), 'uak bytes are intact');
        assert.strictEqual(carol.rec.mode, 'unrestricted');
        assert.strictEqual(carol.rec.uak, null, 'unrestricted stores no uak, mirroring memory');

        // upsert replaces in place; delete removes
        b.putSealedUak('default', 'bob', { mode: 'unrestricted' });
        assert.strictEqual(b.allSealedUaks().find(r => r.identity === 'bob').rec.uak, null);
        b.delSealedUak('default', 'bob');
        assert.ok(!b.allSealedUaks().some(r => r.identity === 'bob'), 'deleted record is gone');
        b.close();
    } finally { cleanup(file); }
});

// ── through the protocol, across a restart ───────────────────────────────

test('a registered UAK survives a broker restart: wrong UAK → 403, right UAK → online delivery, no re-set needed', async () => {
    const env = installSealedEnv();
    const file = tmpDb();
    const uak = Buffer.alloc(16, 9);
    const badUak = Buffer.alloc(16, 1);
    try {
        // ── broker #1: bob registers and pins his UAK ──
        const srv1 = await startServer(serverOptions(file));
        const bob1 = await new Factory(clientOpts(srv1.port)).createConsumer('bob');
        await delay(150);
        const set = await sealedCall(bob1.socket, 'SEALED_UAK_SET', { identity: 'bob', uak: uak.toString('base64'), mode: 'require-uak' });
        assert.strictEqual(set.ok, true);
        assert.strictEqual(set.durable, true, 'the ack reports the record was written through');
        bob1.disconnect();
        await srv1.close();

        // ── broker #2: same file, bob comes back WITHOUT re-sending his UAK ──
        const srv2 = await startServer(serverOptions(file));
        const bobFactory = new Factory(clientOpts(srv2.port));
        const bob2 = await bobFactory.createConsumer('bob');
        const received = [];
        bob2.socket.on('SEALED_MESSAGE', (p) => received.push(p));
        await delay(150);

        const anon = await new Factory(clientOpts(srv2.port)).createProducer();   // ANONYMOUS-<uuid>
        await delay(150);

        // Wrong UAK: 403, NOT 404 — the only way that happens is if the record
        // hydrated from disk (in-memory-only brokers answered 404 here).
        const bad = await sealedCall(anon.socket, 'SEALED_DELIVER', {
            to: { realm: 'default', identity: 'bob' },
            uak: badUak.toString('base64'),
            blob: Buffer.from('x').toString('base64'),
            msg_id: 'bad',
        });
        assert.strictEqual(bad.ok, false);
        assert.strictEqual(bad.code, 403, 'hydrated record enforces require-uak (a 404 would mean the registry was wiped)');

        // Right UAK: delivers online to the reconnected recipient.
        const good = await sealedCall(anon.socket, 'SEALED_DELIVER', {
            to: { realm: 'default', identity: 'bob' },
            uak: uak.toString('base64'),
            blob: Buffer.from('after-restart').toString('base64'),
            msg_id: 'm1',
        });
        assert.strictEqual(good.ok, true);
        assert.strictEqual(good.delivered, 'online');
        await delay(120);
        assert.strictEqual(received.length, 1, 'bob receives without ever re-sending SEALED_UAK_SET');
        assert.strictEqual(received[0].msg_id, 'm1');

        bob2.disconnect();
        anon.disconnect();
        await srv2.close();
    } finally {
        env.restore();
        cleanup(file);
    }
});

test('an unrestricted record also survives a restart', async () => {
    const env = installSealedEnv();
    const file = tmpDb();
    try {
        const srv1 = await startServer(serverOptions(file));
        const bob1 = await new Factory(clientOpts(srv1.port)).createConsumer('bob');
        await delay(150);
        const set = await sealedCall(bob1.socket, 'SEALED_UAK_SET', { identity: 'bob', mode: 'unrestricted' });
        assert.strictEqual(set.ok, true);
        bob1.disconnect();
        await srv1.close();

        const srv2 = await startServer(serverOptions(file));
        const bob2 = await new Factory(clientOpts(srv2.port)).createConsumer('bob');
        const received = [];
        bob2.socket.on('SEALED_MESSAGE', (p) => received.push(p));
        await delay(150);
        const anon = await new Factory(clientOpts(srv2.port)).createProducer();
        await delay(150);

        // No UAK presented at all: accepted, because the hydrated mode is unrestricted.
        const res = await sealedCall(anon.socket, 'SEALED_DELIVER', {
            to: { realm: 'default', identity: 'bob' },
            blob: Buffer.from('open').toString('base64'),
            msg_id: 'u1',
        });
        assert.strictEqual(res.ok, true);
        assert.strictEqual(res.delivered, 'online');
        await delay(120);
        assert.strictEqual(received.length, 1);

        bob2.disconnect();
        anon.disconnect();
        await srv2.close();
    } finally {
        env.restore();
        cleanup(file);
    }
});

run();
