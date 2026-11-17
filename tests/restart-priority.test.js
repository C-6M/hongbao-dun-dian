'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const S = require('../core/strategy');
const restart = require('../core/restart-priority');
const T = Date.parse('2026-11-14T12:00:00+08:00');
const cfg = { ...S.DEFAULTS };

function rooms() {
  return new Map([
    ['1000', { firstSeen: T, lastBatteryHit: T, batteryHits: 1 }],
    ['1001', { firstSeen: T, qqLastAt: T }],
    ['1002', { firstSeen: T }],
  ]);
}

test('saved HOT/WARM tiers and scores survive downtime without changing the room evidence', () => {
  const pool = rooms(), original = structuredClone(pool);
  const saved = restart.snapshot(pool, T, cfg);
  const next = restart.restore({ restartPriority: saved }, pool, T + 3 * 86400000, cfg);
  assert.equal(next.pending.get('1000').tier, 'HOT');
  assert.equal(next.pending.get('1001').tier, 'WARM');
  assert.equal(next.pending.get('1000').score, S.roomScore(pool.get('1000'), T, cfg));
  assert.equal(S.tierOf(pool.get('1000'), T + 3 * 86400000, cfg), 'COLD');
  assert.deepEqual(pool, original);
  assert.ok(!next.pending.has('1002'));
});

test('older pool files reconstruct priorities at the last save time and missing times add no priorities', () => {
  const pool = rooms();
  const next = restart.restore({ at: new Date(T).toISOString() }, pool, T + 3 * 86400000, cfg);
  assert.equal(next.pending.size, 2);
  assert.equal(restart.restore({}, pool, T, cfg).pending.size, 0);
});

test('an interrupted pass retains unscanned rooms on save and completed stale rooms return to COLD', () => {
  const pool = rooms(), time = T + 3 * 86400000;
  const pending = restart.restore({ at: new Date(T).toISOString() }, pool, time, cfg).pending;
  pending.delete('1000');
  const saved = restart.snapshot(pool, time, cfg, pending);
  assert.deepEqual(saved.rooms.map(r => [r.room, r.tier]), [['1001', 'WARM']]);
  assert.equal(restart.restore({ restartPriority: saved }, pool, time + 10000, cfg).pending.get('1001').tier, 'WARM');
});

test('blocked and removed rooms do not enter the pass and malformed snapshots stop restoration', () => {
  const pool = rooms(), saved = restart.snapshot(pool, T, cfg);
  pool.delete('1001');
  assert.equal(restart.restore({ restartPriority: saved }, pool, T, { ...cfg, blockedRooms: ['1000'] }).pending.size, 0);
  for (const invalid of [null, { ...saved, version: 9 }, { ...saved, at: T + 6000 },
    { ...saved, rooms: [{ room: '1000', tier: 'COLD', score: 1 }] },
    { ...saved, rooms: [saved.rooms[0], saved.rooms[0]] }]) {
    assert.throws(() => restart.restore({ restartPriority: invalid }, rooms(), T, cfg));
  }
});

test('a full saved pass spans budgets, visits every priority once and then resumes normal tiers', () => {
  const pool = new Map();
  for (let i = 0; i < 300; i++) pool.set(String(1000 + i), {
    firstSeen: T, ...(i < 30 ? { lastBatteryHit: T } : { qqLastAt: T }), lastAttempt: T,
  });
  for (let i = 0; i < 400; i++) pool.set(String(2000 + i), { firstSeen: T });
  const time = T + 3 * 86400000;
  const pending = restart.restore({ at: new Date(T).toISOString() }, pool, time, cfg).pending;
  const visited = new Set();
  let round = 1;
  while (pending.size && round < 20) {
    const plan = S.buildRoundPlan(pool, round++, time, { ...cfg, perIpBudget: 130, restartPriority: pending });
    assert.ok(plan.plan.length + plan.quota.ipReserve + plan.quota.anchorReserve <= 130);
    assert.ok(plan.quota.regularCold >= Math.ceil(plan.quota.rpQuota * .3));
    assert.equal(new Set(plan.plan).size, plan.plan.length);
    for (const id of plan.plan) {
      if (pending.delete(id)) { assert.ok(!visited.has(id)); visited.add(id); }
    }
  }
  assert.equal(visited.size, 300);
  assert.equal(pending.size, 0);
  assert.ok(round > 2);
  const normal = S.buildRoundPlan(pool, round, time, { ...cfg, restartPriority: pending });
  assert.equal(normal.counts.hot, 0);
  assert.equal(normal.counts.warm, 0);
});

test('pool cleanup keeps pending saved rooms until their single pass is finished', () => {
  const pool = rooms();
  const time = T + 20 * 86400000;
  const pending = restart.restore({ at: new Date(T).toISOString() }, pool, time, cfg).pending;
  S.prunePool(pool, time, { ...cfg, restartPriority: pending });
  assert.ok(pool.has('1000') && pool.has('1001'));
  const normal = structuredClone(pool);
  S.prunePool(normal, time, cfg);
  pending.clear();
  S.prunePool(pool, time, { ...cfg, restartPriority: pending });
  assert.deepEqual(pool, normal);
});

test('retained priority bypasses the old scan interval but preserves retry backoff and blocking', () => {
  const pool = rooms();
  pool.get('1000').lastAttempt = T;
  pool.get('1001').retryAt = T + 60000;
  const pending = restart.restore({ at: new Date(T).toISOString() }, pool, T, cfg).pending;
  const plan = S.buildRoundPlan(pool, 1, T, { ...cfg, restartPriority: pending });
  assert.ok(plan.plan.includes('1000'));
  assert.ok(!plan.plan.includes('1001'));
  const blocked = S.buildRoundPlan(pool, 1, T, { ...cfg, restartPriority: pending, blockedRooms: ['1000'] });
  assert.ok(!blocked.plan.includes('1000'));
});
