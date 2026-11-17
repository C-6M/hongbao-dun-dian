'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const sourcePath = path.resolve(__dirname, '../core/spider.js');
const localRequire = createRequire(sourcePath);
const source = fs.readFileSync(sourcePath, 'utf8');
const { HistoryStore } = require('../core/history-store');
const stores = [];
test.after(() => { for (const store of stores) store.close(); });

function scanner(reply = () => ({ code: 0, data: { lot_info: [] } }), rankReply = () => ({ code: 0, data: { list: [] } }), env = {}) {
  const store = new HistoryStore(':memory:');
  store.startRun({ test: true }); stores.push(store);
  let time = Date.parse('2026-11-06T12:00:00+08:00');
  class Clock extends Date { static now() { return time; } }
  const files = new Map();
  const calls = [];
  const logs = [];
  const aliveProcesses = new Set();
  const transports = [];
  const desktopCalls = [];
  let desktopError = null;
  const fakeFs = {
    writeFileSync(file, data, options) {
      if (options?.flag === 'wx' && files.has(file)) throw Object.assign(new Error('Fixture exists'), { code: 'EEXIST' });
      files.set(file, data);
    },
    readFileSync(file) { if (!files.has(file)) throw Object.assign(new Error('Missing fixture: ' + file), { code: 'ENOENT' }); return files.get(file); },
    renameSync(from, to) { files.set(to, files.get(from)); files.delete(from); },
    unlinkSync(file) { files.delete(file); },
  };
  function fakeReply(url) {
    calls.push(url);
    let result = url.includes('/zone') ? sandbox.zoneReply ? sandbox.zoneReply(url) : { code: 0, data: { addr: sandbox.exitIp || '192.0.2.1' } }
      : url.includes('/rank/getHotRankV3') ? rankReply(url) : reply(url);
    return typeof result === 'string' ? result : JSON.stringify(result) + '\n###200';
  }
  const fakeChild = { execFile(file, args, options, callback) {
    const text = fakeReply(args.at(-1));
    setImmediate(() => callback(null, text));
  } };
  const sandbox = { require(name) {
    if (name === './http-transport') return { createProxyTransport(options) {
      const transport = { options, closed: false, async request(url) {
        const stdout = fakeReply(url);
        await new Promise(resolve => setImmediate(resolve));
        return { err: null, stdout };
      }, close() { this.closed = true; } };
      transports.push(transport); return transport;
    } };
    if (name === './notifications') return { ...localRequire(name), sendDesktop(payload) {
      desktopCalls.push(payload);
      return desktopError ? Promise.reject(desktopError) : Promise.resolve({ submitted: true });
    } };
    return name === 'fs' ? fakeFs : name === 'child_process' ? fakeChild : localRequire(name);
  },
    module: {}, __dirname: path.dirname(sourcePath), Date: Clock, testHistoryStore: store,
    process: { env: { ...env }, pid: 12345, argv: ['node', sourcePath], on() {},
      kill(pid) { if (!aliveProcesses.has(pid)) throw Object.assign(new Error('Fixture process exited'), { code: 'ESRCH' }); } },
    console: { log(...args) { logs.push(args.join(' ')); }, error() {} },
    setTimeout, clearTimeout, setInterval, clearInterval, AbortController, AbortSignal,
    fetch() { throw new Error('Offline test attempted network access'); } };
  vm.createContext(sandbox);
  vm.runInContext(source + `\nhistoryStore = testHistoryStore; CFG.delayMs = 0; CFG.hotIntervalMs = 0; switchNode = async () => {};
    CFG.spreadNodeBudget = false;
    CFG.pooledHttp = false; CFG.roomAudience = false;
    globalThis.api = { CFG, state, nodeState, activeRP, activeAnchor, runRound, acceptRedpockets,
      acceptAnchor, restoreState, restoreBatteryValues, loadPool, savePool, writeState, pickNode, startDiscovery, stop, queueNotification,
      loadNodes, syncNotificationSettings, syncScanSettings, initializeHistoricalSources, restoreNodeLatencies,
      main, acquireLock, releaseLock, clash, readClashSecret, get clashApi() { return CLASH_API; },
      get pendingNotifications() { return pendingNotifications; },
      get discoveryTask() { return discoveryTask; },
      get pool() { return pool; },
      get restartPriority() { return restartPriority; },
      setRooms(count) { pool = new Map(); for (let i = 0; i < count; i++) strategy.ensureRoom(pool, String(1000 + i), now()); },
      addNodes(count) { for (let i = 0; i < count; i++) nodeState.set('node' + i,
        { used: 0, bannedUntil: 0, lastIp: '', totalUsed: 0, totalRequests: 0, lastUsedAt: 0 }); }
    };`, sandbox);
  function setNotificationSettings(settings) {
    files.set(sandbox.api.CFG.notificationSettingsFile, JSON.stringify({ ...localRequire('./notification-settings').DEFAULTS, ...settings }));
  }
  setNotificationSettings({ enabled: false });
  function setScanSettings(enabled) {
    files.set(sandbox.api.CFG.scanSettingsFile, JSON.stringify({ enabled }));
  }
  return { api: sandbox.api, store, calls, logs, aliveProcesses, transports, desktopCalls, files, sandbox, setNotificationSettings, setScanSettings, advance(ms) { time += ms; },
    setDesktopError(error) { desktopError = error; } };
}

test('controller credentials use the environment or ignored local configuration', () => {
  const s = scanner();
  const file = path.resolve(__dirname, '../data/scanner-local-config.json');
  assert.equal(s.api.CFG.clashSecret, '');
  assert.equal(s.api.readClashSecret(), '');
  s.files.set(file, JSON.stringify({ clashSecret: 'local-test-secret' }));
  assert.equal(s.api.readClashSecret(), 'local-test-secret');
  s.sandbox.process.env.SCANNER_CLASH_SECRET = 'env-test-secret';
  assert.equal(s.api.readClashSecret(), 'env-test-secret');
  s.sandbox.process.env.SCANNER_CLASH_SECRET = '';
  assert.equal(s.api.readClashSecret(), '');
  const env = scanner(undefined, undefined, { SCANNER_CLASH_SECRET: 'env-test-secret' });
  assert.equal(env.api.CFG.clashSecret, 'env-test-secret');
});

test('invalid local controller credentials fail without disclosing their contents', () => {
  const s = scanner();
  const file = path.resolve(__dirname, '../data/scanner-local-config.json');
  for (const content of ['{private-test-secret', 'null', '{"clashSecret":123}', '{}']) {
    s.files.set(file, content);
    assert.throws(() => s.api.readClashSecret(), error => {
      assert.match(error.message, /scanner-local-config\.json/);
      assert.doesNotMatch(error.message, /private-test-secret|123/);
      return true;
    });
  }
});

test('duplicate normal starts reuse the existing scanner without requests or state writes', async () => {
  const s = scanner();
  s.aliveProcesses.add(54321);
  s.files.set(s.api.CFG.lockFile, JSON.stringify({ pid: 54321, startedAt: s.sandbox.Date.now() }));
  s.files.set(s.api.CFG.stateFile, 'existing scanner state');
  s.files.set(s.api.CFG.poolFile, 'existing room pool');
  const before = new Map(s.files);
  await s.api.main();
  await s.api.main();
  assert.deepEqual(s.files, before);
  assert.equal(s.calls.length, 0);
  assert.equal(s.store.summary().requests.total, 0);
  assert.equal(s.logs.filter(message => message.includes('54321')).length, 2);
});

test('bounded starts still require ownership while stop commands reach the existing scanner', async () => {
  const s = scanner();
  s.aliveProcesses.add(54321);
  const lock = JSON.stringify({ pid: 54321, startedAt: s.sandbox.Date.now() });
  s.files.set(s.api.CFG.lockFile, lock);
  for (const args of [['--once'], ['--rounds', '1']]) {
    s.sandbox.process.argv = ['node', sourcePath, ...args];
    await assert.rejects(s.api.main(), /54321/);
    assert.equal(s.files.get(s.api.CFG.lockFile), lock);
  }
  s.sandbox.process.argv = ['node', sourcePath, '--stop'];
  await s.api.main();
  assert.deepEqual(JSON.parse(s.files.get(s.api.CFG.lockFile + '.stop')), { pid: 54321 });
  assert.equal(s.files.get(s.api.CFG.lockFile), lock);
  assert.equal(s.calls.length, 0);
});

test('dead scanner locks can be acquired while malformed locks and other owners are preserved', () => {
  const s = scanner();
  for (const invalid of ['{broken', 'null', '{"pid":0}', '{"pid":"54321"}']) {
    s.files.set(s.api.CFG.lockFile, invalid);
    assert.throws(() => s.api.acquireLock({ reuseRunning: true }));
    assert.equal(s.files.get(s.api.CFG.lockFile), invalid);
  }
  s.files.set(s.api.CFG.lockFile, JSON.stringify({ pid: 54321 }));
  s.api.releaseLock();
  assert.ok(s.files.has(s.api.CFG.lockFile));
  assert.equal(s.api.acquireLock({ reuseRunning: true }), true);
  assert.equal(JSON.parse(s.files.get(s.api.CFG.lockFile)).pid, 12345);
  s.api.releaseLock();
  assert.ok(!s.files.has(s.api.CFG.lockFile));
});

function changedControllerScanner() {
  const s = scanner(undefined, undefined, { USERPROFILE: 'C:/Users/scanner-test' });
  const file = path.join(s.sandbox.process.env.USERPROFILE, 'Downloads', 'Clash.for.Windows-0.20.16.4-ikuuu',
    'Clash.for.Windows-0.20.16-ikuuu', 'data', 'config.yaml');
  s.files.set(file, 'external-controller: 127.0.0.1:7158\n');
  vm.runInContext('CLASH_API = "http://127.0.0.1:9090";', s.sandbox);
  return s;
}

test('controller transport failure reloads the changed port and retains it for later controls', async () => {
  const s = changedControllerScanner(), controls = [];
  s.sandbox.fetch = async (url, options) => {
    controls.push({ url, method: options.method || 'GET', body: options.body });
    if (url.startsWith('http://127.0.0.1:9090/')) throw new TypeError('fetch failed');
    assert.ok(url.startsWith('http://127.0.0.1:7158/'));
    return { ok: true, status: options.method === 'PUT' ? 204 : 200, text: async () => '{}' };
  };
  assert.equal((await s.api.clash('/proxies')).status, 200);
  const body = JSON.stringify({ name: 'node0' });
  assert.equal((await s.api.clash('/proxies/test-group', { method: 'PUT', body })).status, 204);
  assert.deepEqual(controls.map(c => c.url), ['http://127.0.0.1:9090/proxies',
    'http://127.0.0.1:7158/version', 'http://127.0.0.1:7158/proxies', 'http://127.0.0.1:7158/proxies/test-group']);
  assert.equal(controls.at(-1).body, body);
  assert.equal(controls.at(-1).method, 'PUT');
  assert.equal(s.api.clashApi, 'http://127.0.0.1:7158');
  assert.equal(s.calls.length, 0);
});

test('a failed request at the rediscovered controller is not retried in a loop', async () => {
  const s = changedControllerScanner(), controls = [];
  s.sandbox.fetch = async url => {
    controls.push(url);
    if (url.endsWith('/version')) return { ok: true };
    throw new TypeError('fetch failed');
  };
  await assert.rejects(s.api.clash('/proxies'), /fetch failed/);
  assert.deepEqual(controls, ['http://127.0.0.1:9090/proxies',
    'http://127.0.0.1:7158/version', 'http://127.0.0.1:7158/proxies']);
});

test('controller HTTP refusals do not trigger rediscovery or request replay', async () => {
  const s = changedControllerScanner(), controls = [];
  s.sandbox.fetch = async url => {
    controls.push(url);
    return { status: 401, text: async () => 'unauthorized' };
  };
  assert.equal((await s.api.clash('/proxies')).status, 401);
  assert.deepEqual(controls, ['http://127.0.0.1:9090/proxies']);
  assert.equal(s.api.clashApi, 'http://127.0.0.1:9090');
});

test('stopping cancels controller requests without rediscovering another port', async () => {
  const s = changedControllerScanner(), controls = [];
  s.sandbox.fetch = async (url, options) => {
    controls.push(url);
    s.api.stop();
    assert.equal(options.signal.aborted, true);
    throw new Error('controller request stopped');
  };
  await assert.rejects(s.api.clash('/proxies'), /controller request stopped/);
  assert.deepEqual(controls, ['http://127.0.0.1:9090/proxies']);
});

function seedHistoricalSource(s, room = '1000') {
  const t = Date.parse('2026-11-06T12:00:00+08:00');
  for (let i = 0; i < 3; i++) {
    const foundAt = t - (i < 2 ? 86400000 : 2 * 86400000) + i * 1000;
    const meta = { kind: 'rp', roomId: room, tier: 'COLD', startedAt: foundAt - 100 };
    const request = s.store.beginRequest(meta);
    s.store.completeRequest(request, meta, { status: 'OK', code: 0, data: { lot_info: [{
      lot_id: 8000 + i, join_requirement: 1, total_price: 10000,
      awards: [{ gift_name: '电池红包', num: 10 }], end_time: foundAt / 1000 + 600,
    }] } }, foundAt);
  }
}

function savedPriorityScanner(count = 2) {
  const previous = scanner(); previous.api.setRooms(500);
  const time = previous.sandbox.Date.now();
  for (let i = 0; i < count; i++) {
    const room = previous.api.pool.get(String(1000 + i));
    if (i < Math.max(1, Math.floor(count / 10))) room.lastBatteryHit = time;
    else room.qqLastAt = time;
  }
  previous.api.savePool();
  const next = scanner(); next.advance(3 * 86400000);
  next.files.set(next.api.CFG.poolFile, previous.files.get(previous.api.CFG.poolFile));
  next.api.loadPool(); next.api.addNodes(8);
  return next;
}

test('restart scans saved HOT/WARM once after downtime and the next round uses current COLD tiers', async () => {
  const s = savedPriorityScanner();
  const originalHit = s.api.pool.get('1000').lastBatteryHit;
  await s.api.runRound(1, [...s.api.nodeState.keys()]);
  const requests = s.store.db.prepare("SELECT room_id, tier FROM requests WHERE room_id IN ('1000', '1001')").all();
  assert.deepEqual(requests.map(r => [r.room_id, r.tier]).sort(), [['1000', 'HOT'], ['1001', 'WARM']]);
  assert.equal(s.api.state.restartPriority.active, false);
  assert.equal(s.api.state.restartPriority.checked, 2);
  assert.equal(s.api.restartPriority.size, 0);
  assert.equal(s.api.pool.get('1000').lastBatteryHit, originalHit);
  assert.equal(s.desktopCalls.length, 0);
  s.advance(200000); s.sandbox.exitIp = '192.0.2.2';
  await s.api.runRound(2, [...s.api.nodeState.keys()]);
  const normal = s.store.db.prepare("SELECT tier FROM requests WHERE kind='rp' AND round=2").all();
  assert.ok(normal.length > 0 && normal.every(r => r.tier === 'COLD'));
  assert.equal(s.api.state.quota.hot, 0);
  assert.equal(s.api.state.quota.warm, 0);
});

test('an interrupted priority pass saves the remaining rooms and restores them on another restart', async () => {
  const s = savedPriorityScanner(300);
  await s.api.runRound(1, [...s.api.nodeState.keys()]);
  assert.ok(s.api.restartPriority.size > 0 && s.api.restartPriority.size < 300);
  const remaining = new Set(s.api.restartPriority.keys());
  const next = scanner(); next.advance(3 * 86400000 + 10000);
  next.files.set(next.api.CFG.poolFile, s.files.get(s.api.CFG.poolFile));
  next.api.loadPool();
  assert.deepEqual(new Set(next.api.restartPriority.keys()), remaining);
  assert.ok(s.api.state.quota.planned + s.api.state.quota.ipReserve <= 110);
});

test('pausing preserves the restart pass and a blocked saved room is skipped without a request', async () => {
  const s = savedPriorityScanner();
  s.setScanSettings(false);
  await s.api.runRound(1, [...s.api.nodeState.keys()]);
  assert.equal(s.api.restartPriority.size, 2);
  assert.equal(s.calls.length, 0);
  s.files.set(s.api.CFG.roomBlocklistFile, JSON.stringify({ rooms: ['1000'] }));
  s.setScanSettings(true);
  await s.api.runRound(1, [...s.api.nodeState.keys()]);
  assert.equal(s.api.state.restartPriority.checked, 1);
  assert.equal(s.api.state.restartPriority.skipped, 1);
  assert.equal(s.store.db.prepare("SELECT COUNT(*) n FROM requests WHERE room_id='1000'").get().n, 0);
});

test('historical manifest persists once and restarts keep membership, attempts and empty backoff', () => {
  const s = scanner(); s.api.setRooms(200); seedHistoricalSource(s);
  const r = s.api.pool.get('1000'); r.lastAttempt = Date.parse('2026-11-06T11:50:00+08:00');
  r.historicalEmptyScans = 4;
  const manifest = s.api.initializeHistoricalSources();
  assert.equal(manifest.candidates.length, 1);
  const saved = s.files.get(s.api.CFG.historicalFile);
  s.advance(10000); s.api.initializeHistoricalSources();
  assert.equal(s.files.get(s.api.CFG.historicalFile), saved);
  assert.equal(r.historicalEmptyScans, 4);
  assert.equal(r.lastAttempt, Date.parse('2026-11-06T11:50:00+08:00'));
  s.api.savePool();
  const next = scanner();
  next.advance(10000);
  next.files.set(next.api.CFG.poolFile, s.files.get(s.api.CFG.poolFile));
  next.files.set(next.api.CFG.historicalFile, saved);
  vm.runInContext('loadPool();', next.sandbox);
  next.api.initializeHistoricalSources();
  assert.equal(next.api.pool.get('1000').historicalEmptyScans, 4);
  assert.equal(next.api.pool.get('1000').lastAttempt, r.lastAttempt);
  assert.equal(next.api.state.historical.manifestHash, s.api.state.historical.manifestHash);
  assert.equal(next.desktopCalls.length, 0);
});

test('concurrent pool cleanup skips a queued room and does not crash on an in-flight room error', async () => {
  let s, cleaned = false, inFlightRoom, removedRooms;
  s = scanner(url => {
    if (url.includes('RedPocketGetInfo') && !cleaned) {
      cleaned = true;
      inFlightRoom = new URL(url).searchParams.get('room_id');
      removedRooms = s.api.state.watchlist.map(r => r.room).filter(id => id !== inFlightRoom).slice(0, 2);
      s.api.pool.delete(inFlightRoom);
      for (const id of removedRooms) s.api.pool.delete(id);
      return 'network reset\n###000';
    }
    return { code: 0, data: { lot_info: [] } };
  });
  s.api.setRooms(300); s.api.addNodes(3);
  await s.api.runRound(1, ['node0', 'node1', 'node2']);
  assert.ok(cleaned);
  for (const id of removedRooms) assert.equal(s.store.db.prepare('SELECT COUNT(*) n FROM requests WHERE room_id=?').get(id).n, 0);
  assert.equal(s.store.db.prepare('SELECT COUNT(*) n FROM requests WHERE room_id=?').get(inFlightRoom).n, 1);
  assert.ok(s.api.state.progress.scanned > 0);
  assert.ok(s.api.nodeState.get('node0').used <= 110);
});

test('historical source blocked at restart resumes after live unblocking without changing its manifest', () => {
  const s = scanner(); s.api.setRooms(200); seedHistoricalSource(s);
  s.api.initializeHistoricalSources();
  const saved = s.files.get(s.api.CFG.historicalFile);
  s.files.set(s.api.CFG.roomBlocklistFile, JSON.stringify({ rooms: ['1000'] }));
  s.api.syncScanSettings(); s.api.initializeHistoricalSources();
  assert.equal(s.api.pool.get('1000').historicalSource, undefined);
  s.files.set(s.api.CFG.roomBlocklistFile, JSON.stringify({ rooms: [] }));
  s.api.syncScanSettings();
  assert.ok(s.api.pool.get('1000').historicalSource);
  assert.equal(s.files.get(s.api.CFG.historicalFile), saved);
  assert.equal(s.calls.length, 0);
});

test('historical requests have their own durable tier and do not replace ordinary exploration', async () => {
  const s = scanner(); s.api.setRooms(300); s.api.addNodes(3); seedHistoricalSource(s);
  s.api.initializeHistoricalSources();
  const r = s.api.pool.get('1000');
  r.lastListedAt = Date.parse('2026-11-06T12:00:00+08:00');
  await s.api.runRound(1, ['node0', 'node1', 'node2']);
  const requests = s.store.db.prepare("SELECT room_id,tier FROM requests WHERE kind='rp' AND started_at>=? ORDER BY id")
    .all(Date.parse('2026-11-06T12:00:00+08:00'));
  assert.equal(requests.length, 109);
  assert.equal(requests.filter(q => q.tier === 'COLD_HISTORY').length, 1);
  assert.equal(requests.find(q => q.room_id === '1000').tier, 'COLD_HISTORY');
  assert.ok(requests.filter(q => q.tier === 'COLD').length >= Math.ceil(109 * .3));
  assert.equal(s.api.state.quota.historical, 1);
  assert.equal(s.api.state.historical.requests, 1);
  assert.ok(r.historicalLastProbeAt > 0);
  s.setScanSettings(false);
  const count = s.calls.length;
  s.advance(300000);
  await s.api.runRound(2, ['node0', 'node1', 'node2']);
  assert.equal(s.calls.length, count);
  s.files.set(s.api.CFG.roomBlocklistFile, JSON.stringify({ rooms: ['1000'] }));
  s.setScanSettings(true); s.sandbox.exitIp = '192.0.2.2';
  await s.api.runRound(3, ['node0', 'node1', 'node2']);
  assert.equal(s.store.db.prepare("SELECT COUNT(*) n FROM requests WHERE room_id='1000' AND tier='COLD_HISTORY'").get().n, 1);
  assert.equal(s.api.state.historical.active, 0);
});

test('historical invalid or unsaved manifests stop before external requests and preserve source files', () => {
  for (const corrupt of [true, false]) {
    const s = scanner(); s.api.setRooms(2); seedHistoricalSource(s);
    if (corrupt) s.files.set(s.api.CFG.historicalFile, '{bad-json');
    else vm.runInContext("fs.renameSync = () => { throw new Error('manifest save failed'); };", s.sandbox);
    assert.throws(() => s.api.initializeHistoricalSources(), /历史来源名单读取失败|manifest save failed/);
    assert.ok(s.api.state.storage.error);
    assert.equal(s.calls.length, 0);
    assert.equal(s.api.pool.get('1000').historicalSource, undefined);
    if (corrupt) assert.equal(s.files.get(s.api.CFG.historicalFile), '{bad-json');
    else assert.equal(s.files.has(s.api.CFG.historicalFile), false);
  }
});

test('historical probes count only successful empties while errors do not trigger the backoff', async () => {
  let error = true;
  const s = scanner(url => ({ code: error && url.endsWith('room_id=1000') ? -1 : 0, data: { lot_info: [] } }));
  s.api.setRooms(300); s.api.addNodes(3); seedHistoricalSource(s); s.api.initializeHistoricalSources();
  await s.api.runRound(1, ['node0', 'node1', 'node2']);
  assert.equal(s.api.pool.get('1000').historicalEmptyScans || 0, 0);
  assert.equal(s.api.pool.get('1000').scanErrors, 1);
  error = false; s.advance(900000); s.sandbox.exitIp = '192.0.2.2';
  await s.api.runRound(2, ['node0', 'node1', 'node2']);
  assert.equal(s.api.pool.get('1000').historicalEmptyScans, 1);
});

test('blocked rooms create no redpocket or historical anchor requests and remain blocked after restart', async () => {
  for (let run = 0; run < 2; run++) {
    const s = scanner(); s.api.setRooms(200); s.api.addNodes(3);
    s.files.set(s.api.CFG.roomBlocklistFile, JSON.stringify({ rooms: ['1000'] }));
    s.api.pool.get('1000').lastBatteryHit = Date.parse('2026-11-06T12:00:00+08:00');
    s.api.pool.get('1000').anchorHits = 3;
    await s.api.runRound(12, ['node0', 'node1', 'node2']);
    assert.equal(s.store.db.prepare("SELECT COUNT(*) AS n FROM requests WHERE room_id='1000'").get().n, 0);
    assert.equal(s.api.nodeState.get('node0').used, 110);
    assert.equal(s.api.pool.get('1000').anchorHits, 3);
    assert.deepEqual([...s.api.state.blocklist.rooms], ['1000']);
  }
});

test('a live blocklist update skips queued rooms without fake requests or exceeding the actual priority cap', async () => {
  let blocked = false;
  const s = scanner(url => {
    if (!blocked && url.includes('RedPocketGetInfo')) {
      blocked = true;
      s.files.set(s.api.CFG.roomBlocklistFile, JSON.stringify({
        rooms: Array.from({ length: 50 }, (_, i) => String(1101 + i)),
      }));
    }
    return { code: 0, data: { lot_info: [] } };
  });
  s.api.setRooms(500); s.api.addNodes(3);
  const at = Date.parse('2026-11-06T12:00:00+08:00');
  for (let i = 0; i < 100; i++) s.api.pool.get(String(1000 + i)).listingPriority = { at, rank: 1, online: i };
  await s.api.runRound(1, ['node0', 'node1', 'node2']);
  const rows = s.store.db.prepare("SELECT room_id,tier FROM requests WHERE kind='rp' ORDER BY id").all();
  assert.ok(rows.length > 1 && rows.length < 109);
  let priority = 0;
  rows.forEach((r, i) => {
    assert.ok(!s.api.state.blocklist.rooms.includes(r.room_id));
    if (r.tier === 'COLD_PRIORITY') priority++;
    assert.ok(priority <= (i + 1) * .2, 'actual priority share exceeded after blocked ordinary rooms were skipped');
  });
  assert.ok(priority > 0);
  assert.equal(s.api.state.stats.errors, 0);
  assert.equal(s.store.summary().requests.total, s.calls.length);
});

test('blocking removes current rewards and QQ/watchlist display while retaining historical evidence', () => {
  const s = scanner(); s.api.setRooms(1);
  s.api.state.stats.byTier.COLD = { batteryHits: 0 };
  const lot = { lot_id: 888, end_time: Date.parse('2026-11-06T12:10:00+08:00') / 1000,
    total_price: 10000, awards: [{ gift_name: '电池红包', num: 10 }] };
  s.api.acceptRedpockets('1000', [lot], 'COLD');
  s.api.acceptAnchor('1000', { id: 889, time: 300 });
  s.api.pool.get('1000').qqPushes = 2;
  s.api.state.watchlist = [{ room: '1000' }];
  vm.runInContext("recentRP.set('890', {lid:890,room_id:'1000',expiredAt:Date.now()});", s.sandbox);
  const historyLength = s.api.state.history.length;
  s.files.set(s.api.CFG.roomBlocklistFile, JSON.stringify({ rooms: ['1000'] }));
  s.api.writeState();
  const published = JSON.parse(s.files.get(s.api.CFG.stateFile));
  for (const field of ['redpockets', 'anchors', 'expired', 'watchlist']) assert.equal(published[field].length, 0);
  assert.equal(published.qq.topSources.length, 0);
  assert.equal(published.history.length, historyLength);
  assert.equal(s.api.acceptRedpockets('1000', [{ ...lot, lot_id: 891 }], 'COLD'), 0);
  s.api.acceptAnchor('1000', { id: 892, time: 300 });
  assert.equal(s.api.pool.get('1000').batteryHits, 1);
  assert.equal(s.api.pool.get('1000').anchorHits, 1);
});

test('blocking cancels an unsent notification and removes its reservation', async () => {
  const s = scanner(); s.setNotificationSettings({ enabled: true });
  const packet = { lid: 893, room_id: '1000', award_name: '电池红包', battery: 100, award_num: 10,
    end_time: Date.parse('2026-11-06T12:10:00+08:00') / 1000 };
  assert.equal(s.api.queueNotification(packet), true);
  s.files.set(s.api.CFG.roomBlocklistFile, JSON.stringify({ rooms: ['1000'] }));
  await Promise.all(s.api.pendingNotifications);
  assert.equal(s.desktopCalls.length, 0);
  assert.equal(s.api.state.notifications.notified.length, 0);
  assert.equal(s.api.queueNotification(packet), false);
});

test('invalid blocklist preserves last valid rooms, pauses scans, and recovers without changing the saved switch', () => {
  const s = scanner(); s.setScanSettings(true);
  s.files.set(s.api.CFG.roomBlocklistFile, JSON.stringify({ rooms: ['1000'] }));
  assert.equal(s.api.syncScanSettings(), true);
  s.files.set(s.api.CFG.roomBlocklistFile, '{broken');
  assert.equal(s.api.syncScanSettings(), false);
  assert.deepEqual([...s.api.state.blocklist.rooms], ['1000']);
  assert.ok(s.api.state.blocklist.error);
  assert.equal(JSON.parse(s.files.get(s.api.CFG.scanSettingsFile)).enabled, true);
  s.files.set(s.api.CFG.roomBlocklistFile, JSON.stringify({ rooms: [] }));
  assert.equal(s.api.syncScanSettings(), true);
  assert.equal(s.api.state.blocklist.error, '');
});

test('pause blocks main scans and discovery without creating fake request records; resume keeps the same pool', async () => {
  const s = scanner(); s.api.setRooms(200); s.api.addNodes(3);
  const pool = s.api.pool;
  s.setScanSettings(false);
  await s.api.runRound(1, ['node0', 'node1', 'node2']);
  s.api.startDiscovery();
  assert.equal(s.api.state.phase, 'paused');
  assert.equal(s.api.discoveryTask, null);
  assert.equal(s.calls.length, 0);
  assert.equal(s.store.summary().requests.total, 0);
  s.setScanSettings(true);
  await s.api.runRound(1, ['node0', 'node1', 'node2']);
  assert.equal(s.api.pool, pool);
  assert.equal(s.api.state.stats.scanned, 109);
  assert.equal(s.api.state.scan.inFlight, 0);
  assert.equal(s.api.state.phase, 'sleeping');
});

test('pausing during a round drains sent requests into history and prevents queued requests and anchors', async () => {
  const s = scanner(() => {
    s.setScanSettings(false);
    return { code: 0, data: { lot_info: [] } };
  });
  s.api.setRooms(200); s.api.addNodes(3);
  await s.api.runRound(12, ['node0', 'node1', 'node2']);
  assert.equal(s.calls.length, 2); // One exit check and the already dispatched redpocket request.
  assert.equal(s.api.state.phase, 'paused');
  assert.equal(s.api.state.scan.inFlight, 0);
  assert.equal(s.api.state.stats.scanned, 1);
  assert.equal(s.api.state.stats.errors, 0);
  assert.equal(s.store.summary().requests.total, 2);
  assert.equal(s.store.query('requests', { outcome: 'pending' }).items.length, 0);
  assert.equal(s.store.query('requests', { outcome: 'empty' }).items.length, 1);
  assert.ok(s.calls.every(url => !url.includes('/Anchor/')));
});

test('pausing an active discovery batch stops subsequent list pages and permits a later batch', async () => {
  let pauseOnce = true;
  const s = scanner(url => {
    if (url.includes('/area/getList')) return { code: 0, data: [{ id: 1, list: [{ id: 2 }] }] };
    if (pauseOnce) { pauseOnce = false; s.setScanSettings(false); }
    return { code: 0, data: [{ roomid: 22222 }] };
  });
  s.api.CFG.discoveryDelayMs = 0;
  s.api.startDiscovery(); await s.api.discoveryTask;
  assert.equal(s.calls.length, 3);
  assert.equal(s.api.state.discovery.running, false);
  assert.equal(s.api.state.discovery.error, '');
  assert.equal(s.api.state.phase, 'paused');
  assert.equal(s.api.pool.has('22222'), true);
  s.setScanSettings(true);
  s.api.startDiscovery(); await s.api.discoveryTask;
  assert.equal(s.calls.length, 5);
  assert.equal(s.api.state.scan.inFlight, 0);
});

test('invalid scan settings pause requests and recover after a valid setting is saved', async () => {
  const s = scanner(); s.api.setRooms(200); s.api.addNodes(3);
  s.files.set(s.api.CFG.scanSettingsFile, '{broken');
  await s.api.runRound(1, ['node0', 'node1', 'node2']);
  assert.equal(s.calls.length, 0);
  assert.ok(s.api.state.scan.settingsError);
  s.setScanSettings(true);
  assert.equal(s.api.syncScanSettings(), true);
  assert.equal(s.api.state.scan.settingsError, '');
  assert.equal(s.api.state.phase, 'idle');
});

test('discovery alternates parent areas at startup without increasing its request budget', async () => {
  const parents = [
    { id: 2, list: Array.from({ length: 115 }, (_, i) => ({ id: 1000 + i })) },
    { id: 3, list: [{ id: 2000 }, { id: 2001 }] },
    { id: 4, list: [] },
    { id: 6, list: [{ id: 3000 }] },
    { id: 1, list: [{ id: 4000 }] },
    { id: 9, list: [{ id: 5000 }] },
  ];
  const s = scanner(url => ({ code: 0, data: url.includes('/area/getList') ? parents : [] }));
  s.api.CFG.discoveryDelayMs = 0;
  s.api.startDiscovery(); await s.api.discoveryTask;
  const pages = s.calls.filter(url => url.includes('/area/getRoomList')).map(url => new URL(url));
  const firstPages = pages.filter(url => url.searchParams.get('page') === '1');
  assert.deepEqual(firstPages.slice(0, 5).map(url => url.searchParams.get('parent_area_id')),
    ['2', '3', '6', '1', '9']);
  assert.equal(firstPages.length, s.api.CFG.discoveryAreaBatch);
  assert.equal(pages.length + s.calls.filter(url => url.includes('/rank/getHotRankV3')).length, 20);
  assert.equal(s.api.state.discovery.error, '');
});

test('discovery rotation covers every child once per cycle across uneven and numerous parents', async () => {
  const parents = Array.from({ length: 12 }, (_, p) => ({ id: p + 1,
    list: Array.from({ length: p === 0 ? 25 : 2 }, (_, i) => ({ id: (p + 1) * 100 + i })) }));
  parents.splice(3, 0, { id: 99 });
  const expected = parents.flatMap(p => (p.list || []).map(a => p.id + ':' + a.id));
  const s = scanner(url => ({ code: 0, data: url.includes('/area/getList') ? parents : [] }));
  s.api.CFG.discoveryDelayMs = 0;
  const visited = [];
  for (let batch = 0; batch < Math.ceil(expected.length / 10); batch++) {
    const before = s.calls.length;
    s.api.startDiscovery(); await s.api.discoveryTask;
    const calls = s.calls.slice(before);
    const pages = calls.filter(url => url.includes('/area/getRoomList')).map(url => new URL(url));
    visited.push(...pages.filter(url => url.searchParams.get('page') === '1')
      .map(url => url.searchParams.get('parent_area_id') + ':' + url.searchParams.get('area_id')));
    assert.ok(pages.length + calls.filter(url => url.includes('/rank/getHotRankV3')).length <= 20);
    assert.equal(s.api.state.discovery.error, '');
    s.advance(61000);
  }
  assert.deepEqual(visited.slice(0, 12).map(key => key.split(':')[0]),
    Array.from({ length: 12 }, (_, i) => String(i + 1)));
  assert.equal(new Set(visited.slice(0, expected.length)).size, expected.length);
  assert.deepEqual(new Set(visited.slice(0, expected.length)), new Set(expected));
  for (const p of parents) assert.deepEqual(visited.slice(0, expected.length).filter(key => key.startsWith(p.id + ':')),
    (p.list || []).map(a => p.id + ':' + a.id));
  assert.equal(visited[expected.length], expected[0]);
});

test('discovery rank feeds real priority scans and their history without changing the node budget', async () => {
  const s=scanner(url=>{
    if(url.includes('/area/getList'))return {code:0,data:[{id:1,list:[{id:2}]}]};
    if(url.includes('/area/getRoomList')) {
      const page=Number(new URL(url).searchParams.get('page'));
      return {code:0,data:Array.from({length:30},(_,i)=>({roomid:1000+(page-1)*30+i,online:500-i}))};
    }
    return {code:0,data:{lot_info:url.endsWith('room_id=1000')?[{
      lot_id:999,end_time:Date.parse('2026-11-06T12:10:00+08:00')/1000,
      total_price:10000,awards:[{gift_name:'电池红包',num:10}],
    }]:[]}};
  });
  s.api.setRooms(200); s.api.addNodes(3); s.api.CFG.discoveryDelayMs=0;
  s.api.startDiscovery();await s.api.discoveryTask;
  assert.equal(s.api.pool.get('1000').listingPriority.rank,1);
  assert.equal(s.api.pool.get('1009').listingPriority.rank,10);
  assert.equal(s.api.pool.get('1010').listingPriority,undefined);
  assert.equal(s.api.pool.get('1030').listingPriority,undefined);
  await s.api.runRound(1,['node0','node1','node2']);
  assert.equal(s.api.state.pool.priority,10);
  assert.equal(s.api.state.quota.priority,10);
  assert.equal(s.api.nodeState.get('node0').used,110);
  assert.equal(s.api.state.stats.byTier.COLD_PRIORITY.requests,10);
  assert.equal(s.api.state.stats.byTier.COLD_PRIORITY.batteryHits,1);
  const requests=s.store.query('requests',{kind:'rp',limit:200}).items;
  assert.equal(requests.filter(r=>r.tier==='COLD_PRIORITY').length,10);
  assert.equal(requests.find(r=>r.room_id==='1000').tier,'COLD_PRIORITY');
  const saved=JSON.parse(s.files.get(s.api.CFG.poolFile));
  assert.equal(saved.rooms['1000'].listingPriority.areaId,2);
  assert.equal(s.api.state.settings.priorityPoolLimit,600);
});

test('global TOP50 discovery replaces one deep page and produces real capped priority requests and durable history', async () => {
  const list = Array.from({ length: 50 }, (_, i) => ({ room_id: 5000 + i, rank: i + 1,
    score: 10000 - i, live_status: 1, parent_area_id: 1, area_id: 2 }));
  list[1].live_status = 0; list[2].room_id = 22748536;
  const s = scanner(url => {
    if (url.includes('/area/getList')) return { code: 0, data: [{ id: 1,
      list: Array.from({ length: 10 }, (_, i) => ({ id: i + 1 })) }] };
    if (url.includes('/area/getRoomList')) {
      const params = new URL(url).searchParams, area = Number(params.get('area_id')), page = Number(params.get('page'));
      return { code: 0, data: Array.from({ length: 30 }, (_, i) => ({ roomid: 90000 + area * 100 + page * 30 + i, online: 100 })) };
    }
    return { code: 0, data: { lot_info: [] } };
  }, () => ({ code: 0, data: { list, countdown: 300, current_room: { room_id: 7777777 }, last_top: [{ room_id: 8888888 }] } }));
  s.api.setRooms(200); s.api.addNodes(3); s.api.CFG.discoveryDelayMs = 0;
  s.files.set(s.api.CFG.roomBlocklistFile, JSON.stringify({ rooms: ['22748536'] }));
  s.api.startDiscovery(); await s.api.discoveryTask;
  const pages = s.calls.filter(url => url.includes('/area/getRoomList')).map(url => new URL(url));
  assert.equal(pages.length, 19);
  assert.equal(pages.filter(url => url.searchParams.get('page') === '1').length, 10);
  assert.equal(s.calls.filter(url => url.includes('/rank/getHotRankV3')).length, 1);
  assert.equal(s.api.state.hotRank.live, 48);
  assert.equal(s.api.state.hotRank.offline, 1);
  assert.equal(s.api.state.hotRank.blocked, 1);
  assert.equal(s.api.pool.has('5001'), false);
  assert.equal(s.api.pool.has('22748536'), false);
  assert.equal(s.api.pool.has('7777777'), false);
  assert.equal(s.api.pool.get('5003').hotRankPriority.rank, 4);
  await s.api.runRound(1, ['node0', 'node1', 'node2']);
  const requests = s.store.query('requests', { kind: 'rp', limit: 200 }).items.reverse();
  let priority = 0;
  requests.forEach((request, index) => {
    if (request.tier === 'COLD_PRIORITY') priority++;
    assert.ok(priority <= (index + 1) * .2);
  });
  assert.equal(requests.length, 109);
  assert.equal(priority, 21);
  assert.equal(s.api.nodeState.get('node0').used, 110);
  assert.ok(requests.some(r => r.tier === 'COLD_PRIORITY' && s.api.pool.get(r.room_id)?.hotRankPriority));
  assert.ok(s.api.state.hotRank.requests > 0);
  assert.ok(s.api.state.hotRank.priorityRequests > 0);
  const rankFetch = s.store.query('requests', { kind: 'discovery', limit: 30 }).items.find(r => r.tier === 'GLOBAL_HOT_RANK');
  assert.equal(rankFetch.outcome, 'ok');
  s.api.savePool();
  assert.equal(JSON.parse(s.files.get(s.api.CFG.poolFile)).rooms['5003'].hotRankPriority.rank, 4);
});

test('the deep page replaced by the global request rotates across all partitions', async () => {
  const s = scanner(url => url.includes('/area/getList')
    ? { code: 0, data: [{ id: 1, list: Array.from({ length: 10 }, (_, i) => ({ id: i + 1 })) }] }
    : { code: 0, data: [] });
  s.api.CFG.discoveryDelayMs = 0;
  const deepAreas = new Set();
  for (let batch = 0; batch < 10; batch++) {
    const before = s.calls.length;
    s.api.startDiscovery(); await s.api.discoveryTask;
    const urls = s.calls.slice(before).filter(url => url.includes('/area/getRoomList')).map(url => new URL(url));
    assert.equal(urls.length, 19);
    assert.equal(urls.filter(url => url.searchParams.get('page') === '1').length, 10);
    urls.filter(url => url.searchParams.get('page') !== '1').forEach(url => deepAreas.add(url.searchParams.get('area_id')));
    s.advance(61000);
  }
  assert.equal(deepAreas.size, 10);
});

test('a malformed global response keeps the old successful timestamp and does not interrupt area discovery', async () => {
  let rankData = { list: [{ room_id: 5000, rank: 1, score: 100, live_status: 1 }] };
  const s = scanner(url => url.includes('/area/getList')
    ? { code: 0, data: [{ id: 1, list: [{ id: 2 }] }] }
    : { code: 0, data: [{ roomid: 6000, online: 100 }] }, () => ({ code: 0, data: rankData }));
  s.api.CFG.discoveryDelayMs = 0;
  s.api.startDiscovery(); await s.api.discoveryTask;
  const at = s.api.pool.get('5000').hotRankPriority.at;
  rankData = { list: [{ room_id: 5000, rank: 51, score: 100, live_status: 1 }] };
  s.advance(61000); s.api.startDiscovery(); await s.api.discoveryTask;
  assert.equal(s.api.pool.get('5000').hotRankPriority.at, at);
  assert.equal(s.api.state.hotRank.at, at);
  assert.ok(s.api.state.hotRank.error);
  assert.equal(s.api.state.discovery.error, '');
  assert.equal(s.api.state.discovery.pages, 2);
  const request = s.store.query('requests', { kind: 'discovery', limit: 20 }).items.find(r => r.tier === 'GLOBAL_HOT_RANK');
  assert.equal(request.outcome, 'error'); assert.equal(request.reason, 'schema');
});

test('pausing during a global fetch prevents subsequent discovery requests; a direct ban cools down the whole batch', async () => {
  const s = scanner(undefined, () => {
    s.setScanSettings(false);
    return { code: 0, data: { list: [{ room_id: 5000, rank: 1, score: 100, live_status: 1 }] } };
  });
  s.api.CFG.discoveryDelayMs = 0;
  s.api.startDiscovery(); await s.api.discoveryTask;
  assert.equal(s.calls.length, 1);
  assert.equal(s.api.state.phase, 'paused');
  assert.equal(s.api.state.scan.inFlight, 0);
  const banned = scanner(undefined, () => '<html>拒绝</html>\n###412');
  banned.api.CFG.discoveryDelayMs = 0;
  banned.api.startDiscovery(); await banned.api.discoveryTask;
  assert.equal(banned.calls.length, 1);
  assert.equal(banned.api.pool.size, 0);
  assert.equal(banned.api.state.stats.banned, 1);
  assert.equal(banned.api.state.discovery.nextAt - banned.api.state.discovery.finishedAt, 15 * 60000);
});

test('QQ source evidence drives actual WARM requests and survives pool publication without fabricating hits', async () => {
  const s = scanner(); s.api.setRooms(200); s.api.addNodes(3);
  const at = Date.parse('2026-11-06T12:00:00+08:00');
  const pushes = [60000, 120000].map(age => ({ room:'1000', battery:100,
    push_time:new Date(at-age).toISOString(), msg_time:new Date(at-age+1000).toISOString(), group:'test source' }));
  s.files.set(s.api.CFG.qqFile, JSON.stringify({ extracted_at:'2026-11-06 12:00:00', pushes }));
  vm.runInContext('fs.statSync = () => ({mtimeMs:1}); syncQQ();', s.sandbox);
  assert.equal(s.api.state.qq.uniqueBatteryReports, 2);
  await s.api.runRound(1, ['node0','node1','node2']);
  s.advance(30000);
  s.sandbox.exitIp = '192.0.2.2';
  await s.api.runRound(2, ['node0','node1','node2']);
  const requests = s.store.db.prepare("SELECT tier FROM requests WHERE kind='rp' AND room_id='1000'").all();
  assert.equal(requests.length, 2);
  assert.ok(requests.every(r => r.tier === 'WARM'));
  assert.equal(s.api.state.stats.batteryHits, 0);
  const r = JSON.parse(s.files.get(s.api.CFG.poolFile)).rooms['1000'];
  assert.equal(r.qqReports.length, 2);
  assert.equal(r.qqMisses, 2);
  assert.equal(s.api.state.settings.qqRepeatIntervalMs, 30000);
  assert.equal(s.api.CFG.minNodeReuseMs, 180000);
});

test('QQ backoff changes actual request cadence and is published without changing node limits', async () => {
  const s=scanner();s.api.setRooms(200);s.api.addNodes(3);
  const at=Date.parse('2026-11-06T12:00:00+08:00');
  s.files.set(s.api.CFG.qqFile,JSON.stringify({pushes:[{room:'1000',battery:100,award_num:10,
    push_time:new Date(at-3*3600000).toISOString(),msg_time:new Date(at-3*3600000+1000).toISOString()}]}));
  vm.runInContext('fs.statSync = () => ({mtimeMs:1}); syncQQ();',s.sandbox);
  s.api.pool.get('1000').qqMisses=16;
  await s.api.runRound(1,['node0','node1','node2']);
  s.advance(180000);s.sandbox.exitIp='192.0.2.2';
  await s.api.runRound(2,['node0','node1','node2']);
  s.advance(120000);s.sandbox.exitIp='192.0.2.3';
  await s.api.runRound(3,['node0','node1','node2']);
  const rows=s.store.db.prepare("SELECT tier,started_at FROM requests WHERE kind='rp' AND room_id='1000' ORDER BY id").all();
  assert.equal(rows.length,2);
  assert.equal(rows[1].started_at-rows[0].started_at,300000);
  assert.ok(rows.every(r=>r.tier==='WARM'));
  assert.equal(s.api.state.qq.backedOff,1);
  assert.equal(s.api.state.settings.qqPolicyVersion,4);
  assert.equal(s.api.state.settings.qqBackoffThirdIntervalMs,300000);
  assert.equal(s.api.CFG.nodeLimit,8);
  assert.equal(s.api.CFG.perIpBudget,110);
  assert.equal(s.api.CFG.minNodeReuseMs,180000);
});

test('QQ live reports schedule a single real verification without inventing a hit or a notification', async () => {
  const s=scanner();s.api.setRooms(200);s.api.addNodes(3);
  const at=Date.parse('2026-11-06T12:00:00+08:00');
  s.api.pool.get('1000').lastAttempt=s.api.pool.get('1000').lastScan=at-10000;
  s.files.set(s.api.CFG.qqFile,JSON.stringify({pushes:[{room:'1000',battery:100,award_num:10,
    push_time:new Date(at-6000).toISOString(),msg_time:new Date(at-5000).toISOString(),
    end_time:new Date(at+300000).toISOString()}]}));
  vm.runInContext('fs.statSync = () => ({mtimeMs:1}); syncQQ();',s.sandbox);
  s.api.writeState();assert.equal(s.api.state.qq.pendingVerification,1);
  await s.api.runRound(1,['node0','node1','node2']);
  const rp=s.calls.filter(url=>url.includes('RedPocketGetInfo'));
  assert.ok(rp[0].endsWith('room_id=1000'));
  assert.equal(rp.filter(url=>url.endsWith('room_id=1000')).length,1);
  assert.equal(s.api.state.qq.pendingVerification,0);
  assert.equal(s.api.state.stats.batteryHits,0);
  assert.equal(s.store.query('events').items.length,0);
  assert.equal(s.desktopCalls.length,0);
});

test('low-value HOT requests wait 60 seconds and recent useful HOT retains fast requests', async () => {
  const s = scanner(); s.api.setRooms(200); s.api.addNodes(3);
  const t = Date.parse('2026-11-06T12:00:00+08:00');
  const S = localRequire('./strategy');
  const packet = (id, num) => ({ lot_id: id, total_price: 10000,
    end_time: t / 1000 + 600, awards: [{ gift_name: '电池红包', num }] });
  S.recordScan(s.api.pool.get('1000'), [packet(1, 50), packet(2, 50)], t);
  S.recordScan(s.api.pool.get('1001'), [packet(3, 10)], t);
  s.advance(20000);
  await s.api.runRound(1, ['node0', 'node1', 'node2']);
  s.advance(39999); s.sandbox.exitIp = '192.0.2.2';
  await s.api.runRound(2, ['node0', 'node1', 'node2']);
  s.advance(1); s.sandbox.exitIp = '192.0.2.3';
  await s.api.runRound(3, ['node0', 'node1', 'node2']);
  const low = s.store.db.prepare("SELECT started_at FROM requests WHERE kind='rp' AND room_id='1000'").all();
  const useful = s.store.db.prepare("SELECT started_at FROM requests WHERE kind='rp' AND room_id='1001'").all();
  assert.equal(low.length, 1); assert.equal(low[0].started_at - t, 60000);
  assert.equal(useful.length, 3);
  assert.equal(s.api.state.pool.hotFast, 1); assert.equal(s.api.state.pool.hotSlow, 1);
});

test('restart restores value from the long-term store without resetting counters or firing notifications', () => {
  const s = scanner(); s.api.setRooms(1);
  const t = Date.parse('2026-11-06T12:00:00+08:00');
  const meta = { kind: 'rp', roomId: '1000', tier: 'WARM', startedAt: t - 10000 };
  const req = s.store.beginRequest(meta);
  s.store.completeRequest(req, meta, { status: 'OK', code: 0, data: { lot_info: [{
    lot_id: 999, total_price: 10000, end_time: t / 1000 + 100,
    awards: [{ gift_name: '电池红包', num: 10 }],
  }] } }, t - 9000);
  const r = s.api.pool.get('1000'); r.batteryHits = 5; r.lastBatteryHit = t - 9000;
  r.lastAttempt = t - 1000; r.misses = 7;
  s.api.restoreBatteryValues(); s.api.restoreBatteryValues();
  assert.equal(r.batteryValueEvidence.length, 1);
  assert.equal(r.batteryValueEvidence[0].at, t - 9000);
  assert.equal(r.batteryValueEvidence[0].perPerson, 10);
  assert.equal(r.batteryHits, 5); assert.equal(r.lastAttempt, t - 1000); assert.equal(r.misses, 7);
  assert.equal(s.api.state.stats.batteryHits, 0); assert.equal(s.desktopCalls.length, 0);
  assert.equal(s.store.summary().requests.total, 1);
});

test('special packets stay in raw history but not live rewards, notifications or battery priority', async () => {
  const t = Date.parse('2026-11-06T12:00:00+08:00');
  const packet = (lot_id, join_requirement) => ({ lot_id, join_requirement,
    total_price: 10000, awards: [{ gift_name: '电池红包', num: 5 }], end_time: t / 1000 + 600 });
  const s = scanner(url => {
    const room = new URL(url).searchParams.get('room_id');
    return { code: 0, data: { lot_info: room === '1000' ? [packet(9901, 3), packet(9902, 2)]
      : room === '1001' ? [packet(9903, 4)] : [] } };
  });
  s.api.setRooms(200); s.api.addNodes(3); s.setNotificationSettings({ enabled: true });
  await s.api.runRound(1, ['node0', 'node1', 'node2']);
  await Promise.all(s.api.pendingNotifications);
  s.api.writeState();
  const state = JSON.parse(s.files.get(s.api.CFG.stateFile));
  assert.deepEqual(state.redpockets.map(r => r.lid), [9902]);
  assert.deepEqual(state.history.map(r => r.lid), [9902]);
  assert.deepEqual(s.desktopCalls.map(p => p.id), ['9902']);
  assert.equal(state.stats.hits, 1); assert.equal(state.stats.batteryHits, 1);
  assert.equal(s.api.pool.get('1000').batteryHits, 1);
  assert.equal(s.api.pool.get('1001').lastBatteryHit, undefined);
  assert.equal(s.api.pool.get('1001').misses, 1);
  assert.equal(s.store.query('events').items.length, 3);
  const archived = s.store.query('events').items.find(e => e.lid === '9901');
  assert.equal(archived.detail.join_requirement, 3);
  assert.equal(archived.detail.raw.join_requirement, 3);
  assert.equal(s.store.query('requests', { room: '1001' }).items[0].outcome, 'hit');
});

test('upgrading saved special evidence removes its HOT status and survives another restart', () => {
  const s = scanner(); s.api.setRooms(1);
  const t = Date.parse('2026-11-06T12:00:00+08:00');
  const ordinaryAt = t - 31 * 60000, specialAt = t - 1000;
  const records = [];
  for (const [id, gate, at] of [[9911, 2, ordinaryAt], [9912, 3, specialAt]]) {
    const lot = { lot_id: id, join_requirement: gate, total_price: 10000,
      awards: [{ gift_name: '电池红包', num: 10 }], end_time: t / 1000 + 600 };
    const meta = { kind: 'rp', roomId: '1000', startedAt: at - 1 };
    const req = s.store.beginRequest(meta);
    s.store.completeRequest(req, meta, { status: 'OK', code: 0, data: { lot_info: [lot] } }, at);
    records.push({ lid: id, room_id: '1000', join_requirement: gate, total_price: 10000,
      battery: 100, per_person: 10, award_name: '电池红包', award_num: 10,
      first_seen: at, last_seen: t - 500, end_time: lot.end_time });
  }
  s.store.importState({ history: records }, 'legacy-summaries');
  const r = s.api.pool.get('1000');
  delete r.batteryEligibilityVersion;
  Object.assign(r, { batteryHits: 2, lastBatteryHit: specialAt, lastAttempt: t - 100, misses: 7,
    batteryValueEvidence: records.map(p => ({ id: String(p.lid), at: p.first_seen, perPerson: 10 })),
    seenLots: records.map(p => ({ id: String(p.lid), until: t + 86400000 })) });
  s.files.set(s.api.CFG.stateFile, JSON.stringify({ redpockets: records, history: records,
    expired: [{ ...records[1], expiredAt: t - 100 }],
    notifications: { notified: [{ id: '9912', until: t + 86400000 }] } }));
  s.api.restoreState();
  s.api.restoreBatteryValues();
  assert.equal(s.api.state.valueEvidence.migratedRooms, 1);
  assert.equal(r.batteryHits, 1); assert.equal(r.lastBatteryHit, ordinaryAt);
  assert.equal(localRequire('./strategy').tierOf(r, t), 'WARM');
  assert.deepEqual(r.batteryValueEvidence.map(e => e.id), ['9911']);
  assert.equal(r.lastAttempt, t - 100); assert.equal(r.misses, 7);
  s.api.writeState();
  s.api.restoreState(); s.api.restoreBatteryValues(); s.api.writeState();
  const state = JSON.parse(s.files.get(s.api.CFG.stateFile));
  assert.deepEqual(state.redpockets.map(p => p.lid), [9911]);
  assert.equal(state.expired.length, 0);
  assert.deepEqual(state.history.map(p => p.lid), [9911]);
  assert.equal(r.batteryHits, 1);
  assert.equal(state.notifications.notified[0].id, '9912');
  assert.equal(state.stats.batteryHits, 0); assert.equal(s.desktopCalls.length, 0);
  assert.equal(s.store.summary().events.total, 2); assert.equal(s.store.summary().requests.total, 2);
});

test('actual priority requests stay below 20 percent even when a round pauses mid-scan', async () => {
  for (const pause of [false, true]) {
    let s;
    s = scanner(url => {
      if (pause && url.includes('RedPocketGetInfo') && Number(new URL(url).searchParams.get('room_id')) < 1100) {
        s.setScanSettings(false);
      }
      return { code: 0, data: { lot_info: [] } };
    });
    s.api.setRooms(500); s.api.addNodes(3);
    const at = Date.parse('2026-11-06T12:00:00+08:00');
    for (let i = 0; i < 100; i++) {
      s.api.pool.get(String(1000 + i)).listingPriority = { at, rank: 1, online: i };
    }
    await s.api.runRound(1, ['node0', 'node1', 'node2']);
    const requests = s.store.query('requests', { kind: 'rp', limit: 200 }).items.sort((a, b) => a.id - b.id);
    let priority = 0;
    for (let i = 0; i < requests.length; i++) {
      if (requests[i].tier === 'COLD_PRIORITY') priority++;
      assert.ok(priority <= (i + 1) * .2);
    }
    if (!pause) {
      assert.equal(requests.length, 109);
      assert.equal(priority, 21);
      assert.equal(s.api.state.quota.regularCold, 88);
      assert.equal(s.api.nodeState.get('node0').used, 110);
    } else {
      assert.ok(priority > 0);
      assert.ok(requests.length < 109);
      assert.equal(s.api.state.scan.enabled, false);
    }
    assert.equal(s.api.state.settings.priorityMaxRatio, .2);
  }
});

test('412 stops dispatch and prevents the anchor phase', async () => {
  const s = scanner(() => '<html>没有固定英文关键词</html>\n###412');
  s.api.setRooms(200); s.api.addNodes(3);
  await s.api.runRound(12, ['node0', 'node1', 'node2']);
  const rp = s.calls.filter(x => x.includes('RedPocketGetInfo'));
  assert.ok(rp.length >= 1 && rp.length <= 5);
  assert.ok(s.calls.every(x => !x.includes('/Anchor/')));
  assert.ok(s.api.state.stats.banned >= 1);
  assert.equal(s.api.state.stats.scanned, 0);
  assert.equal(s.api.pickNode(['node0', 'node1', 'node2']), null);
});

test('round request budget includes IP and anchors; empty success is counted', async () => {
  const s = scanner(url => ({ code: 0, data: url.includes('/Anchor/') ? {} : { lot_info: [] } }));
  s.api.setRooms(200); s.api.addNodes(3);
  await s.api.runRound(12, ['node0', 'node1', 'node2']);
  assert.equal(s.calls.length, 110);
  assert.equal(s.api.state.stats.requestsByKind.ip, 1);
  assert.equal(s.api.state.stats.requestsByKind.rp, 101);
  assert.equal(s.api.state.stats.requestsByKind.anchor, 8);
  assert.equal(s.api.state.stats.scanned, 101);
  assert.equal([...s.api.pool.values()].filter(r => r.misses === 1).length, 101);
  assert.equal(s.store.summary().requests.total, s.calls.length);
  const anchors = s.store.query('requests', {kind:'anchor'}).items;
  assert.ok(anchors.every(r => r.room_id && r.outcome === 'empty'));
});

test('opt-in stop-on-ban drains the scan and prevents requests on another exit while retaining cooldown', async () => {
  for (const reply of ['\n###412', '\n###429', { code: -352 }]) {
    let banned = true;
    const s = scanner(() => banned ? reply : { code: 0, data: { lot_info: [] } }, undefined,
      { SCANNER_STOP_ON_BAN: '1' });
    s.api.setRooms(200); s.api.addNodes(4);
    const nodes = ['node0', 'node1', 'node2', 'node3'];
    await s.api.runRound(1, nodes);
    assert.equal(s.api.state.stats.banned, 1);
    assert.ok(s.api.nodeState.get('node0').bannedUntil > s.sandbox.Date.now());
    assert.equal(s.api.state.scan.inFlight, 0);
    const before = s.calls.length;
    banned = false; s.advance(180000); s.sandbox.exitIp = '192.0.2.2';
    await s.api.runRound(2, nodes);
    assert.equal(s.calls.length, before);
    assert.ok(s.api.nodeState.get('node0').bannedUntil > s.sandbox.Date.now());
  }
});

test('default ban handling retains cooldown and continues scanning another eligible exit', async () => {
  let banned = true;
  const s = scanner(() => banned ? '\n###429' : { code: 0, data: { lot_info: [] } });
  s.api.setRooms(200); s.api.addNodes(4);
  const nodes = ['node0', 'node1', 'node2', 'node3'];
  await s.api.runRound(1, nodes);
  const before = s.calls.length;
  banned = false; s.advance(180000); s.sandbox.exitIp = '192.0.2.2';
  await s.api.runRound(2, nodes);
  assert.equal(s.calls.length - before, 110);
  assert.equal(s.api.nodeState.get('node1').used, 110);
  assert.ok(s.api.nodeState.get('node0').bannedUntil > s.sandbox.Date.now());
});

test('slow exits use smaller real batches, preserve quotas, and rotate to a fast exit with its full budget', async () => {
  const s = scanner(); s.api.setRooms(500); s.api.addNodes(8);
  const slow = s.api.nodeState.get('node0');
  slow.requestMeanMs = 5000; slow.latencySamples = 100;
  const names = [...s.api.nodeState.keys()];
  await s.api.runRound(12, names);
  assert.equal(s.calls.length, 30);
  assert.equal(s.api.state.stats.requestsByKind.ip, 1);
  assert.equal(s.api.state.stats.requestsByKind.anchor, 2);
  assert.equal(s.api.state.stats.requestsByKind.rp, 27);
  assert.equal(slow.used, 30);
  assert.ok(s.api.state.quota.regularCold >= Math.ceil(27 * .3));
  assert.equal(s.api.pickNode(names), 'node1');
  s.sandbox.exitIp = '192.0.2.2';
  await s.api.runRound(13, names);
  assert.equal(s.api.nodeState.get('node1').used, 110);
  assert.equal(s.calls.length, 140);
  assert.equal(s.api.CFG.minNodeReuseMs, 180000);
  assert.equal(s.api.CFG.cooldownMs, 900000);
  s.api.writeState();
  const saved = JSON.parse(s.files.get(s.api.CFG.stateFile));
  const next = scanner();
  next.files.set(next.api.CFG.stateFile, JSON.stringify(saved));
  next.api.restoreState();
  assert.equal(next.api.nodeState.get('node0').requestMeanMs, slow.requestMeanMs);
  assert.equal(next.api.pickNode(names), 'node2');
});

test('legacy node state learns recent measured latency from history while existing estimates survive startup', () => {
  const s = scanner(); s.api.addNodes(3);
  const at = Date.parse('2026-11-06T12:00:00+08:00');
  for (let i = 0; i < 5; i++) {
    const meta = { kind: 'rp', node: 'node0', roomId: '1000', startedAt: at - 5000 };
    const id = s.store.beginRequest(meta);
    s.store.completeRequest(id, meta, { status: 'NETWORK' }, at);
  }
  s.api.nodeState.get('node1').requestMeanMs = 900;
  s.api.nodeState.get('node1').latencySamples = 10;
  s.api.restoreNodeLatencies();
  assert.equal(s.api.nodeState.get('node0').requestMeanMs, 5000);
  assert.equal(s.api.nodeState.get('node0').latencySamples, 5);
  assert.equal(s.api.nodeState.get('node1').requestMeanMs, 900);
  assert.equal(s.calls.length, 0);
});

test('rapid round turnover still waits 180 seconds and honors the actual shared exit clock', () => {
  const s = scanner(); s.api.addNodes(8);
  const names = [...s.api.nodeState.keys()];
  const at = Date.parse('2026-11-06T12:00:00+08:00');
  for (const node of s.api.nodeState.values()) node.lastUsedAt = at;
  assert.equal(s.api.pickNode(names), null);
  s.advance(179999);
  assert.equal(s.api.pickNode(names), null);
  s.advance(1);
  assert.equal(s.api.pickNode(names), 'node0');
  vm.runInContext(`nodeState.get('node0').lastIp = '192.0.2.1';
    nodeState.get('node1').lastIp = '192.0.2.1';
    ipState.set('192.0.2.1', { lastUsedAt: Date.now(), bannedUntil: 0 });`, s.sandbox);
  assert.equal(s.api.pickNode(names), 'node2');
  assert.equal(s.calls.length, 0);
});

test('too few healthy nodes produces no external requests', async () => {
  const s = scanner(); s.api.setRooms(200); s.api.addNodes(2);
  await s.api.runRound(1, ['node0', 'node1']);
  assert.equal(s.calls.length, 0); assert.equal(s.api.state.phase, 'cooldown');
  assert.equal(s.store.summary().requests.total, 0);
});

test('pooled scanner rounds retain the budget and create a fresh transport after switching exits', async () => {
  const s = scanner(); s.api.setRooms(200); s.api.addNodes(3); s.api.CFG.pooledHttp = true;
  await s.api.runRound(1, ['node0', 'node1', 'node2']);
  assert.equal(s.calls.length, 110); assert.equal(s.transports.length, 1);
  assert.equal(s.transports[0].closed, true);
  s.sandbox.exitIp = '192.0.2.2';
  await s.api.runRound(2, ['node0', 'node1', 'node2']);
  assert.equal(s.calls.length, 220); assert.equal(s.transports.length, 2);
  assert.ok(s.transports.every(t => t.closed && t.options.concurrency === 5));
  assert.equal(s.store.summary().requests.total, 220);
});

test('a pooled ban drains the round and closes its transport without fallback requests', async () => {
  const s = scanner(() => '\n###412'); s.api.setRooms(200); s.api.addNodes(3); s.api.CFG.pooledHttp = true;
  await s.api.runRound(1, ['node0', 'node1', 'node2']);
  assert.equal(s.transports.length, 1); assert.equal(s.transports[0].closed, true);
  assert.ok(s.calls.length <= 6);
  assert.equal(s.api.state.phase, 'cooldown');
  assert.equal(s.store.query('requests', { outcome: 'pending' }).items.length, 0);
  assert.ok(s.api.nodeState.get('node0').bannedUntil > s.sandbox.Date.now());
});

test('audience enrichment shares the round budget and leaves the room scan clock intact', async () => {
  const s = scanner(url => url.includes('/Room/get_info') ? { code: 0, data: { uid: 123 } }
    : url.includes('getOnlineGoldRank') ? { code: 0, data: { onlineNum: 72 } }
    : { code: 0, data: { lot_info: [] } });
  s.api.setRooms(200); s.api.addNodes(3); s.api.CFG.roomAudience = true;
  s.api.state.stats.byTier.COLD = { batteryHits: 0 };
  const time = s.sandbox.Date.now();
  s.api.acceptRedpockets('1000', [{ lot_id: 9123, total_price: 10000,
    awards: [{ gift_name: '电池红包', num: 10 }], end_time: time / 1000 + 600 }], 'COLD');
  // Keep the event active while the room is rescanned.
  const original = s.sandbox.api.activeRP.get('9123');
  s.api.pool.get('1000').lastAttempt = time;
  s.api.CFG.hotIntervalMs = 600000;
  await s.api.runRound(1, ['node0', 'node1', 'node2']);
  assert.equal(s.calls.length, 110);
  assert.equal(s.api.state.stats.requestsByKind.rp, 107);
  assert.equal(s.api.state.stats.requestsByKind['audience-room'], 1);
  assert.equal(s.api.state.stats.requestsByKind.audience, 1);
  assert.equal(s.api.pool.get('1000').audience.count, 72);
  assert.equal(s.api.pool.get('1000').lastAttempt, time);
  assert.equal(s.api.state.redpockets.find(r => r.lid === original.lid).audience.count, 72);
});

test('known anchor IDs save an audience lookup and malformed counts do not become zero', async () => {
  const s = scanner(url => url.includes('getOnlineGoldRank') ? { code: 0, data: {} }
    : { code: 0, data: { lot_info: [] } });
  s.api.setRooms(200); s.api.addNodes(3); s.api.CFG.roomAudience = true;
  s.api.state.stats.byTier.COLD = { batteryHits: 0 };
  const time = s.sandbox.Date.now();
  s.api.acceptRedpockets('1000', [{ lot_id: 9124, total_price: 10000,
    awards: [{ gift_name: '电池红包', num: 10 }], end_time: time / 1000 + 600 }], 'COLD');
  s.api.pool.get('1000').anchorUid = 123;
  s.api.pool.get('1000').lastAttempt = time; s.api.CFG.hotIntervalMs = 600000;
  await s.api.runRound(1, ['node0', 'node1', 'node2']);
  assert.equal(s.calls.length, 110);
  assert.equal(s.api.state.stats.requestsByKind.rp, 108);
  assert.equal(s.calls.some(url => url.includes('/Room/get_info')), false);
  assert.equal(s.api.state.redpockets[0].audience, null);
  assert.equal(s.api.state.stats.errorReasons['audience:schema'], 1);
});

test('one opt-in IP network retry recovers the round and consumes the same 110 request budget', async () => {
  const s = scanner(); s.api.setRooms(200); s.api.addNodes(3); s.api.CFG.ipNetworkRetry = true;
  let probes = 0;
  s.sandbox.zoneReply = () => ++probes === 1 ? '\n###000' : { code: 0, data: { addr: '192.0.2.1' } };
  await s.api.runRound(1, ['node0', 'node1', 'node2']);
  assert.equal(probes, 2); assert.equal(s.calls.length, 110);
  assert.equal(s.api.state.stats.requestsByKind.ip, 2);
  assert.equal(s.api.state.stats.requestsByKind.rp, 108);
  assert.equal(s.api.nodeState.get('node0').used, 110);
  assert.equal(s.store.query('requests', { kind: 'ip' }).items.length, 2);
  assert.equal(s.store.summary().requests.total, 110);
});
test('IP retries stop after one transport retry and remain disabled by default', async () => {
  for (const enabled of [false, true]) {
    const s = scanner(); s.api.setRooms(200); s.api.addNodes(3); s.api.CFG.ipNetworkRetry = enabled;
    s.sandbox.zoneReply = () => '\n###000';
    await s.api.runRound(1, ['node0', 'node1', 'node2']);
    assert.equal(s.calls.length, enabled ? 2 : 1);
    assert.equal(s.calls.some(url => url.includes('RedPocketGetInfo')), false);
    assert.equal(s.api.state.phase, 'error');
  }
});
test('IP retry does not repeat a ban, HTTP failure, business error or malformed response', async () => {
  for (const result of ['\n###412', '\n###503', { code: -1 }, { code: 0, data: {} }]) {
    const s = scanner(); s.api.setRooms(200); s.api.addNodes(3); s.api.CFG.ipNetworkRetry = true;
    s.sandbox.zoneReply = () => result;
    await s.api.runRound(1, ['node0', 'node1', 'node2']);
    assert.equal(s.calls.length, 1);
    assert.equal(s.calls.some(url => url.includes('RedPocketGetInfo')), false);
  }
});

test('history write failure stops dispatch and publishes the storage error', async () => {
  const s = scanner(); s.api.setRooms(200); s.api.addNodes(3);
  s.store.completeRequest = () => { throw new Error('history disk full'); };
  await assert.rejects(s.api.runRound(1, ['node0', 'node1', 'node2']), /history disk full/);
  assert.equal(s.calls.length, 1);
  assert.equal(s.api.state.storage.error, 'history disk full');
  assert.equal(s.sandbox.process.exitCode, 1);
});

test('successful empty scans, malformed payloads and hits are durable with request links', async () => {
  let index = 0;
  const s = scanner(() => {
    index++;
    if (index === 1) return {code:0, data:{lot_info:[{lot_id:987, total_price:10000,
      awards:[{gift_name:'电池红包',num:10}],end_time:Date.parse('2026-11-06T12:10:00+08:00')/1000}]}};
    if (index === 2) return {code:0,data:{lot_info:[null]}};
    return {code:0,data:{lot_info:null}};
  });
  s.api.setRooms(200); s.api.addNodes(3);
  await s.api.runRound(1,['node0','node1','node2']);
  assert.equal(s.store.query('requests',{outcome:'hit'}).items.length,1);
  assert.equal(s.store.query('requests',{outcome:'error'}).items[0].reason,'schema');
  assert.equal(s.store.query('events').items[0].battery,100);
  assert.equal(s.store.query('requests',{outcome:'hit'}).items[0].event_ids.length,1);
  assert.equal(s.store.summary().requests.total,s.calls.length);
});

test('the observed live lot_info:null response is a successful empty scan', async () => {
  const s = scanner(() => ({ code: 0, message: 'OK', ttl: 1, data: { lot_info: null } }));
  s.api.setRooms(200); s.api.addNodes(3);
  await s.api.runRound(1, ['node0', 'node1', 'node2']);
  assert.equal(s.api.state.stats.scanned, 109);
  assert.equal(s.api.state.stats.errors, 0);
  assert.equal([...s.api.pool.values()].filter(r => r.misses === 1).length, 109);
});

test('found time remains stable, is published immediately, and survives restart deduplication', () => {
  const s = scanner(); s.api.setRooms(1);
  s.api.state.stats.byTier.COLD = { batteryHits: 0 };
  const lot = { lot_id: 123, start_time: Date.parse('2026-11-06T11:59:00+08:00') / 1000,
    end_time: Date.parse('2026-11-06T12:10:00+08:00') / 1000,
    total_price: 2000, awards: [{ gift_name: '电池红包', num: 10 }] };
  s.api.acceptRedpockets('1000', [lot], 'COLD');
  const first = s.api.activeRP.get('123').first_seen;
  assert.ok(s.files.has(s.api.CFG.stateFile));
  assert.ok(s.files.has(s.api.CFG.poolFile));
  s.advance(20000);
  s.api.acceptRedpockets('1000', [lot], 'COLD');
  assert.equal(s.api.activeRP.get('123').first_seen, first);
  assert.equal(s.api.state.stats.hits, 1);
  s.api.restoreState();
  s.api.acceptRedpockets('1000', [lot], 'COLD');
  assert.equal(s.api.state.stats.hits, 1);
  assert.equal(s.api.pool.get('1000').batteryHits, 1);
});

test('same anchor id is counted once and never promotes a battery HOT tier', () => {
  const s = scanner(); s.api.setRooms(1);
  s.api.acceptAnchor('1000', { id: 456, time: 300 });
  s.advance(20000); s.api.acceptAnchor('1000', { id: 456, time: 280 });
  assert.equal(s.api.pool.get('1000').anchorHits, 1);
  assert.equal(s.api.pool.get('1000').lastBatteryHit, undefined);
});

test('main scan completes while discovery is still pending', async () => {
  const s = scanner(); s.api.setRooms(200); s.api.addNodes(3);
  let release;
  s.sandbox.pendingDiscovery = new Promise(resolve => { release = resolve; });
  vm.runInContext('discoveryGet = () => pendingDiscovery;', s.sandbox);
  s.api.startDiscovery();
  assert.equal(s.api.state.discovery.running, true);
  await s.api.runRound(1, ['node0', 'node1', 'node2']);
  assert.equal(s.api.state.stats.scanned, 109);
  assert.equal(s.api.state.discovery.running, true);
  release([]); await s.api.discoveryTask;
  assert.equal(s.api.state.discovery.running, false);
});

test('a persistence failure cancels and drains workers before a round rejects', async () => {
  const s = scanner(() => ({ code: 0, data: { lot_info: [{ lot_id: 789,
    end_time: Date.parse('2026-11-06T12:10:00+08:00') / 1000,
    awards: [{ gift_name: '电池红包' }] }] } }));
  s.api.setRooms(200); s.api.addNodes(3);
  vm.runInContext('savePool = () => { throw new Error("disk full"); };', s.sandbox);
  await assert.rejects(s.api.runRound(1, ['node0', 'node1', 'node2']), /disk full/);
  const count = s.calls.length;
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(s.calls.length, count);
  assert.ok(count <= 6);
});

test('qualifying packets notify once across polling and a fresh scanner restart', async () => {
  const s = scanner(); s.api.setRooms(1); s.setNotificationSettings({ enabled: true });
  s.api.state.stats.byTier.COLD = { batteryHits: 0 };
  const lot = { lot_id: 901, end_time: Date.parse('2026-11-06T12:10:00+08:00') / 1000,
    total_price: 10000, awards: [{ gift_name: '电池红包', num: 10 }] };
  s.api.acceptRedpockets('1000', [lot], 'COLD');
  s.api.acceptRedpockets('1000', [lot], 'COLD');
  await Promise.all(s.api.pendingNotifications);
  assert.equal(s.desktopCalls.length, 1);
  assert.equal(s.api.state.notifications.sent, 1);
  const restored = scanner(); restored.setNotificationSettings({ enabled: true });
  restored.files.set(restored.api.CFG.stateFile, s.files.get(s.api.CFG.stateFile));
  restored.api.restoreState();
  assert.equal(restored.api.queueNotification(s.api.activeRP.get('901')), false);
  assert.equal(restored.desktopCalls.length, 0);
});

test('cloud mode keeps packet eligibility enabled without reserving or submitting a Windows notification', () => {
  const s = scanner(undefined, undefined, { SCANNER_DESKTOP_NOTIFICATIONS: '0' });
  s.setNotificationSettings({ enabled: true, minBattery: 100, minRemainingSeconds: 120 });
  const record = { lid: '9001', room_id: '1000', battery: 100, award_num: 10,
    award_name: '电池红包', end_time: s.sandbox.Date.now() / 1000 + 300 };
  assert.ok(localRequire('./notifications').buildNotification(record, s.sandbox.Date.now(),
    { enabled: true, minPerPerson: 10, minBattery: 100, minRemainingSeconds: 120 }));
  assert.equal(s.api.queueNotification(record), false);
  assert.equal(s.desktopCalls.length, 0);
  assert.equal(s.api.state.notifications.notified.length, 0);
});

test('notification failure is isolated from scans and retried after a backoff', async () => {
  const s = scanner(); s.setNotificationSettings({ enabled: true });
  const packet = { lid: 902, room_id: '1000', award_name: '电池红包', battery: 100, award_num: 10,
    end_time: Date.parse('2026-11-06T12:10:00+08:00') / 1000 };
  s.setDesktopError(new Error('notification disabled'));
  assert.equal(s.api.queueNotification(packet), true);
  await Promise.all(s.api.pendingNotifications);
  assert.equal(s.api.state.notifications.failed, 1);
  assert.equal(s.api.state.notifications.notified.length, 0);
  assert.equal(s.api.queueNotification(packet), false);
  s.advance(60000); s.setDesktopError(null);
  assert.equal(s.api.queueNotification(packet), true);
  await Promise.all(s.api.pendingNotifications);
  assert.equal(s.api.state.notifications.sent, 1);
  assert.equal(s.api.state.notifications.lastError, '');
});

test('node limit retains eight members across reordered refreshes without replacing cooled nodes', async () => {
  const s = scanner(); s.api.addNodes(12);
  const bannedUntil = Date.parse('2026-11-06T12:15:00+08:00');
  s.api.nodeState.get('node1').bannedUntil = bannedUntil;
  s.sandbox.candidates = Array.from({ length: 12 }, (_, i) => 'node' + i).reverse();
  vm.runInContext('clash = async () => ({status: 200, body: JSON.stringify({proxies: {[CFG.group]: {all: [...candidates, "node0", "DIRECT", "REJECT"]}}})});', s.sandbox);
  const first = await s.api.loadNodes();
  assert.equal(s.api.CFG.nodeLimit, 8);
  assert.deepEqual([...first], Array.from({ length: 8 }, (_, i) => 'node' + i));
  assert.equal(s.api.nodeState.size, 8);
  assert.equal(s.api.nodeState.get('node1').bannedUntil, bannedUntil);
  assert.equal(s.api.nodeState.has('node8'), false);
  s.sandbox.candidates.reverse();
  assert.deepEqual([...await s.api.loadNodes()], [...first]);
  // A removed member can be replaced, but the live pool still stays within the cap.
  s.sandbox.candidates = s.sandbox.candidates.filter(n => n !== 'node7');
  const replaced = await s.api.loadNodes();
  assert.equal(replaced.length, 8);
  assert.equal(s.api.nodeState.has('node7'), false);
  assert.equal(s.api.nodeState.has('node8'), true);
  assert.equal(s.api.nodeState.get('node1').bannedUntil, bannedUntil);
  s.api.writeState();
  assert.equal(JSON.parse(s.files.get(s.api.CFG.stateFile)).nodes.length, 8);
});

test('configured twelve-node pool appends candidates and preserves request limits and cooldowns', async () => {
  const s = scanner(undefined, undefined, { SCANNER_NODE_LIMIT: '12' });
  s.api.addNodes(8);
  const bannedUntil = Date.parse('2026-11-06T12:15:00+08:00');
  s.api.nodeState.get('node1').bannedUntil = bannedUntil;
  s.sandbox.candidates = Array.from({ length: 16 }, (_, i) => 'node' + i);
  vm.runInContext('clash = async () => ({status: 200, body: JSON.stringify({proxies: {[CFG.group]: {all: candidates}}})});', s.sandbox);
  const nodes = await s.api.loadNodes();
  assert.equal(s.api.CFG.nodeLimit, 12);
  assert.equal(s.api.CFG.perIpBudget, 110);
  assert.equal(s.api.CFG.minNodeReuseMs, 180000);
  assert.equal(s.api.CFG.concurrency, 5);
  assert.deepEqual([...nodes], Array.from({ length: 12 }, (_, i) => 'node' + i));
  assert.equal(s.api.nodeState.get('node1').bannedUntil, bannedUntil);
  s.api.writeState();
  const state = JSON.parse(s.files.get(s.api.CFG.stateFile));
  assert.equal(state.nodes.length, 12);
  assert.equal(state.settings.nodeLimit, 12);
});

test('node limit rejects malformed or unbounded configuration before scanning', () => {
  for (const value of ['2', '25', '-1', '12.5', 'Infinity', 'unknown', ' 12 ']) {
    assert.throws(() => scanner(undefined, undefined, { SCANNER_NODE_LIMIT: value }), /SCANNER_NODE_LIMIT/);
  }
  assert.equal(scanner(undefined, undefined, { SCANNER_NODE_LIMIT: '' }).api.CFG.nodeLimit, 8);
  assert.equal(scanner(undefined, undefined, { SCANNER_NODE_LIMIT: '24' }).api.CFG.nodeLimit, 24);
});

test('configured 120-request budget covers IP, RP, anchors and audience in a pooled round', async () => {
  const s = scanner(url => url.includes('/Room/get_info') ? { code: 0, data: { uid: 123 } }
    : url.includes('getOnlineGoldRank') ? { code: 0, data: { onlineNum: 72 } }
    : url.includes('/Anchor/') ? { code: 0, data: {} }
    : { code: 0, data: { lot_info: [] } }, undefined, { SCANNER_PER_IP_BUDGET: '120' });
  s.api.setRooms(300); s.api.addNodes(3);
  s.api.CFG.roomAudience = true; s.api.CFG.pooledHttp = true;
  s.api.state.stats.byTier.COLD = { batteryHits: 0 };
  const time = s.sandbox.Date.now();
  s.api.acceptRedpockets('1000', [{ lot_id: 99123, total_price: 10000,
    awards: [{ gift_name: '电池红包', num: 10 }], end_time: time / 1000 + 600 }], 'COLD');
  s.api.pool.get('1000').lastAttempt = time;
  s.api.CFG.hotIntervalMs = 600000;
  await s.api.runRound(12, ['node0', 'node1', 'node2']);
  assert.equal(s.api.CFG.perIpBudget, 120);
  assert.equal(s.api.CFG.minNodeReuseMs, 180000);
  assert.equal(s.calls.length, 120);
  assert.equal(s.api.nodeState.get('node0').used, 120);
  assert.equal(s.api.state.stats.requestsByKind.ip, 1);
  assert.equal(s.api.state.stats.requestsByKind.rp, 109);
  assert.equal(s.api.state.stats.requestsByKind.anchor, 8);
  assert.equal(s.api.state.stats.requestsByKind['audience-room'], 1);
  assert.equal(s.api.state.stats.requestsByKind.audience, 1);
  assert.equal(s.api.pool.get('1000').audience.count, 72);
  assert.equal(s.store.summary().requests.total, 120);
  assert.equal(s.transports[0].closed, true);
});

test('IP request budget keeps its default and rejects invalid trial settings', () => {
  assert.equal(scanner().api.CFG.perIpBudget, 110);
  assert.equal(scanner(undefined, undefined, { SCANNER_PER_IP_BUDGET: '' }).api.CFG.perIpBudget, 110);
  for (const value of ['19', '151', '-1', '120.5', 'Infinity', 'unknown', ' 120 ']) {
    assert.throws(() => scanner(undefined, undefined, { SCANNER_PER_IP_BUDGET: value }), /SCANNER_PER_IP_BUDGET/);
  }
});

test('node refresh removes deleted nodes while preserving surviving cooldowns', async () => {
  const s = scanner(); s.api.addNodes(3);
  s.api.nodeState.get('node1').bannedUntil = Date.parse('2026-11-06T12:15:00+08:00');
  vm.runInContext(`clash = async () => ({status: 200, body: JSON.stringify({proxies: {
    [CFG.group]: {all: ['node1', 'node2', 'node3', 'DIRECT', 'REJECT']}
  }})});`, s.sandbox);
  const nodes = await s.api.loadNodes();
  assert.deepEqual([...nodes], ['node1', 'node2', 'node3']);
  assert.equal(s.api.nodeState.has('node0'), false);
  assert.equal(s.api.nodeState.get('node1').bannedUntil, Date.parse('2026-11-06T12:15:00+08:00'));
  assert.equal(s.api.nodeState.get('node3').lastUsedAt, 0);
});

test('a failed switch rotates away from the failing node without sending scan requests', async () => {
  const s = scanner(); s.api.setRooms(200); s.api.addNodes(3);
  vm.runInContext('switchNode = async () => { throw new Error("切换失败: 400"); };', s.sandbox);
  await assert.rejects(s.api.runRound(1, ['node0', 'node1', 'node2']), /400/);
  assert.equal(s.calls.length, 0);
  assert.equal(s.api.state.stats.errors, 1);
  assert.equal(s.api.pickNode(['node0', 'node1', 'node2']), 'node1');
});

test('saved controls change the running scanner and disabling cancels unsent notifications', async () => {
  const s = scanner();
  const packet = { lid: 990, room_id: '1000', award_name: '电池红包', battery: 100, award_num: 10,
    end_time: Date.parse('2026-11-06T12:10:00+08:00') / 1000 };
  assert.equal(s.api.queueNotification(packet), false);
  s.setNotificationSettings({ enabled: true, minBattery: 101 });
  assert.equal(s.api.queueNotification(packet), false);
  s.setNotificationSettings({ enabled: true, minBattery: 100, minRemainingSeconds: 600 });
  assert.equal(s.api.queueNotification(packet), true);
  s.setNotificationSettings({ enabled: false });
  await Promise.all(s.api.pendingNotifications);
  assert.equal(s.desktopCalls.length, 0);
  assert.equal(s.api.state.notifications.notified.length, 0);
  assert.equal(s.api.state.notifications.enabled, false);
  s.setNotificationSettings({ enabled: true, minPerPerson: 11 });
  assert.equal(s.api.queueNotification(packet), false);
  s.setNotificationSettings({ enabled: true, minPerPerson: 10 });
  assert.equal(s.api.queueNotification(packet), true);
  await Promise.all(s.api.pendingNotifications);
  assert.equal(s.desktopCalls.length, 1);
});

test('invalid saved settings stop alerts without interrupting scans and recover on correction', () => {
  const s = scanner(); s.setNotificationSettings({ enabled: true });
  assert.equal(s.api.syncNotificationSettings(), true);
  s.files.set(s.api.CFG.notificationSettingsFile, '{invalid');
  const packet = { lid: 991, room_id: '1000', award_name: '电池红包', battery: 100, award_num: 10,
    end_time: Date.parse('2026-11-06T12:10:00+08:00') / 1000 };
  assert.equal(s.api.queueNotification(packet), false);
  assert.ok(s.api.state.notifications.settingsError);
  s.setNotificationSettings({ enabled: false });
  assert.equal(s.api.syncNotificationSettings(), true);
  assert.equal(s.api.state.notifications.settingsError, '');
  assert.equal(s.api.state.notifications.enabled, false);
});

test('paced production scheduling rechecks HOT within the round while preserving exploration and total budget', async () => {
  const s = scanner();
  s.api.setRooms(300); s.api.addNodes(8);
  s.sandbox.setTimeout = (callback, ms) => { s.advance(ms); return setTimeout(callback, 0); };
  vm.runInContext('CFG.spreadNodeBudget = true; CFG.delayMs = 90; CFG.hotIntervalMs = 15000;', s.sandbox);
  for (let i = 0; i < 8; i++) s.api.nodeState.get('node' + i).lastIp = '192.0.2.' + (i + 1);
  const t = Date.parse('2026-11-06T12:00:00+08:00');
  Object.assign(s.api.pool.get('1000'), { lastBatteryHit: t, lastAttempt: t - 20000,
    batteryValueEvidence: [{ id: 'known', at: t, perPerson: 20 }] });
  await s.api.runRound(1, Array.from({ length: 8 }, (_, i) => 'node' + i));
  const rows = s.store.db.prepare("SELECT room_id,tier,started_at FROM requests WHERE kind='rp' ORDER BY started_at").all();
  const hot = rows.filter(r => r.room_id === '1000');
  assert.equal(rows.length, 109);
  assert.ok(hot.length >= 2);
  for (let i = 1; i < hot.length; i++) assert.ok(hot[i].started_at - hot[i - 1].started_at >= 15000);
  assert.ok(rows.filter(r => r.tier === 'COLD').length >= Math.ceil(109 * .3));
  assert.equal(s.api.nodeState.get('node0').used, 110);
  assert.ok(s.api.state.scheduling.hotRechecks > 0);
  assert.equal(s.api.state.stats.errors, 0);
});

test('pausing during a paced round drains requests and stops future time slots', async () => {
  const s = scanner(url => {
    if (url.includes('RedPocketGetInfo')) s.setScanSettings(false);
    return { code: 0, data: { lot_info: [] } };
  });
  s.api.setRooms(300); s.api.addNodes(8);
  s.sandbox.setTimeout = (callback, ms) => { s.advance(ms); return setTimeout(callback, 0); };
  vm.runInContext('CFG.spreadNodeBudget = true; CFG.delayMs = 90;', s.sandbox);
  for (let i = 0; i < 8; i++) s.api.nodeState.get('node' + i).lastIp = '192.0.2.' + (i + 1);
  await s.api.runRound(1, Array.from({ length: 8 }, (_, i) => 'node' + i));
  assert.ok(s.calls.length <= 6);
  assert.equal(s.api.state.scan.inFlight, 0);
  assert.equal(s.api.state.phase, 'paused');
  assert.equal(s.store.query('requests', { outcome: 'pending' }).items.length, 0);
});

test('heartbeat summaries reuse membership while source changes and time expiry stay visible', () => {
  const s = scanner(); s.api.setRooms(200);
  const room = s.api.pool.get('1000'), t = Date.parse('2026-11-06T12:00:00+08:00');
  room.hotRankPriority = { at: t, rank: 1, score: 10 };
  const iterate = s.api.pool[Symbol.iterator].bind(s.api.pool);
  let scans = 0;
  s.api.pool[Symbol.iterator] = function () { scans++; return iterate(); };
  s.api.writeState();
  assert.equal(s.api.state.hotRank.active, 1);
  const afterFirst = scans;
  s.api.writeState(); s.api.writeState();
  assert.equal(scans, afterFirst);
  s.advance(900001); s.api.writeState();
  assert.equal(s.api.state.hotRank.active, 0);
  assert.equal(scans, afterFirst);
  room.qqPushes = 1; room.qqLastAt = t;
  s.api.savePool(); s.api.writeState();
  assert.equal(s.api.state.qq.batteryRooms, 1);
  assert.ok(scans > afterFirst);
});
