'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const S = require('../core/strategy');
const QQ = require('../core/qq-evidence');
const T = Date.parse('2026-11-06T23:00:00+08:00');
const iso = at => new Date(at).toISOString();
const report = (at, extras = {}) => ({ room: '12345', battery: 100, push_time: iso(at),
  msg_time: iso(at + 1000), group: 'A', ...extras });

test('QQ reposts with the same draw time or packet id count once and retain the earliest evidence time', () => {
  const pool = new Map();
  const push = report(T - 60000, { push_time: '', end_time: iso(T + 300000) });
  const result = S.mergeQQ(pool, { pushes: [push, { ...push, group: 'B', msg_time: iso(T - 5000) },
    report(T - 3600000, {lot_id:'99'}), report(T - 60000, {lot_id:'99',group:'B'})] }, T);
  const r = pool.get('12345');
  assert.equal(result.uniqueBatteryReports, 2);
  assert.equal(r.qqPushes, 2);
  assert.equal(r.qqReports.find(p => p.id === 'lot:99').at, T - 3600000);
  assert.deepEqual(r.qqSources, ['A', 'B']);
  const restored = new Map([['12345', JSON.parse(JSON.stringify(r))]]);
  S.mergeQQ(restored, { pushes: [push, push] }, T);
  assert.equal(restored.get('12345').qqPushes, 1);
  assert.equal(r.batteryHits, undefined);
  assert.equal(r.anchorHits, undefined);
});

test('invalid, future, zero-value and non-battery QQ evidence does not create WARM priority', () => {
  const pool = new Map();
  S.mergeQQ(pool, { rooms:[{room:'12345',count:999,total_battery:9999,last:iso(T)}], pushes: [
    report(T+60000),report(T-60000,{battery:0}),report(T-60000,{award_name:'亲密度红包'}),
    report(T-60000,{push_time:'invalid'}),report(T-60000,{battery:Infinity}),
    report(T-60000,{msg_time:iso(T-120000)})] }, T);
  assert.equal(pool.get('12345').qqPushes, 0);
  assert.equal(S.tierOf(pool.get('12345'), T), 'COLD');
  const legacy = new Map();
  S.mergeQQ(legacy, {rooms:[{room:'12345',count:1,total_battery:100,last:iso(T+60000)}]}, T);
  assert.equal(S.tierOf(legacy.get('12345'), T), 'COLD');
});

test('old report counts cannot inherit the freshness of a new report and each report decays separately', () => {
  const pool = new Map();
  const ancient = Array.from({length:100},(_,i)=>report(T-6*86400000-i*1000));
  S.mergeQQ(pool,{pushes:[...ancient, report(T-60000)]},T);
  const r=pool.get('12345'), fresh=new Map();
  S.mergeQQ(fresh,{pushes:[report(T-60000)]},T);
  assert.ok(S.qqSignal(r,T).score-S.qqSignal(fresh.get('12345'),T).score<1);
  assert.equal(S.qqSignal(r,T).intervalMs,45000);
  assert.ok(S.qqSignal(r,T+86400000).score<S.qqSignal(r,T).score);
  assert.equal(S.qqSignal(r,T+S.DEFAULTS.qqRecentWindowMs).intervalMs,90000);
});

test('QQ weights actually change scheduling, empty success releases acceleration and a new report restores it', () => {
  const pool=new Map();
  S.mergeQQ(pool,{pushes:[report(T-60000),report(T-120000)]},T);
  const r=pool.get('12345');
  S.recordScan(r,[],T);
  assert.equal(S.qqSignal(r,T).intervalMs,30000);
  assert.ok(!S.buildRoundPlan(pool,1,T+29999).plan.includes('12345'));
  assert.ok(S.buildRoundPlan(pool,1,T+30000).plan.includes('12345'));
  const lastScan=r.lastScan;
  S.recordError(r,T+31000);
  assert.equal(r.qqMisses,1);
  assert.ok(!S.buildRoundPlan(pool,1,T+40000).plan.includes('12345'));
  for(let i=2;i<=4;i++) S.recordScan(r,[],T+i*90000);
  assert.equal(S.qqSignal(r,T+360000).intervalMs,90000);
  const lastAttempt=r.lastAttempt;
  S.mergeQQ(pool,{pushes:[report(T-60000),report(T-120000),report(T+370000)]},T+380000);
  assert.equal(r.qqMisses,0);
  assert.equal(r.lastAttempt,lastAttempt);
  assert.notEqual(r.lastScan,lastScan);
  assert.equal(S.qqSignal(r,T+380000).intervalMs,30000);
  assert.equal(r.batteryHits,undefined);
});

test('weighted WARM traversal remains fair and preserves exploration and the actual ranking cap', () => {
  const pool=new Map();const pushes=[];
  for(let i=0;i<150;i++) {
    const room=String(10000+i);
    pushes.push(report(T-60000,{room}),report(T-120000,{room}));
  }
  S.mergeQQ(pool,{pushes},T);
  for(let i=0;i<500;i++)pool.set('c'+i,{firstSeen:T});
  for(let i=0;i<100;i++)pool.set('p'+i,{firstSeen:T,listingPriority:{at:T,rank:1,online:i}});
  const seen=new Set();
  for(let round=1;round<=6;round++) {
    const time=T+round*20000;
    const p=S.buildRoundPlan(pool,round,time);
    assert.equal(p.plan.length,109);
    assert.ok(p.quota.regularCold>=Math.ceil(p.quota.rpQuota*.3));
    assert.ok(p.quota.priority*5<=p.plan.length);
    let priority=0;
    for(let i=0;i<p.plan.length;i++) {
      const id=p.plan[i];
      if(p.priorityPlan.includes(id))priority++;
      assert.ok(priority*5<=i+1);
      if(/^1\d+$/.test(id))seen.add(id);
      S.recordScan(pool.get(id),[],time);
    }
  }
  assert.equal(seen.size,150);
});

test('old QQ sources back off after successful empty scans while recent and confirmed sources retain their intervals', () => {
  const make = age => {
    const pool = new Map(); S.mergeQQ(pool, { pushes: [report(T-age)] }, T);
    return pool.get('12345');
  };
  const old = make(3*3600000);
  for (const [misses, expected] of [[3,90000],[4,180000],[8,300000],[16,300000],[100,300000]]) {
    old.qqMisses=misses;
    assert.equal(S.qqSignal(old,T).intervalMs,expected);
  }
  assert.equal(S.qqSignal(make(6*3600000),T).intervalMs,180000);
  assert.equal(S.qqSignal(make(24*3600000),T).intervalMs,300000);
  const recent=make(3600000); recent.qqMisses=16;
  assert.equal(S.qqSignal(recent,T).intervalMs,90000);
  old.lastBatteryHit=T-3600000;
  assert.equal(S.qqSignal(old,T).intervalMs,90000);
  old.lastBatteryHit=T-60000;
  assert.equal(S.tierOf(old,T),'HOT');
  const misses=old.qqMisses;
  S.recordError(old,T);
  assert.equal(old.qqMisses,misses);
});

test('expired historical imports neither reset empty evidence nor request fast verification', () => {
  const pool=new Map(); const ancient=report(T-3*3600000);
  S.mergeQQ(pool,{pushes:[ancient]},T);
  const r=pool.get('12345'); r.qqMisses=16; r.lastScan=r.lastAttempt=T-10000;
  const expired=report(T-60000,{end_time:iso(T-5000),award_num:10});
  S.mergeQQ(pool,{pushes:[ancient,expired]},T);
  assert.equal(r.qqMisses,16);
  assert.equal(S.qqSignal(r,T).recent,1);
  assert.equal(S.qqSignal(r,T).fastRecent,0);
  assert.equal(S.qqSignal(r,T).verifyPending,false);
  assert.equal(S.qqSignal(r,T).intervalMs,90000);
  assert.ok(!S.buildRoundPlan(pool,1,T).plan.includes('12345'));
});

test('an unexpired new report gets one early WARM verification; reposts and errors cannot repeat it', () => {
  const pool=new Map();
  const push=report(T-6000,{end_time:iso(T+300000),award_num:10});
  const r=S.ensureRoom(pool,'12345',T-10000); r.lastAttempt=r.lastScan=T-10000;
  S.mergeQQ(pool,{pushes:[push]},T);
  assert.equal(S.qqSignal(r,T).verifyPending,true);
  assert.deepEqual(S.buildRoundPlan(pool,1,T).plan,['12345']);
  assert.equal(S.tierOf(r,T),'WARM');
  S.recordScan(r,[],T);
  assert.equal(S.qqSignal(r,T).verifyPending,false);
  assert.deepEqual(S.buildRoundPlan(pool,1,T+1000).plan,[]);
  r.qqMisses=8;
  S.mergeQQ(pool,{pushes:[push,{...push,msg_time:iso(T+1000)}]},T+2000);
  assert.equal(r.qqMisses,8);
  assert.equal(S.qqSignal(r,T+2000).verifyPending,false);
  const newPush=report(T+2000,{end_time:iso(T+400000),award_num:10});
  S.mergeQQ(pool,{pushes:[push,newPush]},T+4000);
  assert.equal(r.qqMisses,0);
  assert.equal(S.qqSignal(r,T+4000).verifyPending,true);
  S.recordError(r,T+4000);
  assert.equal(r.qqMisses,0);
  assert.equal(S.qqSignal(r,T+4000).verifyPending,false);
  assert.deepEqual(S.buildRoundPlan(pool,1,T+5000).plan,[]);
});

test('known useful shares outrank unknown and low shares; conflicting reposts remain weak evidence', () => {
  const pool=new Map();
  const pushes=[10,0,50].map((award_num,i)=>report(T-60000,{room:String(12345+i),award_num,end_time:iso(T+300000)}));
  S.mergeQQ(pool,{pushes},T);
  const signals=[...pool.values()].map(r=>S.qqSignal(r,T));
  assert.ok(signals[0].score>signals[1].score && signals[1].score>signals[2].score);
  assert.equal(signals[0].usefulRatio,1);
  assert.equal(signals[1].usefulRatio,null);
  assert.equal(signals[2].usefulRatio,0);
  for(const reversed of [false,true]) {
    const conflicts=[pushes[0],{...pushes[0],award_num:50,msg_time:iso(T-5000)}];
    if(reversed)conflicts.reverse();
    const p=new Map();S.mergeQQ(p,{pushes:conflicts},T);
    const r=p.get('12345');
    assert.equal(r.qqPushes,1);
    assert.equal(r.qqReports[0].shareConflict,true);
    assert.equal(S.qqSignal(r,T).usefulRatio,null);
    assert.equal(r.qqReports[0].availableAt,T-59000);
  }
});

test('useful share weighting changes WARM order while a sufficiently overdue low-share source still gets a turn', () => {
  const pool=new Map();
  S.mergeQQ(pool,{pushes:[report(T-60000,{room:'12345',award_num:10}),report(T-60000,{room:'12346',award_num:50})]},T);
  for(const r of pool.values()) {r.lastAttempt=T-120000;r.qqMisses=4;}
  assert.deepEqual(S.buildRoundPlan(pool,1,T,{perIpBudget:2}).plan,['12345']);
  pool.get('12346').lastAttempt=T-240000;
  pool.get('12345').lastAttempt=T-90000;
  assert.deepEqual(S.buildRoundPlan(pool,1,T,{perIpBudget:2}).plan,['12346']);
});

test('legacy and detailed QQ sources share a consistent fair ordering regardless of pool insertion order', () => {
  const pool=new Map();
  S.mergeQQ(pool,{rooms:[{room:'12345',count:5,total_battery:500,last:iso(T-60000)}]},T);
  S.mergeQQ(pool,{pushes:[report(T-60000,{room:'12346'})]},T);
  pool.get('12345').lastAttempt=T-240000;
  pool.get('12346').lastAttempt=T-90000;
  pool.get('12346').qqMisses=4;
  for(const entries of [[...pool],[...pool].reverse()]) {
    assert.deepEqual(S.buildRoundPlan(new Map(entries),1,T,{perIpBudget:2}).plan,['12345']);
  }
});

test('ordinary and missing gates remain verification sources while explicit special and unknown gates contribute no signal', () => {
  for (const join_requirement of [0, 1, 2, '2', undefined, null, 3, '3', 4, 'unknown', '大航海']) {
    const pool = new Map();
    const result = S.mergeQQ(pool, { pushes: [report(T-60000, { join_requirement, award_num: 10,
      end_time: iso(T+300000) })] }, T);
    const r = pool.get('12345'), signal = S.qqSignal(r, T);
    const allowed = join_requirement == null || [0, 1, 2, '2'].includes(join_requirement);
    assert.equal(result.uniqueBatteryReports, allowed ? 1 : 0);
    assert.equal(r.qqPushes, allowed ? 1 : 0);
    assert.equal(signal.verifyPending, allowed);
    assert.equal(signal.fastRecent, allowed ? 1 : 0);
    assert.equal(signal.usefulRecent, allowed ? 1 : 0);
    if (!allowed) {
      assert.equal(signal.score, 0);
      assert.equal(S.tierOf(r, T), 'COLD');
    }
  }
  assert.equal(QQ.eligibleReport({ joinRequirement: null, requirementState: 'unknown' }), false);
});

test('same-packet gate conflicts are conservative in either report order and survive repeated exports', () => {
  for (const requirement of [1, 2, 3, 'unknown']) {
    for (const reversed of [false, true]) {
      const first = report(T-60000, { lot_id: 'gated', join_requirement: 0, award_num: 10 });
      const second = { ...first, join_requirement: requirement, msg_time: iso(T-10000) };
      const pool = new Map(); S.mergeQQ(pool, { pushes: reversed ? [second, first] : [first, second] }, T);
      const r = pool.get('12345');
      assert.equal(r.qqReports[0].requirementConflict, true);
      assert.equal(r.qqPushes, 0);
      assert.equal(S.qqSignal(r, T).score, 0);
      S.mergeQQ(pool, { pushes: [first] }, T+1000);
      assert.equal(r.qqReports[0].requirementConflict, true);
      assert.equal(S.qqSignal(r, T+1000).verifyPending, false);
    }
  }
  const pool = new Map();
  const known = report(T-60000, { lot_id: 'missing', join_requirement: 2, award_num: 10 });
  S.mergeQQ(pool, { pushes: [known, { ...known, join_requirement: null }] }, T);
  assert.equal(pool.get('12345').qqReports[0].requirementConflict, false);
  assert.equal(pool.get('12345').qqReports[0].joinRequirement, 2);
});

test('successive exports retain the earliest event and availability times and previous amount conflicts', () => {
  const pool = new Map();
  const first = report(T-3*3600000, { lot_id: 'immutable', end_time: iso(T+300000), award_num: 10 });
  S.mergeQQ(pool, { pushes: [first] }, T);
  const r = pool.get('12345');
  r.lastScan = r.lastAttempt = T; r.qqMisses = 8;
  const later = report(T+1000, { lot_id: 'immutable', end_time: iso(T+300000), award_num: 50, battery: 200 });
  S.mergeQQ(pool, { extracted_at: iso(T+2000), pushes: [later] }, T+2000);
  assert.equal(r.qqReports[0].at, T-3*3600000);
  assert.equal(r.qqReports[0].availableAt, T-3*3600000+1000);
  assert.equal(r.qqLastAt, T-3*3600000);
  assert.equal(r.qqMisses, 8);
  assert.equal(r.qqReports[0].shareConflict, true);
  assert.equal(r.qqReports[0].batteryConflict, true);
  assert.equal(S.qqSignal(r, T+2000).recent, 0);
  assert.equal(S.qqSignal(r, T+2000).verifyPending, false);
  S.mergeQQ(pool, { pushes: [first] }, T+3000);
  assert.equal(r.qqReports[0].shareConflict, true);
  assert.equal(r.qqReports[0].batteryConflict, true);
});

test('upgrading old QQ reports preserves exhausted scans and inferred draw times retain their original report identity', () => {
  const pool = new Map();
  const first = report(T-60000, { push_time_source: 'report_scan_time', message_id: '55', group_id: '850739736' });
  S.mergeQQ(pool, { pushes: [first] }, T);
  const r = pool.get('12345');
  r.qqEvidenceVersion = 1;
  for (const p of r.qqReports) {
    delete p.messageKeys; delete p.joinRequirement; delete p.requirementState; delete p.atSource;
    p.confidence = 1;
  }
  r.lastScan = r.lastAttempt = T; r.qqMisses = 8;
  const inferred = { ...first, end_time: iso(T+300000), end_time_source: 'remaining_report_time',
    end_time_reference: first.push_time, end_time_approximate: true, left: '约 6分 0秒', award_num: 10 };
  S.mergeQQ(pool, { schema_version: 3, extracted_at: iso(T+1000), pushes: [inferred] }, T+1000);
  assert.equal(r.qqEvidenceVersion, 2);
  assert.equal(r.qqReports[0].id, 'at:'+(T-60000));
  assert.equal(r.qqReports[0].atSource, 'report_scan_time');
  assert.equal(r.qqReports[0].endSource, 'remaining_report_time');
  assert.equal(r.qqReports[0].left, '约 6分 0秒');
  assert.equal(r.qqReports[0].confidence, .5);
  assert.equal(r.qqReports[0].availableAt, T-59000);
  assert.equal(r.qqMisses, 8);
  assert.equal(S.qqSignal(r, T+1000).verifyPending, false);
});

test('nearby cross-group report times and inferred countdowns never guess a common packet', () => {
  const pool = new Map();
  const first = report(T-60000, { group: 'A', end_time: iso(T+300000), end_time_source: 'remaining_report_time' });
  const nearby = report(T-59000, { group: 'B', end_time: iso(T+300000), end_time_source: 'remaining_report_time' });
  S.mergeQQ(pool, { pushes: [first, nearby] }, T);
  assert.equal(pool.get('12345').qqReports.length, 2);
  const explicit = new Map();
  S.mergeQQ(explicit, { pushes: [{ ...first, end_time_source: 'explicit_datetime' },
    { ...nearby, end_time_source: 'explicit_datetime' }] }, T);
  assert.equal(explicit.get('12345').qqReports.length, 1);
});

test('old persisted detailed reports also enforce explicit gate restrictions before any reimport', () => {
  const r = { qqEvidenceVersion: 1, qqLastAt: T-60000, qqPushes: 1,
    qqReports: [{ id: 'lot:old', at: T-60000, availableAt: T-59000, endAt: T+300000,
      battery: 100, awardNum: 10, confidence: 1, join_requirement: 'unknown' }] };
  const signal = S.qqSignal(r, T);
  assert.equal(signal.score, 0);
  assert.equal(signal.fastRecent, 0);
  assert.equal(signal.verifyPending, false);
});
