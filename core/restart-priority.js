'use strict';

const strategy = require('./strategy');

function snapshot(pool, at, cfg, pending = new Map()) {
  const rooms = [];
  for (const [room, record] of pool) {
    if (strategy.isBlockedRoom(room, cfg)) continue;
    const retained = pending.get(room);
    const tier = retained?.tier || strategy.tierOf(record, at, cfg);
    if (!['HOT', 'WARM'].includes(tier)) continue;
    rooms.push({ room, tier, score: retained?.score ?? strategy.roomScore(record, at, cfg) });
  }
  return { version: 1, at, rooms };
}

function restore(document, pool, time, cfg) {
  let saved = document.restartPriority;
  if (saved === undefined) {
    const at = Date.parse(document.at);
    if (!Number.isFinite(at) || at > time) return { at: null, pending: new Map() };
    // Older pools have no explicit tiers; reconstruct them at their last save time.
    saved = snapshot(pool, at, cfg);
  }
  if (!saved || saved.version !== 1 || !Number.isFinite(saved.at) || saved.at > time + 5000
    || !Array.isArray(saved.rooms)) throw new Error('重启优先级快照无效');
  const pending = new Map();
  for (const entry of saved.rooms) {
    if (!entry || typeof entry.room !== 'string' || !/^\d+$/.test(entry.room)
      || !['HOT', 'WARM'].includes(entry.tier) || !Number.isFinite(entry.score) || entry.score < 0
      || pending.has(entry.room)) throw new Error('重启优先级房间记录无效');
    if (pool.has(entry.room) && !strategy.isBlockedRoom(entry.room, cfg))
      pending.set(entry.room, { tier: entry.tier, score: entry.score });
  }
  return { at: saved.at, pending };
}

module.exports = { snapshot, restore };
