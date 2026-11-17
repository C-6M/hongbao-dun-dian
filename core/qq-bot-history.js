'use strict';
const TIME = '(?:(?:(\\d{4})[-/])?(\\d{1,2})[-/](\\d{1,2})\\s*)?(\\d{1,2})[:：](\\d{2})(?:[:：](\\d{2}))?';
const DEADLINES = [new RegExp('(?:开奖时间|结束时间|截止时间|开奖|结束)\\s*[:：]?\\s*' + TIME, 'g'),
  new RegExp(TIME + '\\s*(?:开奖|结束|截止)', 'g')];
const DAY = 86400000, CHINA = 8 * 3600000;
function parseCard(text, observedAt) {
  if (typeof text !== 'string' || text.length > 100000 || !text.includes('电池')) return [];
  const rooms = [...new Set([...text.matchAll(/https?:\/\/live\.bilibili\.com\/(\d+)\b/g)].map(m => m[1]))];
  if (rooms.length !== 1) return [];
  const batteries = [...text.matchAll(/(\d+(?:\.\d+)?)\s*电池/g)]
    .filter(m => !/人均\s*$/.test(text.slice(Math.max(0, m.index - 8), m.index))).map(m => Number(m[1]));
  const people = [...text.matchAll(/(\d+)\s*(?:份|人(?:名额)?|个名额)/g)].map(m => Number(m[1]));
  const observed = new Date(observedAt + CHINA), facts = [];
  for (const regex of DEADLINES) for (const m of text.matchAll(regex)) {
    let year = m[1] ? Number(m[1]) : observed.getUTCFullYear();
    const month = m[2] ? Number(m[2]) : observed.getUTCMonth() + 1;
    const day = m[3] ? Number(m[3]) : observed.getUTCDate();
    const hour = Number(m[4]), minute = Number(m[5]), second = Number(m[6] || 0);
    if (hour > 23 || minute > 59 || second > 59 || month < 1 || month > 12 || day < 1 || day > 31) continue;
    let expiresAt = Date.UTC(year, month - 1, day, hour, minute, second) - CHINA;
    const check = new Date(expiresAt + CHINA);
    if (check.getUTCMonth() + 1 !== month || check.getUTCDate() !== day) continue;
    if (!m[2] && expiresAt < observedAt - 12 * 3600000) expiresAt += DAY;
    if (m[2] && !m[1] && expiresAt < observedAt - 180 * DAY) expiresAt = Date.UTC(++year, month - 1, day, hour, minute, second) - CHINA;
    facts.push({ room: rooms[0], expiresAt, precision: m[6] ? 1000 : 60000, batteries, people });
  }
  return facts;
}
function messageCards(event) {
  const result = []; let visited = 0;
  function walk(node, depth) {
    if (!node || depth > 8 || ++visited > 200) return;
    const parts = [node.content];
    const fields = node.ark_data?.fields;
    if (fields) parts.push(fields.title, fields.desc, fields.description, fields.jump_url);
    result.push(parts.filter(v => typeof v === 'string').join('\n'));
    if (Array.isArray(node.msg_elements)) for (const child of node.msg_elements) walk(child, depth + 1);
  }
  walk(event, 0); return result;
}
class BotHistory {
  constructor({ saved, save = () => {}, clock = Date.now, appId }) {
    const numberArray = a => Array.isArray(a) && a.every(n => Number.isFinite(n) && n > 0);
    if (saved !== undefined && (!saved || saved.version !== 1 || !Array.isArray(saved.facts)
      || typeof saved.appId !== 'string' || typeof saved.groupOpenid !== 'string'
      || !Number.isFinite(saved.coverageStartedAt) || saved.coverageStartedAt < 0
      || saved.fullMessages !== undefined && typeof saved.fullMessages !== 'boolean'
      || saved.session !== null && (!saved.session || typeof saved.session.id !== 'string' || !saved.session.id
        || !Number.isSafeInteger(saved.session.seq) || saved.session.seq < 0)
      || saved.budget && (!/^\d{4}-\d{2}-\d{2}$/.test(saved.budget.day)
        || !Number.isSafeInteger(saved.budget.count) || saved.budget.count < 0
        || !Array.isArray(saved.budget.recent) || saved.budget.recent.some(t => !Number.isFinite(t) || t < 0))
      || saved.facts.some(f => !f || !/^\d+$/.test(f.room) || !Number.isFinite(f.expiresAt)
        || typeof f.messageId !== 'string' || !f.messageId
        || ![1000, 60000].includes(f.precision) || !numberArray(f.batteries) || !numberArray(f.people))))
      throw new Error('官方机器人查重记录损坏，停止推送');
    this.state = saved?.appId === appId ? saved : { version: 1, appId, groupOpenid: '', facts: [], session: null, coverageStartedAt: 0 };
    this.save = save; this.clock = clock; this.error = false;
  }
  persist() {
    if (this.error) throw new Error('官方机器人查重保存失败，停止推送');
    this.state.facts = this.state.facts.filter(f => f.expiresAt + 3600000 > this.clock());
    try { this.save(this.state); } catch { this.error = true; throw new Error('官方机器人查重保存失败，停止推送'); }
  }
  bind(groupOpenid) {
    if (this.state.groupOpenid !== groupOpenid) {
      this.state.groupOpenid = groupOpenid; this.state.facts = []; this.state.fullMessages = false;
    }
    this.persist();
  }
  record(event) {
    if (event.group_openid !== this.state.groupOpenid || typeof event.id !== 'string') return;
    const at = Date.parse(event.timestamp);
    if (!Number.isFinite(at) || at > this.clock() + 30000) throw new Error('群消息时间无效，暂停查重');
    if (this.state.facts.some(f => f.messageId === event.id)) return;
    const facts = messageCards(event).flatMap(card => parseCard(card, at));
    this.state.facts.push(...facts.map(f => ({ ...f, messageId: event.id })));
    this.persist();
  }
  has(payload) {
    return this.state.facts.some(f => f.room === payload.room
      && Math.floor(f.expiresAt / f.precision) === Math.floor(payload.expiresAt / f.precision)
      && (!f.batteries.length || f.batteries.includes(payload.battery))
      && (!f.people.length || f.people.includes(payload.people)));
  }
  charge() {
    const now = this.clock(), day = new Date(now + CHINA).toISOString().slice(0, 10);
    const budget = this.state.budget || { day, count: 0, recent: [] };
    if (budget.day !== day) { budget.day = day; budget.count = 0; }
    budget.recent = (budget.recent || []).filter(t => t > now - 60000);
    if (budget.count >= 1000 || budget.recent.length >= 20) return false;
    budget.count++; budget.recent.push(now); this.state.budget = budget; this.persist(); return true;
  }
}
module.exports = { BotHistory, parseCard, messageCards };
