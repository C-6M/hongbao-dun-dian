'use strict';

const strategy = require('./strategy');

// Replace only flexible ordinary exploration. The original reserves and request count survive.
function createRoundQueue(pool, plan, tiers, hotRooms, quota, cfg) {
  const candidates = new Set(hotRooms);
  const pending = new Set(plan);
  const inFlight = new Set();
  let index = 0;
  let flexible = Math.max(0, quota.regularCold - quota.explorationReserve);
  let replacements = 0;
  function dueHot(time) {
    let selected = null, oldest = Infinity;
    for (const id of candidates) {
      const room = pool.get(id);
      if (!room || strategy.isBlockedRoom(id, cfg) || strategy.tierOf(room, time, cfg) !== 'HOT') {
        candidates.delete(id);
        continue;
      }
      if (pending.has(id) || inFlight.has(id) || (room.retryAt || 0) > time) continue;
      const interval = strategy.hotSignal(room, time, cfg).intervalMs;
      const attempted = room.lastAttempt || 0;
      if (!(interval > 0) || (attempted && time - attempted < interval)) continue;
      if (selected === null || attempted < oldest || (attempted === oldest && id.localeCompare(selected) < 0)) {
        selected = id;
        oldest = attempted;
      }
    }
    return selected;
  }
  return {
    next(time) {
      while (index < plan.length) {
        let roomId = plan[index++];
        pending.delete(roomId);
        if (!pool.has(roomId)) continue;
        let tier = tiers.get(roomId);
        if (cfg.spreadNodeBudget && !cfg.restartPriorityActive && flexible > 0 && tier === 'COLD'
          && !strategy.isStale(pool.get(roomId), time, cfg)) {
          const hot = dueHot(time);
          if (hot !== null) {
            roomId = hot;
            tier = 'HOT';
            flexible--;
            replacements++;
            quota.hot++;
            quota.cold--;
            quota.regularCold--;
          }
        }
        inFlight.add(roomId);
        return { roomId, tier };
      }
      return null;
    },
    complete(roomId) { inFlight.delete(roomId); },
    addHot(roomId) { candidates.add(roomId); },
    get replacements() { return replacements; },
  };
}

module.exports = { createRoundQueue };
