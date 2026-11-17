'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const A = require('../core/room-audience');
const T = 1800000000000;

test('audience counts accept a genuine zero and reject absent or invalid counts', () => {
  for (const value of [0, '0', 72, '72']) {
    const room = {};
    assert.equal(A.recordAudience(room, { onlineNum: value }, T), true);
    assert.equal(A.publicAudience(room, T).count, Number(value));
  }
  for (const value of [null, undefined, '', -1, 1.5, 'many', {}, true, Number.MAX_SAFE_INTEGER + 1]) {
    const room = { audience: { count: 3, observedAt: T, source: 'online-gold-rank' } };
    assert.equal(A.recordAudience(room, { onlineNum: value }, T + 1), false);
    assert.equal(room.audience.count, 3);
  }
});

test('audience scheduling is bounded to active battery rooms and does not repeat within the cache interval', () => {
  const pool = new Map([['1', {}], ['2', { audienceAttemptAt: T - 60000 }], ['3', { audienceAttemptAt: T - 180000 }], ['4', {}], ['5', {}]]);
  const packet = (id, extra = {}) => ({ room_id: id, award_name: '电池红包', end_time: T / 1000 + 300, ...extra });
  const packets = [packet('1'), packet('2'), packet('3'), packet('4', { end_time: T / 1000 + 5 }), packet('5', { award_name: '礼物' })];
  assert.equal(A.selectAudienceRoom(pool, packets, T, ['1']), '3');
  assert.equal(A.selectAudienceRoom(pool, packets, T, ['1', '3']), null);
  assert.equal(A.selectAudienceRoom(pool, packets, T + 60000, ['1', '3']), '2');
});

test('cached counts retain their observation time and become visibly stale', () => {
  const room = {};
  A.recordAudience(room, { onlineNum: 42 }, T);
  assert.equal(A.publicAudience(room, T + A.INTERVAL_MS - 1).stale, false);
  assert.equal(A.publicAudience(room, T + A.INTERVAL_MS).stale, true);
  assert.equal(A.publicAudience(room, T - 1), null);
  assert.equal(A.publicAudience({ audience: { count: 42, observedAt: T, source: 'unknown' } }, T), null);
  assert.equal(A.anchorUid(0), null);
  assert.equal(A.anchorUid('123'), 123);
});
