'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { validateSettings, readSettings } = require('../core/room-blocklist');

test('room blocklist normalizes IDs, rereads updates, defaults empty only when missing, and rejects invalid files', () => {
  assert.deepEqual(validateSettings({ rooms: [22748536, '022748536', '1234'] }), { rooms: ['22748536', '1234'] });
  for (const rooms of [[0], [-1], [1.2], [true], ['bad'], ['1234567890123']]) {
    assert.throws(() => validateSettings({ rooms }));
  }
  assert.throws(() => validateSettings({ rooms: [], enabled: true }));
  let content = '{"rooms":["22748536"]}';
  const io = { readFileSync() { return content; } };
  assert.deepEqual(readSettings('fixture', io), { rooms: ['22748536'] });
  content = '{"rooms":[]}';
  assert.deepEqual(readSettings('fixture', io), { rooms: [] });
  content = '{broken';
  assert.throws(() => readSettings('fixture', io));
  assert.deepEqual(readSettings('missing', { readFileSync() { throw Object.assign(new Error(), { code: 'ENOENT' }); } }), { rooms: [] });
  assert.throws(() => readSettings('denied', { readFileSync() { throw Object.assign(new Error(), { code: 'EACCES' }); } }));
});
