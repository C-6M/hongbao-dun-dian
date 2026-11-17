'use strict';
// Accept endpoint metadata only. Results containing endpoints remain private on the cloud.
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { sampleCandidates, publicIPv4 } = require('./node-health');
const run = promisify(execFile);
const root = '/data/hongbao';
const providers = ['https://dns.google/resolve', 'https://cloudflare-dns.com/dns-query'];
async function resolve(host) {
  if (net.isIP(host)) return [{ source: 'literal', addresses: [{ address: host }] }];
  return Promise.all(providers.map(async provider => {
    try {
      const { stdout } = await run('curl', ['-fsS', '-m', '10', '--connect-timeout', '5',
        '--proxy', 'http://127.0.0.1:7890', '-H', 'accept: application/dns-json',
        provider + '?name=' + encodeURIComponent(host) + '&type=A'], { timeout: 12000, maxBuffer: 262144 });
      const json = JSON.parse(stdout);
      if (json.Status !== 0) throw new Error('DNS status');
      return { source: provider + '#via-current-proxy', addresses: (json.Answer || [])
        .filter(row => row.type === 1).map(row => ({ address: row.data, ttl: row.TTL })) };
    } catch { return { source: provider + '#via-current-proxy', failed: true, addresses: [] }; }
  }));
}
function tcp(address, port) {
  return new Promise(resolve => {
    const started = Date.now(), socket = net.createConnection({ host: address, port });
    let done = false;
    const finish = ok => { if (done) return; done = true; socket.destroy(); resolve({ ok, elapsedMs: Date.now() - started }); };
    socket.setTimeout(4000, () => finish(false));
    socket.once('connect', () => finish(true)); socket.once('error', () => finish(false));
  });
}
async function main() {
  if (process.platform !== 'linux' || path.resolve(__dirname, '..') !== root) throw new Error('Cloud required');
  const payload = JSON.parse(fs.readFileSync(0, 'utf8'));
  if (Object.keys(payload).length !== 1 || !Array.isArray(payload.nodes) || payload.nodes.length > 34
    || !payload.nodes.length || new Set(payload.nodes.map(n => n.index)).size !== payload.nodes.length
    || payload.nodes.some(n => !Number.isInteger(n.index) || n.index < 13 || n.index > 46
      || !['ss', 'vmess'].includes(n.type) || typeof n.server !== 'string' || !n.server
      || !Number.isInteger(n.port) || n.port < 1 || n.port > 65535
      || (n.localAddresses && (!Array.isArray(n.localAddresses) || n.localAddresses.length > 6
        || n.localAddresses.some(address => !publicIPv4(address))))
      || Object.keys(n).some(key => !['index', 'server', 'port', 'type', 'localAddresses'].includes(key)))) throw new Error('Metadata invalid');
  const localOnly = payload.nodes.every(n => Array.isArray(n.localAddresses));
  const rows = await sampleCandidates(payload.nodes.map(n => ({ ...n, name: 'candidate-' + n.index })), {
    resolve: localOnly ? async host => [{ source: 'local-system-dns', addresses: [...new Set(payload.nodes
      .filter(n => n.server === host).flatMap(n => n.localAddresses))].map(address => ({ address })) }] : resolve, tcp });
  const file = root + '/proxy/eight-exits-screening' + (localOnly ? '-local' : '') + '.json';
  fs.writeFileSync(file, JSON.stringify({ at: new Date().toISOString(), rows }) + '\n', { mode: 0o600 });
  fs.chmodSync(file, 0o600);
  console.log(JSON.stringify({ at: new Date().toISOString(), screened: rows.length,
    passed: rows.filter(n => n.candidates.length).map(n => ({ index: n.index, type: n.type,
      addresses: n.candidates.filter(c => publicIPv4(c.address)).length })),
    rows: rows.map(n => ({ index: n.index, type: n.type, tcpCandidates: n.candidates.length,
      dnsErrors: n.dnsErrors, rejectedAnswers: n.rejectedAnswers })), apiQueriesMade: false, credentialsTransferred: false }));
}
if (require.main === module) main().catch(() => { console.error('Candidate screening failed; private details suppressed'); process.exitCode = 1; });
