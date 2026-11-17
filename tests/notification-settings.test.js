'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const { DEFAULTS, validateSettings, readSettings, writeSettings } = require('../core/notification-settings');
const { createServer } = require('../core/server');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'redpacket-settings-'));
  t.after(() => {
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    fs.rmSync(root, { recursive: true, force: true });
  });
  return path.join(root, 'settings.json');
}
async function service(t, settingsFile) {
  const server = createServer({ settingsFile });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const origin = 'http://127.0.0.1:' + server.address().port;
  return { server, origin, url: origin + '/pool/api/notification-settings' };
}
const custom = { enabled: false, minPerPerson: 12.5, minBattery: 100, minRemainingSeconds: 45 };

test('defaults only apply to missing settings; saved values survive fresh reads', t => {
  const file = fixture(t);
  assert.deepEqual(readSettings(file), DEFAULTS);
  writeSettings(custom, file);
  assert.deepEqual(readSettings(file), custom);
  fs.writeFileSync(file, '{broken');
  assert.throws(() => readSettings(file));
});

test('invalid values are rejected without replacing the last saved settings', t => {
  const file = fixture(t); writeSettings(custom, file);
  for (const invalid of [null, [], {}, { ...custom, enabled: 'false' }, { ...custom, minPerPerson: -1 },
    { ...custom, minBattery: Infinity }, { ...custom, minBattery: '100' },
    { ...custom, minRemainingSeconds: 0.5 }, { ...custom, minRemainingSeconds: 86401 }, { ...custom, extra: 1 }]) {
    assert.throws(() => writeSettings(invalid, file));
    assert.deepEqual(readSettings(file), custom);
  }
  assert.deepEqual(validateSettings({ enabled: true, minPerPerson: 0, minBattery: 0, minRemainingSeconds: 0 }),
    { enabled: true, minPerPerson: 0, minBattery: 0, minRemainingSeconds: 0 });
});

test('settings API saves, returns validation errors, and persists across server instances', async t => {
  const file = fixture(t); const first = await service(t, file);
  const initial = await (await fetch(first.url)).json();
  assert.deepEqual(initial.settings, DEFAULTS);
  const saved = await fetch(first.url, { method: 'PUT', headers: { 'content-type': 'application/json', origin: first.origin }, body: JSON.stringify(custom) });
  assert.equal(saved.status, 200);
  assert.deepEqual((await saved.json()).settings, custom);
  const invalid = await fetch(first.url, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: '{"enabled":false}' });
  assert.equal(invalid.status, 400);
  assert.deepEqual(readSettings(file), custom);
  await new Promise(resolve => { first.server.closeAllConnections(); first.server.close(resolve); });
  const second = await service(t, file);
  assert.deepEqual((await (await fetch(second.url)).json()).settings, custom);
});

test('settings API rejects cross-site writes, non-JSON bodies and oversized requests', async t => {
  const file = fixture(t); writeSettings(custom, file); const app = await service(t, file);
  for (const [headers, body, status] of [
    [{ 'content-type': 'application/json', origin: 'https://example.invalid' }, JSON.stringify(custom), 403],
    [{ 'content-type': 'text/plain' }, JSON.stringify(custom), 415],
    [{ 'content-type': 'application/json' }, ' '.repeat(5000), 413],
    [{ 'content-type': 'application/json' }, '{broken', 400],
  ]) {
    const response = await fetch(app.url, { method: 'PUT', headers, body });
    assert.equal(response.status, status);
    assert.deepEqual(readSettings(file), custom);
  }
});
