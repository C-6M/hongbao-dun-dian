'use strict';

const qqEvidence = require('./qq-evidence');
const policy = require('./redpocket-policy');

const VERSION = 1;
const DAY_MS = 86400000;
const WINDOW_MS = 30 * DAY_MS;
const HALF_LIFE_MS = 14 * DAY_MS;
const MAX_CANDIDATES = 100;
const DEFAULT_BLOCKED_ROOMS = ['22748536'];
const MIN_PER_PERSON = 10;
const roomId = value => /^(?:[0-9]{1,12})$/.test(String(value)) && Number(value) > 0
  ? String(Number(value)) : '';
const timestamp = value => Number.isSafeInteger(value) && value > 0
  && value <= 8640000000000000 - 8 * 3600000;
const dayOf = at => new Date(at + 8 * 3600000).toISOString().slice(0, 10);
const withinWindow = (value, at) => timestamp(value) && value <= at && at - value < WINDOW_MS;
const isObject = value => value != null && typeof value === 'object' && !Array.isArray(value);
const positive = value => Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : 0;

function options({ at, blockedRooms = [], limit = MAX_CANDIDATES } = {}) {
  if (!timestamp(at)) throw new Error('历史来源时间必须是有效的毫秒时间戳');
  if (!Number.isSafeInteger(limit) || limit < 0 || limit > MAX_CANDIDATES) {
    throw new Error('历史来源上限必须是 0 至 100 的整数');
  }
  if (!Array.isArray(blockedRooms) || blockedRooms.some(value => !roomId(value))) {
    throw new Error('历史来源屏蔽名单必须是有效房间号数组');
  }
  return { at, limit, blocked: new Set([...DEFAULT_BLOCKED_ROOMS, ...blockedRooms.map(roomId)]) };
}

function ordinaryRequirement(value) {
  if (value == null) return null;
  if ((typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 2)
    || (typeof value === 'string' && /^[012]$/.test(value.trim()))) return Number(value);
  return undefined;
}

function localReports(observations, at, blocked) {
  const first = new Map();
  // The history store supplies the first successful active response for each lot.
  // Defensive deduplication also prevents repeated observations refreshing its age.
  for (const entry of observations) {
    const room = roomId(entry?.roomId), lot = entry?.lot;
    const availableAt = entry?.availableAt ?? entry?.foundAt;
    if (!room || blocked.has(room) || !isObject(lot) || !lot.lot_id
      || !timestamp(entry.foundAt) || entry.foundAt > at || !timestamp(availableAt) || availableAt > at) continue;
    const id = 'lot:' + String(lot.lot_id), key = room + ':' + id;
    const previous = first.get(key);
    if (!previous || entry.foundAt < previous.foundAt
      || (entry.foundAt === previous.foundAt && availableAt < previous.availableAt)) {
      first.set(key, { room, id, lot, foundAt: entry.foundAt, availableAt });
    }
  }
  const output = [];
  for (const entry of first.values()) {
    const { room, id, lot, foundAt, availableAt } = entry;
    if (!withinWindow(foundAt, at) || !policy.isBattery(lot) || policy.isExcludedBattery(lot)) continue;
    const award = (Array.isArray(lot.awards) ? lot.awards : []).find(value => /电池/.test(value?.gift_name || ''));
    const battery = positive(lot.total_price) / 100, awardNum = Number(award?.num);
    if (!Number.isSafeInteger(awardNum) || awardNum <= 0 || battery / awardNum < MIN_PER_PERSON) continue;
    const endAt = lot.end_time == null || Number(lot.end_time) === 0 ? 0 : Number(lot.end_time) * 1000;
    if (endAt !== 0 && (!timestamp(endAt) || endAt <= Math.max(foundAt, availableAt))) continue;
    const joinRequirement = ordinaryRequirement(lot.join_requirement ?? lot.raw?.join_requirement);
    if (joinRequirement === undefined) continue;
    output.push({ room, source: 'local', id, foundAt, availableAt, endAt,
      battery, awardNum, perPerson: battery / awardNum, day: dayOf(foundAt),
      confidence: 1, joinRequirement });
  }
  return output;
}

function qqReports(data, at, blocked) {
  const output = new Map();
  const { detailed, records } = qqEvidence.collect(data, at);
  if (!detailed) return [];
  for (const [rawRoom, record] of records) {
    const room = roomId(rawRoom);
    if (!room || blocked.has(room)) continue;
    for (const report of record.reports.values()) {
      const joinRequirement = ordinaryRequirement(report.joinRequirement ?? report.join_requirement);
      const availableAt = report.availableAt ?? report.at;
      const awardNum = Number(report.awardNum), battery = positive(report.battery);
      if (!withinWindow(report.at, at) || !timestamp(availableAt) || availableAt > at
        || report.shareConflict || report.batteryConflict || report.requirementConflict
        || ['special', 'unknown'].includes(report.requirementState) || joinRequirement === undefined
        || !Number.isSafeInteger(awardNum) || awardNum <= 0 || battery / awardNum < MIN_PER_PERSON
        || (report.endAt && (!timestamp(report.endAt) || report.endAt <= Math.max(report.at, availableAt)))) continue;
      const entry = { room, source: 'qq', id: report.id, foundAt: report.at, availableAt,
        endAt: report.endAt || 0, battery, awardNum, perPerson: battery / awardNum,
        day: dayOf(report.at), confidence: report.confidence === .5 ? .5 : 1, joinRequirement };
      // collect owns report identity (lot id, draw time, then report time), including
      // cross-group reposts; do not guess that two distinct reports are one packet.
      const key = room + ':' + report.id;
      const previous = output.get(key);
      if (!previous || entry.foundAt < previous.foundAt) output.set(key, entry);
    }
  }
  return [...output.values()];
}

function describe(room, evidence, at) {
  const local = evidence.filter(entry => entry.source === 'local');
  const qq = evidence.filter(entry => entry.source === 'qq');
  const localDays = new Set(local.map(entry => entry.day)).size;
  const qqDays = new Set(qq.map(entry => entry.day)).size;
  const source = local.length >= 3 && localDays >= 2 ? 'local'
    : qq.length >= 3 && qqDays >= 2 ? 'qq' : null;
  if (!source) return null;
  const primary = source === 'local' ? local : qq;
  return { room, source,
    score: primary.reduce((sum, entry) => sum + entry.confidence * 2 ** (-(at - entry.foundAt) / HALF_LIFE_MS), 0),
    localUseful: local.length, qqUseful: qq.length, distinctDays: source === 'local' ? localDays : qqDays,
    lastUsefulAt: primary.reduce((latest, entry) => Math.max(latest, entry.foundAt), 0), evidence };
}

function compareCandidates(a, b) {
  return (a.source === 'local' ? 0 : 1) - (b.source === 'local' ? 0 : 1)
    || b.score - a.score || b.lastUsefulAt - a.lastUsefulAt
    || Number(a.room) - Number(b.room);
}

function compareEvidence(a, b) {
  return (a.source === 'local' ? 0 : 1) - (b.source === 'local' ? 0 : 1)
    || a.foundAt - b.foundAt || a.id.localeCompare(b.id);
}

function buildCandidates({ qqData = {}, localEvidence = [], ...settings } = {}) {
  const { at, limit, blocked } = options(settings);
  if (!isObject(qqData) || !Array.isArray(localEvidence)) throw new Error('历史来源证据格式无效');
  const rooms = new Map();
  for (const { room, ...entry } of [...localReports(localEvidence, at, blocked), ...qqReports(qqData, at, blocked)]) {
    if (!rooms.has(room)) rooms.set(room, []);
    rooms.get(room).push(entry);
  }
  const candidates = [...rooms].map(([room, evidence]) => describe(room, evidence.sort(compareEvidence), at))
    .filter(Boolean).sort(compareCandidates).slice(0, limit);
  return { version: VERSION, generatedAt: at, candidates };
}

function exactKeys(value, keys) {
  return isObject(value) && Object.keys(value).length === keys.length
    && keys.every(key => Object.hasOwn(value, key));
}

function invalid(reason) { throw new Error('历史来源固定名单无效: ' + reason); }

function validateManifest(manifest, settings = {}) {
  const { at, limit } = options(settings);
  if (!exactKeys(manifest, ['version', 'generatedAt', 'candidates']) || manifest.version !== VERSION
    || !timestamp(manifest.generatedAt) || manifest.generatedAt > at || !Array.isArray(manifest.candidates)
    || manifest.candidates.length > limit) invalid('版本、生成时间或候选上限');
  const seen = new Set();
  const candidateKeys = ['room', 'source', 'score', 'localUseful', 'qqUseful', 'distinctDays', 'lastUsefulAt', 'evidence'];
  const evidenceKeys = ['source', 'id', 'foundAt', 'availableAt', 'endAt', 'battery', 'awardNum',
    'perPerson', 'day', 'confidence', 'joinRequirement'];
  for (const candidate of manifest.candidates) {
    if (!exactKeys(candidate, candidateKeys) || roomId(candidate.room) !== candidate.room
      || DEFAULT_BLOCKED_ROOMS.includes(candidate.room) || seen.has(candidate.room) || !Array.isArray(candidate.evidence)
      || !Number.isFinite(candidate.score) || candidate.score <= 0
      || !['local', 'qq'].includes(candidate.source)) invalid('房间号、重复房间或分数');
    seen.add(candidate.room);
    const evidenceIds = new Set();
    for (const entry of candidate.evidence) {
      if (!exactKeys(entry, evidenceKeys) || !['local', 'qq'].includes(entry.source)
        || typeof entry.id !== 'string' || !/^(?:lot|end|at):.+$/.test(entry.id)
        || (entry.source === 'local' && !entry.id.startsWith('lot:'))
        || evidenceIds.has(entry.source + ':' + entry.id)
        || !withinWindow(entry.foundAt, manifest.generatedAt)
        || !timestamp(entry.availableAt) || entry.availableAt > manifest.generatedAt
        || (entry.endAt !== 0 && (!timestamp(entry.endAt) || entry.endAt <= Math.max(entry.foundAt, entry.availableAt)))
        || !Number.isFinite(entry.battery) || entry.battery <= 0
        || !Number.isSafeInteger(entry.awardNum) || entry.awardNum <= 0
        || !Number.isFinite(entry.perPerson) || entry.perPerson < MIN_PER_PERSON
        || entry.perPerson !== entry.battery / entry.awardNum || entry.day !== dayOf(entry.foundAt)
        || ![.5, 1].includes(entry.confidence) || (entry.source === 'local' && entry.confidence !== 1)
        || ![null, 0, 1, 2].includes(entry.joinRequirement)) invalid('证据字段、日期、资格或重复事件');
      evidenceIds.add(entry.source + ':' + entry.id);
    }
    const expected = describe(candidate.room, candidate.evidence, manifest.generatedAt);
    if (!expected || ['source', 'localUseful', 'qqUseful', 'distinctDays', 'lastUsefulAt'].some(key => candidate[key] !== expected[key])
      || candidate.score !== expected.score) invalid('证据不足或汇总值不一致');
    for (let index = 1; index < candidate.evidence.length; index++) {
      if (compareEvidence(candidate.evidence[index - 1], candidate.evidence[index]) > 0) invalid('证据顺序');
    }
  }
  for (let index = 1; index < manifest.candidates.length; index++) {
    if (compareCandidates(manifest.candidates[index - 1], manifest.candidates[index]) > 0) invalid('候选顺序');
  }
  // Validate against the frozen generation time, not restart time. Aging can stop
  // scheduling a member, but cannot silently rebuild or replace this manifest.
  // A newly blocked member is filtered by the runtime projection, preserving the
  // saved membership for future restarts and blocklist changes.
  return manifest;
}

module.exports = { VERSION, WINDOW_MS, HALF_LIFE_MS, MAX_CANDIDATES, DEFAULT_BLOCKED_ROOMS,
  buildCandidates, validateManifest };
