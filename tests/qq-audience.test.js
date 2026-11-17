'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createAudienceResolver, RETRY_MS } = require('../core/qq-audience');
const { Forwarder, buildCandidate, refreshForward } = require('../core/qq-forward');
const notices = require('../core/notification-settings');
const T = Date.parse('2026-11-13T20:00:00+08:00');
const packet = extra => ({ lid: '1', room_id: '1000', battery: 100, award_num: 10, award_name: '电池红包',
  join_requirement: 2, start_time: T / 1000, end_time: T / 1000 + 300, ...extra });
const rules = { ...notices.DEFAULTS, enabled: true, minRemainingSeconds: 120 };
const response = (data, status = 200) => ({ ok: status === 200, status, json: async () => ({ code: 0, data }) });
const candidate = () => buildCandidate(packet(), T, rules);
test('100/50 packets query and send a real audience count with QQ minimum 2 and desktop notifications off', async () => {
  const calls = [], sent = [], snapshots = [];
  const context = { settings: { enabled: true, minPerPerson: 2 }, noticeSettings: { ...rules, enabled: false }, blocked: [],
    live: { updated: T, phase: 'scanning', redpockets: [packet({ award_num: 50, audience: null })] } };
  const resolver = createAudienceResolver({ clock: () => T, fetcher: async url => {
    assert.equal(snapshots.at(-1).deliveries[0].status, 'reserved'); calls.push(url);
    return response(url.includes('/Room/get_info') ? { uid: 123 } : { onlineNum: 47 });
  } });
  const f = new Forwarder({ readContext: () => context, clock: () => T, candidateBuilder: buildCandidate,
    save: state => snapshots.push(structuredClone(state)), send: async p => {
      const counted = await resolver(p), message = refreshForward(counted, f.context(), T);
      assert.ok(message); sent.push(message); return { status: 'sent', audience: message.audience };
    } });
  await f.step(); assert.equal(calls.length, 2); assert.equal(sent.length, 1); assert.equal(f.state.sent, 1);
  assert.match(sent[0].text, /观众 47｜/); assert.equal(context.live.redpockets[0].audience, null);
  assert.match(sent[0].text, /100电池，50份/); assert.equal(context.noticeSettings.minPerPerson, 10);
  assert.equal(f.state.deliveries[0].audienceCount, 47); assert.equal(f.state.deliveries[0].audienceAt, T);
  await f.step(); assert.equal(calls.length, 2);
});
test('persisted anchor UIDs skip the room lookup but every new query fetches a current count including a real zero', async () => {
  let saved; const calls = [];
  const fetcher = async url => { calls.push(url); return response(url.includes('/Room/get_info') ? { uid: '123' } : { onlineNum: '0' }); };
  const resolver = createAudienceResolver({ fetcher, clock: () => T, save: data => { saved = structuredClone(data); } });
  assert.equal((await resolver(candidate())).audience.count, 0); assert.equal(calls.length, 2);
  const restored = createAudienceResolver({ saved, fetcher, clock: () => T });
  await restored({ ...candidate(), id: '2' }); assert.equal(calls.length, 3); assert.ok(calls[2].includes('getOnlineGoldRank'));
});
test('missing or malformed counts prevent sending and retry after ten seconds without using a stale count', async () => {
  for (const onlineNum of [null, undefined, '', -1, 1.5, 'many']) {
    let now = T, calls = 0, bad = true;
    const resolver = createAudienceResolver({ clock: () => now, saved: { '1000': { uid: 123, at: T } },
      fetcher: async () => { calls++; return response({ onlineNum: bad ? onlineNum : 42 }); } });
    await assert.rejects(resolver(candidate()), /有效观众人数/);
    await assert.rejects(resolver(candidate()), /稍后重试/); assert.equal(calls, 1);
    now += RETRY_MS; bad = false; assert.equal((await resolver(candidate())).audience.count, 42); assert.equal(calls, 2);
  }
});
test('blocking, pausing or expiry during a lookup cancels before the next request or message creation', async () => {
  for (const change of ['block', 'pause', 'expire']) {
    let now = T, enabled = true, blocked = false, calls = 0;
    const record = packet({ end_time: T / 1000 + 120 });
    const resolver = createAudienceResolver({ clock: () => now,
      allowed: () => enabled && !blocked && !!buildCandidate(record, now, rules),
      fetcher: async () => {
        calls++;
        if (change === 'block') blocked = true;
        if (change === 'pause') enabled = false;
        if (change === 'expire') now += 1001;
        return response({ uid: 123 });
      } });
    await assert.rejects(resolver(buildCandidate(record, T, rules)), /推送条件/); assert.equal(calls, 1);
  }
});
test('after direct lookup, changed qualification or deadline cancels while the polled count is ignored', async () => {
  const context = { noticeSettings: rules, blocked: [], live: { redpockets: [packet({
    audience: { count: 3, observedAt: T - 600000, source: 'online-gold-rank' } })] } };
  const resolver = createAudienceResolver({ clock: () => T,
    fetcher: async url => response(url.includes('/Room/get_info') ? { uid: 123 } : { onlineNum: 47 }) });
  const counted = await resolver(candidate()); assert.equal(refreshForward(counted, context, T).audienceCount, 47);
  context.blocked = ['1000']; assert.equal(refreshForward(counted, context, T), null); context.blocked = [];
  context.live.redpockets[0].battery = 200; assert.equal(refreshForward(counted, context, T), null);
  context.live.redpockets[0].battery = 100;
  assert.equal(refreshForward(counted, context, T + 180001), null);
});
test('explicit pre-send retry delays preserve serialization and avoid a one-minute wait after audience lookup failure', async () => {
  let now = T, calls = 0;
  const context = { settings: { enabled: true }, noticeSettings: rules, blocked: [],
    live: { updated: now, phase: 'scanning', redpockets: [packet()] } };
  const f = new Forwarder({ candidateBuilder: buildCandidate, readContext: () => context, clock: () => now,
    save: () => {}, send: async () => ++calls === 1 ? { status: 'notSent', retryAfterMs: RETRY_MS } : { status: 'sent' } });
  await f.step(); now += RETRY_MS - 1; context.live.updated = now; await f.step(); assert.equal(calls, 1);
  now++; context.live.updated = now; await f.step(); assert.equal(calls, 2); assert.equal(f.state.sent, 1);
});
test('rate-limit responses pause all direct audience requests and never become a fabricated count', async () => {
  let now = T, calls = 0;
  const resolver = createAudienceResolver({ clock: () => now,
    fetcher: async () => { calls++; return { ok: false, status: 429, json: async () => { throw new Error('not JSON'); } }; } });
  await assert.rejects(resolver(candidate()), /限流/);
  await assert.rejects(resolver({ ...candidate(), room: '1001' }), /限流/); assert.equal(calls, 1);
  now += 60000; await assert.rejects(resolver(candidate()), /限流/); assert.equal(calls, 2);
});
