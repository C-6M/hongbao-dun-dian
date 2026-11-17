'use strict';
// Isolated local comparison: no active profile, system proxy or scanner is changed.
const fs = require('node:fs');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const { spawn, execFile } = require('node:child_process');
const { promisify } = require('node:util');
const run = promisify(execFile);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function main() {
  if (process.platform !== 'win32') throw new Error('Windows comparison only');
  const binary = 'C:/Users/16586/Downloads/Clash.for.Windows-0.20.16.4-ikuuu/Clash.for.Windows-0.20.16-ikuuu/resources/static/files/win/x64/clash-win64.exe';
  const nodes = require('./proxy-config').generateNodePayload().proxies;
  const dir = fs.mkdtempSync(path.join(process.env.LOCALAPPDATA, 'hongbao-proxy-check-'));
  const secret = randomBytes(24).toString('hex');
  const controller = 'http://127.0.0.1:19097';
  const proxy = 'http://127.0.0.1:17897';
  const file = path.join(dir, 'config.yaml');
  fs.writeFileSync(file, JSON.stringify({ 'mixed-port': 17897, 'external-controller': '127.0.0.1:19097',
    'bind-address': '127.0.0.1', 'allow-lan': false, secret, ipv6: false, mode: 'rule',
    'log-level': 'silent', proxies: nodes, 'proxy-groups': [{ name: 'isolated-check', type: 'select',
      proxies: nodes.map(n => n.name) }], rules: ['MATCH,isolated-check'] }));
  const child = spawn(binary, ['-d', dir, '-f', file], { stdio: 'ignore', windowsHide: true });
  const headers = { Authorization: 'Bearer ' + secret, 'Content-Type': 'application/json' };
  const rows = [], exits = new Map();
  async function query(url) {
    let stdout = '', curlExit = 0;
    try { ({ stdout } = await run('C:/Windows/System32/curl.exe', ['-sS', '-m', '12', '--connect-timeout', '5',
      '-x', proxy, '-w', '\n@@@%{http_code}', '-H', 'user-agent: Mozilla/5.0', url],
    { timeout: 15000, windowsHide: true, maxBuffer: 1048576 })); }
    catch (error) { stdout = error.stdout || ''; curlExit = typeof error.code === 'number' ? error.code : -1; }
    const split = stdout.lastIndexOf('\n@@@');
    let json; try { json = JSON.parse(stdout.slice(0, split)); } catch {}
    return { curlExit, http: split >= 0 ? Number(stdout.slice(split + 4)) : 0, json };
  }
  try {
    let ready = false;
    for (let i = 0; i < 20; i++) {
      await pause(250);
      try { ready = (await fetch(controller + '/version', { headers })).ok; } catch {}
      if (ready) break;
    }
    if (!ready) throw new Error('Isolated controller unavailable');
    const indexArg = process.argv.indexOf('--index');
    const onlyIndex = indexArg >= 0 ? Number(process.argv[indexArg + 1]) : null;
    for (const [i, node] of nodes.entries()) {
      if (onlyIndex !== null && i + 1 !== onlyIndex) continue;
      const switched = await fetch(controller + '/proxies/isolated-check', { method: 'PUT', headers,
        body: JSON.stringify({ name: node.name }) });
      if (switched.status !== 204) throw new Error('Switch failed');
      await pause(700);
      const z = await query('https://api.bilibili.com/x/web-interface/zone');
      const addr = z.json?.code === 0 ? z.json?.data?.addr : null;
      const good = z.curlExit === 0 && z.http === 200 && typeof addr === 'string';
      const row = { index: i + 1, zone: { curlExit: z.curlExit, http: z.http,
        apiCode: z.json?.code ?? null, success: good } };
      if (good) {
        if (!exits.has(addr)) exits.set(addr, exits.size + 1);
        row.exitGroup = exits.get(addr);
        const rp = await query('https://api.live.bilibili.com/xlive/lottery-interface/v1/popularityRedPocket/RedPocketGetInfo?room_id=6');
        row.redpocket = { curlExit: rp.curlExit, http: rp.http, apiCode: rp.json?.code ?? null,
          lotInfoKind: rp.json?.data?.lot_info === null ? 'null' : typeof rp.json?.data?.lot_info,
          validSchema: rp.json?.data?.lot_info === null || Array.isArray(rp.json?.data?.lot_info) };
      }
      rows.push(row);
    }
    console.log(JSON.stringify({ at: new Date().toISOString(), nodes: rows, distinctExits: exits.size,
      activeDesktopProfileChanged: false, credentialsPrinted: false }, null, 2));
  } finally {
    if (child.exitCode === null) {
      const closed = new Promise(resolve => child.once('close', resolve));
      child.kill(); await closed;
    }
    // Remove only this freshly created private test directory, inside LOCALAPPDATA.
    const expectedParent = path.resolve(process.env.LOCALAPPDATA);
    if (path.dirname(path.resolve(dir)) !== expectedParent || !path.basename(dir).startsWith('hongbao-proxy-check-')) {
      throw new Error('Unexpected temporary cleanup path');
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
main().catch(() => { console.error('Local HTTP comparison failed; private details suppressed'); process.exitCode = 1; });
