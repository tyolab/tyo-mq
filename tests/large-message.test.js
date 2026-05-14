/**
 * Large-message round-trip test.
 *
 * Verifies that a message whose JSON serialisation exceeds 256 KB is split
 * into PRODUCE_CHUNK frames by the publisher, reassembled by the server, then
 * (if necessary) re-split into CONSUME_CHUNK frames, and finally received by
 * the subscriber intact and parseable as JSON.
 *
 * This covers the bug where JsonEncodedText.Encode() + JsonSerializer.Serialize
 * in the C# publisher produced double-escaped backslashes that made the
 * subscriber's JSON.parse() fail with:
 *   "Expected property name or '}' in JSON at position 1"
 *
 * Usage:  node tests/large-message.test.js
 */

'use strict';

const assert  = require('assert');
const { test, run } = require('./runner');

const TyoMQServer = require('../lib/server');
const Factory     = require('../lib/factory');
const Publisher   = require('../lib/publisher');

const TEST_PORT = 17354; // separate port so it doesn't clash with other test suites

// ─── bootstrap ───────────────────────────────────────────────────────────────

const noop = () => {};
const server = new TyoMQServer({ port: TEST_PORT });
server.logger = { critical: noop, error: noop, warn: noop, output: noop, log: noop, info: noop, debug: noop, trace: noop };
server.start(TEST_PORT);

function mq() {
    return new Factory({ host: '127.0.0.1', port: TEST_PORT, protocol: 'http' });
}

function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Build a JSON string that represents a realistic broker/symbols payload.
 * The object will be padded until the final PRODUCE message exceeds the
 * 256 KB chunk threshold so chunking is actually exercised.
 */
function buildLargeSymbolsJson(targetBytes) {
    const symbols = {};
    let i = 0;
    // Start with a realistic-looking symbols object
    const template = {
        digits: 5,
        spread: 0.0001,
        stops_level: 0,
        lot_size: 100000,
        tick_value: 0.0001,
        tick_size: 0.00001,
        description: 'Generated test symbol with a moderately long description field'
    };
    let candidate = JSON.stringify({ broker: 'TestBroker', account_type: 'demo', symbols });
    while (candidate.length < targetBytes) {
        const sym = 'SYM' + String(i).padStart(5, '0') + 'USD';
        symbols[sym] = Object.assign({}, template);
        i++;
        candidate = JSON.stringify({ broker: 'TestBroker', account_type: 'demo', symbols });
    }
    return candidate;
}

// ─── tests ───────────────────────────────────────────────────────────────────

test('small JSON message round-trip', async () => {
    const client   = mq();
    const producer = await client.createProducer('lm-producer-small');
    const consumer = await client.createConsumer('lm-consumer-small');

    const payload = JSON.stringify({ broker: 'TestBroker', account_type: 'demo', symbols: { EURUSD: { digits: 5 } } });

    const received = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('timeout')), 5000);
        consumer.subscribe(producer.name, 'broker', (data) => {
            clearTimeout(timer);
            resolve(data);
        });
        setTimeout(() => producer.produce('broker', payload), 400);
    });

    // The subscriber receives the raw payload string; it must be parseable JSON.
    const parsed = JSON.parse(received);
    assert.strictEqual(parsed.broker, 'TestBroker', 'broker field mismatch');
    assert.ok(parsed.symbols && parsed.symbols.EURUSD, 'symbols.EURUSD missing');

    producer.disconnect();
    consumer.disconnect();
});

test('large JSON message round-trip (chunked)', async () => {
    const client   = mq();
    const producer = await client.createProducer('lm-producer-large');
    const consumer = await client.createConsumer('lm-consumer-large');

    // Build a payload that is larger than the 256 KB chunk threshold so that
    // PRODUCE_CHUNK frames are used on the publisher side.
    const CHUNK_SIZE = 256 * 1024;
    const symbolsJson = buildLargeSymbolsJson(CHUNK_SIZE + 10_000); // comfortably over

    // Sanity: the raw payload must be valid JSON before we send it.
    const payloadObj = JSON.parse(symbolsJson);
    assert.ok(payloadObj.symbols, 'test setup error: symbols missing');
    const symbolCount = Object.keys(payloadObj.symbols).length;

    const received = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('timeout waiting for large message')), 10000);
        consumer.subscribe(producer.name, 'broker', (data) => {
            clearTimeout(timer);
            resolve(data);
        });
        setTimeout(() => producer.produce('broker', symbolsJson), 400);
    });

    // The subscriber must receive the original symbols JSON string intact
    // and it must parse back to the same object.
    let parsed;
    try {
        parsed = JSON.parse(received);
    } catch (e) {
        throw new Error('subscriber received unparseable JSON: ' + e.message + '\n  first 120 chars: ' + String(received).slice(0, 120));
    }

    assert.strictEqual(parsed.broker, 'TestBroker', 'broker field mismatch after chunked round-trip');
    assert.strictEqual(Object.keys(parsed.symbols).length, symbolCount, 'symbol count mismatch after chunked round-trip');

    producer.disconnect();
    consumer.disconnect();
});

test('large message with special characters (double-quotes inside JSON string)', async () => {
    const client   = mq();
    const producer = await client.createProducer('lm-producer-quotes');
    const consumer = await client.createConsumer('lm-consumer-quotes');

    // Build a large payload whose values contain double-quote and backslash chars —
    // exactly the characters that JsonEncodedText.Encode() was (incorrectly) escaping.
    // The publisher checks JSON.stringify({event,message:data,from,lifespan}).length,
    // so we build until that full-message string exceeds CHUNK_SIZE.
    const CHUNK_SIZE = 256 * 1024;
    const symbols = {};
    let symbolsJson;
    for (let i = 0; i < 10000; i++) {
        symbols['SYM' + i] = {
            digits: 5,
            description: 'He said "hello" and it\\worked and more padding text here'
        };
        symbolsJson = JSON.stringify({ broker: 'TestBroker"Special', symbols });
        const fullMsg = JSON.stringify({ event: 'broker', message: symbolsJson, from: 'lm-producer-quotes', lifespan: -1 });
        if (fullMsg.length > CHUNK_SIZE) break;
    }
    const fullMsgLen = JSON.stringify({ event: 'broker', message: symbolsJson, from: 'lm-producer-quotes', lifespan: -1 }).length;
    assert.ok(fullMsgLen > CHUNK_SIZE, `test setup: full message (${fullMsgLen}) should exceed chunk size (${CHUNK_SIZE})`);

    const received = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('timeout')), 10000);
        consumer.subscribe(producer.name, 'broker', (data) => {
            clearTimeout(timer);
            resolve(data);
        });
        setTimeout(() => producer.produce('broker', symbolsJson), 400);
    });

    let parsed;
    try {
        parsed = JSON.parse(received);
    } catch (e) {
        throw new Error('JSON.parse failed on received message: ' + e.message + '\n  first 120 chars: ' + String(received).slice(0, 120));
    }

    assert.strictEqual(parsed.broker, 'TestBroker"Special', 'broker with special chars mismatch');
    assert.ok(parsed.symbols['SYM0'].description.includes('"hello"'), 'double-quote content lost');
    assert.ok(parsed.symbols['SYM0'].description.includes('\\'), 'backslash content lost');

    producer.disconnect();
    consumer.disconnect();
});

// ─── run ─────────────────────────────────────────────────────────────────────

run();
