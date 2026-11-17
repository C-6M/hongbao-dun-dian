'use strict';
// Never print node names, server addresses, credentials, exit IPs or raw proxy logs.
const fs = require('node:fs');
const net = require('node:net');
const dns = require('node:dns/promises');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { createHash } = require('node:crypto');
const run = promisify(execFile);
const local = process.argv.includes('--local');
const http = process.argv.includes('--http');
const metadata = process.argv.includes('--metadata');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function timedLookup(host) {
  let timer;
  try {
    return await Promise.race([dns.lookup(host, { all: true }),
      new Promise((_, reject) => { timer = setTimeout(() => reject({ code: 'DNS_TIMEOUT' }), 5000); })]);
  } finally { clearTimeout(timer); }
}
function tcp(host, port) {
  return new Promise(resolve => {
    const started = Date.now();
    const socket = net.createConnection({ host, port });
    let done = false;
    const finish = code => {
      if (done) return;
      done = true; socket.destroy();
      resolve({ reachable: code === 'OK', code, elapsedMs: Date.now() - started });
    };
    socket.setTimeout(5000, () => finish('TCP_TIMEOUT'));
    socket.once('connect', () => finish('OK'));
    socket.once('error', error => finish(error.code || 'TCP_ERROR'));
  });
}
async function tcpProbe(node, index) {
  let addresses;
  try { addresses = await timedLookup(node.server); }
  catch (error) { return { index, reachable: false, code: error.code || 'DNS_ERROR' }; }
  const ipv4 = addresses.filter(row => row.family === 4);
  const probes = await Promise.all(ipv4.slice(0, 3).map(row => tcp(row.address, node.port)));
  const categories = ipv4.map(row => {
    const ip = row.address.split('.').map(Number);
    if (ip[0] === 127) return 'loopback';
    if (ip[0] === 10 || ip[0] === 192 && ip[1] === 168 || ip[0] === 172 && ip[1] >= 16 && ip[1] <= 31) return 'private';
    if (ip[0] === 198 && (ip[1] === 18 || ip[1] === 19)) return 'benchmark-fake-ip';
    return 'public';
  });
  return { index, dnsV4Count: ipv4.length, dnsV6Count: addresses.length - ipv4.length,
    addressCategories: categories, dnsFingerprint: createHash('sha256')
      .update(ipv4.map(row => row.address).sort().join(',')).digest('hex').slice(0, 16),
    reachable: probes.some(row => row.reachable), probes };
}
async function curlJson(url, proxy) {
  const args = ['-sS', '--max-time', '12', '--connect-timeout', '5',
    '--proxy', proxy, '--user-agent', 'Mozilla/5.0', '--write-out', '\n@@@%{http_code}', url];
  let stdout = '', curlExit = 0;
  try { ({ stdout } = await run('curl', args, { timeout: 15000, maxBuffer: 1048576 })); }
  catch (error) { stdout = error.stdout || ''; curlExit = typeof error.code === 'number' ? error.code : -1; }
  const split = stdout.lastIndexOf('\n@@@');
  const httpCode = split >= 0 ? Number(stdout.slice(split + 4)) : 0;
  let json;
  try { json = JSON.parse(split >= 0 ? stdout.slice(0, split) : stdout); } catch {}
  return { curlExit, httpCode, json };
}
async function main() {
  if (http && local) throw new Error('Cloud HTTP mode only');
  if (metadata && (local || http)) throw new Error('Cloud metadata TCP mode only');
  const config = local || metadata ? null : JSON.parse(fs.readFileSync('/data/hongbao/proxy/config.yaml', 'utf8'));
  const nodes = metadata ? JSON.parse(fs.readFileSync(0, 'utf8')).nodes
    : local ? require('./proxy-config').generateNodePayload().proxies : config.proxies;
  if (!Array.isArray(nodes) || nodes.length > 64 || nodes.some(node => typeof node.server !== 'string'
    || !Number.isInteger(node.port) || metadata && Object.keys(node).some(key => !['index', 'server', 'port', 'type'].includes(key)))) {
    throw new Error('Unexpected node metadata');
  }
  const rows = [];
  if (!http) {
    for (let start = 0; start < nodes.length; start += 4) {
      rows.push(...await Promise.all(nodes.slice(start, start + 4)
        .map((node, offset) => tcpProbe(node, node.index || start + offset + 1))));
    }
  } else {
    // Switching a shared controller group is allowed only while the scanner is stopped.
    const service = await run('systemctl', ['show', 'hongbao-scanner', '--property=ActiveState', '--value']);
    if (service.stdout.trim() !== 'inactive') throw new Error('Stop scanner before group diagnosis');
    const { validateConfig } = require('./preflight');
    const env = validateConfig(process.env);
    const headers = { Authorization: 'Bearer ' + env.secret, 'Content-Type': 'application/json' };
    const groupUrl = env.controller + '/proxies/' + encodeURIComponent(env.group);
    const initial = await (await fetch(groupUrl, { headers })).json();
    const exits = new Map();
    try {
      for (const [i, node] of nodes.entries()) {
        const indexArg = process.argv.indexOf('--index');
        if (indexArg >= 0 && i + 1 !== Number(process.argv[indexArg + 1])) continue;
        if (process.argv.includes('--pinned-only') && !config.hosts?.[node.server]) continue;
        const response = await fetch(groupUrl, { method: 'PUT', headers, body: JSON.stringify({ name: node.name }) });
        if (response.status !== 204) throw new Error('Controller rejected node switch');
        await wait(700);
        const zone = await curlJson('https://api.bilibili.com/x/web-interface/zone', env.proxy);
        const addr = zone.json?.code === 0 ? zone.json?.data?.addr : null;
        const good = zone.curlExit === 0 && zone.httpCode === 200 && typeof addr === 'string';
        const row = { index: i + 1, zone: { curlExit: zone.curlExit, http: zone.httpCode,
          apiCode: zone.json?.code ?? null, success: good } };
        if (good) {
          if (!exits.has(addr)) exits.set(addr, exits.size + 1);
          row.exitGroup = exits.get(addr);
          // One ordinary room query verifies API shape without starting continuous scanning.
          const pool = JSON.parse(fs.readFileSync('/data/hongbao/data/room-pool.json', 'utf8'));
          const room = Object.keys(pool.rooms || {}).find(id => /^\d+$/.test(id) && id !== '22748536');
          if (room) {
            const rp = await curlJson('https://api.live.bilibili.com/xlive/lottery-interface/v1/popularityRedPocket/RedPocketGetInfo?room_id=' + room, env.proxy);
            row.redpocket = { curlExit: rp.curlExit, http: rp.httpCode, apiCode: rp.json?.code ?? null,
              lotInfoKind: rp.json?.data?.lot_info === null ? 'null' : typeof rp.json?.data?.lot_info,
              validSchema: rp.json?.data?.lot_info === null || Array.isArray(rp.json?.data?.lot_info) };
          }
        }
        rows.push(row);
      }
    } finally {
      if (initial.now) await fetch(groupUrl, { method: 'PUT', headers, body: JSON.stringify({ name: initial.now }) });
    }
    rows.distinctExits = exits.size;
  }
  const result = { at: new Date().toISOString(), location: local ? 'desktop' : 'cloud',
    mode: http ? 'zone-and-single-room' : 'tcp', nodes: rows, distinctExits: rows.distinctExits,
    configSha256: config ? createHash('sha256').update(JSON.stringify(config)).digest('hex') : undefined,
    credentialsPrinted: false };
  if (!local) fs.writeFileSync('/data/hongbao/proxy/connectivity-' + (metadata ? 'remaining' : http ? 'http' : 'tcp') + '.json',
    JSON.stringify(result, null, 2) + '\n', { mode: 0o600 });
  console.log(JSON.stringify(result, null, 2));
}
main().catch(() => { console.error('Connectivity diagnosis failed; private details suppressed'); process.exitCode = 1; });
