'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const { buildForward: buildForwardImpl, initialState, Forwarder, RETRY_MS, SEND_GAP_MS } = require('../core/qq-forward');
const settings = require('../core/qq-forward-settings');
const { createServer } = require('../core/server');
const noticeSettings = require('../core/notification-settings');
const { buildNotification } = require('../core/notifications');
const buildForward = (record, time, rules = { ...noticeSettings.DEFAULTS, enabled: true }) => buildForwardImpl(record, time, rules);
const { atomicSave } = require('../core/qq-forward-worker');
const { createAnchorResolver, CACHE_MS } = require('../core/qq-anchor-name');

const TIME = Date.parse('2026-11-07T19:00:00+08:00');
test('dashboard startup leaves a supervised cloud worker to its service manager', () => {
  const previous = process.env.QQ_FORWARD_MANAGED;
  try {
    process.env.QQ_FORWARD_MANAGED = '1';
    assert.doesNotThrow(() => require('../core/qq-forward-worker').startWorker());
  } finally {
    if (previous === undefined) delete process.env.QQ_FORWARD_MANAGED;
    else process.env.QQ_FORWARD_MANAGED = previous;
  }
});
const packet = (overrides = {}) => ({ lid: '7001', room_id: '1000', battery: 100,
  award_num: 10, award_name: '电池红包', end_time: TIME / 1000 + 600,
  audience: { count: 47, observedAt: TIME, source: 'online-gold-rank' },
  join_requirement: 2, ...overrides });
test('messages use the actual broadcaster name and reuse a persisted room cache', async () => {
  let calls = 0, saved;
  const resolve = createAnchorResolver({ clock: () => TIME, save: cache => { saved = structuredClone(cache); },
    fetcher: async url => { calls++; assert.ok(url.endsWith('roomid=1000'));
      return { ok: true, json: async () => ({ code: 0, data: { info: { uname: ' 呆呆猫猫er\n' } } }) }; } });
  const p = buildForward(packet({ sender: '红包发起人' }), TIME);
  const named = await resolve(p); assert.match(named.text, /\n主播：呆呆猫猫er\n/);
  assert.doesNotMatch(named.text, /红包发起人|编号/); assert.equal(named.id, p.id);
  await resolve(p); assert.equal(calls, 1);
  const restored = createAnchorResolver({ saved, clock: () => TIME + CACHE_MS - 1,
    fetcher: async () => { throw new Error('cache should survive restart'); } });
  assert.equal((await restored(p)).anchorName, '呆呆猫猫er');
});
test('expired or malformed broadcaster names are refreshed, with failed lookups backed off', async () => {
  let calls = 0, time = TIME;
  const resolve = createAnchorResolver({ saved: { '1000': { name: '旧名字', at: TIME - CACHE_MS } },
    clock: () => time, fetcher: async () => { calls++; return { ok: true,
      json: async () => ({ code: -352, data: { info: { uname: '无效名字' } } }) }; } });
  const p = buildForward(packet(), TIME);
  await assert.rejects(resolve(p), /主播名字获取失败/);
  await assert.rejects(resolve(p), /稍后重试/); assert.equal(calls, 1);
  time += 60000; await assert.rejects(resolve(p), /主播名字获取失败/); assert.equal(calls, 2);
});
test('transient Windows destination locks retry the durable save; permanent failures preserve the prior file', () => {
  const files = new Map([['state.json', 'prior']]); let failures = 2, pauses = 0;
  const io = {
    writeFileSync: (file, value) => files.set(file, value),
    renameSync: (from, to) => {
      if (failures-- > 0) throw Object.assign(new Error('locked'), { code: 'EPERM' });
      files.set(to, files.get(from)); files.delete(from);
    },
    unlinkSync: file => files.delete(file),
  };
  atomicSave({ sent: 1 }, 'state.json', io, () => { pauses++; });
  assert.equal(JSON.parse(files.get('state.json')).sent, 1); assert.equal(pauses, 2);
  failures = 20; pauses = 0;
  assert.throws(() => atomicSave({ sent: 2 }, 'state.json', io, () => { pauses++; }), /locked/);
  assert.equal(JSON.parse(files.get('state.json')).sent, 1); assert.equal(pauses, 10);
  assert.equal(files.size, 1);
});
function harness(options = {}) {
  let time = TIME, snapshots = [], calls = [];
  const context = { settings: { enabled: true }, noticeSettings: { ...noticeSettings.DEFAULTS, enabled: true },
    scanSettings: { enabled: true }, blocked: [], live: {
    updated: time, phase: 'scanning', scan: { enabled: true }, redpockets: [packet()],
  } };
  const f = new Forwarder({ state: options.state, clock: () => time, readContext: () => context,
    save: state => {
      snapshots.push(JSON.parse(JSON.stringify(state)));
      if (options.save) options.save(state, context);
    }, send: async payload => { calls.push(payload); return options.send ? options.send(payload) : { status: 'sent' }; } });
  return { f, context, calls, snapshots, advance(ms) { time += ms; context.live.updated = time; } };
}
test('forward messages use human average >= 10 and preserve ordinary qualification only', () => {
  const p = buildForward(packet(), TIME);
  assert.equal(p.groupId, '1127875934'); assert.equal(p.text.split('\n')[0], '🔴 电池红包 100电池，10份');
  assert.doesNotMatch(p.text, /人均/);
  assert.match(p.text, /房间 1000\n门槛：粉丝团｜观众 47｜开奖时间 19:10:00（剩余 10分00秒）/);
  assert.ok(p.text.endsWith('https://live.bilibili.com/1000'));
  assert.doesNotMatch(p.text, /编号|7001/); assert.equal(p.id, '7001');
  for (const gate of [0, 1, 2, '2']) assert.ok(buildForward(packet({ join_requirement: gate }), TIME));
  for (const invalid of [{ battery: 99.99 }, { join_requirement: 3 }, { join_requirement: 4 },
    { join_requirement: 2, raw: { join_requirement: 3 } }, { expired: true },
    { end_time: TIME / 1000 }, { award_num: 0 }, { room_id: '../1000' }, { lid: 'bad' },
    { award_name: '其他奖励' }]) assert.equal(buildForward(packet(invalid), TIME), null);
});
test('QQ forwarding waits for an actual fresh audience count and cancels if it disappears', async () => {
  for (const audience of [null, {}, { count: null, observedAt: TIME, source: 'online-gold-rank' },
    { count: -1, observedAt: TIME, source: 'online-gold-rank' },
    { count: 47, observedAt: TIME - 120000, source: 'online-gold-rank' },
    { count: 47, observedAt: TIME + 1, source: 'online-gold-rank' }]) {
    const h = harness(); h.context.live.redpockets = [packet({ audience })];
    await h.f.step(); assert.equal(h.calls.length, 0); assert.equal(h.f.state.deliveries.length, 0);
  }
  assert.match(buildForward(packet({ audience: { count: 0, observedAt: TIME, source: 'online-gold-rank' } }), TIME).text, /观众 0｜/);
  const h = harness(); h.context.live.redpockets[0].audience = null;
  await h.f.step(); assert.equal(h.calls.length, 0);
  h.context.live.redpockets[0].audience = { count: 47, observedAt: TIME, source: 'online-gold-rank' };
  await h.f.step(); assert.equal(h.calls.length, 1);
  const cancelled = harness({ save: (state, context) => { if (state.deliveries.length) context.live.redpockets[0].audience = null; } });
  await cancelled.f.step(); assert.equal(cancelled.calls.length, 0); assert.equal(cancelled.f.state.deliveries.length, 0);
});
test('desktop notifications and QQ forwarding obey their own switches in all combinations', async () => {
  for (const desktopEnabled of [false, true]) for (const qqEnabled of [false, true]) {
    const h = harness();
    h.context.noticeSettings.enabled = desktopEnabled;
    h.context.settings.enabled = qqEnabled;
    await h.f.step();
    assert.equal(h.calls.length, qqEnabled ? 1 : 0);
    assert.equal(!!buildNotification(packet(), TIME, h.context.noticeSettings), desktopEnabled);
    assert.equal(h.context.noticeSettings.enabled, desktopEnabled);
  }
});
test('closing desktop notifications during preparation does not cancel QQ forwarding', async () => {
  const h = harness({ save: (state, context) => {
    if (state.deliveries.some(d => d.status === 'reserved')) context.noticeSettings.enabled = false;
  } });
  await h.f.step(); assert.equal(h.calls.length, 1); assert.equal(h.f.state.sent, 1);
  assert.equal(buildNotification(packet(), TIME, h.context.noticeSettings), null);
});
test('forwarding follows shared amount and expiry conditions with desktop notifications off', async () => {
  const h = harness();
  h.context.noticeSettings.enabled = false;
  h.context.noticeSettings.minBattery = 100;
  h.context.live.redpockets.push(packet({ lid: '7002', join_requirement: 3 }), packet({ lid: '7003', battery: 1 }));
  await h.f.step(); assert.equal(h.calls.length, 1); assert.equal(h.f.state.sent, 1);
  for (const rules of [{ minPerPerson: 10.01 }, { minBattery: 101 }, { minRemainingSeconds: 601 }]) {
    const rejected = harness(); Object.assign(rejected.context.noticeSettings, { enabled: false }, rules);
    await rejected.f.step(); assert.equal(rejected.calls.length, 0);
  }
  const small = harness(); Object.assign(small.context.noticeSettings, { enabled: false, minBattery: 100 });
  small.context.live.redpockets = [packet({ battery: 50, award_num: 5 })];
  await small.f.step(); assert.equal(small.calls.length, 0);
});
test('QQ minimum 2 accepts 100/50 without lowering desktop thresholds or bypassing other guards', async () => {
  for (const change of [{}, { award_num: 51 }, { battery: 50, award_num: 25 },
    { end_time: TIME / 1000 + 119 }, { join_requirement: 3 }, { audience: null }]) {
    const h = harness();
    h.context.settings.minPerPerson = 2;
    Object.assign(h.context.noticeSettings, { enabled: false, minBattery: 100, minRemainingSeconds: 120 });
    h.context.live.redpockets = [packet({ award_num: 50, ...change })];
    await h.f.step(); assert.equal(h.calls.length, Object.keys(change).length ? 0 : 1);
    assert.equal(h.context.noticeSettings.minPerPerson, 10);
    assert.equal(buildNotification(packet({ award_num: 50 }), TIME,
      { ...h.context.noticeSettings, enabled: true }), null);
    if (h.calls.length) assert.match(h.calls[0].text, /100电池，50份/);
  }
  const inherited = harness(); inherited.context.settings.minPerPerson = null;
  inherited.context.live.redpockets = [packet({ award_num: 50 })];
  await inherited.f.step(); assert.equal(inherited.calls.length, 0);
});
test('QQ threshold changes cancel a reserved 100/50 packet, while desktop threshold changes do not', async () => {
  for (const changeQQ of [false, true]) {
    const h = harness({ save: (state, context) => {
      if (state.deliveries.some(d => d.status === 'reserved')) {
        if (changeQQ) context.settings.minPerPerson = 2.01;
        else context.noticeSettings.minPerPerson = 20;
      }
    } });
    h.context.settings.minPerPerson = 2;
    h.context.live.redpockets = [packet({ award_num: 50 })];
    await h.f.step(); assert.equal(h.calls.length, changeQQ ? 0 : 1);
  }
});
test('same packet is reserved durably before send and deduplication survives a fresh worker', async () => {
  const h = harness({ send: () => {
    assert.equal(h.snapshots.at(-1).deliveries[0].status, 'reserved'); return { status: 'sent' };
  } });
  await h.f.step(); h.advance(SEND_GAP_MS); await h.f.step(); assert.equal(h.calls.length, 1);
  const restored = harness({ state: h.snapshots.at(-1) }); await restored.f.step();
  assert.equal(restored.calls.length, 0); assert.equal(restored.f.state.sent, 1);
});
test('the two minute minimum is inclusive and is checked again before transport', async () => {
  const rules = { ...noticeSettings.DEFAULTS, enabled: true, minRemainingSeconds: 120 };
  assert.equal(buildForward(packet({ end_time: TIME / 1000 + 119 }), TIME, rules), null);
  assert.ok(buildForward(packet({ end_time: TIME / 1000 + 120 }), TIME, rules));
  let advanced = false;
  const h = harness({ save: state => {
    if (!advanced && state.deliveries.some(d => d.status === 'reserved')) { advanced = true; h.advance(1001); }
  } });
  h.context.noticeSettings.minRemainingSeconds = 120;
  h.context.live.redpockets = [packet({ end_time: TIME / 1000 + 120 })];
  await h.f.step(); assert.equal(h.calls.length, 0); assert.equal(h.f.state.deliveries.length, 0);
});
test('a worker crash during sending and an ambiguous result never cause automatic duplicates', async () => {
  const h = harness({ send: () => ({ status: 'unknown', error: '未确认' }) });
  await h.f.step(); h.advance(RETRY_MS); await h.f.step();
  assert.equal(h.calls.length, 1); assert.equal(h.f.state.uncertain, 1);
  const reserved = structuredClone(h.snapshots[0]);
  assert.equal(reserved.deliveries[0].status, 'reserved');
  const restarted = harness({ state: reserved }); await restarted.f.step();
  assert.equal(restarted.calls.length, 0); assert.equal(restarted.f.state.uncertain, 1);
});
test('a packet found in the group is skipped durably and never retried after a restart', async () => {
  const h = harness({ send: () => ({ status: 'duplicate' }) });
  await h.f.step();
  assert.equal(h.f.state.skipped, 1); assert.equal(h.f.state.sent, 0); assert.equal(h.f.state.failed, 0);
  assert.equal(h.f.state.deliveries[0].status, 'duplicate'); assert.equal(h.f.state.lastError, '');
  h.advance(RETRY_MS); await h.f.step(); assert.equal(h.calls.length, 1);
  const restarted = harness({ state: h.snapshots.at(-1) });
  restarted.context.live.redpockets.push(packet({ lid: '7002' }));
  restarted.advance(RETRY_MS); await restarted.f.step();
  assert.deepEqual(restarted.calls.map(p => p.id), ['7002']);
  assert.equal(restarted.f.state.skipped, 1); assert.equal(restarted.f.state.sent, 1);
});
test('definitely unsent failures retry after backoff and sending is serialized', async () => {
  let complete;
  const h = harness({ send: () => new Promise(resolve => { complete = resolve; }) });
  const first = h.f.step(); assert.equal(await h.f.step(), false);
  assert.equal(h.calls.length, 1); complete({ status: 'notSent', error: 'QQ 没有登录' }); await first;
  assert.equal(h.f.state.failed, 1); assert.equal(h.f.state.deliveries[0].status, 'failed');
  h.advance(RETRY_MS - 1); await h.f.step(); assert.equal(h.calls.length, 1);
  h.advance(1); h.f.send = async p => { h.calls.push(p); return { status: 'sent' }; };
  await h.f.step(); assert.equal(h.calls.length, 2); assert.equal(h.f.state.sent, 1);
  assert.equal(h.f.state.lastError, '');
});
test('switching off, blocking, expiration or eligibility changes cancel before sender invocation', async () => {
  for (const change of [
    c => { c.settings.enabled = false; }, c => { c.blocked.push('1000'); },
    c => { c.noticeSettings.minBattery = 101; },
    c => { c.scanSettings.enabled = false; },
    c => { c.live.redpockets[0].expired = true; }, c => { c.live.redpockets[0].join_requirement = 3; },
  ]) {
    let changed = false;
    const h = harness({ save: (state, context) => {
      if (!changed && state.deliveries.length) { changed = true; change(context); }
    } });
    await h.f.step(); assert.equal(h.calls.length, 0); assert.equal(h.f.state.deliveries.length, 0);
  }
});
test('old state, stopped scans, blocked rooms and disabled settings do not send', async () => {
  for (const change of [c => { c.settings.enabled = false; }, c => { c.live.updated -= 30001; },
    c => { c.live.phase = 'stopped'; }, c => { c.live.scan.enabled = false; },
    c => { c.live.phase = 'storage_error'; }, c => { c.live.storage = { error: 'disk full' }; },
    c => { c.live.scan.settingsError = 'broken settings'; }, c => { c.live.blocklist = { error: 'broken list' }; },
    c => { c.noticeSettings = null; }, c => { c.blocked = ['1000']; }]) {
    const h = harness(); change(h.context); await h.f.step(); assert.equal(h.calls.length, 0);
  }
});
test('storage failure prevents sender calls and transport exceptions become uncertain', async () => {
  const h = harness({ save: () => { throw new Error('disk full'); } });
  await assert.rejects(h.f.step(), /disk full/); assert.equal(h.calls.length, 0);
  const thrown = harness({ send: () => { throw new Error('timeout'); } });
  await thrown.f.step(); assert.equal(thrown.f.state.deliveries[0].status, 'uncertain');
  thrown.advance(RETRY_MS); await thrown.f.step(); assert.equal(thrown.calls.length, 1);
});
test('corrupt deduplication is rejected rather than treated as an empty queue', () => {
  for (const saved of [null, {}, { version: 1, deliveries: 'bad' },
    { version: 1, deliveries: [{ key: 'x', until: Infinity, status: 'sent' }] }]) {
    assert.throws(() => initialState(saved));
  }
});
test('independent switch validates and persists; malformed files do not enable forwarding', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-switch-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'settings.json');
  assert.deepEqual(settings.readSettings(file), { enabled: false, minPerPerson: null });
  settings.writeSettings({ enabled: true }, file); assert.deepEqual(settings.readSettings(file), { enabled: true, minPerPerson: null });
  for (const invalid of [{ enabled: 'true' }, {}, { enabled: true, groupId: 'other' }]) {
    assert.throws(() => settings.writeSettings(invalid, file)); assert.equal(settings.readSettings(file).enabled, true);
  }
  fs.writeFileSync(file, '{broken'); assert.throws(() => settings.readSettings(file));
});
test('QQ minimum persists across legacy switches and invalid thresholds cannot replace it', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-minimum-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'settings.json');
  fs.writeFileSync(file, JSON.stringify({ enabled: true }));
  assert.equal(settings.readSettings(file).minPerPerson, null);
  settings.writeSettings({ enabled: true, minPerPerson: 2 }, file);
  settings.writeSettings({ enabled: false }, file);
  assert.deepEqual(settings.readSettings(file), { enabled: false, minPerPerson: 2 });
  settings.writeSettings({ enabled: true }, file);
  for (const minimum of ['2', -1, Infinity, NaN, 100000001]) {
    assert.throws(() => settings.writeSettings({ enabled: true, minPerPerson: minimum }, file));
    assert.equal(settings.readSettings(file).minPerPerson, 2);
  }
  settings.writeSettings({ enabled: true, minPerPerson: 0 }, file);
  assert.equal(settings.readSettings(file).minPerPerson, 0);
  settings.writeSettings({ enabled: true, minPerPerson: null }, file);
  assert.equal(settings.readSettings(file).minPerPerson, null);
  fs.writeFileSync(file, '{broken');
  settings.writeSettings({ enabled: true, minPerPerson: 2 }, file);
  assert.equal(settings.readSettings(file).minPerPerson, 2);
});
test('QQ switch API is independent, checks same origin, and exposes worker status without message records', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-api-'));
  const file = path.join(root, 'settings.json'), status = path.join(root, 'state.json');
  fs.writeFileSync(status, JSON.stringify({ version: 1, updated: TIME, sent: 2,
    deliveries: [{ text: 'private record' }] }));
  let started = 0;
  const server = createServer({ qqForwardSettingsFile: file, qqForwardStateFile: status, startQQWorker: () => { started++; } });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise(r => server.close(r)); fs.rmSync(root, { recursive: true, force: true }); });
  const base = 'http://127.0.0.1:' + server.address().port;
  const put = (body, origin = base) => fetch(base + '/pool/api/qq-forward-settings', {
    method: 'PUT', headers: { 'content-type': 'application/json', origin }, body: JSON.stringify(body),
  });
  assert.equal((await (await fetch(base + '/pool/api/qq-forward-settings')).json()).settings.enabled, false);
  assert.equal((await put({ enabled: true }, 'https://other.invalid')).status, 403); assert.equal(started, 0);
  assert.equal((await put({ enabled: true, minPerPerson: 2 })).status, 200); assert.equal(started, 1);
  assert.equal((await put({ enabled: true, minPerPerson: '2' })).status, 400); assert.equal(started, 1);
  assert.equal((await put({ enabled: false })).status, 200); assert.equal(started, 1);
  assert.equal(settings.readSettings(file).enabled, false);
  assert.equal(settings.readSettings(file).minPerPerson, 2);
  const data = await (await fetch(base + '/pool/api/qq-forward-status')).json();
  assert.equal(data.sent, 2); assert.equal(data.deliveries, undefined); assert.equal(data.groupId, '1127875934');
});
