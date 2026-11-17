'use strict';
// Read-only operational summary; never prints configured node names, IPs or credentials.
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
function service(name) {
  return execFileSync('systemctl', ['show', name, '--property=ActiveState,UnitFileState,MainPID'], { encoding: 'utf8' }).trim();
}
const state = JSON.parse(fs.readFileSync('/data/hongbao/data/live-state.json', 'utf8'));
const pool = JSON.parse(fs.readFileSync('/data/hongbao/data/room-pool.json', 'utf8'));
const config = JSON.parse(fs.readFileSync('/data/hongbao/proxy/config.yaml', 'utf8'));
const db = new DatabaseSync('/data/hongbao/data/history.sqlite', { readOnly: true });
db.exec('PRAGMA query_only=ON');
const runs = db.prepare('SELECT id,started_at,ended_at,status FROM runs ORDER BY started_at DESC LIMIT 5').all();
const runIds = runs.map(run => run.id);
const perRun = runIds.map(id => ({ id, requests: db.prepare('SELECT kind,outcome,COUNT(*) AS count FROM requests WHERE run_id=? GROUP BY kind,outcome').all(id),
  distinctSuccessfulExits: db.prepare("SELECT COUNT(DISTINCT ip) AS count FROM requests WHERE run_id=? AND kind='rp' AND outcome IN ('hit','empty')").get(id).count,
  lastFinishedAt: db.prepare('SELECT MAX(finished_at) AS at FROM requests WHERE run_id=?').get(id).at }));
const events = db.prepare('SELECT COUNT(*) AS total,SUM(CASE WHEN battery>0 THEN 1 ELSE 0 END) AS battery FROM events').get();
const latestRunNodes = runs.length ? db.prepare(`SELECT node,COUNT(*) AS requests,
  SUM(CASE WHEN outcome IN ('hit','empty') THEN 1 ELSE 0 END) AS successes,
  MAX(CASE WHEN outcome IN ('hit','empty') THEN finished_at ELSE NULL END) AS latestSuccess
  FROM requests WHERE run_id=? AND kind='rp' AND finished_at IS NOT NULL GROUP BY node`)
  .all(runs[0].id).map(row => ({ index: config.proxies.findIndex(node => node.name === row.node) + 1,
    requests: row.requests, successes: row.successes, latestSuccess: row.latestSuccess })) : [];
db.close();
console.log(JSON.stringify({ at: new Date().toISOString(), services: {
  proxy: service('hongbao-proxy'), scanner: service('hongbao-scanner'), dashboard: service('hongbao-dashboard') },
  nodeHealth: fs.existsSync('/data/hongbao/proxy/node-health-summary.json')
    ? JSON.parse(fs.readFileSync('/data/hongbao/proxy/node-health-summary.json', 'utf8')) : null,
  phase: state.phase, round: state.round, updatedAt: state.updatedAt || state.at,
  heartbeatAt: state.updated,
  stats: state.stats, progress: state.progress, storage: state.storage,
  poolRooms: Object.keys(pool.rooms || {}).length,
  configuredPrivateNodes: config.proxies.length, scannerGroupNodes: config['proxy-groups'].find(g => g.name === 'scan-exits').proxies.length,
  nodeSummary: (state.nodes || []).map(node => ({ index: config.proxies.findIndex(row => row.name === node.name) + 1,
    lastUsedAt: node.lastUsedAt, banned: node.banned, used: node.used })),
  runs, perRun, latestRunNodes, events, credentialsPrinted: false }, null, 2));
