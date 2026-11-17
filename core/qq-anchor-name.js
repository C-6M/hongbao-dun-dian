'use strict';
const CACHE_MS = 60 * 60000;
function normalizeName(value) {
  return typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 100) : '';
}
function withAnchor(payload, value) {
  const anchorName = normalizeName(value);
  if (!anchorName) return payload;
  const lines = payload.text.split('\n');
  if (lines[1]?.startsWith('主播：')) lines.splice(1, 1);
  lines.splice(1, 0, '主播：' + anchorName);
  return { ...payload, anchorName, text: lines.join('\n') };
}
function createAnchorResolver({ saved = {}, save = () => {}, fetcher = fetch, clock = Date.now } = {}) {
  const cache = saved && typeof saved === 'object' && !Array.isArray(saved) ? { ...saved } : {};
  const retry = new Map();
  return async payload => {
    if (!/^[1-9]\d*$/.test(payload.room)) throw new Error('主播房间无效');
    const entry = cache[payload.room];
    if (normalizeName(entry?.name) && Number.isFinite(entry.at) && clock() >= entry.at && clock() - entry.at < CACHE_MS)
      return withAnchor(payload, entry.name);
    if ((retry.get(payload.room) || 0) > clock()) throw new Error('主播名字暂时无法获取，稍后重试');
    try {
      const response = await fetcher('https://api.live.bilibili.com/live_user/v1/UserInfo/get_anchor_in_room?roomid=' + payload.room,
        { headers: { 'User-Agent': 'Mozilla/5.0', Referer: 'https://live.bilibili.com/' }, signal: AbortSignal.timeout(5000) });
      if (!response.ok) throw new Error('主播信息接口未成功返回');
      const result = await response.json();
      const name = normalizeName(result.data?.info?.uname);
      if (result.code !== 0 || !name) throw new Error('主播信息接口未返回名字');
      cache[payload.room] = { name, at: clock() }; save(cache); retry.delete(payload.room);
      return withAnchor(payload, name);
    } catch (error) {
      retry.set(payload.room, clock() + 60000);
      throw new Error('主播名字获取失败，暂停本条推送：' + error.message);
    }
  };
}
module.exports = { normalizeName, withAnchor, createAnchorResolver, CACHE_MS };
