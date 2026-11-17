'use strict';
// Decisions are independent of files/services; endpoint details stay in the private ledger.
const net = require('node:net');
const { createHash } = require('node:crypto');
const { validRedpocket } = require('./preflight');
const fingerprint = value => createHash('sha256').update(value).digest('hex').slice(0, 16);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
function publicIPv4(ip) {
  if (net.isIP(ip) !== 4) return false;
  const [a, b, c] = ip.split('.').map(Number);
  return a > 0 && a < 224 && a !== 10 && a !== 127
    && !(a === 100 && b >= 64 && b <= 127) && !(a === 169 && b === 254)
    && !(a === 172 && b >= 16 && b <= 31) && !(a === 192 && b === 168)
    && !(a === 192 && b === 0 && [0, 2].includes(c))
    && !(a === 198 && [18, 19].includes(b)) && !(a === 198 && b === 51 && c === 100)
    && !(a === 203 && b === 0 && c === 113);
}
async function sampleCandidates(nodes, { resolve, tcp, wait = pause, rounds = 2,
  intervalMs = 12000, now = Date.now, previous = {}, hints = {} } = {}) {
  const rows = nodes.map(node => ({ index: node.index, name: node.name, type: node.type, server: node.server,
    port: node.port, rejectedAnswers: 0, dnsErrors: 0, candidates: new Map() }));
  for (let round = 0; round < rounds; round++) {
    const answers = new Map();
    for (let start = 0; start < rows.length; start += 4) {
      await Promise.all(rows.slice(start, start + 4).map(async row => {
        if (!answers.has(row.server)) answers.set(row.server, resolve(row.server).catch(() => []));
        const sources = await answers.get(row.server);
        row.dnsErrors += sources.filter(source => source.failed).length;
        const pinned = previous[row.name]?.address;
        const pools = [{ source: 'previous-verified', addresses: pinned ? [{ address: pinned }] : [] },
          ...sources, ...(hints[row.name] || [])];
        // Round-robin providers so an unusable system answer cannot crowd out independent DNS.
        for (let i = 0; i < 3; i++) for (const source of pools) {
          const item = source.addresses?.[i];
          if (!item) continue;
          if (!publicIPv4(item.address)) { row.rejectedAnswers++; continue; }
          if (!row.candidates.has(item.address) && row.candidates.size < 6) {
            row.candidates.set(item.address, { address: item.address, firstObservedAt: now(),
              sources: [], tcpPasses: 0, tcpAttempts: 0, elapsedMs: 0 });
          }
          const candidate = row.candidates.get(item.address);
          if (candidate && !candidate.sources.includes(source.source)) candidate.sources.push(source.source);
        }
        await Promise.all([...row.candidates.values()].map(async candidate => {
          const result = await tcp(candidate.address, row.port);
          candidate.tcpAttempts++;
          if (result.ok) { candidate.tcpPasses++; candidate.elapsedMs += result.elapsedMs || 0; }
        }));
      }));
    }
    if (round < rounds - 1) await wait(intervalMs);
  }
  return rows.map(row => ({ ...row, candidates: [...row.candidates.values()]
    .filter(candidate => candidate.tcpPasses === rounds)
    .sort((a, b) => Number(b.sources.includes('previous-verified')) - Number(a.sources.includes('previous-verified'))
      || a.elapsedMs - b.elapsedMs) }));
}
function screenedHints(nodes, reports, now = Date.now()) {
  const hints = {};
  for (const report of reports) {
    const at = Date.parse(report?.at);
    if (!Number.isFinite(at) || at > now || now - at > 10 * 60000 || !Array.isArray(report.rows)) continue;
    for (const node of nodes) for (const row of report.rows) {
      if (row.server !== node.server || row.port !== node.port || row.type !== node.type) continue;
      for (const candidate of row.candidates || []) {
        if (!publicIPv4(candidate.address) || candidate.tcpPasses !== 2 || candidate.tcpAttempts !== 2) continue;
        for (const source of candidate.sources || []) {
          if (source !== 'local-system-dns' && !String(source).endsWith('#via-current-proxy')) continue;
          (hints[node.name] ||= []).push({ source, addresses: [{ address: candidate.address }] });
        }
      }
    }
  }
  return hints;
}
async function certifyNodes(nodes, { switchNode, query, changeAddress, wait = pause,
  rounds = 3, intervalMs = 12000, now = Date.now, previous = {}, onRound = () => {} } = {}) {
  const rows = nodes.map(node => ({ ...node, address: node.candidates[0]?.address,
    passedRounds: 0, requests: 0, validRequests: 0, networkFailures: 0, retries: 0, elapsedMs: 0,
    reason: '', exit: '', cooldownUntil: 0 }));
  async function probe(url, row) {
    const started = now();
    let result;
    for (let attempt = 0; attempt < 2; attempt++) {
      row.requests++;
      result = await query(url);
      if (result.status !== 'NETWORK') break;
      row.networkFailures++;
      if (attempt === 0) { row.retries++; await wait(700); }
    }
    row.elapsedMs += Math.max(0, now() - started);
    return result;
  }
  async function check(row) {
    await switchNode(row.name);
    const zone = await probe('https://api.bilibili.com/x/web-interface/zone', row);
    if (zone.status !== 'OK' || zone.code !== 0 || !publicIPv4(zone.data?.addr)) {
      return zone.status === 'OK' ? 'ZONE_SCHEMA' : zone.status;
    }
    const ip = zone.data.addr;
    row.validRequests++;
    if (row.exit && row.exit !== ip) return 'EXIT_CHANGED';
    row.exit = ip;
    const rp = await probe('https://api.live.bilibili.com/xlive/lottery-interface/v1/popularityRedPocket/RedPocketGetInfo?room_id=6', row);
    if (!validRedpocket(rp)) return rp.status === 'OK' ? 'REDPOCKET_SCHEMA' : rp.status;
    row.validRequests++;
    return '';
  }
  for (let round = 0; round < rounds; round++) {
    for (const row of rows) {
      if (row.reason) continue;
      const old = previous[row.name];
      if (old?.cooldownUntil > now()) { row.reason = 'COOLDOWN'; row.cooldownUntil = old.cooldownUntil; continue; }
      if (!row.address) { row.reason = 'DNS_OR_TCP'; row.cooldownUntil = now() + 10 * 60000; continue; }
      let reason = await check(row);
      // One alternate endpoint, only for transport failure, after validating that same node's DNS/TCP.
      if (reason === 'NETWORK' && round === 0 && row.candidates[1] && changeAddress) {
        row.address = row.candidates[1].address;
        row.exit = '';
        await changeAddress(row.name, row.address);
        reason = await check(row);
      }
      if (reason) {
        row.reason = reason;
        row.cooldownUntil = now() + (reason === 'BANNED' ? 15 : 10) * 60000;
      } else row.passedRounds++;
    }
    await onRound(round + 1, rows);
    if (round < rounds - 1) await wait(intervalMs);
  }
  return rows;
}
function selectionCost(row, { runtime = [], observedAt = Date.now(), preferred = [], retentionFactor = .85 } = {}) {
  const recent = runtime.find(sample => sample.index === row.index && sample.exit === row.exit);
  const useRuntime = recent && recent.requests >= 20 && recent.successRate > 0 && recent.successRate <= 1
    && recent.latestSuccess <= observedAt && observedAt - recent.latestSuccess < 5 * 60000
    && Number.isFinite(recent.meanRequestMs) && recent.meanRequestMs > 0;
  const valid = row.validRequests ?? Math.max(0, (row.requests || 0) - (row.networkFailures || 0));
  const estimate = useRuntime ? recent.meanRequestMs / recent.successRate
    : valid > 0 && Number.isFinite(row.elapsedMs) ? row.elapsedMs / valid : Infinity;
  return { ms: estimate * (preferred.includes(row.name) ? retentionFactor : 1),
    basis: useRuntime ? 'RECENT_PRODUCTION' : 'THREE_ROUND_PROBE' };
}
function chooseHealthy(rows, { rounds = 3, minimum = 3, maximum = 5, preferred = [], runtime = [], observedAt = Date.now() } = {}) {
  if (!Number.isInteger(minimum) || !Number.isInteger(maximum) || minimum < 3 || maximum < minimum || maximum > 8) {
    throw new Error('Health selection requires 3 to 8 exits');
  }
  const banned = new Set(rows.filter(row => row.reason === 'BANNED').map(row => row.exit).filter(Boolean));
  const options = { preferred, runtime, observedAt };
  const healthy = rows.filter(row => !row.reason && row.passedRounds === rounds && publicIPv4(row.exit)
    && !banned.has(row.exit)).sort((a, b) =>
    selectionCost(a, options).ms - selectionCost(b, options).ms
    || a.networkFailures / Math.max(1, a.requests) - b.networkFailures / Math.max(1, b.requests)
    || Number(preferred.includes(b.name)) - Number(preferred.includes(a.name)));
  const exits = new Set(), selected = [];
  for (const row of healthy) {
    if (exits.has(row.exit)) continue;
    exits.add(row.exit); selected.push(row);
    if (selected.length === maximum) break;
  }
  return { ok: selected.length >= minimum, selected, healthyNodes: healthy.length,
    distinctExits: selected.length, selectionPolicy: 'EXPECTED_SUCCESS_LATENCY',
    ranking: healthy.map(row => ({ index: row.index, estimatedMs: Math.round(selectionCost(row, options).ms),
      basis: selectionCost(row, options).basis, selected: selected.includes(row) })) };
}
function safeSummary(rows, selected = []) {
  const names = new Set(selected.map(row => row.name));
  return rows.map(row => ({ index: row.index, type: row.type, dnsCandidates: row.candidates.length,
    rejectedAnswers: row.rejectedAnswers, dnsErrors: row.dnsErrors,
    endpointFingerprint: row.address ? fingerprint(row.address) : null,
    passedRounds: row.passedRounds, requests: row.requests, retries: row.retries,
    networkFailures: row.networkFailures, requestSuccessRate: row.requests
      ? row.validRequests / row.requests : null,
    meanProbeMs: row.requests ? Math.round(row.elapsedMs / row.requests) : null,
    reason: row.reason || (names.has(row.name) ? 'SELECTED' : 'RESERVE_OR_SHARED_EXIT'),
    cooldownUntil: row.cooldownUntil || null, selected: names.has(row.name) }));
}
function monitoringIsEnough({ nodes, selected, lastFullCheckAt, configMatches, scannerActive, now = Date.now() }) {
  if (!scannerActive || !configMatches || !lastFullCheckAt || now - lastFullCheckAt >= 60 * 60000
    || lastFullCheckAt > now || new Set(selected).size < 3) return false;
  return selected.every(index => {
    const row = nodes.find(row => row.index === index);
    return row && row.requests >= 20 && row.successRate >= 0.90
      && row.latestSuccess && row.latestSuccess <= now && now - row.latestSuccess < 5 * 60000;
  });
}
module.exports = { publicIPv4, sampleCandidates, screenedHints, certifyNodes, chooseHealthy, selectionCost, safeSummary, monitoringIsEnough };
