'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const settings = require('../core/scan-settings');
const { createServer } = require('../core/server');

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rp-scan-settings-'));
  t.after(() => {
    assert.equal(path.dirname(dir), path.resolve(os.tmpdir()));
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return path.join(dir, 'scan-settings.json');
}
async function service(t, file) {
  const server = createServer({ scanSettingsFile: file });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  return 'http://127.0.0.1:' + server.address().port + '/pool/api/scan-settings';
}

test('scan settings default to enabled, preserve pause across reads, and reject corrupt or invalid settings', t => {
  const file = fixture(t);
  assert.deepEqual(settings.readSettings(file), { enabled: true });
  settings.writeSettings({ enabled: false }, file);
  assert.deepEqual(settings.readSettings(file), { enabled: false });
  for (const value of [null, [], {}, { enabled: 'false' }, { enabled: false, extra: 1 }]) {
    assert.throws(() => settings.writeSettings(value, file));
    assert.deepEqual(settings.readSettings(file), { enabled: false });
  }
  fs.writeFileSync(file, '{broken');
  assert.throws(() => settings.readSettings(file));
});

test('scan switch API persists pause across server instances and can resume', async t => {
  const file = fixture(t), first = await service(t, file);
  assert.deepEqual((await (await fetch(first)).json()).settings, { enabled: true });
  const saved = await fetch(first, { method: 'PUT', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ enabled: false }) });
  assert.equal(saved.status, 200);
  const second = await service(t, file);
  assert.deepEqual((await (await fetch(second)).json()).settings, { enabled: false });
  const resumed = await fetch(second, { method: 'PUT', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ enabled: true }) });
  assert.equal(resumed.status, 200);
  assert.deepEqual(settings.readSettings(file), { enabled: true });
});

test('scan switch API rejects invalid or cross-site writes without changing the paused state', async t => {
  const file = fixture(t); settings.writeSettings({ enabled: false }, file);
  const url = await service(t, file);
  for (const [headers, body, expected] of [
    [{ 'content-type': 'application/json' }, '{"enabled":"false"}', 400],
    [{ 'content-type': 'application/json' }, '{"enabled":true,"extra":1}', 400],
    [{ 'content-type': 'application/json', origin: 'https://example.invalid' }, '{"enabled":true}', 403],
    [{ 'content-type': 'text/plain' }, '{"enabled":true}', 415],
    [{ 'content-type': 'application/json' }, ' '.repeat(5000), 413],
  ]) {
    assert.equal((await fetch(url, { method: 'PUT', headers, body })).status, expected);
    assert.deepEqual(settings.readSettings(file), { enabled: false });
  }
  assert.equal((await fetch(url, { method: 'POST' })).status, 405);
});
