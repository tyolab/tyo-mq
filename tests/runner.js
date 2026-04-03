/**
 * Minimal async test runner.
 *
 * Usage:
 *   const { test, run } = require('./runner');
 *   test('my test', async () => { ... });
 *   run();
 */

const tests = [];
let passed = 0;
let failed = 0;

function test(name, fn) {
    tests.push({ name, fn });
}

async function run() {
    console.log(`\nRunning ${tests.length} test(s)...\n`);
    for (const t of tests) {
        try {
            await t.fn();
            console.log(`  ✓  ${t.name}`);
            passed++;
        } catch (err) {
            console.error(`  ✗  ${t.name}`);
            console.error(`     ${err.message}`);
            failed++;
        }
    }
    console.log(`\n${passed} passed, ${failed} failed\n`);
    process.exit(failed > 0 ? 1 : 0);
}

module.exports = { test, run };
