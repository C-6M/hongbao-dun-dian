'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildNotification: build } = require('../core/notifications');
const rules = { enabled: true, minPerPerson: 10, minBattery: 0, minRemainingSeconds: 0 };
const buildNotification = (record, time, settings = rules) => build(record, time, settings);
const time = Date.parse('2026-11-06T12:00:00+08:00');
const packet = { lid: 123, room_id: '4567', award_name: '电池红包',
  battery: 100, award_num: 10, end_time: (time + 300000) / 1000 };

test('inclusive per-person threshold accepts 100/10 and 50/5, rejects rounded-up values', () => {
  assert.ok(buildNotification(packet, time));
  assert.ok(buildNotification({ ...packet, battery: 50, award_num: 5 }, time));
  assert.ok(buildNotification({ ...packet, battery: 120 }, time));
  assert.equal(buildNotification({ ...packet, battery: 99.999, per_person: 10 }, time), null);
  assert.equal(buildNotification({ ...packet, battery: 100, award_num: 20 }, time), null);
});

test('expired, non-battery and invalid recipient counts do not notify', () => {
  for (const change of [{ expired: true }, { end_time: time / 1000 }, { award_name: '亲密度红包' },
    { award_num: 0 }, { award_num: -1 }, { award_num: 1.5 }, { battery: Infinity },
    { room_id: '1?redirect=bad' }, { lid: '' }]) {
    assert.equal(buildNotification({ ...packet, ...change }, time), null);
  }
});

test('special participation gates block notifications even with all amount limits disabled', () => {
  const unlimited = { enabled: true, minPerPerson: 0, minBattery: 0, minRemainingSeconds: 0 };
  for (const join_requirement of [3, '3', 4, 'unknown']) {
    assert.equal(buildNotification({ ...packet, join_requirement }, time, unlimited), null);
  }
  for (const join_requirement of [0, 1, 2, '2']) {
    assert.ok(buildNotification({ ...packet, join_requirement }, time));
  }
  assert.equal(buildNotification({ ...packet, raw: { join_requirement: 3 } }, time), null);
});

test('notification has the actual share, remaining time, and a fixed live-room URL', () => {
  const message = buildNotification(packet, time);
  assert.equal(message.title, '红包蹲点 · 人均 10 电池');
  assert.match(message.body, /100 电池 \/ 10 人/);
  assert.match(message.body, /剩余 5分0秒/);
  assert.equal(message.url, 'https://live.bilibili.com/4567');
});

test('all manual conditions must match, including exact boundaries and disabled limits', () => {
  const all = { enabled: true, minPerPerson: 10, minBattery: 100, minRemainingSeconds: 300 };
  assert.ok(buildNotification(packet, time, all));
  for (const change of [{ enabled: false }, { minPerPerson: 10.01 }, { minBattery: 100.01 }, { minRemainingSeconds: 301 }]) {
    assert.equal(buildNotification(packet, time, { ...all, ...change }), null);
  }
  assert.ok(buildNotification({ ...packet, battery: 1 }, time,
    { enabled: true, minPerPerson: 0, minBattery: 0, minRemainingSeconds: 0 }));
});
