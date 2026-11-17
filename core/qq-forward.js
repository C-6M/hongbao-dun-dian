'use strict';
const { buildNotification } = require('./notifications');
const { GROUP_ID, GROUP_NAME } = require('./qq-forward-settings');
const { DEFAULTS } = require('./notification-settings');
const { publicAudience } = require('./room-audience');

const RETAIN_MS = 7 * 86400000;
const RETRY_MS = 60000;
const SEND_GAP_MS = 5000;

function buildCandidate(record, time = Date.now(), rules = DEFAULTS) {
  // The caller supplies QQ's thresholds; its delivery switch is checked separately.
  const notice = buildNotification(record, time, typeof rules === 'number' ? rules : { ...rules, enabled: true });
  if (!notice) return null;
  const requirement = record.join_requirement ?? record.raw?.join_requirement;
  const gate = requirement == null ? '未知' : ['无门槛', '关注', '粉丝团'][Number(requirement)];
  const start = Number(record.start_time) * 1000;
  return { id: notice.id, room: notice.room, expiresAt: notice.expiresAt,
    startedAt: Number.isFinite(start) && start > 0 && start <= time ? start : null,
    battery: Number(record.battery), people: Number(record.award_num), gate,
    groupId: GROUP_ID, groupName: GROUP_NAME };
}
function buildForward(record, time = Date.now(), rules = DEFAULTS) {
  const candidate = buildCandidate(record, time, rules);
  if (!candidate) return null;
  const audience = publicAudience(record, time);
  if (!audience || audience.stale) return null;
  const format = n => Number(Number(n).toFixed(2)).toString();
  const remaining = Math.ceil((candidate.expiresAt - time) / 1000);
  const deadline = new Date(candidate.expiresAt).toLocaleTimeString('zh-CN', {
    timeZone: 'Asia/Shanghai', hour12: false,
  });
  return { ...candidate, audience: { count: Number(audience.count), observedAt: audience.observedAt, source: audience.source },
    audienceCount: Number(audience.count),
    text: '🔴 电池红包 ' + format(record.battery) + '电池，' + record.award_num + '份\n'
      + '房间 ' + candidate.room + '\n'
      + '门槛：' + candidate.gate + '｜观众 ' + audience.count + '｜开奖时间 ' + deadline
      + '（剩余 ' + String(Math.floor(remaining / 60)).padStart(2, '0') + '分'
      + String(remaining % 60).padStart(2, '0') + '秒）\nhttps://live.bilibili.com/' + candidate.room };
}

function sameCandidate(a, b) {
  return !!a && !!b && ['id', 'room', 'groupId', 'expiresAt', 'startedAt', 'battery', 'people', 'gate']
    .every(key => a[key] === b[key]);
}
function candidateRules(context) {
  return { ...context.noticeSettings,
    minPerPerson: context.settings?.minPerPerson ?? context.noticeSettings.minPerPerson };
}
function refreshForward(payload, context, time = Date.now()) {
  if (!context || context.blocked.includes(payload.room)) return null;
  const record = (context.live.redpockets || []).find(r => String(r.lid) === payload.id && String(r.room_id) === payload.room);
  const rules = candidateRules(context);
  if (!sameCandidate(payload, buildCandidate(record, time, rules))) return null;
  return buildForward({ ...record, audience: payload.audience }, time, rules);
}

function initialState(saved) {
  if (saved !== undefined && (!saved || saved.version !== 1 || !Array.isArray(saved.deliveries))) {
    throw new Error('QQ 转发去重记录损坏，停止转发以避免重复消息');
  }
  const state = saved || { version: 1, sent: 0, failed: 0, deliveries: [], lastError: '' };
  if (state.deliveries.some(d => !d || typeof d.key !== 'string' || !Number.isFinite(d.until)
    || !['reserved', 'sent', 'duplicate', 'failed', 'uncertain'].includes(d.status))) {
    throw new Error('QQ 转发去重记录格式无效');
  }
  // A crash between sending and saving is ambiguous; never resend automatically.
  for (const delivery of state.deliveries) {
    if (delivery.status === 'reserved') delivery.status = 'uncertain';
  }
  state.sent = Number.isSafeInteger(state.sent) ? state.sent : 0;
  state.failed = Number.isSafeInteger(state.failed) ? state.failed : 0;
  state.skipped = Number.isSafeInteger(state.skipped) ? state.skipped : 0;
  return state;
}

class Forwarder {
  constructor({ state, readContext, save, send, clock = Date.now, candidateBuilder = buildForward }) {
    this.state = initialState(state);
    this.readContext = readContext; this.save = save; this.send = send; this.clock = clock;
    this.candidateBuilder = candidateBuilder;
    this.running = false;
  }
  context() {
    const context = this.readContext();
    const live = context.live;
    if (!context.settings.enabled || !context.noticeSettings || context.scanSettings?.enabled === false
      || !live || !Number.isFinite(live.updated)
      || this.clock() - live.updated > 30000 || live.updated > this.clock() + 5000
      || ['stopped', 'paused', 'pausing', 'storage_error'].includes(live.phase)
      || live.storage?.error || live.scan?.settingsError || live.blocklist?.error
      || live.scan?.enabled === false) return null;
    return context;
  }
  candidates(context) {
    return (context.live.redpockets || [])
      .filter(r => !context.blocked.includes(String(r.room_id)))
      .map(r => this.candidateBuilder(r, this.clock(), candidateRules(context))).filter(Boolean)
      .sort((a, b) => a.expiresAt - b.expiresAt);
  }
  key(payload) { return payload.groupId + ':' + payload.id; }
  async step() {
    if (this.running) return false;
    this.running = true;
    let reservation, attempted = false;
    try {
      const time = this.clock();
      this.state.updated = time;
      this.state.deliveries = this.state.deliveries.filter(d => d.until > time);
      const context = this.context();
      this.state.enabled = !!context;
      this.state.waiting = 0;
      if (!context || time < (this.state.nextSendAt || 0)) { this.save(this.state); return false; }
      const candidates = this.candidates(context).filter(p => {
        const entry = this.state.deliveries.find(d => d.key === this.key(p));
        return !entry || entry.status === 'failed' && (entry.retryAt || 0) <= time;
      });
      this.state.waiting = candidates.length;
      const payload = candidates[0];
      if (!payload) { this.save(this.state); return false; }
      reservation = { key: this.key(payload), id: payload.id, room: payload.room,
        until: Math.max(time, payload.expiresAt) + RETAIN_MS, status: 'reserved', at: time };
      this.state.deliveries = this.state.deliveries.filter(d => d.key !== reservation.key);
      this.state.deliveries.push(reservation);
      this.save(this.state);
      // Re-read switches, blocklist and latest record after the durable reservation.
      const freshContext = this.context();
      const fresh = freshContext && this.candidates(freshContext).find(p => this.key(p) === reservation.key);
      if (!fresh) {
        this.state.deliveries = this.state.deliveries.filter(d => d !== reservation);
        this.save(this.state); return false;
      }
      attempted = true;
      const result = await this.send(fresh);
      this.state.nextSendAt = this.clock() + SEND_GAP_MS;
      if (result.status === 'sent') {
        reservation.status = 'sent'; reservation.sentAt = this.clock();
        if (Number.isSafeInteger(result.audience?.count) && result.audience.count >= 0
          && Number.isFinite(result.audience.observedAt)) {
          reservation.audienceCount = result.audience.count; reservation.audienceAt = result.audience.observedAt;
        }
        if (result.transport === 'official' && typeof result.messageId === 'string') {
          reservation.transport = 'official'; reservation.messageId = result.messageId;
          this.state.officialSent = (this.state.officialSent || 0) + 1;
        }
        this.state.sent++; this.state.lastSentAt = this.clock(); this.state.lastError = '';
      } else if (result.status === 'duplicate') {
        reservation.status = 'duplicate'; reservation.skippedAt = this.clock();
        this.state.skipped++; this.state.lastError = '';
      } else {
        reservation.status = result.status === 'notSent' ? 'failed' : 'uncertain';
        const retry = result.status === 'notSent' && Number.isSafeInteger(result.retryAfterMs)
          && result.retryAfterMs >= 10000 && result.retryAfterMs <= RETRY_MS ? result.retryAfterMs : RETRY_MS;
        reservation.retryAt = this.clock() + retry;
        this.state.failed++; this.state.lastError = result.error || 'QQ 未确认发送结果';
        reservation.error = this.state.lastError;
      }
      return true;
    } catch (e) {
      this.state.enabled = false;
      if (reservation) {
        reservation.status = attempted ? 'uncertain' : 'failed';
        reservation.retryAt = this.clock() + RETRY_MS;
      }
      this.state.lastError = e.message; this.state.failed++;
      return false;
    } finally {
      this.state.updated = this.clock();
      this.state.uncertain = this.state.deliveries.filter(d => d.status === 'uncertain').length;
      this.running = false;
      this.save(this.state);
    }
  }
}
module.exports = { buildCandidate, buildForward, sameCandidate, refreshForward, initialState, Forwarder, RETRY_MS, SEND_GAP_MS };
