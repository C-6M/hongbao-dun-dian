'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { HistoryStore, describeResult } = require('../core/history-store');
const { createServer } = require('../core/server');

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rp-history-'));
  const file = path.join(dir, 'history.sqlite');
  const stores = [];
  const open = (options) => { const s = new HistoryStore(file, options); stores.push(s); return s; };
  t.after(() => { for (const s of stores) { try { s.close(); } catch {} } fs.rmSync(dir, {recursive:true,force:true}); });
  return {file,open};
}
const lot = {lot_id:123,total_price:10000,awards:[{gift_name:'电池红包',num:10}],start_time:1,end_time:100};
const ok = lots => ({status:'OK',code:0,httpCode:200,data:{lot_info:lots}});
function record(store, result, at = 1000, roomId = '42') {
  const meta = {kind:'rp',roomId,round:1,tier:'COLD',startedAt:at};
  const req = store.beginRequest(meta); store.completeRequest(req,meta,result,at+10); return req;
}

test('events and every observation survive reopen; concurrent readers see committed data', t => {
  const f = fixture(t), s = f.open(); s.startRun({perIpBudget:66},500);
  record(s,ok([lot])); record(s,ok([lot]),2000); record(s,ok(null),3000);
  const reader = f.open({readOnly:true});
  assert.equal(reader.summary().requests.total,3);
  assert.equal(reader.summary().events.total,1);
  s.endRun(); s.close();
  const restored = f.open();
  const event = restored.query('events').items[0];
  assert.equal(event.first_seen,1010); assert.equal(event.last_seen,2010);
  assert.equal(event.observations,2); assert.equal(event.per_person,10);
  assert.equal(restored.query('requests',{outcome:'empty'}).items.length,1);
  assert.equal(restored.db.prepare('PRAGMA integrity_check').get().integrity_check,'ok');
});

test('imports deduplicate across snapshots, retain actual discovery times and create no fake scans', t => {
  const f = fixture(t), s = f.open();
  const a = {lid:123,room_id:'42',first_seen:100,last_seen:200,battery:100,per_person:10};
  assert.equal(s.importState({history:[a],redpockets:[a]},'snapshot1'),2);
  assert.equal(s.importState({history:[a]},'snapshot1'),0);
  s.importState({expired:[{...a,first_seen:50,last_seen:150}]},'snapshot2');
  assert.equal(s.summary().events.total,1); assert.equal(s.summary().requests.total,0);
  const event = s.query('events').items[0];
  assert.equal(event.first_seen,50); assert.equal(event.last_seen,200); assert.equal(event.observations,0);
  s.startRun({}); record(s,ok([lot]));
  const updated = s.query('events').items[0];
  assert.equal(updated.first_seen,50); assert.equal(updated.imported,1); assert.equal(updated.observations,1);
});

test('unfinished requests become interrupted on restart without inventing empty results or finish times', t => {
  const f = fixture(t), s = f.open(); s.startRun({});
  s.beginRequest({kind:'rp',roomId:'42',startedAt:1000}); s.close();
  const next = f.open(); next.startRun({});
  const r = next.query('requests').items[0];
  assert.equal(r.outcome,'interrupted'); assert.equal(r.finished_at,null);
  assert.equal(next.query('events').items.length,0);
});

test('classification distinguishes empty, errors, limits, cancellations and expired rewards', () => {
  for (const [result, expected] of [[ok(null),'empty'],[ok([]),'empty'],[ok([null]),'error'],
    [{status:'NETWORK'},'error'],[{status:'OK',code:-1},'error'],[{status:'BANNED',httpCode:412},'banned'],
    [{status:'ABORT'},'cancelled'],[ok([lot]),'hit']]) {
    assert.equal(describeResult('rp',result,'42',1000).outcome,expected);
  }
  const expired = describeResult('rp',ok([lot]),'42',200000);
  assert.equal(expired.outcome,'empty'); assert.equal(expired.packets.length,1);
  assert.equal(describeResult('rp',{status:'OK',code:0,data:{}},'42',1000).reason,'schema');
});

test('transaction rolls back the result and event together, allowing safe recovery', t => {
  const f = fixture(t), s = f.open(); s.startRun({});
  const meta = {kind:'rp',roomId:'42',startedAt:1000}; const requestId = s.beginRequest(meta);
  s.db.exec("CREATE TRIGGER fail_link BEFORE INSERT ON request_events BEGIN SELECT RAISE(ABORT, 'disk simulation'); END");
  assert.throws(() => s.completeRequest(requestId,meta,ok([lot]),1100),/disk simulation/);
  assert.equal(s.summary().events.total,0);
  assert.equal(s.query('requests').items[0].outcome,'pending');
  s.db.exec('DROP TRIGGER fail_link'); s.completeRequest(requestId,meta,ok([lot]),1200);
  assert.throws(() => s.completeRequest(requestId,meta,ok([lot]),1300),/已完成/);
  assert.equal(s.query('events').items[0].observations,1);
});

test('history does not truncate at 100; cursor pagination and room/time/amount filters are stable', t => {
  const f = fixture(t), s = f.open(); s.startRun({});
  for (let i=1;i<=125;i++) record(s,ok([{...lot,lot_id:i}]),1000+i,i%2?'42':'43');
  assert.equal(s.summary().events.total,125);
  const first = s.query('events',{limit:50}), second = s.query('events',{limit:50,before:first.next});
  const third = s.query('events',{limit:50,before:second.next});
  assert.equal(new Set([...first.items,...second.items,...third.items].map(e=>e.id)).size,125);
  assert.equal(third.next,null);
  const filtered = s.query('requests',{room:'42',from:1100,to:1120}).items;
  assert.equal(filtered.length,10); assert.ok(filtered.every(r=>r.room_id==='42'));
  assert.equal(s.query('events',{minPerPerson:11}).items.length,0);
});

test('battery value restoration reads all real first active observations and excludes imports and late packets', t => {
  const f = fixture(t), s = f.open(); s.startRun({});
  for (let i = 1; i <= 125; i++) record(s, ok([{ ...lot, lot_id: i }]), 1000 + i);
  record(s, ok([{ ...lot, lot_id: 1 }]), 5000);
  record(s, ok([{ ...lot, lot_id: 999, end_time: 1 }]), 5000);
  s.importState({ history: [{ lid: 998, room_id: '42', first_seen: 2000, battery: 100, per_person: 10 }] }, 'value-import');
  const counts = s.summary();
  const values = s.recentBatteryEvidence(1000, 10000);
  assert.equal(values.length, 125);
  assert.equal(values[0].foundAt, 1011);
  assert.equal(values[0].lot.awards[0].num, 10);
  assert.ok(values.every(e => e.roomId === '42' && e.lot.lot_id !== 999 && e.lot.lot_id !== 998));
  assert.equal(s.recentBatteryEvidence(2000, 10000).length, 0);
  assert.equal(s.summary().events.total, counts.events.total);
  assert.equal(s.summary().requests.total, counts.requests.total);
});

test('value restoration retains participation restrictions after a saved summary replaces raw details', t => {
  const f = fixture(t), s = f.open(); s.startRun({});
  record(s, ok([{ ...lot, join_requirement: 3, rp_type: 5 }]), 1000);
  s.importState({ history: [{ kind: 'popularity_red_pocket', lid: lot.lot_id, room_id: '42',
    first_seen: 1010, last_seen: 2000, total_price: 10000, battery: 100, per_person: 10,
    award_name: '电池红包', award_num: 10, start_time: 1, end_time: 100,
    join_requirement: 3, rp_type: 5 }] }, 'normalized-summary');
  const values = s.recentBatteryEvidence(0, 3000);
  assert.equal(values.length, 1);
  assert.equal(values[0].lot.join_requirement, 3);
  assert.equal(values[0].lot.awards[0].gift_name, '电池红包');
  assert.equal(values[0].foundAt, 1010);
  assert.equal(s.summary().events.total, 1);
  assert.equal(s.summary().requests.total, 1);
});

test('history API supports queries and rejects invalid input without creating a missing database', async t => {
  let server;
  t.after(() => new Promise(resolve => {
    server.closeAllConnections(); server.close(resolve);
  }));
  const f = fixture(t);
  server = createServer({historyFile:f.file});
  await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
  const base = 'http://127.0.0.1:' + server.address().port;
  assert.equal((await fetch(base+'/pool/api/history/summary')).status,503);
  assert.equal(fs.existsSync(f.file),false);
  const s = f.open(); s.startRun({perIpBudget:110}); record(s,ok([lot]));
  const result = await (await fetch(base+'/pool/api/history/events?room=42&minPerPerson=10')).json();
  assert.equal(result.items.length,1);
  assert.equal((await fetch(base+'/pool/api/history/requests?limit=100000')).status,400);
  assert.equal((await fetch(base+'/pool/api/history/events?room=42%27%20OR%201=1')).status,400);
  assert.equal((await fetch(base+'/pool/api/history/events?from=20&to=10')).status,400);
  assert.equal((await fetch(base+'/pool/api/history/events',{method:'POST'})).status,405);
  const summary = await (await fetch(base+'/pool/api/history/summary')).json();
  assert.equal(summary.run.config.perIpBudget,110);
  assert.equal((await fetch(base+'/pool/history')).status,200);
});

test('audience request types are queryable while missing counts are recorded as schema errors', async t => {
  let server;
  // Close the API reader before the Windows fixture removes its database.
  t.after(() => new Promise(resolve => {
    if (!server) return resolve();
    server.closeAllConnections(); server.close(resolve);
  }));
  const f = fixture(t), s = f.open(); s.startRun({});
  for (const [kind, data] of [['audience-room', { uid: 123 }], ['audience', { onlineNum: 0 }], ['audience', {}]]) {
    const meta = { kind, roomId: '42', tier: 'AUDIENCE', startedAt: 1000 };
    const request = s.beginRequest(meta);
    s.completeRequest(request, meta, { status: 'OK', code: 0, data }, 1100);
  }
  server = createServer({ historyFile: f.file });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + server.address().port + '/pool/api/history/requests?kind=';
  const audience = await (await fetch(base + 'audience')).json();
  assert.equal(audience.ok, true); assert.equal(audience.items.length, 2);
  assert.equal(audience.items.filter(r => r.outcome === 'error' && r.reason === 'schema').length, 1);
  assert.equal((await (await fetch(base + 'audience-room')).json()).items.length, 1);
  assert.equal((await fetch(base + 'made-up')).status, 400);
  assert.equal(s.summary().events.total, 0);
});
