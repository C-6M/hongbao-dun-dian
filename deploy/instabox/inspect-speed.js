'use strict';
// Read-only production measurements. Never emit node names, addresses or credentials.
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const root = '/data/hongbao';
const args = process.argv.slice(2);
function option(name, fallback) {
  const i = args.indexOf(name);
  return i < 0 ? fallback : args[i + 1];
}
const until = Number(option('--to', Math.floor(Date.now() / 60000) * 60000));
const since = Number(option('--from', until - 10 * 60000));
if (!Number.isSafeInteger(since) || !Number.isSafeInteger(until) || since >= until) throw new Error('Invalid measurement window');
const config = JSON.parse(fs.readFileSync(root + '/proxy/config.yaml', 'utf8'));
const state = JSON.parse(fs.readFileSync(root + '/data/live-state.json', 'utf8'));
const db = new DatabaseSync(root + '/data/history.sqlite', { readOnly: true });
db.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=5000');
const run = db.prepare('SELECT id,started_at,ended_at,status,config_json FROM runs WHERE id=?').get(option('--run', state.storage.runId));
if (!run) throw new Error('Measurement run not found');
const samples = db.prepare(`SELECT node,ip,started_at,finished_at,duration_ms,outcome,reason,round
  FROM requests WHERE run_id=? AND kind='rp' AND finished_at>=? AND finished_at<? ORDER BY finished_at`).all(run.id, since, until);
const good = r => ['hit', 'empty'].includes(r.outcome);
function latency(rows) {
  const times = rows.map(r => r.duration_ms).sort((a, b) => a - b);
  const p = fraction => times.length ? times[Math.min(times.length - 1, Math.ceil(times.length * fraction) - 1)] : null;
  return { meanMs: times.length ? Math.round(times.reduce((a, b) => a + b, 0) / times.length) : null,
    p50Ms: p(.5), p90Ms: p(.9), p95Ms: p(.95), p99Ms: p(.99), over5s: times.filter(ms => ms >= 5000).length };
}
const successes = samples.filter(good).length;
const nodes = [...new Set(samples.map(r => r.node))].map(node => {
  const rows = samples.filter(r => r.node === node);
  return { index: config.proxies.findIndex(p => p.name === node) + 1, requests: rows.length,
    successes: rows.filter(good).length, latency: latency(rows.filter(good)),
    successfulExitCount: new Set(rows.filter(good).map(r => r.ip)).size };
}).sort((a, b) => a.index - b.index);
const rounds = db.prepare(`SELECT round,MIN(started_at) AS start,MAX(finished_at) AS finish,
  SUM(CASE WHEN outcome='pending' THEN 1 ELSE 0 END) AS pending,COUNT(*) AS requests
  FROM requests WHERE run_id=? AND kind IN ('ip','rp','anchor') GROUP BY round ORDER BY round`).all(run.id);
const fullRounds = rounds.filter(r => r.start >= since && r.finish < until && !r.pending);
const gaps = fullRounds.map(r => {
  const next = rounds.find(row => row.round === r.round + 1);
  return { round: r.round, requests: r.requests, elapsedMs: r.finish - r.start,
    gapToNextMs: next ? next.start - r.finish : null };
});
const perMinute = Array.from({ length: Math.ceil((until - since) / 60000) }, (_, i) => {
  const start = since + i * 60000, end = Math.min(until, start + 60000);
  const rows = samples.filter(r => r.finished_at >= start && r.finished_at < end);
  return { from: new Date(start).toISOString(), requests: rows.length, successes: rows.filter(good).length,
    errors: rows.filter(r => r.outcome === 'error').length, banned: rows.filter(r => r.outcome === 'banned').length };
});
const saved = JSON.parse(run.config_json);
const numericConfig = Object.fromEntries(['roundIntervalMs','readyNodeIntervalMs','concurrency','delayMs','perIpBudget',
  'minNodeReuseMs','cooldownMs','nodeLimit'].map(k => [k, saved[k] ?? null]));
const units = ['hongbao-scanner', 'hongbao-node-health', 'hongbao-node-health.timer'];
const services = Object.fromEntries(units.map(unit => [unit,
  execFileSync('systemctl', ['show', unit, '--property=ActiveState,SubState,NextElapseUSecRealtime'], { encoding: 'utf8' }).trim()]));
console.log(JSON.stringify({ at: new Date().toISOString(), run: { id: run.id, startedAt: run.started_at, status: run.status },
  window: { from: since, to: until, minutes: (until - since) / 60000 }, config: numericConfig,
  requests: samples.length, successes, successPerMinute: successes / ((until - since) / 60000),
  errors: samples.filter(r => r.outcome === 'error').length, banned: samples.filter(r => r.outcome === 'banned').length,
  cancelled: samples.filter(r => r.outcome === 'cancelled').length,
  successRate: samples.length ? successes / samples.length : null,
  latency: latency(samples), successLatency: latency(samples.filter(good)),
  distinctSuccessfulExits: new Set(samples.filter(good).map(r => r.ip)).size,
  nodes, rounds: gaps, perMinute, services, phase: state.phase, lastRoundMs: state.lastRoundMs,
  scannerGroupNodes: config['proxy-groups'].find(g => g.name === 'scan-exits').proxies.length,
  storageError: state.storage.error, privateDataPrinted: false }, null, 2));
db.close();
