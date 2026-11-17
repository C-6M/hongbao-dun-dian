'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const store = require('../core/qq-push-blocklist');
const { createServer } = require('../core/server');
const { Forwarder } = require('../core/qq-forward');
const notices = require('../core/notification-settings');
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-push-block-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return path.join(root, 'blocked.json');
}
test('QQ push blocklist persists independently, normalizes IDs and preserves old data on invalid input', t => {
  const file = fixture(t); assert.deepEqual(store.readSettings(file), { rooms: [] });
  store.writeSettings({ rooms: ['1741667419', 12345, '012345'] }, file);
  assert.deepEqual(store.readSettings(file).rooms, ['1741667419', '12345']);
  assert.throws(() => store.writeSettings({ rooms: ['bad'] }, file));
  assert.deepEqual(store.readSettings(file).rooms, ['1741667419', '12345']);
  store.writeSettings({ rooms: ['12345'] }, file); assert.deepEqual(store.readSettings(file).rooms, ['12345']);
  fs.writeFileSync(file, '{broken'); assert.throws(() => store.readSettings(file));
});
test('push blocklist API protects local writes, validates rooms and supports clearing the saved list', async t => {
  const file = fixture(t); let starts = 0;
  const server = createServer({ qqPushBlocklistFile: file, startQQWorker: () => { starts++; } });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise(r => server.close(r)); });
  const base = 'http://127.0.0.1:' + server.address().port, endpoint = base + '/pool/api/qq-push-blocklist';
  const put = (body, origin = base, type = 'application/json') => fetch(endpoint, { method: 'PUT',
    headers: { Origin: origin, 'content-type': type }, body: JSON.stringify(body) });
  assert.deepEqual((await(await fetch(endpoint)).json()).settings.rooms, []);
  assert.equal((await put({ rooms: ['1741667419'] }, 'https://example.com')).status, 403);
  assert.equal((await put({ rooms: [] }, base, 'text/plain')).status, 415);
  assert.equal((await put({ rooms: ['1741667419', '1741667419'] })).status, 200);
  assert.equal((await put({ rooms: ['0'] })).status, 400);
  assert.deepEqual((await(await fetch(endpoint)).json()).settings.rooms, ['1741667419']);
  assert.equal((await put({ rooms: [] })).status, 200);
  assert.deepEqual(store.readSettings(file).rooms, []); assert.equal(starts, 0);
});
test('a saved block cancels a reserved packet before transport, and removal permits the same unsent packet', async t => {
  const file = fixture(t), now = Date.parse('2026-11-13T20:00:00+08:00'); let saves = 0, calls = 0;
  const live = { updated: now, phase: 'scanning', redpockets: [{ lid: '1', room_id: '1741667419',
    battery: 100, award_num: 10, award_name: '电池红包', join_requirement: 2, end_time: now / 1000 + 600,
    audience: { count: 47, observedAt: now, source: 'online-gold-rank' } }] };
  const readContext = () => ({ live, settings: { enabled: true }, blocked: store.readSettings(file).rooms,
    noticeSettings: { ...notices.DEFAULTS, enabled: true } });
  const f = new Forwarder({ readContext, clock: () => now,
    save: state => { if (++saves === 1 && state.deliveries.length) store.writeSettings({ rooms: ['1741667419'] }, file); },
    send: async () => { calls++; return { status: 'sent' }; } });
  await f.step(); assert.equal(calls, 0); assert.equal(f.state.deliveries.length, 0);
  store.writeSettings({ rooms: [] }, file); await f.step(); assert.equal(calls, 1);
});
