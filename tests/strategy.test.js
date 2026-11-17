'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const S = require('../core/strategy');
const { parseHttpResult } = require('../core/http-result');
const T = Date.parse('2026-11-06T12:00:00+08:00');
const battery = (id = 1) => ({ lot_id: id, end_time: T / 1000 + 600,
  total_price: 10000, awards: [{ gift_name: '电池红包', num: 10 }] });

const historicalRoom = overrides => ({ firstSeen: T - 2 * 86400000,
  historicalSource: { version: 1, generatedAt: T - 1000, lastUsefulAt: T - 86400000, score: 3 },
  ...overrides });

test('historical sources spend only flexible exploration capacity and keep all existing reserves', () => {
  const pool = new Map();
  for (let i = 0; i < 100; i++) pool.set('s' + i, historicalRoom());
  for (let i = 0; i < 1000; i++) pool.set('c' + i, { firstSeen: T });
  for (let i = 0; i < 100; i++) pool.set('p' + i, rankedRoom(i));
  for (let i = 0; i < 10; i++) pool.set('h' + i, { lastBatteryHit: T });
  for (let i = 0; i < 20; i++) pool.set('w' + i, { qqLastAt: T });
  for (let i = 0; i < 100; i++) pool.set('z' + i, { firstSeen: T - 86400000 });
  for (const round of [1, 12]) {
    const p = S.buildRoundPlan(pool, round, T);
    assert.equal(p.plan.length + p.quota.ipReserve + p.quota.anchorReserve, 110);
    assert.equal(new Set(p.plan).size, p.plan.length);
    assert.equal(p.quota.hot, 10);
    assert.equal(p.quota.warm, 20);
    assert.ok(p.quota.regularCold >= Math.ceil(p.quota.rpQuota * .3));
    assert.ok(p.quota.stale >= 3);
    assert.equal(p.historicalPlan.length, Math.floor(p.quota.rpQuota * .1));
    const priority = new Set(p.priorityPlan);
    let n = 0;
    p.plan.forEach((id, index) => {
      if (priority.has(id)) n++;
      assert.ok(n <= (index + 1) * .2);
    });
  }
  for (let i = 10; i < 300; i++) pool.set('h' + i, { lastBatteryHit: T });
  assert.equal(S.buildRoundPlan(pool, 1, T).historicalPlan.length, 0);
});

test('historical candidate waits for 5 or 15 minutes, backs off on four empty scans, and errors preserve misses', () => {
  const r = historicalRoom({ lastListedAt: T, lastAttempt: T });
  const pool = new Map([['1234', r]]);
  assert.equal(S.buildRoundPlan(pool, 1, T + 299999).historicalPlan.length, 0);
  assert.deepEqual(S.buildRoundPlan(pool, 1, T + 300000).historicalPlan, ['1234']);
  for (let i = 0; i < 4; i++) S.recordScan(r, [], T + i * 300000);
  assert.equal(r.historicalEmptyScans, 4);
  assert.equal(S.historicalSignal(r, T + 900000).intervalMs, 900000);
  S.recordError(r, T + 1000000);
  assert.equal(r.historicalEmptyScans, 4);
  assert.equal(S.buildRoundPlan(pool, 1, T + 1899999).historicalPlan.length, 0);
  assert.deepEqual(S.buildRoundPlan(pool, 1, T + 1900000).historicalPlan, ['1234']);
  const useful = { ...battery(91), end_time: (T + 2500000) / 1000 };
  S.recordScan(r, [useful], T + 1900000);
  assert.equal(r.historicalEmptyScans, 0);
  assert.equal(S.tierOf(r, T + 1900000), 'HOT');
  r.historicalEmptyScans = 4;
  S.recordScan(r, [useful], T + 1901000);
  assert.equal(r.historicalEmptyScans, 4, 'a repeated packet must not restore the history probe interval');
  const old = historicalRoom({ lastAttempt: T });
  assert.equal(S.historicalSignal(old, T + 899999).due, false);
  assert.equal(S.historicalSignal(old, T + 900000).due, true);
});

test('historical membership does not bypass HOT/WARM clocks, blocklist, or evidence expiry', () => {
  const pool = new Map([
    ['hot', historicalRoom({ lastBatteryHit: T, lastAttempt: T })],
    ['warm', historicalRoom({ qqLastAt: T, lastAttempt: T })],
    ['blocked', historicalRoom()],
    ['expired', historicalRoom({ historicalSource: { version: 1, generatedAt: T - 31 * 86400000,
      lastUsefulAt: T - 30 * 86400000 } })],
  ]);
  const p = S.buildRoundPlan(pool, 1, T + 15000, { blockedRooms: ['blocked'] });
  assert.ok(p.plan.includes('hot'));
  assert.ok(!p.plan.includes('warm'));
  assert.ok(!p.plan.includes('blocked'));
  assert.equal(p.historicalPlan.length, 0);
  assert.equal(S.historicalSignal(pool.get('expired'), T).eligible, false);
  assert.equal(S.historicalSignal(historicalRoom({ lastListedAt: T + 1 }), T).intervalMs, 900000);
});

test('pool cleanup retains a fixed historical member until its evidence window expires', () => {
  const r = historicalRoom({ firstSeen: T - 20 * 86400000,
    historicalSource: { version: 1, generatedAt: T - 10 * 86400000, lastUsefulAt: T - 10 * 86400000 } });
  const pool = new Map([['1234', r], ['5678', { firstSeen: T - 20 * 86400000 }]]);
  assert.equal(S.prunePool(pool, T), 1);
  assert.ok(pool.has('1234'));
  assert.equal(S.prunePool(pool, T + 20 * 86400000), 1);
  assert.equal(pool.size, 0);
});

test('blocked rooms are excluded from every tier while their evidence and the budget survive', () => {
  const blockedRooms = ['1', '2', '3', '4', '5'];
  const pool = new Map([
    ['1', { lastBatteryHit: T, batteryHits: 1 }],
    ['2', { qqLastAt: T }],
    ['3', rankedRoom()], ['4', { firstSeen: T }],
    ['5', { firstSeen: T - 86400000 }],
  ]);
  for (let i = 0; i < 200; i++) pool.set(String(1000 + i), { firstSeen: T });
  const evidence = JSON.stringify([...pool].slice(0, 5));
  for (const round of [1, 12]) {
    const p = S.buildRoundPlan(pool, round, T, { blockedRooms });
    assert.ok(p.plan.every(id => !blockedRooms.includes(id)));
    assert.equal(p.counts.blocked, 5);
    assert.equal(p.counts.priority, 0);
    assert.equal(p.plan.length + p.quota.ipReserve + p.quota.anchorReserve, 110);
  }
  assert.equal(JSON.stringify([...pool].slice(0, 5)), evidence);
});

test('listing discovery and QQ cannot add blocked rooms or refresh existing blocked evidence', () => {
  const pool = new Map([['22748536', { firstSeen: T - 1000, qqPushes: 2 }]]);
  const options = { blockedRooms: ['22748536', '1234'] };
  const evidence = JSON.stringify(pool.get('22748536'));
  const listing = { page: 1, pageSize: 30, index: 0, parentAreaId: 1, areaId: 2 };
  for (const roomid of [22748536, 1234]) {
    assert.equal(S.recordListing(pool, { roomid, online: 10000 }, listing, T, options), null);
  }
  const result = S.mergeQQ(pool, { pushes: ['22748536', '1234', '5678'].map(room => ({
    room, battery: 100, push_time: '2026-11-06 11:59:00',
  })) }, T, options);
  assert.equal(result.updated, 1);
  assert.equal(pool.has('1234'), false);
  assert.equal(pool.has('5678'), true);
  assert.equal(JSON.stringify(pool.get('22748536')), evidence);
});

test('HTTP trailer is parsed; bans, errors and empty success remain distinct', () => {
  for (const code of [412, 429]) assert.equal(parseHttpResult('<html>拒绝</html>\n###' + code).status, 'BANNED');
  assert.equal(parseHttpResult('{"code":-352}\n###200').status, 'BANNED');
  assert.equal(parseHttpResult('{"code":0}\n###500').status, 'HTTP');
  assert.equal(parseHttpResult('\n###000', new Error('timeout')).status, 'NETWORK');
  assert.equal(parseHttpResult('{broken\n###200').status, 'PARSE');
  assert.deepEqual(parseHttpResult('{"code":0,"data":{"lot_info":[]}}\r\n###200'),
    { status: 'OK', httpCode: 200, code: 0, data: { lot_info: [] } });
});

test('exploration and WARM retain capacity when HOT exceeds the entire budget', () => {
  const pool = new Map();
  for (let i = 0; i < 300; i++) pool.set('h' + i, { lastBatteryHit: T, batteryHits: 1 });
  for (let i = 0; i < 300; i++) pool.set('w' + i, { qqLastAt: T });
  for (let i = 0; i < 1000; i++) pool.set('c' + i, { firstSeen: T });
  for (const round of [1, 12]) {
    const p = S.buildRoundPlan(pool, round, T);
    assert.equal(p.plan.length + p.quota.anchorReserve + p.quota.ipReserve, 110);
    assert.ok(p.quota.cold >= Math.ceil(p.quota.rpQuota * 0.3));
    assert.ok(p.quota.warm > 0);
    assert.equal(new Set(p.plan).size, p.plan.length);
  }
});

test('cold traversal does not resample before reaching unvisited peers', () => {
  const pool = new Map(Array.from({ length: 400 }, (_, i) => ['c' + i, { firstSeen: T }]));
  const seen = new Set();
  for (let round = 1; round <= 3; round++) {
    const time = T + round * 20000;
    for (const id of S.buildRoundPlan(pool, round, time).plan) {
      assert.ok(!seen.has(id), 'repeated before finishing coverage: ' + id);
      seen.add(id);
      S.recordScan(pool.get(id), [], time);
    }
  }
  assert.equal(seen.size, 327);
  for (const id of S.buildRoundPlan(pool, 4, T + 80000).plan) seen.add(id);
  assert.equal(seen.size, 400);
});

test('old HOT rooms get a turn even if their score is lower', () => {
  const pool = new Map(Array.from({ length: 250 }, (_, i) => ['h' + i,
    { firstSeen: T, lastBatteryHit: T, batteryHits: i + 1 }]));
  const seen = new Set();
  for (let round = 1; round <= 3; round++) {
    const time = T + round * 20000;
    for (const id of S.buildRoundPlan(pool, round, time).plan) {
      seen.add(id); S.recordScan(pool.get(id), [], time);
    }
  }
  assert.equal(seen.size, 250);
});

test('WARM waits 90 seconds and releases capacity to COLD', () => {
  const pool = new Map([['warm', { qqLastAt: T, lastAttempt: T }], ['cold', { firstSeen: T }]]);
  assert.deepEqual(S.buildRoundPlan(pool, 1, T + 80000).plan, ['cold']);
  assert.ok(S.buildRoundPlan(pool, 1, T + 90000).plan.includes('warm'));
});

test('empty success updates scans; failures preserve successful evidence and misses', () => {
  const r = S.ensureRoom(new Map(), '1234', T);
  S.recordScan(r, [], T);
  assert.equal(r.misses, 1); assert.equal(r.successScans, 1); assert.equal(r.lastScan, T);
  S.recordError(r, T + 1000);
  assert.equal(r.misses, 1); assert.equal(r.successScans, 1); assert.equal(r.lastScan, T);
  assert.equal(r.scanErrors, 1); assert.ok(r.retryAt > T + 1000);
  S.recordScan(r, [], T + 40000);
  assert.equal(r.retryAt, 0); assert.equal(r.consecutiveErrors, 0); assert.equal(r.misses, 2);
});

test('only unique, live battery events earn battery priority, including after persistence', () => {
  const pool = new Map(); const r = S.ensureRoom(pool, '1234', T);
  const other = { ...battery(2), awards: [{ gift_name: '亲密度红包' }] };
  S.recordScan(r, [other], T);
  assert.equal(S.tierOf(r, T), 'COLD');
  assert.equal(S.recordScan(r, [battery()], T).length, 1);
  assert.equal(S.tierOf(r, T), 'HOT');
  const restored = JSON.parse(JSON.stringify(r));
  assert.equal(S.recordScan(restored, [battery()], T + 1000).length, 0);
  assert.equal(restored.batteryHits, 1);
  assert.equal(S.recordScan(restored, [battery(3)], T + 700000).length, 0);
});

test('repeated low-value packets slow HOT to 60 seconds while a useful packet immediately restores fast scans', () => {
  const pool = new Map(), r = S.ensureRoom(pool, '1234', T);
  const low = id => ({ ...battery(id), awards: [{ gift_name: '电池红包', num: 50 }] });
  S.recordScan(r, [low(1)], T);
  assert.equal(S.hotSignal(r, T + 20000).intervalMs, 15000);
  S.recordScan(r, [low(1)], T + 20000);
  assert.equal(S.hotSignal(r, T + 20000).low, 1);
  S.recordScan(r, [low(1), low(2)], T + 40000);
  assert.equal(S.hotSignal(r, T + 40000).intervalMs, 60000);
  assert.deepEqual(S.buildRoundPlan(pool, 1, T + 99999).plan, []);
  assert.deepEqual(S.buildRoundPlan(pool, 1, T + 100000).plan, ['1234']);
  S.recordScan(r, [battery(3)], T + 100000);
  assert.equal(S.hotSignal(r, T + 100000).quality, 'useful');
  assert.deepEqual(S.buildRoundPlan(pool, 1, T + 115000).plan, ['1234']);
  const restored = JSON.parse(JSON.stringify(r));
  S.recordScan(restored, [battery(3)], T + 120000);
  assert.equal(S.hotSignal(restored, T + 120000).useful, 1);
  assert.equal(restored.batteryValueEvidence.find(e => e.id === '3').at, T + 100000);
});

test('special batteries count as no usable discovery and cannot buy HOT priority with a large amount', () => {
  const pool = new Map(), r = S.ensureRoom(pool, '1234', T);
  r.qqLastAt = T - 3600000;
  const special = { ...battery(1), join_requirement: 3, total_price: 1000000 };
  assert.equal(S.recordScan(r, [special], T).length, 0);
  assert.equal(r.misses, 1); assert.equal(r.qqMisses, 1);
  assert.equal(r.batteryHits || 0, 0);
  assert.equal(S.tierOf(r, T), 'WARM');
  S.recordBatteryValue(r, special, T, T);
  assert.equal(S.hotSignal(r, T).useful, 0);
  const low = id => ({ ...battery(id), join_requirement: 2, awards: [{ gift_name: '电池红包', num: 50 }] });
  S.recordScan(r, [low(2), low(3)], T + 1000);
  assert.equal(S.hotSignal(r, T + 1000).intervalMs, 60000);
  assert.equal(S.recordScan(r, [special], T + 2000).length, 0);
  assert.equal(r.batteryHits, 2);
  assert.equal(r.lastBatteryHit, T + 1000);
  assert.equal(S.hotSignal(r, T + 2000).intervalMs, 60000);
  S.recordScan(r, [{ ...battery(4), join_requirement: 1 }], T + 3000);
  assert.equal(S.hotSignal(r, T + 3000).quality, 'useful');
});

test('rebuilding an affected room removes restricted value without altering scan or error evidence', () => {
  const r = { batteryHits: 2, lastBatteryHit: T, hits: 8, lastAttempt: T - 50, misses: 4,
    scanErrors: 3, evidence: { at: T, scans: 100, events: 2, value: 10100 },
    batteryValueEvidence: [{ id: '9', at: T, perPerson: 1000 }] };
  const observations = [
    { lot: { ...battery(8), join_requirement: 2 }, foundAt: T - 600000 },
    { lot: { ...battery(9), join_requirement: 3, total_price: 1000000 }, foundAt: T },
  ];
  S.rebuildBatteryEvidence(r, [...observations, observations[0]], T);
  assert.equal(r.batteryHits, 1); assert.equal(r.lastBatteryHit, T - 600000);
  assert.deepEqual(r.batteryValueEvidence.map(e => e.id), ['8']);
  assert.equal(r.evidence.scans, 100); assert.ok(r.evidence.events < 1); assert.ok(r.evidence.value < 100);
  assert.equal(r.hits, 8); assert.equal(r.lastAttempt, T - 50); assert.equal(r.misses, 4); assert.equal(r.scanErrors, 3);
  const once = JSON.stringify(r);
  S.rebuildBatteryEvidence(r, observations, T);
  assert.equal(JSON.stringify(r), once);
  S.rebuildBatteryEvidence(r, observations.slice(1), T);
  assert.equal(S.tierOf(r, T), 'COLD');
});

test('unknown amounts get an observation window, never a fabricated useful share', () => {
  for (const num of [undefined, 0, -1, 1.5, 'invalid']) {
    const r = {};
    S.recordScan(r, [{ ...battery(), awards: [{ gift_name: '电池红包', num }] }], T);
    assert.equal(S.hotSignal(r, T + 299999).quality, 'unknown');
    assert.equal(S.hotSignal(r, T + 299999).intervalMs, 15000);
    assert.equal(S.hotSignal(r, T + 300000).intervalMs, 60000);
    assert.equal(S.hotSignal(r, T + 300000).useful, 0);
  }
  const low = {};
  S.recordScan(low, [{ ...battery(), total_price: 9999 }], T);
  assert.equal(S.hotSignal(low, T).useful, 0);
  assert.equal(S.hotSignal(low, T + 300000).intervalMs, 60000);
});

test('only recent useful events extend HOT and stale or expired history cannot renew it', () => {
  const r = { batteryHits: 1000, lastBatteryHit: T };
  assert.equal(S.tierOf(r, T + 1800000), 'WARM');
  for (const id of [1, 2, 3, 4]) S.recordBatteryValue(r, battery(id), T, T);
  assert.equal(S.hotSignal(r, T).windowMs, 7200000);
  assert.equal(S.tierOf(r, T + 7199999), 'HOT');
  assert.equal(S.tierOf(r, T + 7200000), 'WARM');
  const before = JSON.stringify(r.batteryValueEvidence);
  S.recordBatteryValue(r, battery(5), T + 700000, T + 700000);
  S.recordBatteryValue(r, battery(6), T + 100, T);
  assert.equal(JSON.stringify(r.batteryValueEvidence), before);
  assert.equal(S.hotSignal(r, T + S.DEFAULTS.hotValueWindowMs).useful, 0);
  const migrated = { batteryHits: 99, lastBatteryHit: T, lastAttempt: T, misses: 5 };
  S.recordBatteryValue(migrated, battery(), T, T + 600000);
  S.recordBatteryValue(migrated, battery(), T, T + 1200000);
  assert.equal(migrated.batteryValueEvidence.length, 1);
  assert.equal(migrated.batteryValueEvidence[0].at, T);
  assert.equal(migrated.batteryHits, 99);
  assert.equal(migrated.lastAttempt, T);
  assert.equal(migrated.misses, 5);
});

test('QQ uses export time, preserves scans, and never creates anchor evidence', () => {
  const pool = new Map(); const r = S.ensureRoom(pool, '1234', T);
  S.recordScan(r, [], T);
  S.mergeQQ(pool, { rooms: [{ room: 1234, count: 5, total_battery: 5000, last: '2026-10-30 12:00:00' },
    { room: 5678, count: 1, last: '2026-11-06 11:00:00' }] }, T);
  assert.equal(r.qqLastAt, Date.parse('2026-10-30T12:00:00+08:00'));
  assert.equal(r.successScans, 1); assert.equal(r.anchorHits, undefined);
  assert.equal(S.tierOf(r, T), 'COLD');
  assert.equal(S.tierOf(pool.get('5678'), T), 'WARM');
});

test('battery and QQ score decays; stale rooms retain a bounded probe allocation', () => {
  const r = { lastBatteryHit: T, qqLastAt: T, qqPushes: 10,
    evidence: { at: T, scans: 50, events: 5, value: 100 } };
  assert.ok(S.roomScore(r, T + 86400000) < S.roomScore(r, T));
  const pool = new Map(Array.from({ length: 500 }, (_, i) => ['c' + i, { firstSeen: T }]));
  for (let i = 0; i < 100; i++) pool.set('s' + i, { firstSeen: T - 86400000 });
  const p = S.buildRoundPlan(pool, 1, T);
  assert.ok(p.quota.stale > 0 && p.quota.stale < p.quota.cold);
});

test('pool pruning removes stale unproven rooms and retains battery/QQ sources', () => {
  const old = T - 10 * 86400000;
  const pool = new Map([['old', { firstSeen: old }], ['seen', { firstSeen: old, lastListedAt: T }],
    ['battery', { firstSeen: old, batteryHits: 2 }], ['qq', { firstSeen: old, qqPushes: 1 }]]);
  assert.equal(S.prunePool(pool, T), 1);
  assert.deepEqual([...pool.keys()], ['seen', 'battery', 'qq']);
});

function rankedRoom(online = 100, at = T) {
  return { firstSeen: T, lastListedAt: at, listingPriority: { at, rank: 1, online } };
}

test('ranked COLD has a hard cap while ordinary exploration and WARM keep reserves under HOT pressure', () => {
  const pool = new Map();
  for (let i = 0; i < 300; i++) pool.set('h' + i, { lastBatteryHit: T });
  for (let i = 0; i < 300; i++) pool.set('w' + i, { qqLastAt: T });
  for (let i = 0; i < 1000; i++) pool.set('c' + i, { firstSeen: T });
  for (let i = 0; i < 200; i++) pool.set('p' + i, rankedRoom());
  for (const round of [1, 12]) {
    const p = S.buildRoundPlan(pool, round, T);
    assert.equal(p.plan.length + p.quota.anchorReserve + p.quota.ipReserve, 110);
    assert.equal(p.quota.priority, Math.floor(p.quota.rpQuota * .2));
    assert.equal(p.quota.priorityCap, Math.floor(p.quota.rpQuota * .2));
    assert.ok(p.quota.regularCold >= Math.ceil(p.quota.rpQuota * .3));
    assert.ok(p.quota.warm >= Math.ceil(p.quota.rpQuota * .15));
    assert.ok(p.quota.hot > 0);
    assert.equal(p.quota.cold, p.quota.priority + p.quota.regularCold);
    assert.equal(new Set(p.plan).size, p.plan.length);
    assert.ok(p.priorityPlan.every(id => id.startsWith('p')));
  }
});

test('listing evidence persists, deep pages cannot extend it, and expired or invalid evidence returns to ordinary COLD', () => {
  const pool = new Map();
  const listing = { page: 1, pageSize: 30, index: 0, parentAreaId: 1, areaId: 2 };
  const r = S.recordListing(pool, { roomid: 1234, online: '500' }, listing, T);
  assert.equal(r.listingPriority.online, 500);
  assert.equal(r.listingPriority.rank, 1);
  assert.equal(S.tierOf(r, T), 'COLD');
  S.recordListing(pool, { roomid: 1234, online: 1 }, { ...listing, page: 2 }, T + 60000);
  assert.equal(r.lastListedAt, T + 60000);
  assert.equal(r.listingPriority.at, T);
  assert.equal(r.listingPriority.online, 500);
  const restored = new Map(Object.entries(JSON.parse(JSON.stringify(Object.fromEntries(pool)))));
  for (let i = 0; i < 4; i++) restored.set('c' + i, { firstSeen: T });
  assert.equal(S.buildRoundPlan(restored, 1, T + 60000).quota.priority, 1);
  assert.equal(S.buildRoundPlan(restored, 1, T + S.DEFAULTS.priorityWindowMs).quota.priority, 0);
  assert.equal(S.buildRoundPlan(restored, 1, T + S.DEFAULTS.priorityWindowMs).quota.regularCold, 5);
  for (const [id, evidence] of [['future', {at:T+1,rank:1}], ['rank', {at:T,rank:11}]]) {
    const p = S.buildRoundPlan(new Map([[id,{firstSeen:T,listingPriority:evidence}]]),1,T);
    assert.equal(p.quota.priority,0); assert.deepEqual(p.plan,[id]);
  }
  assert.equal(S.recordListing(pool, {roomid:'bad'}, listing, T), null);
  S.recordListing(pool, {roomid:5678}, {...listing,index:10}, T);
  assert.equal(pool.get('5678').listingPriority, undefined);
});

test('priority membership is capped by online rank while peers retain ordinary exploration', () => {
  const pool = new Map(Array.from({length:700},(_,i)=>['p'+i,rankedRoom(i)]));
  const p = S.buildRoundPlan(pool,1,T);
  assert.equal(p.counts.priority,600);
  assert.ok(p.priorityPlan.every(id=>Number(id.slice(1))>=100));
  assert.ok(p.quota.regularCold>=33);
  pool.get('p699').lastBatteryHit=T;
  const promoted=S.buildRoundPlan(pool,1,T);
  assert.equal(promoted.priorityPlan.includes('p699'),false);
  assert.equal(promoted.quota.hot,1);
});

test('priority interval and retry delays release unused capacity to ordinary COLD', () => {
  const pool=new Map([['p',rankedRoom()],...Array.from({length:200},(_,i)=>['c'+i,{firstSeen:T}])]);
  S.recordScan(pool.get('p'),[],T);
  let p=S.buildRoundPlan(pool,1,T+S.DEFAULTS.priorityIntervalMs-1);
  assert.equal(p.quota.priority,0); assert.equal(p.quota.regularCold,109);
  p=S.buildRoundPlan(pool,1,T+S.DEFAULTS.priorityIntervalMs);
  assert.equal(p.quota.priority,1);
  S.recordError(pool.get('p'),T+S.DEFAULTS.priorityIntervalMs);
  assert.equal(S.buildRoundPlan(pool,1,T+S.DEFAULTS.priorityIntervalMs+1000).quota.priority,0);
});

test('bounded priority rooms retain a capped share while ordinary COLD keeps moving forward', () => {
  const pool=new Map(Array.from({length:10000},(_,i)=>['c'+i,{firstSeen:T}]));
  for(let i=0;i<600;i++)pool.set('p'+i,rankedRoom(i));
  const prioritySeen=new Set(),ordinarySeen=new Set();
  for(let round=1;round<=32;round++) {
    const time=T+round*23000;
    const p=S.buildRoundPlan(pool,round,time);
    for(const id of p.plan) {
      (id.startsWith('p')?prioritySeen:ordinarySeen).add(id);
      S.recordScan(pool.get(id),[],time);
    }
    assert.ok(p.quota.regularCold>=Math.ceil(p.quota.rpQuota*.3));
    assert.ok(p.quota.priority<=Math.floor(p.plan.length*.2));
  }
  assert.equal(prioritySeen.size,600);
  assert.ok(ordinarySeen.size>=2700);
  assert.ok([...pool].filter(([id,r])=>id.startsWith('p')&&r.successScans>=2).length>0);
});

test('the priority cap also holds for small plans and every dispatch prefix', () => {
  for (const count of [0, 1, 4, 5, 20, 87, 88, 100]) {
    const pool = new Map(Array.from({ length: 100 }, (_, i) => ['p' + i, rankedRoom(i)]));
    for (let i = 0; i < count; i++) pool.set('c' + i, { firstSeen: T });
    const p = S.buildRoundPlan(pool, 1, T);
    const priority = new Set(p.priorityPlan);
    let sentPriority = 0;
    for (let i = 0; i < p.plan.length; i++) {
      if (priority.has(p.plan[i])) sentPriority++;
      assert.ok(sentPriority <= (i + 1) * .2);
    }
    assert.ok(p.quota.priority <= Math.floor(p.plan.length * .2));
    assert.equal(p.plan.length, Math.min(109, count + Math.min(21, Math.floor(count / 4))));
  }
});
