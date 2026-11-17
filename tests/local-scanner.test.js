'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runLocalScanner } = require('../core/local-scanner');

function fixture(t, scenario) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hongbao-local-scanner-'));
  t.after(() => {
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const entry = path.join(directory, 'scanner.js');
  const stateFile = path.join(directory, 'state.json');
  const lockFile = path.join(directory, 'scanner.lock');
  const launches = path.join(directory, 'launches.jsonl');
  fs.writeFileSync(entry, `
    const fs = require('node:fs');
    const budget = process.env.SCANNER_PER_IP_BUDGET;
    const mode = process.env.TEST_SCENARIO;
    const stateFile = process.env.TEST_STATE_FILE;
    const lockFile = process.env.TEST_LOCK_FILE;
    fs.appendFileSync(process.env.TEST_LAUNCHES, JSON.stringify({ budget,
      guard: process.env.SCANNER_STOP_ON_BAN, nodeLimit: process.env.SCANNER_NODE_LIMIT }) + '\\n');
    const banned = mode === 'ban-always' || mode === 'foreign-state' || mode === 'stale-state'
      || (mode === 'ban-once' && budget === '130');
    function finish() {
      fs.writeFileSync(stateFile, JSON.stringify({ pid: mode === 'foreign-state' ? process.pid + 1 : process.pid,
        started: mode === 'stale-state' ? 1 : Date.now(),
        stats: { banned: banned ? 1 : 0 }, storage: { error: '' } }));
      if (fs.existsSync(lockFile)) fs.unlinkSync(lockFile);
      process.exit(0);
    }
    if (mode === 'wait-for-stop') {
      setTimeout(() => fs.writeFileSync(lockFile, JSON.stringify({ pid: process.pid })), 100);
      setInterval(() => {
        if (fs.existsSync(lockFile + '.stop') && JSON.parse(fs.readFileSync(lockFile + '.stop')).pid === process.pid) finish();
      }, 20);
    } else {
      finish();
    }
  `);
  const options = { entry, stateFile, lockFile, stdio: 'ignore', env: { ...process.env,
    TEST_SCENARIO: scenario, TEST_STATE_FILE: stateFile, TEST_LOCK_FILE: lockFile, TEST_LAUNCHES: launches,
    SCANNER_PER_IP_BUDGET: '130', SCANNER_NODE_LIMIT: '12' } };
  return { options, launches: () => fs.readFileSync(launches, 'utf8').trim().split('\n').map(JSON.parse),
    started: () => fs.existsSync(launches), lockFile };
}

test('local scanner falls back once to 110 after its own confirmed ban', async t => {
  const f = fixture(t, 'ban-once');
  assert.equal(await runLocalScanner(f.options), 0);
  assert.deepEqual(f.launches(), [
    { budget: '130', guard: '1', nodeLimit: '12' },
    { budget: '110', guard: '1', nodeLimit: '12' },
  ]);
});

test('a second ban at 110 stops without another retry', async t => {
  const f = fixture(t, 'ban-always');
  assert.equal(await runLocalScanner(f.options), 1);
  assert.deepEqual(f.launches().map(item => item.budget), ['130', '110']);
});

test('manual stop during startup waits for the scanner lock and never restarts', async t => {
  const f = fixture(t, 'wait-for-stop');
  const controller = new AbortController();
  const result = runLocalScanner({ ...f.options, signal: controller.signal });
  const deadline = Date.now() + 5000;
  while (!f.started() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
  controller.abort();
  assert.equal(await result, 0);
  assert.deepEqual(f.launches().map(item => item.budget), ['130']);
  assert.equal(fs.existsSync(f.lockFile), false);
});

test('a ban belonging to another scanner does not trigger a restart', async t => {
  const f = fixture(t, 'foreign-state');
  assert.equal(await runLocalScanner(f.options), 0);
  assert.deepEqual(f.launches().map(item => item.budget), ['130']);
});

test('bounded commands preserve their requested stop even when a ban is recorded', async t => {
  const f = fixture(t, 'ban-always');
  assert.equal(await runLocalScanner({ ...f.options, args: ['--rounds', '1'] }), 0);
  assert.deepEqual(f.launches().map(item => item.budget), ['130']);
});

test('an old state with a reused process id cannot trigger a fallback', async t => {
  const f = fixture(t, 'stale-state');
  assert.equal(await runLocalScanner(f.options), 0);
  assert.deepEqual(f.launches().map(item => item.budget), ['130']);
});
