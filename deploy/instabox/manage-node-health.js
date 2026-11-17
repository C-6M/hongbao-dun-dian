'use strict';
// Runs only against the already-authorized private node configuration on the cloud machine.
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const { spawn, execFileSync } = require('node:child_process');
const { randomBytes, createHash } = require('node:crypto');
const { validateConfig, queryViaProxy } = require('./preflight');
const { publicIPv4, sampleCandidates, screenedHints, certifyNodes, chooseHealthy, safeSummary, monitoringIsEnough } = require('./node-health');
const { validateNodes, MAX_SELECTED_EXITS, pinAddress } = require('./authorized-nodes');
const { resolveNode, verifiedResolvers: selectResolvers } = require('./node-dns');
const root = '/data/hongbao', dir = root + '/proxy';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const read = (file, fallback) => fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : fallback;
function write(file, value) {
  const temporary = file + '.' + randomBytes(6).toString('hex') + '.tmp';
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(temporary, file); fs.chmodSync(file, 0o600);
}
function systemctl(...args) {
  return execFileSync('sudo', ['systemctl', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
}
function scannerStopped() {
  const state = systemctl('show', 'hongbao-scanner', '--property=ActiveState', '--value');
  if (!['inactive', 'failed'].includes(state)) throw new Error('Scanner must be stopped during maintenance');
  const lock = read(root + '/data/scanner.lock', null);
  if (lock && Number.isSafeInteger(lock.pid)) {
    const command = '/proc/' + lock.pid + '/cmdline';
    if (fs.existsSync(command) && fs.readFileSync(command, 'utf8').includes(root + '/core/spider.js')) {
      throw new Error('Manual scanner is still running');
    }
  }
}
function lockMaintenance() {
  const file = dir + '/node-health.lock';
  if (fs.existsSync(file)) {
    const old = read(file, {}), command = '/proc/' + Number(old.pid) + '/cmdline';
    if (fs.existsSync(command) && fs.readFileSync(command, 'utf8').includes('manage-node-health.js')) {
      throw new Error('Node maintenance already running');
    }
    fs.unlinkSync(file);
  }
  fs.writeFileSync(file, JSON.stringify({ pid: process.pid }), { flag: 'wx', mode: 0o600 });
  return () => fs.unlinkSync(file);
}
function runtimeStats(config) {
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(root + '/data/history.sqlite', { readOnly: true });
  try {
    db.exec('PRAGMA query_only=ON');
    const results = db.prepare(`SELECT node,COUNT(*) AS requests,
      SUM(CASE WHEN outcome IN ('hit','empty') THEN 1 ELSE 0 END) AS successes,
      MAX(finished_at) AS latest,
      AVG(duration_ms) AS mean_request_ms,
      MAX(CASE WHEN outcome IN ('hit','empty') THEN finished_at ELSE NULL END) AS latest_success
      FROM requests WHERE kind='rp' AND finished_at>=? GROUP BY node`)
      .all(Date.now() - 30 * 60000);
    const last = db.prepare("SELECT MAX(finished_at) AS at FROM requests WHERE kind IN ('rp','ip','anchor')").get().at || 0;
    const at = Date.now();
    const nodes = config.proxies.map((node, i) => {
      const row = results.find(row => row.node === node.name);
      return { index: i + 1, requests: row?.requests || 0, successes: row?.successes || 0,
        successRate: row?.requests ? row.successes / row.requests : null,
        meanRequestMs: row?.mean_request_ms ?? null,
        latest: row?.latest || null, latestSuccess: row?.latest_success || null };
    });
    const performance = nodes.map(row => ({ ...row, exit: db.prepare(`SELECT ip FROM requests
      WHERE node=? AND kind='rp' AND outcome IN ('hit','empty') ORDER BY finished_at DESC LIMIT 1`)
      .get(config.proxies[row.index - 1].name)?.ip }));
    return { at, lastRequestAt: last, nodes, performance };
  } finally { db.close(); }
}
function tcp(address, port) {
  return new Promise(resolve => {
    const started = Date.now(), socket = net.createConnection({ host: address, port });
    let done = false;
    const finish = ok => {
      if (done) return; done = true; socket.destroy(); resolve({ ok, elapsedMs: Date.now() - started });
    };
    socket.setTimeout(4000, () => finish(false));
    socket.once('connect', () => finish(true)); socket.once('error', () => finish(false));
  });
}
async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve)); return port;
}
async function temporaryProxy(config) {
  const folder = fs.mkdtempSync(dir + '/node-health-'); fs.chmodSync(folder, 0o700);
  const controllerPort = await freePort();
  let proxyPort = await freePort();
  while (proxyPort === controllerPort) proxyPort = await freePort();
  const isolated = structuredClone(config);
  isolated['external-controller'] = '127.0.0.1:' + controllerPort;
  isolated['mixed-port'] = proxyPort;
  isolated.secret = randomBytes(24).toString('hex');
  isolated['allow-lan'] = false; isolated['bind-address'] = '127.0.0.1';
  isolated['proxy-groups'] = [{ name: 'health-probes', type: 'select', proxies: config.proxies.map(node => node.name) }];
  isolated.rules = ['MATCH,health-probes'];
  const endpoint = { controller: 'http://127.0.0.1:' + controllerPort, proxy: 'http://127.0.0.1:' + proxyPort,
    group: 'health-probes', secret: isolated.secret };
  const headers = { Authorization: 'Bearer ' + endpoint.secret, 'Content-Type': 'application/json' };
  let child;
  async function stop() {
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    const exited = new Promise(resolve => child.once('exit', resolve));
    child.kill('SIGTERM');
    await Promise.race([exited, sleep(3000)]);
    if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exited; }
  }
  async function start() {
    write(folder + '/config.yaml', isolated);
    child = spawn(root + '/runtime/mihomo', ['-d', folder, '-f', folder + '/config.yaml'], { stdio: 'ignore' });
    let failed = false; child.once('error', () => { failed = true; });
    for (let i = 0; i < 30; i++) {
      if (failed || child.exitCode !== null) throw new Error('Temporary proxy could not start');
      try {
        const response = await fetch(endpoint.controller + '/proxies/health-probes', { headers, signal: AbortSignal.timeout(700) });
        if (response.ok) {
          const group = await response.json();
          if (isolated.proxies.every(node => group.all?.includes(node.name))) return;
        }
      } catch {}
      await sleep(300);
    }
    throw new Error('Temporary controller readiness timed out');
  }
  try { await start(); } catch (error) { await stop(); fs.rmSync(folder, { recursive: true, force: true }); throw error; }
  return { endpoint,
    switchNode: async name => {
      const response = await fetch(endpoint.controller + '/proxies/health-probes', { method: 'PUT', headers,
        body: JSON.stringify({ name }), signal: AbortSignal.timeout(3000) });
      if (response.status !== 204) throw new Error('Temporary node switch failed: HTTP ' + response.status);
      await sleep(700);
    },
    changeAddress: async (name, address) => {
      isolated.proxies.find(node => node.name === name).server = address;
      await stop(); await start();
    },
    close: async () => { await stop(); fs.rmSync(folder, { recursive: true, force: true }); },
  };
}
async function quietUntil(at) {
  const delay = Math.max(0, at + 180000 - Date.now());
  if (delay) { console.log(JSON.stringify({ stage: 'reuse-wait', seconds: Math.ceil(delay / 1000) })); await sleep(delay); }
}
async function main() {
  if (process.platform !== 'linux' || path.resolve(__dirname, '..') !== root) throw new Error('Cloud install required');
  const env = validateConfig(process.env), configFile = dir + '/config.yaml';
  const config = read(configFile, null), ledgerFile = dir + '/node-health-ledger.json';
  if (!config) throw new Error('Authorized node configuration missing');
  validateNodes(config.proxies);
  const release = lockMaintenance();
  let temporary;
  try {
    const previous = read(ledgerFile, { nodes: {}, sources: {} });
    const group = config['proxy-groups'].find(group => group.name === env.group);
    if (!group) throw new Error('Scanner group missing');
    const runtime = runtimeStats(config);
    const healthyRuntime = monitoringIsEnough({ nodes: runtime.nodes,
      selected: config.proxies.map((node, i) => group.proxies.includes(node.name) ? i + 1 : null).filter(Boolean),
      lastFullCheckAt: previous.lastFullCheckAt, configMatches: previous.configHash === hash(config),
      scannerActive: systemctl('show', 'hongbao-scanner', '--property=ActiveState', '--value') === 'active' });
    if (process.argv.includes('--scheduled') && healthyRuntime) {
      const report = { at: new Date().toISOString(), ok: true, monitoringOnly: true,
        selectedExits: group.proxies.length, runtime: runtime.nodes, privateDataPrinted: false };
      write(dir + '/node-health-summary.json', report); console.log(JSON.stringify(report)); return;
    }
    systemctl('stop', 'hongbao-scanner.service'); scannerStopped();
    const sources = {}, nodes = config.proxies.map((node, i) => {
      const old = previous.sources[node.name];
      if (old && (old.port !== node.port || old.type !== node.type)) throw new Error('Authorized node identity changed');
      sources[node.name] = old || { server: node.server, port: node.port, type: node.type };
      return { index: i + 1, name: node.name, ...sources[node.name] };
    });
    const addresses = Object.fromEntries(nodes.map(node => [node.name, {
      address: previous.nodes[node.name]?.address || config.hosts?.[node.server]
        || (publicIPv4(config.proxies[node.index - 1].server) ? config.proxies[node.index - 1].server : null),
    }]));
    console.log(JSON.stringify({ stage: 'dns-sampling', nodes: nodes.length, samples: 2, intervalSeconds: 12 }));
    const hints = screenedHints(nodes, ['eight-exits-screening.json', 'eight-exits-screening-local.json',
      'node-health-candidate-samples.json']
      .map(file => read(dir + '/' + file, null)));
    const candidates = await sampleCandidates(nodes, {
      resolve: host => resolveNode(host, { proxy: env.proxy }), tcp, previous: addresses, hints });
    write(dir + '/node-health-candidate-samples.json', { at: new Date().toISOString(), rows: candidates });
    console.log(JSON.stringify({ stage: 'tcp-complete', reachableNodes: candidates.filter(row => row.candidates.length).length,
      rejectedAnswers: candidates.reduce((sum, row) => sum + row.rejectedAnswers, 0) }));
    await quietUntil(Math.max(runtime.lastRequestAt, previous.lastProbeAt || 0));
    const probingConfig = structuredClone(config);
    probingConfig.proxies = probingConfig.proxies.map((node, i) =>
      pinAddress(node, candidates[i].candidates[0]?.address || nodes[i].server));
    temporary = await temporaryProxy(probingConfig);
    const cooldowns = structuredClone(previous.nodes);
    for (const node of read(root + '/data/live-state.json', {}).nodes || []) {
      if (node.bannedUntil > Date.now()) cooldowns[node.name] = {
        ...cooldowns[node.name], cooldownUntil: Math.max(node.bannedUntil, cooldowns[node.name]?.cooldownUntil || 0),
      };
    }
    const rows = await certifyNodes(candidates, {
      switchNode: temporary.switchNode, changeAddress: temporary.changeAddress,
      query: url => queryViaProxy(url, temporary.endpoint), previous: cooldowns,
      onRound: (round, rows) => console.log(JSON.stringify({ stage: 'http-round', round,
        passingNodes: rows.filter(row => row.passedRounds === round).length,
        failedNodes: rows.filter(row => row.reason).map(row => ({ index: row.index, reason: row.reason })) })),
    });
    const lastProbeAt = Date.now();
    const requireEight = process.argv.includes('--require-eight');
    const selection = chooseHealthy(rows, { maximum: MAX_SELECTED_EXITS, minimum: requireEight ? MAX_SELECTED_EXITS : 3,
      preferred: group.proxies,
      runtime: runtime.performance, observedAt: runtime.at });
    await temporary.close(); temporary = null;
    const updated = { version: 1, sources, nodes: Object.fromEntries(rows.map(row => [row.name, {
      index: row.index, address: row.address || previous.nodes[row.name]?.address,
      exit: row.exit, checkedAt: lastProbeAt, cooldownUntil: row.cooldownUntil,
      passedRounds: row.passedRounds, reason: row.reason, requests: row.requests, networkFailures: row.networkFailures,
    }])), lastFullCheckAt: Date.now(), lastProbeAt, configHash: hash(config) };
    const report = { at: new Date().toISOString(), ok: selection.ok, monitoringOnly: false,
      storedAuthorizedNodes: config.proxies.length, maximumSelectedExits: MAX_SELECTED_EXITS,
      requiredRounds: 3, healthyNodes: selection.healthyNodes,
      selectedExits: selection.selected.length, nodes: safeSummary(rows, selection.selected),
      selectionPolicy: selection.selectionPolicy, selectionRanking: selection.ranking,
      runtimeBefore: runtime.nodes, scannerStarted: false, configurationApplied: false, privateDataPrinted: false };
    // Preserve the actual probe time and cooldowns even if applying the configuration fails.
    write(ledgerFile, updated); write(dir + '/node-health-summary.json', report);
    if (!selection.ok) {
      write(ledgerFile, updated); write(dir + '/node-health-summary.json', report);
      console.log(JSON.stringify(report)); throw new Error('Fewer than ' + (requireEight ? 'eight' : 'three')
        + ' continuously verified independent exits; scanner remains stopped');
    }
    const desired = structuredClone(config);
    desired.proxies = desired.proxies.map((node, i) => {
      const selected = selection.selected.find(row => row.name === node.name);
      return pinAddress(node, selected?.address || nodes[i].server);
    });
    desired['proxy-groups'].find(group => group.name === env.group).proxies = selection.selected.map(row => row.name);
    const verifiedResolvers = selectResolvers(selection.selected);
    desired.dns = { ...desired.dns, enable: true, ipv6: false, 'use-hosts': true,
      nameserver: desired.dns?.nameserver || ['system'],
      'default-nameserver': ['1.1.1.1', '8.8.8.8'],
      'proxy-server-nameserver': verifiedResolvers.length ? verifiedResolvers : ['system'] };
    // Selected endpoints are per node, so shared domains with different ports do not overwrite each other.
    scannerStopped();
    if (!fs.existsSync(dir + '/config.before-node-health.yaml')) write(dir + '/config.before-node-health.yaml', config);
    write(dir + '/config.previous-node-health.yaml', config);
    try {
      write(configFile, desired);
      execFileSync(root + '/runtime/mihomo', ['-t', '-d', dir, '-f', configFile], { stdio: 'ignore' });
      systemctl('restart', 'hongbao-proxy.service');
    } catch (error) {
      write(configFile, config); systemctl('restart', 'hongbao-proxy.service'); throw error;
    }
    updated.configHash = hash(desired); write(ledgerFile, updated);
    report.dnsResolvers = verifiedResolvers.length; report.configurationApplied = true;
    write(dir + '/node-health-summary.json', report);
    // Diagnostic requests remain separate from scanner accounting and do not immediately precede a full scan batch.
    await quietUntil(lastProbeAt);
    systemctl('reset-failed', 'hongbao-scanner.service');
    systemctl('start', '--no-block', 'hongbao-scanner.service');
    report.scannerStartRequested = true;
    console.log(JSON.stringify({ stage: 'scanner-starting', selectedExits: selection.selected.length }));
    for (let i = 0; i < 85; i++) {
      const state = systemctl('show', 'hongbao-scanner', '--property=ActiveState', '--value');
      if (state === 'active') { report.scannerStarted = true; break; }
      if (['inactive', 'failed'].includes(state)) break;
      await sleep(5000);
    }
    report.at = new Date().toISOString();
    write(dir + '/node-health-summary.json', report); console.log(JSON.stringify(report));
    if (!report.scannerStarted) throw new Error('Scanner startup verification failed');
  } finally { if (temporary) await temporary.close(); release(); }
}
if (require.main === module) main().catch(error => {
  const safe = /^(Cloud install|Scanner |Manual scanner|Node maintenance already|Authorized node|Temporary |Fewer than (three|eight))/.test(error.message)
    ? error.message : 'inspect the sanitized summary; private details suppressed';
  console.error('Node maintenance failed: ' + safe); process.exitCode = 1;
});
