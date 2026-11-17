'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const hotRank = require('../core/hot-rank');
const { HistoryStore, describeResult } = require('../core/history-store');
const sample = require('../docs/hot-rank-20261110/api-sample.json').response.data;

test('official global TOP50 response keeps original ranks and excludes previous/current room lists', () => {
  const data = structuredClone(sample);
  data.list[1].live_status = 0;
  data.current_room = { room_id: 99999999, rank: 1 };
  data.last_top = [{ room_id: 88888888, rank: 1 }];
  const result = hotRank.parseSnapshot(data);
  assert.equal(result.items.length, 50);
  assert.equal(result.items[1].rank, 2);
  assert.equal(result.items[1].liveStatus, 0);
  assert.ok(result.items.every(r => !['99999999', '88888888'].includes(r.roomid)));
  const url = new URL(hotRank.buildUrl());
  assert.equal(url.searchParams.get('sub_rank_type'), '1');
  assert.equal(hotRank.isTarget(url.href), true);
  assert.equal(hotRank.isTarget(url.href.replace('sub_rank_type=1', 'sub_rank_type=2')), false);
});

test('malformed/duplicate/unbounded global rank snapshots cannot be accepted as fresh evidence', () => {
  for (const change of [d => { d.list[0].rank = 51; }, d => { d.list[0].room_id = 0; },
    d => { d.list[0].live_status = undefined; }, d => { d.list[0].score = '100'; },
    d => { d.list[0] = structuredClone(d.list[1]); }, d => { d.list.push(d.list[0]); }]) {
    const data = structuredClone(sample); change(data);
    assert.throws(() => hotRank.parseSnapshot(data));
  }
  assert.throws(() => hotRank.parseSnapshot({ list: {} }));
  assert.deepEqual(hotRank.parseSnapshot({ list: [] }).items, []);
});

test('global ranking requests use existing discovery history with target-specific schema validation', t => {
  const store = new HistoryStore(':memory:'); t.after(() => store.close());
  store.startRun({ test: true });
  const meta = { kind: 'discovery', tier: 'GLOBAL_HOT_RANK', target: hotRank.buildUrl(), startedAt: 1 };
  const result = { status: 'OK', code: 0, httpCode: 200, data: sample };
  const request = store.beginRequest(meta); store.completeRequest(request, meta, result, 2);
  assert.equal(store.query('requests', { kind: 'discovery' }).items[0].outcome, 'ok');
  assert.equal(describeResult('discovery', result, null, 2, meta.target).reason, '');
  assert.equal(describeResult('discovery', result, null, 2, '/room/v1/area/getRoomList').reason, 'schema');
  assert.equal(describeResult('discovery', { ...result, data: { list: [{ rank: 1 }] } }, null, 2, meta.target).reason, 'schema');
});
