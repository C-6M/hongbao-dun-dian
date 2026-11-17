'use strict';

const INTERVAL_MS = 2 * 60000;
const integer = value => {
  if (typeof value === 'string' && !/^\d+$/.test(value)) return null;
  if (!['number', 'string'].includes(typeof value)) return null;
  const n = Number(value);
  return Number.isSafeInteger(n) && n >= 0 ? n : null;
};
const anchorUid = value => { const n = integer(value); return n > 0 ? n : null; };

function selectAudienceRoom(pool, packets, time, blockedRooms = []) {
  const blocked = new Set(blockedRooms);
  const eligible = new Set(packets.filter(p => /电池/.test(p.award_name || '')
    && Number(p.end_time) * 1000 > time + 15000).map(p => String(p.room_id)));
  return [...eligible].filter(id => pool.has(id) && !blocked.has(id)
    && (!(pool.get(id).audienceAttemptAt > 0) || time - pool.get(id).audienceAttemptAt >= INTERVAL_MS))
    .sort((a, b) => (pool.get(a).audienceAttemptAt || 0) - (pool.get(b).audienceAttemptAt || 0)
      || a.localeCompare(b))[0] || null;
}

function recordAudience(room, data, time) {
  const count = integer(data?.onlineNum);
  if (count === null) return false;
  room.audience = { count, observedAt: time, source: 'online-gold-rank' };
  return true;
}

function publicAudience(room, time) {
  const audience = room?.audience;
  if (!audience || integer(audience.count) === null || !Number.isFinite(audience.observedAt)
    || audience.observedAt > time || audience.source !== 'online-gold-rank') return null;
  return { ...audience, stale: time - audience.observedAt >= INTERVAL_MS };
}

module.exports = { INTERVAL_MS, integer, anchorUid, selectAudienceRoom, recordAudience, publicAudience };
