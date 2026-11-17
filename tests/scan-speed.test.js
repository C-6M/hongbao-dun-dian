'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { roundBudget, recordLatency, nextRoundDelay, nextNodeWait, requestSlotAt } = require('../core/scan-speed');
const cfg = { perIpBudget: 110, concurrency: 5, delayMs: 90, nodeBatchTargetMs: 30000,
  roundIntervalMs: 8000, readyNodeIntervalMs: 250 };

test('fast and unsampled exits retain the full budget while slow batches shrink within the same ceiling', () => {
  assert.equal(roundBudget(undefined, cfg), 110);
  assert.equal(roundBudget({ requestMeanMs: 5000, latencySamples: 4 }, cfg), 110);
  assert.equal(roundBudget({ requestMeanMs: 750, latencySamples: 100 }, cfg), 110);
  assert.equal(roundBudget({ requestMeanMs: 5000, latencySamples: 100 }, cfg), 30);
  assert.equal(roundBudget({ requestMeanMs: 10000, latencySamples: 100 }, cfg), 20);
  assert.equal(roundBudget({ requestMeanMs: 10000, latencySamples: 100 }, { ...cfg, perIpBudget: 10 }), 10);
});

test('the batch estimate includes the request launch interval and adapts when an exit recovers', () => {
  const node = {};
  recordLatency(node, [5000, 5000, 5000, 5000, 5000]);
  assert.equal(roundBudget(node, cfg), 30);
  recordLatency(node, [600, 600, 600, 600, 600]);
  assert.ok(roundBudget(node, cfg) > 30);
  assert.equal(roundBudget({ requestMeanMs: 100, latencySamples: 5 }, { ...cfg, delayMs: 1000 }), 30);
  const before = { ...node };
  recordLatency(node, [500, 600, NaN, -1]);
  assert.deepEqual(node, before);
});

test('completed or failed rounds can proceed to another eligible exit without idle waiting', () => {
  assert.equal(nextRoundDelay('sleeping', true, cfg), 250);
  assert.equal(nextRoundDelay('sleeping', false, cfg), 8000);
  for (const phase of ['error', 'cooldown']) assert.equal(nextRoundDelay(phase, true, cfg), 250);
  for (const phase of ['idle', 'paused']) assert.equal(nextRoundDelay(phase, true, cfg), 8000);
});

test('node waiting respects shared exits, reuse clocks and the minimum healthy exit count', () => {
  const cfg = { minNodeReuseMs: 180000, minNodesAlive: 3 };
  const nodes = new Map([
    ['a', { lastIp: 'one', lastUsedAt: 100000 }],
    ['b', { lastIp: 'two', lastUsedAt: 105000 }],
    ['c', { lastIp: 'three', lastUsedAt: 107000 }],
  ]);
  const ips = new Map([['one', { lastUsedAt: 104000 }]]);
  assert.equal(nextNodeWait([...nodes.keys()], nodes, ips, cfg, 280000), 4000);
  assert.equal(nextNodeWait([...nodes.keys()], nodes, ips, cfg, 284000), 0);
  nodes.get('c').lastIp = 'two';
  assert.equal(nextNodeWait([...nodes.keys()], nodes, ips, cfg, 280000), Infinity);
  nodes.get('c').lastIp = 'three';
  ips.set('three', { bannedUntil: 300000 });
  assert.equal(nextNodeWait([...nodes.keys()], nodes, ips, cfg, 280000), Infinity);
});

test('eligible node deadlines wake precisely while errors retain the retry delay', () => {
  assert.equal(nextRoundDelay('cooldown', false, cfg, 2400), 2400);
  assert.equal(nextRoundDelay('sleeping', false, cfg, 18000), 8000);
  assert.equal(nextRoundDelay('error', false, cfg, 2400), 8000);
  assert.equal(nextRoundDelay('cooldown', false, cfg, 0), 20);
});

test('request spreading fills the reuse cycle without changing the existing launch floor or batch budget', () => {
  const paced = { ...cfg, spreadNodeBudget: true, minNodeReuseMs: 180000, minNodesAlive: 3 };
  assert.equal(requestSlotAt(100000, 0, 110, 8, paced), 100000);
  assert.equal(requestSlotAt(100000, 55, 110, 8, paced), 111250);
  assert.equal(requestSlotAt(100000, 109, 110, 8, paced), 100000 + 109 * 180000 / 8 / 110);
  assert.equal(requestSlotAt(100000, 55, 110, 2, paced), 100000);
  assert.equal(requestSlotAt(100000, 55, 110, 8, { ...paced, spreadNodeBudget: false }), 100000);
});

test('spreading reserves turnover time and cannot stretch a slow batch beyond its existing target', () => {
  const paced = { ...cfg, spreadNodeBudget: true, minNodeReuseMs: 180000, minNodesAlive: 3,
    nodeTurnoverReserveMs: 1800 };
  assert.equal(requestSlotAt(100000, 55, 110, 8, paced), 110350);
  assert.equal(requestSlotAt(100000, 10, 20, 3, paced), 115000);
});
