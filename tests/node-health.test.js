'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { publicIPv4, sampleCandidates, screenedHints, certifyNodes, chooseHealthy, selectionCost, safeSummary, monitoringIsEnough } = require('../deploy/instabox/node-health');
const wait = async () => {};
test('screened DNS hints are fresh, endpoint-specific and still require two new TCP passes', async () => {
  const now = Date.now(), node = {index:13,name:'new',server:'entry.example',port:1234,type:'ss'};
  const report = {at:new Date(now).toISOString(),rows:[{server:node.server,port:node.port,type:node.type,
    candidates:[{address:'8.8.8.8',tcpPasses:2,tcpAttempts:2,sources:['local-system-dns']}]}]};
  const hints = screenedHints([node],[report],now);
  assert.ok(hints.new);
  assert.deepEqual(screenedHints([{...node,port:5678}],[report],now),{});
  assert.deepEqual(screenedHints([node],[report],now+600001),{});
  assert.deepEqual(screenedHints([node],[{...report,at:new Date(now+1).toISOString()}],now),{});
  let attempts=0;
  const rows=await sampleCandidates([node],{resolve:async()=>[],hints,wait,
    tcp:async()=>({ok:++attempts===1})});
  assert.equal(attempts,2);
  assert.equal(rows[0].candidates.length,0);
});
const nodes = ['a', 'b', 'c', 'd'].map((name, i) => ({ index: i + 1, name, server: name + '.example',
  port: 1234, candidates: [{ address: '8.8.8.' + (i + 1) }], rejectedAnswers: 0, dnsErrors: 0 }));
function fixture() {
  let current;
  const calls = [];
  return { calls, switchNode: async name => { current = name; }, wait,
    query: async url => {
      calls.push({ name: current, zone: url.includes('/zone') });
      return url.includes('/zone') ? { status: 'OK', code: 0, data: { addr: '9.9.9.' + (nodes.findIndex(n => n.name === current) + 1) } }
        : { status: 'OK', code: 0, data: { lot_info: null } };
    },
  };
}
test('DNS candidate filtering rejects loopback, private, CGNAT, fake and reserved IPs', () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.1.1', '192.168.1.1', '100.64.0.1',
    '169.254.1.1', '198.18.0.1', '192.0.2.1', '203.0.113.1', '224.0.0.1', '::1', 'invalid']) assert.equal(publicIPv4(ip), false, ip);
  assert.equal(publicIPv4('8.8.8.8'), true);
});
test('DNS samples retain only repeatedly reachable endpoints of the same host and port', async () => {
  const requested = [], waits = [];
  const result = await sampleCandidates(nodes.slice(0, 2), {
    resolve: async host => [{ source: 'system', addresses: [{ address: '127.0.0.1' }] },
      { source: 'independent', addresses: [{ address: host === 'a.example' ? '8.8.8.8' : '9.9.9.9' }] }],
    tcp: async (ip, port) => { requested.push({ ip, port }); return { ok: ip === '8.8.8.8', elapsedMs: 2 }; },
    wait: async ms => waits.push(ms),
  });
  assert.equal(result[0].candidates[0].tcpPasses, 2);
  assert.equal(result[1].candidates.length, 0);
  assert.equal(requested.some(row => row.ip === '127.0.0.1'), false);
  assert.deepEqual(waits, [12000]);
  assert.ok(result.every(row => row.rejectedAnswers === 2));
});
test('one TCP pass followed by failure cannot certify an endpoint', async () => {
  let calls = 0;
  const result = await sampleCandidates(nodes.slice(0, 1), {
    resolve: async () => [{ source: 'dns', addresses: [{ address: '8.8.8.8' }] }],
    tcp: async () => ({ ok: calls++ === 0 }), wait,
  });
  assert.equal(result[0].candidates.length, 0);
});
test('one failed node does not block three continuously validated different exits', async () => {
  const f = fixture(), base = f.query;
  f.query = async url => { const result = await base(url); return f.calls.at(-1).name === 'd' ? { status: 'NETWORK' } : result; };
  const rows = await certifyNodes(nodes, f), selected = chooseHealthy(rows);
  assert.equal(selected.ok, true);
  assert.deepEqual(selected.selected.map(row => row.name).sort(), ['a', 'b', 'c']);
  assert.ok(selected.selected.every(row => row.passedRounds === 3 && row.requests === 6));
  assert.equal(rows[3].retries, 1); assert.equal(rows[3].passedRounds, 0);
});
test('IP detection cannot certify a malformed or missing redpocket payload', async () => {
  const f = fixture(), base = f.query;
  f.query = async url => url.includes('/zone') ? base(url) : { status: 'OK', code: 0, data: {} };
  const rows = await certifyNodes(nodes, f);
  assert.equal(chooseHealthy(rows).ok, false);
  assert.ok(rows.every(row => row.reason === 'REDPOCKET_SCHEMA'));
  assert.ok(safeSummary(rows).every(row => row.requestSuccessRate === 0.5));
});
test('a node failing its third round is not promoted based on two earlier passes', async () => {
  const f = fixture(), base = f.query;
  let round = 0;
  f.onRound = () => round++;
  f.query = async url => round === 2 && !url.includes('/zone') ? { status: 'HTTP', httpCode: 503 } : base(url);
  const rows = await certifyNodes(nodes, f);
  assert.ok(rows.every(row => row.passedRounds === 2)); assert.equal(chooseHealthy(rows).ok, false);
});
test('named nodes sharing an exit count only once', async () => {
  const f = fixture(), base = f.query;
  f.query = async url => { const r = await base(url); if (url.includes('/zone')) r.data.addr = '9.9.9.9'; return r; };
  const rows = await certifyNodes(nodes, f);
  assert.equal(chooseHealthy(rows).distinctExits, 1); assert.equal(chooseHealthy(rows).ok, false);
});
test('bans are not retried or sent to an alternate endpoint; cooldown avoids all requests', async () => {
  const f = fixture(); let changed = 0;
  f.query = async () => { f.calls.push(1); return { status: 'BANNED' }; };
  f.changeAddress = async () => changed++;
  const input = nodes.map(n => ({ ...n, candidates: [...n.candidates, { address: '1.1.1.1' }] }));
  const rows = await certifyNodes(input, f);
  assert.equal(f.calls.length, 4); assert.equal(changed, 0);
  assert.ok(rows.every(row => row.cooldownUntil > Date.now() + 14 * 60000));
  const cooldown = fixture(); cooldown.previous = Object.fromEntries(nodes.map(n => [n.name, { cooldownUntil: Date.now() + 60000 }]));
  const blocked = await certifyNodes(nodes, cooldown);
  assert.equal(cooldown.calls.length, 0); assert.ok(blocked.every(row => row.reason === 'COOLDOWN'));
});
test('a reachable alternate is tried once for transport failure', async () => {
  const f = fixture(), base = f.query;
  let recovered = false;
  f.query = async url => recovered ? base(url) : { status: 'NETWORK' };
  f.changeAddress = async (name, ip) => { assert.equal(name, 'a'); assert.equal(ip, '1.1.1.1'); recovered = true; };
  const rows = await certifyNodes([{ ...nodes[0], candidates: [...nodes[0].candidates, { address: '1.1.1.1' }] }], f);
  assert.equal(rows[0].passedRounds, 3); assert.equal(rows[0].address, '1.1.1.1'); assert.equal(rows[0].retries, 1);
});
test('an exit changing between rounds is not treated as a stable independent exit', async () => {
  const f = fixture(), base = f.query; let round = 0;
  f.onRound = () => round++;
  f.query = async url => { const r = await base(url); if (round && url.includes('/zone')) r.data.addr = '1.1.1.1'; return r; };
  const rows = await certifyNodes(nodes, f);
  assert.ok(rows.every(row => row.reason === 'EXIT_CHANGED')); assert.equal(chooseHealthy(rows).ok, false);
});
test('a banned shared exit also excludes another node with the same exit', async () => {
  const f = fixture(), rows = await certifyNodes(nodes, f);
  rows[3].exit = rows[0].exit; rows[3].reason = 'BANNED';
  assert.equal(chooseHealthy(rows).ok, false);
});
test('health output identifies nodes by index and omits names, endpoints, domains and exits', async () => {
  const rows = await certifyNodes(nodes, fixture()), selection = chooseHealthy(rows);
  const output = JSON.stringify(safeSummary(rows, selection.selected));
  for (const node of nodes) { assert.equal(output.includes(node.server), false); assert.equal(output.includes(node.candidates[0].address), false); }
  for (const row of rows) assert.equal(output.includes(row.exit), false);
  assert.equal(safeSummary(rows, selection.selected).filter(row => row.selected).length, 4);
});
test('healthy recent scanner queries permit monitoring without interrupting scanning', () => {
  const now = 10000000;
  const state = { now, nodes: [1, 2, 3].map(index => ({ index, requests: 100, successRate: 0.95,
    latestSuccess: now - 10000 })), selected: [1, 2, 3], lastFullCheckAt: now - 30 * 60000,
    configMatches: true, scannerActive: true };
  assert.equal(monitoringIsEnough(state), true);
  assert.equal(monitoringIsEnough({ ...state, configMatches: false }), false);
  assert.equal(monitoringIsEnough({ ...state, scannerActive: false }), false);
  assert.equal(monitoringIsEnough({ ...state, lastFullCheckAt: now - 60 * 60000 }), false);
  assert.equal(monitoringIsEnough({ ...state, selected: [1, 2] }), false);
  state.nodes[2].latestSuccess = now - 6 * 60000;
  assert.equal(monitoringIsEnough(state), false);
  state.nodes[2].latestSuccess = now - 10000; state.nodes[2].successRate = 0.8;
  assert.equal(monitoringIsEnough(state), false);
});

test('expanded candidate pool selects at most eight distinct healthy exits and keeps shared exits out', () => {
  const rows = Array.from({length:12},(_,i)=>({name:'candidate-'+i,exit:'9.9.9.'+(i+1),passedRounds:3,
    networkFailures:0,requests:6,elapsedMs:6}));
  rows[11].exit = rows[0].exit;
  const selected = chooseHealthy(rows,{maximum:8});
  assert.equal(selected.selected.length,8);
  assert.equal(new Set(selected.selected.map(row=>row.exit)).size,8);
  assert.throws(()=>chooseHealthy(rows,{maximum:9}));
  assert.equal(chooseHealthy(rows.slice(0,7),{minimum:8,maximum:8}).ok,false);
});

test('a continuously verified fast reserve replaces a much slower incumbent despite one recovered network request', () => {
  const rows = Array.from({ length: 9 }, (_, i) => ({ index: i + 1, name: 'n' + i, exit: '9.9.9.' + (i + 1),
    passedRounds: 3, networkFailures: 0, requests: 6, validRequests: 6, elapsedMs: 6000 }));
  rows[7].elapsedMs = 24000;
  rows[8].requests = 7; rows[8].networkFailures = 1; rows[8].elapsedMs = 8400;
  const result = chooseHealthy(rows, { maximum: 8, preferred: rows.slice(0, 8).map(r => r.name) });
  assert.ok(result.selected.includes(rows[8]));
  assert.ok(!result.selected.includes(rows[7]));
  assert.equal(result.selected.length, 8);
  assert.equal(result.selectionPolicy, 'EXPECTED_SUCCESS_LATENCY');
});

test('small speed differences retain incumbents and failed or duplicate exits still cannot add capacity', () => {
  const rows = Array.from({ length: 10 }, (_, i) => ({ index: i + 1, name: 'n' + i, exit: '9.9.9.' + (i + 1),
    passedRounds: 3, networkFailures: 0, requests: 6, validRequests: 6, elapsedMs: 6000 }));
  rows[8].elapsedMs = 5400;
  rows[9].elapsedMs = 100; rows[9].passedRounds = 2;
  const options = { maximum: 8, preferred: rows.slice(0, 8).map(r => r.name) };
  assert.ok(!chooseHealthy(rows, options).selected.includes(rows[8]));
  assert.ok(!chooseHealthy(rows, options).selected.includes(rows[9]));
  rows[8].elapsedMs = 4000; rows[8].exit = rows[0].exit;
  const result = chooseHealthy(rows, options);
  assert.equal(result.distinctExits, 8);
  assert.equal(result.selected.filter(r => r.exit === rows[0].exit).length, 1);
});

test('recent production latency and success rate override probes only for the same measured exit', () => {
  const observedAt = 10000000;
  const row = { index: 1, name: 'one', exit: '9.9.9.1', requests: 6, validRequests: 6, elapsedMs: 24000 };
  const runtime = [{ index: 1, exit: row.exit, requests: 100, successRate: .95,
    meanRequestMs: 950, latestSuccess: observedAt - 1000 }];
  assert.equal(selectionCost(row, { runtime, observedAt }).ms, 1000);
  assert.equal(selectionCost(row, { runtime, observedAt }).basis, 'RECENT_PRODUCTION');
  for (const sample of [{ ...runtime[0], exit: '9.9.9.2' }, { ...runtime[0], requests: 19 },
    { ...runtime[0], latestSuccess: observedAt - 300000 }, { ...runtime[0], latestSuccess: observedAt + 1 }]) {
    assert.equal(selectionCost(row, { runtime: [sample], observedAt }).ms, 4000);
  }
  assert.equal(selectionCost(row, { runtime: [{ ...runtime[0], successRate: .5 }], observedAt }).ms, 1900);
});

test('selection diagnostics contain only indexes, estimated latency and measurement basis', () => {
  const row = { index: 1, name: 'private-name', exit: '9.9.9.1', passedRounds: 3,
    requests: 6, validRequests: 6, networkFailures: 0, elapsedMs: 6000 };
  const ranking = JSON.stringify(chooseHealthy([row]).ranking);
  assert.ok(!ranking.includes(row.name)); assert.ok(!ranking.includes(row.exit));
});
