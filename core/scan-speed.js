'use strict';

// Keep the per-exit limits; reduce a slow exit's batch so it cannot monopolize the selector.
function roundBudget(node, cfg) {
  const ceiling = cfg.perIpBudget;
  if (!node || !(node.latencySamples >= 5) || !Number.isFinite(node.requestMeanMs) || node.requestMeanMs <= 0) return ceiling;
  const estimate = Math.max(node.requestMeanMs / cfg.concurrency, cfg.delayMs);
  return Math.min(ceiling, Math.max(Math.min(20, ceiling), Math.floor(cfg.nodeBatchTargetMs / estimate)));
}

function recordLatency(node, durations) {
  const valid = durations.filter(ms => Number.isFinite(ms) && ms >= 0);
  if (valid.length < 5) return;
  const mean = valid.reduce((sum, ms) => sum + ms, 0) / valid.length;
  node.requestMeanMs = Number.isFinite(node.requestMeanMs) && node.latencySamples >= 5
    ? (node.requestMeanMs + mean) / 2 : mean;
  node.latencySamples = valid.length;
}

function nextNodeWait(nodes, nodeState, ipState, cfg, time) {
  const alive = nodes.filter(name => {
    const node = nodeState.get(name);
    return node && (node.bannedUntil || 0) <= time
      && (ipState.get(node.lastIp)?.bannedUntil || 0) <= time;
  });
  if (new Set(alive.map(name => nodeState.get(name).lastIp || name)).size < cfg.minNodesAlive) return Infinity;
  return Math.min(...alive.map(name => {
    const node = nodeState.get(name);
    const lastUsed = Math.max(node.lastUsedAt || 0, ipState.get(node.lastIp)?.lastUsedAt || 0);
    return Math.max(0, lastUsed + cfg.minNodeReuseMs - time);
  }));
}

function requestSlotAt(startedAt, used, budget, exits, cfg) {
  if (!cfg.spreadNodeBudget || !(exits >= cfg.minNodesAlive) || !(budget > 0)) return startedAt;
  const span = Math.min(cfg.nodeBatchTargetMs ?? Infinity,
    Math.max(0, cfg.minNodeReuseMs / exits - (cfg.nodeTurnoverReserveMs || 0)));
  return startedAt + used * span / budget;
}

function nextRoundDelay(phase, ready, cfg, waitMs = Infinity) {
  if (ready && ['sleeping', 'error', 'cooldown'].includes(phase)) return cfg.readyNodeIntervalMs;
  if (!ready && ['sleeping', 'cooldown'].includes(phase) && Number.isFinite(waitMs)) {
    return Math.max(20, Math.min(cfg.roundIntervalMs, waitMs));
  }
  return cfg.roundIntervalMs;
}

module.exports = { roundBudget, recordLatency, nextRoundDelay, nextNodeWait, requestSlotAt };
