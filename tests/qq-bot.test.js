'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const { QQBotClient } = require('../core/qq-bot-client');
const { BotHistory, parseCard, messageCards } = require('../core/qq-bot-history');
const configStore = require('../core/qq-bot-config');
const { Forwarder, buildForward: buildForwardImpl } = require('../core/qq-forward');
const notices = require('../core/notification-settings');
const buildForward = (record, time, rules = { ...notices.DEFAULTS, enabled: true }) => buildForwardImpl(record, time, rules);
const { createServer } = require('../core/server');
const NOW = Date.parse('2026-11-13T20:00:00+08:00');
const GROUP = 'group_target_1234';
const TEXT = '🔴 电池红包 100电池，10份\n主播：小猫\n房间 1000\n门槛：粉丝团｜观众 47｜开奖时间 20:05:00（剩余 05分00秒）\nhttps://live.bilibili.com/1000';
const payload = () => ({ id: '7001', groupId: '1127875934', room: '1000', battery: 100, people: 10,
  startedAt: NOW + 1000, expiresAt: NOW + 300000, text: TEXT });
class Socket {
  constructor() { this.readyState = 1; this.listeners = {}; this.frames = []; }
  addEventListener(type, callback) { (this.listeners[type] ||= []).push(callback); }
  emit(type, data) { for (const callback of this.listeners[type] || []) callback(data); }
  send(text) { this.frames.push(JSON.parse(text)); }
  close(code = 1000) { if (this.readyState === 3) return; this.readyState = 3; this.emit('close', { code }); }
}
const response = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
function harness(options = {}) {
  let time = NOW, config = { ...configStore.defaults(), active: true, appId: '123456', appSecret: 'unit-test-secret',
    groupOpenid: options.unbound ? '' : GROUP }, saved, posts = [], enabled = true;
  const history = new BotHistory({ saved: options.saved, appId: config.appId, clock: () => time,
    save: s => { if (options.save) options.save(s); saved = structuredClone(s); } });
  const bot = new QQBotClient({ config, history, clock: () => time, Socket,
    readConfig: () => config, writeConfig: c => { config = c; return c; }, guard: () => enabled,
    fetcher: async (url, init) => {
      if (url.endsWith('getAppAccessToken')) {
        if (options.token) return options.token();
        return response({ access_token: 'test-token', expires_in: '7200' });
      }
      if (url.endsWith('/gateway')) return response({ url: 'wss://api.bot.qq.com/websocket' });
      posts.push({ url, init }); return options.post ? options.post() : response({ id: 'message-1' });
    } });
  let seq = 0;
  return { bot, history, posts, get saved() { return saved; }, get config() { return config; },
    disable() { enabled = false; }, changeConfig() { config = { ...config, active: false }; }, advance(ms) { time += ms; },
    async event(type, event) { await bot.handle({ op: 0, t: type, s: ++seq, d: event }); },
    async ready() {
      bot.stopped = false;
      await this.event('READY', { session_id: 'session-test' });
      await this.event('GROUP_MESSAGE_CREATE', { id: 'permission-proof', group_openid: GROUP,
        timestamp: new Date(time).toISOString(), content: '普通群消息', author: { member_role: 'member' } });
    } };
}
test('official dedup recognizes other senders, broadcaster format, precise amounts and deadlines', () => {
  const h = harness();
  const legacy = harness();
  legacy.history.record({ group_openid: GROUP, id: 'old-format', timestamp: new Date(NOW).toISOString(),
    content: '电池红包 · 人均 10 电池\n主播：小猫\n100 电池 / 10 份\n20:05:00 开奖\nhttps://live.bilibili.com/1000' });
  assert.equal(legacy.history.has(payload()), true);
  h.history.record({ group_openid: GROUP, id: 'other-bot', timestamp: new Date(NOW).toISOString(), content: TEXT });
  assert.equal(h.history.has(payload()), true);
  for (const delta of [{ room: '1001' }, { expiresAt: NOW + 301000 }, { battery: 101 }, { people: 11 }])
    assert.equal(h.history.has({ ...payload(), ...delta }), false);
  const minute = parseCard(TEXT.replace('20:05:00', '20:05'), NOW)[0];
  assert.equal(minute.precision, 60000); assert.deepEqual(minute.batteries, [100]);
  assert.equal(parseCard(TEXT.replace('20:05:00 开奖', '开奖时间：20:05:00'), NOW)[0].expiresAt, payload().expiresAt);
  assert.equal(parseCard(TEXT + '\nhttps://live.bilibili.com/1001', NOW).length, 0);
  assert.equal(parseCard(TEXT.replace('20:05:00', '25:05:00'), NOW).length, 0);
});
test('dedup interprets midnight and year changes and keeps independent cards separate', () => {
  const at = Date.parse('2026-12-31T23:59:00+08:00');
  const midnight = TEXT.replace('20:05:00', '00:05:00');
  assert.equal(parseCard(midnight, at)[0].expiresAt, Date.parse('2027-01-01T00:05:00+08:00'));
  assert.equal(parseCard(midnight.replace('00:05:00', '01/01 00:05:00'), at)[0].expiresAt,
    Date.parse('2027-01-01T00:05:00+08:00'));
  const cards = messageCards({ msg_elements: [{ content: TEXT }, { content: TEXT.replace('/1000', '/1001') }] });
  assert.equal(cards.flatMap(t => parseCard(t, NOW)).length, 2);
});
test('only explicit owner/admin nonce commands bind and full messages are required', async () => {
  const h = harness({ unbound: true }); h.bot.stopped = false;
  await h.event('READY', { session_id: 'session-test' });
  const event = { id: 'binding', group_openid: GROUP, timestamp: new Date(NOW).toISOString(),
    content: '<@123456> ' + configStore.publicConfig(h.config).bindingCommand, author: { member_role: 'member' } };
  await h.event('GROUP_AT_MESSAGE_CREATE', event); assert.equal(h.config.groupOpenid, '');
  await h.event('GROUP_AT_MESSAGE_CREATE', { ...event, author: { member_role: 'owner' }, content: '绑定红包推送 wrong' });
  assert.equal(h.config.groupOpenid, '');
  await h.event('GROUP_AT_MESSAGE_CREATE', { ...event, author: { member_role: 'admin' } });
  assert.equal(h.config.groupOpenid, GROUP); assert.equal(h.bot.ready(), false); assert.equal(h.posts.length, 0);
  await h.event('GROUP_MESSAGE_CREATE', { ...event, group_openid: 'another_group_123', content: '普通消息' });
  assert.equal(h.bot.ready(), false);
  await h.event('GROUP_MESSAGE_CREATE', { ...event, content: '普通消息' }); assert.equal(h.bot.ready(), true);
  await h.event('GROUP_AT_MESSAGE_CREATE', { ...event, group_openid: 'another_group_123', author: { member_role: 'owner' } });
  assert.equal(h.config.groupOpenid, GROUP);
});
test('fresh sessions exclude older packets; resume persists replay before becoming ready', async () => {
  const h = harness(); await h.ready();
  assert.equal((await h.bot.send({ ...payload(), startedAt: NOW - 1 })).status, 'notSent');
  assert.equal((await h.bot.send({ ...payload(), startedAt: null })).status, 'notSent'); assert.equal(h.posts.length, 0);
  h.bot.connected = false; h.bot.synced = false; h.bot.fullMessages = false;
  await h.event('GROUP_MESSAGE_CREATE', { id: 'replayed', group_openid: GROUP,
    timestamp: new Date(NOW).toISOString(), content: TEXT });
  assert.equal(h.bot.ready(), false); assert.equal(h.saved.session.seq, 3);
  await h.event('RESUMED', {}); assert.equal(h.bot.ready(), true); assert.equal(h.saved.session.seq, 4);
  assert.equal((await h.bot.send(payload())).status, 'duplicate'); assert.equal(h.posts.length, 0);
  h.advance(5000); await h.event('READY', { session_id: 'fresh-session' });
  assert.equal(h.bot.ready(), false); assert.equal(h.history.state.coverageStartedAt, NOW + 5000);
});
test('WebSocket identifies/resumes, invalid sessions discard coverage and stop cancels retries', async () => {
  const h = harness(); h.bot.start();
  while (!h.bot.socket) await new Promise(r => setImmediate(r));
  const socket = h.bot.socket;
  socket.emit('message', { data: JSON.stringify({ op: 10, d: { heartbeat_interval: 30000 } }) });
  await h.bot.queue; assert.equal(socket.frames[0].op, 2); assert.equal(socket.frames[0].d.intents, 1 << 25);
  await h.ready(); socket.close(4009);
  assert.equal(h.history.state.session, null); assert.equal(h.history.state.fullMessages, false);
  assert.equal(h.bot.ready(), false); assert.ok(h.bot.retryTimer); h.bot.stop(); assert.equal(h.bot.retryTimer, null);
  assert.doesNotMatch(JSON.stringify(h.bot.status()), /unit-test-secret|test-token/);
});
test('switch/config changes during token refresh cancel before posting', async () => {
  for (const change of ['disable', 'changeConfig']) {
    let resolve; const h = harness({ token: () => new Promise(r => { resolve = r; }) }); await h.ready();
    const send = h.bot.send(payload()); h[change](); resolve(response({ access_token: 'test-token', expires_in: 7200 }));
    assert.equal((await send).status, 'notSent'); assert.equal(h.posts.length, 0);
  }
});
test('quota is durable across restarts and respects minute/day limits', () => {
  const h = harness(); for (let i = 0; i < 20; i++) assert.equal(h.history.charge(), true);
  assert.equal(h.history.charge(), false);
  const restored = harness({ saved: h.saved }); assert.equal(restored.history.charge(), false);
  restored.advance(60000); assert.equal(restored.history.charge(), true);
  restored.history.state.budget.count = 1000; assert.equal(restored.history.charge(), false);
  restored.advance(86400000); assert.equal(restored.history.charge(), true);
});
test('corrupt history and durable save failures prevent sending', async () => {
  const h = harness(); await h.ready();
  for (const delta of [{ coverageStartedAt: 'bad' }, { session: { id: 's', seq: '1' } },
    { budget: { day: '2026-11-13', count: -1, recent: [] } },
    { facts: [{ room: '1000', expiresAt: NOW, precision: 1000, batteries: ['100'], people: [], messageId: 'm' }] }])
    assert.throws(() => harness({ saved: { ...h.saved, ...delta } }), /查重记录损坏/);
  let fail = false; const broken = harness({ save: () => { if (fail) throw new Error('disk full'); } }); await broken.ready();
  fail = true; assert.equal((await broken.bot.send(payload())).status, 'notSent');
  assert.equal(broken.posts.length, 0); assert.equal(broken.bot.ready(), false);
});
test('explicit API rejection is unsent, network/5xx/ambiguous responses are never replayed', async () => {
  for (const [post, expected] of [[() => response({ code: 40054010 }, 400), 'notSent'],
    [() => response({ error: 'server' }, 503), 'unknown'], [() => response({}), 'unknown'],
    [() => { throw new Error('connection lost'); }, 'unknown'], [() => response({ id: 'ok' }), 'sent']]) {
    const h = harness({ post }); await h.ready();
    const record = { lid: '7001', room_id: '1000', battery: 100, award_num: 10, award_name: '电池红包',
      join_requirement: 2, start_time: NOW / 1000 + 1, end_time: NOW / 1000 + 300 };
    record.audience = { count: 47, observedAt: NOW, source: 'online-gold-rank' };
    h.advance(1000); const context = { settings: { enabled: true }, noticeSettings: { ...notices.DEFAULTS, enabled: false },
      blocked: [], live: { updated: NOW + 1000, phase: 'scanning', redpockets: [record] } };
    const f = new Forwarder({ readContext: () => context, clock: () => NOW + 1000,
      save: () => {}, send: p => h.bot.send(p) });
    await f.step(); assert.equal(f.state.deliveries[0].status, expected === 'unknown' ? 'uncertain' : expected === 'notSent' ? 'failed' : 'sent');
    if (expected === 'sent') {
      assert.equal(f.state.deliveries[0].messageId, 'ok'); assert.equal(f.state.deliveries[0].transport, 'official');
      assert.equal(f.state.officialSent, 1);
    }
    const restored = new Forwarder({ state: structuredClone(f.state), readContext: () => context,
      clock: () => NOW + 1000, save: () => {}, send: p => h.bot.send(p) });
    await restored.step(); assert.equal(h.posts.length, 1);
  }
});
test('bot credentials are local only and never appear in API response or validation errors', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-api-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'config.json'); let starts = 0;
  const server = createServer({ qqBotConfigFile: file, qqForwardStateFile: path.join(directory, 'state.json'),
    startQQWorker: () => { starts++; } });
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); t.after(() => server.close());
  const base = 'http://127.0.0.1:' + server.address().port;
  const put = (body, origin = base) => fetch(base + '/pool/api/qq-bot', { method: 'PUT',
    headers: { Origin: origin, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const input = { appId: '123456', appSecret: 'unit-test-secret' };
  assert.equal((await put(input, 'https://example.com')).status, 403);
  let r = await put(input); assert.equal(r.status, 200); assert.doesNotMatch(await r.text(), /unit-test-secret|appSecret/);
  assert.equal(starts, 1); r = await fetch(base + '/pool/api/qq-bot'); assert.doesNotMatch(await r.text(), /unit-test-secret|appSecret/);
  r = await put({ ...input, unexpected: input.appSecret }); assert.equal(r.status, 400); assert.doesNotMatch(await r.text(), /unit-test-secret/);
  configStore.configure({ appId: '123456', appSecret: '' }, file);
  assert.equal(configStore.read(file).appSecret, 'unit-test-secret');
  assert.throws(() => configStore.configure({ appId: '654321', appSecret: '' }, file), /AppSecret/);
  assert.equal(buildForward({ lid: '1', room_id: '1', battery: 100, award_num: 10, award_name: '电池红包',
    audience: { count: 47, observedAt: NOW, source: 'online-gold-rank' },
    join_requirement: 2, end_time: NOW / 1000 + 300 }, NOW).startedAt, null);
});
