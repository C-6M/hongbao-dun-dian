'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const S = require('../core/strategy');
const T = Date.parse('2026-11-10T22:00:00+08:00');
const rankItem = (roomid, rank, extra = {}) => ({ roomid: String(roomid), rank, score: rank * 100,
  liveStatus: 1, parentAreaId: 1, areaId: 2, ...extra });
const listing = { page: 1, pageSize: 30, index: 0, parentAreaId: 3, areaId: 4 };

function ordinary(pool, count = 200) {
  for (let i = 0; i < count; i++) S.ensureRoom(pool, String(100000 + i), T);
}

function assertCap(plan) {
  const priority = new Set(plan.priorityPlan);
  let sent = 0;
  for (let i = 0; i < plan.plan.length; i++) {
    if (priority.has(plan.plan[i])) sent++;
    assert.ok(sent <= (i + 1) * .2, 'every dispatch prefix must retain the 20% cap');
  }
  assert.ok(sent <= Math.floor(plan.quota.rpQuota * .2));
  assert.equal(new Set(plan.plan).size, plan.plan.length);
}

test('complete hot rank snapshots admit only live unblocked rooms without changing area evidence or confirmed tiers', () => {
  const pool = new Map();
  S.recordListing(pool, { roomid: 1, online: 1000 }, listing, T - 1000);
  const originalArea = { ...pool.get('1').listingPriority };
  S.ensureRoom(pool, '2', T).lastBatteryHit = T;
  S.ensureRoom(pool, '3', T).qqLastAt = T;
  S.ensureRoom(pool, '4', T - 1000).hotRankPriority = { at: T - 1000, rank: 5, score: 1 };
  const blocked = JSON.stringify(pool.get('4'));
  const result = S.recordHotRankSnapshot(pool, [rankItem(1, 1), rankItem(2, 2), rankItem(3, 3),
    rankItem(4, 4), rankItem(5, 5, { liveStatus: 0 }), rankItem(6, 6, { liveStatus: 2 })], T, { blockedRooms: ['4'] });
  assert.deepEqual(result, { received: 6, live: 3, added: 0, updated: 3, removed: 0, blocked: 1, offline: 2 });
  assert.deepEqual(pool.get('1').listingPriority, originalArea);
  assert.equal(pool.get('1').lastListedAt, T);
  assert.equal(S.tierOf(pool.get('1'), T), 'COLD');
  assert.equal(S.tierOf(pool.get('2'), T), 'HOT');
  assert.equal(S.tierOf(pool.get('3'), T), 'WARM');
  assert.equal(S.hotRankSignal(pool.get('2'), T).eligible, true);
  assert.equal(JSON.stringify(pool.get('4')), blocked);
  assert.equal(pool.has('5'), false);
  assert.equal(pool.has('6'), false);
  ordinary(pool);
  const plan = S.buildRoundPlan(pool, 1, T, { blockedRooms: ['4'] });
  assert.deepEqual(plan.priorityPlan, ['1']);
  assert.ok(plan.plan.includes('2') && plan.plan.includes('3'));
  assertCap(plan);
});

test('invalid whole snapshots leave all room and ranking evidence unchanged', () => {
  const pool = new Map();
  S.recordHotRankSnapshot(pool, [rankItem(1, 1)], T);
  const before = JSON.stringify(Object.fromEntries(pool));
  const invalid = [null, {}, [rankItem(2, 1), rankItem(3, 1)], [rankItem(2, 1), rankItem(2, 2)],
    [rankItem(2, 51)], [rankItem(0, 1)], [rankItem('bad', 1)], [rankItem(2, 1, { score: -1 })],
    [rankItem(2, 1, { score: Infinity })], [rankItem(2, 1, { liveStatus: '1' })],
    [rankItem(2, 1, { areaId: -1 })], [rankItem(2, 1, { rank: 1.5 })],
    [rankItem(2, 1), rankItem(3, 2, { roomid: 3 })]];
  for (const items of invalid) {
    assert.throws(() => S.recordHotRankSnapshot(pool, items, T + 1000), /快照/);
    assert.equal(JSON.stringify(Object.fromEntries(pool)), before);
  }
  for (const time of [0, -1, NaN, Infinity]) {
    assert.throws(() => S.recordHotRankSnapshot(pool, [], time), /快照/);
    assert.equal(JSON.stringify(Object.fromEntries(pool)), before);
  }
});

test('successful snapshots remove dropped and offline global evidence while preserving area and blocked records', () => {
  const pool = new Map();
  S.recordHotRankSnapshot(pool, [rankItem(1, 1), rankItem(2, 2), rankItem(3, 3)], T);
  S.recordListing(pool, { roomid: 1, online: 9 }, listing, T);
  const area = { ...pool.get('1').listingPriority };
  const beforeBlocked = JSON.stringify(pool.get('3'));
  const result = S.recordHotRankSnapshot(pool, [rankItem(2, 1, { liveStatus: 0 }), rankItem(4, 2)], T + 1000,
    { blockedRooms: ['3'] });
  assert.equal(result.removed, 2);
  assert.equal(result.added, 1);
  assert.equal(pool.get('1').hotRankPriority, undefined);
  assert.equal(pool.get('2').hotRankPriority, undefined);
  assert.equal(pool.get('2').lastListedAt, T);
  assert.deepEqual(pool.get('1').listingPriority, area);
  assert.equal(JSON.stringify(pool.get('3')), beforeBlocked);
  assert.equal(pool.get('4').hotRankPriority.rank, 2, 'offline filtering must not renumber the remaining ranks');
  S.recordHotRankSnapshot(pool, [], T + 2000, { blockedRooms: ['3'] });
  assert.equal(pool.get('4').hotRankPriority, undefined);
  assert.equal(JSON.stringify(pool.get('3')), beforeBlocked);
});

test('global ranking survives persistence and expires independently from fresh area ranking', () => {
  const pool = new Map();
  S.recordHotRankSnapshot(pool, [rankItem(1, 50)], T);
  const restored = new Map(Object.entries(JSON.parse(JSON.stringify(Object.fromEntries(pool)))));
  ordinary(restored);
  assert.equal(S.hotRankSignal(restored.get('1'), T + 899999).eligible, true);
  assert.equal(S.buildRoundPlan(restored, 1, T + 899999).priorityPlan.includes('1'), true);
  assert.equal(S.hotRankSignal(restored.get('1'), T + 900000).eligible, false);
  assert.equal(S.buildRoundPlan(restored, 1, T + 900000).priorityPlan.includes('1'), false);
  S.recordListing(restored, { roomid: 1, online: 123 }, listing, T + 899999);
  assert.equal(S.buildRoundPlan(restored, 1, T + 900000).priorityPlan.includes('1'), true);
  assert.equal(restored.get('1').hotRankPriority.at, T);
  assert.equal(S.hotRankSignal(restored.get('1'), T - 1).eligible, false);
  for (const p of [{ at: T, rank: 51, score: 0 }, { at: T, rank: 1, score: NaN }, { at: T + 1, rank: 1, score: 0 }]) {
    assert.equal(S.hotRankSignal({ hotRankPriority: p }, T).eligible, false);
  }
});

test('both sources share one capped pool and all fifty global ranks survive high online area candidates', () => {
  const pool = new Map();
  for (let i = 1; i <= 700; i++) S.recordListing(pool, { roomid: 2000 + i, online: i * 1000000 }, listing, T);
  const items = Array.from({ length: 50 }, (_, i) => rankItem(i + 1, i + 1, { score: .001 }));
  S.recordHotRankSnapshot(pool, items, T);
  S.recordListing(pool, { roomid: 1, online: Number.MAX_SAFE_INTEGER }, listing, T);
  ordinary(pool, 1000);
  const seenGlobal = new Set();
  for (let round = 1; round <= 32; round++) {
    const time = T + round * 25000;
    const plan = S.buildRoundPlan(pool, round, time);
    assert.equal(plan.counts.priority, 600);
    assertCap(plan);
    assert.equal(plan.plan.length + plan.quota.ipReserve + plan.quota.anchorReserve, 110);
    assert.ok(plan.quota.regularCold >= Math.ceil(plan.quota.rpQuota * .3));
    for (const id of plan.plan) {
      if (Number(id) <= 50 && plan.priorityPlan.includes(id)) seenGlobal.add(id);
      S.recordScan(pool.get(id), [], time);
    }
  }
  assert.equal(seenGlobal.size, 50);
});

test('hot rank candidates retain two minute attempts and error retry delays without extra budget', () => {
  const pool = new Map();
  S.recordHotRankSnapshot(pool, [rankItem(1, 1)], T);
  ordinary(pool);
  S.recordScan(pool.get('1'), [], T);
  assert.equal(S.buildRoundPlan(pool, 1, T + 119999).priorityPlan.length, 0);
  assert.deepEqual(S.buildRoundPlan(pool, 1, T + 120000).priorityPlan, ['1']);
  S.recordError(pool.get('1'), T + 120000);
  assert.equal(S.buildRoundPlan(pool, 1, T + 120001).priorityPlan.length, 0);
  assert.deepEqual(S.buildRoundPlan(pool, 1, T + 240000).priorityPlan, ['1']);
});

test('hot rank observations preserve historical routing and its slower empty-scan interval', () => {
  const pool = new Map();
  const r = S.ensureRoom(pool, '1', T);
  r.historicalSource = { version: 1, generatedAt: T - 1000, lastUsefulAt: T - 86400000, score: 10 };
  S.recordHotRankSnapshot(pool, [rankItem(1, 1)], T);
  ordinary(pool);
  let plan = S.buildRoundPlan(pool, 1, T);
  assert.deepEqual(plan.historicalPlan, ['1']);
  assert.equal(plan.priorityPlan.includes('1'), false);
  S.recordScan(r, [], T);
  assert.equal(S.buildRoundPlan(pool, 1, T + 120000).plan.includes('1'), false);
  assert.deepEqual(S.buildRoundPlan(pool, 1, T + 300000).historicalPlan, ['1']);
  r.historicalEmptyScans = 4;
  assert.equal(S.historicalSignal(r, T + 300000).intervalMs, 900000);
});

test('global-only and small mixed plans cannot consume more than the shared 20 percent share', () => {
  for (const count of [0, 1, 4, 5, 20, 87, 88, 100]) {
    const pool = new Map();
    S.recordHotRankSnapshot(pool, Array.from({ length: 50 }, (_, i) => rankItem(i + 1, i + 1)), T);
    ordinary(pool, count);
    for (const round of [1, 12]) {
      const plan = S.buildRoundPlan(pool, round, T);
      assertCap(plan);
      assert.ok(plan.plan.length + plan.quota.ipReserve + plan.quota.anchorReserve <= 110);
      if (!count) assert.equal(plan.priorityPlan.length, 0);
    }
  }
});
