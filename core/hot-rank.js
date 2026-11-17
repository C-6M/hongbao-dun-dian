'use strict';

const ENDPOINT = '/xlive/general-interface/v1/rank/getHotRankV3';
const TOP_N = 50;
// Public broadcaster context, not the logged-in user's identity. The list is global.
const DEFAULT_CONTEXT = { ruid: '3632305195190283', roomId: '1837229404' };
const positiveId = value => /^[1-9]\d*$/.test(String(value ?? '')) ? String(value) : '';

function buildUrl(context = DEFAULT_CONTEXT) {
  const ruid = positiveId(context.ruid) || DEFAULT_CONTEXT.ruid;
  const roomId = positiveId(context.roomId) || DEFAULT_CONTEXT.roomId;
  return 'https://api.live.bilibili.com' + ENDPOINT
    + '?ruid=' + ruid + '&room_id=' + roomId + '&platform=web&sub_rank_type=1';
}

function isTarget(target) {
  try {
    const url = new URL(target, 'https://api.live.bilibili.com');
    return url.pathname === ENDPOINT && url.searchParams.get('sub_rank_type') === '1';
  } catch { return false; }
}

function parseSnapshot(data) {
  if (!data || !Array.isArray(data.list) || data.list.length > TOP_N) throw new Error('热门榜响应格式不匹配');
  const rooms = new Set(), ranks = new Set();
  const items = data.list.map(item => {
    const roomid = positiveId(item?.room_id);
    const rank = item?.rank, score = item?.score, liveStatus = item?.live_status;
    if (!roomid || !Number.isInteger(rank) || rank < 1 || rank > TOP_N
      || !Number.isFinite(score) || score < 0 || ![0, 1, 2].includes(liveStatus)
      || [item.parent_area_id, item.area_id].some(id => id != null && (!Number.isSafeInteger(id) || id < 0))
      || rooms.has(roomid) || ranks.has(rank)) throw new Error('热门榜房间或排名格式不匹配');
    rooms.add(roomid); ranks.add(rank);
    return { roomid, rank, score, liveStatus, uid: positiveId(item.uinfo?.uid),
      parentAreaId: item.parent_area_id, areaId: item.area_id };
  }).sort((a, b) => a.rank - b.rank);
  // last_top and current_room are not members of the current global TOP50.
  return { items, countdown: Number.isFinite(data.countdown) && data.countdown >= 0 ? data.countdown : null };
}

module.exports = { TOP_N, DEFAULT_CONTEXT, buildUrl, isTarget, parseSnapshot, positiveId };
