'use strict';
const { anchorUid, recordAudience } = require('./room-audience');
const UID_CACHE_MS = 86400000;
const RETRY_MS = 10000;
function createAudienceResolver({ saved = {}, save = () => {}, allowed = () => true,
  fetcher = fetch, clock = Date.now, onState = () => {} } = {}) {
  const cache = saved && typeof saved === 'object' && !Array.isArray(saved) ? { ...saved } : {};
  const pending = new Map(), retryAt = new Map();
  let cooldownUntil = 0;
  function check(payload) {
    if (!/^[1-9]\d*$/.test(payload.room) || !allowed(payload)) {
      const error = new Error('红包已不满足当前推送条件'); error.cancelled = true; throw error;
    }
  }
  async function request(route, payload) {
    check(payload);
    const response = await fetcher('https://api.live.bilibili.com' + route, {
      headers: { 'User-Agent': 'Mozilla/5.0', Referer: 'https://live.bilibili.com/' },
      signal: AbortSignal.timeout(4000) });
    if ([412, 429].includes(response.status)) {
      const error = new Error('观众人数接口限流，稍后重试'); error.retryAfterMs = 60000;
      cooldownUntil = clock() + 60000; throw error;
    }
    const data = await response.json();
    if ([-352, -412].includes(data.code)) {
      const error = new Error('观众人数接口限流，稍后重试'); error.retryAfterMs = 60000;
      cooldownUntil = clock() + 60000; throw error;
    }
    if (!response.ok || data.code !== 0) throw new Error('观众人数接口未成功返回');
    check(payload); return data.data;
  }
  return async payload => {
    check(payload);
    if (cooldownUntil > clock()) {
      const error = new Error('观众人数接口限流，稍后重试'); error.retryAfterMs = 60000; throw error;
    }
    if ((retryAt.get(payload.room) || 0) > clock()) throw new Error('观众人数查询失败，稍后重试');
    if (!pending.has(payload.room)) {
      const promise = (async () => {
        const startedAt = clock();
        onState({ room: payload.room, stage: 'querying', startedAt, updated: startedAt });
        const entry = cache[payload.room];
        let uid = entry && Number.isFinite(entry.at) && entry.at <= clock()
          && clock() - entry.at < UID_CACHE_MS ? anchorUid(entry.uid) : null;
        if (!uid) {
          const info = await request('/room/v1/Room/get_info?room_id=' + payload.room, payload);
          uid = anchorUid(info?.uid); if (!uid) throw new Error('未取得主播 UID，无法查询观众人数');
          cache[payload.room] = { uid, at: clock() }; save(cache);
        }
        const data = await request('/xlive/general-interface/v1/rank/getOnlineGoldRank?ruid=' + uid
          + '&roomId=' + payload.room + '&page=1&pageSize=1', payload);
        const result = {};
        if (!recordAudience(result, data, clock())) throw new Error('未取得有效观众人数');
        retryAt.delete(payload.room);
        onState({ room: payload.room, stage: 'ready', count: result.audience.count,
          startedAt, updated: clock(), durationMs: clock() - startedAt });
        return result.audience;
      })().catch(error => {
        if (!error.cancelled) retryAt.set(payload.room, clock() + (error.retryAfterMs || RETRY_MS));
        onState({ room: payload.room, stage: error.cancelled ? 'cancelled' : 'failed', updated: clock(),
          error: error.cancelled ? error.message : '观众人数查询失败，稍后重试' });
        throw error;
      }).finally(() => pending.delete(payload.room));
      pending.set(payload.room, promise);
    }
    const audience = await pending.get(payload.room);
    check(payload); return { ...payload, audience };
  };
}
module.exports = { createAudienceResolver, UID_CACHE_MS, RETRY_MS };
