'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildCandidates, validateManifest, WINDOW_MS, HALF_LIFE_MS } = require('../core/historical-sources');

const DAY = 86400000;
const T = Date.parse('2026-11-10T12:00:00+08:00');
const iso = at => new Date(at).toISOString();
const clone = value => JSON.parse(JSON.stringify(value));
const local = (roomId, lotId, foundAt, extras = {}) => ({ roomId, foundAt,
  lot: { lot_id: lotId, total_price: 10000, awards: [{ gift_name: '电池红包', num: 10 }],
    end_time: (foundAt + 60000) / 1000, ...extras } });
const qq = (room, lotId, at, extras = {}) => ({ room, lot_id: lotId, battery: 100, award_num: 10,
  award_name: '电池红包', push_time: iso(at), msg_time: iso(at + 1000),
  end_time: iso(at + 60000), group: 'A', ...extras });
const localThree = (room = '12345') => [local(room, '1', T - 2 * DAY),
  local(room, '2', T - DAY), local(room, '3', T - DAY + 2000)];
const qqThree = (room = '12345') => [qq(room, 'q1', T - 2 * DAY),
  qq(room, 'q2', T - DAY), qq(room, 'q3', T - DAY + 2000)];
const build = (localEvidence = [], pushes = [], extras = {}) => buildCandidates({ at: T,
  localEvidence, qqData: { pushes }, ...extras });

test('three distinct useful packets across two days qualify; unknown shares, low shares and non-battery lots do not', () => {
  const evidence = [...localThree(), ...localThree('12346').map(e => ({ ...e,
    lot: { ...e.lot, awards: [{ gift_name: '电池红包' }] } })),
  ...localThree('12347').map(e => ({ ...e, lot: { ...e.lot, total_price: 9900 } })),
  ...localThree('12348').map(e => ({ ...e, lot: { ...e.lot, awards: [{ gift_name: '亲密度红包', num: 10 }] } }))];
  const manifest = build(evidence);
  assert.deepEqual(manifest.candidates.map(c => c.room), ['12345']);
  const candidate = manifest.candidates[0];
  assert.equal(candidate.localUseful, 3);
  assert.equal(candidate.qqUseful, 0);
  assert.equal(candidate.distinctDays, 2);
  assert.equal(candidate.source, 'local');
  assert.equal(candidate.lastUsefulAt, T - DAY + 2000);
  assert.equal(candidate.evidence[0].perPerson, 10);
  assert.equal(validateManifest(clone(manifest), { at: T }).generatedAt, T);
});

test('local observations and reposts cannot multiply the same packet; later repeats do not refresh its age', () => {
  const evidence = localThree();
  const old = local('12346', 'same', T - 31 * DAY);
  const manifest = build([...evidence, evidence[0], local('12345', '1', T - 1000),
    old, local('12346', 'same', T - DAY), local('12346', 'same', T - DAY + 1000),
    local('12346', 'same', T - 2000)]);
  assert.deepEqual(manifest.candidates.map(c => c.room), ['12345']);
  assert.equal(manifest.candidates[0].localUseful, 3);
  assert.equal(manifest.candidates[0].evidence[0].foundAt, evidence[0].foundAt);
});

test('local and QQ evidence never add together to meet either the three-event or two-day threshold', () => {
  const tooFew = build(localThree().slice(0, 2), qqThree().slice(0, 2));
  assert.equal(tooFew.candidates.length, 0);
  const sameDay = [0, 1000, 2000].map((offset, i) => local('12345', String(i), T - DAY + offset));
  assert.equal(build(sameDay, qqThree().slice(0, 2)).candidates.length, 0);
  const fromQQ = build(sameDay, qqThree()).candidates[0];
  assert.equal(fromQQ.source, 'qq');
  assert.equal(fromQQ.localUseful, 3);
  assert.equal(fromQQ.qqUseful, 3);
  assert.equal(fromQQ.distinctDays, 2);
});

test('the evidence window is 30 days and future or unavailable observations never influence a past manifest', () => {
  const evidence = [...localThree('12345'),
    ...localThree('12346').map(e => ({ ...e, availableAt: T + 1 })),
    ...localThree('12347').map(e => ({ ...e, foundAt: T + DAY })),
    local('12348', 'old', T - WINDOW_MS), local('12348', '2', T - DAY), local('12348', '3', T - 2 * DAY)];
  const pushes = [...qqThree('12349').map(p => ({ ...p, msg_time: iso(T + 1) })),
    qq('12350', '1', T - WINDOW_MS), ...qqThree('12350').slice(1)];
  assert.deepEqual(build(evidence, pushes).candidates.map(c => c.room), ['12345']);
  const futureDuplicate = local('12345', '1', T + 1, { join_requirement: 3, total_price: 1 });
  assert.deepEqual(build([...localThree(), futureDuplicate]), build(localThree()));
});

test('first observations made after expiration cannot become historical evidence', () => {
  const expired = localThree().map(e => ({ ...e, lot: { ...e.lot, end_time: e.foundAt / 1000 } }));
  const lateQQ = qqThree('12346').map(p => ({ ...p, msg_time: iso(Date.parse(p.end_time) + 1000) }));
  assert.equal(build(expired, lateQQ).candidates.length, 0);
  const delayed = qqThree('12347').map(p => ({ ...p, msg_time: iso(Date.parse(p.push_time) + 30000) }));
  assert.equal(build([], delayed).candidates[0].qqUseful, 3);
});

test('explicit special, unknown and conflicting gates are excluded; ordinary and missing gates can qualify', () => {
  const locals = [...localThree('12345').map(e => ({ ...e, lot: { ...e.lot, join_requirement: 3 } })),
    ...localThree('12346').map(e => ({ ...e, lot: { ...e.lot, join_requirement: 0, raw: { join_requirement: 3 } } })),
    ...localThree('12347').map(e => ({ ...e, lot: { ...e.lot, join_requirement: '2' } }))];
  const pushes = [...qqThree('12348').map(p => ({ ...p, join_requirement: 'unknown' })),
    ...qqThree('12349').map(p => ({ ...p, join_requirement: 3 })),
    ...qqThree('12350').map(p => ({ ...p, join_requirement: 1 })), ...qqThree('12351'),
    ...qqThree('12352').flatMap(p => [p, { ...p, group: 'B', join_requirement: 3 }])];
  const manifest = build(locals, pushes);
  assert.deepEqual(manifest.candidates.map(c => c.room), ['12347', '12350', '12351']);
  assert.deepEqual(manifest.candidates.map(c => c.evidence[0].joinRequirement), [2, 1, null]);
});

test('QQ uses collect identity across groups and refuses conflicting recipient counts or battery amounts', () => {
  const reports = qqThree();
  const reposts = reports.flatMap(p => [p, { ...p, group: 'B', msg_time: iso(Date.parse(p.msg_time) + 1000) }]);
  const candidate = build([], reposts).candidates[0];
  assert.equal(candidate.qqUseful, 3);
  assert.equal(candidate.evidence[0].availableAt, Date.parse(reports[0].msg_time));
  for (const change of [{ award_num: 1 }, { battery: 101 }]) {
    const conflicts = qqThree('12346').flatMap(p => [p, { ...p, ...change, group: 'B' }]);
    assert.equal(build([], conflicts).candidates.length, 0);
  }
  const noIds = reports.map(p => ({ ...p, lot_id: undefined }));
  assert.equal(build([], [...noIds, ...noIds.map(p => ({ ...p, group: 'B' }))]).candidates[0].qqUseful, 3);
  assert.equal(build([], reports, { qqData: { rooms: [{ room: '12345', count: 999, total_battery: 999999 }] } }).candidates.length, 0);
});

test('calendar-day diversity uses Beijing dates, including the UTC date boundary', () => {
  const midnight = Date.parse('2026-11-09T00:00:00+08:00');
  const events = [local('12345', '1', midnight - 1000), local('12345', '2', midnight + 1000),
    local('12345', '3', midnight + 2000)];
  assert.equal(build(events).candidates[0].distinctDays, 2);
  assert.deepEqual(build(events).candidates[0].evidence.map(e => e.day), ['2026-11-08', '2026-11-09', '2026-11-09']);
});

test('each primary source event decays with a 14-day half-life without QQ corroboration inflating local score', () => {
  const current = build(localThree()).candidates[0];
  const older = build(localThree().map(e => ({ ...e, foundAt: e.foundAt - HALF_LIFE_MS,
    lot: { ...e.lot, end_time: e.lot.end_time - HALF_LIFE_MS / 1000 } }))).candidates[0];
  assert.equal(older.score, current.score / 2);
  const corroborated = build(localThree(), qqThree()).candidates[0];
  assert.equal(corroborated.score, current.score);
  assert.equal(corroborated.qqUseful, 3);
});

test('local qualifying sources rank ahead of QQ sources and a manifest contains at most 100 rooms', () => {
  const locals = localThree('10000').map(e => ({ ...e, foundAt: e.foundAt - 20 * DAY,
    lot: { ...e.lot, end_time: e.lot.end_time - 20 * DAY / 1000 } }));
  const pushes = Array.from({ length: 110 }, (_, i) => qqThree(String(20000 + i))).flat();
  const manifest = build(locals, pushes);
  assert.equal(manifest.candidates.length, 100);
  assert.equal(manifest.candidates[0].room, '10000');
  assert.ok(manifest.candidates[0].score < manifest.candidates[1].score);
  assert.equal(new Set(manifest.candidates.map(c => c.room)).size, 100);
  assert.deepEqual(build(locals, pushes, { limit: 1 }).candidates.map(c => c.room), ['10000']);
  assert.equal(build(locals, pushes, { limit: 0 }).candidates.length, 0);
  assert.throws(() => build([], [], { limit: 101 }), /上限/);
  validateManifest(clone(manifest), { at: T });
});

test('the permanent blocked room and configured blocklist are excluded at generation and recovery', () => {
  const manifest = build([...localThree('22748536'), ...localThree('12345'), ...localThree('12346')],
    qqThree('22748536'), { blockedRooms: ['12346'] });
  assert.deepEqual(manifest.candidates.map(c => c.room), ['12345']);
  assert.equal(validateManifest(manifest, { at: T, blockedRooms: ['12345'] }), manifest);
  const invalid = clone(manifest); invalid.candidates[0].room = '22748536';
  assert.throws(() => validateManifest(invalid, { at: T }), /固定名单无效/);
});

test('fixed manifests restore unchanged after evidence ages out and reject malformed or future snapshots', () => {
  const manifest = build(localThree(), qqThree('12346'));
  const saved = clone(manifest);
  assert.equal(validateManifest(saved, { at: T + 60 * DAY }), saved);
  assert.deepEqual(saved, manifest);
  assert.throws(() => validateManifest(saved, { at: T - 1 }), /生成时间/);
  const mutations = [m => { m.version = 2; }, m => { m.candidates = {}; },
    m => { m.candidates.push(clone(m.candidates[0])); }, m => { m.candidates[0].score = Infinity; },
    m => { m.candidates[0].score += .1; }, m => { m.candidates[0].localUseful++; },
    m => { m.candidates[0].lastUsefulAt++; }, m => { m.candidates[0].distinctDays++; },
    m => { m.candidates[0].room = 'abc'; }, m => { m.candidates[0].room = '012345'; },
    m => { m.candidates[0].evidence[0].availableAt = T + 1; },
    m => { m.candidates[0].evidence[0].foundAt = T - WINDOW_MS; },
    m => { m.candidates[0].evidence[0].day = '2026-99-99'; },
    m => { m.candidates[0].evidence[0].joinRequirement = 3; },
    m => { m.candidates[0].evidence[0].awardNum = 0; },
    m => { m.candidates[0].evidence[0].perPerson = 11; },
    m => { m.candidates[0].evidence.push(clone(m.candidates[0].evidence[0])); },
    m => { m.candidates.reverse(); }, m => { delete m.candidates[0].evidence; },
    m => { m.extra = true; }];
  for (const mutate of mutations) {
    const bad = clone(manifest); mutate(bad);
    assert.throws(() => validateManifest(bad, { at: T }), /固定名单无效/);
  }
  assert.throws(() => validateManifest(manifest, { at: T, limit: 1 }), /上限/);
  assert.throws(() => validateManifest(null, { at: T }), /固定名单无效/);
});
