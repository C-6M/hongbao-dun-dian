'use strict';
const BASE = 'https://api.bot.qq.com';
const { publicConfig } = require('./qq-bot-config');
class QQBotClient {
  constructor({ config, readConfig, writeConfig, history, guard = () => true, fetcher = fetch, Socket = WebSocket, clock = Date.now }) {
    Object.assign(this, { config, readConfig, writeConfig, history, guard, fetcher, Socket, clock });
    this.stopped = true; this.connected = false; this.synced = false; this.fullMessages = false;
    this.token = ''; this.tokenUntil = 0; this.error = ''; this.queue = Promise.resolve(); this.backoff = 5000;
    this.history.bind(config.groupOpenid);
  }
  async getToken() {
    if (this.token && this.tokenUntil > this.clock() + 60000) return this.token;
    if (!this.tokenPromise) this.tokenPromise = (async () => {
      const response = await this.fetcher(BASE + '/app/getAppAccessToken', { method: 'POST',
        headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(8000),
        body: JSON.stringify({ appId: this.config.appId, clientSecret: this.config.appSecret }) });
      const data = await response.json();
      if (!response.ok || data.code && data.code !== 0 || typeof data.access_token !== 'string'
        || !data.access_token || !Number.isFinite(Number(data.expires_in))
        || !(Number(data.expires_in) > 60) || Number(data.expires_in) > 7200)
        throw new Error('官方机器人鉴权失败，请核对 AppID 和 AppSecret');
      this.token = data.access_token; this.tokenUntil = this.clock() + Number(data.expires_in) * 1000;
      return this.token;
    })().finally(() => { this.tokenPromise = null; });
    return this.tokenPromise;
  }
  async api(route, options = {}) {
    const token = await this.getToken();
    return this.fetcher(BASE + route, { ...options, signal: AbortSignal.timeout(8000),
      headers: { 'content-type': 'application/json', Authorization: 'QQBot ' + token, ...options.headers } });
  }
  start() { if (!this.stopped) return; this.stopped = false; this.connect(); }
  stop() {
    this.stopped = true; this.connected = false; this.synced = false;
    clearTimeout(this.retryTimer); clearTimeout(this.renewTimer); clearInterval(this.heartbeatTimer);
    this.retryTimer = null;
    const socket = this.socket; this.socket = null; socket?.close();
  }
  sendFrame(value) { if (this.socket?.readyState !== 1) throw new Error('官方机器人连接不可用'); this.socket.send(JSON.stringify(value)); }
  schedule() {
    if (this.stopped || this.retryTimer || this.history.error) return;
    this.retryTimer = setTimeout(() => { this.retryTimer = null; this.connect(); }, this.backoff);
    this.retryTimer.unref?.(); this.backoff = Math.min(60000, this.backoff * 2);
  }
  async connect() {
    if (this.stopped || this.connecting || this.socket || this.history.error) return;
    this.connecting = true;
    try {
      const response = await this.api('/gateway');
      const data = await response.json(); const url = new URL(data.url);
      if (!response.ok || url.protocol !== 'wss:' || !['api.bot.qq.com', 'api.sgroup.qq.com'].includes(url.hostname))
        throw new Error('官方机器人网关地址无效');
      if (this.stopped) return;
      const socket = new this.Socket(url.href); this.socket = socket;
      socket.addEventListener('message', event => {
        this.queue = this.queue.then(async () => {
          if (this.socket !== socket || this.stopped) return;
          if (typeof event.data !== 'string' || event.data.length > 1000000) throw new Error('官方机器人事件格式无效');
          await this.handle(JSON.parse(event.data));
        }).catch(() => {
          if (this.socket !== socket) return;
          this.error = '群消息处理或保存失败，暂停推送'; this.connected = false; this.synced = false;
          // A malformed/lost event invalidates coverage; never resume past that gap.
          this.history.state.session = null; this.history.state.fullMessages = false;
          try { this.history.persist(); } catch {}
          socket.close();
        });
      });
      socket.addEventListener('close', event => {
        if (this.socket !== socket) return;
        this.connected = false; this.synced = false; this.fullMessages = false; this.socket = null;
        clearInterval(this.heartbeatTimer); clearTimeout(this.renewTimer);
        if ([4006, 4007, 4009].includes(event.code)) {
          this.history.state.session = null; this.history.state.fullMessages = false;
          try { this.history.persist(); } catch { this.error = '群消息查重保存失败，停止推送'; }
        }
        this.error ||= '官方机器人连接中断，正在重连'; this.schedule();
      });
      socket.addEventListener('error', () => { if (this.socket === socket) socket.close(); });
    } catch (error) { this.error = error.message === '官方机器人鉴权失败，请核对 AppID 和 AppSecret'
      ? error.message : '官方机器人连接失败，正在重试'; this.connected = false; this.synced = false; this.schedule(); }
    finally { this.connecting = false; }
  }
  async handle(frame) {
    if (!frame || typeof frame.op !== 'number') throw new Error('机器人事件无效');
    if (frame.op === 10) {
      const interval = Number(frame.d?.heartbeat_interval);
      if (!Number.isFinite(interval) || interval < 1000 || interval > 120000) throw new Error('机器人心跳周期无效');
      clearInterval(this.heartbeatTimer); this.heartbeatPending = false;
      this.heartbeatTimer = setInterval(() => {
        try {
          if (this.heartbeatPending) { this.socket?.close(); return; }
          this.sendFrame({ op: 1, d: this.history.state.session?.seq ?? null }); this.heartbeatPending = true;
        } catch { this.socket?.close(); }
      }, interval); this.heartbeatTimer.unref?.();
      const token = await this.getToken(), session = this.history.state.session;
      if (session?.id && Number.isSafeInteger(session.seq)) this.sendFrame({ op: 6, d: { token: 'QQBot ' + token, session_id: session.id, seq: session.seq } });
      else this.sendFrame({ op: 2, d: { token: 'QQBot ' + token, intents: 1 << 25, shard: [0, 1] } });
      clearTimeout(this.renewTimer);
      this.renewTimer = setTimeout(() => this.socket?.close(), Math.max(1000, this.tokenUntil - this.clock() - 45000));
      this.renewTimer.unref?.(); return;
    }
    if (frame.op === 11) { this.heartbeatPending = false; return; }
    if (frame.op === 7) { this.socket?.close(); return; }
    if (frame.op === 9) {
      this.connected = false; this.synced = false; this.fullMessages = false;
      this.history.state.session = null; this.history.state.fullMessages = false; this.history.persist(); this.socket?.close(); return;
    }
    if (frame.op !== 0) return;
    if (!Number.isSafeInteger(frame.s) || frame.s < 0) throw new Error('机器人消息序号无效');
    if (frame.t === 'READY') {
      if (!frame.d?.session_id || !Number.isSafeInteger(frame.s)) throw new Error('机器人会话无效');
      this.history.state.session = { id: frame.d.session_id, seq: frame.s };
      this.history.state.coverageStartedAt = this.clock(); this.history.state.fullMessages = false;
      this.fullMessages = false; this.connected = true; this.synced = true; this.error = ''; this.backoff = 5000;
    } else if (frame.t === 'RESUMED') {
      if (!this.history.state.session) throw new Error('机器人恢复会话无效');
      this.connected = true; this.synced = true; this.fullMessages = !!this.history.state.fullMessages; this.error = ''; this.backoff = 5000;
    } else if (['GROUP_MESSAGE_CREATE', 'GROUP_AT_MESSAGE_CREATE'].includes(frame.t)) {
      const event = frame.d;
      if (!event || !/^[\w-]{8,128}$/.test(event.group_openid || '')) throw new Error('机器人群标识无效');
      const current = this.readConfig();
      if (current.appId !== this.config.appId || current.appSecret !== this.config.appSecret || !current.active) return;
      const command = String(event.content || '').replace(/^\s*(?:<@!?[\w-]+>\s*)*/, '').trim();
      if (!current.groupOpenid && ['owner', 'admin'].includes(event.author?.member_role)
        && command === publicConfig(current).bindingCommand) {
        this.config = this.writeConfig({ ...current, groupOpenid: event.group_openid }); this.history.bind(event.group_openid);
      }
      if (event.group_openid === this.config.groupOpenid) {
        this.history.record(event);
        if (frame.t === 'GROUP_MESSAGE_CREATE') { this.fullMessages = true; this.history.state.fullMessages = true; }
      }
    }
    if (this.history.state.session && Number.isSafeInteger(frame.s)) this.history.state.session.seq = frame.s;
    this.history.persist();
  }
  ready() { return !this.stopped && !this.history.error && this.connected && this.synced && this.fullMessages && !!this.config.groupOpenid; }
  status() {
    return { appId: this.config.appId, connected: this.connected && this.synced, fullMessages: this.fullMessages,
      bound: !!this.config.groupOpenid, ready: this.ready(), coverageStartedAt: this.history.state.coverageStartedAt,
      error: this.history.error ? '群消息查重保存失败，停止推送' : this.error || (!this.connected ? '等待官方机器人连接' : !this.config.groupOpenid ? '等待目标群绑定'
        : !this.fullMessages ? '等待群全量消息，请群主开启“接收群内全部消息”' : '') };
  }
  async send(payload) {
    if (!this.ready()) return { status: 'notSent', error: this.status().error };
    let posting = false;
    try {
      await this.getToken(); await this.queue;
      const config = this.readConfig();
      if (!config.active || config.appId !== this.config.appId || config.appSecret !== this.config.appSecret
        || config.groupOpenid !== this.config.groupOpenid || !this.ready()) return { status: 'notSent', error: '官方机器人配置或连接已改变' };
      if (!this.guard(payload)) return { status: 'notSent', error: '红包已不满足当前推送条件' };
      if (!this.covered(payload)) return { status: 'notSent', error: '红包开始早于群消息接收，等待新的红包' };
      if (this.history.has(payload)) return { status: 'duplicate' };
      if (!this.history.charge()) return { status: 'notSent', error: '达到官方单群推送额度，等待额度恢复' };
      posting = true;
      const response = await this.fetcher(BASE + '/v2/groups/' + encodeURIComponent(config.groupOpenid) + '/messages',
        { method: 'POST', headers: { 'content-type': 'application/json', Authorization: 'QQBot ' + this.token },
          body: JSON.stringify({ msg_type: 0, content: payload.text }), signal: AbortSignal.timeout(8000) });
      const result = await response.json();
      if (response.ok && typeof result.id === 'string' && result.id && (!result.code || result.code === 0))
        return { status: 'sent', transport: 'official', messageId: result.id, confirmedAt: this.clock() };
      if (response.status < 500 && (Number.isFinite(result.code) || response.status >= 400))
        return { status: 'notSent', error: '官方接口拒绝发送（' + (result.code || response.status) + '），请核对群主动推送权限及链接权限' };
      return { status: 'unknown', error: '官方接口未确认发送结果，不自动重发' };
    } catch (error) { return { status: posting ? 'unknown' : 'notSent', error: posting
      ? '官方发送结果未确认，不自动重发' : '官方推送准备失败：' + (error.message.includes('鉴权') ? '鉴权失败' : '连接或查重记录不可用') }; }
  }
  covered(payload) { return Number.isFinite(payload.startedAt) && payload.startedAt > 0
    && payload.startedAt >= this.history.state.coverageStartedAt; }
}
module.exports = { QQBotClient };
