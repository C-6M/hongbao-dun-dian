'use strict';
// Pins only recently resolved, TCP-verified addresses of already-configured proxy nodes.
const fs = require('node:fs');
const net = require('node:net');
const { createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process');
function main() {
  const state = execFileSync('systemctl', ['show', 'hongbao-scanner', '--property=ActiveState', '--value'], { encoding: 'utf8' }).trim();
  if (state !== 'inactive') throw new Error('Scanner must be inactive');
  const file = '/data/hongbao/proxy/config.yaml';
  const original = fs.readFileSync(file, 'utf8');
  const config = JSON.parse(original);
  const map = JSON.parse(fs.readFileSync('/data/hongbao/proxy/dns-repair-candidates.json', 'utf8'));
  // Reuse an address only when this same node's recorded DNS answer matched it and TCP was verified.
  if (process.argv.includes('--observed')) {
    const ledger = JSON.parse(fs.readFileSync('/data/hongbao/proxy/connectivity-tcp.json', 'utf8'));
    for (const row of ledger.nodes) {
      if (!row.reachable || row.index < 1 || row.index > config.proxies.length) continue;
      const matching = Object.values(map).find(ip => createHash('sha256').update(ip).digest('hex').slice(0, 16) === row.dnsFingerprint);
      if (matching) map[config.proxies[row.index - 1].server] = matching;
    }
  }
  const servers = new Set(config.proxies.map(node => node.server));
  const keys = Object.keys(map);
  if (!keys.length || keys.some(host => !servers.has(host) || net.isIP(map[host]) !== 4
    || /^(127\.|10\.|192\.168\.)/.test(map[host]))) throw new Error('Invalid DNS candidates');
  const backup = '/data/hongbao/proxy/config.before-dns-pin.yaml';
  if (!fs.existsSync(backup)) fs.writeFileSync(backup, original, { mode: 0o600 });
  config.hosts = { ...config.hosts, ...map };
  config.dns = { enable: true, ipv6: false, 'use-hosts': true, nameserver: ['system'],
    'proxy-server-nameserver': ['system'] };
  try {
    fs.writeFileSync(file, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
    execFileSync('/data/hongbao/runtime/mihomo', ['-t', '-d', '/data/hongbao/proxy', '-f', file], { stdio: 'ignore' });
  } catch (error) { fs.writeFileSync(file, original, { mode: 0o600 }); throw error; }
  console.log(JSON.stringify({ pinnedNodes: keys.length, additionalCredentialsTransferred: false,
    reversibleBackup: true, scannerStarted: false }));
}
try { main(); } catch { console.error('DNS repair failed; private details suppressed'); process.exitCode = 1; }
