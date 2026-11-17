'use strict';
const { execFileSync, execFile } = require('node:child_process');
const { promisify } = require('node:util');
const net = require('node:net');
const fs = require('node:fs');
const run = promisify(execFile);
function localEndpoint(value, name) {
  let url;
  try { url = new URL(value); } catch { throw new Error(name + ' is required'); }
  if (url.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
    || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error(name + ' must be a loopback HTTP endpoint without embedded credentials');
  }
  return url.origin;
}
function validateConfig(env) {
  const controller = localEndpoint(env.SCANNER_CLASH_API, 'SCANNER_CLASH_API');
  const proxy = localEndpoint(env.SCANNER_PROXY, 'SCANNER_PROXY');
  if (!env.SCANNER_CLASH_GROUP?.trim()) throw new Error('SCANNER_CLASH_GROUP is required');
  return { controller, proxy, group: env.SCANNER_CLASH_GROUP,
    secret: env.SCANNER_CLASH_SECRET || '' };
}
async function checkController(config, request = fetch) {
  const response = await request(config.controller + '/proxies', {
    headers: { Authorization: 'Bearer ' + config.secret }, signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) throw new Error('Controller check failed: HTTP ' + response.status);
  const json = await response.json();
  const all = json.proxies?.[config.group]?.all;
  if (!Array.isArray(all)) throw new Error('Configured controller group is missing');
  const count = new Set(all.filter(name => name !== 'DIRECT' && name !== 'REJECT')).size;
  if (count < 3) throw new Error('At least three configured nodes are required; got ' + count);
  // Group membership does not prove reachability or distinct exit IPs.
  return { configuredNodes: count, exitsVerified: false };
}
async function queryViaProxy(url, config) {
  let stdout = '', failure;
  try { ({ stdout } = await run('curl', ['-sS', '-m', '10', '--connect-timeout', '5', '-x', config.proxy,
    '-H', 'user-agent: Mozilla/5.0', '-w', '\n###%{http_code}', url],
  { timeout: 13000, maxBuffer: 1048576 })); }
  catch (error) { failure = error; stdout = error.stdout || ''; }
  return require('../core/http-result').parseHttpResult(stdout, failure);
}
function validRedpocket(result) {
  const lots = result.data?.lot_info;
  return result.status === 'OK' && result.code === 0 && (lots === null || Array.isArray(lots)
    && lots.every(lot => lot?.lot_id && (lot.awards == null || Array.isArray(lot.awards)
      && lot.awards.every(award => award && typeof award === 'object'))));
}
async function checkLiveExits(config, { request = fetch, query = queryViaProxy,
  settle = () => new Promise(resolve => setTimeout(resolve, 700)) } = {}) {
  const groupUrl = config.controller + '/proxies/' + encodeURIComponent(config.group);
  const headers = { Authorization: 'Bearer ' + config.secret, 'Content-Type': 'application/json' };
  const read = await request(groupUrl, { headers, signal: AbortSignal.timeout(5000) });
  if (!read.ok) throw new Error('Live exit group unavailable');
  const group = await read.json();
  const names = [...new Set((group.all || []).filter(name => !['DIRECT', 'REJECT'].includes(name)))];
  if (names.length < 3 || names.length > 8) throw new Error('Live exit group requires 3 to 8 concrete nodes');
  const exits = new Set();
  let verifiedNodes = 0;
  async function probe(url) {
    let result = await query(url, config);
    // Startup only: one bounded retry for transport failures, never for a ban or business error.
    if (result.status === 'NETWORK') { await settle(); result = await query(url, config); }
    return result;
  }
  try {
    for (const name of names) {
      const switched = await request(groupUrl, { method: 'PUT', headers, body: JSON.stringify({ name }),
        signal: AbortSignal.timeout(5000) });
      if (switched.status !== 204) throw new Error('Live exit switch failed');
      await settle();
      const zone = await probe('https://api.bilibili.com/x/web-interface/zone');
      const ip = zone.data?.addr;
      if (zone.status !== 'OK' || zone.code !== 0 || !net.isIP(ip || '') || /^(127\.|::1$)/.test(ip)) continue;
      const rp = await probe('https://api.live.bilibili.com/xlive/lottery-interface/v1/popularityRedPocket/RedPocketGetInfo?room_id=6');
      if (!validRedpocket(rp)) continue;
      verifiedNodes++; exits.add(ip);
    }
  } finally {
    if (group.now) {
      const restored = await request(groupUrl, { method: 'PUT', headers, body: JSON.stringify({ name: group.now }),
        signal: AbortSignal.timeout(5000) });
      if (restored.status !== 204) throw new Error('Live exit selection restore failed');
    }
  }
  if (verifiedNodes !== names.length || exits.size < 3) {
    throw new Error('Every selected node must query Bilibili; at least three distinct live exits required'
      + ' (working=' + verifiedNodes + ', exits=' + exits.size + ')');
  }
  return { verifiedNodes, distinctExits: exits.size, exitsVerified: true };
}
async function main() {
  if (process.platform !== 'linux') throw new Error('This deployment bundle targets Linux');
  const scannerState = execFileSync('systemctl', ['show', 'hongbao-scanner', '--property=ActiveState', '--value'],
    { encoding: 'utf8' }).trim();
  if (['active', 'reloading'].includes(scannerState)) throw new Error('Stop scanner before live exit preflight');
  const lockFile = '/data/hongbao/data/scanner.lock';
  if (fs.existsSync(lockFile)) {
    const lock = JSON.parse(fs.readFileSync(lockFile, 'utf8'));
    const command = '/proc/' + Number(lock.pid) + '/cmdline';
    if (fs.existsSync(command) && fs.readFileSync(command, 'utf8').includes('/data/hongbao/core/spider.js')) {
      throw new Error('Stop the manual scanner before live exit preflight');
    }
  }
  if (Number(process.versions.node.split('.')[0]) < 24) throw new Error('Node.js 24+ is required');
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(':memory:'); db.exec('SELECT 1'); db.close();
  execFileSync('curl', ['--version'], { stdio: 'ignore' });
  const config = validateConfig(process.env);
  const status = await checkController(config);
  const live = await checkLiveExits(config);
  console.log(JSON.stringify({ ok: true, node: process.versions.node, ...status, ...live }));
}
module.exports = { localEndpoint, validateConfig, checkController, checkLiveExits, queryViaProxy, validRedpocket };
if (require.main === module) main().catch(error => {
  console.error('Preflight: ' + error.message); process.exitCode = 1;
});
