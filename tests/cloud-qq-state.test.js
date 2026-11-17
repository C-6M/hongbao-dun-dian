'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { importState } = require('../deploy/instabox/import-qq-state');
const NOW = Date.now();
function payload() {
  return { version: 1, files: {
    'qq-bot-config.json': { version: 1, active: true, appId: '123', appSecret: 'test-private-secret',
      groupOpenid: 'group_target_123', bindingCode: '1234567890abcdef' },
    'qq-bot-history.json': { version: 1, appId: '123', groupOpenid: 'group_target_123', facts: [],
      session: { id: 'test-session', seq: 10 }, fullMessages: true, coverageStartedAt: NOW - 300000 },
    'qq-forward-state.json': { version: 1, pid: 12345, enabled: false, sent: 1, failed: 0,
      deliveries: [{ key: '1127875934:1', id: '1', room: '1000', until: NOW + 86400000, status: 'sent' }] },
    'qq-anchor-names.json': {}, 'qq-audience-uids.json': {},
    'qq-push-blocklist.json': { rooms: ['1741667419'] },
    'notification-settings.json': { enabled: true, minPerPerson: 10, minBattery: 100, minRemainingSeconds: 120 },
  } };
}
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-cloud-import-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return path.join(root, 'data');
}
test('cloud migration preserves sent records, group binding and resumable coverage while leaving sending disabled', t => {
  const dir = fixture(t), input = payload();
  const summary = importState(input, dir);
  const read = file => JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
  assert.deepEqual(read('qq-forward-settings.json'), { enabled: false });
  assert.equal(read('qq-forward-state.json').pid, 0);
  assert.deepEqual(read('qq-forward-state.json').deliveries, input.files['qq-forward-state.json'].deliveries);
  assert.deepEqual(read('qq-bot-history.json'), input.files['qq-bot-history.json']);
  assert.equal(read('qq-bot-config.json').appSecret, 'test-private-secret');
  assert.deepEqual(read('qq-push-blocklist.json').rooms, ['1741667419']);
  assert.equal(read('notification-settings.json').minRemainingSeconds, 120);
  assert.doesNotMatch(JSON.stringify(summary), /test-private-secret|test-session|group_target/);
  if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(dir, 'qq-bot-config.json')).mode & 0o777, 0o600);
});
test('active local sends, outstanding reservations and inconsistent bot identities stop migration before any file write', t => {
  const dir = fixture(t);
  for (const mutate of [
    p => { p.files['qq-forward-state.json'].enabled = true; },
    p => { p.files['qq-forward-state.json'].deliveries[0].status = 'reserved'; },
    p => { p.files['qq-bot-history.json'].groupOpenid = 'group_wrong_123'; },
    p => { p.files['qq-bot-config.json'].appSecret = false; },
  ]) {
    const input = payload(); mutate(input); assert.throws(() => importState(input, dir));
    assert.equal(fs.existsSync(dir), false);
  }
});
