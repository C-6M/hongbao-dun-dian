#!/usr/bin/env node
/**
 * spider.js — 蹲点模式红包扫描器
 *
 * 电池红包优先；固定探索配额、按最久未扫描轮巡；后台发现新房间。
 *
 * 用法：
 *   node spider.js               # 启动蹲点扫描
 *   node spider.js --once        # 只跑一轮（调试）
 *   node spider.js --rounds 10   # 跑 10 轮后退出
 *
 * 输出：live-state.json（server.js 读取它做网页）
 */

'use strict';
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const strategy = require('./strategy');
const restartPriorities = require('./restart-priority');
const scanSpeed = require('./scan-speed');
const { createRoundQueue } = require('./round-queue');
const { createProxyTransport } = require('./http-transport');
const roomAudience = require('./room-audience');
const historicalSources = require('./historical-sources');
const hotRank = require('./hot-rank');
const redpocketPolicy = require('./redpocket-policy');
const { parseHttpResult } = require('./http-result');
const notifications = require('./notifications');
const notificationSettings = require('./notification-settings');
const scanSettings = require('./scan-settings');
const roomBlocklist = require('./room-blocklist');
const { HistoryStore, describeResult, FILE: HISTORY_FILE } = require('./history-store');
const { createHash } = require('node:crypto');

// ═══════════════════════════════════════════════════════════════════════
// 配置
// ═══════════════════════════════════════════════════════════════════════
function readNodeLimit(value) {
  if (value === undefined || value === '') return 8;
  if (!/^\d+$/.test(value) || Number(value) < 3 || Number(value) > 24) {
    throw new Error('SCANNER_NODE_LIMIT 必须是 3～24 的整数');
  }
  return Number(value);
}

function readIpBudget(value) {
  if (value === undefined || value === '') return 110;
  if (!/^\d+$/.test(value) || Number(value) < 20 || Number(value) > 150) {
    throw new Error('SCANNER_PER_IP_BUDGET 必须是 20～150 的整数');
  }
  return Number(value);
}

function readClashSecret() {
  if (process.env.SCANNER_CLASH_SECRET !== undefined) return process.env.SCANNER_CLASH_SECRET;
  try {
    const local = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'scanner-local-config.json'), 'utf8'));
    if (!local || typeof local.clashSecret !== 'string') throw new Error('Invalid credential type');
    return local.clashSecret;
  } catch (error) {
    if (error.code === 'ENOENT') return '';
    throw new Error('本地 Clash 配置无效，请检查 data/scanner-local-config.json');
  }
}

const CFG = {
  ...strategy.DEFAULTS,
  // Clash 控制器（端口会变，启动时自动探测）
  clashSecret: readClashSecret(),
  proxy: 'http://127.0.0.1:7890',
  group: '🌏 爱奇艺&哔哩哔哩',

  // ── 蹲点参数 ──────────────────────────────────────────────────────
  roundIntervalMs: 8000,    // 无可用节点、空房间池或失败时等待 8 秒
  readyNodeIntervalMs: 250, // 已有其他可用出口时及时进入下一轮
  nodeBatchTargetMs: 30000, // 慢节点按近期延迟缩小批次，保留每 IP 上限
  spreadNodeBudget: process.env.SCANNER_SPREAD_BUDGET !== '0',
  nodeTurnoverReserveMs: 1800, // 轮换周期为切换、规划及落盘留出时间
  pooledHttp: process.env.SCANNER_POOLED_HTTP !== '0',
  roomAudience: process.env.SCANNER_ROOM_AUDIENCE !== '0',
  explorationRatio: 0.30,   // 为普通 COLD 轮巡保留至少 30%，不含榜单优先池
  warmIntervalMs: 90000,   // WARM 90 秒复查，剩余预算用于探索
  notificationSettingsFile: notificationSettings.FILE,
  scanSettingsFile: scanSettings.FILE,
  roomBlocklistFile: roomBlocklist.FILE,

  // ── 天选（次要目标，优先级已大幅下调）────────────────────────────
  // 用户主要看电池红包，天选只是顺带。
  anchorEveryRounds: 12,
  anchorRoomLimit: 8,
  anchorBudgetRatio: 0.08,  // 天选最多用掉节点预算的 8%

  // ── 请求控制 ──────────────────────────────────────────────────────
  concurrency: 5,
  delayMs: 90,             // 跨红包、天选和出口检查的启动间隔
  perIpBudget: readIpBudget(process.env.SCANNER_PER_IP_BUDGET), // 默认 110；所有代理请求共用
  cooldownMs: 15 * 60e3,    // 节点冷却 15 分钟
  minNodeReuseMs: 180000,   // 同节点再次使用至少间隔 3 分钟
  ipNetworkRetry: process.env.SCANNER_IP_NETWORK_RETRY === '1',
  stopOnBan: process.env.SCANNER_STOP_ON_BAN === '1', // 临时压力试验：首次风控结束整个扫描

  // ── 节点池（从 Clash 策略组读取，每轮仅选一个）──────────────────
  nodeLimit: readNodeLimit(process.env.SCANNER_NODE_LIMIT), // 默认 8；刷新时优先保留现有成员
  minNodesAlive: 3,         // 存活节点少于这个数就暂停，避免单点压力过大

  // ── 房间池 ────────────────────────────────────────────────────────
  hotWindowMs: 30 * 60e3,   // 30 分钟内命中过 = HOT
  warmWindowMs: 6 * 3600e3, // 6 小时内命中过 = WARM
  discoveryEveryMs: 60e3,  // 批次完成后至少等待 60 秒
  discoveryAreaBatch: 10,  // 每个分区 2 页
  discoveryMaxPage: 5,     // 第 1 页 + 在第 2～5 页之间轮换
  discoveryDelayMs: 250,
  hotRankEveryMs: 60e3,   // 与发现批次共用请求额度，不采用页面的 15 秒轮询

  stateFile: path.join(__dirname, '..', 'data', 'live-state.json'),
  poolFile: path.join(__dirname, '..', 'data', 'room-pool.json'),
  qqFile: path.join(__dirname, '..', 'data', 'qq_redpacket_extract.json'),
  historicalFile: path.join(__dirname, '..', 'data', 'historical-sources.json'),
  lockFile: path.join(__dirname, '..', 'data', 'scanner.lock'),
  UA: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
};

const CURL = 'C:\\Windows\\system32\\curl.exe';
const now = () => Date.now();

// ═══════════════════════════════════════════════════════════════════════
// Clash 控制（自动探测端口）
// ═══════════════════════════════════════════════════════════════════════
let CLASH_API = null;

async function discoverClash() {
  // 1. 从配置文件读
  const cfgPaths = [
    path.join(process.env.USERPROFILE || '', 'Downloads', 'Clash.for.Windows-0.20.16.4-ikuuu',
      'Clash.for.Windows-0.20.16-ikuuu', 'data', 'config.yaml'),
  ];
  for (const p of cfgPaths) {
    try {
      const txt = fs.readFileSync(p, 'utf8');
      const m = txt.match(/external-controller:\s*['"]?([0-9.]+:\d+)['"]?/);
      if (m) {
        const url = 'http://' + m[1];
        if (await pingClash(url)) return url;
      }
    } catch (e) { /* ignore */ }
  }
  // 2. 常见端口兜底
  for (const port of [10039, 14086, 9090, 9097, 6170]) {
    const url = 'http://127.0.0.1:' + port;
    if (await pingClash(url)) return url;
  }
  return null;
}

async function pingClash(url) {
  try {
    const r = await fetch(url + '/version', {
      headers: { Authorization: 'Bearer ' + CFG.clashSecret },
      signal: AbortSignal.timeout(3000),
    });
    return r.ok;
  } catch (e) { return false; }
}

async function clash(p, opt = {}) {
  const request = async () => {
    const r = await fetch(CLASH_API + p, {
      method: opt.method || 'GET',
      headers: {
        Authorization: 'Bearer ' + CFG.clashSecret,
        'content-type': 'application/json',
      },
      body: opt.body,
      signal: AbortSignal.any([shutdownController.signal, AbortSignal.timeout(8000)]),
    });
    return { status: r.status, body: await r.text() };
  };
  try { return await request(); }
  catch (error) {
    if (shutdownController.signal.aborted) throw error;
    // Clash for Windows changes its controller port on restart. Rediscover on
    // transport failure; HTTP errors and Bilibili requests are not replayed.
    const refreshed = await discoverClash();
    if (!refreshed || refreshed === CLASH_API || shutdownController.signal.aborted) throw error;
    CLASH_API = refreshed;
    console.log('[Clash] 控制器地址已更新，恢复连接: ' + refreshed);
    return request();
  }
}

// ═══════════════════════════════════════════════════════════════════════
// 节点管理
// ═══════════════════════════════════════════════════════════════════════
const nodeState = new Map();
const ipState = new Map();
const shutdownController = new AbortController();
let stopping = false;
let historyStore = null;

function persistHistory(action) {
  try { return action(); }
  catch (e) {
    state.storage.error = e.message;
    state.phase = 'storage_error';
    process.exitCode = 1;
    console.error('[长期记录] 保存失败，停止扫描: ' + e.message);
    stop();
    throw e;
  }
}

function initializeHistory() {
  persistHistory(() => {
    historyStore = new HistoryStore();
    let old;
    try { old = fs.readFileSync(CFG.stateFile, 'utf8'); }
    catch (e) { if (e.code !== 'ENOENT') throw e; }
    if (old) historyStore.importState(JSON.parse(old), 'live-state:' + createHash('sha256').update(old).digest('hex'));
    initializeHistoricalSources();
    // Only numeric/boolean strategy parameters are archived; controller credentials are excluded.
    const config = Object.fromEntries(Object.entries(CFG).filter(([, v]) => typeof v === 'number' || typeof v === 'boolean'));
    config.historicalCandidatesGeneratedAt = historicalManifest.generatedAt;
    config.historicalCandidatesCount = historicalManifest.candidates.length;
    state.storage.runId = historyStore.startRun(config);
    state.storage.enabled = true;
    console.log('[长期记录] 已启用 ' + HISTORY_FILE);
  });
}

async function loadNodes() {
  const response = await clash('/proxies');
  if (response.status !== 200) throw new Error('读取节点失败: ' + response.status);
  const p = JSON.parse(response.body).proxies;
  const g = p[CFG.group];
  if (!Array.isArray(g?.all)) throw new Error('找不到策略组: ' + CFG.group);
  const candidates = [...new Set(g.all.filter(n => n !== 'DIRECT' && n !== 'REJECT'))];
  const retained = [...nodeState.keys()].filter(n => candidates.includes(n));
  const nodes = [...new Set([...retained, ...candidates])].slice(0, CFG.nodeLimit);
  for (const n of nodes) if (!nodeState.has(n)) {
    nodeState.set(n, { used: 0, bannedUntil: 0, lastIp: '', totalUsed: 0, totalRequests: 0, lastUsedAt: 0 });
  }
  for (const name of nodeState.keys()) if (!nodes.includes(name)) nodeState.delete(name);
  return nodes;
}

function nodeAlive(n, time = now()) {
  const s = nodeState.get(n);
  return s && (s.bannedUntil || 0) <= time
    && (ipState.get(s.lastIp)?.bannedUntil || 0) <= time;
}

function pickNode(nodes) {
  const t = now();
  const alive = nodes.filter(n => nodeAlive(n, t));
  const exits = new Set(alive.map(n => nodeState.get(n).lastIp || n));
  if (exits.size < CFG.minNodesAlive) return null;
  return alive.filter(n => {
    const s = nodeState.get(n);
    return t - Math.max(s.lastUsedAt || 0, ipState.get(s.lastIp)?.lastUsedAt || 0) >= CFG.minNodeReuseMs;
  }).sort((a, b) => (nodeState.get(a).lastUsedAt || 0) - (nodeState.get(b).lastUsedAt || 0)
    || (nodeState.get(a).totalRequests || 0) - (nodeState.get(b).totalRequests || 0))[0] || null;
}

function banNode(node) {
  const s = nodeState.get(node);
  s.bannedUntil = now() + CFG.cooldownMs;
  if (s.lastIp) ipState.set(s.lastIp, { ...ipState.get(s.lastIp), bannedUntil: s.bannedUntil });
}

async function switchNode(name) {
  const r = await clash('/proxies/' + encodeURIComponent(CFG.group), {
    method: 'PUT', body: JSON.stringify({ name }),
  });
  if (r.status !== 204) throw new Error('切换失败: ' + r.status);
  await sleep(700);
}

function httpGet(url, { viaProxy = true, timeout = 12000, kind = 'other', roomId, tier,
  signal = shutdownController.signal, transport } = {}) {
  if (signal.aborted || !syncScanSettings()) return Promise.resolve({ status: 'ABORT', sent: false });
  if (roomId && isBlockedRoom(roomId)) return Promise.resolve({ status: 'SKIP', sent: false });
  const meta = { kind, roomId, startedAt: now(), round: state.round,
    tier: tier ?? (roomId ? tierOf(roomId) : null),
    node: viaProxy ? state.current.node : null, ip: viaProxy ? state.current.ip : null,
    target: url.replace(/^https?:\/\/[^/]+/, '') };
  const requestId = persistHistory(() => historyStore.beginRequest(meta));
  state.scan.inFlight++;
  state.stats.requests++;
  state.stats.requestsByKind[kind] = (state.stats.requestsByKind[kind] || 0) + 1;
  return new Promise((resolve, reject) => {
    const args = ['-s', '-m', String(Math.ceil(timeout / 1000)), '-w', '\n###%{http_code}',
      '-H', 'user-agent: ' + CFG.UA];
    if (viaProxy) args.push('-x', CFG.proxy);
    else args.push('--noproxy', '*');
    args.push(url);
    const env = { ...process.env };
    if (!viaProxy) for (const k of ['http_proxy', 'https_proxy', 'HTTP_PROXY', 'HTTPS_PROXY']) env[k] = '';
    const finish = (err, stdout) => {
      const result = signal.aborted ? { status: 'ABORT' } : parseHttpResult(stdout, err);
      if (result.status === 'BANNED') {
        state.stats.banned++;
        if (CFG.stopOnBan) stop();
      }
      else if (result.status === 'ABORT') state.stats.cancelled++;
      else if (result.status !== 'OK' || result.code !== 0) noteError(kind, result.status + ':' + (result.code ?? result.httpCode ?? ''));
      try {
        persistHistory(() => historyStore.completeRequest(requestId, meta, result, now()));
        state.storage.completed++;
        state.storage.lastWrite = now();
        resolve({ ...result, sent: true });
      } catch (e) { reject(e); }
      finally { state.scan.inFlight--; refreshScanPhase(); }
    };
    try {
      if (transport) transport.request(url, { timeout, signal }).then(
        result => finish(result.err, result.stdout), error => finish(error, ''));
      else execFile(CURL, args, { windowsHide: true, encoding: 'utf8', timeout: timeout + 3000, env, signal, maxBuffer: 4 * 1024 * 1024 }, finish);
    }
    catch (e) { finish(e, ''); }
  });
}

function noteError(kind, reason) {
  state.stats.errors++;
  const key = kind + ':' + reason;
  state.stats.errorReasons[key] = (state.stats.errorReasons[key] || 0) + 1;
}

const sleep = ms => new Promise(resolve => {
  const signal = shutdownController.signal;
  if (signal.aborted) return resolve();
  const finish = () => { clearTimeout(timer); signal.removeEventListener('abort', finish); resolve(); };
  const timer = setTimeout(finish, ms);
  signal.addEventListener('abort', finish, { once: true });
});

// ═══════════════════════════════════════════════════════════════════════
// 房间池
// ═══════════════════════════════════════════════════════════════════════
let pool = new Map();
let restartPriority = new Map();
let restartPriorityAt = null, restartPriorityTotal = 0, restartPriorityChecked = 0, restartPrioritySkipped = 0;
let summaryIndex = null;
let historicalManifest = null;
let qqMtime = -1;
let discoveryTask = null;
let discoveryAreas = [];
let areasLoadedAt = 0;
let discoveryCursor = 0;
let discoverySkipCursor = 0;
const discoveryPages = new Map();
let hotRankContext = { ...hotRank.DEFAULT_CONTEXT };
const hotRankScannedRooms = new Set();

function atomicJSON(file, data) {
  const temp = file + '.' + process.pid + '.tmp';
  try {
    fs.writeFileSync(temp, JSON.stringify(data));
    fs.renameSync(temp, file);
  } catch (e) {
    try { fs.unlinkSync(temp); } catch {}
    throw e;
  }
}

function loadPool() {
  try {
    const d = JSON.parse(fs.readFileSync(CFG.poolFile, 'utf8'));
    pool = new Map(Object.entries(d.rooms || {}));
    const saved = restartPriorities.restore(d, pool, now(), CFG);
    restartPriority = saved.pending;
    restartPriorityAt = saved.at;
    restartPriorityTotal = restartPriority.size;
  } catch (e) {
    if (e.code !== 'ENOENT') throw new Error('房间池读取失败，保留原文件: ' + e.message);
  }
  for (const id of pool.keys()) strategy.ensureRoom(pool, id, now());
  console.log('[池] 载入 ' + pool.size + ' 个房间');
  if (restartPriority.size) console.log('[重启优先] 保留 ' + restartPriority.size + ' 间 HOT/WARM，逐间复查一次后恢复正常分层。');
}

function syncRestartPriority() {
  const before = restartPriority.size;
  for (const [id, priority] of restartPriority) {
    const room = pool.get(id);
    if (!room || isBlockedRoom(id) || (priority.tier === 'HOT' && !room.lastBatteryHit)) {
      restartPriority.delete(id);
      restartPrioritySkipped++;
    }
  }
  let hot = 0, warm = 0;
  for (const priority of restartPriority.values()) priority.tier === 'HOT' ? hot++ : warm++;
  state.restartPriority = { active: restartPriority.size > 0, sourceAt: restartPriorityAt,
    total: restartPriorityTotal, checked: restartPriorityChecked, skipped: restartPrioritySkipped,
    remaining: restartPriority.size, hot, warm };
  if (before && !restartPriority.size) console.log('[重启优先] 原有 HOT/WARM 复查完成，恢复正常分层。');
}

function completeRestartPriority(id) {
  if (!restartPriority.delete(id)) return;
  restartPriorityChecked++;
  if (!restartPriority.size) console.log('[重启优先] 原有 HOT/WARM 复查完成，恢复正常分层。');
  syncRestartPriority();
}

function savePool() {
  summaryIndex = null;
  syncRestartPriority();
  const at = now();
  atomicJSON(CFG.poolFile, { schemaVersion: 2, at: new Date(at).toISOString(), rooms: Object.fromEntries(pool),
    restartPriority: restartPriorities.snapshot(pool, at, CFG, restartPriority) });
}

function poolSummaryIndex() {
  if (summaryIndex?.pool === pool) return summaryIndex;
  const index = { pool, ranked: [], qq: [], historical: [] };
  for (const entry of pool) {
    const room = entry[1];
    if (room.hotRankPriority) index.ranked.push(entry);
    if (room.qqPushes > 0) index.qq.push(entry);
    if (room.historicalSource) index.historical.push(entry);
  }
  summaryIndex = index;
  return index;
}

function projectHistoricalSources() {
  if (!historicalManifest) return;
  summaryIndex = null;
  for (const { evidence, ...candidate } of historicalManifest.candidates) {
    if (isBlockedRoom(candidate.room)) continue;
    const r = strategy.ensureRoom(pool, candidate.room, now());
    r.historicalSource = { ...candidate, version: historicalManifest.version, generatedAt: historicalManifest.generatedAt };
  }
}

function initializeHistoricalSources() {
  return persistHistory(() => {
    const t = now();
    let manifest;
    try { manifest = JSON.parse(fs.readFileSync(CFG.historicalFile, 'utf8')); }
    catch (e) {
      if (e.code !== 'ENOENT') throw new Error('历史来源名单读取失败，保留原文件: ' + e.message);
      let qqData = {};
      try { qqData = JSON.parse(fs.readFileSync(CFG.qqFile, 'utf8')); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      manifest = historicalSources.buildCandidates({ qqData,
        localEvidence: historyStore.recentBatteryEvidence(t - historicalSources.WINDOW_MS, t),
        at: t, blockedRooms: CFG.blockedRooms, limit: CFG.historicalPoolLimit });
      historicalSources.validateManifest(manifest, { at: t, blockedRooms: CFG.blockedRooms, limit: CFG.historicalPoolLimit });
      // Persist the fixed membership before permitting any requests from it.
      atomicJSON(CFG.historicalFile, manifest);
    }
    historicalSources.validateManifest(manifest, { at: t, blockedRooms: CFG.blockedRooms, limit: CFG.historicalPoolLimit });
    historicalManifest = manifest;
    for (const r of pool.values()) delete r.historicalSource;
    projectHistoricalSources();
    state.historical = { version: manifest.version, generatedAt: manifest.generatedAt,
      manifestHash: createHash('sha256').update(JSON.stringify(manifest)).digest('hex'),
      candidates: manifest.candidates.length };
    console.log('[历史来源] 固定名单 ' + manifest.candidates.length + ' 间，生成于 ' + new Date(manifest.generatedAt).toISOString());
    return manifest;
  });
}

function syncQQ() {
  try {
    const mtime = fs.statSync(CFG.qqFile).mtimeMs;
    if (mtime === qqMtime) return;
    const data = JSON.parse(fs.readFileSync(CFG.qqFile, 'utf8'));
    const result = strategy.mergeQQ(pool, data, now(), CFG);
    summaryIndex = null;
    qqMtime = mtime;
    state.qq = { ...result, sourceAt: data.extracted_at, sources: data.sources || [], syncedAt: now() };
    console.log('[QQ] 接入 ' + result.updated + ' 个房间，新增 ' + result.added);
  } catch (e) {
    if (e.code !== 'ENOENT') console.error('[QQ] 读取失败: ' + e.message);
  }
}

const tierOf = id => restartPriority.get(id)?.tier || strategy.tierOf(pool.get(id) || {}, now(), CFG);
const roomScore = id => strategy.roomScore(pool.get(id) || {}, now(), CFG);
const buildRoundPlan = (round, options = {}) => strategy.buildRoundPlan(pool, round, now(), { ...CFG, restartPriority, ...options });

async function discoveryGet(url) {
  const r = await httpGet(url, { viaProxy: false, timeout: 10000, kind: 'discovery' });
  if (r.status === 'ABORT') throw Object.assign(new Error('发现任务已暂停或停止'), { cancelled: true });
  if (r.status !== 'OK' || r.code !== 0 || !Array.isArray(r.data)) {
    if (r.status === 'OK' && r.code === 0) noteError('discovery', 'schema');
    const error = new Error('发现接口: ' + r.status + '/' + (r.code ?? r.httpCode ?? ''));
    error.banned = r.status === 'BANNED';
    throw error;
  }
  return r.data;
}

async function refreshHotRank() {
  await sleep(CFG.discoveryDelayMs);
  if (stopping || !syncScanSettings()) return false;
  state.hotRank.running = true;
  state.hotRank.lastAttemptAt = now();
  let backoff = CFG.hotRankEveryMs;
  try {
    const result = await httpGet(hotRank.buildUrl(hotRankContext), {
      viaProxy: false, timeout: 10000, kind: 'discovery', tier: 'GLOBAL_HOT_RANK',
    });
    if (result.sent) state.hotRank.fetchRequests++;
    if (result.status === 'ABORT') throw Object.assign(new Error('热门榜发现已暂停或停止'), { cancelled: true });
    if (result.status !== 'OK' || result.code !== 0) {
      throw Object.assign(new Error('热门榜接口: ' + result.status + '/' + (result.code ?? result.httpCode ?? '')),
        { banned: result.status === 'BANNED' });
    }
    let snapshot;
    try { snapshot = hotRank.parseSnapshot(result.data); }
    catch (error) { noteError('discovery', 'hot-rank-schema'); throw error; }
    syncRoomBlocklist();
    const at = now();
    const summary = strategy.recordHotRankSnapshot(pool, snapshot.items, at, CFG);
    summaryIndex = null;
    const context = snapshot.items.find(item => item.uid);
    if (context) hotRankContext = { ruid: context.uid, roomId: context.roomid };
    state.hotRank = { ...state.hotRank, ...summary, at, error: '', countdown: snapshot.countdown,
      rooms: snapshot.items.filter(item => item.liveStatus === 1 && !isBlockedRoom(item.roomid))
        .map(({ roomid, rank, score }) => ({ room: roomid, rank, score })) };
  } catch (error) {
    if (!error.cancelled) {
      state.hotRank.error = error.message;
      if (!stopping) console.error('[热门榜] ' + error.message);
    }
    if (error.banned) backoff = CFG.cooldownMs;
    if (error.cancelled || error.banned || state.storage.error) throw error;
  } finally {
    state.hotRank.running = false;
    state.hotRank.nextAt = now() + backoff;
  }
  return true;
}

function interleaveDiscoveryAreas(parents) {
  const groups = parents.map(parent => (parent.list || []).map(area => [parent.id, area.id]));
  const ordered = [];
  // Refresh every parent early after a restart; a large first parent must not
  // delay all other room sources until its entire child list has been visited.
  for (let index = 0; groups.some(group => index < group.length); index++) {
    for (const group of groups) if (index < group.length) ordered.push(group[index]);
  }
  return ordered;
}

async function discoverRooms() {
  state.discovery.running = true;
  state.discovery.startedAt = now();
  state.discovery.pages = 0;
  let backoff = CFG.discoveryEveryMs;
  try {
    // One global snapshot replaces one deep-page request in this batch.
    let listingBudget = CFG.discoveryAreaBatch * 2;
    let hotRankRequested = false;
    if (listingBudget > 0 && now() >= state.hotRank.nextAt && await refreshHotRank()) {
      listingBudget--; hotRankRequested = true;
    }
    if (!discoveryAreas.length || now() - areasLoadedAt > 3600000) {
      const data = await discoveryGet('https://api.live.bilibili.com/room/v1/area/getList?parent_id=0');
      discoveryAreas = interleaveDiscoveryAreas(data);
      areasLoadedAt = now();
    }
    const count = Math.min(CFG.discoveryAreaBatch, discoveryAreas.length);
    const skipDeepIndex = hotRankRequested && count * 2 > listingBudget ? discoverySkipCursor++ % count : -1;
    for (let i = 0; i < count && listingBudget > 0 && !stopping && syncScanSettings(); i++) {
      const [pa, ar] = discoveryAreas[discoveryCursor++ % discoveryAreas.length];
      const key = pa + ':' + ar;
      const deepPage = discoveryPages.get(key) || 2;
      // Rotate the omitted deep page so no fixed partition loses deep discovery.
      for (const page of i === skipDeepIndex ? [1] : [1, deepPage]) {
        if (listingBudget <= 0 || stopping || !syncScanSettings()) break;
        await sleep(CFG.discoveryDelayMs);
        if (stopping || !syncScanSettings()) break;
        const url = 'https://api.live.bilibili.com/room/v1/area/getRoomList?platform=web&parent_area_id='
          + pa + '&area_id=' + ar + '&sort_type=online&page=' + page + '&page_size=30';
        const list = await discoveryGet(url);
        listingBudget--;
        syncRoomBlocklist();
        const listedAt = now();
        for (let index = 0; index < list.length; index++) {
          strategy.recordListing(pool, list[index], {
            parentAreaId: pa, areaId: ar, page, pageSize: 30, index,
          }, listedAt, CFG);
        }
        const context = list.find(item => hotRank.positiveId(item.uid) && hotRank.positiveId(item.roomid));
        if (context) hotRankContext = { ruid: String(context.uid), roomId: String(context.roomid) };
        state.discovery.pages++;
        if (page === deepPage) discoveryPages.set(key, deepPage >= CFG.discoveryMaxPage ? 2 : deepPage + 1);
      }
    }
    state.discovery.removed = strategy.prunePool(pool, now(), { ...CFG, restartPriority });
    state.discovery.error = '';
  } catch (e) {
    if (!stopping && !e.cancelled) console.error('[发现] ' + e.message);
    if (!e.cancelled) state.discovery.error = e.message;
    if (e.banned) backoff = CFG.cooldownMs;
  } finally {
    state.discovery.running = false;
    state.discovery.finishedAt = now();
    state.discovery.nextAt = now() + (state.scan.enabled ? backoff : 0);
    if (!stopping) savePool();
  }
}

function startDiscovery() {
  if (stopping || !syncScanSettings() || discoveryTask || now() < state.discovery.nextAt) return;
  discoveryTask = discoverRooms().catch(e => {
    console.error('[发现] 保存失败: ' + e.message);
  }).finally(() => { discoveryTask = null; });
}

// ═══════════════════════════════════════════════════════════════════════
// 全局状态（写给 server.js）
// ═══════════════════════════════════════════════════════════════════════
const state = {
  schemaVersion: 2, pid: process.pid,
  started: now(), updated: 0, round: 0, phase: 'idle',
  current: { node: '', ip: '' },
  stats: { scanned: 0, requests: 0, hits: 0, batteryHits: 0, errors: 0, cancelled: 0,
    banned: 0, rounds: 0, requestsByKind: {}, errorReasons: {}, byTier: {} },
  settings: { roundIntervalMs: CFG.roundIntervalMs, anchorEveryRounds: CFG.anchorEveryRounds,
    readyNodeIntervalMs: CFG.readyNodeIntervalMs, nodeBatchTargetMs: CFG.nodeBatchTargetMs,
    nodeLimit: CFG.nodeLimit, minNodeReuseMs: CFG.minNodeReuseMs,
    priorityMaxRatio: CFG.priorityMaxRatio, priorityPoolLimit: CFG.priorityPoolLimit,
    priorityTopN: CFG.priorityTopN, priorityWindowMs: CFG.priorityWindowMs,
    hotRankTopN: CFG.hotRankTopN, hotRankEveryMs: CFG.hotRankEveryMs,
    priorityIntervalMs: CFG.priorityIntervalMs,
    explorationRatio: CFG.explorationRatio, warmIntervalMs: CFG.warmIntervalMs,
    valuePolicyVersion: CFG.valuePolicyVersion, hotIntervalMs: CFG.hotIntervalMs,
    batteryEligibilityVersion: CFG.batteryEligibilityVersion,
    hotUsefulMinPerPerson: CFG.hotUsefulMinPerPerson, hotValueWindowMs: CFG.hotValueWindowMs,
    hotLowValueIntervalMs: CFG.hotLowValueIntervalMs, hotObservationMs: CFG.hotObservationMs,
    qqEvidenceHalfLifeMs: CFG.qqEvidenceHalfLifeMs, qqRecentWindowMs: CFG.qqRecentWindowMs,
    qqRecentIntervalMs: CFG.qqRecentIntervalMs, qqRepeatIntervalMs: CFG.qqRepeatIntervalMs,
    qqEmptyLimit: CFG.qqEmptyLimit,
    qqPolicyVersion: CFG.qqPolicyVersion, qqUsefulMinPerPerson: CFG.qqUsefulMinPerPerson,
    qqBackoffSecondEmptyLimit: CFG.qqBackoffSecondEmptyLimit, qqBackoffThirdEmptyLimit: CFG.qqBackoffThirdEmptyLimit,
    qqBackoffFirstIntervalMs: CFG.qqBackoffFirstIntervalMs, qqBackoffSecondIntervalMs: CFG.qqBackoffSecondIntervalMs,
    qqBackoffThirdIntervalMs: CFG.qqBackoffThirdIntervalMs,
    qqSourceAgingMs: CFG.qqSourceAgingMs, qqSourceOldMs: CFG.qqSourceOldMs,
    historicalPolicyVersion: CFG.historicalPolicyVersion, historicalPoolLimit: CFG.historicalPoolLimit,
    historicalMaxRatio: CFG.historicalMaxRatio, historicalActiveIntervalMs: CFG.historicalActiveIntervalMs,
    historicalProbeIntervalMs: CFG.historicalProbeIntervalMs, historicalEmptyLimit: CFG.historicalEmptyLimit,
    concurrency: CFG.concurrency, delayMs: CFG.delayMs, perIpBudget: CFG.perIpBudget,
    spreadNodeBudget: CFG.spreadNodeBudget,
    pooledHttp: CFG.pooledHttp, roomAudience: CFG.roomAudience,
    discoveryEveryMs: CFG.discoveryEveryMs, discoveryAreaBatch: CFG.discoveryAreaBatch,
    discoveryDelayMs: CFG.discoveryDelayMs },
  discovery: { running: false, nextAt: 0 },
  hotRank: { running: false, nextAt: 0, at: 0, fetchRequests: 0, requests: 0, priorityRequests: 0,
    scannedRooms: 0, rooms: [], error: '' },
  scan: { enabled: true, settingsError: '', inFlight: 0 },
  blocklist: { rooms: [], error: '' },
  historical: { version: CFG.historicalPolicyVersion, candidates: 0 },
  pool: { hot: 0, warm: 0, cold: 0 },
  nodes: [], redpockets: [], anchors: [], history: [], lastRoundMs: 0,
  storage: { enabled: false, file: HISTORY_FILE, runId: null, completed: 0, lastWrite: 0, error: '' },
  notifications: { enabled: notificationSettings.DEFAULTS.enabled, minimum: notificationSettings.DEFAULTS.minPerPerson,
    settings: { ...notificationSettings.DEFAULTS }, settingsError: '',
    sent: 0, failed: 0, lastError: '', lastSent: null, notified: [] },
};
const activeRP = new Map();
const activeAnchor = new Map();
const recentRP = new Map();
const pendingNotifications = new Set();
const notificationRetries = new Map();

function refreshScanPhase() {
  if (stopping || state.storage.error) return;
  if (!state.scan.enabled) state.phase = state.scan.inFlight ? 'pausing' : 'paused';
  else if (['pausing', 'paused'].includes(state.phase)) state.phase = 'idle';
}

const isBlockedRoom = id => strategy.isBlockedRoom(id, CFG);

function syncRoomBlocklist() {
  try {
    const rooms = roomBlocklist.readSettings(CFG.roomBlocklistFile, fs).rooms;
    const changed = JSON.stringify(rooms) !== JSON.stringify(CFG.blockedRooms);
    CFG.blockedRooms = rooms;
    if (changed) projectHistoricalSources();
    state.blocklist = { rooms: [...CFG.blockedRooms], error: '' };
    return true;
  } catch (e) {
    if (state.blocklist.error !== e.message) console.error('[房间屏蔽] ' + e.message);
    state.blocklist.error = e.message;
    return false;
  }
}

function syncScanSettings() {
  try {
    if (!syncRoomBlocklist()) throw new Error('房间屏蔽设置读取失败: ' + state.blocklist.error);
    state.scan.enabled = scanSettings.readSettings(CFG.scanSettingsFile, fs).enabled;
    state.scan.settingsError = '';
  } catch (e) {
    if (state.scan.settingsError !== e.message) console.error('[扫描设置] ' + e.message);
    state.scan.enabled = false;
    state.scan.settingsError = e.message;
  }
  refreshScanPhase();
  return state.scan.enabled;
}

function syncNotificationSettings() {
  const ns = state.notifications;
  try {
    ns.settings = notificationSettings.readSettings(CFG.notificationSettingsFile, fs);
    ns.enabled = ns.settings.enabled;
    ns.minimum = ns.settings.minPerPerson;
    ns.settingsError = '';
    return true;
  } catch (e) {
    if (ns.settingsError !== e.message) console.error('[通知设置] ' + e.message);
    ns.settingsError = e.message;
    return false;
  }
}

function restoreState() {
  let old;
  try { old = JSON.parse(fs.readFileSync(CFG.stateFile, 'utf8')); }
  catch (e) { if (e.code === 'ENOENT') return; throw new Error('状态读取失败，保留原文件: ' + e.message); }
  state.history = (old.history || []).filter(r => !redpocketPolicy.isExcludedBattery(r)).slice(0, 100);
  state.notifications.notified = (old.notifications?.notified || []).filter(item => item.until > now());
  for (const r of old.redpockets || []) activeRP.set(String(r.lid), r);
  for (const r of old.expired || []) recentRP.set(String(r.lid), r);
  for (const r of old.anchors || []) activeAnchor.set(String(r.lid), r);
  const known = new Map();
  for (const h of [...state.history, ...(old.redpockets || [])]) {
    if (!known.has(String(h.lid))) known.set(String(h.lid), h);
  }
  for (const h of [...known.values()].sort((a, b) => (a.first_seen || a.foundAt || 0) - (b.first_seen || b.foundAt || 0))) {
    if (!h.room_id || !h.end_time || h.end_time * 1000 + 86400000 <= now()) continue;
    const r = strategy.ensureRoom(pool, h.room_id, now());
    const saved = { hits: r.hits || 0, lastHit: r.lastHit || 0 };
    strategy.recordLots(r, [{ lot_id: h.lid, end_time: h.end_time, total_price: h.total_price,
      awards: [{ gift_name: h.award_name, num: h.award_num }],
      join_requirement: h.join_requirement, rp_type: h.rp_type }], h.first_seen || h.foundAt || now(), CFG);
    Object.assign(r, saved);
  }
  for (const n of old.nodes || []) {
    nodeState.set(n.name, { used: 0, totalUsed: n.totalUsed || 0, totalRequests: n.totalRequests || 0,
      lastUsedAt: n.lastUsedAt || 0, lastIp: n.ip || '',
      requestMeanMs: n.requestMeanMs, latencySamples: n.latencySamples || 0,
      bannedUntil: n.bannedUntil || (n.banned ? (old.updated || 0) + CFG.cooldownMs : 0) });
  }
  for (const entry of old.ipLimits || []) ipState.set(entry.ip, entry);
  for (const n of nodeState.values()) if (n.lastIp) {
    const previous = ipState.get(n.lastIp) || {};
    ipState.set(n.lastIp, { lastUsedAt: Math.max(previous.lastUsedAt || 0, n.lastUsedAt),
      bannedUntil: Math.max(previous.bannedUntil || 0, n.bannedUntil) });
  }
  pruneExpired();
}

function restoreBatteryValues() {
  const t = now();
  const needsMigration = [...pool.values()].some(r => r.batteryEligibilityVersion !== CFG.batteryEligibilityVersion);
  const evidence = historyStore.recentBatteryEvidence(needsMigration ? 0 : t - CFG.hotValueWindowMs, t);
  let migratedRooms = 0;
  if (needsMigration) {
    const byRoom = new Map();
    for (const e of evidence) {
      if (!byRoom.has(e.roomId)) byRoom.set(e.roomId, []);
      byRoom.get(e.roomId).push(e);
    }
    for (const [id, r] of pool) {
      if (r.batteryEligibilityVersion === CFG.batteryEligibilityVersion) continue;
      const observations = byRoom.get(id) || [];
      if (observations.some(e => redpocketPolicy.isExcludedBattery(e.lot))) {
        strategy.rebuildBatteryEvidence(r, observations, t, CFG);
        migratedRooms++;
      }
      r.batteryEligibilityVersion = CFG.batteryEligibilityVersion;
    }
  }
  let restored = 0, excluded = 0;
  for (const e of evidence) {
    if (!e.lot || !pool.has(e.roomId)) continue;
    if (redpocketPolicy.isExcludedBattery(e.lot)) { excluded++; continue; }
    if (t - e.foundAt >= CFG.hotValueWindowMs) continue;
    strategy.recordBatteryValue(pool.get(e.roomId), e.lot, e.foundAt, t, CFG);
    restored++;
  }
  state.valueEvidence = { restored, excluded, migratedRooms, at: t };
}

function restoreNodeLatencies() {
  const recent = historyStore.db.prepare(`SELECT duration_ms FROM requests
    WHERE node=? AND kind='rp' AND finished_at>=? AND outcome IN ('hit','empty','error')
    ORDER BY finished_at DESC LIMIT 110`);
  for (const [name, node] of nodeState) {
    if (node.latencySamples >= 5 && Number.isFinite(node.requestMeanMs)) continue;
    scanSpeed.recordLatency(node, recent.all(name, now() - 30 * 60000).map(r => r.duration_ms));
  }
}

function pruneExpired() {
  const t = now();
  for (const [lid, r] of activeRP) if (r.end_time && r.end_time * 1000 <= t) {
    recentRP.set(lid, { ...r, expired: true, expiredAt: r.end_time * 1000 });
    activeRP.delete(lid);
  }
  for (const [lid, r] of activeAnchor) if (r.expireAt && r.expireAt <= t) activeAnchor.delete(lid);
  for (const [lid, r] of recentRP) if (t - (r.expiredAt || 0) > 3600000) recentRP.delete(lid);
}

function writeState() {
  syncScanSettings();
  syncRestartPriority();
  pruneExpired();
  for (const entries of [activeRP, activeAnchor, recentRP]) {
    for (const [id, record] of entries) if (isBlockedRoom(record.room_id)) entries.delete(id);
  }
  for (const entries of [activeRP, recentRP]) {
    for (const [id, record] of entries) if (redpocketPolicy.isExcludedBattery(record)) entries.delete(id);
  }
  state.history = state.history.filter(r => !redpocketPolicy.isExcludedBattery(r));
  if (state.watchlist) state.watchlist = state.watchlist.filter(r => !isBlockedRoom(r.room));
  state.updated = now();
  const summary = poolSummaryIndex();
  const ranked = summary.ranked.filter(([id, r]) => !isBlockedRoom(id) && strategy.hotRankSignal(r, now(), CFG).eligible);
  state.hotRank = { ...state.hotRank, active: ranked.length,
    cold: ranked.filter(([id]) => tierOf(id) === 'COLD').length,
    scannedRooms: hotRankScannedRooms.size };
  const qqRooms = summary.qq.filter(([id, r]) => !isBlockedRoom(id) && r.qqPushes > 0);
  const qqSummary = qqRooms.map(([room, r]) => ({ room, tier: tierOf(room),
    ...strategy.qqSignal(r, now(), CFG), reports: r.qqPushes, lastAt: r.qqLastAt,
    sources: r.qqSources || [], anchors: r.qqAnchors || [] }));
  state.qq = { ...state.qq, batteryRooms: qqRooms.length,
    accelerated: qqSummary.filter(r => r.tier === 'WARM' && r.intervalMs < CFG.warmIntervalMs).length,
    backedOff: qqSummary.filter(r => r.tier === 'WARM' && r.backedOff).length,
    pendingVerification: qqSummary.filter(r => r.tier === 'WARM' && r.verifyPending).length,
    topSources: qqSummary.sort((a, b) => b.score - a.score).slice(0, 8) };
  const historicalSummary = summary.historical.filter(([id, r]) => !isBlockedRoom(id) && r.historicalSource)
    .map(([room, r]) => ({ room, tier: tierOf(room), ...strategy.historicalSignal(r, now(), CFG),
      emptyScans: r.historicalEmptyScans || 0, lastProbeAt: r.historicalLastProbeAt || 0 }));
  const historicalEligible = historicalSummary.filter(r => r.eligible);
  const historicalCold = historicalEligible.filter(r => r.tier === 'COLD');
  state.historical = { ...state.historical, active: historicalEligible.length,
    cold: historicalCold.length, due: historicalCold.filter(r => r.due).length,
    backedOff: historicalCold.filter(r => r.backedOff).length,
    neverScanned: historicalEligible.filter(r => r.delayMs === null).length,
    maxDelayMs: Math.max(0, ...historicalEligible.map(r => r.delayMs || 0)),
    maxOverdueMs: Math.max(0, ...historicalCold.map(r => r.overdueMs || 0)),
    requests: state.stats.byTier.COLD_HISTORY?.requests || 0,
    lastSent: historicalSummary.reduce((latest, r) => Math.max(latest, r.lastProbeAt), 0),
    topWaiting: historicalCold.filter(r => r.due).sort((a, b) => (b.overdueMs || 0) - (a.overdueMs || 0)).slice(0, 8) };
  state.redpockets = [...activeRP.values()].map(record => ({ ...record,
    audience: roomAudience.publicAudience(pool.get(String(record.room_id)), now()) }))
    .sort((a, b) => (b.per_person || 0) - (a.per_person || 0));
  state.expired = [...recentRP.values()].sort((a, b) => b.expiredAt - a.expiredAt).slice(0, 30);
  state.anchors = [...activeAnchor.values()].map(r => ({ ...r, remain: Math.max(0, Math.ceil((r.expireAt - now()) / 1000)) }))
    .sort((a, b) => a.remain - b.remain);
  state.nodes = [...nodeState].map(([name, s]) => ({ name, used: s.used,
    totalUsed: s.totalUsed, totalRequests: s.totalRequests, lastUsedAt: s.lastUsedAt,
    requestMeanMs: s.requestMeanMs, latencySamples: s.latencySamples || 0,
    banned: !nodeAlive(name), bannedUntil: s.bannedUntil, ip: s.lastIp }));
  state.ipLimits = [...ipState].map(([ip, limit]) => ({ ip, ...limit }));
  atomicJSON(CFG.stateFile, state);
}

function acceptRedpockets(roomId, lots, tier) {
  if (!syncRoomBlocklist() || isBlockedRoom(roomId)) return 0;
  const t = now();
  const r = strategy.ensureRoom(pool, roomId, t);
  const newLots = strategy.recordScan(r, lots, t, CFG);
  const newIds = new Set(newLots.map(l => String(l.lot_id)));
  const valid = lots.filter(l => l.lot_id && (!l.end_time || l.end_time * 1000 > t));
  const validIds = new Set(valid.map(l => String(l.lot_id)));
  for (const [lid, previous] of activeRP) if (String(previous.room_id) === roomId && !validIds.has(lid)) {
    recentRP.set(lid, { ...previous, expired: true, expiredAt: t });
    activeRP.delete(lid);
  }
  for (const lot of valid) {
    const id = String(lot.lot_id);
    if (redpocketPolicy.isExcludedBattery(lot)) {
      activeRP.delete(id);
      recentRP.delete(id);
      continue;
    }
    const award = (lot.awards || []).find(a => /电池/.test(a.gift_name || '')) || (lot.awards || [])[0] || {};
    const battery = strategy.isBattery(lot) ? (lot.total_price || 0) / 100 : 0;
    const previous = activeRP.get(id) || recentRP.get(id);
    const rec = { kind: 'popularity_red_pocket', lid: lot.lot_id, room_id: roomId,
      award_name: award.gift_name || '', award_num: award.num || 0, total_price: lot.total_price || 0,
      battery, per_person: battery / Math.max(1, award.num || 1),
      join_requirement: lot.join_requirement, rp_type: lot.rp_type, end_time: lot.end_time,
      start_time: lot.start_time, h5: lot.h5_url,
      sender: lot.sender_info?.base?.name || '', first_seen: previous?.first_seen || t,
      last_seen: t, qqPushes: r.qqPushes || 0, qqBattery: r.qqBattery || 0, qqAnchors: r.qqAnchors || [] };
    activeRP.set(id, rec);
    if (newIds.has(id)) {
      state.stats.hits++;
      if (strategy.isBattery(lot)) {
        state.stats.batteryHits++;
        state.stats.byTier[tier].batteryHits++;
      }
      state.history.unshift({ ...rec, foundAt: t });
      state.history = state.history.slice(0, 100);
    }
  }
  if (newLots.length) { savePool(); writeState(); }
  for (const lot of valid) queueNotification(activeRP.get(String(lot.lot_id)));
  return newLots.length;
}

function queueNotification(record) {
  // Cloud forwarding shares the eligibility settings without Windows toasts.
  if (process.env.SCANNER_DESKTOP_NOTIFICATIONS === '0') return false;
  // Re-read before dispatch as well as on the heartbeat, so saved changes apply to the next alert.
  if (!syncRoomBlocklist() || isBlockedRoom(record?.room_id)) return false;
  if (!syncNotificationSettings()) return false;
  const payload = notifications.buildNotification(record, now(), state.notifications.settings);
  if (!payload || (notificationRetries.get(payload.id) || 0) > now()) return false;
  const ns = state.notifications;
  ns.notified = ns.notified.filter(item => item.until > now());
  if (ns.notified.some(item => item.id === payload.id)) return false;
  const marker = { id: payload.id, until: payload.expiresAt + 86400000 };
  ns.notified.push(marker);
  // Persist the reservation before submitting so a restart cannot replay the same alert.
  try { writeState(); }
  catch (e) {
    ns.notified = ns.notified.filter(item => item !== marker);
    ns.lastError = e.message;
    console.error('[通知] 状态保存失败: ' + e.message);
    return false;
  }
  const task = Promise.resolve().then(() => {
    if (!syncRoomBlocklist() || isBlockedRoom(record?.room_id)
      || !syncNotificationSettings() || !notifications.buildNotification(record, now(), ns.settings)) {
      ns.notified = ns.notified.filter(item => item !== marker);
      return false;
    }
    return notifications.sendDesktop(payload).then(() => true);
  })
    .then(submitted => {
      if (!submitted) return;
      ns.sent++;
      ns.lastError = '';
      ns.lastSent = { id: payload.id, room: payload.room, at: now() };
      notificationRetries.delete(payload.id);
      console.log('[通知] ' + payload.title + ' · 房间 ' + payload.room);
    })
    .catch(e => {
      ns.failed++;
      ns.lastError = e.message;
      ns.notified = ns.notified.filter(item => item.id !== payload.id);
      notificationRetries.set(payload.id, now() + 60000);
      console.error('[通知] ' + e.message);
    })
    .finally(() => {
      pendingNotifications.delete(task);
      try { writeState(); } catch (e) { console.error('[通知] 状态保存失败: ' + e.message); }
    });
  pendingNotifications.add(task);
  return true;
}

function acceptAnchor(roomId, d) {
  if (!syncRoomBlocklist() || isBlockedRoom(roomId)) return;
  const t = now();
  const r = strategy.ensureRoom(pool, roomId, t);
  r.lastAnchorScan = t;
  r.seenAnchors = (r.seenAnchors || []).filter(x => x.until > t);
  if (!d?.id || !(d.time > 0)) return;
  const id = String(d.id);
  if (!r.seenAnchors.some(x => x.id === id)) {
    r.anchorHits = (r.anchorHits || 0) + 1;
    r.lastAnchor = t;
    r.seenAnchors.push({ id, until: t + d.time * 1000 + 86400000 });
  }
  activeAnchor.set(id, { kind: 'gift_anchor', lid: d.id, room_id: roomId,
    award_name: d.award_name, award_num: d.award_num, require_text: d.require_text,
    remain: d.time, expireAt: t + d.time * 1000, join_total: d.join_total, url: d.url });
}

// ═══════════════════════════════════════════════════════════════════════
// 单轮扫描
// ═══════════════════════════════════════════════════════════════════════
async function runRound(round, nodes) {
  if (!syncScanSettings()) { writeState(); return; }
  syncRestartPriority();
  const restartPriorityActive = restartPriority.size > 0;
  const t0 = now();
  state.round = round;
  state.phase = 'planning';
  const node = pickNode(nodes);
  if (!node) { state.phase = 'cooldown'; return; }
  const batchBudget = scanSpeed.roundBudget(nodeState.get(node), CFG);
  const audienceRoom = CFG.roomAudience
    ? roomAudience.selectAudienceRoom(pool, [...activeRP.values()], now(), CFG.blockedRooms) : null;
  const audienceReserve = audienceRoom ? (roomAudience.anchorUid(pool.get(audienceRoom).anchorUid) ? 1 : 2) : 0;
  const { plan, priorityPlan, historicalPlan, hotRooms, counts, quota } = buildRoundPlan(round,
    { perIpBudget: batchBudget - audienceReserve, restartPriority });
  quota.audienceReserve = audienceReserve;
  const priorityIds = new Set(priorityPlan);
  const historicalIds = new Set(historicalPlan);
  const tiers = new Map(plan.map(id => [id, priorityIds.has(id) ? 'COLD_PRIORITY'
    : historicalIds.has(id) ? 'COLD_HISTORY' : restartPriority.get(id)?.tier || tierOf(id)]));
  state.pool = counts;
  state.quota = quota;
  state.watchlist = plan.slice(0, 12).map(id => ({ room: id, score: restartPriority.get(id)?.score ?? roomScore(id),
    reason: historicalIds.has(id) ? 'historical-source' : priorityIds.has(id) ? 'priority' : tiers.get(id).toLowerCase(),
    historicalIntervalMs: historicalIds.has(id) ? strategy.historicalSignal(pool.get(id), now(), CFG).intervalMs : null,
    hits: pool.get(id).batteryHits || 0, qqPushes: pool.get(id).qqPushes || 0,
    qqScore: strategy.qqSignal(pool.get(id), now(), CFG).score,
    qqIntervalMs: strategy.qqSignal(pool.get(id), now(), CFG).intervalMs,
    hotQuality: strategy.hotSignal(pool.get(id), now(), CFG).quality,
    hotIntervalMs: strategy.hotSignal(pool.get(id), now(), CFG).intervalMs,
    anchorHits: pool.get(id).anchorHits || 0, lastHit: pool.get(id).lastBatteryHit || 0 }));
  if (!plan.length) { state.phase = 'idle'; return; }
  state.phase = 'switching';
  const ns = nodeState.get(node);
  // Failed switches also wait before retrying so one invalid node cannot stall every round.
  ns.lastUsedAt = now();
  try { await switchNode(node); }
  catch (e) { noteError('switch', e.message); throw e; }
  ns.used = 0;
  ns.totalUsed++;
  state.current = { node, ip: ns.lastIp };
  const roundTransport = CFG.pooledHttp ? createProxyTransport({ proxy: CFG.proxy,
    userAgent: CFG.UA, concurrency: CFG.concurrency }) : null;
  const controller = new AbortController();
  const signal = AbortSignal.any([controller.signal, shutdownController.signal]);
  let gate = Promise.resolve();
  let nextRequestAt = 0;
  let sentRP = 0, sentPriority = 0;
  const requestDurations = [];
  const priorityMaxRatio = Math.max(0, Math.min(1, Number(CFG.priorityMaxRatio) || 0));
  const pendingWorkers = [];
  const exits = new Set(nodes.filter(name => nodeAlive(name)).map(name => nodeState.get(name).lastIp || name)).size;
  const queue = createRoundQueue(pool, plan, tiers, hotRooms, quota, { ...CFG, restartPriorityActive });
  state.scheduling = { spreadNodeBudget: CFG.spreadNodeBudget,
    rotationSlotMs: scanSpeed.requestSlotAt(0, batchBudget, batchBudget, exits, CFG), hotRechecks: 0 };
  async function nodeRequest(url, kind, roomId, tier) {
    let skipped = false;
    const turn = gate.then(async () => {
      if (signal.aborted || !syncScanSettings() || isBlockedRoom(roomId) || ns.used >= batchBudget) return false;
      if (roomId && !pool.has(roomId)) { skipped = true; return false; }
      const slotAt = scanSpeed.requestSlotAt(ns.lastUsedAt, ns.used, batchBudget, exits, CFG);
      const launchAt = Math.max(nextRequestAt, slotAt);
      while (launchAt > now()) {
        await sleep(Math.min(500, launchAt - now()));
        if (signal.aborted || !syncScanSettings()) return false;
      }
      if (signal.aborted || !syncScanSettings() || isBlockedRoom(roomId) || ns.used >= batchBudget) return false;
      if (roomId && !pool.has(roomId)) { skipped = true; return false; }
      // A live blocklist can remove ordinary requests from the original plan.
      if (kind === 'rp' && tier === 'COLD_PRIORITY' && sentPriority + 1 > (sentRP + 1) * priorityMaxRatio) {
        skipped = true;
        return false;
      }
      ns.used++;
      ns.totalRequests++;
      nextRequestAt = now() + CFG.delayMs;
      if (roomId && kind === 'rp') pool.get(roomId).lastAttempt = now();
      return true;
    });
    gate = turn.then(() => {}, () => {});
    if (!await turn) return { status: skipped || isBlockedRoom(roomId) ? 'SKIP' : 'ABORT', sent: false };
    const before = state.stats.requestsByKind.rp || 0;
    const requestStartedAt = now();
    const pending = httpGet(url, { kind, roomId, tier, signal, timeout: 10000, transport: roundTransport });
    if (kind === 'rp' && state.stats.requestsByKind.rp > before) {
      sentRP++;
      if (tier === 'COLD_PRIORITY') sentPriority++;
      if (tier === 'COLD_HISTORY' && pool.has(roomId)) pool.get(roomId).historicalLastProbeAt = now();
    }
    const result = await pending;
    if (kind === 'rp' && result.sent && result.status !== 'ABORT') requestDurations.push(now() - requestStartedAt);
    if (result.status === 'BANNED') {
      banNode(node);
      controller.abort();
      console.log('[风控] ' + node + ' 暂停 15 分钟，本轮停止派发请求');
    }
    return result;
  }

  try {
    const zoneUrl = 'https://api.bilibili.com/x/web-interface/zone';
    let ipResult = await nodeRequest(zoneUrl, 'ip');
    // One optional transport retry uses the same gate and the same total request budget.
    if (CFG.ipNetworkRetry && ipResult.status === 'NETWORK' && !signal.aborted) {
      ipResult = await nodeRequest(zoneUrl, 'ip');
    }
    if (ipResult.status !== 'OK' || ipResult.code !== 0 || !ipResult.data?.addr) {
      if (ipResult.status === 'OK' && ipResult.code === 0) noteError('ip', 'schema');
      state.phase = ipResult.status === 'BANNED' ? 'cooldown' : 'error';
      return;
    }
    const addr = ipResult.data.addr;
    ns.lastIp = addr;
    state.current.ip = addr;
    const previous = ipState.get(addr);
    if (previous && ((previous.bannedUntil || 0) > now()
      || now() - previous.lastUsedAt < CFG.minNodeReuseMs)) {
      state.phase = 'cooldown';
      return;
    }
    ipState.set(addr, { lastUsedAt: ns.lastUsedAt, bannedUntil: 0 });
    state.phase = 'scanning';
    state.progress = { planned: plan.length, sent: 0, scanned: 0 };
    writeState();
    let hits = 0;
    async function worker() {
      while (!signal.aborted) {
        const task = queue.next(now());
        if (!task) return;
        const { roomId, tier } = task;
        state.scheduling.hotRechecks = queue.replacements;
        try {
        const room = pool.get(roomId);
        if (!room) continue;
        const fromHotRank = strategy.hotRankSignal(room, now(), CFG).eligible;
        const stats = state.stats.byTier[tier] ||= { requests: 0, scanned: 0, errors: 0, batteryHits: 0 };
        const result = await nodeRequest('https://api.live.bilibili.com/xlive/lottery-interface/v1/popularityRedPocket/RedPocketGetInfo?room_id=' + roomId, 'rp', roomId, tier);
        if (result.sent) {
          completeRestartPriority(roomId);
          stats.requests++; state.progress.sent++;
          if (fromHotRank) {
            state.hotRank.requests++;
            if (tier === 'COLD_PRIORITY') state.hotRank.priorityRequests++;
            hotRankScannedRooms.add(roomId);
            state.hotRank.scannedRooms = hotRankScannedRooms.size;
          }
        }
        if (result.status === 'SKIP') continue;
        if (result.status === 'ABORT') return;
        if (result.status === 'BANNED') { stats.errors++; return; }
        if (result.status !== 'OK' || result.code !== 0
          || describeResult('rp', result, roomId, now()).reason === 'schema') {
          if (result.status === 'OK' && result.code === 0) noteError('rp', 'schema');
          if (pool.has(roomId)) strategy.recordError(pool.get(roomId), now());
          stats.errors++;
          continue;
        }
        state.stats.scanned++;
        state.progress.scanned++;
        stats.scanned++;
        hits += acceptRedpockets(roomId, result.data.lot_info || [], tier);
        if (tierOf(roomId) === 'HOT') queue.addHot(roomId);
        } finally { queue.complete(roomId); }
      }
    }
    pendingWorkers.push(...Array.from({ length: CFG.concurrency }, worker));
    await Promise.all(pendingWorkers);
    if (quota.anchorReserve && !signal.aborted) {
      state.phase = 'anchors';
      const oldest = (a, b) => (pool.get(a).lastAnchorScan || 0) - (pool.get(b).lastAnchorScan || 0);
      const historical = [...pool.keys()].filter(id => !isBlockedRoom(id) && pool.get(id).anchorHits > 0).sort(oldest);
      const anchorRooms = [...new Set([
        ...historical.slice(0, Math.floor(quota.anchorReserve / 2)),
        ...plan.slice().sort(oldest), ...historical,
      ])].slice(0, quota.anchorReserve);
      let anchorIndex = 0;
      async function anchorWorker() {
        while (anchorIndex < anchorRooms.length && !signal.aborted) {
          const roomId = anchorRooms[anchorIndex++];
          const result = await nodeRequest('https://api.live.bilibili.com/xlive/lottery-interface/v1/Anchor/Check?roomid=' + roomId + '&need_guard=true', 'anchor', roomId);
          if (result.status === 'SKIP') continue;
          if (result.status === 'ABORT' || result.status === 'BANNED') return;
          if (result.status === 'OK' && result.code === 0) {
            if (describeResult('anchor', result, roomId, now()).reason === 'schema') noteError('anchor', 'schema');
            else acceptAnchor(roomId, result.data);
          }
        }
      }
      pendingWorkers.push(...Array.from({ length: Math.min(2, CFG.concurrency) }, anchorWorker));
      await Promise.all(pendingWorkers);
    }
    if (audienceRoom && !signal.aborted && !isBlockedRoom(audienceRoom) && ns.used < batchBudget
      && [...activeRP.values()].some(packet => String(packet.room_id) === audienceRoom
        && Number(packet.end_time) * 1000 > now() + 15000)) {
      const room = pool.get(audienceRoom);
      room.audienceAttemptAt = now();
      let uid = roomAudience.anchorUid(room.anchorUid);
      if (!uid) {
        const info = await nodeRequest('https://api.live.bilibili.com/room/v1/Room/get_info?room_id='
          + audienceRoom, 'audience-room', audienceRoom, 'AUDIENCE');
        if (info.status === 'OK' && info.code === 0) uid = roomAudience.anchorUid(info.data?.uid);
        if (info.status === 'OK' && info.code === 0 && !uid) noteError('audience-room', 'schema');
        if (uid) room.anchorUid = uid;
      }
      if (uid && !signal.aborted) {
        const info = await nodeRequest('https://api.live.bilibili.com/xlive/general-interface/v1/rank/getOnlineGoldRank?ruid='
          + uid + '&roomId=' + audienceRoom + '&page=1&pageSize=1', 'audience', audienceRoom, 'AUDIENCE');
        if (info.status === 'OK' && info.code === 0 && !roomAudience.recordAudience(room, info.data, now())) {
          noteError('audience', 'schema');
        }
      }
    }
    state.stats.rounds++;
    state.phase = signal.aborted ? 'cooldown' : 'sleeping';
    console.log('[轮 ' + round + '] 成功 ' + state.progress.scanned + '/' + plan.length
      + '，HOT ' + quota.hot + ' / WARM ' + quota.warm + ' / COLD ' + quota.cold
      + '（榜单优先 ' + quota.priority + ' / 普通探索 ' + quota.regularCold + '）'
      + ' / 历史复查 ' + quota.historical
      + '，新增 ' + hits + '，节点请求 ' + ns.used + '/' + CFG.perIpBudget);
  } finally {
    controller.abort();
    await Promise.allSettled(pendingWorkers);
    roundTransport?.close();
    scanSpeed.recordLatency(ns, requestDurations);
    state.lastRoundMs = now() - t0;
    savePool();
    writeState();
  }
}

// ═══════════════════════════════════════════════════════════════════════
// 主循环
// ═══════════════════════════════════════════════════════════════════════
function acquireLock({ reuseRunning = false } = {}) {
  try {
    fs.writeFileSync(CFG.lockFile, JSON.stringify({ pid: process.pid, startedAt: now() }), { flag: 'wx' });
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;
    const previous = JSON.parse(fs.readFileSync(CFG.lockFile, 'utf8'));
    if (!Number.isSafeInteger(previous?.pid) || previous.pid <= 0) throw new Error('扫描器锁无效，请检查: ' + CFG.lockFile);
    let alive = true;
    try { process.kill(previous.pid, 0); }
    catch (error) {
      if (error.code === 'ESRCH') alive = false;
      else if (error.code !== 'EPERM') throw error;
    }
    if (alive) {
      if (!reuseRunning) throw new Error('扫描器已运行，PID ' + previous.pid);
      console.log('[扫描器] 已在运行，PID ' + previous.pid + '，继续使用现有实例，本窗口正常退出.');
      return false;
    }
    fs.unlinkSync(CFG.lockFile);
    fs.writeFileSync(CFG.lockFile, JSON.stringify({ pid: process.pid, startedAt: now() }), { flag: 'wx' });
  }
  return true;
}

function releaseLock() {
  try {
    const lock = JSON.parse(fs.readFileSync(CFG.lockFile, 'utf8'));
    if (lock.pid === process.pid) fs.unlinkSync(CFG.lockFile);
  } catch {}
}

function stop() {
  stopping = true;
  shutdownController.abort();
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--stop')) {
    const lock = JSON.parse(fs.readFileSync(CFG.lockFile, 'utf8'));
    atomicJSON(CFG.lockFile + '.stop', { pid: lock.pid });
    console.log('已请求扫描器保存状态并退出，PID ' + lock.pid);
    return;
  }
  const roundsArg = args.indexOf('--rounds');
  const maxRounds = args.includes('--once') ? 1 : roundsArg >= 0 ? Number(args[roundsArg + 1]) : Infinity;
  if (maxRounds !== Infinity && (!Number.isInteger(maxRounds) || maxRounds < 1)) throw new Error('--rounds 必须是正整数');
  if (!acquireLock({ reuseRunning: !args.includes('--once') && roundsArg < 0 })) return;
  let heartbeat, poolReady = false;
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  try {
    loadPool();
    restoreState();
    poolReady = true;
    syncScanSettings();
    initializeHistory();
    restoreNodeLatencies();
    restoreBatteryValues();
    syncScanSettings();
    syncNotificationSettings();
    syncQQ();
    CLASH_API = await discoverClash();
    if (!CLASH_API) throw new Error('找不到 Clash 控制器');
    let nodes = await loadNodes();
    console.log('可用节点: ' + nodes.length + '；固定探索配额 ' + CFG.explorationRatio * 100 + '%');
    savePool();
    writeState();
    heartbeat = setInterval(() => {
      try {
        if (fs.existsSync(CFG.lockFile + '.stop')) {
          const request = JSON.parse(fs.readFileSync(CFG.lockFile + '.stop', 'utf8'));
          fs.unlinkSync(CFG.lockFile + '.stop');
          if (request.pid === process.pid) stop();
        }
        syncNotificationSettings();
        syncScanSettings();
        writeState();
      } catch (e) { console.error('[状态] ' + e.message); }
    }, 2000);
    for (let round = 1; !stopping && round <= maxRounds;) {
      if (!syncScanSettings()) { await sleep(500); continue; }
      syncQQ();
      startDiscovery();
      try {
        if (round > 1) nodes = await loadNodes();
        await runRound(round, nodes);
      }
      catch (e) { console.error('[轮 ' + round + '] ' + e.message); state.phase = 'error'; }
      if (round >= maxRounds || stopping) break;
      round++;
      await sleep(scanSpeed.nextRoundDelay(state.phase, Boolean(pickNode(nodes)), CFG,
        scanSpeed.nextNodeWait(nodes, nodeState, ipState, CFG, now())));
    }
  } finally {
    stop();
    clearInterval(heartbeat);
    if (discoveryTask) await discoveryTask;
    await Promise.allSettled(pendingNotifications);
    if (poolReady) {
      state.phase = state.storage.error ? 'storage_error' : 'stopped';
      try { savePool(); writeState(); } catch (e) { console.error('[保存] ' + e.message); }
    }
    if (historyStore) {
      try { historyStore.endRun(state.storage.error ? 'storage_error' : 'stopped'); }
      catch (e) { console.error('[长期记录] 关闭会话失败: ' + e.message); process.exitCode = 1; }
      finally { historyStore.close(); }
    }
    releaseLock();
  }
}

if (require.main === module) main().catch(e => { console.error('致命错误:', e.message); process.exitCode = 1; });
