'use strict';

const qqEvidence = require('./qq-evidence');
const redpocketPolicy = require('./redpocket-policy');
const { anchorUid } = require('./room-audience');
const { parseQQTime } = qqEvidence;

// Scheduling is independent of HTTP and disk so coverage can be checked offline.
const DEFAULTS = {
  ...qqEvidence.DEFAULTS,
  blockedRooms: [],
  perIpBudget: 110,
  anchorEveryRounds: 12,
  anchorRoomLimit: 8,
  anchorBudgetRatio: 0.08,
  explorationRatio: 0.30,
  priorityMaxRatio: 0.20,
  priorityPoolLimit: 600,
  priorityTopN: 10,
  hotRankTopN: 50,
  priorityWindowMs: 15 * 60000,
  priorityIntervalMs: 2 * 60000,
  warmReserveRatio: 0.15,
  staleProbeRatio: 0.10,
  hotIntervalMs: 15000,
  valuePolicyVersion: 2,
  batteryEligibilityVersion: redpocketPolicy.VERSION,
  hotUsefulMinPerPerson: 10,
  hotValueWindowMs: 6 * 3600000,
  hotLowValueIntervalMs: 60000,
  hotObservationMs: 5 * 60000,
  warmIntervalMs: 90000,
  staleIntervalMs: 15 * 60000,
  hotWindowMs: 30 * 60000,
  warmWindowMs: 6 * 3600000,
  evidenceHalfLifeMs: 6 * 3600000,
  qqWindowMs: 48 * 3600000,
  staleAfterMs: 6 * 3600000,
  roomRetentionMs: 7 * 86400000,
  historicalPolicyVersion: 1,
  historicalPoolLimit: 100,
  historicalMaxRatio: 0.10,
  historicalActiveIntervalMs: 5 * 60000,
  historicalProbeIntervalMs: 15 * 60000,
  historicalListingWindowMs: 86400000,
  historicalEvidenceWindowMs: 30 * 86400000,
  historicalEmptyLimit: 4,
};

const isBlockedRoom = (id, cfg = DEFAULTS) => (cfg.blockedRooms || []).includes(String(id));

function ensureRoom(pool, id, time) {
  id = String(id);
  if (!pool.has(id)) pool.set(id, { hits: 0, firstSeen: time, lastScan: 0, misses: 0,
    batteryEligibilityVersion: DEFAULTS.batteryEligibilityVersion });
  const r = pool.get(id);
  // Old lastScan values included failed responses. Start a reliable attempt clock.
  if (r.policyVersion !== 2) {
    r.policyVersion = 2;
    r.legacyLastHit = r.lastHit || 0;
    r.lastAttempt = 0;
    r.successScans = 0;
    r.scanErrors = 0;
    r.consecutiveErrors = 0;
    r.misses = 0;
  }
  return r;
}

function decayEvidence(r, time, cfg = DEFAULTS) {
  const e = r.evidence || { at: time, scans: 0, events: 0, value: 0 };
  const factor = 2 ** (-Math.max(0, time - e.at) / cfg.evidenceHalfLifeMs);
  return { at: time, scans: e.scans * factor, events: e.events * factor, value: e.value * factor };
}

function recordBatteryValue(r, lot, foundAt, time = foundAt, options = {}) {
  const cfg = { ...DEFAULTS, ...options };
  if (!lot.lot_id || !isBattery(lot) || redpocketPolicy.isExcludedBattery(lot)
    || !Number.isFinite(foundAt) || foundAt > time
    || time - foundAt >= cfg.hotValueWindowMs || (lot.end_time && lot.end_time * 1000 <= foundAt)) return;
  const award = (lot.awards || []).find(a => /电池/.test(a.gift_name || ''));
  const total = Number(lot.total_price), count = Number(award?.num);
  const perPerson = Number.isFinite(total) && total > 0 && Number.isSafeInteger(count) && count > 0
    ? total / 100 / count : null;
  const evidence = (r.batteryValueEvidence || []).filter(e => Number.isFinite(e.at) && time - e.at < cfg.hotValueWindowMs);
  const id = String(lot.lot_id), existing = evidence.find(e => e.id === id);
  if (!existing) evidence.push({ id, at: foundAt, perPerson });
  else {
    // Restarts/reobservations may fill missing amounts, but never refresh event time.
    existing.at = Math.min(existing.at, foundAt);
    if (existing.perPerson == null && perPerson != null) existing.perPerson = perPerson;
  }
  r.batteryValueEvidence = evidence;
}

function rebuildBatteryEvidence(r, observations, time, cfg = DEFAULTS) {
  // A policy upgrade reprojects affected rooms from actual historical requests.
  // Scan/error clocks, general discoveries and notification deduplication survive.
  r.batteryHits = 0;
  r.lastBatteryHit = 0;
  r.batteryValueEvidence = [];
  const evidence = decayEvidence(r, time, cfg);
  evidence.events = evidence.value = 0;
  const seen = new Set();
  for (const { lot, foundAt } of observations) {
    if (!lot?.lot_id || !isBattery(lot) || redpocketPolicy.isExcludedBattery(lot)
      || !Number.isFinite(foundAt) || foundAt > time
      || (lot.end_time && lot.end_time * 1000 <= foundAt)) continue;
    const id = String(lot.lot_id);
    if (seen.has(id)) continue;
    seen.add(id);
    r.batteryHits++;
    r.lastBatteryHit = Math.max(r.lastBatteryHit, foundAt);
    const factor = 2 ** (-(time - foundAt) / cfg.evidenceHalfLifeMs);
    evidence.events += factor;
    evidence.value += Math.max(0, Number(lot.total_price) || 0) / 100 * factor;
    recordBatteryValue(r, lot, foundAt, time, cfg);
  }
  r.evidence = evidence;
  r.batteryEligibilityVersion = cfg.batteryEligibilityVersion;
}

function hotSignal(r, time, options = {}) {
  const cfg = { ...DEFAULTS, ...options };
  const evidence = (r.batteryValueEvidence || []).filter(e => Number.isFinite(e.at)
    && e.at <= time && time - e.at < cfg.hotValueWindowMs);
  const useful = evidence.filter(e => Number.isFinite(e.perPerson) && e.perPerson >= cfg.hotUsefulMinPerPerson).length;
  const low = evidence.filter(e => Number.isFinite(e.perPerson) && e.perPerson > 0 && e.perPerson < cfg.hotUsefulMinPerPerson).length;
  const firstAt = evidence.length ? Math.min(...evidence.map(e => e.at)) : r.lastBatteryHit || time;
  const observing = !useful && low < 2 && time - firstAt < cfg.hotObservationMs;
  const slow = !useful && !observing;
  return { quality: useful ? 'useful' : low ? 'low' : 'unknown', useful, low, observing,
    intervalMs: slow ? cfg.hotLowValueIntervalMs : cfg.hotIntervalMs,
    // Only recent useful packets extend HOT; lifetime small-packet counts do not.
    windowMs: cfg.hotWindowMs * Math.min(4, Math.max(1, useful)) };
}

function tierOf(r, time, cfg = DEFAULTS) {
  if (r.lastBatteryHit) {
    const age = time - r.lastBatteryHit;
    const hotWindow = hotSignal(r, time, cfg).windowMs;
    if (age < hotWindow) return 'HOT';
    if (age < cfg.warmWindowMs) return 'WARM';
  }
  if (r.qqLastAt && time - r.qqLastAt < cfg.qqWindowMs) return 'WARM';
  // Legacy generic hits are weak evidence, never promoted to confirmed battery hits.
  if (r.legacyLastHit && time - r.legacyLastHit < cfg.warmWindowMs) return 'WARM';
  return 'COLD';
}

function roomScore(r, time, cfg = DEFAULTS) {
  const e = decayEvidence(r, time, cfg);
  const rate = Math.min(1, e.events / (e.scans + 10));
  const batteryAge = r.lastBatteryHit ? Math.max(0, time - r.lastBatteryHit) : Infinity;
  const score = 1500 * rate + 25 * Math.log1p(e.events)
    + Math.min(80, 8 * Math.log1p(e.value))
    + 60 * 2 ** (-batteryAge / cfg.evidenceHalfLifeMs)
    + qqEvidence.signal(r, time, cfg).score;
  return Math.round(score * 10) / 10;
}

function isStale(r, time, cfg = DEFAULTS) {
  return time - Math.max(r.lastListedAt || r.firstSeen || time,
    r.lastBatteryHit || 0, r.qqLastAt || 0) > cfg.staleAfterMs;
}

function historicalSignal(r, time, options = {}) {
  const cfg = { ...DEFAULTS, ...options };
  const source = r.historicalSource;
  const eligible = !!source && source.version === cfg.historicalPolicyVersion
    && Number.isFinite(source.generatedAt) && source.generatedAt <= time
    && Number.isFinite(source.lastUsefulAt) && source.lastUsefulAt <= time
    && time - source.lastUsefulAt < cfg.historicalEvidenceWindowMs;
  const recentlyListed = Number.isFinite(r.lastListedAt) && r.lastListedAt <= time
    && time - r.lastListedAt < cfg.historicalListingWindowMs;
  const backedOff = (r.historicalEmptyScans || 0) >= cfg.historicalEmptyLimit;
  const intervalMs = recentlyListed && !backedOff
    ? cfg.historicalActiveIntervalMs : cfg.historicalProbeIntervalMs;
  const elapsed = r.lastAttempt ? Math.max(0, time - r.lastAttempt) : null;
  return { eligible, intervalMs, backedOff, recentlyListed,
    due: eligible && !(r.retryAt > time) && (elapsed === null || elapsed >= intervalMs),
    delayMs: elapsed, overdueMs: elapsed === null ? null : Math.max(0, elapsed - intervalMs) };
}

function recordListing(pool, item, listing, time, options = {}) {
  const cfg = { ...DEFAULTS, ...options };
  const id = String(item.roomid || '');
  if (!/^\d+$/.test(id) || id === '0') return null;
  if (isBlockedRoom(id, cfg)) return null;
  const r = ensureRoom(pool, id, time);
  r.lastListedAt = time;
  const uid = anchorUid(item.uid);
  if (uid) r.anchorUid = uid;
  const rank = (listing.page - 1) * listing.pageSize + listing.index + 1;
  if (Number.isInteger(rank) && rank > 0 && rank <= cfg.priorityTopN) {
    const online = Number(item.online);
    r.listingPriority = { at: time, rank,
      online: Number.isFinite(online) ? Math.max(0, online) : 0,
      parentAreaId: listing.parentAreaId, areaId: listing.areaId };
  }
  return r;
}

function hotRankSignal(r, time, options = {}) {
  const cfg = { ...DEFAULTS, ...options };
  const p = r.hotRankPriority;
  const eligible = !!p && Number.isFinite(p.at) && p.at > 0 && p.at <= time
    && time - p.at < cfg.priorityWindowMs && Number.isInteger(p.rank)
    && p.rank > 0 && p.rank <= Math.min(50, cfg.hotRankTopN)
    && Number.isFinite(p.score) && p.score >= 0;
  return { eligible, at: p?.at || 0, rank: p?.rank || 0, score: p?.score || 0,
    parentAreaId: p?.parentAreaId, areaId: p?.areaId };
}

function recordHotRankSnapshot(pool, items, time, options = {}) {
  const cfg = { ...DEFAULTS, ...options };
  const limit = Math.min(50, cfg.hotRankTopN);
  if (!Number.isInteger(limit) || limit < 1 || !Number.isFinite(time) || time <= 0
    || !Array.isArray(items) || items.length > limit) throw new Error('全站热门榜快照无效');
  const rooms = new Set(), ranks = new Set();
  for (const item of items) {
    if (!item || typeof item !== 'object' || typeof item.roomid !== 'string'
      || !/^[1-9]\d*$/.test(item.roomid) || rooms.has(item.roomid)
      || !Number.isInteger(item.rank) || item.rank < 1 || item.rank > limit || ranks.has(item.rank)
      || !Number.isFinite(item.score) || item.score < 0 || ![0, 1, 2].includes(item.liveStatus)
      || [item.parentAreaId, item.areaId].some(id => id != null && (!Number.isSafeInteger(id) || id < 0))) {
      throw new Error('全站热门榜快照条目无效');
    }
    rooms.add(item.roomid); ranks.add(item.rank);
  }
  const active = items.filter(item => item.liveStatus === 1 && !isBlockedRoom(item.roomid, cfg));
  const activeIds = new Set(active.map(item => item.roomid));
  const summary = { received: items.length, live: active.length, added: 0, updated: 0, removed: 0,
    blocked: items.filter(item => isBlockedRoom(item.roomid, cfg)).length,
    offline: items.filter(item => item.liveStatus !== 1 && !isBlockedRoom(item.roomid, cfg)).length };
  // A validated complete snapshot replaces only this source; area evidence stays independent.
  for (const [id, r] of pool) {
    if (r.hotRankPriority && !activeIds.has(id) && !isBlockedRoom(id, cfg)) {
      delete r.hotRankPriority;
      summary.removed++;
    }
  }
  for (const item of active) {
    if (!pool.has(item.roomid)) summary.added++;
    else summary.updated++;
    const r = ensureRoom(pool, item.roomid, time);
    r.lastListedAt = time;
    r.hotRankPriority = { at: time, rank: item.rank, score: item.score,
      parentAreaId: item.parentAreaId, areaId: item.areaId };
  }
  return summary;
}

function priorityMembers(pool, time, cfg, tiers) {
  const hotRankIds = [], areaIds = [];
  for (const [id, r] of pool) {
    if (isBlockedRoom(id, cfg)) continue;
    const tier = cfg.restartPriority?.get(id)?.tier || tierOf(r, time, cfg);
    tiers.set(id, tier);
    if (tier !== 'COLD') continue;
    if (hotRankSignal(r, time, cfg).eligible) hotRankIds.push(id);
    else {
      const p = r.listingPriority;
      if (p && Number.isFinite(p.at) && p.at <= time && time - p.at < cfg.priorityWindowMs
        && Number.isInteger(p.rank) && p.rank > 0 && p.rank <= cfg.priorityTopN) areaIds.push(id);
    }
  }
  hotRankIds.sort((a, b) => pool.get(a).hotRankPriority.rank - pool.get(b).hotRankPriority.rank
    || a.localeCompare(b));
  areaIds.sort((a, b) => {
    const pa = pool.get(a).listingPriority, pb = pool.get(b).listingPriority;
    return pb.online - pa.online || pa.rank - pb.rank || pb.at - pa.at || a.localeCompare(b);
  });
  return [...hotRankIds, ...areaIds].slice(0, cfg.priorityPoolLimit);
}

function firstRooms(ids, limit, compare) {
  if (ids.length <= limit) return ids.sort(compare);
  const heap = [];
  function down(index) {
    while (index * 2 + 1 < heap.length) {
      let child = index * 2 + 1;
      if (child + 1 < heap.length && compare(heap[child + 1], heap[child]) > 0) child++;
      if (compare(heap[index], heap[child]) >= 0) break;
      [heap[index], heap[child]] = [heap[child], heap[index]];
      index = child;
    }
  }
  for (const id of ids) {
    if (heap.length < limit) {
      heap.push(id);
      let index = heap.length - 1;
      while (index > 0) {
        const parent = Math.floor((index - 1) / 2);
        if (compare(heap[parent], heap[index]) >= 0) break;
        [heap[parent], heap[index]] = [heap[index], heap[parent]];
        index = parent;
      }
    } else if (limit && compare(id, heap[0]) < 0) {
      heap[0] = id;
      down(0);
    }
  }
  return heap.sort(compare);
}

function buildRoundPlan(pool, round, time, options = {}) {
  const cfg = { ...DEFAULTS, ...options };
  const anchorReserve = round % cfg.anchorEveryRounds === 0
    ? Math.min(cfg.anchorRoomLimit, Math.floor(cfg.perIpBudget * cfg.anchorBudgetRatio)) : 0;
  // The exit-IP check is also a request on the selected node.
  const rpQuota = Math.max(0, cfg.perIpBudget - 1 - anchorReserve);
  const tiers = new Map();
  const members = new Set(priorityMembers(pool, time, cfg, tiers));
  const hotRooms = [];
  const buckets = { HOT: [], WARM: [], PRIORITY: [], COLD: [], STALE: [], HISTORY: [] };
  const counts = { hot: 0, warm: 0, cold: 0, stale: 0, priority: members.size, blocked: 0,
    hotFast: 0, hotSlow: 0, historical: 0, historicalDue: 0 };
  for (const [id, r] of pool) {
    if (isBlockedRoom(id, cfg)) { counts.blocked++; continue; }
    const tier = tiers.get(id);
    const retained = cfg.restartPriority?.get(id);
    if (tier === 'HOT') hotRooms.push(id);
    counts[tier.toLowerCase()]++;
    const hot = tier === 'HOT' ? hotSignal(r, time, cfg) : null;
    if (hot) counts[hot.intervalMs === cfg.hotIntervalMs ? 'hotFast' : 'hotSlow']++;
    const stale = tier === 'COLD' && isStale(r, time, cfg);
    if (stale) counts.stale++;
    const historical = historicalSignal(r, time, cfg);
    if (historical.eligible) counts.historical++;
    const segment = tier !== 'COLD' ? tier : historical.eligible ? 'HISTORY'
      : members.has(id) ? 'PRIORITY' : stale ? 'STALE' : 'COLD';
    // Finish one pass through the saved rooms before repeating current HOT/WARM.
    if (cfg.restartPriority?.size && tier !== 'COLD' && !retained) continue;
    const warmSignal = segment === 'WARM' ? qqEvidence.signal(r, time, cfg) : null;
    const interval = segment === 'HOT' ? hot.intervalMs
      : segment === 'WARM' ? warmSignal.verifyPending ? 0 : warmSignal.intervalMs : segment === 'PRIORITY' ? cfg.priorityIntervalMs
      : segment === 'HISTORY' ? historical.intervalMs : segment === 'STALE' ? cfg.staleIntervalMs : 0;
    if ((r.retryAt || 0) > time || (!retained && r.lastAttempt && time - r.lastAttempt < interval)) continue;
    buckets[segment].push(id);
    if (segment === 'HISTORY') counts.historicalDue++;
  }
  // Oldest attempt wins. Score only breaks ties, so high scores cannot starve peers.
  const scores = new Map();
  const score = id => {
    if (!scores.has(id)) scores.set(id, cfg.restartPriority?.get(id)?.score ?? roomScore(pool.get(id), time, cfg));
    return scores.get(id);
  };
  const oldestFirst = (a, b) => (pool.get(a).lastAttempt || 0) - (pool.get(b).lastAttempt || 0)
    || score(b) - score(a)
    || (pool.get(a).firstSeen || 0) - (pool.get(b).firstSeen || 0)
    || a.localeCompare(b);
  const dueCounts = Object.fromEntries(Object.entries(buckets).map(([segment, ids]) => [segment, ids.length]));
  for (const [segment, ids] of Object.entries(buckets)) {
    if (segment === 'COLD' || segment === 'STALE') buckets[segment] = firstRooms(ids, rpQuota, oldestFirst);
    else ids.sort(oldestFirst);
  }
  buckets.HISTORY.sort((a, b) => {
    const sa = historicalSignal(pool.get(a), time, cfg), sb = historicalSignal(pool.get(b), time, cfg);
    const aDue = sa.delayMs === null ? Infinity : sa.delayMs / sa.intervalMs;
    const bDue = sb.delayMs === null ? Infinity : sb.delayMs / sb.intervalMs;
    return aDue === bDue ? oldestFirst(a, b) : bDue - aDue;
  });
  // WARM sources with fresh repeated reports become due sooner; waiting peers still gain turns.
  const overdue = id => {
    const r = pool.get(id);
    const q = qqEvidence.signal(r, time, cfg);
    return r.lastAttempt ? (time - r.lastAttempt) / q.intervalMs * (q.schedulingWeight || 1) : Infinity;
  };
  buckets.WARM.sort((a, b) => {
    if (cfg.restartPriority?.has(a) && cfg.restartPriority.has(b)) return oldestFirst(a, b);
    const qa = qqEvidence.signal(pool.get(a), time, cfg), qb = qqEvidence.signal(pool.get(b), time, cfg);
    if (!!qa.verifyPending !== !!qb.verifyPending) return qa.verifyPending ? -1 : 1;
    if (qa.verifyPending && qa.verifyEndAt !== qb.verifyEndAt) return qa.verifyEndAt - qb.verifyEndAt;
    const aDue = overdue(a), bDue = overdue(b);
    return aDue === bDue ? oldestFirst(a, b) : bDue - aDue;
  });

  const exploration = Math.min(dueCounts.COLD + dueCounts.STALE,
    Math.ceil(rpQuota * cfg.explorationRatio));
  const staleReserve = Math.min(buckets.STALE.length,
    exploration ? Math.max(1, Math.floor(exploration * cfg.staleProbeRatio)) : 0);
  const priorityMaxRatio = Math.max(0, Math.min(1, Number(cfg.priorityMaxRatio) || 0));
  const priorityCap = Math.floor(rpQuota * priorityMaxRatio);
  const historicalCap = Math.floor(rpQuota * Math.max(0, Math.min(.10, Number(cfg.historicalMaxRatio) || 0)));
  const otherEligible = dueCounts.HOT + dueCounts.WARM + dueCounts.COLD + dueCounts.STALE
    + Math.min(buckets.HISTORY.length, historicalCap);
  // Small plans also respect the share cap; unused slots remain available to ordinary scans.
  const shareLimit = priorityMaxRatio === 1 ? rpQuota
    : Math.floor(otherEligible * priorityMaxRatio / (1 - priorityMaxRatio));
  const priorityLimit = Math.min(buckets.PRIORITY.length, priorityCap, shareLimit);
  const selected = { HOT: [], WARM: [], PRIORITY: [], COLD: [], STALE: [], HISTORY: [] };
  let remaining = rpQuota;
  function take(tier, n) {
    const ids = buckets[tier].splice(0, Math.max(0, Math.min(n, remaining)));
    selected[tier].push(...ids);
    remaining -= ids.length;
    return ids.length;
  }
  take('STALE', staleReserve);
  const coldTaken = take('COLD', exploration - selected.STALE.length);
  take('STALE', exploration - selected.STALE.length - coldTaken);
  take('PRIORITY', priorityLimit);
  take('WARM', Math.ceil(rpQuota * cfg.warmReserveRatio));
  take('HOT', remaining);
  take('WARM', remaining);
  // Historical probes use capacity that would otherwise fill ordinary exploration.
  // The ordinary reserve, WARM reserve, and due HOT/WARM requests have already been served.
  take('HISTORY', historicalCap);
  take('COLD', remaining);
  take('STALE', remaining);
  // Ordinary requests go first so an interrupted round cannot exceed the priority share.
  const plan = [...selected.HOT, ...selected.WARM, ...selected.HISTORY, ...selected.COLD, ...selected.STALE, ...selected.PRIORITY];
  return { plan, priorityPlan: selected.PRIORITY, historicalPlan: selected.HISTORY, hotRooms, counts, quota: {
    total: cfg.perIpBudget, ipReserve: 1, anchorReserve, rpQuota, planned: plan.length,
    hot: selected.HOT.length, warm: selected.WARM.length,
    cold: selected.PRIORITY.length + selected.COLD.length + selected.STALE.length + selected.HISTORY.length,
    priority: selected.PRIORITY.length, regularCold: selected.COLD.length + selected.STALE.length,
    stale: selected.STALE.length, explorationReserve: exploration, priorityCap, priorityLimit,
    historical: selected.HISTORY.length, historicalCap,
  } };
}

function isBattery(lot) {
  return redpocketPolicy.isBattery(lot);
}

function recordLots(r, lots, time, cfg = DEFAULTS) {
  r.seenLots = (r.seenLots || []).filter(x => x.until > time);
  const seen = new Set(r.seenLots.map(x => String(x.id)));
  const newLots = [];
  for (const lot of lots) {
    if (!lot.lot_id || redpocketPolicy.isExcludedBattery(lot)
      || (lot.end_time && lot.end_time * 1000 <= time)) continue;
    const id = String(lot.lot_id);
    if (seen.has(id)) continue;
    seen.add(id);
    r.seenLots.push({ id, until: Math.max(time, (lot.end_time || 0) * 1000) + 86400000 });
    newLots.push(lot);
    r.hits = (r.hits || 0) + 1;
    r.lastHit = Math.max(r.lastHit || 0, time);
    if (isBattery(lot)) {
      recordBatteryValue(r, lot, time, time, cfg);
      r.batteryHits = (r.batteryHits || 0) + 1;
      r.lastBatteryHit = Math.max(r.lastBatteryHit || 0, time);
      const e = decayEvidence(r, time, cfg);
      e.events++;
      e.value += (lot.total_price || 0) / 100;
      r.evidence = e;
    }
  }
  return newLots;
}

function recordScan(r, lots, time, cfg = DEFAULTS) {
  r.lastAttempt = r.lastScan = time;
  r.successScans = (r.successScans || 0) + 1;
  r.consecutiveErrors = 0;
  r.retryAt = 0;
  r.evidence = decayEvidence(r, time, cfg);
  r.evidence.scans++;
  const active = lots.filter(l => l.lot_id && !redpocketPolicy.isExcludedBattery(l)
    && (!l.end_time || l.end_time * 1000 > time));
  r.misses = active.some(isBattery) ? 0 : (r.misses || 0) + 1;
  if (r.qqLastAt && r.qqLastAt <= time) r.qqMisses = active.some(isBattery) ? 0 : (r.qqMisses || 0) + 1;
  const newLots = recordLots(r, active, time, cfg);
  if (r.historicalSource) {
    if (!active.some(isBattery)) r.historicalEmptyScans = (r.historicalEmptyScans || 0) + 1;
    if (newLots.some(lot => {
      const award = (lot.awards || []).find(a => /电池/.test(a.gift_name || ''));
      return isBattery(lot) && Number(lot.total_price) > 0 && Number.isSafeInteger(Number(award?.num))
        && Number(award.num) > 0 && Number(lot.total_price) / 100 / Number(award.num) >= cfg.hotUsefulMinPerPerson;
    })) r.historicalEmptyScans = 0;
  }
  return newLots;
}

function recordError(r, time) {
  r.lastAttempt = time;
  r.scanErrors = (r.scanErrors || 0) + 1;
  r.consecutiveErrors = (r.consecutiveErrors || 0) + 1;
  r.retryAt = time + Math.min(5 * 60000, 30000 * 2 ** Math.min(4, r.consecutiveErrors - 1));
}

function mergeQQ(pool, data, time, options = {}) {
  const cfg = { ...DEFAULTS, ...options };
  const evidence = qqEvidence.collect(data, time);
  let added = 0, updated = 0;
  for (const [id, record] of evidence.records) {
    if (isBlockedRoom(id, cfg)) continue;
    if (!pool.has(id)) added++;
    const r = ensureRoom(pool, id, time);
    qqEvidence.mergeRoom(r, record, evidence.detailed, time, cfg);
    updated++;
  }
  return { added, updated, uniqueBatteryReports: evidence.uniqueReports,
    accelerated: [...evidence.records.keys()].filter(id => !isBlockedRoom(id, cfg) && tierOf(pool.get(id), time, cfg) === 'WARM'
      && qqEvidence.signal(pool.get(id), time, cfg).intervalMs < cfg.warmIntervalMs).length };
}

function prunePool(pool, time, cfg = DEFAULTS) {
  let removed = 0;
  for (const [id, r] of pool) {
    if (cfg.restartPriority?.has(id)) continue;
    const lastEvidence = Math.max(r.lastListedAt || r.firstSeen || time,
      r.lastBatteryHit || 0, r.qqLastAt || 0);
    if (time - lastEvidence > cfg.roomRetentionMs && !r.batteryHits && !r.qqPushes
      && !historicalSignal(r, time, cfg).eligible) {
      pool.delete(id);
      removed++;
    }
  }
  return removed;
}

module.exports = { DEFAULTS, ensureRoom, tierOf, roomScore, buildRoundPlan, recordListing,
  isBattery, recordLots, recordScan, recordError, mergeQQ, parseQQTime, prunePool, hotSignal, recordBatteryValue,
  rebuildBatteryEvidence, historicalSignal, recordHotRankSnapshot, hotRankSignal,
  qqSignal: qqEvidence.signal, isBlockedRoom, isStale };
