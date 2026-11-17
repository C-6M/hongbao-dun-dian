'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const S = require('../core/strategy');
const { createRoundQueue } = require('../core/round-queue');
const T = Date.parse('2026-11-12T12:00:00+08:00');

function setup(extra = {}) {
  const cfg = { ...S.DEFAULTS, spreadNodeBudget: true, ...extra };
  const pool = new Map();
  for (let i = 0; i < 400; i++) pool.set(String(1000 + i), { firstSeen: T });
  pool.set('hot', { firstSeen: T, lastBatteryHit: T, lastAttempt: T,
    batteryValueEvidence: [{ at: T, perPerson: 20 }] });
  for (let i = 0; i < 40; i++) pool.set('warm' + i, { firstSeen: T, qqLastAt: T });
  for (let i = 0; i < 100; i++) pool.set('priority' + i,
    { firstSeen: T, listingPriority: { at: T, rank: 1, online: i } });
  const selection = S.buildRoundPlan(pool, 1, T, cfg);
  const priority = new Set(selection.priorityPlan), historical = new Set(selection.historicalPlan);
  const tiers = new Map(selection.plan.map(id => [id, priority.has(id) ? 'COLD_PRIORITY'
    : historical.has(id) ? 'COLD_HISTORY' : S.tierOf(pool.get(id), T, cfg)]));
  const queue = createRoundQueue(pool, selection.plan, tiers, selection.hotRooms, selection.quota, cfg);
  return { cfg, pool, selection, queue };
}

test('HOT becoming due during a round uses flexible capacity and keeps request and reserve limits', () => {
  const { pool, selection, queue } = setup();
  const tasks = [];
  for (let i = 0; ; i++) {
    const time = T + i * 500;
    const task = queue.next(time);
    if (!task) break;
    tasks.push(task);
    S.recordScan(pool.get(task.roomId), [], time);
    queue.complete(task.roomId);
  }
  assert.equal(tasks.length, 109);
  assert.ok(tasks.filter(t => t.roomId === 'hot').length >= 2);
  assert.ok(tasks.filter(t => t.tier === 'COLD').length >= Math.ceil(109 * .3));
  assert.equal(tasks.filter(t => t.tier === 'WARM').length, 40);
  assert.equal(tasks.filter(t => t.tier === 'COLD_PRIORITY').length, 21);
  assert.equal(selection.quota.hot, queue.replacements);
  let priority = 0;
  tasks.forEach((task, i) => {
    if (task.tier === 'COLD_PRIORITY') priority++;
    assert.ok(priority <= (i + 1) * .2);
  });
});

test('a queued or in-flight HOT is never issued twice and retry, blocklist and slow quality remain effective', () => {
  for (const change of [
    room => { room.retryAt = T + 90000; },
    (room, cfg) => { cfg.blockedRooms = ['hot']; },
    room => { room.batteryValueEvidence = [{ at: T, perPerson: 1 }, { at: T, perPerson: 2 }]; },
  ]) {
    const { cfg, pool, queue } = setup();
    change(pool.get('hot'), cfg);
    let task, hits = 0;
    while ((task = queue.next(T + 20000))) {
      if (task.roomId === 'hot') hits++;
      queue.complete(task.roomId);
    }
    assert.equal(hits, 0);
  }
  const { queue } = setup();
  let task;
  while ((task = queue.next(T + 20000)) && task.roomId !== 'hot') queue.complete(task.roomId);
  assert.equal(task.roomId, 'hot');
  while ((task = queue.next(T + 20000))) assert.notEqual(task.roomId, 'hot');
});

test('the startup pass does not replace exploration with repeated HOT requests', () => {
  const { selection, queue } = setup({ restartPriorityActive: true });
  const tasks = [];
  let task;
  while ((task = queue.next(T + 120000))) { tasks.push(task); queue.complete(task.roomId); }
  assert.deepEqual(tasks.map(task => task.roomId), selection.plan);
  assert.equal(queue.replacements, 0);
});

test('rooms removed by concurrent pool cleanup are skipped while surviving requests retain their order', () => {
  const { pool, selection, queue } = setup();
  const removed = selection.plan.slice(0, 5);
  for (const id of removed) pool.delete(id);
  const tasks = [];
  let task;
  while ((task = queue.next(T))) { tasks.push(task.roomId); queue.complete(task.roomId); }
  assert.deepEqual(tasks, selection.plan.filter(id => !removed.includes(id)));
});

test('disabling the trial keeps the original plan and exhausted flexible capacity keeps exploration', () => {
  const { selection, queue } = setup({ spreadNodeBudget: false });
  const rooms = [];
  let task;
  while ((task = queue.next(T + 120000))) { rooms.push(task.roomId); queue.complete(task.roomId); }
  assert.deepEqual(rooms, selection.plan);
  assert.equal(queue.replacements, 0);
  const busy = setup();
  while ((task = busy.queue.next(T + 120000))) {
    // No attempt clock update: HOT may re-enter after completion, but only within the flexible reserve.
    busy.queue.complete(task.roomId);
  }
  assert.ok(busy.selection.quota.regularCold >= busy.selection.quota.explorationReserve);
});
