'use strict';
// Bounded DNS sampling on the eight already-authorized nodes; stores only validated endpoints privately.
const fs = require('node:fs');
const dns = require('node:dns/promises');
const net = require('node:net');
const { createHash } = require('node:crypto');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
function tcp(ip, port) {
  return new Promise(resolve => {
    const socket = net.createConnection({ host: ip, port });
    let done = false;
    const finish = code => { if (done) return; done = true; socket.destroy(); resolve(code); };
    socket.setTimeout(4000, () => finish('TIMEOUT'));
    socket.once('connect', () => finish('OK'));
    socket.once('error', error => finish(error.code || 'ERROR'));
  });
}
async function main() {
  const config = JSON.parse(fs.readFileSync('/data/hongbao/proxy/config.yaml', 'utf8'));
  const rows = [], usable = {};
  for (let start = 0; start < config.proxies.length; start += 4) {
    rows.push(...await Promise.all(config.proxies.slice(start, start + 4).map(async (node, offset) => {
      const seen = new Map();
      const slow = process.argv.includes('--slow');
      if (slow && ![2, 3, 4].includes(start + offset + 1)) return { index: start + offset + 1, skipped: true };
      for (let i = 0; i < (slow ? 5 : 8); i++) {
        try {
          const addresses = await dns.resolve4(node.server, { ttl: true });
          for (const { address, ttl } of addresses) {
            if (seen.has(address)) continue;
            const isLoopback = address.startsWith('127.');
            const code = isLoopback ? 'SKIPPED_LOOPBACK' : await tcp(address, node.port);
            seen.set(address, { fingerprint: createHash('sha256').update(address).digest('hex').slice(0, 16),
              ttl, code });
            if (code === 'OK') usable[node.server] ||= address;
          }
        } catch {}
        if (i < (slow ? 4 : 7)) await pause(slow ? 12000 : 200);
      }
      return { index: start + offset + 1, answers: [...seen.values()], reachable: Boolean(usable[node.server]) };
    })));
  }
  const result = { at: new Date().toISOString(), samplesPerNode: process.argv.includes('--slow') ? 5 : 8, nodes: rows,
    tcpReachableNodes: Object.keys(usable).length, credentialsPrinted: false };
  const previous = fs.existsSync('/data/hongbao/proxy/dns-repair-candidates.json')
    ? JSON.parse(fs.readFileSync('/data/hongbao/proxy/dns-repair-candidates.json', 'utf8')) : {};
  fs.writeFileSync('/data/hongbao/proxy/dns-repair-candidates.json', JSON.stringify({ ...previous, ...usable }) + '\n', { mode: 0o600 });
  fs.writeFileSync('/data/hongbao/proxy/dns-sampling.json', JSON.stringify(result, null, 2) + '\n', { mode: 0o600 });
  console.log(JSON.stringify(result, null, 2));
}
main().catch(() => { console.error('DNS sampling failed; private details suppressed'); process.exitCode = 1; });
