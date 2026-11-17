'use strict';
const net = require('node:net');
const dns = require('node:dns/promises');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { publicIPv4 } = require('./node-health');
const run = promisify(execFile);
const providers = [
  { source: 'https://dns.google/dns-query', json: 'https://dns.google/resolve' },
  { source: 'https://cloudflare-dns.com/dns-query', json: 'https://cloudflare-dns.com/dns-query' },
];
function addresses(json) {
  if (json.Status !== 0) throw new Error('DNS response failure');
  return (json.Answer || []).filter(answer => answer.type === 1)
    .map(answer => ({ address: answer.data, ttl: answer.TTL }));
}
async function resolveNode(host, { proxy, request = fetch, execute = run,
  system = h => new dns.Resolver({ timeout: 2000, tries: 1 }).resolve4(h, { ttl: true }) } = {}) {
  if (net.isIP(host)) return [{ source: 'literal', addresses: [{ address: host }] }];
  const direct = await Promise.all([
    system(host).then(addresses => ({ source: 'system', addresses }))
      .catch(() => ({ source: 'system', failed: true, addresses: [] })),
    ...providers.map(async provider => {
      try {
        const response = await request(provider.json + '?name=' + encodeURIComponent(host) + '&type=A', {
          headers: { accept: 'application/dns-json' }, signal: AbortSignal.timeout(6000),
        });
        if (!response.ok) throw new Error('DNS HTTP failure');
        return { source: provider.source, addresses: addresses(await response.json()) };
      } catch { return { source: provider.source, failed: true, addresses: [] }; }
    }),
  ]);
  if (!proxy || direct.some(source => source.addresses.some(row => publicIPv4(row.address)))) return direct;
  const extra = await Promise.all(providers.map(async provider => {
    const source = provider.source + '#via-current-proxy';
    try {
      const { stdout } = await execute('curl', ['-fsS', '-m', '10', '--connect-timeout', '5', '--proxy', proxy,
        '-H', 'accept: application/dns-json', provider.json + '?name=' + encodeURIComponent(host) + '&type=A'],
      { timeout: 12000, maxBuffer: 262144 });
      return { source, addresses: addresses(JSON.parse(stdout)) };
    } catch { return { source, failed: true, addresses: [] }; }
  }));
  return [...direct, ...extra];
}
function verifiedResolvers(selected) {
  const sources = selected.flatMap(row => row.candidates.find(candidate => candidate.address === row.address)?.sources || []);
  return [...new Set(sources.map(source => source.split('#')[0]))]
    .filter(source => providers.some(provider => provider.source === source));
}
module.exports = { providers, resolveNode, verifiedResolvers };
