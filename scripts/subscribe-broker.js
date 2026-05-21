/**
 * Live subscriber test client.
 *
 * Connects to a running tyo-mq server, subscribes to the "broker" event
 * published by the C# tyosis-data producer, and prints each received message.
 *
 * Usage:
 *   node scripts/subscribe-broker.js [options]
 *
 * Options:
 *   -h <host>      MQ server host      (default: localhost)
 *   -p <port>      MQ server port      (default: 17352)
 *   -s <protocol>  Transport protocol  (default: http)
 *   --timeout <ms> Exit after N ms with no message (0 = wait forever, default: 0)
 */

'use strict';

const Factory = require('../lib/factory');

// ─── parse args ──────────────────────────────────────────────────────────────

var host     = process.env.TYO_MQ_HOST || 'localhost';
var port     = parseInt(process.env.TYO_MQ_PORT, 10) || 17352;
var protocol = 'http';
var timeout  = 0;

for (var i = 2; i < process.argv.length; i++) {
    switch (process.argv[i]) {
        case '-h': host     = process.argv[++i]; break;
        case '-p': port     = parseInt(process.argv[++i], 10); break;
        case '-s': protocol = process.argv[++i]; break;
        case '--timeout': timeout = parseInt(process.argv[++i], 10); break;
        default:
            console.error('Unknown option: ' + process.argv[i]);
            process.exit(1);
    }
}

const PRODUCER = 'tyosis-data';
const EVENT    = 'broker';

// ─── main ────────────────────────────────────────────────────────────────────

console.log('[subscribe-broker] connecting to ' + protocol + '://' + host + ':' + port);
console.log('[subscribe-broker] waiting for "' + EVENT + '" from producer "' + PRODUCER + '"');
console.log('[subscribe-broker] press Ctrl-C to exit\n');

var idleTimer = null;

function resetIdleTimer(consumer) {
    if (!timeout) return;
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(function () {
        console.log('\n[subscribe-broker] no message received within ' + timeout + ' ms — exiting');
        consumer.disconnect();
        process.exit(0);
    }, timeout);
}

var mq = new Factory({ host: host, port: port, protocol: protocol });

mq.createConsumer('broker-test-subscriber', function (consumer) {
    console.log('[subscribe-broker] connected (socket: ' + consumer.getId() + ')\n');

    resetIdleTimer(consumer);

    consumer.subscribe(PRODUCER, EVENT, function (data, from) {
        var ts = new Date().toISOString();

        console.log('─'.repeat(72));
        console.log('[' + ts + '] message received from: ' + from);
        console.log('  type   : ' + typeof data);
        console.log('  length : ' + String(data).length + ' chars');

        // Try to parse as JSON — this is what the tyosis subscriber does
        var parsed = null;
        var parseError = null;
        try {
            parsed = JSON.parse(data);
            console.log('  JSON.parse : OK');
        } catch (e) {
            parseError = e;
            console.log('  JSON.parse : FAILED — ' + e.message);
            console.log('  first 200 chars of raw data:');
            console.log('    ' + String(data).slice(0, 200));
        }

        if (parsed) {
            var keys = Object.keys(parsed);
            console.log('  top-level keys : ' + keys.join(', '));

            if (parsed.broker)
                console.log('  broker : ' + parsed.broker);
            if (parsed.account_type)
                console.log('  account_type : ' + parsed.account_type);
            if (parsed.symbols) {
                var symCount = Object.keys(parsed.symbols).length;
                console.log('  symbols : ' + symCount + ' entries');
                // Print first 3 symbol names as a sanity check
                var sample = Object.keys(parsed.symbols).slice(0, 3).join(', ');
                if (sample) console.log('  sample symbols : ' + sample + (symCount > 3 ? ' ...' : ''));
            }
        }

        console.log('─'.repeat(72) + '\n');

        resetIdleTimer(consumer);
    });
}, port, host, protocol);
