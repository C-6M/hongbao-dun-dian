'use strict';
// Diagnose public node DNS without exposing endpoints or credentials.
const fs = require('node:fs');
const net = require('node:net');
const { createHash } = require('node:crypto');
const local = process.argv.includes('--local');
const fingerprint = ip => createHash('sha256').update(ip).digest('hex').slice(0, 16);
function isPublic(ip) {
  if (net.isIP(ip) !== 4) return false;
  const [a, b] = ip.split('.').map(Number);
  return a !== 0 && a !== 10 && a !== 127 && a < 224 && !(a === 169 && b === 254)
    && !(a === 172 && b >= 16 && b <= 31) && !(a === 192 && b === 168)
    && !(a === 198 && (b === 18 || b === 19));
}
function tcp(ip, port) {
  return new Promise(resolve => {
    const socket = net.createConnection({ host: ip, port });
    let done = false;
    const finish = code => { if (done) return; done = true; socket.destroy(); resolve(code); };
    socket.setTimeout(6000, () => finish('TIMEOUT'));
    socket.once('connect', () => finish('OK'));
    socket.once('error', error => finish(error.code || 'ERROR'));
  });
}
async function main() {
  const config = local ? null : JSON.parse(fs.readFileSync('/data/hongbao/proxy/config.yaml', 'utf8'));
  const nodes = local ? require('./proxy-config').generateNodePayload().proxies : config.proxies;
  const providers = [
    { name: 'alidns', base: 'https://dns.alidns.com/resolve' },
  ];
  const rows = [];
  const usable = {};
  for (let start = 0; start < nodes.length; start += 4) {
    rows.push(...await Promise.all(nodes.slice(start, start + 4).map(async (node, offset) => {
      const index = start + offset + 1;
      const answers = await Promise.all(providers.map(async provider => {
        try {
          const url = provider.base + '?name=' + encodeURIComponent(node.server) + '&type=A';
          const response = await fetch(url, { headers: { accept: 'application/dns-json' },
            signal: AbortSignal.timeout(8000) });
          const json = await response.json();
          const addresses = [...new Set((json.Answer || []).filter(row => row.type === 1).map(row => row.data))];
          const probes = await Promise.all(addresses.slice(0, 3).map(async ip => ({
            fingerprint: fingerprint(ip), category: isPublic(ip) ? 'public' : 'non-public',
            tcp: isPublic(ip) ? await tcp(ip, node.port) : 'SKIPPED', ip,
          })));
          for (const probe of probes) if (probe.tcp === 'OK') usable[node.server] ||= probe.ip;
          return { provider: provider.name, http: response.status, dnsStatus: json.Status,
            probes: probes.map(({ ip, ...safe }) => safe) };
        } catch (error) { return { provider: provider.name, failed: true,
          errorCode: error.cause?.code || error.code || error.name }; }
      }));
      return { index, answers };
    })));
  }
  const result = { at: new Date().toISOString(), location: local ? 'desktop' : 'cloud', nodes: rows,
    publicReachableNodes: Object.keys(usable).length, credentialsPrinted: false };
  if (!local) {
    fs.writeFileSync('/data/hongbao/proxy/dns-diagnostics.json', JSON.stringify(result, null, 2) + '\n', { mode: 0o600 });
    // Private endpoint mapping remains on the VM for a possible DNS repair.
    fs.writeFileSync('/data/hongbao/proxy/dns-usable.json', JSON.stringify(usable) + '\n', { mode: 0o600 });
  }
  console.log(JSON.stringify(result, null, 2));
}
main().catch(() => { console.error('DNS diagnosis failed; private details suppressed'); process.exitCode = 1; });
